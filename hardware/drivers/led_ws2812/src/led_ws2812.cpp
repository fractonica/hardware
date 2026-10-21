// fr:realtime
#include "fr/drv/led_ws2812.hpp"

#include "driver/gpio.h"
#include "led_strip.h"

namespace fr::drv {

namespace {

// 10 MHz gives 0.1 us ticks, fine enough for the WS2812 bit timings (led_strip's own default).
constexpr uint32_t kRmtResolutionHz = 10 * 1000 * 1000;

uint32_t scale(uint8_t c, uint8_t brightness)
{
    return (static_cast<uint32_t>(c) * brightness + 127) / 255;
}

}  // namespace

Status LedWs2812::init(Core &)
{
    if (!GPIO_IS_VALID_OUTPUT_GPIO(cfg_.gpio)) {
        return std::unexpected(Err::invalid_args);
    }
    led_strip_config_t strip = {};
    strip.strip_gpio_num = cfg_.gpio;
    strip.max_leds = 1;
    strip.led_model = LED_MODEL_WS2812;
    strip.color_component_format =
        cfg_.color_order == ColorOrder::GRB ? LED_STRIP_COLOR_COMPONENT_FMT_GRB : LED_STRIP_COLOR_COMPONENT_FMT_RGB;
    led_strip_rmt_config_t rmt = {};
    rmt.clk_src = RMT_CLK_SRC_DEFAULT;
    rmt.resolution_hz = kRmtResolutionHz;
    // led_strip allocates its channel and pixel buffer here, once at boot, never on the realtime path.
    if (led_strip_new_rmt_device(&strip, &rmt, &strip_) != ESP_OK) {
        strip_ = nullptr;
        return std::unexpected(Err::failed);
    }
    // A WS2812 can power up showing a stale or random colour; start dark.
    level_ = {};
    return show(level_);
}

Status LedWs2812::write(const hal::LightLevel &l)
{
    if (strip_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    level_ = l;
    return show(l);
}

Status LedWs2812::show(const hal::LightLevel &l)
{
    const uint8_t b = l.on ? l.brightness : 0;
    // One pixel is 24 bits plus the reset gap: refresh blocks for about 0.3 ms, inside the 1 ms the
    // LightOutput contract allows.
    if (led_strip_set_pixel(strip_, 0, scale(l.color.r, b), scale(l.color.g, b), scale(l.color.b, b)) != ESP_OK ||
        led_strip_refresh(strip_) != ESP_OK) {
        return std::unexpected(Err::failed);
    }
    return {};
}

hal::Selftest LedWs2812::selftest()
{
    if (strip_ == nullptr) {
        return {false, "not initialized"};
    }
    // The RMT owns the pin, so there is no level to drive and read back; instead re-send the current
    // colour (proves the channel transmits) and check that the data line idles low afterwards, which a
    // short to 3V3 or a wrong pin would break.
    if (!show(level_)) {
        return {false, "RMT refresh failed"};
    }
    const auto pin = static_cast<gpio_num_t>(cfg_.gpio);
    gpio_input_enable(pin);
    if (gpio_get_level(pin) != 0) {
        return {false, "data line high at idle (shorted to 3V3?)"};
    }
    return {true, "refresh ok, data line idles low"};
}

}  // namespace fr::drv
