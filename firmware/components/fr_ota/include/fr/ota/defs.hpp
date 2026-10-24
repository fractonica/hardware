// What the node's OTA side shares with the hub and its own interfaces (design c4 §3, §7; spec 05 §5.7,
// 06 §6.6): timing and size constants, the health bits, OFFER flags, the REJECT codes, STATUS states,
// RESULT outcomes and reasons, what Flash reports about the running image, the fr_ident fields CHECK
// compares and the nvs:fr_ota record. Values marked "wire" are wire values: the hub's orchestrator reads
// the same numbers.
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

#include "fr/app_desc.h"

namespace fr::ota {

// ---- constants (design c4 §7) ----

/** FR_OTA_HEALTH_DEADLINE_MS: a PENDING_VERIFY image has this long to set every required health bit. */
inline constexpr uint32_t kHealthDeadlineMs = 60'000;
/** FR_OTA_CHUNK: bytes per HTTP read and flash write. */
inline constexpr size_t kChunk = 4096;
/** FR_OTA_RESUME_STRIDE: nvs:fr_ota `off` is written every this many bytes (rounded down to kChunk). */
inline constexpr uint32_t kResumeStride = 65'536;
/** FR_OTA_RANGE_RETRIES: a failed read re-issues `Range: bytes=<written>-` this often within one boot. */
inline constexpr uint8_t kRangeRetries = 5;
/** FR_OTA_STATUS_MS: STATUS while downloading at least this often (and at every 5 %). */
inline constexpr uint32_t kStatusMs = 1000;
/** The hub's node HTTP port (spec 08 §8.10): `http://<hub ip of the TCP session>:7422/ota/<fw_id>.bin`. */
inline constexpr uint16_t kHttpPort = 7422;
/** The image GET's connect, each send and each receive give up after this long: below the hub's 15 s stall
 * limit (06 §6.7), so a silent connection fails here first and the Range is re-issued. */
inline constexpr uint32_t kHttpTimeoutMs = 10'000;

/** Image offsets (06 §6.8): esp_app_desc_t after the 24 B image and 8 B segment headers, fr_app_desc after it. */
inline constexpr size_t kEspAppDescOffset = 32;
inline constexpr size_t kAppDescOffset = FR_APP_DESC_OFFSET;
/** CHECK needs this much of the image before any flash write: through the end of fr_app_desc_t. */
inline constexpr size_t kCheckBytes = kAppDescOffset + sizeof(fr_app_desc_t);
static_assert(kCheckBytes == 400);
static_assert(kResumeStride % kChunk == 0 && kCheckBytes <= kChunk);

// ---- health gate (06 §6.6) ----

inline constexpr uint32_t kHealthCore = 1u << 0;    // boot complete
inline constexpr uint32_t kHealthCaps = 1u << 1;    // every bound capability's init succeeded (never in a fault build)
inline constexpr uint32_t kHealthNet = 1u << 2;     // Wi-Fi up, or the serial session's WELCOME with the radio off (m2-c1-hil D6)
inline constexpr uint32_t kHealthHubAck = 1u << 3;  // WELCOME received; required only with nvs:fr_ota hub_seen

// ---- OTA/OFFER flags (schema/protocol.yaml, wire) ----

inline constexpr uint32_t kOfferForce = 1u << 0;
inline constexpr uint32_t kOfferDeferCommit = 1u << 1;
inline constexpr uint32_t kOfferAllowDowngrade = 1u << 2;

/** OTA/REJECT `code` (design c4 §3, wire). Only `busy` is worth retrying. */
enum class Reject : uint8_t {
    busy = 1,       // a job is running, the app is PENDING_VERIFY, or no TCP session to download over
    chip = 2,       // image chip id or chip revision range
    identity = 3,   // fr_app_desc board/profile/part_profile differ from fr_ident (unless FORCE)
    size = 4,       // larger than the update slot
    same_fw = 5,    // fw_id is the running one or the last invalid one (unless FORCE)
    downgrade = 6,  // lower leading semver than the running app (unless ALLOW_DOWNGRADE)
    bad_image = 7,  // no image magic, no appended digest, no esp_app_desc or fr_app_desc; a malformed OFFER
};

/** OTA/STATUS `state` (wire): where the job is. STATUS goes every 5 % or 1 s while downloading, and once
 * at each later state. */
enum class Phase : uint8_t {
    downloading = 1,  // `bytes` received so far (a resume starts at its stored offset)
    staged = 2,       // verified, waiting for COMMIT (OFFER flag DEFER_COMMIT)
    rebooting = 3,    // the new image is the boot partition: BYE ota and the restart follow
};

/** OTA/ACCEPT `code` (wire). */
enum class Accept : uint8_t {
    fresh = 0,    // the download starts at byte 0
    resumed = 1,  // it continues a download an earlier boot or job left in the slot (nvs:fr_ota `off`)
};

/** OTA/RESULT `outcome` (schema/protocol.yaml, wire). */
enum class Outcome : uint8_t { success = 0, failed = 1, rolled_back = 2 };

/** OTA/RESULT `reason` with outcome rolled_back (design c4 §3, wire). */
enum class RollbackReason : uint8_t { health_timeout = 1, crash = 2, unknown = 3 };

/** OTA/RESULT `reason` with outcome failed (wire). The node sends no RESULT for an ABORTed job. */
enum class FailReason : uint8_t {
    download = 1,  // HTTP: no answer, an error status, or a short body after kRangeRetries re-issues
    digest = 2,    // the written image does not verify, or its SHA-256 is not the OFFER's fw_id
    flash = 3,     // opening, writing or closing the slot, or setting the boot partition, failed
};

/** What Flash reports about the running image, this boot and the slot an update would go to. */
struct RunningInfo {
    std::array<uint8_t, 32> fw_id{};  // the running image's appended SHA-256 (esp_partition_get_sha256)
    char version[32] = {};            // esp_app_desc_t.version, NUL-terminated
    bool pending_verify = false;      // the running image is ESP_OTA_IMG_PENDING_VERIFY
    bool has_last_invalid = false;    // esp_ota_get_last_invalid_partition() found one with a readable digest
    std::array<uint8_t, 32> last_invalid_fw_id{};
    uint16_t chip_id = 0;    // image chip id: C3 5, S3 9, C6 13
    uint16_t chip_rev = 0;   // major * 100 + minor, as esp_image_header_t's min/max_chip_rev_full
    uint32_t slot_size = 0;  // the next update partition's size
    uint32_t slot_addr = 0;  // and its flash address: a stored resume offset belongs to one slot
    bool crashed = false;    // this boot follows a panic or a watchdog reset (a rollback's `crash` reason)
};

/** The fr_ident fields CHECK compares an image's fr_app_desc with (06 §6.3: the OTA compatibility gate). */
struct Ident {
    char board[32] = {};
    char profile[32] = {};
    char part_profile[16] = {};
};

/** nvs:fr_ota `state`: how far the stored job got. */
enum class RecState : uint8_t {
    download = 0,        // downloading or staged; `off` says where a resume continues (0: from the start)
    installed = 1,       // the image is (about to be) the boot partition: the next boots report on it
    health_timeout = 2,  // that image missed its health deadline and asked for the rollback
};

/** nvs:fr_ota (06 §6.3): the job a download or an installed image belongs to. */
struct Record {
    char job_id[24] = {};  // NUL-terminated
    std::array<uint8_t, 32> fw_id{};
    uint32_t size = 0;
    uint32_t off = 0;   // resume offset, a multiple of kChunk; 0: none
    uint32_t slot = 0;  // RunningInfo::slot_addr the download went to
    bool hub_seen = false;  // the job came from the hub: the installed image must reach it too (HUB_ACK)
    RecState state = RecState::download;
};

}  // namespace fr::ota
