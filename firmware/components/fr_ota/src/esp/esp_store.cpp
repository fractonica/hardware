// nvs:fr_ota (spec 06 §6.3) and the fr_ident fields of the OTA compatibility gate. Keys: job (string),
// fw (32 B blob), size, off, slot (u32), hub_seen, state (u8). Writes run on fr_worker.
#include <cstdio>
#include <cstring>

#include "esp_log.h"
#include "fr/app_desc.h"
#include "fr/ota/esp.hpp"
#include "nvs.h"

namespace fr::ota::esp {
namespace {

constexpr const char *TAG = "fr_ota";
constexpr const char *NAMESPACE = "fr_ota";
constexpr const char *IDENT_PARTITION = "fr_ident";
constexpr const char *IDENT_NAMESPACE = "fr_id";

Status done(nvs_handle_t h, esp_err_t err)
{
    if (err == ESP_OK) {
        err = nvs_commit(h);
    }
    nvs_close(h);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "nvs:fr_ota: %s", esp_err_to_name(err));
        return std::unexpected(Err::failed);
    }
    return {};
}

class EspStore final : public Store
{
public:
    bool load(Record &out) override
    {
        nvs_handle_t h;
        if (nvs_open(NAMESPACE, NVS_READONLY, &h) != ESP_OK) {
            return false;  // never written
        }
        Record r;
        size_t job_len = sizeof(r.job_id);
        size_t fw_len = r.fw_id.size();
        uint8_t hub_seen = 0;
        uint8_t state = 0;
        const bool ok = nvs_get_str(h, "job", r.job_id, &job_len) == ESP_OK &&
                        nvs_get_blob(h, "fw", r.fw_id.data(), &fw_len) == ESP_OK && fw_len == r.fw_id.size() &&
                        nvs_get_u32(h, "size", &r.size) == ESP_OK;
        nvs_get_u32(h, "off", &r.off);
        nvs_get_u32(h, "slot", &r.slot);
        nvs_get_u8(h, "hub_seen", &hub_seen);
        nvs_get_u8(h, "state", &state);
        nvs_close(h);
        if (!ok || state > static_cast<uint8_t>(RecState::health_timeout)) {
            return false;
        }
        r.hub_seen = hub_seen != 0;
        r.state = static_cast<RecState>(state);
        out = r;
        return true;
    }

    Status save(const Record &r) override
    {
        nvs_handle_t h;
        esp_err_t err = nvs_open(NAMESPACE, NVS_READWRITE, &h);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "nvs:fr_ota: %s", esp_err_to_name(err));
            return std::unexpected(Err::failed);
        }
        char job[sizeof(r.job_id)];
        std::snprintf(job, sizeof(job), "%.*s", static_cast<int>(sizeof(r.job_id) - 1), r.job_id);
        err = nvs_set_str(h, "job", job);
        if (err == ESP_OK) {
            err = nvs_set_blob(h, "fw", r.fw_id.data(), r.fw_id.size());
        }
        if (err == ESP_OK) {
            err = nvs_set_u32(h, "size", r.size);
        }
        if (err == ESP_OK) {
            err = nvs_set_u32(h, "off", r.off);
        }
        if (err == ESP_OK) {
            err = nvs_set_u32(h, "slot", r.slot);
        }
        if (err == ESP_OK) {
            err = nvs_set_u8(h, "hub_seen", r.hub_seen ? 1 : 0);
        }
        if (err == ESP_OK) {
            err = nvs_set_u8(h, "state", static_cast<uint8_t>(r.state));
        }
        return done(h, err);
    }

    Status save_off(uint32_t off) override
    {
        nvs_handle_t h;
        if (nvs_open(NAMESPACE, NVS_READWRITE, &h) != ESP_OK) {
            return std::unexpected(Err::failed);
        }
        return done(h, nvs_set_u32(h, "off", off));
    }

    Status save_state(RecState s) override
    {
        nvs_handle_t h;
        if (nvs_open(NAMESPACE, NVS_READWRITE, &h) != ESP_OK) {
            return std::unexpected(Err::failed);
        }
        return done(h, nvs_set_u8(h, "state", static_cast<uint8_t>(s)));
    }

    Status clear() override
    {
        nvs_handle_t h;
        if (nvs_open(NAMESPACE, NVS_READWRITE, &h) != ESP_OK) {
            return std::unexpected(Err::failed);
        }
        return done(h, nvs_erase_all(h));
    }
};

EspStore s_store;

template <size_t N>
void copy_field(char (&dst)[N], const char (&src)[N])
{
    std::memcpy(dst, src, N);
    dst[N - 1] = '\0';
}

/** A string key of fr_ident into `out`, which keeps its value when the key is missing or too long. */
template <size_t N>
void read_ident(nvs_handle_t h, const char *key, char (&out)[N])
{
    char buf[N];
    size_t len = N;
    if (nvs_get_str(h, key, buf, &len) == ESP_OK) {
        std::memcpy(out, buf, N);
    }
}

}  // namespace

Store &store()
{
    return s_store;
}

Ident ident()
{
    Ident id;
    copy_field(id.board, fr_app_desc.board);
    copy_field(id.profile, fr_app_desc.profile);
    copy_field(id.part_profile, fr_app_desc.part_profile);
    nvs_handle_t h;
    if (nvs_open_from_partition(IDENT_PARTITION, IDENT_NAMESPACE, NVS_READONLY, &h) == ESP_OK) {
        read_ident(h, "board", id.board);
        read_ident(h, "profile", id.profile);
        read_ident(h, "part_profile", id.part_profile);
        nvs_close(h);
    }
    return id;
}

}  // namespace fr::ota::esp
