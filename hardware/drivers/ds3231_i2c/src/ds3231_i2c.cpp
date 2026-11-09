#include "fr/drv/ds3231_i2c.hpp"

#include <array>
#include <cinttypes>
#include <cstdio>
#include <cstring>
#include <sys/time.h>

#include "driver/i2c_master.h"
#include "esp_log.h"
#include "fr/platform/i2c_bus.hpp"
#include "fr/rtc/ds3231_regs.hpp"

namespace fr::drv {
namespace {

constexpr const char *TAG = "ds3231";
// A 19-byte burst at 100 kHz is about 2 ms; 50 ms leaves room for the core task being preempted without the driver
// abandoning a transaction it has started (an abandoned one is what lets bus recovery clocks write stray data).
constexpr int kTimeoutMs = 50;
namespace regs = fr::rtc::ds3231;

// Control: EOSC 0 (run on battery), BBSQW 0, CONV 0, RS 00, INTCN 1, A2IE 0, A1IE 0.
constexpr uint8_t kControl = 0x04;

}  // namespace

Status Ds3231I2c::init(Core &core)
{
    (void)core;
    const auto dev = platform::i2c_device(cfg_.sda, cfg_.scl, regs::kAddress, cfg_.khz);
    if (!dev) {
        std::snprintf(detail_, sizeof(detail_), "no I2C bus on SDA %u / SCL %u", cfg_.sda, cfg_.scl);
        return std::unexpected(dev.error());
    }
    dev_ = *dev;
    Burst b{};
    if (!read_regs(regs::kRegTempMsb, b.data(), b.size())) {
        std::snprintf(detail_, sizeof(detail_), "no answer at 0x%02X", regs::kAddress);
        ESP_LOGW(TAG, "no answer at 0x%02X on SDA %u / SCL %u", regs::kAddress, cfg_.sda, cfg_.scl);
        return {};  // the service reports read errors; init stays OK so a missing module never stops the node
    }
    // The pointer wraps from 0x12 to 0x00 (the burst's time bytes) or the burst holds 0x13.. garbage: compare with one
    // direct read of the seconds and minutes (the only read that ever points at 0x00, once at boot).
    uint8_t direct[2] = {};
    if (read_regs(regs::kRegSeconds, direct, 2)) {
        const bool same_min = (direct[1] & 0x7F) == (b[3] & 0x7F);
        const auto s0 = regs::from_bcd(b[2] & 0x7F);
        const auto s1 = regs::from_bcd(direct[0] & 0x7F);
        wrap_ok_ = same_min && s0 && s1 && (*s1 == *s0 || *s1 == (*s0 + 1) % 60);
    }
    ESP_LOGI(TAG, "pointer wraps 0x12->0x00: %s", wrap_ok_ ? "yes" : "NO (fallback: pointer write, STOP, read)");
    if (b[16] != kControl) {
        (void)write_regs(regs::kRegControl, &kControl, 1);
    }
    const uint8_t status = b[17];
    const uint8_t cleared = static_cast<uint8_t>(status & ~0x08 & ~0x03);  // EN32kHz off, alarm flags cleared
    if (cleared != status) {
        (void)write_regs(regs::kRegStatus, &cleared, 1);
    }
    ESP_LOGI(TAG, "DS3231 at 0x%02X, OSF %d, %u kHz", regs::kAddress, (status & regs::kStatusOsf) != 0, cfg_.khz);
    std::snprintf(detail_, sizeof(detail_), "ok");
    return {};
}

Status Ds3231I2c::burst(Burst &b)
{
    if (wrap_ok_) {
        return read_regs(regs::kRegTempMsb, b.data(), b.size());
    }
    // Fallback (a chip whose pointer does not wrap): the pointer at 0x00 in a transaction of its own, a STOP, then the
    // read. A transaction broken off after the pointer write can still store stray data in the seconds register, but the
    // read itself no longer rides on a repeated START. b[0..1] (temperature) are read separately.
    if (dev_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    uint8_t t[2] = {};
    if (auto st = read_regs(regs::kRegTempMsb, t, 2); !st) {
        return st;
    }
    b[0] = t[0];
    b[1] = t[1];
    const uint8_t reg = regs::kRegSeconds;
    if (i2c_master_transmit(dev_, &reg, 1, kTimeoutMs) != ESP_OK ||
        i2c_master_receive(dev_, b.data() + 2, b.size() - 2, kTimeoutMs) != ESP_OK) {
        ++errors_;
        return std::unexpected(Err::failed);
    }
    return {};
}

Status Ds3231I2c::read_regs(uint8_t reg, uint8_t *out, size_t n)
{
    if (dev_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    if (i2c_master_transmit_receive(dev_, &reg, 1, out, n, kTimeoutMs) != ESP_OK) {
        ++errors_;
        return std::unexpected(Err::failed);
    }
    return {};
}

Status Ds3231I2c::write_regs(uint8_t reg, const uint8_t *data, size_t n)
{
    if (dev_ == nullptr || n > 8) {
        return std::unexpected(Err::failed);
    }
    uint8_t buf[9];
    buf[0] = reg;
    std::memcpy(buf + 1, data, n);
    if (i2c_master_transmit(dev_, buf, n + 1, kTimeoutMs) != ESP_OK) {
        ++errors_;
        return std::unexpected(Err::failed);
    }
    return {};
}

std::expected<hal::RtcTime, Err> Ds3231I2c::now()
{
    // One burst from 0x11 (read-only temperature), wrapping at 0x12 to 0x00: 0x11, 0x12, 0x00-0x10.
    Burst b{};
    if (auto st = burst(b); !st) {
        return std::unexpected(st.error());
    }
    std::array<uint8_t, 7> r{};
    std::memcpy(r.data(), b.data() + 2, r.size());
    const auto unix = regs::decode_time(r);
    if (!unix) {
        ++invalid_;
        ESP_LOGW(TAG, "invalid time registers %02X %02X %02X %02X %02X %02X %02X (read discarded)", r[0], r[1], r[2], r[3],
                 r[4], r[5], r[6]);
        return std::unexpected(Err::failed);
    }
    const bool control_ok = b[16] == kControl;
    if (!control_ok && b[16] != last_bad_control_) {
        ESP_LOGW(TAG, "control register reads 0x%02X, expected 0x%02X (a stray write?)", b[16], kControl);
    }
    last_bad_control_ = control_ok ? 0xFF : b[16];
    return hal::RtcTime{.unix = *unix,
                        .osf = (b[17] & regs::kStatusOsf) != 0,
                        .temp_c10 = regs::temp_c10(b[0], b[1]),
                        .aging = static_cast<int8_t>(b[18]),
                        .control_ok = control_ok};
}

std::expected<uint8_t, Err> Ds3231I2c::seconds()
{
    // The pointer at 0x12 (read-only), wrapping to the seconds: a broken-off transaction leaves nothing writable behind.
    uint8_t b[2] = {};
    if (wrap_ok_) {
        if (auto st = read_regs(regs::kRegTempLsb, b, 2); !st) {
            return std::unexpected(st.error());
        }
    } else {
        Burst full{};
        if (auto st = burst(full); !st) {
            return std::unexpected(st.error());
        }
        b[1] = full[2];
    }
    const auto v = regs::from_bcd(b[1] & 0x7F);
    if (!v || *v > 59) {
        ++invalid_;
        return std::unexpected(Err::failed);
    }
    return *v;
}

Status Ds3231I2c::set(uint32_t unix)
{
    const auto r = regs::encode_time(unix);
    if (auto st = write_regs(regs::kRegSeconds, r.data(), r.size()); !st) {
        ESP_LOGW(TAG, "time write failed");
        return st;
    }
    uint8_t status = 0;
    if (auto st = read_regs(regs::kRegStatus, &status, 1); !st) {
        return st;
    }
    const uint8_t cleared = static_cast<uint8_t>(status & ~regs::kStatusOsf);
    return write_regs(regs::kRegStatus, &cleared, 1);
}

std::expected<int16_t, Err> Ds3231I2c::temp_c10()
{
    uint8_t t[2] = {};
    if (auto st = read_regs(regs::kRegTempMsb, t, 2); !st) {
        return std::unexpected(st.error());
    }
    return regs::temp_c10(t[0], t[1]);
}

std::expected<int8_t, Err> Ds3231I2c::aging()
{
    Burst b{};
    if (auto st = burst(b); !st) {
        return std::unexpected(st.error());
    }
    return static_cast<int8_t>(b[18]);
}

Status Ds3231I2c::set_aging(int8_t offset)
{
    const uint8_t a = static_cast<uint8_t>(offset);
    return write_regs(regs::kRegAging, &a, 1);
}

void Ds3231I2c::set_system_time(uint32_t unix)
{
    timeval tv{};
    tv.tv_sec = static_cast<time_t>(unix);
    settimeofday(&tv, nullptr);
}

void Ds3231I2c::note(const char *what)
{
    ESP_LOGW(TAG, "%s", what);
}

hal::Selftest Ds3231I2c::selftest()
{
    uint8_t t[2] = {};
    if (!read_regs(regs::kRegTempMsb, t, 2)) {
        return {false, "DS3231 does not answer at 0x68"};
    }
    return {true, wrap_ok_ ? "DS3231 answers" : "DS3231 answers (no pointer wrap: fallback reads)"};
}

}  // namespace fr::drv
