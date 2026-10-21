// fr::ota::Flash on esp_ota_ops (spec 06 §6.6): one update slot at a time, sequential writes only
// (OTA_WITH_SEQUENTIAL_WRITES erases sector by sector instead of the whole slot up front, which would
// stall the radio for seconds), esp_ota_resume for a download an earlier boot left, and the otadata
// states of the health gate. Writes run on fr_worker; running() once at boot.
#include <cstdio>
#include <cstring>

#include "esp_app_desc.h"
#include "esp_chip_info.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_partition.h"
#include "esp_system.h"
#include "fr/ota/esp.hpp"
#include "sdkconfig.h"

namespace fr::ota::esp {
namespace {

constexpr const char *TAG = "fr_ota";

class EspFlash final : public Flash
{
public:
    Status begin(uint32_t size, uint32_t resume_off) override
    {
        abort();
        const esp_partition_t *next = esp_ota_get_next_update_partition(nullptr);
        if (next == nullptr) {
            ESP_LOGE(TAG, "no update partition");
            return std::unexpected(Err::failed);
        }
        // `size` was checked against the slot (CHECK); the slot is erased as the writes reach it.
        esp_err_t err = resume_off > 0 ? esp_ota_resume(next, OTA_WITH_SEQUENTIAL_WRITES, resume_off, &handle_)
                                       : esp_ota_begin(next, OTA_WITH_SEQUENTIAL_WRITES, &handle_);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "%s %s: %s", resume_off > 0 ? "esp_ota_resume" : "esp_ota_begin", next->label,
                     esp_err_to_name(err));
            return std::unexpected(Err::failed);
        }
        ESP_LOGI(TAG, "slot %s open for %u B at %u", next->label, static_cast<unsigned>(size),
                 static_cast<unsigned>(resume_off));
        slot_ = next;
        open_ = true;
        return {};
    }

    Status write(std::span<const uint8_t> bytes) override
    {
        if (!open_) {
            return std::unexpected(Err::failed);
        }
        esp_err_t err = esp_ota_write(handle_, bytes.data(), bytes.size());
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "esp_ota_write: %s", esp_err_to_name(err));
            return std::unexpected(Err::failed);
        }
        return {};
    }

    Status finish(std::span<uint8_t, 32> sha_out) override
    {
        if (!open_) {
            return std::unexpected(Err::failed);
        }
        open_ = false;  // esp_ota_end frees the handle whatever it returns
        esp_err_t err = esp_ota_end(handle_);
        if (err == ESP_ERR_OTA_VALIDATE_FAILED) {
            ESP_LOGE(TAG, "the written image does not verify");
            return std::unexpected(Err::invalid_args);
        }
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "esp_ota_end: %s", esp_err_to_name(err));
            return std::unexpected(Err::failed);
        }
        // The appended digest, checked against the slot's contents (bootloader_common_get_sha256_of_partition).
        err = esp_partition_get_sha256(slot_, sha_out.data());
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "esp_partition_get_sha256: %s", esp_err_to_name(err));
            return std::unexpected(Err::invalid_args);
        }
        return {};
    }

    Status set_boot() override
    {
        const esp_partition_t *slot = slot_ != nullptr ? slot_ : esp_ota_get_next_update_partition(nullptr);
        esp_err_t err = slot != nullptr ? esp_ota_set_boot_partition(slot) : ESP_ERR_NOT_FOUND;
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "esp_ota_set_boot_partition: %s", esp_err_to_name(err));
            return std::unexpected(Err::failed);
        }
        ESP_LOGI(TAG, "boot partition: %s", slot->label);
        return {};
    }

    void abort() override
    {
        if (open_) {
            esp_ota_abort(handle_);
            open_ = false;
        }
    }

    Status read(uint32_t offset, std::span<uint8_t> out) override
    {
        const esp_partition_t *next = esp_ota_get_next_update_partition(nullptr);
        if (next == nullptr || esp_partition_read(next, offset, out.data(), out.size()) != ESP_OK) {
            return std::unexpected(Err::failed);
        }
        return {};
    }

    Status mark_valid() override
    {
        esp_err_t err = esp_ota_mark_app_valid_cancel_rollback();
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "esp_ota_mark_app_valid_cancel_rollback: %s", esp_err_to_name(err));
            return std::unexpected(Err::failed);
        }
        ESP_LOGI(TAG, "health gate passed: image marked valid");
        return {};
    }

    void rollback() override
    {
        ESP_LOGW(TAG, "health deadline missed: rolling back");
        esp_err_t err = esp_ota_mark_app_invalid_rollback_and_reboot();
        ESP_LOGE(TAG, "rollback impossible (%s): this image keeps running unconfirmed", esp_err_to_name(err));
    }

    RunningInfo running() const override
    {
        RunningInfo r;
        const esp_partition_t *run = esp_ota_get_running_partition();
        uint8_t sha[32];
        if (run != nullptr && esp_partition_get_sha256(run, sha) == ESP_OK) {
            std::memcpy(r.fw_id.data(), sha, sizeof(sha));
        }
        std::snprintf(r.version, sizeof(r.version), "%s", esp_app_get_description()->version);
        esp_ota_img_states_t st;
        r.pending_verify = run != nullptr && esp_ota_get_state_partition(run, &st) == ESP_OK &&
                           st == ESP_OTA_IMG_PENDING_VERIFY;
        // An invalid or aborted image's digest, as long as its slot still holds all of it.
        const esp_partition_t *invalid = esp_ota_get_last_invalid_partition();
        if (invalid != nullptr && esp_partition_get_sha256(invalid, sha) == ESP_OK) {
            r.has_last_invalid = true;
            std::memcpy(r.last_invalid_fw_id.data(), sha, sizeof(sha));
        }
        esp_chip_info_t chip;
        esp_chip_info(&chip);
        r.chip_id = static_cast<uint16_t>(CONFIG_IDF_FIRMWARE_CHIP_ID);
        r.chip_rev = chip.revision;  // major * 100 + minor, as the image header's revision range
        const esp_partition_t *next = esp_ota_get_next_update_partition(nullptr);
        if (next != nullptr) {
            r.slot_size = next->size;
            r.slot_addr = next->address;
        }
        // The reset that ended the previous boot: a rolled-back image's `crash` reason.
        const esp_reset_reason_t why = esp_reset_reason();
        r.crashed = why == ESP_RST_PANIC || why == ESP_RST_INT_WDT || why == ESP_RST_TASK_WDT || why == ESP_RST_WDT;
        return r;
    }

private:
    esp_ota_handle_t handle_ = 0;
    const esp_partition_t *slot_ = nullptr;
    bool open_ = false;
};

EspFlash s_flash;

}  // namespace

Flash &flash()
{
    return s_flash;
}

}  // namespace fr::ota::esp
