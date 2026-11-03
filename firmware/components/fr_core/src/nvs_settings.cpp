// fr::platform::NvsSettings (design scale-round-c1 D6): see fr/platform/nvs_settings.hpp.
#include "fr/platform/nvs_settings.hpp"

#include <array>
#include <cstring>

#include "esp_log.h"
#include "fr/core/worker.hpp"
#include "nvs.h"

namespace fr::platform {
namespace {

constexpr const char *TAG = "fr_settings";

/** What a queued set carries: the key copied (the caller's buffer may go) and the value. */
struct Job {
    const char *ns;
    std::array<char, hal::Settings::kKeyMax + 1> key;
    int32_t value;
};

void run(const Job &j)
{
    nvs_handle_t h;
    esp_err_t err = nvs_open(j.ns, NVS_READWRITE, &h);
    if (err == ESP_OK) {
        err = nvs_set_i32(h, j.key.data(), j.value);
        if (err == ESP_OK) {
            err = nvs_commit(h);
        }
        nvs_close(h);
    }
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "nvs:%s set %s failed (%s)", j.ns, j.key.data(), esp_err_to_name(err));
    }
}

Status queue(const char *ns, const char *key, int32_t value)
{
    Job j{ns, {}, value};
    const size_t n = std::strlen(key);
    if (n == 0 || n > hal::Settings::kKeyMax) {
        return std::unexpected(Err::invalid_args);
    }
    std::memcpy(j.key.data(), key, n + 1);
    // 24 bytes on the 32-bit targets: fits fr_worker's Callback (its static_assert says so otherwise).
    if (!worker::post([j] { run(j); })) {
        ESP_LOGW(TAG, "nvs:%s %s not queued: fr_worker's queue is full", ns, key);
        return std::unexpected(Err::busy);
    }
    return {};
}

}  // namespace

std::expected<int32_t, Err> NvsSettings::get_i32(const char *key)
{
    nvs_handle_t h;
    esp_err_t err = nvs_open(ns_, NVS_READONLY, &h);
    if (err == ESP_ERR_NVS_NOT_FOUND) {
        return std::unexpected(Err::not_found);  // the namespace was never written
    }
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "nvs:%s not opened (%s)", ns_, esp_err_to_name(err));
        return std::unexpected(Err::failed);
    }
    int32_t v = 0;
    err = nvs_get_i32(h, key, &v);
    nvs_close(h);
    if (err == ESP_ERR_NVS_NOT_FOUND) {
        return std::unexpected(Err::not_found);
    }
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "nvs:%s %s not read (%s)", ns_, key, esp_err_to_name(err));
        return std::unexpected(Err::failed);
    }
    return v;
}

Status NvsSettings::set_i32(const char *key, int32_t value)
{
    return queue(ns_, key, value);
}

Status NvsSettings::erase(std::span<const char *const> keys)
{
    if (keys.empty() || keys.size() > kEraseMax) {
        return std::unexpected(Err::invalid_args);
    }
    for (const char *k : keys) {
        const size_t n = std::strlen(k);
        if (n == 0 || n > kKeyMax) {
            return std::unexpected(Err::invalid_args);
        }
    }
    if (erase_queued_.exchange(true, std::memory_order_acq_rel)) {
        ESP_LOGW(TAG, "nvs:%s erase not queued: the last one has not run yet", ns_);
        return std::unexpected(Err::busy);
    }
    for (size_t i = 0; i < keys.size(); ++i) {
        std::memcpy(erase_keys_[i].data(), keys[i], std::strlen(keys[i]) + 1);
    }
    erase_n_ = keys.size();
    // `this` lives as long as the node (fr_board builds the settings at namespace scope).
    if (!worker::post([this] { erase_now(); })) {
        erase_queued_.store(false, std::memory_order_release);
        ESP_LOGW(TAG, "nvs:%s erase not queued: fr_worker's queue is full", ns_);
        return std::unexpected(Err::busy);
    }
    return {};
}

void NvsSettings::erase_now()
{
    nvs_handle_t h;
    esp_err_t err = nvs_open(ns_, NVS_READWRITE, &h);
    if (err == ESP_OK) {
        for (size_t i = 0; i < erase_n_ && err == ESP_OK; ++i) {
            err = nvs_erase_key(h, erase_keys_[i].data());
            if (err == ESP_ERR_NVS_NOT_FOUND) {
                err = ESP_OK;  // nothing kept: already forgotten
            }
        }
        if (err == ESP_OK) {
            err = nvs_commit(h);  // one commit for all of them
        }
        nvs_close(h);
    }
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "nvs:%s erase of %u keys failed (%s)", ns_, static_cast<unsigned>(erase_n_), esp_err_to_name(err));
    }
    erase_queued_.store(false, std::memory_order_release);
}

}  // namespace fr::platform
