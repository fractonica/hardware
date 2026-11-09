// ds3231_i2c (design lcd-clock-c1 D7, D8; spec 07 §7.8): hal::Rtc on a DS3231 at I2C 0x68.
#pragma once

#include <array>
#include <cstdint>

#include "fr/core/core.hpp"
#include "fr/hal/rtc.hpp"

struct i2c_master_dev_t;

namespace fr::drv {

/**
 * init: the device on fr_core's shared I2C bus (fr::platform::i2c_device), then the control register: oscillator on
 * battery (EOSC clear), square wave and alarms off (INTCN set, A1IE/A2IE clear), so the coin cell feeds the oscillator
 * only. The status register's EN32kHz is cleared (the 32 kHz pin is not used). OSF is left as found: the service reads it.
 *
 * Stray writes (design lcd-clock-c1 D8, as built): a transaction broken off right after its register-pointer byte leaves
 * the chip waiting for data, and the master's bus-recovery clocks are then stored at that pointer. So every read starts
 * at a read-only register: now() is one 19-byte burst from 0x11 (temperature MSB), the pointer wrapping at 0x12 to 0x00
 * (0x11, 0x12, 0x00-0x10: time, alarms, control, status, aging); seconds() is a 2-byte read from 0x12 (0x12, 0x00). init
 * checks the wrap once against a direct read; a chip that does not wrap gets the fallback (pointer write, STOP, read),
 * logged. Only set() (0x00 + 7), set_aging() (0x10) and init's control/status fixes point at writable registers.
 * now() refuses registers that are not a valid time, and checks the control register against what init wrote.
 * Each transaction times out after 50 ms.
 */
class Ds3231I2c final : public hal::Rtc
{
public:
    struct Config {
        uint8_t sda = 0;
        uint8_t scl = 0;
        uint16_t khz = 100;
    };

    explicit Ds3231I2c(const Config &cfg) : cfg_(cfg) {}

    Status init(Core &core) override;
    std::expected<hal::RtcTime, Err> now() override;
    std::expected<uint8_t, Err> seconds() override;
    Status set(uint32_t unix) override;
    std::expected<int16_t, Err> temp_c10() override;
    std::expected<int8_t, Err> aging() override;
    Status set_aging(int8_t offset) override;
    void set_system_time(uint32_t unix) override;
    hal::Selftest selftest() override;
    uint32_t bus_errors() const override { return errors_; }
    void note(const char *what) override;

private:
    using Burst = std::array<uint8_t, 19>;  // 0x11, 0x12, 0x00-0x10
    Status burst(Burst &b);
    Status read_regs(uint8_t reg, uint8_t *out, size_t n);
    Status write_regs(uint8_t reg, const uint8_t *data, size_t n);

    Config cfg_;
    i2c_master_dev_t *dev_ = nullptr;
    uint32_t errors_ = 0;
    uint32_t invalid_ = 0;
    bool wrap_ok_ = true;
    uint8_t last_bad_control_ = 0xFF;
    char detail_[64] = {};
};

}  // namespace fr::drv
