// Host shim (firmware/test/host/shim/wifi_sim.hpp): lwIP's esp_ping API as IDF v6.1 declares it
// (components/lwip/include/apps/ping/ping_sock.h): the session config, callbacks and calls wifi_csi uses.
#pragma once

#include <stdint.h>

#include "esp_err.h"
#include "lwip/ip_addr.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef void *esp_ping_handle_t;

typedef struct {
    void *cb_args;
    void (*on_ping_success)(esp_ping_handle_t hdl, void *args);
    void (*on_ping_timeout)(esp_ping_handle_t hdl, void *args);
    void (*on_ping_end)(esp_ping_handle_t hdl, void *args);
} esp_ping_callbacks_t;

typedef struct {
    uint32_t count;
    uint32_t interval_ms;
    uint32_t timeout_ms;
    uint32_t data_size;
    int tos;
    int ttl;
    ip_addr_t target_addr;
    uint32_t task_stack_size;
    uint32_t task_prio;
    uint32_t interface;
} esp_ping_config_t;

#define ESP_PING_DEFAULT_CONFIG()        \
    {                                    \
        .count = 5,                      \
        .interval_ms = 1000,             \
        .timeout_ms = 1000,              \
        .data_size = 64,                 \
        .tos = 0,                        \
        .ttl = IP_DEFAULT_TTL,           \
        .target_addr = *(IP_ANY_TYPE),   \
        .task_stack_size = ESP_TASK_PING_STACK,         \
        .task_prio = 2,                  \
        .interface = 0,\
    }

#define ESP_PING_COUNT_INFINITE (0)

esp_err_t esp_ping_new_session(const esp_ping_config_t *config, const esp_ping_callbacks_t *cbs, esp_ping_handle_t *hdl_out);
esp_err_t esp_ping_delete_session(esp_ping_handle_t hdl);
esp_err_t esp_ping_start(esp_ping_handle_t hdl);
esp_err_t esp_ping_stop(esp_ping_handle_t hdl);

#ifdef __cplusplus
}
#endif
