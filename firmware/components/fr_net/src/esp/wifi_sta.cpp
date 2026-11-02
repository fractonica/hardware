#include "wifi_sta.hpp"

#include <algorithm>
#include <cstdio>
#include <cstring>

#include "air_detail.hpp"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "sdkconfig.h"

namespace fr::net::esp::detail {
namespace {

constexpr const char *TAG = "fr_net";

/** Copies a credential string into a fixed Wi-Fi config field, which need not be NUL-terminated when full. */
template <size_t N>
void copy_field(uint8_t (&dst)[N], const char *src)
{
    std::memset(dst, 0, N);
    std::memcpy(dst, src, std::min(std::strlen(src), N));
}

void zero_creds(fr_net_creds_t &c)
{
    // The passphrase must not linger in a buffer nobody uses any more.
    volatile uint8_t *p = reinterpret_cast<volatile uint8_t *>(&c);
    for (size_t i = 0; i < sizeof(c); ++i) {
        p[i] = 0;
    }
}

}  // namespace

void WifiSta::configure(const Settings &s, TimeUs now)
{
    band_ = s.band;
    base_ = s.creds;
    prov_ts_ = s.prov_ts;
    lost_since_ = now;  // a pin found at boot counts the sweep's wait (sta_rules.hpp) from here
    fr_link_pin_t link;
    if (fr_id_load_link(&link) == ESP_OK) {
        Pin p{.set = true, .channel = link.channel, .ssid_hash = link.ssid_hash};
        std::memcpy(p.bssid.data(), link.bssid, p.bssid.size());
        pins_.load(p);
    }
    // C from the last boot (use_creds): ESP-NOW works on it before (and without) an association (05 §5.4).
    use_creds(base_, false, false, now);

    fr_net_override_t o;
    if (fr_id_load_net_override(&o) == ESP_OK) {
        if (o.base_prov_ts != prov_ts_) {
            // fr_ident was written again since (a reprovision): the registry's network wins.
            ESP_LOGI(TAG, "wifi: dropping a net_set override from an earlier provisioning");
            fr_id_clear_net_override();
        } else {
            override_ = o;
            fr_net_creds_t c = o.creds;
            if (c.hub_host[0] == '\0') {
                std::memcpy(c.hub_host, base_.hub_host, sizeof(c.hub_host));
            }
            // A confirmed override is the node's network now; one that never joined gets its 60 s again.
            use_creds(c, true, !o.confirmed, now);
            ESP_LOGI(TAG, "wifi: using the net_set network '%s'%s", c.ssid, o.confirmed ? "" : " (trial)");
            zero_creds(c);
        }
        zero_creds(o.creds);
    }
}

void WifiSta::use_creds(const fr_net_creds_t &c, bool is_override, bool trial, TimeUs now)
{
    creds_ = c;
    override_active_ = is_override;
    trial_ = trial;
    trial_deadline_ = trial ? now + kTrialUs : 0;
    publish([&](Snapshot &s) {
        std::memcpy(s.ssid, c.ssid, sizeof(s.ssid));
        s.override_active = is_override;
        s.override_trial = trial;
    });
    // A pin from another network (another SSID), a trial of a new one, or a pin that is not the BSSID the
    // credentials name is not joined: by SSID (or that BSSID) instead. fr_link survives a reprovision, and
    // 05 §5.4 joins fr_ident's BSSID first, so a mesh home can move every node to one AP.
    pins_.use(fr_id_ssid_hash(c.ssid), c.has_bssid ? c.bssid : nullptr, trial);
    set_home(pins_.home());
}

void WifiSta::attempt(TimeUs now)
{
    if (held_) {
        phase_ = Phase::held;
        return;
    }
    if (!started_ || !have_creds()) {
        phase_ = Phase::idle;
        return;
    }
    const Pin *pin = pins_.usable();
    const uint32_t heard = air_last_heard_s();
    const uint32_t wifi_up = air_wifi_up_heard_s();
    const Search was = search_;
    search_ = search({.now = now,
                      .lost_since = lost_since_,
                      .last_sweep = last_sweep_,
                      .heard = heard,
                      .wifi_up = wifi_up,
                      .pinned = pin != nullptr,
                      .any_bssid = !creds_.has_bssid});
    if (search_ == Search::pinned || search_ == Search::ssid_on_c) {
        // 05 §5.4: scan only channel C (for the pinned BSSID, or any AP of the SSID) and connect once it
        // answers, so a router outage never sends the radio off channel C, where ESP-NOW keeps working.
        std::memcpy(join_bssid_, pin->bssid.data(), sizeof(join_bssid_));
        join_channel_ = pin->channel;
        if (search_ == Search::ssid_on_c && was != Search::ssid_on_c) {
            ESP_LOGI(TAG, "wifi: pinned AP silent while a neighbour is on Wi-Fi; any '%s' AP on channel %u will do",
                     creds_.ssid, join_channel_);
        }
        wifi_scan_config_t sc;
        std::memset(&sc, 0, sizeof(sc));
        if (search_ == Search::pinned) {
            sc.bssid = join_bssid_;
        } else {
            sc.ssid = reinterpret_cast<uint8_t *>(creds_.ssid);
        }
        sc.channel = join_channel_;
        sc.show_hidden = true;
        if (is_dfs_channel(join_channel_)) {
            sc.scan_type = WIFI_SCAN_TYPE_PASSIVE;
            sc.scan_time.passive = kDfsScanMs;
        } else {
            sc.scan_type = WIFI_SCAN_TYPE_ACTIVE;
            sc.scan_time.active.min = 0;
            sc.scan_time.active.max = kPinScanMs;
        }
        esp_err_t err = esp_wifi_scan_start(&sc, false);
        if (err != ESP_OK) {
            ESP_LOGD(TAG, "wifi: channel %u scan not started (%s)", join_channel_, esp_err_to_name(err));
            retry_later(now);
            return;
        }
        phase_ = Phase::scanning;
        phase_deadline_ = now + kScanTimeoutUs;
        return;
    }
    if (search_ == Search::sweep) {
        last_sweep_ = now;
        // 05 §5.4 "Heartbeats report each sweep": Net sets HEARTBEAT swept for each new one.
        publish([](Snapshot &s) { ++s.sweeps; });
        ESP_LOGI(TAG, "wifi: pinned AP silent for %u s, %s; sweeping all channels for '%s'",
                 static_cast<unsigned>((now - lost_since_) / 1'000'000),
                 heard_within(heard, now, kHeardWindowUs) ? "no neighbour on Wi-Fi" : "no ESP-NOW heard", creds_.ssid);
    }
    connect(now, false);
}

bool WifiSta::pick_ap()
{
    bool pinned = false;
    bool other = false;
    int8_t best = 0;
    uint8_t strongest[6] = {};
    wifi_ap_record_t r;
    while (!pinned && esp_wifi_scan_get_ap_record(&r) == ESP_OK) {  // each call frees the record it returns
        if (r.primary != join_channel_) {
            continue;  // heard from a neighbouring channel: joining it would take the radio off C
        }
        if (std::memcmp(r.bssid, join_bssid_, sizeof(join_bssid_)) == 0) {
            pinned = true;
        } else if (!other || r.rssi > best) {
            other = true;
            best = r.rssi;
            std::memcpy(strongest, r.bssid, sizeof(strongest));
        }
    }
    esp_wifi_clear_ap_list();  // what the loop left
    if (pinned || !other) {
        return pinned;
    }
    std::memcpy(join_bssid_, strongest, sizeof(join_bssid_));
    ESP_LOGI(TAG, "wifi: joining %02x:%02x:%02x:%02x:%02x:%02x of '%s' on channel %u instead of the pinned AP",
             strongest[0], strongest[1], strongest[2], strongest[3], strongest[4], strongest[5], creds_.ssid,
             join_channel_);
    return true;
}

void WifiSta::connect(TimeUs now, bool to_bssid)
{
    wifi_config_t cfg;
    std::memset(&cfg, 0, sizeof(cfg));
    copy_field(cfg.sta.ssid, creds_.ssid);
    copy_field(cfg.sta.password, creds_.pass);
    if (to_bssid) {
        // bssid_set + channel: the driver's own pre-connect scan starts on C and takes only that AP.
        cfg.sta.bssid_set = true;
        std::memcpy(cfg.sta.bssid, join_bssid_, sizeof(cfg.sta.bssid));
        cfg.sta.channel = join_channel_;
        cfg.sta.scan_method = WIFI_FAST_SCAN;
    } else {
        // First join (05 §5.4): fr_ident's BSSID if it names one, else the strongest AP of the SSID.
        cfg.sta.bssid_set = creds_.has_bssid;
        std::memcpy(cfg.sta.bssid, creds_.bssid, sizeof(cfg.sta.bssid));
        cfg.sta.scan_method = WIFI_ALL_CHANNEL_SCAN;
        cfg.sta.sort_method = WIFI_CONNECT_AP_BY_SIGNAL;
    }
    esp_err_t err = esp_wifi_set_config(WIFI_IF_STA, &cfg);
    std::memset(&cfg, 0, sizeof(cfg));  // the passphrase stays only in the driver
    if (err == ESP_OK) {
        err = esp_wifi_connect();
    }
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "wifi: connect not started (%s)", esp_err_to_name(err));
        retry_later(now);
        return;
    }
    phase_ = Phase::connecting;
    phase_deadline_ = now + kConnectTimeoutUs;
}

void WifiSta::retry_later(TimeUs now)
{
    phase_ = Phase::waiting;
    next_attempt_ = now + retry_us_;
    retry_us_ = std::min(retry_us_ * 2, kRetryMaxUs);
    // Not associated (every caller follows a failure or a disconnect): wait on C, not where the last scan or
    // the driver's default left the radio.
    keep_channel();
}

void WifiSta::set_home(uint8_t channel)
{
    if (channel == home_channel_) {
        return;
    }
    home_channel_ = channel;
    publish([channel](Snapshot &s) { s.home_channel = channel; });
    detail::air_set_channel(channel);
}

void WifiSta::keep_channel()
{
    if (home_channel_ == 0 || !started_) {
        return;
    }
    // Refused while the driver is still scanning or connecting; the next idle moment sets it again.
    esp_err_t err = esp_wifi_set_channel(home_channel_, WIFI_SECOND_CHAN_NONE);
    if (err != ESP_OK) {
        ESP_LOGD(TAG, "wifi: channel %u not set (%s)", home_channel_, esp_err_to_name(err));
    }
}

void WifiSta::rejoin(TimeUs now)
{
    retry_us_ = kRetryMinUs;
    if (phase_ == Phase::scanning) {
        esp_wifi_scan_stop();
    } else if (phase_ == Phase::connecting || phase_ == Phase::associated) {
        // Its DISCONNECTED event schedules the next attempt too; this covers a driver that sends none.
        esp_wifi_disconnect();
    }
    phase_ = Phase::waiting;
    next_attempt_ = now + kRetryMinUs;
}

void WifiSta::store_pin()
{
    const Pin &p = pins_.stored();
    fr_link_pin_t link;
    std::memset(&link, 0, sizeof(link));
    link.channel = p.channel;
    std::memcpy(link.bssid, p.bssid.data(), sizeof(link.bssid));
    link.ssid_hash = p.ssid_hash;
    esp_err_t err = fr_id_save_link(&link);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "wifi: pin not stored (%s)", esp_err_to_name(err));
    }
}

void WifiSta::apply_band()
{
#if CONFIG_SOC_WIFI_SUPPORT_5G
    constexpr bool kHas5g = true;
#else
    constexpr bool kHas5g = false;
#endif
    const Band band = band_from_ident(band_);
    wifi_band_mode_t mode = WIFI_BAND_MODE_AUTO;
    switch (band_action(band, kHas5g)) {
    case BandAction::none:
        return;
    case BandAction::refuse_5g:
        ESP_LOGE(TAG, "wifi: band 5g provisioned on a chip without 5 GHz; staying on 2.4 GHz");
        return;
    case BandAction::only_2g:
        mode = WIFI_BAND_MODE_2G_ONLY;
        break;
    case BandAction::only_5g:
        mode = WIFI_BAND_MODE_5G_ONLY;
        break;
    case BandAction::both:
        mode = WIFI_BAND_MODE_AUTO;
        break;
    }
    const esp_err_t err = esp_wifi_set_band_mode(mode);
    if (err == ESP_OK) {
        ESP_LOGI(TAG, "wifi: band %s", band_name(band));
    } else {
        ESP_LOGE(TAG, "esp_wifi_set_band_mode: %s", esp_err_to_name(err));
    }
}

void WifiSta::on_event(const Event &e, TimeUs now)
{
    if (e.base == WIFI_EVENT) {
        switch (e.id) {
        case WIFI_EVENT_STA_START:
            started_ = true;
            apply_band();    // before keep_channel and the first scan: C may be a 5 GHz channel
            keep_channel();  // ESP-NOW on C from the start, whatever the first join does
            attempt(now);
            break;
        case WIFI_EVENT_STA_STOP:
            started_ = false;
            phase_ = Phase::idle;
            break;
        case WIFI_EVENT_SCAN_DONE: {
            if (phase_ != Phase::scanning) {
                esp_wifi_clear_ap_list();
                break;
            }
            bool found = false;
            if (search_ == Search::ssid_on_c) {
                found = pick_ap();
            } else {
                uint16_t n = 0;
                esp_wifi_scan_get_ap_num(&n);
                esp_wifi_clear_ap_list();  // frees the driver's list; only "found" matters
                found = n > 0;
            }
            if (found) {
                connect(now, true);
            } else {
                retry_later(now);
            }
            break;
        }
        case WIFI_EVENT_STA_CONNECTED: {
            const wifi_event_sta_connected_t &c = e.data.connected;
            if (held_) {
                // A join that completed as the hold began: drop it too.
                esp_wifi_disconnect();
                break;
            }
            phase_ = Phase::associated;
            retry_us_ = kRetryMinUs;
            lost_since_ = 0;
            next_rssi_ = now;
            // fr_link's pin, or (during a trial) the trial's, written to fr_link only once it is confirmed.
            if (pins_.associated(c.bssid, c.channel)) {
                store_pin();
            }
            set_home(c.channel);
            publish([&](Snapshot &s) {
                s.associated = true;
                s.channel = c.channel;
                std::memcpy(s.bssid, c.bssid, sizeof(s.bssid));
            });
            ESP_LOGI(TAG, "wifi: associated with %02x:%02x:%02x:%02x:%02x:%02x on channel %u", c.bssid[0], c.bssid[1],
                     c.bssid[2], c.bssid[3], c.bssid[4], c.bssid[5], c.channel);
            break;
        }
        case WIFI_EVENT_STA_DISCONNECTED: {
            bool was = phase_ == Phase::associated;
            ip_up_ = false;
            disconnect_reason_ = e.data.disconnected.reason;
            if (lost_since_ == 0) {
                lost_since_ = now;
            }
            uint16_t reason = disconnect_reason_;
            publish([reason](Snapshot &s) {
                s.associated = false;
                s.ip_up = false;
                std::memset(s.ip, 0, sizeof(s.ip));
                s.rssi = 0;
                ++s.disconnects;
                s.last_reason = reason;
            });
            if (was) {
                ESP_LOGW(TAG, "wifi: disconnected (reason %u)", e.data.disconnected.reason);
            } else {
                ESP_LOGD(TAG, "wifi: join failed (reason %u)", e.data.disconnected.reason);
            }
            if (held_) {
                keep_channel();  // the STA is idle now: back on C for the hold's duration
            } else if (phase_ != Phase::waiting) {
                retry_later(now);
            }
            break;
        }
        case WIFI_EVENT_HOME_CHANNEL_CHANGE: {
            // The router moved channel C (05 §5.4): associated nodes follow it; re-pin.
            const wifi_event_home_channel_change_t &c = e.data.channel;
            if (phase_ == Phase::associated) {
                if (pins_.associated(nullptr, c.new_chan)) {
                    store_pin();
                }
                set_home(c.new_chan);
                publish([&](Snapshot &s) { s.channel = c.new_chan; });
                ESP_LOGI(TAG, "wifi: home channel %u -> %u", c.old_chan, c.new_chan);
            }
            break;
        }
        default:
            break;
        }
        return;
    }
    if (e.base == IP_EVENT) {
        if (e.id == IP_EVENT_STA_GOT_IP) {
            const esp_ip4_addr_t &a = e.data.got_ip.ip_info.ip;
            ip_up_ = true;
            disconnect_reason_ = 0;
            uint8_t ip[4] = {esp_ip4_addr1(&a), esp_ip4_addr2(&a), esp_ip4_addr3(&a), esp_ip4_addr4(&a)};
            publish([&](Snapshot &s) {
                s.ip_up = true;
                std::memcpy(s.ip, ip, sizeof(s.ip));
            });
            ESP_LOGI(TAG, "wifi: got %u.%u.%u.%u", ip[0], ip[1], ip[2], ip[3]);
            if (trial_) {
                // The pushed network works: keep it for good (06 §6.3).
                trial_ = false;
                trial_deadline_ = 0;
                if (pins_.confirm()) {
                    store_pin();  // the trial's pin is fr_link's now
                }
                override_.confirmed = true;
                esp_err_t err = fr_id_save_net_override(&override_);
                if (err != ESP_OK) {
                    ESP_LOGW(TAG, "wifi: net_set confirmation not stored (%s)", esp_err_to_name(err));
                }
                publish([](Snapshot &s) { s.override_trial = false; });
                ESP_LOGI(TAG, "wifi: net_set network confirmed");
            }
        } else if (e.id == IP_EVENT_STA_LOST_IP) {
            ip_up_ = false;
            publish([](Snapshot &s) {
                s.ip_up = false;
                std::memset(s.ip, 0, sizeof(s.ip));
            });
        }
    }
}

bool WifiSta::request_override(const fr_net_creds_t &creds, TimeUs now)
{
    bool ok = false;
    portENTER_CRITICAL(&mux_);
    if (!pending_) {
        pending_ = true;
        pending_at_ = now + kApplyDelayUs;
        pending_creds_ = creds;
        ok = true;
    }
    portEXIT_CRITICAL(&mux_);
    if (ok) {
        wake();
    }
    return ok;
}

void WifiSta::request_down(uint32_t seconds, TimeUs now)
{
    portENTER_CRITICAL(&mux_);
    down_pending_ = true;
    down_at_ = now + kApplyDelayUs;
    down_s_ = seconds;
    portEXIT_CRITICAL(&mux_);
    wake();
}

void WifiSta::request_protocol(bool ax, TimeUs now)
{
    portENTER_CRITICAL(&mux_);
    proto_pending_ = true;
    proto_at_ = now + kApplyDelayUs;
    proto_ax_ = ax;
    portEXIT_CRITICAL(&mux_);
    wake();
}

void WifiSta::apply_down(uint32_t seconds, TimeUs now)
{
    if (seconds == 0) {
        if (held_) {
            release(now);
        }
        return;
    }
    const bool was = held_;
    held_ = true;
    held_until_ = now + static_cast<TimeUs>(seconds) * 1'000'000;
    const TimeUs until = held_until_;
    publish([until](Snapshot &s) {
        s.held = true;
        s.held_until = until;
    });
    if (was) {
        ESP_LOGW(TAG, "wifi: down (debug hook) now for %u s", static_cast<unsigned>(seconds));
        return;
    }
    ESP_LOGW(TAG, "wifi: down for %u s (debug hook): no join and no scan, the radio stays on channel %u",
             static_cast<unsigned>(seconds), home_channel_);
    switch (phase_) {
    case Phase::scanning:
        esp_wifi_scan_stop();
        break;
    case Phase::connecting:
    case Phase::associated:
        esp_wifi_disconnect();  // its DISCONNECTED event drops the links and puts the radio on C again
        break;
    default:
        break;
    }
    phase_ = Phase::held;
    keep_channel();
}

void WifiSta::release(TimeUs now)
{
    held_ = false;
    publish([](Snapshot &s) {
        s.held = false;
        s.held_until = 0;
    });
    ESP_LOGW(TAG, "wifi: down hook over, rejoining '%s'", creds_.ssid);
    phase_ = Phase::waiting;
    next_attempt_ = now;
    retry_us_ = kRetryMinUs;
    // The pinned AP first: any sweep waits its full time again from here, and a trial gets its 60 s back.
    lost_since_ = now;
    if (trial_) {
        trial_deadline_ = now + kTrialUs;
    }
}

void WifiSta::apply_override(const fr_net_creds_t &c, TimeUs now)
{
    override_ = {};
    override_.creds = c;
    override_.base_prov_ts = prov_ts_;
    override_.confirmed = false;
    esp_err_t err = fr_id_save_net_override(&override_);
    if (err != ESP_OK) {
        // It is tried all the same; a reboot then returns to the base network.
        ESP_LOGW(TAG, "wifi: net_set not stored (%s)", esp_err_to_name(err));
    }
    fr_net_creds_t use = c;
    if (use.hub_host[0] == '\0') {
        std::memcpy(use.hub_host, base_.hub_host, sizeof(use.hub_host));
    }
    use_creds(use, true, true, now);
    zero_creds(use);
    ESP_LOGI(TAG, "wifi: net_set: joining '%s' (reverted unless it joins within 60 s)", c.ssid);
    if (held_) {
        trial_deadline_ = held_until_ + kTrialUs;  // joined when the hold ends; its 60 s count from then
        return;
    }
    rejoin(now);
}

void WifiSta::revert_override(TimeUs now)
{
    ESP_LOGW(TAG, "wifi: net_set network '%s' did not join in 60 s; back to '%s'", creds_.ssid,
             base_.ssid[0] != '\0' ? base_.ssid : "(none)");
    esp_err_t err = fr_id_clear_net_override();
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "wifi: fr_net2 not cleared (%s)", esp_err_to_name(err));
    }
    zero_creds(override_.creds);
    // C follows the base network's pin again (use_creds), or is unknown until it associates: a trial that
    // associated without an address left C on its own AP's channel.
    use_creds(base_, false, false, now);
    rejoin(now);
}

void WifiSta::poll(TimeUs now)
{
    bool take = false;
    fr_net_creds_t pushed;
    portENTER_CRITICAL(&mux_);
    if (pending_ && now >= pending_at_) {
        pending_ = false;
        pushed = pending_creds_;
        zero_creds(pending_creds_);
        take = true;
    }
    portEXIT_CRITICAL(&mux_);
    if (take) {
        apply_override(pushed, now);
        zero_creds(pushed);
    }

    bool down = false;
    uint32_t down_s = 0;
    portENTER_CRITICAL(&mux_);
    if (down_pending_ && now >= down_at_) {
        down_pending_ = false;
        down = true;
        down_s = down_s_;
    }
    portEXIT_CRITICAL(&mux_);
    if (down) {
        apply_down(down_s, now);
    }

    bool proto = false;
    bool ax = false;
    portENTER_CRITICAL(&mux_);
    if (proto_pending_ && now >= proto_at_) {
        proto_pending_ = false;
        proto = true;
        ax = proto_ax_;
    }
    portEXIT_CRITICAL(&mux_);
    if (proto) {
        // Design m2-c4-gateway D19 (e): the protocols an association negotiates, so a rejoin follows (the hold's end
        // does it during a wifi_down).
        const Protocols want = wifi_protocols(ax);
        wifi_protocols_t p = {.ghz_2g = want.ghz_2g, .ghz_5g = want.ghz_5g};
        esp_err_t err = esp_wifi_set_protocols(WIFI_IF_STA, &p);
        ESP_LOGW(TAG, "wifi: protocols 2g 0x%02x 5g 0x%02x (debug hook): %s%s", want.ghz_2g, want.ghz_5g, esp_err_to_name(err),
                 err == ESP_OK && !held_ ? ", rejoining" : "");
        if (err == ESP_OK && !held_) {
            rejoin(now);
        }
    }

    if (trial_ && !held_ && now >= trial_deadline_ && !ip_up_) {
        revert_override(now);
    }

    switch (phase_) {
    case Phase::waiting:
        if (now >= next_attempt_) {
            attempt(now);
        }
        break;
    case Phase::scanning:
        if (now >= phase_deadline_) {
            esp_wifi_scan_stop();
            retry_later(now);
        }
        break;
    case Phase::connecting:
        if (now >= phase_deadline_) {
            ESP_LOGW(TAG, "wifi: join of '%s' timed out", creds_.ssid);
            esp_wifi_disconnect();
            retry_later(now);
        }
        break;
    case Phase::associated:
        if (now >= next_rssi_) {
            next_rssi_ = now + kRssiEveryUs;
            int rssi = 0;
            if (esp_wifi_sta_get_rssi(&rssi) == ESP_OK) {
                publish([&](Snapshot &s) { s.rssi = static_cast<int8_t>(std::clamp(rssi, -128, 127)); });
            }
        }
        break;
    case Phase::held:
        if (now >= held_until_) {
            release(now);
        }
        break;
    case Phase::idle:
        break;
    }
}

TimeUs WifiSta::next_deadline() const
{
    TimeUs t = 0;
    auto consider = [&t](TimeUs d) {
        if (d != 0 && (t == 0 || d < t)) {
            t = d;
        }
    };
    if (phase_ == Phase::waiting) {
        consider(next_attempt_);
    } else if (phase_ == Phase::scanning || phase_ == Phase::connecting) {
        consider(phase_deadline_);
    } else if (phase_ == Phase::associated) {
        consider(next_rssi_);
    } else if (phase_ == Phase::held) {
        consider(held_until_);
    }
    if (trial_ && !held_) {
        consider(trial_deadline_);
    }
    portENTER_CRITICAL(&mux_);
    if (pending_) {
        consider(pending_at_);
    }
    if (proto_pending_) {
        consider(proto_at_);
    }
    if (down_pending_) {
        consider(down_at_);
    }
    portEXIT_CRITICAL(&mux_);
    return t;
}

void WifiSta::fill(Status &out) const
{
    portENTER_CRITICAL(&mux_);
    Snapshot s = snap_;
    portEXIT_CRITICAL(&mux_);
    out.associated = s.associated;
    out.ip_up = s.ip_up;
    std::memcpy(out.ssid, s.ssid, sizeof(out.ssid));
    out.channel = s.associated ? s.channel : 0;
    std::memcpy(out.bssid, s.bssid, sizeof(out.bssid));
    out.rssi = s.rssi;
    std::memcpy(out.ip, s.ip, sizeof(out.ip));
    out.override_active = s.override_active;
    out.override_trial = s.override_trial;
    out.wifi_disconnects = s.disconnects;
    out.wifi_last_reason = s.last_reason;
    out.home_channel = s.home_channel;
    out.wifi_held = s.held;
    if (s.held) {
        const TimeUs left = s.held_until - esp_timer_get_time();
        out.wifi_held_s = left > 0 ? static_cast<uint32_t>((left + 999'999) / 1'000'000) : 0;
    }
}

LinkInfo WifiSta::link_info() const
{
    portENTER_CRITICAL(&mux_);
    Snapshot s = snap_;
    portEXIT_CRITICAL(&mux_);
    LinkInfo li;
    li.wifi_up = s.ip_up;
    li.sweeps = s.sweeps;
    if (s.associated) {
        li.channel = s.channel;
        std::copy(std::begin(s.bssid), std::end(s.bssid), li.bssid.begin());
        li.rssi = s.rssi;
    }
    return li;
}

}  // namespace fr::net::esp::detail
