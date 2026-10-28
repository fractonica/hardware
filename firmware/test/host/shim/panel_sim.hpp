// The host suite's I2C and SPI shim (design m2-c5-display D4, D7, D8): the test side of idf/driver/i2c_master.h and
// idf/driver/spi_master.h. The suite builds hardware/drivers/{ssd1306_i2c,st7789_spi,cst816_i2c} and fr_core's
// src/i2c_bus.cpp unchanged against idf/ (FR_HOST_SHIM), so their tests check the bytes the drivers send. GPIO, LEDC and
// esp_timer are esp_sim's (esp_sim.hpp).
#pragma once

#include <cstdint>
#include <span>
#include <vector>

namespace esp_sim {

// ---- I2C ----
/** One I2C device on any bus: absent devices NACK. Reads (transmit_receive) answer regs[first written byte...]. */
void i2c_attach(uint8_t address);
void i2c_detach(uint8_t address);
void i2c_set_regs(uint8_t address, uint8_t reg, std::span<const uint8_t> bytes);
/** Every write to `address` (transmit, and the register byte of transmit_receive), in order. */
const std::vector<std::vector<uint8_t>> &i2c_writes(uint8_t address);
/** Buses i2c_new_master_bus created (they are never freed: fr_core's table keeps their handles across tests). */
int i2c_buses();
/** The scl_speed_hz `address` was added with (0: never). */
uint32_t i2c_speed_hz(uint8_t address);
/** Forgets every device and write; buses stay. */
void i2c_reset();

// ---- SPI ----
struct SpiTx {
    bool dc;  // the level of the watched DC pin when the transaction went out
    std::vector<uint8_t> bytes;
};
/** The pin whose level each transaction records. */
void spi_watch_dc(int gpio);
const std::vector<SpiTx> &spi_log();
/** spi_bus_initialize / spi_bus_add_device answers as configured: the bus, the device's clock, mode and CS. */
bool spi_bus_up();
int spi_clock_hz();
int spi_cs();
int spi_mosi();
int spi_sclk();
/** The GPIOs driving high (output enabled, output register 1) when spi_bus_initialize ran, bit n = GPIOn. */
uint64_t spi_high_at_bus_init();
/** Every SPI state back to nothing (the bus is down again). */
void spi_reset();

// ---- FreeRTOS ----
/** vTaskDelay's total since the last reset, in ms (ticks at 1 kHz). */
uint32_t task_delay_ms();
void task_delay_reset();

}  // namespace esp_sim

namespace fr::drv {
// The drivers' static RAM as a fresh boot finds it (FR_HOST_SHIM builds define it): st7789_spi's LEDC allocation.
void st7789_spi_host_reset();
}  // namespace fr::drv
