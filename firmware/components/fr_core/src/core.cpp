#include "fr/core.hpp"

#include <cinttypes>
#include <cstdio>

#include "esp_app_desc.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_partition.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdkconfig.h"

namespace fr::core {
namespace {

constexpr const char *TAG = "fr";
constexpr uint32_t ALIVE_PERIOD_MS = 10000;

fr_identity_t s_identity;
char s_fw_id[13] = "unknown";

const char *reset_reason_name(esp_reset_reason_t r)
{
    switch (r) {
    case ESP_RST_POWERON:
        return "POWERON";
    case ESP_RST_EXT:
        return "EXT";
    case ESP_RST_SW:
        return "SW";
    case ESP_RST_PANIC:
        return "PANIC";
    case ESP_RST_INT_WDT:
        return "INT_WDT";
    case ESP_RST_TASK_WDT:
        return "TASK_WDT";
    case ESP_RST_WDT:
        return "WDT";
    case ESP_RST_DEEPSLEEP:
        return "DEEPSLEEP";
    case ESP_RST_BROWNOUT:
        return "BROWNOUT";
    case ESP_RST_USB:
        return "USB";
    case ESP_RST_JTAG:
        return "JTAG";
    default:
        return "OTHER";
    }
}

void load_fw_id()
{
    const esp_partition_t *running = esp_ota_get_running_partition();
    uint8_t sha[32];
    if (running && esp_partition_get_sha256(running, sha) == ESP_OK) {
        snprintf(s_fw_id, sizeof(s_fw_id), "%02x%02x%02x%02x%02x%02x", sha[0], sha[1], sha[2], sha[3], sha[4],
                 sha[5]);
    }
}

void alive_task(void *)
{
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(ALIVE_PERIOD_MS));
        ESP_LOGI(TAG, "alive id=%s uptime_s=%" PRId64 " heap=%" PRIu32, s_identity.device_id,
                 esp_timer_get_time() / 1000000, (uint32_t)esp_get_free_heap_size());
    }
}

}  // namespace

void boot()
{
    fr_id_load(&s_identity);
    load_fw_id();
    const esp_app_desc_t *app = esp_app_get_description();
    const esp_partition_t *running = esp_ota_get_running_partition();
    // The banner is the C1 contract with the hub and agents: `fr wait log "fr: ready id=<id>"`.
    ESP_LOGI(TAG, "ready id=%s fw=%s state=%s addr=%04x alias=%s board=%s profile=%s part=%s app=%s ver=%s idf=%s reset=%s slot=%s",
             s_identity.device_id, s_fw_id, fr_id_state_name(s_identity.state), s_identity.addr, s_identity.alias,
             s_identity.board, s_identity.profile, CONFIG_FR_PART_PROFILE, app->project_name, app->version,
             app->idf_ver, reset_reason_name(esp_reset_reason()), running ? running->label : "?");
    xTaskCreate(alive_task, "fr_alive", 3072, nullptr, 2, nullptr);
}

const fr_identity_t &identity()
{
    return s_identity;
}

const char *fw_id()
{
    return s_fw_id;
}

}  // namespace fr::core
