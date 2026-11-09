// The DS3231's register layout and conversions (design lcd-clock-c1 D7): BCD, the civil calendar against unix seconds, the
// temperature registers. Pure and header-only, so the host suite tests what the ds3231_i2c driver sends and reads.
//
// Registers 0x00-0x06: seconds, minutes, hours (bit 6: 12-hour mode, forced to 24-hour at set), day of week 1-7,
// date, month (bit 7: century), year 00-99, all BCD. 0x0E control, 0x0F status (bit 7 OSF), 0x10 aging offset (two's
// complement), 0x11-0x12 temperature (MSB two's complement degC, LSB bits 7:6 quarter degrees).
#pragma once

#include <array>
#include <cstdint>
#include <optional>

namespace fr::rtc::ds3231 {

inline constexpr uint8_t kAddress = 0x68;
inline constexpr uint8_t kRegSeconds = 0x00;
inline constexpr uint8_t kRegControl = 0x0E;
inline constexpr uint8_t kRegStatus = 0x0F;
inline constexpr uint8_t kRegAging = 0x10;
inline constexpr uint8_t kRegTempMsb = 0x11;
/** Read-only (temperature LSB) and the last register: the pointer wraps from here to 0x00, so a read that starts here
 * leaves a broken-off transaction's stray data on a register writes cannot change (design lcd-clock-c1 D8, as built). */
inline constexpr uint8_t kRegTempLsb = 0x12;
inline constexpr uint8_t kStatusOsf = 0x80;
/** 2000-01-01T00:00:00Z and the first second the chip cannot hold (it keeps 2000-2099). */
inline constexpr uint32_t kUnix2000 = 946'684'800;
inline constexpr uint32_t kUnix2100 = 4'102'444'800;

constexpr uint8_t to_bcd(uint8_t v)
{
    return static_cast<uint8_t>(((v / 10) << 4) | (v % 10));
}

/** nullopt for a nibble above 9 (a chip that does not answer reads 0xFF). */
constexpr std::optional<uint8_t> from_bcd(uint8_t b)
{
    if ((b & 0x0F) > 9 || (b >> 4) > 9) {
        return std::nullopt;
    }
    return static_cast<uint8_t>((b >> 4) * 10 + (b & 0x0F));
}

/** Days since 1970-01-01 for a proleptic Gregorian date (H. Hinnant's days_from_civil). */
constexpr int64_t days_from_civil(int64_t y, unsigned m, unsigned d)
{
    y -= m <= 2 ? 1 : 0;
    const int64_t era = (y >= 0 ? y : y - 399) / 400;
    const unsigned yoe = static_cast<unsigned>(y - era * 400);
    const unsigned doy = (153 * (m > 2 ? m - 3 : m + 9) + 2) / 5 + d - 1;
    const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return era * 146097 + static_cast<int64_t>(doe) - 719468;
}

struct Civil {
    int64_t year;
    unsigned month, day;
};

constexpr Civil civil_from_days(int64_t z)
{
    z += 719468;
    const int64_t era = (z >= 0 ? z : z - 146096) / 146097;
    const unsigned doe = static_cast<unsigned>(z - era * 146097);
    const unsigned yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    const int64_t y = static_cast<int64_t>(yoe) + era * 400;
    const unsigned doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    const unsigned mp = (5 * doy + 2) / 153;
    const unsigned d = doy - (153 * mp + 2) / 5 + 1;
    const unsigned m = mp < 10 ? mp + 3 : mp - 9;
    return {m <= 2 ? y + 1 : y, m, d};
}

/** Registers 0x00-0x06 for `unix` (clamped to 2000-2099): 24-hour mode, century bit 0, weekday 1 = Monday. */
constexpr std::array<uint8_t, 7> encode_time(uint32_t unix)
{
    if (unix < kUnix2000) {
        unix = kUnix2000;
    } else if (unix >= kUnix2100) {
        unix = kUnix2100 - 1;
    }
    const int64_t days = unix / 86400;
    const uint32_t secs = unix % 86400;
    const Civil c = civil_from_days(days);
    // 1970-01-01 was a Thursday (4 with Monday = 1).
    const unsigned wday = static_cast<unsigned>((days + 3) % 7) + 1;
    return {to_bcd(static_cast<uint8_t>(secs % 60)),
            to_bcd(static_cast<uint8_t>(secs / 60 % 60)),
            to_bcd(static_cast<uint8_t>(secs / 3600)),
            static_cast<uint8_t>(wday),
            to_bcd(static_cast<uint8_t>(c.day)),
            to_bcd(static_cast<uint8_t>(c.month)),
            to_bcd(static_cast<uint8_t>(c.year - 2000))};
}

/** Days in `month` (1-12) of `year` (Gregorian). */
constexpr unsigned days_in_month(int64_t year, unsigned month)
{
    constexpr unsigned kDays[12] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
    if (month < 1 || month > 12) {
        return 0;
    }
    const bool leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    return kDays[month - 1] + (month == 2 && leap ? 1 : 0);
}

/** Unix seconds from registers 0x00-0x06 (12-hour mode read too; the century bit taken as 20xx); nullopt when invalid. */
constexpr std::optional<uint32_t> decode_time(const std::array<uint8_t, 7> &r)
{
    const auto s = from_bcd(r[0] & 0x7F);
    const auto mi = from_bcd(r[1] & 0x7F);
    std::optional<uint8_t> h;
    if ((r[2] & 0x40) != 0) {  // 12-hour: bit 5 PM, bits 4:0 hour 1-12
        const auto h12 = from_bcd(r[2] & 0x1F);
        if (h12 && *h12 >= 1 && *h12 <= 12) {
            h = static_cast<uint8_t>(*h12 % 12 + ((r[2] & 0x20) != 0 ? 12 : 0));
        }
    } else {
        h = from_bcd(r[2] & 0x3F);
    }
    const auto d = from_bcd(r[4] & 0x3F);
    const auto mo = from_bcd(r[5] & 0x1F);
    const auto y = from_bcd(r[6]);
    if (!s || !mi || !h || !d || !mo || !y || *s > 59 || *mi > 59 || *h > 23 || *d < 1 || *d > 31 || *mo < 1 || *mo > 12 ||
        *d > days_in_month(2000 + *y, *mo) || r[3] < 1 || r[3] > 7) {
        return std::nullopt;
    }
    const int64_t days = days_from_civil(2000 + *y, *mo, *d);
    return static_cast<uint32_t>(days * 86400 + *h * 3600 + *mi * 60 + *s);
}

/** degC x 10 from the temperature registers (quarter degrees, rounded half away from zero). */
constexpr int16_t temp_c10(uint8_t msb, uint8_t lsb)
{
    const int q = static_cast<int8_t>(msb) * 4 + (lsb >> 6);  // quarter degrees
    const int t = q * 10;
    return static_cast<int16_t>(t >= 0 ? (t + 2) / 4 : (t - 2) / 4);
}

}  // namespace fr::rtc::ds3231
