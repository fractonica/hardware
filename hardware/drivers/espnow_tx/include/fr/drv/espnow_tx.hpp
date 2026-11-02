// espnow_tx (design csi-c1 D9; spec 07 §7.8): hal::RadioTx on the chip's own Wi-Fi radio. RadioTxService calls start()
// and stop() from the core task (fr/hal/radio_tx.hpp); the frames go out on the driver's own pacing.
#pragma once

#include <array>
#include <atomic>
#include <cstdint>

#include "fr/core/core.hpp"
#include "fr/hal/radio_tx.hpp"

namespace fr::drv {

/**
 * Sends through fr_net's ESP-NOW scheduler (fr::net::esp::air_send_plain: one send in flight beside the hub link's
 * frames, BULK, the band's robust rate, 11b 1 Mbps or on 5 GHz 11a 6 Mbps, no link retry), never esp_now_send itself.
 * start() needs ESP-NOW up on a known channel C (Err::busy otherwise), arms a periodic esp_timer at 1 / rate_hz
 * (esp_timer task), whose ticks post one send each to the core task: `len` bytes, a u32 LE sequence number from 0,
 * then zeros. A tick that finds the previous frame still in flight skips its frame (counted failed, the sequence
 * number goes on), so the rate never queues up behind a slow channel; a frame the peer did not acknowledge counts
 * failed. A tick that finds ESP-NOW down (the station lost its channel) stops the run (running() false). stop()
 * stops the timer; a frame in flight still ends (its peer entry stays in the scheduler's LRU, as any peer's).
 */
class EspnowTx final : public hal::RadioTx
{
public:
    // driver.yaml `config: {}`: nothing to configure; the generated fr_board fills an empty Config.
    struct Config {};

    static constexpr uint16_t kMaxLen = 250;  // ESP-NOW v1

    // Only stores the configuration: the radio is touched once start() runs (spec 03 §3.4).
    explicit EspnowTx(const Config &cfg) : cfg_(cfg) {}

    Status init(Core &core) override;
    Status start(const std::array<uint8_t, 6> &peer, uint16_t rate_hz, uint16_t len) override;
    Status stop() override;
    bool running() const override { return running_; }
    uint32_t sent() const override { return sent_; }
    uint32_t failed() const override { return failed_; }
    hal::Selftest selftest() override;

    /** Frames the peer acknowledged since boot. Core task. */
    uint32_t acked() const { return acked_; }

    // Callbacks (the .cpp's free functions reach them).
    void on_tick_timer();
    void on_done(uint32_t token, bool ok);

private:
    void tick();

    [[maybe_unused]] Config cfg_;
    Core *core_ = nullptr;
    void *timer_ = nullptr;  // esp_timer_handle_t
    std::atomic<bool> tick_posted_{false};

    // ---- core task ----
    bool running_ = false;
    std::array<uint8_t, 6> peer_{};
    uint16_t len_ = 0;
    uint32_t seq_ = 0;
    uint32_t run_ = 0;           // the run's number: a late end of an earlier run's frame is not this run's
    bool in_flight_ = false;
    uint32_t in_flight_token_ = 0;
    uint32_t sent_ = 0;
    uint32_t failed_ = 0;
    uint32_t acked_ = 0;
    uint8_t frame_[kMaxLen] = {};
};

}  // namespace fr::drv
