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
constexpr const char *BOOT_NAMESPACE = "fr_boot";  // RW, default `nvs` partition (06 §6.3)
constexpr const char *EPOCH_KEY = "epoch";

/** The newer of two u16 epochs in RFC 1982 serial order; `a` when they are exactly half apart. */
constexpr uint16_t serial_max(uint16_t a, uint16_t b)
{
    return static_cast<int16_t>(static_cast<uint16_t>(b - a)) > 0 ? b : a;
}

/**
 * This boot's epoch: max(stored, floor) + 1. A missing stored epoch (fresh or erased NVS) takes no part
 * in the max: as 0 it would beat any floor in [32768, 65535] in serial order and regress the epoch.
 */
constexpr uint16_t next_epoch(bool have_stored, uint16_t stored, uint16_t floor)
{
    return static_cast<uint16_t>((have_stored ? serial_max(stored, floor) : floor) + 1);
}

static_assert(next_epoch(false, 0, 0) == 1);
static_assert(next_epoch(false, 0, 32768) == 32769);
static_assert(next_epoch(true, 7, 3) == 8);
static_assert(next_epoch(true, 3, 7) == 8);
static_assert(next_epoch(true, 65535, 2) == 3);  // 2 is newer than 65535 in serial order
static_assert(next_epoch(true, 40000, 20000) == 40001);

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

extern "C" esp_err_t fr_id_commit_boot_epoch(fr_identity_t *id)
{
    nvs_handle_t h;
    esp_err_t err = nvs_open(BOOT_NAMESPACE, NVS_READWRITE, &h);
    uint16_t stored = 0;
    bool have_stored = false;
    if (err == ESP_OK) {
        esp_err_t get = nvs_get_u16(h, EPOCH_KEY, &stored);
        // Anything but a clean read (missing key, wrong type) counts as no stored epoch.
        have_stored = get == ESP_OK;
        if (get != ESP_OK && get != ESP_ERR_NVS_NOT_FOUND) {
            ESP_LOGW(TAG, "stored epoch unreadable (%s)", esp_err_to_name(get));
        }
    }
    uint16_t epoch = next_epoch(have_stored, stored, id->epoch_floor);
    if (err == ESP_OK) {
        err = nvs_set_u16(h, EPOCH_KEY, epoch);
        if (err == ESP_OK) {
            err = nvs_commit(h);
        }
        nvs_close(h);
    }
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "boot epoch %u not committed (%s)", epoch, esp_err_to_name(err));
    }
    id->epoch = epoch;
    return err;
}
