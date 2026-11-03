#include "fr/drv/gc9a01_spi.hpp"

#include <algorithm>
#include <cinttypes>
#include <cstdio>
#include <cstring>
#include <iterator>

#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

namespace fr::drv {
namespace {

constexpr const char *TAG = "gc9a01";

constexpr spi_host_device_t kHost = SPI2_HOST;

// GC9A01 commands (GC9A01A datasheet v1.2 §6.2, the MIPI DCS subset).
constexpr uint8_t kSwReset = 0x01;
constexpr uint8_t kSlpOut = 0x11;
constexpr uint8_t kInvOff = 0x20;
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
constexpr uint8_t kMadBgr = 0x08;

/** The longest parameter list of the init sequence (0x62, 0x63). */
constexpr size_t kMaxParams = 12;

/**
 * The panel vendor's register boilerplate as Adafruit_GC9A01A sends it, the table the bench's spike lit the glass with
 * (2026-11-03: red, green, blue and white where drawn): {command, parameter count, parameters...}. Most of these
 * registers are undocumented (the 0x6x/0x8x/0x9x tables, 0xFF, 0xBC/0xBD/0xBE, 0xDF, 0xE1, 0xED); their values are
 * copied, not understood. Adafruit leaves out the vendor's 0x70 line (TFT_eSPI and esp_lcd_gc9a01 send it; Adafruit's
 * users reported trouble with it), and so does this table. kMadCtl marks where MADCTL (rotation, BGR) goes:
 * init_sequence fills it in.
 */
constexpr uint8_t kVendorInit[] = {
    0xEF, 0,                                       // inter-register enable 2
    0xEB, 1, 0x14,
    0xFE, 0,                                       // inter-register enable 1
    0xEF, 0,                                       // inter-register enable 2
    0xEB, 1, 0x14,
    0x84, 1, 0x40,
    0x85, 1, 0xFF,
    0x86, 1, 0xFF,
    0x87, 1, 0xFF,
    0x88, 1, 0x0A,
    0x89, 1, 0x21,
    0x8A, 1, 0x00,
    0x8B, 1, 0x80,
    0x8C, 1, 0x01,
    0x8D, 1, 0x01,
    0x8E, 1, 0xFF,
    0x8F, 1, 0xFF,
    0xB6, 2, 0x00, 0x00,                           // display function control (Adafruit's: SS clear, so r0 sets MX)
    kMadCtl, 1, 0x00,                              // filled in: the rotation and BGR
    kColMod, 1, 0x05,                              // 16 bits per pixel (RGB565) on the MCU interface (the bench's)
    0x90, 4, 0x08, 0x08, 0x08, 0x08,
    0xBD, 1, 0x06,
    0xBC, 1, 0x00,
    0xFF, 3, 0x60, 0x01, 0x04,
    0xC3, 1, 0x13,                                 // power control 2
    0xC4, 1, 0x13,                                 // power control 3
    0xC9, 1, 0x22,                                 // power control 4
    0xBE, 1, 0x11,
    0xE1, 2, 0x10, 0x0E,
    0xDF, 3, 0x21, 0x0C, 0x02,
    0xF0, 6, 0x45, 0x09, 0x08, 0x08, 0x26, 0x2A,   // gamma 1
    0xF1, 6, 0x43, 0x70, 0x72, 0x36, 0x37, 0x6F,   // gamma 2
    0xF2, 6, 0x45, 0x09, 0x08, 0x08, 0x26, 0x2A,   // gamma 3
    0xF3, 6, 0x43, 0x70, 0x72, 0x36, 0x37, 0x6F,   // gamma 4
    0xED, 2, 0x1B, 0x0B,
    0xAE, 1, 0x77,
    0xCD, 1, 0x63,
    0xE8, 1, 0x34,                                 // frame rate
    0x62, 12, 0x18, 0x0D, 0x71, 0xED, 0x70, 0x70, 0x18, 0x0F, 0x71, 0xEF, 0x70, 0x70,
    0x63, 12, 0x18, 0x11, 0x71, 0xF1, 0x70, 0x70, 0x18, 0x13, 0x71, 0xF3, 0x70, 0x70,
    0x64, 7, 0x28, 0x29, 0xF1, 0x01, 0xF1, 0x00, 0x07,
    0x66, 10, 0x3C, 0x00, 0xCD, 0x67, 0x45, 0x45, 0x10, 0x00, 0x00, 0x00,
    0x67, 10, 0x00, 0x3C, 0x00, 0x00, 0x00, 0x01, 0x54, 0x10, 0x32, 0x98,
    0x74, 7, 0x10, 0x85, 0x80, 0x00, 0x00, 0x4E, 0x00,
    0x98, 2, 0x3E, 0x07,
    0x35, 0,                                       // tearing effect line on (the module does not wire TE)
};

void delay_ms(uint32_t ms)
{
    vTaskDelay(pdMS_TO_TICKS(ms) > 0 ? pdMS_TO_TICKS(ms) : 1);
}

}  // namespace

uint8_t Gc9a01Spi::madctl(hal::Rotation r, bool bgr)
{
    uint8_t m = 0;
    // Adafruit_GC9A01A's setRotation 0..3; r0 (MX) is the bench's, the others are not seen on the glass yet.
    switch (r) {
    case hal::Rotation::r0:
        m = kMadMx;
        break;
    case hal::Rotation::r90:
        m = kMadMv;
        break;
    case hal::Rotation::r180:
        m = kMadMy;
        break;
    case hal::Rotation::r270:
        m = kMadMx | kMadMy | kMadMv;
        break;
    }
    return bgr ? static_cast<uint8_t>(m | kMadBgr) : m;
}

Status Gc9a01Spi::init(Core &, hal::Rotation rotation)
{
    if (cfg_.width == 0 || cfg_.height == 0 || cfg_.width > kRamWidth || cfg_.height > kRamHeight || cfg_.spi_mhz == 0 ||
        cfg_.spi_mhz > 80) {
        return std::unexpected(Err::invalid_args);
    }
    for (int pin : {int{cfg_.sclk}, int{cfg_.mosi}, int{cfg_.dc}}) {
        if (!GPIO_IS_VALID_OUTPUT_GPIO(pin)) {
            return std::unexpected(Err::invalid_args);
        }
    }
    for (int pin : {int{cfg_.cs}, int{cfg_.rst}}) {
        if (pin >= 0 && !GPIO_IS_VALID_OUTPUT_GPIO(pin)) {
            return std::unexpected(Err::invalid_args);
        }
    }
    rotation_ = rotation;

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
    dev.spics_io_num = cfg_.cs;  // -1: no CS (the module pulls it low)
    dev.queue_size = 2;
    err = spi_bus_add_device(kHost, &dev, &dev_);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "spi_bus_add_device: %s", esp_err_to_name(err));
        return std::unexpected(Err::failed);
    }

    if (Status st = init_sequence(rotation); !st) {
        ESP_LOGE(TAG, "init sequence not sent");
        return st;
    }
    ready_ = true;
    ESP_LOGI(TAG, "%ux%u at %u MHz, rotation %u, %s, %s, cs %d, rst %d", unsigned{cfg_.width}, unsigned{cfg_.height},
             unsigned{cfg_.spi_mhz}, static_cast<unsigned>(rotation), cfg_.invert ? "inverted" : "not inverted",
             cfg_.bgr ? "BGR" : "RGB", int{cfg_.cs}, int{cfg_.rst});
    return {};
}

Status Gc9a01Spi::init_sequence(hal::Rotation rotation)
{
    // Without a reset line the panel may hold any state (a brown-out, a warm reboot): SWRESET first.
    Status st{};
    if (cfg_.rst < 0) {
        st = command(kSwReset);
        if (st) {
            delay_ms(150);  // the bench's spike waited 150 ms
        }
    }
    for (size_t i = 0; st && i + 1 < sizeof(kVendorInit);) {
        const uint8_t cmd = kVendorInit[i];
        const uint8_t n = kVendorInit[i + 1];
        uint8_t params[kMaxParams] = {};
        if (n > kMaxParams || i + 2u + n > sizeof(kVendorInit)) {
            return std::unexpected(Err::failed);  // a malformed table: caught by the host test
        }
        if (n > 0) {
            std::memcpy(params, &kVendorInit[i + 2], n);
        }
        if (cmd == kMadCtl) {
            params[0] = madctl(rotation, cfg_.bgr);
        }
        st = command(cmd, {params, n});
        i += 2u + n;
    }
    if (st) {
        st = command(cfg_.invert ? kInvOn : kInvOff);
    }
    if (st) {
        st = command(kSlpOut);
    }
    if (st) {
        delay_ms(120);
        st = window(0, 0, width(), height());
    }
    if (st) {
        st = pixels({}, static_cast<size_t>(width()) * height() * 2);
    }
    if (st) {
        st = command(kDispOn);
    }
    if (st) {
        delay_ms(20);
    }
    return st;
}

Status Gc9a01Spi::command(uint8_t cmd, std::span<const uint8_t> params)
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
    spi_transaction_t p = {};
    if (params.size() <= 4) {
        p.flags = SPI_TRANS_USE_TXDATA;
        std::memcpy(p.tx_data, params.data(), params.size());
    } else {
        // Longer lists (the vendor tables, up to 12 bytes) from the DMA-capable chunk buffer: nothing is in flight.
        const size_t n = std::min(params.size(), kChunk);
        std::memcpy(buf_[0], params.data(), n);
        p.tx_buffer = buf_[0];
    }
    p.length = 8 * std::min(params.size(), kChunk);
    gpio_set_level(static_cast<gpio_num_t>(cfg_.dc), 1);
    if (spi_device_polling_transmit(dev_, &p) != ESP_OK) {
        return std::unexpected(Err::failed);
    }
    return {};
}

Status Gc9a01Spi::window(uint16_t x, uint16_t y, uint16_t w, uint16_t h)
{
    const uint16_t xs = x;
    const auto xe = static_cast<uint16_t>(xs + w - 1);
    const uint16_t ys = y;
    const auto ye = static_cast<uint16_t>(ys + h - 1);
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

Status Gc9a01Spi::pixels(std::span<const uint8_t> src, size_t n)
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

Status Gc9a01Spi::flush(uint16_t x, uint16_t y, uint16_t w, uint16_t h, std::span<const uint8_t> px)
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

hal::Selftest Gc9a01Spi::selftest()
{
    if (!ready_) {
        return {false, "not initialized (init sequence not sent)"};
    }
    // MOSI only: the panel cannot be read back, so this reports what was sent.
    snprintf(detail_, sizeof(detail_), "init sent (no readback), %ux%u round, %u MHz, no backlight control, %" PRIu32 " flush errors",
             unsigned{width()}, unsigned{height()}, unsigned{cfg_.spi_mhz}, flush_errors_);
    return {true, detail_};
}

}  // namespace fr::drv
