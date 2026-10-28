// The shared I2C master buses (fr/platform/i2c_bus.hpp, design m2-c5-display D4, D8).
#include "fr/platform/i2c_bus.hpp"

#include <array>
#include <mutex>

#include "esp_err.h"
#include "esp_log.h"
#include "soc/soc_caps.h"

namespace fr::platform {
namespace {

constexpr const char *TAG = "fr_i2c";

struct Bus {
    int sda = -1;
    int scl = -1;
    i2c_master_bus_handle_t handle = nullptr;
};

// Board init runs on the app task, later users may run elsewhere: the table is locked.
std::mutex s_mutex;
std::array<Bus, SOC_I2C_NUM> s_buses{};

}  // namespace

std::expected<i2c_master_bus_handle_t, Err> i2c_bus(int sda, int scl)
{
    std::lock_guard<std::mutex> lock(s_mutex);
    Bus *free_slot = nullptr;
    for (Bus &b : s_buses) {
        if (b.handle == nullptr) {
            free_slot = free_slot != nullptr ? free_slot : &b;
            continue;
        }
        if (b.sda == sda && b.scl == scl) {
            return b.handle;
        }
        if (b.sda == sda || b.scl == scl || b.sda == scl || b.scl == sda) {
            ESP_LOGE(TAG, "SDA %d / SCL %d: a pin of the bus on SDA %d / SCL %d", sda, scl, b.sda, b.scl);
            return std::unexpected(Err::busy);
        }
    }
    if (free_slot == nullptr) {
        ESP_LOGE(TAG, "SDA %d / SCL %d: no free I2C port", sda, scl);
        return std::unexpected(Err::failed);
    }
    i2c_master_bus_config_t cfg = {};
    cfg.i2c_port = -1;  // the first free port
    cfg.sda_io_num = static_cast<gpio_num_t>(sda);
    cfg.scl_io_num = static_cast<gpio_num_t>(scl);
    cfg.clk_source = I2C_CLK_SRC_DEFAULT;
    cfg.glitch_ignore_cnt = 7;
    cfg.flags.enable_internal_pullup = true;
    i2c_master_bus_handle_t h = nullptr;
    const esp_err_t err = i2c_new_master_bus(&cfg, &h);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "i2c_new_master_bus SDA %d / SCL %d: %s", sda, scl, esp_err_to_name(err));
        return std::unexpected(Err::failed);
    }
    *free_slot = {sda, scl, h};
    return h;
}

std::expected<i2c_master_dev_handle_t, Err> i2c_device(int sda, int scl, uint8_t address, uint32_t khz)
{
    const auto bus = i2c_bus(sda, scl);
    if (!bus) {
        return std::unexpected(bus.error());
    }
    i2c_device_config_t dev = {};
    dev.dev_addr_length = I2C_ADDR_BIT_LEN_7;
    dev.device_address = address;
    dev.scl_speed_hz = khz * 1000;
    i2c_master_dev_handle_t h = nullptr;
    const esp_err_t err = i2c_master_bus_add_device(*bus, &dev, &h);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "device 0x%02X on SDA %d / SCL %d: %s", address, sda, scl, esp_err_to_name(err));
        return std::unexpected(Err::failed);
    }
    return h;
}

}  // namespace fr::platform
