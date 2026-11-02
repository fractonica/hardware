// wifi_csi (design csi-c1 D7, D8, §12; spec 07 §7.8): hal::CsiSource on the chip's own Wi-Fi radio. CsiService calls
// capture() and stop() from the core task (fr/hal/csi.hpp); the records arrive on the Wi-Fi task.
#pragma once

#include <array>
#include <atomic>
#include <cstdint>

#include "fr/core/core.hpp"
#include "fr/hal/csi.hpp"

namespace fr::drv {

/**
 * WifiCsi's sender filter: one writer (the core task), one reader (the Wi-Fi task, which on a single core preempts the
 * writer and must never wait for it). Two copies and a counter: the writer fills the copy the counter does not name
 * (stage), then moves the counter on (publish); the reader takes the copy the counter names and checks the counter
 * did not move meanwhile. A writer stopped between the two steps leaves the reader the previous filter, whole. Only a
 * writer on another core that publishes twice during one read (two captures within a few instructions) can spoil a
 * read: get() then tries again, kTries times in all, and answers false (the caller drops the record, counted).
 */
class CsiFilter
{
public:
    struct Value {
        hal::CsiMode mode = hal::CsiMode::router;
        uint32_t lo = 0;  // mac[0..3]
        uint32_t hi = 0;  // mac[4..5]
    };
    static constexpr int kTries = 4;

    /** Core task: `v` into the copy not in use. */
    void stage(const Value &v)
    {
        Copy &c = copies_[(gen_.load(std::memory_order_relaxed) + 1) & 1];
        c.mode.store(static_cast<uint32_t>(v.mode), std::memory_order_relaxed);
        c.lo.store(v.lo, std::memory_order_relaxed);
        c.hi.store(v.hi, std::memory_order_relaxed);
    }
    /** Core task: the staged copy is the one in use from now on. */
    void publish() { gen_.store(gen_.load(std::memory_order_relaxed) + 1, std::memory_order_release); }
    void set(const Value &v)
    {
        stage(v);
        publish();
    }
    /** Wi-Fi task: the filter in use; false when it could not be read whole in kTries (see above). */
    bool get(Value &out) const
    {
        for (int i = 0; i < kTries; ++i) {
            const uint32_t g = gen_.load(std::memory_order_acquire);
            const Copy &c = copies_[g & 1];
            out.mode = static_cast<hal::CsiMode>(c.mode.load(std::memory_order_relaxed));
            out.lo = c.lo.load(std::memory_order_relaxed);
            out.hi = c.hi.load(std::memory_order_relaxed);
            std::atomic_thread_fence(std::memory_order_acquire);
            if (gen_.load(std::memory_order_relaxed) == g) {
                return true;  // the writer did not move on to this copy while it was read
            }
        }
        return false;
    }

private:
    struct Copy {
        std::atomic<uint32_t> mode{0};
        std::atomic<uint32_t> lo{0};
        std::atomic<uint32_t> hi{0};
    };
    std::array<Copy, 2> copies_{};
    std::atomic<uint32_t> gen_{0};  // the copy in use: gen_ & 1
};

/**
 * init remembers the sink and makes a periodic esp_timer (kPollUs, esp_timer task) that posts poll() to the core task.
 * capture() stores the request and polls at once. poll() reads the station (esp_netif_get_ip_info on WIFI_STA_DEF,
 * esp_wifi_sta_get_ap_info) and, once it has an IP, applies the request, again whenever the request, the gateway, the
 * AP's BSSID or its channel changed (a reconnect): the sender filter, esp_wifi_set_csi_config (MAC v3, the C5:
 * wifi_csi_acquire_config_t with acquire_csi_legacy and lltf_bit_mode 8-bit always, force_lltf for format lltf, the
 * HT/VHT bits for auto and ht, the HE SU/MU/DCM/beamformed bits for auto and he, he_stbc_mode 2, val_scale_cfg 0;
 * MAC v2, the C6: its HE struct likewise; the C3/S3: wifi_csi_config_t with lltf_en, htltf_en and stbc_htltf2_en for
 * auto and ht, channel_filter_en off), esp_wifi_set_csi_rx_cb, esp_wifi_set_csi(true), and for mode router an esp_ping
 * session to the default gateway (count infinite, timeout the interval: a lost reply never stalls the rate). esp_ping
 * paces in whole FreeRTOS ticks (vTaskDelayUntil of pdMS_TO_TICKS(interval_ms)), so the interval is ping_ticks()
 * ticks, the whole number nearest to the tick rate / rate_hz (at least one): the C5's 100 Hz tick pings at 100, 50,
 * 33, 25, 20 ... Hz, never 150. The rate it pings at is ping_hz() and the "CSI on" log line (records per second
 * still show as fr.csi's `rate`). Without an IP it turns CSI and the pings off until one comes.
 *
 * The callback (Wi-Fi task) drops records without rx_channel_estimate_info_vld (HE chips), without data or with more
 * than hal::kCsiDataMax bytes (counted, oversized()), and for router and peer every sender but the filter's (the AP's
 * BSSID, the peer); it fills hal::CsiRecord (bb_format the C5's cur_bb_format, the older chips' sig_mode and rate
 * mapped; kCsiFlagMatched for the filter's sender, kCsiFlagGroup, kCsiFlagFirstWordInvalid) and calls the sink. The
 * filter is a CsiFilter (two copies): the callback never waits for the core task, which it preempts on one core.
 * stop() deletes the ping session and turns CSI off.
 */
class WifiCsi final : public hal::CsiSource
{
public:
    // driver.yaml `config: {}`: nothing to configure; the generated fr_board fills an empty Config.
    struct Config {};

    /** How often the core task looks at the station (and re-applies after a reconnect). */
    static constexpr uint32_t kPollUs = 500'000;

    /** The router pings' interval in ticks of a `tick_hz` FreeRTOS tick: the whole number nearest tick_hz / rate_hz,
     * at least one. */
    static constexpr uint32_t ping_ticks(uint32_t rate_hz, uint32_t tick_hz)
    {
        const uint32_t t = rate_hz == 0 ? 1 : (tick_hz + rate_hz / 2) / rate_hz;
        return t == 0 ? 1 : t;
    }

    // Only stores the configuration: the radio is touched once capture() runs (spec 03 §3.4).
    explicit WifiCsi(const Config &cfg) : cfg_(cfg) {}

    Status init(Core &core, hal::CsiSink &sink) override;
    Status capture(const hal::CsiCapture &c) override;
    Status stop() override;
    uint32_t pings_sent() const override { return pings_sent_.load(std::memory_order_relaxed); }
    uint32_t pings_lost() const override { return pings_lost_.load(std::memory_order_relaxed); }
    hal::Selftest selftest() override;

    /** Records the callback handed the sink, and those it dropped (invalid, another sender, the filter not read
     * whole), since boot; and of the dropped ones those above hal::kCsiDataMax. */
    uint32_t kept() const { return kept_.load(std::memory_order_relaxed); }
    uint32_t skipped() const { return skipped_.load(std::memory_order_relaxed); }
    uint32_t oversized() const { return oversized_.load(std::memory_order_relaxed); }
    /** The rate the router pings go at now (0: no ping session). Core task. */
    uint32_t ping_hz() const { return ping_hz_; }
    /** CSI is on (applied with an IP). Core task. */
    bool applied() const { return applied_; }

    // Callbacks (C linkage targets): public so the free functions in the .cpp reach them.
    void on_rx(const void *info);
    void on_ping(bool replied);
    void on_poll_timer();

private:
    void poll();
    bool apply(uint32_t gw, const uint8_t (&bssid)[6], uint8_t channel);
    void teardown();
    void stop_pings();
    void set_filter(hal::CsiMode mode, const uint8_t *mac);

    [[maybe_unused]] Config cfg_;
    Core *core_ = nullptr;
    hal::CsiSink *sink_ = nullptr;
    void *timer_ = nullptr;  // esp_timer_handle_t
    void *ping_ = nullptr;   // esp_ping_handle_t
    std::atomic<bool> poll_posted_{false};

    // ---- core task ----
    hal::CsiCapture want_{};
    bool has_want_ = false;
    bool applied_ = false;
    bool cb_registered_ = false;
    hal::CsiCapture applied_cap_{};
    uint32_t applied_gw_ = 0;
    std::array<uint8_t, 6> applied_bssid_{};
    uint8_t applied_channel_ = 0;
    uint32_t ping_hz_ = 0;

    // ---- the filter: core task writes, Wi-Fi task reads ----
    CsiFilter filter_;

    std::atomic<uint32_t> pings_sent_{0};
    std::atomic<uint32_t> pings_lost_{0};
    std::atomic<uint32_t> kept_{0};
    std::atomic<uint32_t> skipped_{0};
    std::atomic<uint32_t> oversized_{0};
};

}  // namespace fr::drv
