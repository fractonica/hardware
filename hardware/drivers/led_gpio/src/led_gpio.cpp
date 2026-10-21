// fr:realtime
#include "fr/drv/led_gpio.hpp"

#include "driver/gpio.h"
#include "esp_rom_sys.h"

namespace fr::drv {

namespace {

// The pad input is synchronised to the APB clock, so a level written to the output register reads
// back a few cycles later.
constexpr uint32_t kSettleUs = 2;

}  // namespace

Status LedGpio::init(Core &)
{
    if (!GPIO_IS_VALID_OUTPUT_GPIO(cfg_.gpio)) {
        return std::unexpected(Err::invalid_args);
    }
    const auto pin = static_cast<gpio_num_t>(cfg_.gpio);
    // Latch "off" before the output is enabled so the LED never flashes at boot.
    gpio_set_level(pin, pin_level(false));
    gpio_config_t io = {};
    io.pin_bit_mask = 1ULL << cfg_.gpio;
    // Input stays enabled so selftest() can read the pad back without reconfiguring it.
    io.mode = GPIO_MODE_INPUT_OUTPUT;
    io.pull_up_en = GPIO_PULLUP_DISABLE;
    io.pull_down_en = GPIO_PULLDOWN_DISABLE;
    io.intr_type = GPIO_INTR_DISABLE;
    if (gpio_config(&io) != ESP_OK) {
        return std::unexpected(Err::failed);
    }
    lit_ = false;
    ready_ = true;
    return {};
}

Status LedGpio::write(const hal::LightLevel &l)
{
    if (!ready_) {
        return std::unexpected(Err::failed);
    }
    // features() says neither dimmable nor rgb, so only `on` counts (hal/light.hpp): brightness 0 must
    // not leave the LED dark while the service reports it on.
    const bool lit = l.on;
    if (gpio_set_level(static_cast<gpio_num_t>(cfg_.gpio), pin_level(lit)) != ESP_OK) {
        return std::unexpected(Err::failed);
    }
    lit_ = lit;
    return {};
}

hal::Selftest LedGpio::selftest()
{
    if (!ready_) {
        return {false, "not initialized"};
    }
    // Drive both levels and read the pad back (spec 09 §9.7). A pin shorted to a rail or held by
    // something stronger reads the wrong level. The LED flickers for a few microseconds.
    const auto pin = static_cast<gpio_num_t>(cfg_.gpio);
    gpio_set_level(pin, 1);
    esp_rom_delay_us(kSettleUs);
    const bool ok_high = gpio_get_level(pin) == 1;
    gpio_set_level(pin, 0);
    esp_rom_delay_us(kSettleUs);
    const bool ok_low = gpio_get_level(pin) == 0;
    gpio_set_level(pin, pin_level(lit_));
    if (!ok_high && !ok_low) {
        return {false, "pad reads the opposite of what is driven"};
    }
    if (!ok_high) {
        return {false, "pad reads low while driven high (shorted to ground?)"};
    }
    if (!ok_low) {
        return {false, "pad reads high while driven low (shorted to 3V3?)"};
    }
    return {true, "drive and readback ok"};
}

}  // namespace fr::drv
