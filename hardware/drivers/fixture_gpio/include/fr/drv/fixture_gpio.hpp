// fixture_gpio (design m2-c1-hil D4, D11; spec 07 §7.8): hal::FixtureLine on one GPIO of the HIL fixture. Presses
// run from ISR-dispatched esp_timers that write the pin through gpio_ll, with a second timer releasing the
// line at min(total, cap) + 5 ms; an IRAM any-edge ISR (decode level and open_drain lines) stamps each edge
// into one edge ring. Every reset path lets go of the lines first (D11 item 1): esp_restart through a shutdown
// handler, a panic through a wrap of esp_panic_handler, and the boot after a CPU reset (which keeps the S3's
// GPIO block) through an early init function. src/fixture_gpio.cpp implements it; the host suite builds that
// same file over an IDF shim (firmware/test/host/shim) and runs FixtureService on it
// (firmware/test/host/tests/fixture_gpio_sim_test.cpp).
//
// M2-C3 (design m2-c3-inputs §3): a pwm line is an LEDC output (low-speed mode, 20 kHz, 11-bit, one LEDC timer shared
// by every pwm line, a channel each) into the RC of a DUT's analog input. It has no edge interrupt and no press; its
// duty is 0 at init, on release and on every reset path, where the pin goes back to a plain GPIO output driven low.
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <expected>
#include <span>

#include "fr/core/core.hpp"
#include "fr/hal/fixture.hpp"

struct esp_timer;  // esp_timer_handle_t, without esp_timer.h in a public header

namespace fr::drv {

class FixtureGpio final : public hal::FixtureLine
{
public:
    // Field order and defaults follow driver.yaml `config:`; the generated fr_board fills it from the
    // instance's `bind: gpio.<n>`.
    struct Config {
        uint8_t gpio = 0;
    };

    /** fixture_gpio lines one node runs: every board instance (fr::core::kMaxInstances) could be one. */
    static constexpr size_t kMaxLines = 16;
    /** Segments one press runs (fr.fixture press `segments_us` max). */
    static constexpr size_t kMaxSegments = 16;
    /** The cap release comes this long after the press should have ended, whatever the segment timer did. */
    static constexpr uint32_t kGuardUs = 5'000;
    /** How long press() waits for the ISR to capture its own press edge on an open_drain line. */
    static constexpr uint32_t kReadbackUs = 100;
    /** pwm lines (design m2-c3-inputs §3): the LEDC timer's frequency and duty resolution, and the lines one node
     * runs (the S3's low-speed LEDC channels). */
    static constexpr uint32_t kPwmHz = 20'000;
    static constexpr uint8_t kPwmBits = 11;
    static constexpr size_t kMaxPwmLines = 8;

    /** set_duty's 1/10,000 of full scale in LEDC steps, rounded: 0..2,048, where 2,048 (2^11, the top LEDC takes)
     * holds the output high all period, so 10,000 is fully on rather than one step short of it. */
    static constexpr uint32_t pwm_steps(uint16_t duty)
    {
        return (uint32_t{duty} * (1u << kPwmBits) + hal::kFixtureDutyMax / 2) / hal::kFixtureDutyMax;
    }

    /**
     * A press as the segment timer runs it. Boundary i ends segment i, `ends[i]` after the first press edge;
     * segments alternate press, release, press, ... and are cut at the cap, so the last boundary is at
     * min(sum, cap) = total_us. After boundary i the line is pressed when i is odd and another segment
     * follows; the last boundary always releases it and ends the press (a trailing release segment only
     * keeps the press running, so it answers BUSY until then).
     */
    struct Plan {
        std::array<uint32_t, kMaxSegments> ends{};
        uint8_t n = 0;  // boundaries; segments after the cap are dropped
        uint32_t total_us = 0;

        /** Line state after boundary `i`. */
        constexpr bool pressed_after(size_t i) const { return i % 2 == 1 && i + 1 < n; }
        /** When the cap release fires, from the first press edge. */
        constexpr uint32_t guard_us() const { return total_us + kGuardUs; }

        /** invalid_args for no segments, more than kMaxSegments, a zero-length segment or a zero cap. */
        static constexpr std::expected<Plan, Err> make(std::span<const uint32_t> segments_us, uint32_t cap_us)
        {
            if (segments_us.empty() || segments_us.size() > kMaxSegments || cap_us == 0) {
                return std::unexpected(Err::invalid_args);
            }
            Plan p;
            uint64_t at = 0;
            for (uint32_t s : segments_us) {
                if (s == 0) {
                    return std::unexpected(Err::invalid_args);
                }
                at += s;
                const bool cut = at >= cap_us;
                p.ends[p.n++] = cut ? cap_us : static_cast<uint32_t>(at);
                if (cut) {
                    break;
                }
            }
            p.total_us = p.ends[p.n - 1];
            return p;
        }
    };

    /** The pin level that presses (or releases) a line: open_drain pulls low, nfet_gate drives its gate high. */
    static constexpr bool pin_level(hal::FixtureDrive drive, bool pressed)
    {
        return drive == hal::FixtureDrive::nfet_gate ? pressed : !pressed;
    }

    /**
     * Whether a line takes the any-edge interrupt: decode level lines that read their pin (input taps, and
     * open_drain lines reading back their own presses). An nfet_gate line reports its write stamps instead,
     * decode ws2812 is fixture_ws2812_rx's (RMT RX: its ~800 kHz bit edges would flood the ISR), and a pwm line's
     * 20 kHz output has no edges worth capturing (design m2-c3-inputs §3).
     */
    static constexpr bool edge_irq(const hal::FixtureLineMode &mode)
    {
        return mode.decode == hal::FixtureDecode::level && mode.drive != hal::FixtureDrive::nfet_gate &&
               mode.drive != hal::FixtureDrive::pwm;
    }

    // Stores the configuration and notes the pin for release_at_boot(): hardware is touched in init() (spec 03 §3.4).
    explicit FixtureGpio(const Config &cfg);

    Status init(Core &core, const hal::FixtureLineMode &mode, hal::EdgeSink &sink) override;
    std::expected<hal::FixturePress, Err> press(std::span<const uint32_t> segments_us, uint32_t cap_us) override;
    Status release() override;
    bool pressing() const override;
    bool level() const override;
    /** A pwm line's LEDC duty (pwm_steps), updated at once; the stamp is taken when ledc_update_duty returned. The
     * output takes it at the start of its next 50 µs period. */
    std::expected<uint32_t, Err> set_duty(uint16_t duty) override;
    void drain() override;
    hal::Selftest selftest() override;

    // ---- the reset paths (design m2-c1-hil D11 item 1) ----
    // On the S3 a software restart and a panic's restart are CPU resets, which keep the GPIO block: a line pressed
    // then would stay driven through the panic output, the coredump, the bootloader and boot until init().

    /** Turns the output of every constructed line's pin off, whatever a CPU reset left it driving: GPIO_ENABLE
     * cleared, the output enable taken from GPIO_ENABLE (OEN_SEL set) and the pin routed to its output register
     * (SIG_GPIO_OUT_IDX). open_drain and nfet_gate lines then read released (the DUT's pull-up, the gate's
     * pull-down), and a pwm line is taken off the LEDC output, which a CPU reset keeps running and whose output
     * enable (OEN_SEL clear after ledc_channel_config) GPIO_ENABLE alone does not override: the pin floats, its RC
     * held at 0 V, until init() drives duty 0. An ESP_SYSTEM_INIT_FN runs it at boot, once the generated board's
     * constructors have noted the pins and before app_main. */
    static void release_at_boot();
    /** Stops every press and writes every driving line released, under the lock, and takes every pwm line off LEDC
     * to a GPIO output driven low (duty 0): the shutdown handler that esp_restart runs (reboot, OTA, rollback), which
     * init() registers. */
    static void release_for_restart();
    /** Writes every driving line released, pwm lines low through the GPIO matrix as release_for_restart, without the
     * lock (the other CPU is stalled, interrupts are off): the panic hook (__wrap_esp_panic_handler), before the
     * backtrace and the coredump. */
    static void release_for_panic();

private:
    static void isr(void *arg);         // any-edge capture (IRAM, on the ESP_INTR_FLAG_IRAM GPIO ISR service)
    static void on_segment(void *arg);  // segment boundaries (IRAM, ESP_TIMER_ISR)
    static void on_guard(void *arg);    // the cap release (IRAM, ESP_TIMER_ISR)
    /** Every line's edges and ring overflows to their sinks; the core task. */
    static void drain_all();

    // Under the driver's spinlock (src/fixture_gpio.cpp); `pushed` says an edge went into the ring.
    /** Writes the pin and returns the write stamp (esp_timer µs). */
    int64_t write_locked(bool pressed, bool &pushed);
    /** Stops both timers and releases the line. */
    void end_locked(bool &pushed);
    /** Runs every boundary that is due and arms the next one. */
    void step_locked(bool &pushed);
    /** The pin reads its idle level: open_drain high (nobody holds the DUT's BOOT), nfet_gate's gate low. */
    bool released_locked() const;
    /** pwm: the LEDC timer (once, for every pwm line) and this line's channel at duty 0. */
    Status init_pwm();
    /** pwm: sets and updates the channel's duty in LEDC steps; the core task. */
    bool apply_steps(uint32_t steps);
    /** pwm: the pin back on the GPIO output register, driven low (IRAM, no lock, no LEDC driver call). */
    void pwm_pin_low() const;

    Config cfg_;
    hal::FixtureLineMode mode_{};
    hal::EdgeSink *sink_ = nullptr;
    uint8_t ch_ = 0;  // index in the driver's line table and the edge ring's `ch`
    esp_timer *segment_ = nullptr;
    esp_timer *guard_ = nullptr;

    // The running press: written by press()/release() on the core task and by the timer ISRs, under the lock.
    Plan plan_{};
    int64_t t0_ = 0;         // the first press edge (esp_timer µs)
    int64_t due_ = 0;        // the next boundary
    int64_t guard_due_ = 0;  // the cap release
    uint8_t next_ = 0;       // the next boundary's index
    bool driven_ = false;    // the pin is driven to its press level
    volatile bool running_ = false;

    // The newest captured edge, for press()'s readback stamp (the ISR writes, press() polls).
    volatile uint32_t edge_seq_ = 0;
    volatile uint32_t edge_us_ = 0;
    volatile bool edge_level_ = false;
    volatile uint32_t isr_count_ = 0;
    // pwm (design m2-c3-inputs §3): the line's LEDC channel and its duty as last applied, on the core task.
    int8_t ledc_ch_ = -1;
    volatile uint16_t duty_ = 0;
    char detail_[112] = {};
};

}  // namespace fr::drv
