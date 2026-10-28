#include "fr/drv/ssd1306_i2c.hpp"

#include <algorithm>
#include <cinttypes>
#include <cstdio>
#include <cstring>

#include "driver/i2c_master.h"
#include "esp_log.h"
#include "fr/platform/i2c_bus.hpp"

namespace fr::drv {
namespace {

constexpr const char *TAG = "ssd1306";
constexpr int kTimeoutMs = 50;
constexpr uint8_t kCtrlCommands = 0x00;  // control byte: a command stream follows
constexpr uint8_t kCtrlData = 0x40;      // control byte: GDDRAM data follows

}  // namespace

Status Ssd1306I2c::init(Core &, hal::Rotation rotation)
{
    if (rotation == hal::Rotation::r90 || rotation == hal::Rotation::r270) {
        return std::unexpected(Err::unsupported);  // the controller mirrors, it does not turn
    }
    if (cfg_.width == 0 || cfg_.height == 0 || cfg_.height % 8 != 0 || cfg_.height > kRamRows ||
        cfg_.width + cfg_.column_offset > kRamColumns) {
        return std::unexpected(Err::invalid_args);
    }
    rotation_ = rotation;
    const bool flip = rotation == hal::Rotation::r180;
    col0_ = flip ? static_cast<uint16_t>(kRamColumns - cfg_.width - cfg_.column_offset) : cfg_.column_offset;

    const auto dev = platform::i2c_device(cfg_.sda, cfg_.scl, cfg_.address, cfg_.i2c_khz);
    if (!dev) {
        return std::unexpected(dev.error());
    }
    dev_ = *dev;
    const uint8_t init[] = {
        0xAE,                                     // display off
        0xD5, 0x80,                               // clock divide
        0xA8, static_cast<uint8_t>(cfg_.height - 1),  // multiplex ratio
        0xD3, 0x00,                               // display offset
        0x40,                                     // start line 0
        0x8D, 0x14,                               // charge pump on
        0x20, 0x00,                               // horizontal addressing
        static_cast<uint8_t>(flip ? 0xA0 : 0xA1),  // segment remap
        static_cast<uint8_t>(flip ? 0xC0 : 0xC8),  // COM scan direction
        0xDA, 0x12,                               // COM pins
        0x81, 0xCF,                               // contrast (set_backlight sets it next)
        0xD9, 0xF1,                               // pre-charge
        0xDB, 0x40,                               // VCOMH
        0xAD, 0x30,                               // internal IREF (SSD1306B)
        0x2E, 0xA4, 0xA6,                         // scroll off, RAM display, normal
    };
    if (auto st = commands(init); !st) {
        ESP_LOGE(TAG, "init not accepted at 0x%02X", cfg_.address);
        return st;
    }
    // The window cleared (GDDRAM is random at power-up), then on.
    const uint8_t zeros[kRamColumns / 8 * 8] = {};
    const uint16_t stride = static_cast<uint16_t>((cfg_.width + 7) / 8);
    for (uint16_t p = 0; p < cfg_.height / 8; ++p) {
        if (auto st = write_pages(0, cfg_.width, static_cast<uint8_t>(p), static_cast<uint8_t>(p),
                                  {zeros, static_cast<size_t>(stride) * 8}, stride, static_cast<uint16_t>(p * 8), 8);
            !st) {
            return st;
        }
    }
    const uint8_t on[] = {0xAF};
    if (auto st = commands(on); !st) {
        return st;
    }
    ready_ = true;
    return {};
}

Status Ssd1306I2c::commands(std::span<const uint8_t> cmds)
{
    uint8_t buf[40];
    if (cmds.size() + 1 > sizeof(buf)) {
        return std::unexpected(Err::invalid_args);
    }
    buf[0] = kCtrlCommands;
    std::memcpy(buf + 1, cmds.data(), cmds.size());
    if (i2c_master_transmit(dev_, buf, cmds.size() + 1, kTimeoutMs) != ESP_OK) {
        return std::unexpected(Err::failed);
    }
    return {};
}

Status Ssd1306I2c::write_pages(uint16_t x, uint16_t w, uint8_t p0, uint8_t p1, std::span<const uint8_t> rows,
                               size_t stride, uint16_t y, uint16_t h)
{
    const uint8_t window[] = {0x21, static_cast<uint8_t>(col0_ + x), static_cast<uint8_t>(col0_ + x + w - 1),
                              0x22, p0, p1};
    if (auto st = commands(window); !st) {
        return st;
    }
    uint8_t buf[1 + kRamColumns];
    buf[0] = kCtrlData;
    for (uint8_t p = p0; p <= p1; ++p) {
        // Column c of page p: rows p*8..p*8+7 of the area, bit 0 the top; rows past the area's bottom stay dark.
        for (uint16_t c = 0; c < w; ++c) {
            uint8_t b = 0;
            for (int r = 0; r < 8; ++r) {
                const int row = p * 8 + r - y;  // row inside the area
                if (row < 0 || row >= h) {
                    continue;
                }
                const uint8_t src = rows[static_cast<size_t>(row) * stride + c / 8];
                if (((src >> (7 - c % 8)) & 1u) != 0) {
                    b = static_cast<uint8_t>(b | (1u << r));
                }
            }
            buf[1 + c] = b;
        }
        if (i2c_master_transmit(dev_, buf, static_cast<size_t>(w) + 1, kTimeoutMs) != ESP_OK) {
            return std::unexpected(Err::failed);
        }
    }
    return {};
}

Status Ssd1306I2c::flush(uint16_t x, uint16_t y, uint16_t w, uint16_t h, std::span<const uint8_t> pixels)
{
    if (!ready_) {
        return std::unexpected(Err::failed);
    }
    const size_t stride = (static_cast<size_t>(w) + 7) / 8;
    const bool whole_pages = y % 8 == 0 && (h % 8 == 0 || y + h == cfg_.height);
    if (w == 0 || h == 0 || x + w > cfg_.width || y + h > cfg_.height || !whole_pages || pixels.size() < stride * h) {
        return std::unexpected(Err::invalid_args);
    }
    const Status st = write_pages(x, w, static_cast<uint8_t>(y / 8), static_cast<uint8_t>((y + h - 1) / 8), pixels,
                                  stride, y, h);
    if (!st) {
        ++flush_errors_;
    }
    return st;
}

Status Ssd1306I2c::set_backlight(uint8_t level)
{
    if (!ready_) {
        return std::unexpected(Err::failed);
    }
    const uint8_t cmd[] = {0x81, level};
    return commands(cmd);
}

hal::Selftest Ssd1306I2c::selftest()
{
    if (!ready_) {
        return {false, "not initialized (no ACK, or the init was refused)"};
    }
    const auto bus = platform::i2c_bus(cfg_.sda, cfg_.scl);
    const bool ack = bus && i2c_master_probe(*bus, cfg_.address, kTimeoutMs) == ESP_OK;
    snprintf(detail_, sizeof(detail_), "%s at 0x%02X, init accepted, %ux%u, %" PRIu32 " flush errors",
             ack ? "ACK" : "no ACK", cfg_.address, unsigned{cfg_.width}, unsigned{cfg_.height}, flush_errors_);
    return {ack, detail_};
}

}  // namespace fr::drv
