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
constexpr const char *NET_NAMESPACE = "fr_net";       // fr_ident: Wi-Fi and hub (06 §6.3)
constexpr const char *BOOT_NAMESPACE = "fr_boot";     // RW, default `nvs` partition (06 §6.3)
constexpr const char *OVR_NAMESPACE = "fr_ovr";       // RW: alias + rev from fr.node.set_alias
constexpr const char *NET2_NAMESPACE = "fr_net2";     // RW: Wi-Fi from fr.node.net_set
constexpr const char *LINK_NAMESPACE = "fr_link";     // RW: channel + BSSID of the last association
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

/** A string key into `out` (NUL-terminated); false when absent or longer than `out` holds. */
template <size_t N>
bool read_str(nvs_handle_t h, const char *key, char (&out)[N])
{
    size_t len = N;
    if (nvs_get_str(h, key, out, &len) != ESP_OK) {
        out[0] = '\0';
        return false;
    }
    return true;
}

/** A 6-byte blob key (a MAC or BSSID); false when absent or of another length. */
bool read_mac(nvs_handle_t h, const char *key, uint8_t (&out)[6])
{
    uint8_t buf[6];
    size_t len = sizeof(buf);
    if (nvs_get_blob(h, key, buf, &len) != ESP_OK || len != sizeof(buf)) {
        return false;
    }
    std::memcpy(out, buf, sizeof(buf));
    return true;
}

/**
 * The fr_ovr alias wins over fr_ident's when its rev is higher (06 §6.3). A device without a valid
 * fr_ident has no registry alias of its own here, so a stored override always applies to it.
 */
void apply_alias_override(fr_identity_t *id)
{
    nvs_handle_t h;
    if (nvs_open(OVR_NAMESPACE, NVS_READONLY, &h) != ESP_OK) {
        return;  // never renamed
    }
    char alias[FR_ID_ALIAS_MAX + 1];
    uint32_t rev = 0;
    if (read_str(h, "alias", alias) && nvs_get_u32(h, "alias_rev", &rev) == ESP_OK &&
        fr_id_alias_valid(alias, static_cast<uint32_t>(std::strlen(alias))) &&
        (rev > id->alias_rev || id->state != FR_ID_PROVISIONED)) {
        std::snprintf(id->alias, sizeof(id->alias), "%s", alias);
        id->alias_rev = rev;
    }
    nvs_close(h);
}

esp_err_t commit_and_close(nvs_handle_t h, esp_err_t err)
{
    if (err == ESP_OK) {
        err = nvs_commit(h);
    }
    nvs_close(h);
    return err;
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
        apply_alias_override(id);
        return ESP_OK;
    }
    nvs_handle_t h;
    err = nvs_open_from_partition(PARTITION, NAMESPACE, NVS_READONLY, &h);
    if (err != ESP_OK) {
        ESP_LOGI(TAG, "no identity (%s)", esp_err_to_name(err));
        apply_alias_override(id);
        return ESP_OK;
    }
    uint8_t stored_mac[6];
    size_t len = sizeof(stored_mac);
    if (nvs_get_blob(h, "mac", stored_mac, &len) != ESP_OK || len != sizeof(stored_mac) ||
        memcmp(stored_mac, id->mac, sizeof(stored_mac)) != 0) {
        ESP_LOGW(TAG, "identity belongs to another device");
        id->state = FR_ID_MISBOUND;
        nvs_close(h);
        apply_alias_override(id);
        return ESP_OK;
    }
    read_identity(h, id);
    nvs_close(h);
    id->state = FR_ID_PROVISIONED;
    apply_alias_override(id);
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

extern "C" bool fr_id_alias_valid(const char *alias, uint32_t len)
{
    if (alias == nullptr || len == 0 || len > FR_ID_ALIAS_MAX || alias[0] == '-' || alias[len - 1] == '-') {
        return false;
    }
    for (uint32_t i = 0; i < len; ++i) {
        char c = alias[i];
        bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-';
        if (!ok) {
            return false;
        }
    }
    return true;
}

extern "C" esp_err_t fr_id_set_alias(fr_identity_t *id, const char *alias, uint32_t rev)
{
    uint32_t len = static_cast<uint32_t>(std::strlen(alias));
    if (!fr_id_alias_valid(alias, len)) {
        return ESP_ERR_INVALID_ARG;
    }
    if (rev == id->alias_rev && std::strcmp(alias, id->alias) == 0) {
        return ESP_OK;  // the hub re-sent what we have (06 §6.3 step 3)
    }
    nvs_handle_t h;
    esp_err_t err = nvs_open(OVR_NAMESPACE, NVS_READWRITE, &h);
    if (err != ESP_OK) {
        return err;
    }
    err = nvs_set_str(h, "alias", alias);
    if (err == ESP_OK) {
        err = nvs_set_u32(h, "alias_rev", rev);
    }
    err = commit_and_close(h, err);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "alias not stored (%s)", esp_err_to_name(err));
        return err;
    }
    std::snprintf(id->alias, sizeof(id->alias), "%s", alias);
    id->alias_rev = rev;
    return ESP_OK;
}

extern "C" esp_err_t fr_id_load_net(fr_net_config_t *out)
{
    std::memset(out, 0, sizeof(*out));
    nvs_handle_t h;
    // fr_id_load() already initialised the partition; without it this open fails.
    esp_err_t err = nvs_open_from_partition(PARTITION, NET_NAMESPACE, NVS_READONLY, &h);
    if (err != ESP_OK) {
        return ESP_ERR_NOT_FOUND;
    }
    fr_net_creds_t &c = out->creds;
    bool have_ssid = read_str(h, "ssid", c.ssid) && c.ssid[0] != '\0';
    read_str(h, "pass", c.pass);  // an open network has none
    c.has_bssid = read_mac(h, "bssid", c.bssid);
    read_str(h, "hub_host", c.hub_host);
    read_str(h, "country", out->country);
    read_str(h, "hub_ip", out->hub_ip);
    nvs_close(h);
    if (nvs_open_from_partition(PARTITION, NAMESPACE, NVS_READONLY, &h) == ESP_OK) {
        nvs_get_u32(h, "prov_ts", &out->prov_ts);
        nvs_close(h);
    }
    if (!have_ssid) {
        std::memset(out, 0, sizeof(*out));  // no network: drop whatever else was there
        return ESP_ERR_NOT_FOUND;
    }
    return ESP_OK;
}

extern "C" esp_err_t fr_id_load_net_override(fr_net_override_t *out)
{
    std::memset(out, 0, sizeof(*out));
    nvs_handle_t h;
    if (nvs_open(NET2_NAMESPACE, NVS_READONLY, &h) != ESP_OK) {
        return ESP_ERR_NOT_FOUND;
    }
    fr_net_creds_t &c = out->creds;
    uint8_t ok = 0;
    bool have = read_str(h, "ssid", c.ssid) && c.ssid[0] != '\0' && nvs_get_u32(h, "base", &out->base_prov_ts) == ESP_OK;
    read_str(h, "pass", c.pass);
    c.has_bssid = read_mac(h, "bssid", c.bssid);
    read_str(h, "hub_host", c.hub_host);
    nvs_get_u8(h, "ok", &ok);
    out->confirmed = ok != 0;
    nvs_close(h);
    if (!have) {
        std::memset(out, 0, sizeof(*out));
        return ESP_ERR_NOT_FOUND;
    }
    return ESP_OK;
}

extern "C" esp_err_t fr_id_save_net_override(const fr_net_override_t *o)
{
    nvs_handle_t h;
    esp_err_t err = nvs_open(NET2_NAMESPACE, NVS_READWRITE, &h);
    if (err != ESP_OK) {
        return err;
    }
    // One namespace per override: whatever an earlier one set (a BSSID, a hub host) must not survive.
    err = nvs_erase_all(h);
    const fr_net_creds_t &c = o->creds;
    if (err == ESP_OK) {
        err = nvs_set_str(h, "ssid", c.ssid);
    }
    if (err == ESP_OK) {
        err = nvs_set_str(h, "pass", c.pass);
    }
    if (err == ESP_OK && c.has_bssid) {
        err = nvs_set_blob(h, "bssid", c.bssid, sizeof(c.bssid));
    }
    if (err == ESP_OK && c.hub_host[0] != '\0') {
        err = nvs_set_str(h, "hub_host", c.hub_host);
    }
    if (err == ESP_OK) {
        err = nvs_set_u32(h, "base", o->base_prov_ts);
    }
    if (err == ESP_OK) {
        err = nvs_set_u8(h, "ok", o->confirmed ? 1 : 0);
    }
    return commit_and_close(h, err);
}

extern "C" esp_err_t fr_id_clear_net_override(void)
{
    nvs_handle_t h;
    esp_err_t err = nvs_open(NET2_NAMESPACE, NVS_READWRITE, &h);
    if (err != ESP_OK) {
        return err;
    }
    return commit_and_close(h, nvs_erase_all(h));
}

extern "C" esp_err_t fr_id_load_link(fr_link_pin_t *out)
{
    std::memset(out, 0, sizeof(*out));
    nvs_handle_t h;
    if (nvs_open(LINK_NAMESPACE, NVS_READONLY, &h) != ESP_OK) {
        return ESP_ERR_NOT_FOUND;
    }
    bool have = nvs_get_u8(h, "chan", &out->channel) == ESP_OK && read_mac(h, "bssid", out->bssid) &&
                nvs_get_u32(h, "ssid_h", &out->ssid_hash) == ESP_OK && out->channel != 0;
    nvs_close(h);
    if (!have) {
        std::memset(out, 0, sizeof(*out));
        return ESP_ERR_NOT_FOUND;
    }
    return ESP_OK;
}

extern "C" esp_err_t fr_id_save_link(const fr_link_pin_t *pin)
{
    nvs_handle_t h;
    esp_err_t err = nvs_open(LINK_NAMESPACE, NVS_READWRITE, &h);
    if (err != ESP_OK) {
        return err;
    }
    err = nvs_set_u8(h, "chan", pin->channel);
    if (err == ESP_OK) {
        err = nvs_set_blob(h, "bssid", pin->bssid, sizeof(pin->bssid));
    }
    if (err == ESP_OK) {
        err = nvs_set_u32(h, "ssid_h", pin->ssid_hash);
    }
    return commit_and_close(h, err);
}

extern "C" uint32_t fr_id_ssid_hash(const char *ssid)
{
    // FNV-1a 32, as everywhere else in the protocol (fr/hash.hpp is not a dependency of this component).
    uint32_t h = 0x811C9DC5;
    for (const char *p = ssid; *p != '\0'; ++p) {
        h = (h ^ static_cast<uint8_t>(*p)) * 0x01000193;
    }
    return h;
}
