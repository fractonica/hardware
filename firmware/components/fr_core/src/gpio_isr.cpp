// The shared per-pin GPIO ISR service (fr/platform/gpio_isr.hpp).
#include "fr/platform/gpio_isr.hpp"

#include <mutex>

#include "driver/gpio.h"
#include "esp_err.h"
#include "esp_log.h"

namespace fr::platform {
namespace {

constexpr const char *TAG = "fr_gpio";

std::mutex s_mutex;
bool s_installed = false;
int s_flags = 0;

}  // namespace

std::expected<int, Err> gpio_isr_service(int intr_alloc_flags)
{
    std::lock_guard<std::mutex> lock(s_mutex);
    if (s_installed) {
        return s_flags;
    }
    const esp_err_t err = gpio_install_isr_service(intr_alloc_flags);
    if (err == ESP_OK) {
        s_flags = intr_alloc_flags;
    } else if (err == ESP_ERR_INVALID_STATE) {
        s_flags = 0;  // installed by code that does not come through here: its flags are unknown
    } else {
        ESP_LOGE(TAG, "gpio_install_isr_service: %s", esp_err_to_name(err));
        return std::unexpected(Err::failed);
    }
    s_installed = true;
    return s_flags;
}

#if FR_HOST_SHIM
void gpio_isr_service_host_reset()
{
    std::lock_guard<std::mutex> lock(s_mutex);
    s_installed = false;
    s_flags = 0;
}
#endif

}  // namespace fr::platform
