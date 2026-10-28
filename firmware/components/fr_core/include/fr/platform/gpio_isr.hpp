// The firmware's one per-pin GPIO ISR service: every GPIO driver that takes an edge interrupt (button_gpio,
// fixture_gpio, cst816_i2c) installs it through here. IDF's gpio_install_isr_service answers a repeat call with
// ESP_ERR_INVALID_STATE but also logs it as an error ("E gpio: gpio_install_isr_service(568): GPIO isr service already
// installed"), which a board with two such drivers (pad-s3t: the BOOT button and the touch INT) printed at every boot.
// ESP-IDF only (src/gpio_isr.cpp; the host suite builds it against its shim). For the app task during board init.
#pragma once

#include <expected>

#include "fr/base.hpp"

namespace fr::platform {

/**
 * Installs the service once per boot with the first caller's `intr_alloc_flags` (ESP_INTR_FLAG_*); later calls change
 * nothing and answer the flags it was installed with, so a driver that needs ESP_INTR_FLAG_IRAM can tell whether it
 * got it. A service installed outside this function (ESP_ERR_INVALID_STATE on the first call) is taken as installed,
 * with flags 0 (not known to be IRAM). Err::failed when IDF refused (logged).
 */
std::expected<int, Err> gpio_isr_service(int intr_alloc_flags);

#if FR_HOST_SHIM
/** The host suite: forgets the installation, as esp_sim::reset() forgets the service (a fresh boot). */
void gpio_isr_service_host_reset();
#endif

}  // namespace fr::platform
