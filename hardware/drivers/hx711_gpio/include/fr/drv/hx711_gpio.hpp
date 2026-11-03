// hx711_gpio (design scale-round-c1 D8; spec 07 §7.8): hal::LoadCell on an HX711 by two GPIOs. DOUT going low means a
// conversion is ready: its falling edge interrupt wakes the driver's task (fr_hx711, above fr_core and fr_net, below
// Wi-Fi), which clocks the 24 bits and the gain pulses out with interrupts masked (PD_SCK high for more than 60 µs powers
// the part down, which a preemption mid-train would do), pushes the conversion into a ring and calls the consumer's
// ready hook (ScaleService posts a wake-up to the core task, which drains the ring at once), then re-arms the
// interrupt. From DOUT falling to the hook: the ISR's wake-up, the ~60-80 µs train, nothing else (no sleep, no poll).
// The task also wakes every kWaitMs: a missed edge is read then, and the rate
// (conversions over the last whole second) falls to 0 when the part stops answering.
//
// Only the task drives PD_SCK: start() and stop() ask it (power up: PD_SCK low; power down: high). The first
// kSettleDrops conversions after a power-up or a gain change are dropped (the datasheet's settling: 4 conversions at
// either rate, plus the one still at the previous gain); they count for the rate.
#pragma once

#include <atomic>
#include <cstdint>

#include "fr/core/core.hpp"
#include "fr/drv/hx711_bits.hpp"
#include "fr/hal/load_cell.hpp"

namespace fr::drv {

class Hx711Gpio final : public hal::LoadCell
{
public:
    // Field order and defaults follow driver.yaml `config:`; the generated fr_board fills it from the instance's
    // `bind: { dout: gpio.<n>, sck: gpio.<n> }`.
    struct Config {
        uint8_t dout = 0;
        uint8_t sck = 0;
    };

    /**
     * Above fr_core (10) and fr_net (11), below lwIP (18), esp_timer (22) and Wi-Fi (23): the edge's wake-up preempts
     * the core task, which the conversion then goes to. Higher would only pass lwIP and esp_timer, which the core task
     * waits behind anyway (the end-to-end time would not change; the conversion's time is the ISR's either way).
     */
    static constexpr uint32_t kTaskPriority = 12;
    static constexpr uint32_t kStackBytes = 3072;
    /** The task's longest sleep: the missed-edge poll and the rate's clock. */
    static constexpr uint32_t kWaitMs = 100;
    /** Conversions dropped after a power-up or a gain change. */
    static constexpr uint8_t kSettleDrops = 5;
    /** 160 ms of conversions at the ~100/s a fast part makes (the core drains each one as it lands). */
    static constexpr size_t kRing = 16;
    /** No conversion this long after a power-up: logged once (wiring or power). */
    static constexpr uint32_t kDeadLogMs = 1000;

    // Only stores the configuration: hardware is touched in init() (spec 03 §3.4).
    explicit Hx711Gpio(const Config &cfg) : cfg_(cfg) {}

    /** PD_SCK high (powered down), DOUT an input with its edge interrupt, the task. Err::failed when IDF refuses. */
    Status init(Core &core) override;
    Status start(hal::LoadCellGain gain) override;
    Status stop() override;
    void set_on_ready(Callback<void(), 16> hook) override { on_ready_ = hook; }
    bool take(hal::LoadCellSample &out) override { return ring_.pop(out); }
    uint8_t rate_hz() const override { return rate_.load(std::memory_order_relaxed); }
    uint8_t resolution_bits() const override { return hx711::kDataBits; }
    uint8_t max_rate_hz() const override { return 80; }
    uint32_t overruns() const override { return ring_.dropped(); }
    hal::Selftest selftest() override;

private:
    static void task_main(void *arg);
    static void isr(void *arg);
    void loop();
    /** One train; `at` is when the conversion became ready. */
    void convert(TimeUs at);

    Config cfg_;
    Callback<void(), 16> on_ready_;  // set before init (the task reads it), then never changed
    void *task_ = nullptr;  // TaskHandle_t
    std::atomic<bool> want_on_{false};                  // start()/stop() -> the task
    std::atomic<uint8_t> want_gain_{0};                 // start() -> the task (hal::LoadCellGain)
    volatile TimeUs edge_at_ = 0;                       // the ISR -> the task, read after the notification
    std::atomic<uint8_t> rate_{0};
    std::atomic<uint32_t> conversions_{0};              // valid conversions since boot
    std::atomic<uint32_t> last_code_{0};
    std::atomic<uint32_t> last_ms_{0};                  // when the last valid conversion came (esp_timer ms)
    std::atomic<uint32_t> bad_trains_{0};               // trains after which DOUT stayed low
    hal::SampleRing<kRing> ring_;

    // the task's own
    TimeUs missed_at_ = 0;  // a conversion found ready just after re-arming (its edge fell while the ISR was off)
    bool on_ = false;
    uint8_t gain_ = 0;
    uint8_t drop_ = 0;
    TimeUs on_at_ = 0;
    uint32_t since_on_ = 0;
    bool logged_dead_ = false;
    bool logged_low_ = false;
    hx711::RateWindow window_;

    char detail_[112] = {};
};

}  // namespace fr::drv
