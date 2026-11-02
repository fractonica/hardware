// wifi_csi (design csi-c1 D7, D8, §12): hal::CsiSource on esp_wifi's CSI and lwIP's esp_ping. The header says what
// runs where. The host suite builds this file unchanged against firmware/test/host/shim/idf (the C5's types).
#include "fr/drv/wifi_csi.hpp"

#include <algorithm>
#include <cstring>
#include <iterator>

#include "esp_log.h"
#include "esp_netif.h"
#include "esp_task.h"  // ESP_TASK_PING_STACK, which ESP_PING_DEFAULT_CONFIG uses
#include "esp_timer.h"
#include "esp_wifi.h"
#include "lwip/ip_addr.h"
#include "ping/ping_sock.h"
#include "sdkconfig.h"

namespace fr::drv {
namespace {

constexpr const char *TAG = "wifi_csi";
#ifdef CONFIG_FREERTOS_HZ
constexpr uint32_t kTickHz = CONFIG_FREERTOS_HZ;
#else
constexpr uint32_t kTickHz = 1000;  // the host shim's pdMS_TO_TICKS
#endif
static_assert(1000 % kTickHz == 0, "a tick of whole milliseconds: esp_ping's interval_ms is pdMS_TO_TICKS'd");

void csi_cb(void *ctx, wifi_csi_info_t *info)
{
    static_cast<WifiCsi *>(ctx)->on_rx(info);
}

void ping_ok(esp_ping_handle_t, void *args)
{
    static_cast<WifiCsi *>(args)->on_ping(true);
}

void ping_timeout(esp_ping_handle_t, void *args)
{
    static_cast<WifiCsi *>(args)->on_ping(false);
}

void poll_timer(void *arg)
{
    static_cast<WifiCsi *>(arg)->on_poll_timer();
}

bool same(const hal::CsiCapture &a, const hal::CsiCapture &b)
{
    return a.mode == b.mode && a.rate_hz == b.rate_hz && a.format == b.format && a.has_peer == b.has_peer &&
           (!a.has_peer || a.peer == b.peer);
}

/** The CSI asked of the hardware for `f` (the header lists the bits per chip). */
wifi_csi_config_t csi_config(hal::CsiFormat f)
{
    const bool ht = f == hal::CsiFormat::auto_ || f == hal::CsiFormat::ht;
    wifi_csi_config_t c;
    std::memset(&c, 0, sizeof(c));
#if CONFIG_SOC_WIFI_HE_SUPPORT
    const bool he = f == hal::CsiFormat::auto_ || f == hal::CsiFormat::he;
    c.enable = 1;
    c.acquire_csi_legacy = 1;  // L-LTF always (design D7: format auto keeps it on)
    c.acquire_csi_ht20 = ht ? 1 : 0;
    c.acquire_csi_ht40 = ht ? 1 : 0;
    c.acquire_csi_su = he ? 1 : 0;
    c.acquire_csi_mu = he ? 1 : 0;
    c.acquire_csi_dcm = he ? 1 : 0;
    c.acquire_csi_beamformed = he ? 1 : 0;
    c.val_scale_cfg = 0;
    c.dump_ack_en = 0;
#if CONFIG_SOC_WIFI_MAC_VERSION_NUM == 3
    c.acquire_csi_force_lltf = f == hal::CsiFormat::lltf ? 1 : 0;
    c.acquire_csi_vht = ht ? 1 : 0;
    c.acquire_csi_he_stbc_mode = 2;  // sample evenly among HE-LTF1 and HE-LTF2
    c.lltf_bit_mode = 1;             // 8-bit I/Q: 2 bytes a subcarrier (106 B for 53 LLTF ones)
#else
    c.acquire_csi_he_stbc = 2;
#endif
#else
    c.lltf_en = true;
    c.htltf_en = ht;
    c.stbc_htltf2_en = ht;
    c.ltf_merge_en = false;
    c.channel_filter_en = false;  // keep adjacent subcarriers independent
    c.manu_scale = false;
    c.shift = 0;
    c.dump_ack_en = false;
#endif
    return c;
}

}  // namespace

Status WifiCsi::init(Core &core, hal::CsiSink &sink)
{
    core_ = &core;
    sink_ = &sink;
    const esp_timer_create_args_t args = {
        .callback = poll_timer,
        .arg = this,
        .dispatch_method = ESP_TIMER_TASK,
        .name = "fr_csi",
        .skip_unhandled_events = true,
    };
    esp_timer_handle_t t = nullptr;
    if (esp_timer_create(&args, &t) != ESP_OK) {
        return std::unexpected(Err::failed);
    }
    timer_ = t;
    return {};
}

Status WifiCsi::capture(const hal::CsiCapture &c)
{
    if ((c.mode == hal::CsiMode::peer && !c.has_peer) || c.rate_hz < 10 || c.rate_hz > 200) {
        return std::unexpected(Err::invalid_args);
    }
    if (timer_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    want_ = c;
    if (!has_want_) {
        has_want_ = true;
        esp_timer_start_periodic(static_cast<esp_timer_handle_t>(timer_), kPollUs);
    }
    poll();
    return {};
}

Status WifiCsi::stop()
{
    if (has_want_) {
        has_want_ = false;
        esp_timer_stop(static_cast<esp_timer_handle_t>(timer_));
    }
    teardown();
    return {};
}

hal::Selftest WifiCsi::selftest()
{
#if !CONFIG_ESP_WIFI_CSI_ENABLED
    return {false, "wifi_csi: CONFIG_ESP_WIFI_CSI_ENABLED is off"};
#else
    if (!cb_registered_) {
        return {false, "wifi_csi: CSI not on yet (the station has no IP)"};
    }
    return {true, "wifi_csi: CSI callback registered"};
#endif
}

void WifiCsi::on_poll_timer()
{
    // esp_timer task: the look itself is the core task's.
    if (core_ == nullptr || poll_posted_.exchange(true, std::memory_order_acq_rel)) {
        return;
    }
    if (!core_->post([this] {
            poll_posted_.store(false, std::memory_order_release);
            poll();
        })) {
        poll_posted_.store(false, std::memory_order_release);  // a full queue: the next tick offers it again
    }
}

void WifiCsi::poll()
{
    if (!has_want_) {
        return;
    }
    esp_netif_t *netif = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
    esp_netif_ip_info_t ip;
    std::memset(&ip, 0, sizeof(ip));
    wifi_ap_record_t ap;
    std::memset(&ap, 0, sizeof(ap));
    const bool up = netif != nullptr && esp_netif_get_ip_info(netif, &ip) == ESP_OK && ip.ip.addr != 0 &&
                    esp_wifi_sta_get_ap_info(&ap) == ESP_OK;
    if (!up) {
        if (applied_) {
            ESP_LOGI(TAG, "station lost its IP: CSI off until it is back");
            teardown();
        }
        return;
    }
    if (applied_ && same(want_, applied_cap_) && applied_gw_ == ip.gw.addr && applied_channel_ == ap.primary &&
        std::equal(applied_bssid_.begin(), applied_bssid_.end(), ap.bssid)) {
        return;
    }
    apply(ip.gw.addr, ap.bssid, ap.primary);
}

void WifiCsi::set_filter(hal::CsiMode mode, const uint8_t *mac)
{
    uint32_t lo = 0;
    uint32_t hi = 0;
    if (mac != nullptr) {
        lo = static_cast<uint32_t>(mac[0]) | static_cast<uint32_t>(mac[1]) << 8 | static_cast<uint32_t>(mac[2]) << 16 |
             static_cast<uint32_t>(mac[3]) << 24;
        hi = static_cast<uint32_t>(mac[4]) | static_cast<uint32_t>(mac[5]) << 8;
    }
    filter_.set({.mode = mode, .lo = lo, .hi = hi});
}

bool WifiCsi::apply(uint32_t gw, const uint8_t (&bssid)[6], uint8_t channel)
{
    const hal::CsiCapture &c = want_;
    set_filter(c.mode, c.mode == hal::CsiMode::router ? bssid : c.mode == hal::CsiMode::peer ? c.peer.data() : nullptr);
    const wifi_csi_config_t cfg = csi_config(c.format);
    esp_err_t err = esp_wifi_set_csi_config(&cfg);
    if (err == ESP_OK) {
        err = esp_wifi_set_csi_rx_cb(csi_cb, this);
    }
    if (err == ESP_OK) {
        err = esp_wifi_set_csi(true);
    }
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "CSI not on (%s); trying again", esp_err_to_name(err));
        return false;  // the next poll tries again (applied_ stays as it was)
    }
    cb_registered_ = true;
    stop_pings();
    if (c.mode == hal::CsiMode::router && gw != 0) {
        // Whole ticks (esp_ping's vTaskDelayUntil): the nearest rate the tick allows, said in the log line below.
        const uint32_t ticks = ping_ticks(c.rate_hz, kTickHz);
        esp_ping_config_t pc = ESP_PING_DEFAULT_CONFIG();
        pc.count = ESP_PING_COUNT_INFINITE;
        pc.interval_ms = ticks * (1000 / kTickHz);
        pc.timeout_ms = pc.interval_ms;  // a reply that comes later still carries its CSI
        ip4_addr_t g;
        g.addr = gw;
        ip_addr_copy_from_ip4(pc.target_addr, g);
        const esp_ping_callbacks_t cbs = {
            .cb_args = this,
            .on_ping_success = ping_ok,
            .on_ping_timeout = ping_timeout,
            .on_ping_end = nullptr,
        };
        esp_ping_handle_t h = nullptr;
        err = esp_ping_new_session(&pc, &cbs, &h);
        if (err == ESP_OK && (err = esp_ping_start(h)) == ESP_OK) {
            ping_ = h;
            ping_hz_ = kTickHz / ticks;
        } else {
            if (h != nullptr) {
                esp_ping_delete_session(h);
            }
            ESP_LOGW(TAG, "no ping session to the gateway (%s): router CSI comes only from the AP's own frames",
                     esp_err_to_name(err));
        }
    }
    applied_ = true;
    applied_cap_ = c;
    applied_gw_ = gw;
    std::copy(std::begin(bssid), std::end(bssid), applied_bssid_.begin());
    applied_channel_ = channel;
    if (ping_ != nullptr) {
        ESP_LOGI(TAG, "CSI on: source router, channel %u, pings at %u Hz (rate_hz %u, in whole %u ms ticks)",
                 static_cast<unsigned>(channel), static_cast<unsigned>(ping_hz_), static_cast<unsigned>(c.rate_hz),
                 static_cast<unsigned>(1000 / kTickHz));
    } else {
        ESP_LOGI(TAG, "CSI on: source %s, channel %u, no pings", c.mode == hal::CsiMode::router ? "router"
                                                               : c.mode == hal::CsiMode::peer ? "peer"
                                                                                               : "any",
                 static_cast<unsigned>(channel));
    }
    return true;
}

void WifiCsi::stop_pings()
{
    if (ping_ != nullptr) {
        esp_ping_stop(ping_);
        esp_ping_delete_session(ping_);
        ping_ = nullptr;
    }
    ping_hz_ = 0;
}

void WifiCsi::teardown()
{
    stop_pings();
    if (applied_ || cb_registered_) {
        esp_wifi_set_csi(false);
    }
    applied_ = false;
}

void WifiCsi::on_ping(bool replied)
{
    pings_sent_.fetch_add(1, std::memory_order_relaxed);
    if (!replied) {
        pings_lost_.fetch_add(1, std::memory_order_relaxed);
    }
}

void WifiCsi::on_rx(const void *raw)
{
    // Wi-Fi task: copy and return.
    const auto *info = static_cast<const wifi_csi_info_t *>(raw);
    if (info == nullptr || info->buf == nullptr || info->len == 0 || sink_ == nullptr) {
        return;
    }
    const wifi_pkt_rx_ctrl_t &rx = info->rx_ctrl;
#if CONFIG_SOC_WIFI_HE_SUPPORT
    if (!rx.rx_channel_estimate_info_vld) {
        skipped_.fetch_add(1, std::memory_order_relaxed);
        return;
    }
#endif
    if (info->len > hal::kCsiDataMax) {
        // Not a record the wire carries (len <= 512, design §12): dropped whole, never cut short.
        oversized_.fetch_add(1, std::memory_order_relaxed);
        skipped_.fetch_add(1, std::memory_order_relaxed);
        return;
    }
    CsiFilter::Value f;
    if (!filter_.get(f)) {
        skipped_.fetch_add(1, std::memory_order_relaxed);  // the filter changed twice during the read: never waited for
        return;
    }
    const uint8_t *m = info->mac;
    const bool matched = f.mode != hal::CsiMode::any &&
                         (static_cast<uint32_t>(m[0]) | static_cast<uint32_t>(m[1]) << 8 |
                          static_cast<uint32_t>(m[2]) << 16 | static_cast<uint32_t>(m[3]) << 24) == f.lo &&
                         (static_cast<uint32_t>(m[4]) | static_cast<uint32_t>(m[5]) << 8) == f.hi;
    if (f.mode != hal::CsiMode::any && !matched) {
        skipped_.fetch_add(1, std::memory_order_relaxed);
        return;
    }
    hal::CsiRecord r{};
    r.t_us = rx.timestamp;
    r.rssi = static_cast<int8_t>(rx.rssi);
    r.noise = static_cast<int8_t>(rx.noise_floor);
    r.channel = static_cast<uint8_t>(rx.channel);
#if CONFIG_SOC_WIFI_HE_SUPPORT
    r.bb_format = static_cast<hal::CsiBbFormat>(rx.cur_bb_format);
    const bool group = rx.is_group != 0;
#else
    // sig_mode 0 non-HT (rate < 8: an 11b rate), 1 HT, 3 VHT.
    r.bb_format = rx.sig_mode == 1   ? hal::CsiBbFormat::ht
                  : rx.sig_mode == 3 ? hal::CsiBbFormat::vht
                  : rx.rate < 8      ? hal::CsiBbFormat::b11
                                     : hal::CsiBbFormat::legacy;
    const bool group = (info->dmac[0] & 0x01) != 0;
#endif
    r.flags = static_cast<uint8_t>((info->first_word_invalid ? hal::kCsiFlagFirstWordInvalid : 0) |
                                   (group ? hal::kCsiFlagGroup : 0) | (matched ? hal::kCsiFlagMatched : 0));
    std::copy(m, m + r.mac.size(), r.mac.begin());
    r.data = {info->buf, static_cast<size_t>(info->len)};
    kept_.fetch_add(1, std::memory_order_relaxed);
    sink_->on_csi(r);
}

}  // namespace fr::drv
