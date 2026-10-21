// CHECK (spec 06 §6.6, design c4 §3): whether an image may go into the update slot, decided before the
// first flash write. check_offer() needs only the OFFER (busy is Ota's to decide); check_image() reads the
// image's first kCheckBytes, i.e. the image header, esp_app_desc_t and fr_app_desc_t (06 §6.8 offsets).
// Pure functions: Ota runs them on fr_worker, fr_net_node and the tests call them directly.
#pragma once

#include <cstdint>
#include <optional>
#include <span>
#include <string_view>

#include "fr/ota/defs.hpp"

namespace fr::ota {

/** Image header fields CHECK reads (esp_image_header_t, packed, little-endian). */
inline constexpr uint8_t kImageMagic = 0xE9;
inline constexpr size_t kImageChipIdOffset = 12;
inline constexpr size_t kImageMinRevOffset = 15;  // min_chip_rev_full
inline constexpr size_t kImageMaxRevOffset = 17;  // max_chip_rev_full
inline constexpr size_t kImageHashAppendedOffset = 23;
/** esp_app_desc_t.magic_word and .version, from the image start. */
inline constexpr uint32_t kEspAppDescMagic = 0xABCD5432;
inline constexpr size_t kEspAppVersionOffset = kEspAppDescOffset + 16;

/** A version's leading `MAJOR.MINOR.PATCH` (an optional leading `v`); the rest of the label is ignored. */
struct Semver {
    uint32_t major = 0;
    uint32_t minor = 0;
    uint32_t patch = 0;

    friend constexpr auto operator<=>(const Semver &, const Semver &) = default;
};

/** The leading semver of `label`, or nothing for a label that does not start with one ("dev", "1.2"). */
std::optional<Semver> leading_semver(std::string_view label);

/** Design c4 §3: lower leading semver than the running app's; a non-semver label is never a downgrade. */
bool is_downgrade(std::string_view image_version, std::string_view running_version);

/** The REJECT an OFFER earns from its own fields (size, same_fw; FORCE lifts same_fw), else nothing. */
std::optional<Reject> check_offer(std::span<const uint8_t, 32> fw_id, uint32_t size, uint32_t flags,
                                  const RunningInfo &running);

/** The REJECT the image's first kCheckBytes earn (bad_image, chip, identity unless FORCE, downgrade unless
 * ALLOW_DOWNGRADE), else nothing. Fewer than kCheckBytes is bad_image. */
std::optional<Reject> check_image(std::span<const uint8_t> head, uint32_t flags, const RunningInfo &running,
                                  const Ident &ident);

}  // namespace fr::ota
