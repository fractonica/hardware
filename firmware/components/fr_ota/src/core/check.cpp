// CHECK (spec 06 §6.6, design c4 §3), over the bytes of the image header, esp_app_desc_t and
// fr_app_desc_t. Fields are read by offset rather than through the C structs: the head arrives as a byte
// buffer from HTTP or a flash read, and the offsets are the wire contract the hub's ingest checks too.
#include "fr/ota/check.hpp"

#include <cstring>

namespace fr::ota {
namespace {

uint16_t le16(std::span<const uint8_t> b, size_t at)
{
    return static_cast<uint16_t>(b[at] | b[at + 1] << 8);
}

uint32_t le32(std::span<const uint8_t> b, size_t at)
{
    return static_cast<uint32_t>(b[at]) | static_cast<uint32_t>(b[at + 1]) << 8 |
           static_cast<uint32_t>(b[at + 2]) << 16 | static_cast<uint32_t>(b[at + 3]) << 24;
}

/** A fixed-size char field up to its NUL (all of it when it has none). */
std::string_view field(std::span<const uint8_t> b, size_t at, size_t len)
{
    const char *p = reinterpret_cast<const char *>(b.data() + at);
    const void *nul = std::memchr(p, '\0', len);
    return {p, nul != nullptr ? static_cast<size_t>(static_cast<const char *>(nul) - p) : len};
}

template <size_t N>
std::string_view cstr(const char (&s)[N])
{
    const void *nul = std::memchr(s, '\0', N);
    return {s, nul != nullptr ? static_cast<size_t>(static_cast<const char *>(nul) - s) : N};
}

/** Decimal digits at `s[i]`; false without any (or on overflow past u32). */
bool number(std::string_view s, size_t &i, uint32_t &out)
{
    const size_t start = i;
    uint64_t v = 0;
    while (i < s.size() && s[i] >= '0' && s[i] <= '9') {
        v = v * 10 + static_cast<uint64_t>(s[i] - '0');
        if (v > UINT32_MAX) {
            return false;
        }
        ++i;
    }
    out = static_cast<uint32_t>(v);
    return i > start;
}

}  // namespace

std::optional<Semver> leading_semver(std::string_view label)
{
    size_t i = 0;
    if (!label.empty() && (label[0] == 'v' || label[0] == 'V')) {
        i = 1;
    }
    Semver v;
    if (!number(label, i, v.major) || i >= label.size() || label[i++] != '.' || !number(label, i, v.minor) ||
        i >= label.size() || label[i++] != '.' || !number(label, i, v.patch)) {
        return std::nullopt;
    }
    // `1.2.3x` is a label that happens to start with digits, `1.2.3+g1a2b`, `1.2.3-rc1` and `1.2.3.dirty`
    // are versions.
    if (i < label.size() && ((label[i] >= 'a' && label[i] <= 'z') || (label[i] >= 'A' && label[i] <= 'Z'))) {
        return std::nullopt;
    }
    return v;
}

bool is_downgrade(std::string_view image_version, std::string_view running_version)
{
    const std::optional<Semver> img = leading_semver(image_version);
    const std::optional<Semver> run = leading_semver(running_version);
    return img && run && *img < *run;
}

std::optional<Reject> check_offer(std::span<const uint8_t, 32> fw_id, uint32_t size, uint32_t flags,
                                  const RunningInfo &running)
{
    if (size < kCheckBytes) {
        return Reject::bad_image;  // cannot even hold the descriptors CHECK reads
    }
    if (size > running.slot_size) {
        return Reject::size;
    }
    if ((flags & kOfferForce) == 0) {
        const bool is_running = std::memcmp(fw_id.data(), running.fw_id.data(), 32) == 0;
        const bool is_last_invalid =
            running.has_last_invalid && std::memcmp(fw_id.data(), running.last_invalid_fw_id.data(), 32) == 0;
        if (is_running || is_last_invalid) {
            return Reject::same_fw;
        }
    }
    return std::nullopt;
}

std::optional<Reject> check_image(std::span<const uint8_t> head, uint32_t flags, const RunningInfo &running,
                                  const Ident &ident)
{
    // The structure first: without it nothing below means anything. The appended digest is what fw_id is
    // (06 §6.3), so an image without one could never pass VERIFY.
    if (head.size() < kCheckBytes || head[0] != kImageMagic || head[kImageHashAppendedOffset] != 1 ||
        le32(head, kEspAppDescOffset) != kEspAppDescMagic || le32(head, kAppDescOffset) != FR_APP_DESC_MAGIC ||
        head[kAppDescOffset + offsetof(fr_app_desc_t, version)] < 1) {
        return Reject::bad_image;
    }

    // IDF's own rule (bootloader_common_check_chip_revision_validity): the minimum always applies, the
    // maximum only when the image sets one (neither 0 nor 0xFFFF).
    const uint16_t min_rev = le16(head, kImageMinRevOffset);
    const uint16_t max_rev = le16(head, kImageMaxRevOffset);
    const bool max_set = max_rev != 0 && max_rev != 0xFFFF;
    if (le16(head, kImageChipIdOffset) != running.chip_id || running.chip_rev < min_rev ||
        (max_set && running.chip_rev > max_rev)) {
        return Reject::chip;
    }

    if ((flags & kOfferForce) == 0) {
        const size_t at = kAppDescOffset;
        if (field(head, at + offsetof(fr_app_desc_t, board), sizeof(fr_app_desc_t::board)) != cstr(ident.board) ||
            field(head, at + offsetof(fr_app_desc_t, profile), sizeof(fr_app_desc_t::profile)) != cstr(ident.profile) ||
            field(head, at + offsetof(fr_app_desc_t, part_profile), sizeof(fr_app_desc_t::part_profile)) !=
                cstr(ident.part_profile)) {
            return Reject::identity;
        }
    }

    if ((flags & kOfferAllowDowngrade) == 0 &&
        is_downgrade(field(head, kEspAppVersionOffset, sizeof(RunningInfo::version)), cstr(running.version))) {
        return Reject::downgrade;
    }
    return std::nullopt;
}

}  // namespace fr::ota
