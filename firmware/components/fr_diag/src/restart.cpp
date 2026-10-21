// Download-mode restart needs the chip's force-download bit, which no public IDF API sets; it lives
// here, outside fr_core, whose boundary rules forbid soc/* (spec 03 §3.2).
#include "fr/diag.hpp"

#include "esp_system.h"
#include "sdkconfig.h"

#if CONFIG_IDF_TARGET_ESP32C3 || CONFIG_IDF_TARGET_ESP32S3
#include "soc/rtc_cntl_reg.h"
#elif CONFIG_IDF_TARGET_ESP32C6
#include "soc/lp_aon_reg.h"
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
#endif
    }
    esp_restart();
}

}  // namespace fr::diag
