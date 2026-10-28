#include "fr/drv/st7789_spi.hpp"

#include <algorithm>
#include <cinttypes>
#include <cstdio>
#include <cstring>
#include <iterator>

#include "driver/gpio.h"
#include "driver/ledc.h"
#include "driver/spi_master.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

namespace fr::drv {
namespace {

constexpr const char *TAG = "st7789";

constexpr spi_host_device_t kHost = SPI2_HOST;

// ST7789 commands (datasheet v1.6 §9.1).
constexpr uint8_t kSwReset = 0x01;
constexpr uint8_t kSlpOut = 0x11;
constexpr uint8_t kNorOn = 0x13;
constexpr uint8_t kInvOn = 0x21;
constexpr uint8_t kDispOn = 0x29;
constexpr uint8_t kCaSet = 0x2A;
constexpr uint8_t kRaSet = 0x2B;
constexpr uint8_t kRamWr = 0x2C;
constexpr uint8_t kMadCtl = 0x36;
constexpr uint8_t kColMod = 0x3A;

constexpr uint8_t kMadMy = 0x80;
constexpr uint8_t kMadMx = 0x40;
constexpr uint8_t kMadMv = 0x20;

// The backlight PWM: the top LEDC timer and channels, clear of fixture_gpio's (timer 0, channels from 0 up).
constexpr ledc_mode_t kLedcMode = LEDC_LOW_SPEED_MODE;
constexpr ledc_timer_t kLedcTimer = LEDC_TIMER_3;
constexpr uint32_t kLedcHz = 20'000;
constexpr int kLedcTop = LEDC_CHANNEL_MAX - 1;
int s_ledc_next = kLedcTop;  // channels are taken downwards, one per panel with a backlight
bool s_ledc_timer = false;

void delay_ms(uint32_t ms)
{
    vTaskDelay(pdMS_TO_TICKS(ms) > 0 ? pdMS_TO_TICKS(ms) : 1);
}

}  // namespace

uint8_t St7789Spi::madctl(hal::Rotation r)
{
    switch (r) {
    case hal::Rotation::r0:
        return 0;
    case hal::Rotation::r90:
        return kMadMx | kMadMv;
    case hal::Rotation::r180:
        return kMadMx | kMadMy;
    case hal::Rotation::r270:
        return kMadMy | kMadMv;
    }
    return 0;
}

Status St7789Spi::init(Core &, hal::Rotation rotation)
{
    if (cfg_.width == 0 || cfg_.height == 0 || cfg_.width + cfg_.column_offset > kRamWidth ||
        cfg_.height + cfg_.row_offset > kRamHeight || cfg_.spi_mhz == 0 || cfg_.spi_mhz > 80) {
        return std::unexpected(Err::invalid_args);
    }
    for (int pin : {int{cfg_.sclk}, int{cfg_.mosi}, int{cfg_.cs}, int{cfg_.dc}}) {
        if (!GPIO_IS_VALID_OUTPUT_GPIO(pin)) {
            return std::unexpected(Err::invalid_args);
        }
    }
    for (int pin = 0; pin < 64; ++pin) {
        if (((cfg_.idle_high >> pin) & 1) != 0 && !GPIO_IS_VALID_OUTPUT_GPIO(pin)) {
            return std::unexpected(Err::invalid_args);
        }
    }
    rotation_ = rotation;
    const uint16_t c0 = cfg_.column_offset;
    const uint16_t r0 = cfg_.row_offset;
    const auto c0m = static_cast<uint16_t>(kRamWidth - cfg_.width - c0);
    const auto r0m = static_cast<uint16_t>(kRamHeight - cfg_.height - r0);
    switch (rotation) {
    case hal::Rotation::r0:
        x0_ = c0;
        y0_ = r0;
        break;
    case hal::Rotation::r90:
        x0_ = r0;
        y0_ = c0m;
        break;
    case hal::Rotation::r180:
        x0_ = c0m;
        y0_ = r0m;
        break;
    case hal::Rotation::r270:
        x0_ = r0m;
        y0_ = c0;
        break;
    }

    // Backlight off before anything else lights the glass.
    if (auto st = backlight_init(); !st) {
        return st;
    }

    // The other devices' chip selects on this bus, high before the bus carries anything: the level first, then the
    // output enable, so the pin never drives low.
    if (cfg_.idle_high != 0) {
        for (int pin = 0; pin < 64; ++pin) {
            if (((cfg_.idle_high >> pin) & 1) != 0) {
                gpio_set_level(static_cast<gpio_num_t>(pin), 1);
            }
        }
        gpio_config_t cs = {};
        cs.pin_bit_mask = cfg_.idle_high;
        cs.mode = GPIO_MODE_OUTPUT;
        cs.pull_up_en = GPIO_PULLUP_ENABLE;  // also high if something resets the output
        cs.pull_down_en = GPIO_PULLDOWN_DISABLE;
        cs.intr_type = GPIO_INTR_DISABLE;
        if (gpio_config(&cs) != ESP_OK) {
            return std::unexpected(Err::failed);
        }
    }

    gpio_config_t io = {};
    io.pin_bit_mask = 1ULL << cfg_.dc;
    if (cfg_.rst >= 0) {
        io.pin_bit_mask |= 1ULL << cfg_.rst;
    }
    io.mode = GPIO_MODE_OUTPUT;
    io.pull_up_en = GPIO_PULLUP_DISABLE;
    io.pull_down_en = GPIO_PULLDOWN_DISABLE;
    io.intr_type = GPIO_INTR_DISABLE;
    if (gpio_config(&io) != ESP_OK) {
        return std::unexpected(Err::failed);
    }
    if (cfg_.rst >= 0) {
        gpio_set_level(static_cast<gpio_num_t>(cfg_.rst), 0);
        delay_ms(10);
        gpio_set_level(static_cast<gpio_num_t>(cfg_.rst), 1);
        delay_ms(120);
    }

    spi_bus_config_t bus = {};
    std::fill(std::begin(bus.iocfg), std::end(bus.iocfg), -1);
    bus.mosi_io_num = cfg_.mosi;
    bus.sclk_io_num = cfg_.sclk;
    bus.max_transfer_sz = static_cast<int>(kChunk);
    esp_err_t err = spi_bus_initialize(kHost, &bus, SPI_DMA_CH_AUTO);
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {  // INVALID_STATE: another device brought the bus up
        ESP_LOGE(TAG, "spi_bus_initialize: %s", esp_err_to_name(err));
        return std::unexpected(Err::failed);
    }
    spi_device_interface_config_t dev = {};
    dev.mode = 0;
    dev.clock_speed_hz = static_cast<int>(cfg_.spi_mhz) * 1'000'000;
    dev.spics_io_num = cfg_.cs;
    dev.queue_size = 2;
    err = spi_bus_add_device(kHost, &dev, &dev_);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "spi_bus_add_device: %s", esp_err_to_name(err));
        return std::unexpected(Err::failed);
    }

    const uint8_t colmod = 0x55;  // 16 bits per pixel, RGB565
    const uint8_t mad = madctl(rotation);
    Status st = command(kSwReset);
    if (st) {
        delay_ms(150);
        st = command(kSlpOut);
    }
    if (st) {
        delay_ms(120);
        st = command(kColMod, {&colmod, 1});
    }
    if (st) {
        st = command(kMadCtl, {&mad, 1});
    }
    if (st) {
        st = command(kInvOn);
    }
    if (st) {
        st = command(kNorOn);
    }
    if (st) {
        st = window(0, 0, width(), height());
    }
    if (st) {
        st = pixels({}, static_cast<size_t>(width()) * height() * 2);
    }
    if (st) {
        st = command(kDispOn);
    }
    if (!st) {
        ESP_LOGE(TAG, "init sequence not sent");
        return st;
    }
    ready_ = true;
    return {};
}

Status St7789Spi::backlight_init()
{
    if (cfg_.backlight < 0) {
        return {};
    }
    if (!GPIO_IS_VALID_OUTPUT_GPIO(cfg_.backlight) || s_ledc_next < 0) {
        return std::unexpected(Err::invalid_args);
    }
    if (!s_ledc_timer) {
        ledc_timer_config_t t = {};
        t.speed_mode = kLedcMode;
        t.duty_resolution = LEDC_TIMER_8_BIT;
        t.timer_num = kLedcTimer;
        t.freq_hz = kLedcHz;
        t.clk_cfg = LEDC_AUTO_CLK;
        if (ledc_timer_config(&t) != ESP_OK) {
            return std::unexpected(Err::failed);
        }
        s_ledc_timer = true;
    }
    ledc_channel_config_t c = {};
    c.gpio_num = cfg_.backlight;
    c.speed_mode = kLedcMode;
    c.channel = static_cast<ledc_channel_t>(s_ledc_next);
    c.timer_sel = kLedcTimer;
    c.duty = 0;  // off
    c.hpoint = 0;
    // An active-low backlight (the LCD-1.9, M2-C5 bench) gets the inverted output, so duty still means brightness.
    c.flags.output_invert = cfg_.backlight_active == BacklightActive::low ? 1 : 0;
    if (ledc_channel_config(&c) != ESP_OK) {
        return std::unexpected(Err::failed);
    }
    ledc_ch_ = static_cast<int8_t>(s_ledc_next--);
    level_ = 0;
    return {};
}

Status St7789Spi::set_backlight(uint8_t level)
{
    if (ledc_ch_ < 0) {
        return {};  // no backlight control: accepted and ignored
    }
    // 8-bit duty; 256 is fully on (no low phase at all).
    const uint32_t duty = level == 255 ? 256u : level;
    const auto ch = static_cast<ledc_channel_t>(ledc_ch_);
    if (ledc_set_duty(kLedcMode, ch, duty) != ESP_OK || ledc_update_duty(kLedcMode, ch) != ESP_OK) {
        return std::unexpected(Err::failed);
    }
    level_ = level;
    return {};
}

Status St7789Spi::command(uint8_t cmd, std::span<const uint8_t> params)
{
    spi_transaction_t t = {};
    t.flags = SPI_TRANS_USE_TXDATA;
    t.length = 8;
    t.tx_data[0] = cmd;
    gpio_set_level(static_cast<gpio_num_t>(cfg_.dc), 0);
    if (spi_device_polling_transmit(dev_, &t) != ESP_OK) {
        return std::unexpected(Err::failed);
    }
    if (params.empty()) {
        return {};
    }
    // Parameters are at most 4 bytes here (CASET, RASET): inline, no DMA buffer.
    spi_transaction_t p = {};
    p.flags = SPI_TRANS_USE_TXDATA;
    p.length = 8 * std::min<size_t>(params.size(), 4);
    std::memcpy(p.tx_data, params.data(), std::min<size_t>(params.size(), 4));
    gpio_set_level(static_cast<gpio_num_t>(cfg_.dc), 1);
    if (spi_device_polling_transmit(dev_, &p) != ESP_OK) {
        return std::unexpected(Err::failed);
    }
    return {};
}

Status St7789Spi::window(uint16_t x, uint16_t y, uint16_t w, uint16_t h)
{
    const uint16_t xs = x0_ + x;
    const uint16_t xe = static_cast<uint16_t>(xs + w - 1);
    const uint16_t ys = y0_ + y;
    const uint16_t ye = static_cast<uint16_t>(ys + h - 1);
    const uint8_t ca[4] = {static_cast<uint8_t>(xs >> 8), static_cast<uint8_t>(xs), static_cast<uint8_t>(xe >> 8),
                           static_cast<uint8_t>(xe)};
    const uint8_t ra[4] = {static_cast<uint8_t>(ys >> 8), static_cast<uint8_t>(ys), static_cast<uint8_t>(ye >> 8),
                           static_cast<uint8_t>(ye)};
    if (auto st = command(kCaSet, ca); !st) {
        return st;
    }
    if (auto st = command(kRaSet, ra); !st) {
        return st;
    }
    return command(kRamWr);
}

Status St7789Spi::pixels(std::span<const uint8_t> src, size_t n)
{
    gpio_set_level(static_cast<gpio_num_t>(cfg_.dc), 1);
    spi_transaction_t t[2] = {};
    int in_flight = 0;
    int which = 0;
    Status st{};
    for (size_t off = 0; off < n; off += kChunk) {
        const size_t len = std::min(kChunk, n - off);
        uint8_t *buf = buf_[which];
        // A chunk is converted while the other one is on the wire; the buffer of a chunk still in flight is never
        // touched (at most two are queued, and the older one is collected first).
        if (in_flight == 2) {
            spi_transaction_t *done = nullptr;
            if (spi_device_get_trans_result(dev_, &done, portMAX_DELAY) != ESP_OK) {
                st = std::unexpected(Err::failed);
                in_flight = 0;
                break;
            }
            --in_flight;
        }
        if (src.empty()) {
            std::memset(buf, 0, len);
        } else {
            for (size_t i = 0; i + 1 < len; i += 2) {
                buf[i] = src[off + i + 1];  // RGB565 high byte first on the wire
                buf[i + 1] = src[off + i];
            }
        }
        t[which] = {};
        t[which].length = len * 8;
        t[which].tx_buffer = buf;
        if (spi_device_queue_trans(dev_, &t[which], portMAX_DELAY) != ESP_OK) {
            st = std::unexpected(Err::failed);
            break;
        }
        ++in_flight;
        which ^= 1;
    }
    while (in_flight > 0) {
        spi_transaction_t *done = nullptr;
        if (spi_device_get_trans_result(dev_, &done, portMAX_DELAY) != ESP_OK) {
            st = std::unexpected(Err::failed);
            break;
        }
        --in_flight;
    }
    return st;
}

Status St7789Spi::flush(uint16_t x, uint16_t y, uint16_t w, uint16_t h, std::span<const uint8_t> px)
{
    if (!ready_) {
        return std::unexpected(Err::failed);
    }
    const size_t n = static_cast<size_t>(w) * h * 2;
    if (w == 0 || h == 0 || x + w > width() || y + h > height() || px.size() < n) {
        return std::unexpected(Err::invalid_args);
    }
    Status st = window(x, y, w, h);
    if (st) {
        st = pixels(px, n);
    }
    if (!st) {
        ++flush_errors_;
    }
    return st;
}

#if FR_HOST_SHIM
void st7789_spi_host_reset()
{
    s_ledc_next = kLedcTop;
    s_ledc_timer = false;
}
#endif

hal::Selftest St7789Spi::selftest()
{
    if (!ready_) {
        return {false, "not initialized (init sequence not sent)"};
    }
    // MOSI only: the panel cannot be read back, so this reports what was sent and what drives the backlight.
    if (ledc_ch_ >= 0) {
        snprintf(detail_, sizeof(detail_), "init sent (no readback), %ux%u, backlight PWM on LEDC %d at %u/255, %" PRIu32 " flush errors",
                 unsigned{width()}, unsigned{height()}, int{ledc_ch_}, unsigned{level_}, flush_errors_);
    } else {
        snprintf(detail_, sizeof(detail_), "init sent (no readback), %ux%u, no backlight control, %" PRIu32 " flush errors",
                 unsigned{width()}, unsigned{height()}, flush_errors_);
    }
    return {true, detail_};
}

}  // namespace fr::drv
