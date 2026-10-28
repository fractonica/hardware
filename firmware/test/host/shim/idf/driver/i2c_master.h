// Host shim (firmware/test/host/shim/panel_sim.hpp): driver/i2c_master.h, the IDF v6.1 calls fr_core's shared I2C buses
// and the ssd1306_i2c / cst816_i2c drivers make (design m2-c5-display D4, D8). Devices are panel_sim's fakes.
#pragma once

#include <cstddef>
#include <cstdint>

#include "driver/gpio.h"
#include "esp_err.h"

typedef int i2c_port_num_t;
typedef enum { I2C_CLK_SRC_DEFAULT = 0 } i2c_clock_source_t;
typedef enum { I2C_ADDR_BIT_LEN_7 = 0, I2C_ADDR_BIT_LEN_10 = 1 } i2c_addr_bit_len_t;

typedef struct {
    i2c_port_num_t i2c_port;
    gpio_num_t sda_io_num;
    gpio_num_t scl_io_num;
    i2c_clock_source_t clk_source;
    uint8_t glitch_ignore_cnt;
    int intr_priority;
    size_t trans_queue_depth;
    struct {
        uint32_t enable_internal_pullup : 1;
        uint32_t allow_pd : 1;
    } flags;
} i2c_master_bus_config_t;

typedef struct {
    i2c_addr_bit_len_t dev_addr_length;
    uint16_t device_address;
    uint32_t scl_speed_hz;
    uint32_t scl_wait_us;
    struct {
        uint32_t disable_ack_check : 1;
    } flags;
} i2c_device_config_t;

typedef struct i2c_master_bus_t *i2c_master_bus_handle_t;
typedef struct i2c_master_dev_t *i2c_master_dev_handle_t;

esp_err_t i2c_new_master_bus(const i2c_master_bus_config_t *bus_config, i2c_master_bus_handle_t *ret_bus_handle);
esp_err_t i2c_master_bus_add_device(i2c_master_bus_handle_t bus_handle, const i2c_device_config_t *dev_config,
                                    i2c_master_dev_handle_t *ret_handle);
esp_err_t i2c_master_transmit(i2c_master_dev_handle_t i2c_dev, const uint8_t *write_buffer, size_t write_size,
                              int xfer_timeout_ms);
esp_err_t i2c_master_transmit_receive(i2c_master_dev_handle_t i2c_dev, const uint8_t *write_buffer, size_t write_size,
                                      uint8_t *read_buffer, size_t read_size, int xfer_timeout_ms);
esp_err_t i2c_master_probe(i2c_master_bus_handle_t bus_handle, uint16_t address, int xfer_timeout_ms);
