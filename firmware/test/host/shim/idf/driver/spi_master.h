// Host shim (firmware/test/host/shim/panel_sim.hpp): driver/spi_master.h, the IDF v6.1 calls st7789_spi makes (design
// m2-c5-display D7). Every transaction is recorded with the DC pin's level as it went out; queued ones complete at once.
#pragma once

#include <cstddef>
#include <cstdint>

#include "esp_err.h"

typedef enum { SPI1_HOST = 0, SPI2_HOST = 1, SPI3_HOST = 2 } spi_host_device_t;
typedef enum { SPI_DMA_DISABLED = 0, SPI_DMA_CH_AUTO = 3 } spi_dma_chan_t;

typedef struct {
    union {
        struct {
            int mosi_io_num;
            int miso_io_num;
            int sclk_io_num;
            int quadwp_io_num;
            int quadhd_io_num;
            int data4_io_num;
            int data5_io_num;
            int data6_io_num;
            int data7_io_num;
        };
        int iocfg[9];
    };
    bool data_io_default_level;
    int max_transfer_sz;
    uint32_t dma_burst_size;
    uint32_t flags;
    int isr_cpu_id;
    int intr_flags;
} spi_bus_config_t;

typedef struct spi_transaction_t spi_transaction_t;
typedef void (*transaction_cb_t)(spi_transaction_t *trans);

typedef struct {
    uint8_t command_bits;
    uint8_t address_bits;
    uint8_t dummy_bits;
    uint8_t mode;
    int clock_source;
    uint16_t duty_cycle_pos;
    uint16_t cs_ena_pretrans;
    uint8_t cs_ena_posttrans;
    int clock_speed_hz;
    int input_delay_ns;
    int sample_point;
    int spics_io_num;
    uint32_t flags;
    int queue_size;
    transaction_cb_t pre_cb;
    transaction_cb_t post_cb;
} spi_device_interface_config_t;

#define SPI_TRANS_USE_TXDATA (1 << 3)

struct spi_transaction_t {
    uint32_t flags;
    uint16_t cmd;
    uint64_t addr;
    size_t length;
    size_t rxlength;
    uint32_t override_freq_hz;
    void *user;
    union {
        const void *tx_buffer;
        uint8_t tx_data[4];
    };
    union {
        void *rx_buffer;
        uint8_t rx_data[4];
    };
};

typedef struct spi_device_t *spi_device_handle_t;

esp_err_t spi_bus_initialize(spi_host_device_t host_id, const spi_bus_config_t *bus_config, spi_dma_chan_t dma_chan);
esp_err_t spi_bus_add_device(spi_host_device_t host_id, const spi_device_interface_config_t *dev_config,
                             spi_device_handle_t *handle);
esp_err_t spi_device_polling_transmit(spi_device_handle_t handle, spi_transaction_t *trans_desc);
esp_err_t spi_device_queue_trans(spi_device_handle_t handle, spi_transaction_t *trans_desc, uint32_t ticks_to_wait);
esp_err_t spi_device_get_trans_result(spi_device_handle_t handle, spi_transaction_t **trans_desc,
                                      uint32_t ticks_to_wait);
