// fr:realtime
// The T-LAT test pin (design c6 D24): open-drain pulses for diag `pin_pulse`, released by a one-shot timer.
#include "test_pin.hpp"

#include <atomic>

#include "driver/gpio.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "sdkconfig.h"

namespace fr::core::test_pin {
namespace {

constexpr const char *TAG = "fr";

// `fr gen firmware` writes it from the board manifest; an sdkconfig from before C6 has none.
#if defined(CONFIG_FR_TEST_PIN)
constexpr int kPin = CONFIG_FR_TEST_PIN;
#else
constexpr int kPin = -1;
#endif

#if FR_TEST_HOOKS
esp_timer_handle_t s_release = nullptr;
// Set on the core task by pulse(), cleared by the release timer (esp_timer task).
std::atomic<bool> s_low{false};

void release(void *)
{
    gpio_set_level(static_cast<gpio_num_t>(kPin), 1);  // open-drain: 1 lets go, the other board's pull-up wins
    s_low.store(false, std::memory_order_release);
}
#endif

}  // namespace

void init()
{
#if FR_TEST_HOOKS
    if (kPin < 0) {
        return;
    }
    const auto pin = static_cast<gpio_num_t>(kPin);
    // Released before it becomes an output, so it never drives low at boot: the board it is wired to may be
    // resetting right now, and its strapping pin must read high.
    gpio_set_level(pin, 1);
    gpio_config_t c{};
    c.pin_bit_mask = 1ULL << (kPin & 63);  // the mask keeps a build without a pin (-1) free of a negative shift
    c.mode = GPIO_MODE_INPUT_OUTPUT_OD;
    c.pull_up_en = GPIO_PULLUP_DISABLE;
    c.pull_down_en = GPIO_PULLDOWN_DISABLE;
    c.intr_type = GPIO_INTR_DISABLE;
    esp_err_t err = gpio_config(&c);
    esp_timer_create_args_t args{};
    args.callback = release;
    args.dispatch_method = ESP_TIMER_TASK;
    args.name = "fr_test_pin";
    if (err == ESP_OK) {
        err = esp_timer_create(&args, &s_release);
    }
    if (err != ESP_OK) {
        s_release = nullptr;
        ESP_LOGE(TAG, "test_pin GPIO%d: %s; pin_pulse answers unsupported", kPin, esp_err_to_name(err));
    }
#endif
}

int pin()
{
    return kPin;
}

std::expected<diag::PulseInfo, Err> pulse(uint32_t us)
{
#if FR_TEST_HOOKS
    if (kPin < 0 || s_release == nullptr) {
        return std::unexpected(Err::unsupported);
    }
    if (s_low.exchange(true, std::memory_order_acq_rel)) {
        return std::unexpected(Err::busy);
    }
    const auto pin = static_cast<gpio_num_t>(kPin);
    gpio_set_level(pin, 0);
    // The falling edge, as close to it as the clock can be read: what T-LAT pairs with the other board's input.
    const TimeUs at = esp_timer_get_time();
    if (esp_timer_start_once(s_release, us) != ESP_OK) {
        gpio_set_level(pin, 1);
        s_low.store(false, std::memory_order_release);
        return std::unexpected(Err::failed);
    }
    return diag::PulseInfo{.pin = kPin, .at = at};
#else
    static_cast<void>(us);
    return std::unexpected(Err::unsupported);
#endif
}

}  // namespace fr::core::test_pin
