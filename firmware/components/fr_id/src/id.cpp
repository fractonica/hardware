#include "fr/id.h"

#include <cstdio>
#include <cstring>

#include "esp_log.h"
#include "esp_mac.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "sdkconfig.h"

namespace {

constexpr const char *TAG = "fr_id";
constexpr const char *PARTITION = "fr_ident";
constexpr const char *NAMESPACE = "fr_id";

void read_identity(nvs_handle_t h, fr_identity_t *id)
{
    nvs_get_u16(h, "addr", &id->addr);
    nvs_get_u16(h, "net", &id->net);
    nvs_get_u32(h, "alias_rev", &id->alias_rev);
    nvs_get_u16(h, "epoch_floor", &id->epoch_floor);
    size_t len = sizeof(id->alias);
    nvs_get_str(h, "alias", id->alias, &len);
}

}  // namespace

extern "C" esp_err_t fr_id_get_mac(uint8_t out[6])
{
    return esp_read_mac(out, ESP_MAC_EFUSE_FACTORY);
}

extern "C" const char *fr_id_state_name(fr_id_state_t state)
{
    switch (state) {
    case FR_ID_PROVISIONED:
        return "PROVISIONED";
    case FR_ID_MISBOUND:
        return "MISBOUND";
    default:
        return "UNASSIGNED";
    }
}

extern "C" esp_err_t fr_id_load(fr_identity_t *id)
{
    memset(id, 0, sizeof(*id));
    esp_err_t err = fr_id_get_mac(id->mac);
    if (err != ESP_OK) {
        return err;
    }
    snprintf(id->device_id, sizeof(id->device_id), "%02x%02x%02x%02x%02x%02x", id->mac[0], id->mac[1],
             id->mac[2], id->mac[3], id->mac[4], id->mac[5]);
    snprintf(id->board, sizeof(id->board), "%s", CONFIG_FR_BOARD);
    snprintf(id->profile, sizeof(id->profile), "%s", CONFIG_FR_PROFILE);
    snprintf(id->alias, sizeof(id->alias), "new-%s", id->device_id + 6);
    id->state = FR_ID_UNASSIGNED;
    id->addr = FR_ADDR_UNASSIGNED;

    err = nvs_flash_init_partition(PARTITION);
    if (err != ESP_OK) {
        ESP_LOGI(TAG, "no identity partition data (%s)", esp_err_to_name(err));
        return ESP_OK;
    }
    nvs_handle_t h;
    err = nvs_open_from_partition(PARTITION, NAMESPACE, NVS_READONLY, &h);
    if (err != ESP_OK) {
        ESP_LOGI(TAG, "no identity (%s)", esp_err_to_name(err));
        return ESP_OK;
    }
    uint8_t stored_mac[6];
    size_t len = sizeof(stored_mac);
    if (nvs_get_blob(h, "mac", stored_mac, &len) != ESP_OK || len != sizeof(stored_mac) ||
        memcmp(stored_mac, id->mac, sizeof(stored_mac)) != 0) {
        ESP_LOGW(TAG, "identity belongs to another device");
        id->state = FR_ID_MISBOUND;
        nvs_close(h);
        return ESP_OK;
    }
    read_identity(h, id);
    nvs_close(h);
    id->state = FR_ID_PROVISIONED;
    return ESP_OK;
}
