// The ESP32-C5's download-mode restart (design csi-c1 D2; fr_diag/src/download_boot.hpp): restart.cpp writes
// LP_AON_FORCE_DOWNLOAD_BOOT = 01 (boot0, UART/USB) with REG_SET_FIELD. Checked here against the C5's register
// constants and soc.h's REG_SET_FIELD, copied verbatim from IDF v6.1 (components/soc/esp32c5/register/soc/
// lp_aon_reg.h, components/soc/esp32c5/include/soc/soc.h) onto a fake register, beside the C6's one-bit field.
#include <cstdint>

#include "../../../components/fr_diag/src/download_boot.hpp"
#include "tests/test.hpp"

namespace {

// IDF v6.1 esp32c5 lp_aon_reg.h (the register's address replaced by the fake word).
#define LP_AON_FORCE_DOWNLOAD_BOOT    0x00000003U
#define LP_AON_FORCE_DOWNLOAD_BOOT_M  (LP_AON_FORCE_DOWNLOAD_BOOT_V << LP_AON_FORCE_DOWNLOAD_BOOT_S)
#define LP_AON_FORCE_DOWNLOAD_BOOT_V  0x00000003U
#define LP_AON_FORCE_DOWNLOAD_BOOT_S  29
#define LP_AON_FORCE_DOWNLOAD_BOOT_STATUS_V  0x00000003U
#define LP_AON_FORCE_DOWNLOAD_BOOT_STATUS_S  27
// IDF v6.1 esp32c6 lp_aon_reg.h: the C6's field, one bit.
#define C6_LP_AON_FORCE_DOWNLOAD_BOOT (1U << 30)

uint32_t g_sys_cfg = 0;
#define REG_READ(_r) (*(_r))
#define REG_WRITE(_r, _v) (*(_r) = (_v))
// IDF v6.1 esp32c5 soc.h.
#define REG_SET_FIELD(_r, _f, _v) do {                                                                                 \
            REG_WRITE((_r),((REG_READ(_r) & ~((_f##_V) << (_f##_S)))|(((_v) & (_f##_V))<<(_f##_S))));                  \
        } while(0)

using namespace fr::diag::detail;

TEST(diag_c5_download_boot_constants_match_the_register_header)
{
    CHECK_EQ(kC5ForceDownloadShift, LP_AON_FORCE_DOWNLOAD_BOOT_S);
    CHECK_EQ(kC5ForceDownloadMask, LP_AON_FORCE_DOWNLOAD_BOOT_V);
    CHECK_EQ(LP_AON_FORCE_DOWNLOAD_BOOT_M, 0x60000000u);  // bits [30:29]
    CHECK_EQ(kC5ForceDownloadBoot0, 1u);
}

TEST(diag_c5_download_boot_writes_boot0_and_keeps_the_rest)
{
    g_sys_cfg = 0;
    REG_SET_FIELD(&g_sys_cfg, LP_AON_FORCE_DOWNLOAD_BOOT, kC5ForceDownloadBoot0);
    CHECK_EQ(g_sys_cfg, 0x20000000u);  // 01 at [30:29]: boot0 (UART/USB)
    CHECK_EQ((g_sys_cfg >> LP_AON_FORCE_DOWNLOAD_BOOT_S) & LP_AON_FORCE_DOWNLOAD_BOOT_V, 1u);
    CHECK_EQ(with_field(0, kC5ForceDownloadShift, kC5ForceDownloadMask, kC5ForceDownloadBoot0), g_sys_cfg);

    // Other bits stay (the read-only status at [28:27] among them); a boot1 left behind (10) becomes 01.
    g_sys_cfg = 0x9FFFFFFFu | 0x40000000u;
    REG_SET_FIELD(&g_sys_cfg, LP_AON_FORCE_DOWNLOAD_BOOT, kC5ForceDownloadBoot0);
    CHECK_EQ(g_sys_cfg, 0xBFFFFFFFu);
    CHECK_EQ(with_field(0xDFFFFFFFu, kC5ForceDownloadShift, kC5ForceDownloadMask, kC5ForceDownloadBoot0), 0xBFFFFFFFu);
}

TEST(diag_c5_download_boot_the_c6_bit_would_select_boot1)
{
    // The C6 code's BIT(30) on a C5 reads as 10 in the two-bit field: boot1 (UART/SDIO), not USB.
    CHECK_EQ((C6_LP_AON_FORCE_DOWNLOAD_BOOT >> LP_AON_FORCE_DOWNLOAD_BOOT_S) & LP_AON_FORCE_DOWNLOAD_BOOT_V, 2u);
    CHECK((C6_LP_AON_FORCE_DOWNLOAD_BOOT & (1u << LP_AON_FORCE_DOWNLOAD_BOOT_S)) == 0);
}

}  // namespace
