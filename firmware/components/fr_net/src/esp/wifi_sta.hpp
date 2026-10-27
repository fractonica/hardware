// Wi-Fi STA policy (spec 05 §5.3-5.4, design c3 §3, c5 §3): the first join is by SSID (or fr_ident's BSSID)
// and takes the strongest AP; every association pins its channel C and BSSID in nvs:fr_link (a net_set
// trial's only once it is confirmed); a lost link is rejoined by scanning only channel C for the pinned BSSID
// (active, 30 ms) and connecting to it once found. Whether, and when, a lost AP is looked for elsewhere
// (another AP of the SSID on C, an all-channel sweep) depends on what ESP-NOW hears: sta_rules.hpp. While
// disconnected the radio is kept on C, where ESP-NOW lives. fr.node.net_set pushes an override (nvs:fr_net2)
// that is reverted unless it joins within 60 s; `net wifi_down` holds the STA off for a while. Private to
// fr_net/src/esp; everything but request_override(), request_down() and the snapshot readers runs on the
// fr_net task.
#pragma once

#include <cstdint>

#include "esp_event.h"
#include "esp_netif_types.h"
#include "esp_wifi_types.h"
#include "fr/base.hpp"
#include "fr/id.h"
#include "fr/net/esp.hpp"
#include "freertos/FreeRTOS.h"
#include "sta_rules.hpp"

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
    static constexpr TimeUs kTrialUs = 60'000'000;       // 06 §6.3: fr_net2 reverted after 60 s
    static constexpr TimeUs kApplyDelayUs = 300'000;     // net_set, wifi_down: let its RESULT leave first
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
    /** Core task: queues `net wifi_down <seconds>` (0 ends a hold); a newer request replaces a waiting one. */
    void request_down(uint32_t seconds, TimeUs now);
    /** Core task: queues `wifi proto` (design m2-c4-gateway D19 (e)): esp_wifi_set_protocol(`bitmap`) and a rejoin
     * (none during a wifi_down hold: its end joins with the new protocols); a newer request replaces a waiting one. */
    void request_protocol(uint8_t bitmap, TimeUs now);

    bool ip_up() const { return ip_up_; }
    /** wifi_err_reason_t of the last disconnect; 0 after an address came (an address lost on its own). */
    uint16_t disconnect_reason() const { return disconnect_reason_; }
    /** The hub host of the credentials in use (an override without one keeps the base's). */
    const char *hub_host() const { return creds_.hub_host; }

    /** Any task. */
    void fill(Status &s) const;
    LinkInfo link_info() const;

private:
    // held: `net wifi_down`; nothing is joined or scanned until it ends.
    enum class Phase : uint8_t { idle, waiting, scanning, connecting, associated, held };

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
        uint8_t home_channel = 0;  // C
        bool held = false;         // `net wifi_down`
        TimeUs held_until = 0;
    };

    bool have_creds() const { return creds_.ssid[0] != '\0'; }
    void attempt(TimeUs now);
    /** The channel C scan for any AP of the SSID answered: the pinned BSSID if it is among them, else the
     * strongest on C, into join_bssid_. False when none is on C. Frees the driver's list. */
    bool pick_ap();
    /** Joins join_bssid_ on join_channel_ (C), or (to_bssid false) by SSID on every channel. */
    void connect(TimeUs now, bool to_bssid);
    void retry_later(TimeUs now);
    /** Drops the current association (if any) and joins with creds_ again soon. */
    void rejoin(TimeUs now);
    /** The credentials in use; C follows their usable pin (or the trial's rules, Pins::home). */
    void use_creds(const fr_net_creds_t &c, bool is_override, bool trial, TimeUs now);
    void apply_override(const fr_net_creds_t &c, TimeUs now);
    void revert_override(TimeUs now);
    /** Writes fr_link's pin (Pins::stored) to nvs:fr_link. */
    void store_pin();
    /** Channel C is now `channel`: ESP-NOW's filter follows, and the radio waits there while disconnected. */
    void set_home(uint8_t channel);
    /** Puts the idle radio on C (esp_wifi_set_channel), so ESP-NOW hears its neighbours between scans. */
    void keep_channel();
    void apply_down(uint32_t seconds, TimeUs now);
    void release(TimeUs now);

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

    Pins pins_;
    Search search_ = Search::first;  // what the last attempt looked for
    uint8_t join_bssid_[6] = {};     // the AP a channel C scan looks for, then connect() joins
    uint8_t join_channel_ = 0;

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
    uint8_t home_channel_ = 0;  // C: Pins::home() (the usable pin's channel), then the associated AP's
    bool held_ = false;         // `net wifi_down` in force
    TimeUs held_until_ = 0;

    // net_set handover from the core task.
    mutable portMUX_TYPE mux_ = portMUX_INITIALIZER_UNLOCKED;
    bool pending_ = false;
    TimeUs pending_at_ = 0;
    fr_net_creds_t pending_creds_{};
    // wifi_down handover from the core task (under mux_ too).
    bool down_pending_ = false;
    TimeUs down_at_ = 0;
    uint32_t down_s_ = 0;
    // `wifi proto` handover from the core task (under mux_ too).
    bool proto_pending_ = false;
    TimeUs proto_at_ = 0;
    uint8_t proto_ = 0;

    Snapshot snap_;  // under mux_
};

}  // namespace fr::net::esp::detail
