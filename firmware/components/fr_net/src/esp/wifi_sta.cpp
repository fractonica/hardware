#include "wifi_sta.hpp"

#include <algorithm>
#include <cstdio>
#include <cstring>

#include "esp_log.h"
#include "esp_wifi.h"

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
    base_ = s.creds;
    prov_ts_ = s.prov_ts;
    lost_since_ = now;  // a pin found at boot counts its 60 s from here
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
    pin_loaded_ = fr_id_load_link(&pin_) == ESP_OK;
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
}

bool WifiSta::pin_usable() const
{
    // A pin from another network (another SSID), a trial of a new one, or a pin that is not the BSSID the
    // credentials name: join by SSID (or that BSSID) instead. fr_link survives a reprovision, and 05 §5.4
    // joins fr_ident's BSSID first, so a mesh home can move every node to one AP.
    return pin_loaded_ && !trial_ && pin_.ssid_hash == fr_id_ssid_hash(creds_.ssid) &&
           (!creds_.has_bssid || std::memcmp(pin_.bssid, creds_.bssid, sizeof(pin_.bssid)) == 0);
}

void WifiSta::attempt(TimeUs now)
{
    if (!started_ || !have_creds()) {
        phase_ = Phase::idle;
        return;
    }
    bool pinned = pin_usable();
    bool sweep = lost_since_ != 0 && now - lost_since_ >= kSweepAfterUs && now - last_sweep_ >= kSweepAfterUs;
    if (pinned && !sweep) {
        // 05 §5.4: scan only channel C for the pinned BSSID and connect once it answers, so a router
        // outage never sends the radio off channel C (ESP-NOW keeps working there from C5 on).
        wifi_scan_config_t sc;
        std::memset(&sc, 0, sizeof(sc));
        sc.bssid = pin_.bssid;
        sc.channel = pin_.channel;
        sc.show_hidden = true;
        sc.scan_type = WIFI_SCAN_TYPE_ACTIVE;
        sc.scan_time.active.min = 0;
        sc.scan_time.active.max = kPinScanMs;
        esp_err_t err = esp_wifi_scan_start(&sc, false);
        if (err != ESP_OK) {
            ESP_LOGD(TAG, "wifi: channel %u scan not started (%s)", pin_.channel, esp_err_to_name(err));
            retry_later(now);
            return;
        }
        phase_ = Phase::scanning;
        phase_deadline_ = now + kScanTimeoutUs;
        return;
    }
    if (sweep) {
        last_sweep_ = now;
        if (pinned) {
            // 05 §5.4 "Heartbeats report each sweep": Net sets HEARTBEAT swept for each new one.
            publish([](Snapshot &s) { ++s.sweeps; });
            ESP_LOGI(TAG, "wifi: pinned AP missing for 60 s, sweeping all channels for '%s'", creds_.ssid);
        }
    }
    connect(now, false);
}

void WifiSta::connect(TimeUs now, bool pinned)
{
    wifi_config_t cfg;
    std::memset(&cfg, 0, sizeof(cfg));
    copy_field(cfg.sta.ssid, creds_.ssid);
    copy_field(cfg.sta.password, creds_.pass);
    if (pinned) {
        // bssid_set + channel: the driver's own pre-connect scan starts on C and takes only that AP.
        cfg.sta.bssid_set = true;
        std::memcpy(cfg.sta.bssid, pin_.bssid, sizeof(cfg.sta.bssid));
        cfg.sta.channel = pin_.channel;
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

void WifiSta::remember_pin(const uint8_t bssid[6], uint8_t channel)
{
    uint32_t h = fr_id_ssid_hash(creds_.ssid);
    if (pin_loaded_ && pin_.channel == channel && pin_.ssid_hash == h && std::memcmp(pin_.bssid, bssid, 6) == 0) {
        return;  // unchanged: no flash write
    }
    pin_.channel = channel;
    std::memcpy(pin_.bssid, bssid, sizeof(pin_.bssid));
    pin_.ssid_hash = h;
    pin_loaded_ = true;
    esp_err_t err = fr_id_save_link(&pin_);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "wifi: pin not stored (%s)", esp_err_to_name(err));
    }
}

void WifiSta::on_event(const Event &e, TimeUs now)
{
    if (e.base == WIFI_EVENT) {
        switch (e.id) {
        case WIFI_EVENT_STA_START:
            started_ = true;
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
            uint16_t found = 0;
            esp_wifi_scan_get_ap_num(&found);
            esp_wifi_clear_ap_list();  // frees the driver's list; only "found" matters
            if (found > 0) {
                connect(now, true);
            } else {
                retry_later(now);
            }
            break;
        }
        case WIFI_EVENT_STA_CONNECTED: {
            const wifi_event_sta_connected_t &c = e.data.connected;
            phase_ = Phase::associated;
            retry_us_ = kRetryMinUs;
            lost_since_ = 0;
            next_rssi_ = now;
            remember_pin(c.bssid, c.channel);
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
            if (phase_ != Phase::waiting) {
                retry_later(now);
            }
            break;
        }
        case WIFI_EVENT_HOME_CHANNEL_CHANGE: {
            // The router moved channel C (05 §5.4): associated nodes follow it; re-pin.
            const wifi_event_home_channel_change_t &c = e.data.channel;
            if (phase_ == Phase::associated && pin_loaded_) {
                uint8_t bssid[6];
                std::memcpy(bssid, pin_.bssid, sizeof(bssid));
                remember_pin(bssid, c.new_chan);
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

    if (trial_ && now >= trial_deadline_ && !ip_up_) {
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
    }
    if (trial_) {
        consider(trial_deadline_);
    }
    portENTER_CRITICAL(&mux_);
    if (pending_) {
        consider(pending_at_);
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
