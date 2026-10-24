// Host shim (firmware/test/host/shim/esp_sim.hpp): esp_timer.h, on FakeCore's clock. A timer is a FakeCore timer
// that runs its callback as an ISR would (ESP_TIMER_ISR): GPIO edges it makes reach their ISR after it returns.
// start_once_at and stop answer as IDF v6.1's do (esp_timer.c): ESP_ERR_INVALID_STATE for a timer already armed (or
// not armed), ESP_ERR_INVALID_ARG for an alarm more than the minimum period in the past.
#pragma once

#include <cstdint>

#include "esp_err.h"

struct esp_timer;
typedef struct esp_timer *esp_timer_handle_t;
typedef void (*esp_timer_cb_t)(void *arg);

typedef enum {
    ESP_TIMER_TASK,
    ESP_TIMER_ISR,
} esp_timer_dispatch_t;

typedef struct {
    esp_timer_cb_t callback;
    void *arg;
    esp_timer_dispatch_t dispatch_method;
    const char *name;
    bool skip_unhandled_events;
} esp_timer_create_args_t;

esp_err_t esp_timer_create(const esp_timer_create_args_t *args, esp_timer_handle_t *out_handle);
esp_err_t esp_timer_start_once_at(esp_timer_handle_t timer, uint64_t alarm_us);
esp_err_t esp_timer_stop(esp_timer_handle_t timer);
int64_t esp_timer_get_time(void);
