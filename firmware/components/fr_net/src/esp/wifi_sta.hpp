// Wi-Fi STA policy (spec 05 §5.3-5.4, design c3 §3): the first join is by SSID (or fr_ident's BSSID) and
// takes the strongest AP; every association pins its channel C and BSSID in nvs:fr_link; a lost link is
// rejoined by scanning only channel C for the pinned BSSID (active, 30 ms) and connecting to it once
// found, with an all-channel sweep only after 60 s without it. fr.node.net_set pushes an override
// (nvs:fr_net2) that is reverted unless it joins within 60 s. Private to fr_net/src/esp; everything but
// request_override() and the snapshot readers runs on the fr_net task.
#pragma once

#include <cstdint>

#include "esp_event.h"
#include "esp_netif_types.h"
#include "esp_wifi_types.h"
#include "fr/base.hpp"
#include "fr/id.h"
#include "fr/net/esp.hpp"
#include "freertos/FreeRTOS.h"

namespace fr::net::esp::detail {

/** One Wi-Fi or IP event, copied out of the default event loop for the fr_net task (POD: queue-copied). */
struct Event {
    esp_event_base_t base;
    int32_t id;
    union {
        wifi_event_sta_connected_t connected;
        wifi_event_sta_disconnected_t disconnected;
        wifi_event_home_channel_change_t channel;
        ip_event_got_ip_t got_ip;
    } data;
};

/** Wakes the fr_net task (its select() watches an eventfd); any task. */
void wake();

class WifiSta
{
public:
    static constexpr TimeUs kRetryMinUs = 250'000;
    static constexpr TimeUs kRetryMaxUs = 2'000'000;
    static constexpr uint32_t kPinScanMs = 30;           // 05 §5.4: active, <= 30 ms on channel C
    static constexpr TimeUs kSweepAfterUs = 60'000'000;  // 05 §5.4: no ESP-NOW yet, so 60 s without the AP
    static constexpr TimeUs kTrialUs = 60'000'000;       // 06 §6.3: fr_net2 reverted after 60 s
    static constexpr TimeUs kApplyDelayUs = 300'000;     // net_set: let its RESULT leave first
    static constexpr TimeUs kScanTimeoutUs = 1'000'000;  // no SCAN_DONE: give up on that scan
    static constexpr TimeUs kConnectTimeoutUs = 20'000'000;  // no CONNECTED/DISCONNECTED: start over
    static constexpr TimeUs kRssiEveryUs = 1'000'000;

    /** Base credentials, the override of nvs:fr_net2 (dropped if from another provisioning), the pin. */
    void configure(const Settings &s, TimeUs now);
    void on_event(const Event &e, TimeUs now);
    /** Retries, the trial's revert, a pending net_set, RSSI refresh. */
    void poll(TimeUs now);
    /** The earliest time poll() has something to do; 0 when nothing is scheduled. */
    TimeUs next_deadline() const;

    /** Core task: queues a net_set. False while another one waits to apply. */
    bool request_override(const fr_net_creds_t &creds, TimeUs now);

    bool ip_up() const { return ip_up_; }
    /** wifi_err_reason_t of the last disconnect; 0 after an address came (an address lost on its own). */
    uint16_t disconnect_reason() const { return disconnect_reason_; }
    /** The hub host of the credentials in use (an override without one keeps the base's). */
    const char *hub_host() const { return creds_.hub_host; }

    /** Any task. */
    void fill(Status &s) const;
    LinkInfo link_info() const;

private:
    enum class Phase : uint8_t { idle, waiting, scanning, connecting, associated };

    /** The Wi-Fi state other tasks read (link_info, diag), under a spinlock. */
    struct Snapshot {
        bool associated = false;
        bool ip_up = false;
        uint8_t ip[4] = {};
        uint8_t channel = 0;
        uint8_t bssid[6] = {};
        int8_t rssi = 0;
        char ssid[FR_ID_SSID_MAX + 1] = {};
        bool override_active = false;
        bool override_trial = false;
        uint32_t disconnects = 0;
        uint16_t last_reason = 0;  // wifi_err_reason_t of the last disconnect
        uint32_t sweeps = 0;       // all-channel sweeps started (05 §5.4: HEARTBEAT swept)
    };

    bool have_creds() const { return creds_.ssid[0] != '\0'; }
    bool pin_usable() const;
    void attempt(TimeUs now);
    void connect(TimeUs now, bool pinned);
    void retry_later(TimeUs now);
    /** Drops the current association (if any) and joins with creds_ again soon. */
    void rejoin(TimeUs now);
    void use_creds(const fr_net_creds_t &c, bool is_override, bool trial, TimeUs now);
    void apply_override(const fr_net_creds_t &c, TimeUs now);
    void revert_override(TimeUs now);
    void remember_pin(const uint8_t bssid[6], uint8_t channel);

    /** Edits the snapshot under its lock; `edit` must be short (it runs with interrupts masked). */
    template <class F>
    void publish(F &&edit)
    {
        portENTER_CRITICAL(&mux_);
        edit(snap_);
        portEXIT_CRITICAL(&mux_);
    }

    fr_net_creds_t base_{};
    fr_net_creds_t creds_{};
    fr_net_override_t override_{};  // what fr_net2 holds while an override is active
    uint32_t prov_ts_ = 0;
    bool override_active_ = false;
    bool trial_ = false;
    TimeUs trial_deadline_ = 0;

    fr_link_pin_t pin_{};
    bool pin_loaded_ = false;

    Phase phase_ = Phase::idle;
    bool started_ = false;
    bool ip_up_ = false;
    uint16_t disconnect_reason_ = 0;
    TimeUs retry_us_ = kRetryMinUs;
    TimeUs next_attempt_ = 0;
    TimeUs phase_deadline_ = 0;  // scanning / connecting safety net
    TimeUs lost_since_ = 0;      // no association since (0: associated, or never tried)
    TimeUs last_sweep_ = 0;
    TimeUs next_rssi_ = 0;

    // net_set handover from the core task.
    mutable portMUX_TYPE mux_ = portMUX_INITIALIZER_UNLOCKED;
    bool pending_ = false;
    TimeUs pending_at_ = 0;
    fr_net_creds_t pending_creds_{};

    Snapshot snap_;  // under mux_
};

}  // namespace fr::net::esp::detail
