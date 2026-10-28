// cst816_i2c (design m2-c5-display D4; spec 07 §7.8): hal::TouchSource on a CST816S/D/T capacitive touch controller
// over I2C; INT (falling edge) feeds a core input slot, the core task reads the touch.
#pragma once

#include <cstdint>

#include "fr/core/core.hpp"
#include "fr/hal/touch.hpp"

struct i2c_master_dev_t;

namespace fr::drv {

/**
 * The controller on the shared I2C bus of its pins (fr/platform/i2c_bus.hpp; the Touch-LCD-2's QMI8658 IMU joins the
 * same bus later), at cfg.address (0x15).
 *
 * init: the reset line if wired (low 10 ms, then 50 ms), the chip id read (0xA7: 0xB4 CST816S, 0xB5 CST816T, 0xB6
 * CST816D; *inferred* from the CST816S register map), auto-sleep off (0xFE = 1, so it keeps answering on I2C) and
 * interrupts on touch and change (0xFA = 0x60: periodic while touched, and on press/lift).
 *
 * Absent: a controller that does not answer does not fail init (the service, its `inject` included, works without it).
 * Two cases look the same on the bus: a CST816D asleep (it wakes on a touch) and a board without the touch panel (the
 * bench's pad-s3t, a non-touch Touch-LCD-2: no ACK at 0x15, no interrupt; board manifest). So the driver probes the
 * chip id again every kProbeEveryMs for the first kProbeForMs after init (one core timer, taken only then) and on
 * every interrupt until it answers, then does the setup above once. Until then poll() and the report read leave the
 * bus alone and selftest answers ok=false with "absent: no ACK at 0x15 (a board without the touch panel, or asleep:
 * touch the screen)" (it probes once more itself).
 *
 * INT on its GPIO, falling edge, pull-up on: the ISR only
 * writes the input slot; on the core task the slot's callback reads the 6 report bytes from 0x01 (gesture, fingers,
 * X high with the event in bits 7..6, X low, Y high, Y low) and reports pressed = fingers > 0 and event != lift, in the
 * controller's native coordinates (TouchService rotates them). The controller's gesture register is not used
 * (*inferred* unreliable outside its gesture mode): TouchService recognises gestures itself.
 */
class Cst816I2c final : public hal::TouchSource
{
public:
    // Field order and defaults follow driver.yaml `config:`; the generated fr_board fills it from the board
    // manifest's `touch.<name>` entry. An optional pin that is not wired is -1.
    struct Config {
        uint8_t sda = 0;
        uint8_t scl = 0;
        uint8_t irq = 0;
        int8_t rst = -1;
        uint8_t address = 0x15;
        uint16_t i2c_khz = 400;
    };

    /** One 6-byte report from register 0x01, decoded. */
    struct Report {
        uint16_t x, y;
        bool pressed;
    };
    static Report decode(const uint8_t (&b)[6]);

    // Only stores the configuration: hardware is touched in init() (spec 03 §3.4).
    explicit Cst816I2c(const Config &cfg) : cfg_(cfg) {}

    /** While absent: the chip id is probed this often, for this long after init (and on every interrupt). */
    static constexpr uint32_t kProbeEveryMs = 5000;
    static constexpr uint32_t kProbeForMs = 60000;

    Status init(Core &core, hal::TouchSink &sink) override;
    Status poll() override;
    hal::Selftest selftest() override;

    uint8_t chip_id() const { return chip_id_; }
    /** The controller has answered (its setup is done); false while absent or asleep since boot. */
    bool present() const { return present_; }

private:
    static void isr(void *arg);
    Status read(TimeUs at);
    /** Reads the chip id; the first answer does the setup and ends the probing. Core task (or init). */
    bool probe();
    void on_probe_timer();

    Config cfg_;
    i2c_master_dev_t *dev_ = nullptr;
    InputSlot *slot_ = nullptr;
    hal::TouchSink *sink_ = nullptr;
    Core *core_ = nullptr;
    Timer *probe_timer_ = nullptr;
    TimeUs probe_until_ = 0;
    bool present_ = false;
    uint8_t chip_id_ = 0;
    uint32_t read_errors_ = 0;
    volatile uint32_t isr_count_ = 0;
    char detail_[112] = {};
};

}  // namespace fr::drv
