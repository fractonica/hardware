// The ESP32-C5's force-download field (design csi-c1 D2), IDF-free so that restart.cpp on target and the host suite
// check the same numbers. On the C5, LP_AON_SYS_CFG_REG's LP_AON_FORCE_DOWNLOAD_BOOT is two bits at [30:29]
// (soc/esp32c5/register/soc/lp_aon_reg.h: 00 no operation, 01 boot0 = UART/USB, 10 boot1 = UART/SDIO, 11 no
// operation), where the C6 has one bit at 30: the C6's BIT(30) written on a C5 would select boot1, the wrong mode.
// restart.cpp static_asserts these against the real header.
#pragma once

#include <cstdint>

namespace fr::diag::detail {

inline constexpr uint32_t kC5ForceDownloadShift = 29;   // LP_AON_FORCE_DOWNLOAD_BOOT_S
inline constexpr uint32_t kC5ForceDownloadMask = 0x3;   // LP_AON_FORCE_DOWNLOAD_BOOT_V
inline constexpr uint32_t kC5ForceDownloadBoot0 = 0x1;  // 01: download boot0, UART / USB-Serial/JTAG

/** What REG_SET_FIELD(reg, field, v) writes: `reg` with the field (shift, mask) replaced by `v`, the rest kept. */
constexpr uint32_t with_field(uint32_t reg, uint32_t shift, uint32_t mask, uint32_t v)
{
    return (reg & ~(mask << shift)) | ((v & mask) << shift);
}

}  // namespace fr::diag::detail
