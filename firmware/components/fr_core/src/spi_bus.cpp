// The shared SPI master buses (fr/platform/spi_bus.hpp, design lcd-clock-c1 D3).
#include "fr/platform/spi_bus.hpp"

#include <algorithm>
#include <array>
#include <iterator>
#include <mutex>

#include "esp_err.h"
#include "esp_log.h"
#include "soc/soc_caps.h"

namespace fr::platform {
namespace {

constexpr const char *TAG = "fr_spi";

struct Bus {
    bool up = false;
    SpiBusPins pins{};
};

std::mutex s_mutex;
std::array<Bus, SOC_SPI_PERIPH_NUM> s_buses{};

}  // namespace

Status spi_bus(spi_host_device_t host, const SpiBusPins &pins, int max_transfer)
{
    if (static_cast<size_t>(host) >= s_buses.size()) {
        return std::unexpected(Err::invalid_args);
    }
    std::lock_guard<std::mutex> lock(s_mutex);
    Bus &b = s_buses[host];
    if (b.up) {
        const bool same = b.pins.sclk == pins.sclk && b.pins.mosi == pins.mosi && (pins.miso < 0 || pins.miso == b.pins.miso);
        if (!same) {
            ESP_LOGE(TAG, "host %d: SCLK %d / MOSI %d / MISO %d does not match the bus's SCLK %d / MOSI %d / MISO %d",
                     static_cast<int>(host), pins.sclk, pins.mosi, pins.miso, b.pins.sclk, b.pins.mosi, b.pins.miso);
            return std::unexpected(Err::busy);
        }
        return {};
    }
    spi_bus_config_t cfg = {};
    std::fill(std::begin(cfg.iocfg), std::end(cfg.iocfg), -1);
    cfg.sclk_io_num = pins.sclk;
    cfg.mosi_io_num = pins.mosi;
    cfg.miso_io_num = pins.miso;
    cfg.max_transfer_sz = std::max(max_transfer, 4096);
    const esp_err_t err = spi_bus_initialize(host, &cfg, SPI_DMA_CH_AUTO);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "spi_bus_initialize host %d: %s", static_cast<int>(host), esp_err_to_name(err));
        return std::unexpected(Err::failed);
    }
    b.up = true;
    b.pins = pins;
    return {};
}

#if FR_HOST_SHIM
void spi_bus_host_reset()
{
    std::lock_guard<std::mutex> lock(s_mutex);
    s_buses = {};
}
#endif

}  // namespace fr::platform
