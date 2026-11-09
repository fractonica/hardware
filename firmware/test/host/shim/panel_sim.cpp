// The host suite's I2C and SPI shim (panel_sim.hpp): the idf/ functions the panel and touch drivers call.
#include "panel_sim.hpp"

#include "fr/platform/spi_bus.hpp"

#include <array>
#include <cstring>
#include <deque>
#include <map>
#include <memory>

#include "driver/gpio.h"
#include "driver/i2c_master.h"
#include "driver/spi_master.h"
#include "esp_err.h"
#include "esp_sim.hpp"
#include "freertos/task.h"

struct i2c_master_bus_t {
    int sda = -1;
    int scl = -1;
};

struct i2c_master_dev_t {
    i2c_master_bus_t *bus = nullptr;
    uint8_t address = 0;
};

struct spi_device_t {
    std::deque<spi_transaction_t *> done;
};

namespace esp_sim {
namespace {

struct I2cDevice {
    bool present = false;
    std::array<uint8_t, 256> regs{};
    std::vector<std::vector<uint8_t>> writes;
    uint32_t speed_hz = 0;
};

struct PanelSim {
    std::vector<std::unique_ptr<i2c_master_bus_t>> buses;
    std::vector<std::unique_ptr<i2c_master_dev_t>> devs;
    std::map<uint8_t, I2cDevice> i2c;
    int dc = -1;
    std::vector<SpiTx> spi;
    bool bus_up = false;
    int mosi = -1, sclk = -1, cs = -1, clock_hz = 0;
    uint64_t high_at_bus_init = 0;
    std::vector<std::unique_ptr<spi_device_t>> spi_devs;
    uint32_t delay_ms = 0;
};

PanelSim &ps()
{
    static PanelSim s;
    return s;
}

void record_spi(const spi_transaction_t *t)
{
    const size_t n = t->length / 8;
    const auto *p = (t->flags & SPI_TRANS_USE_TXDATA) != 0 ? t->tx_data : static_cast<const uint8_t *>(t->tx_buffer);
    ps().spi.push_back({ps().dc >= 0 && esp_sim::out(ps().dc), {p, p + n}});
}

}  // namespace

void i2c_attach(uint8_t address)
{
    ps().i2c[address].present = true;
}

void i2c_detach(uint8_t address)
{
    ps().i2c[address].present = false;
}

void i2c_set_regs(uint8_t address, uint8_t reg, std::span<const uint8_t> bytes)
{
    auto &d = ps().i2c[address];
    for (size_t i = 0; i < bytes.size() && reg + i < d.regs.size(); ++i) {
        d.regs[reg + i] = bytes[i];
    }
}

const std::vector<std::vector<uint8_t>> &i2c_writes(uint8_t address)
{
    return ps().i2c[address].writes;
}

int i2c_buses()
{
    return static_cast<int>(ps().buses.size());
}

uint32_t i2c_speed_hz(uint8_t address)
{
    return ps().i2c[address].speed_hz;
}

void i2c_reset()
{
    ps().i2c.clear();
}

void spi_watch_dc(int gpio)
{
    ps().dc = gpio;
}

const std::vector<SpiTx> &spi_log()
{
    return ps().spi;
}

bool spi_bus_up()
{
    return ps().bus_up;
}

int spi_clock_hz()
{
    return ps().clock_hz;
}

int spi_cs()
{
    return ps().cs;
}

int spi_mosi()
{
    return ps().mosi;
}

int spi_sclk()
{
    return ps().sclk;
}

uint64_t spi_high_at_bus_init()
{
    return ps().high_at_bus_init;
}

void spi_reset()
{
    fr::platform::spi_bus_host_reset();
    PanelSim &s = ps();
    s.spi.clear();
    s.bus_up = false;
    s.mosi = s.sclk = s.cs = -1;
    s.clock_hz = 0;
    s.dc = -1;
    s.high_at_bus_init = 0;
}

uint32_t task_delay_ms()
{
    return ps().delay_ms;
}

void task_delay_reset()
{
    ps().delay_ms = 0;
}

}  // namespace esp_sim

using esp_sim::ps;

const char *esp_err_to_name(int code)
{
    switch (code) {
    case ESP_OK:
        return "ESP_OK";
    case ESP_ERR_INVALID_ARG:
        return "ESP_ERR_INVALID_ARG";
    case ESP_ERR_INVALID_STATE:
        return "ESP_ERR_INVALID_STATE";
    default:
        return "ESP_FAIL";
    }
}

void vTaskDelay(TickType_t ticks)
{
    ps().delay_ms += ticks;
}

esp_err_t i2c_new_master_bus(const i2c_master_bus_config_t *cfg, i2c_master_bus_handle_t *ret)
{
    if (cfg == nullptr || ret == nullptr || !GPIO_IS_VALID_GPIO(cfg->sda_io_num) || !GPIO_IS_VALID_GPIO(cfg->scl_io_num)) {
        return ESP_ERR_INVALID_ARG;
    }
    if (ps().buses.size() == 2) {
        return ESP_ERR_NOT_FOUND;
    }
    ps().buses.push_back(std::make_unique<i2c_master_bus_t>(i2c_master_bus_t{cfg->sda_io_num, cfg->scl_io_num}));
    *ret = ps().buses.back().get();
    return ESP_OK;
}

esp_err_t i2c_master_bus_add_device(i2c_master_bus_handle_t bus, const i2c_device_config_t *cfg,
                                    i2c_master_dev_handle_t *ret)
{
    if (bus == nullptr || cfg == nullptr || ret == nullptr || cfg->device_address > 0x7F) {
        return ESP_ERR_INVALID_ARG;
    }
    ps().devs.push_back(
        std::make_unique<i2c_master_dev_t>(i2c_master_dev_t{bus, static_cast<uint8_t>(cfg->device_address)}));
    ps().i2c[static_cast<uint8_t>(cfg->device_address)].speed_hz = cfg->scl_speed_hz;
    *ret = ps().devs.back().get();
    return ESP_OK;
}

esp_err_t i2c_master_transmit(i2c_master_dev_handle_t dev, const uint8_t *buf, size_t n, int)
{
    auto &d = ps().i2c[dev->address];
    if (!d.present) {
        return ESP_FAIL;  // NACK
    }
    d.writes.emplace_back(buf, buf + n);
    return ESP_OK;
}

esp_err_t i2c_master_transmit_receive(i2c_master_dev_handle_t dev, const uint8_t *wbuf, size_t wn, uint8_t *rbuf,
                                      size_t rn, int)
{
    auto &d = ps().i2c[dev->address];
    if (!d.present) {
        return ESP_FAIL;
    }
    d.writes.emplace_back(wbuf, wbuf + wn);
    const uint8_t reg = wn > 0 ? wbuf[0] : 0;
    for (size_t i = 0; i < rn; ++i) {
        rbuf[i] = d.regs[(reg + i) & 0xFF];
    }
    return ESP_OK;
}

esp_err_t i2c_master_probe(i2c_master_bus_handle_t, uint16_t address, int)
{
    return address <= 0x7F && ps().i2c[static_cast<uint8_t>(address)].present ? ESP_OK : ESP_FAIL;
}

esp_err_t spi_bus_initialize(spi_host_device_t, const spi_bus_config_t *cfg, spi_dma_chan_t)
{
    if (ps().bus_up) {
        return ESP_ERR_INVALID_STATE;
    }
    ps().bus_up = true;
    ps().high_at_bus_init = 0;
    for (int pin = 0; pin < GPIO_NUM_MAX; ++pin) {
        if (GPIO_IS_VALID_GPIO(pin) && esp_sim::output_enabled(pin) && esp_sim::out(pin)) {
            ps().high_at_bus_init |= 1ULL << pin;
        }
    }
    ps().mosi = cfg->mosi_io_num;
    ps().sclk = cfg->sclk_io_num;
    return ESP_OK;
}

esp_err_t spi_bus_add_device(spi_host_device_t, const spi_device_interface_config_t *cfg, spi_device_handle_t *handle)
{
    if (!ps().bus_up) {
        return ESP_ERR_INVALID_STATE;
    }
    ps().cs = cfg->spics_io_num;
    ps().clock_hz = cfg->clock_speed_hz;
    ps().spi_devs.push_back(std::make_unique<spi_device_t>());
    *handle = ps().spi_devs.back().get();
    return ESP_OK;
}

esp_err_t spi_device_polling_transmit(spi_device_handle_t handle, spi_transaction_t *t)
{
    if (handle == nullptr || !handle->done.empty()) {
        return ESP_ERR_INVALID_STATE;  // IDF: no polling transaction while queued ones are in flight
    }
    esp_sim::record_spi(t);
    return ESP_OK;
}

esp_err_t spi_device_queue_trans(spi_device_handle_t handle, spi_transaction_t *t, uint32_t)
{
    if (handle == nullptr || t->length / 8 > 4096) {
        return ESP_ERR_INVALID_ARG;
    }
    esp_sim::record_spi(t);
    handle->done.push_back(t);
    return ESP_OK;
}

esp_err_t spi_device_get_trans_result(spi_device_handle_t handle, spi_transaction_t **t, uint32_t)
{
    if (handle == nullptr || handle->done.empty()) {
        return ESP_ERR_TIMEOUT;
    }
    *t = handle->done.front();
    handle->done.pop_front();
    return ESP_OK;
}
