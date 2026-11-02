// Download-mode restart needs the chip's force-download bit, which no public IDF API sets; it lives
// here, outside fr_core, whose boundary rules forbid soc/* (spec 03 §3.2).
#include "fr/diag.hpp"

#include "download_boot.hpp"
#include "esp_system.h"
#include "sdkconfig.h"

#if CONFIG_IDF_TARGET_ESP32C3 || CONFIG_IDF_TARGET_ESP32S3
#include "soc/rtc_cntl_reg.h"
#elif CONFIG_IDF_TARGET_ESP32C6 || CONFIG_IDF_TARGET_ESP32C5
#include "soc/lp_aon_reg.h"
#endif

#if CONFIG_IDF_TARGET_ESP32C5
// Design csi-c1 D2: the C5's field is two bits at [30:29]; 01 is boot0 (UART/USB). Never the C6's BIT(30) here.
static_assert(LP_AON_FORCE_DOWNLOAD_BOOT_S == fr::diag::detail::kC5ForceDownloadShift &&
              LP_AON_FORCE_DOWNLOAD_BOOT_V == fr::diag::detail::kC5ForceDownloadMask);
#endif

namespace fr::diag {

void restart(bool bootloader)
{
    if (bootloader) {
        // The ROM checks this bit on the next reset and stays in USB-Serial/JTAG download mode, the same
        // way the ROM USB console's "reboot to bootloader" does it.
#if CONFIG_IDF_TARGET_ESP32C3 || CONFIG_IDF_TARGET_ESP32S3
        REG_WRITE(RTC_CNTL_OPTION1_REG, RTC_CNTL_FORCE_DOWNLOAD_BOOT);
#elif CONFIG_IDF_TARGET_ESP32C6
        REG_SET_BIT(LP_AON_SYS_CFG_REG, LP_AON_FORCE_DOWNLOAD_BOOT);
#elif CONFIG_IDF_TARGET_ESP32C5
        REG_SET_FIELD(LP_AON_SYS_CFG_REG, LP_AON_FORCE_DOWNLOAD_BOOT, detail::kC5ForceDownloadBoot0);
#endif
    }
    esp_restart();
}

}  // namespace fr::diag
