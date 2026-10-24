// Host shim (firmware/test/host/shim/esp_sim.hpp): driver/rmt_rx.h. esp_sim::rmt_deliver() completes an armed
// receive: the symbols land in its buffer and on_recv_done runs as the RMT ISR would.
#pragma once

#include <cstddef>
#include <cstdint>

#include "driver/gpio.h"
#include "esp_err.h"

struct rmt_channel_t;
typedef struct rmt_channel_t *rmt_channel_handle_t;

typedef enum { RMT_CLK_SRC_DEFAULT = 4 } rmt_clock_source_t;

typedef struct {
    gpio_num_t gpio_num;
    rmt_clock_source_t clk_src;
    uint32_t resolution_hz;
    size_t mem_block_symbols;
    int intr_priority;
} rmt_rx_channel_config_t;

typedef struct {
    uint32_t signal_range_min_ns;
    uint32_t signal_range_max_ns;
} rmt_receive_config_t;

typedef struct {
    void *received_symbols;
    size_t num_symbols;
} rmt_rx_done_event_data_t;

typedef bool (*rmt_rx_done_callback_t)(rmt_channel_handle_t rx_chan, const rmt_rx_done_event_data_t *edata,
                                       void *user_ctx);

typedef struct {
    rmt_rx_done_callback_t on_recv_done;
} rmt_rx_event_callbacks_t;

esp_err_t rmt_new_rx_channel(const rmt_rx_channel_config_t *config, rmt_channel_handle_t *ret_chan);
esp_err_t rmt_rx_register_event_callbacks(rmt_channel_handle_t rx_channel, const rmt_rx_event_callbacks_t *cbs,
                                          void *user_data);
esp_err_t rmt_enable(rmt_channel_handle_t channel);
esp_err_t rmt_receive(rmt_channel_handle_t rx_channel, void *buffer, size_t buffer_size,
                      const rmt_receive_config_t *config);
