// Host shim (firmware/test/host/shim/esp_sim.hpp): esp_log.h. Lines are counted (esp_sim::logs) and printed only
// with FR_SIM_LOG set.
#pragma once

[[gnu::format(printf, 3, 4)]] void esp_sim_log(char level, const char *tag, const char *fmt, ...);

#define ESP_LOGE(tag, fmt, ...) esp_sim_log('E', tag, fmt __VA_OPT__(, ) __VA_ARGS__)
#define ESP_LOGW(tag, fmt, ...) esp_sim_log('W', tag, fmt __VA_OPT__(, ) __VA_ARGS__)
#define ESP_LOGI(tag, fmt, ...) esp_sim_log('I', tag, fmt __VA_OPT__(, ) __VA_ARGS__)
#define ESP_LOGD(tag, fmt, ...) esp_sim_log('D', tag, fmt __VA_OPT__(, ) __VA_ARGS__)
