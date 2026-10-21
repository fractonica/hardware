// The OTA slot as Ota sees it (design c4 §3): on target esp_ota_begin/resume/write/end, the boot
// partition, the partition SHA-256 and otadata states (src/esp); a memory flash in host tests and in
// fr_net_node. Every call that writes flash (the slot, otadata) runs on fr_worker; running() is cached at
// boot and read on the core task.
#pragma once

#include <cstdint>
#include <span>

#include "fr/base.hpp"
#include "fr/ota/defs.hpp"

namespace fr::ota {

class Flash
{
public:
    /** Opens the next update slot for `size` bytes with OTA_WITH_SEQUENTIAL_WRITES; `resume_off` > 0
     * continues an earlier download there (esp_ota_resume; 4 KB-aligned, so that sector is re-erased). */
    virtual Status begin(uint32_t size, uint32_t resume_off) = 0;
    /** The next bytes, in order: sequential writes only, never mixed with offset writes (06 §6.6). */
    virtual Status write(std::span<const uint8_t> bytes) = 0;
    /** Closes the slot (esp_ota_end, which verifies the image) and reports the SHA-256 of what is in it
     * (esp_partition_get_sha256). invalid_args: the image does not verify; failed: a flash error. */
    virtual Status finish(std::span<uint8_t, 32> sha_out) = 0;
    /** Boots the new slot next (esp_ota_set_boot_partition). */
    virtual Status set_boot() = 0;
    /** Drops an open slot (esp_ota_abort); nothing to do when none is open. */
    virtual void abort() = 0;
    /** Reads back what an earlier download left at `offset` of the update slot (the resume CHECK). */
    virtual Status read(uint32_t offset, std::span<uint8_t> out) = 0;
    /** The running PENDING_VERIFY image passed its health gate (esp_ota_mark_app_valid_cancel_rollback). */
    virtual Status mark_valid() = 0;
    /** The running image failed its health gate: mark it invalid and reboot into the previous one
     * (esp_ota_mark_app_invalid_rollback_and_reboot). Returns only when that is impossible. */
    virtual void rollback() = 0;
    virtual RunningInfo running() const = 0;

protected:
    ~Flash() = default;
};

}  // namespace fr::ota
