// FNV-1a 32 and the hashes HELLO carries (design c3 §2, spec 05 §5.7): descriptor_hash over the encoded
// Descriptor (what fr.node.describe returns), board_hash over the board id. The TS twin is
// packages/protocol/src/wire/hash.ts; the generated catalog_hash is FNV-1a 32 too.
#pragma once

#include <cstddef>
#include <cstdint>
#include <span>
#include <string_view>

namespace fr::wire {

inline constexpr uint32_t kFnv1a32Basis = 0x811C9DC5;
inline constexpr uint32_t kFnv1a32Prime = 0x01000193;

/** Continues an FNV-1a 32 hash over more bytes (start from kFnv1a32Basis). */
constexpr uint32_t fnv1a32(std::span<const uint8_t> data, uint32_t h = kFnv1a32Basis)
{
    for (const uint8_t b : data) {
        h = (h ^ b) * kFnv1a32Prime;
    }
    return h;
}

constexpr uint32_t fnv1a32(std::string_view s, uint32_t h = kFnv1a32Basis)
{
    for (const char c : s) {
        h = (h ^ static_cast<uint8_t>(c)) * kFnv1a32Prime;
    }
    return h;
}

/** HELLO `descriptor_hash`: FNV-1a 32 over the protobuf-wire Descriptor bytes. */
constexpr uint32_t descriptor_hash(std::span<const uint8_t> descriptor)
{
    return fnv1a32(descriptor);
}

/** HELLO `board_hash`: FNV-1a 32 over the board id (`esp32c6-supermini`). */
constexpr uint32_t board_hash(std::string_view board)
{
    return fnv1a32(board);
}

static_assert(fnv1a32(std::string_view("")) == 0x811C9DC5);
static_assert(fnv1a32(std::string_view("a")) == 0xE40C292C);

}  // namespace fr::wire
