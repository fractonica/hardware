// Small helpers the fr_net core's translation units share (net.cpp: the hub link; air.cpp: ESP-NOW receive,
// flooding, the directory; peer.cpp: node <-> node sends; bindings.cpp). Private to src/core.
#pragma once

#include <cstddef>
#include <cstdint>

#include "fr/base.hpp"
#include "protocol.hpp"

namespace fr::net::util {

constexpr TimeUs ms_us(uint32_t ms)
{
    return static_cast<TimeUs>(ms) * 1000;
}

/** The u32 clock of envelopes and EXT TLVs: the low 32 bits of esp_timer µs (05 §5.7). */
constexpr uint32_t low32(TimeUs t)
{
    return static_cast<uint32_t>(t);
}

/** Groups and the reserved well-known groups (05 §5.5): BCAST space, delivered only to members (M2). */
constexpr bool is_group(uint16_t dst)
{
    return dst >= fr::proto::kAddrGroupsFirst && dst < fr::proto::kAddrUnassigned;
}

/** A provisioned node's address (gateways included), 05 §5.5. */
constexpr bool is_node_addr(uint16_t a)
{
    return a >= fr::proto::kAddrNodesFirst && a <= fr::proto::kAddrNodesLast;
}

/** 05 §5.9 is_flood_dst: broadcast or a group. */
constexpr bool is_flood_dst(uint16_t dst)
{
    return dst == fr::proto::kAddrBroadcast || is_group(dst);
}

constexpr uint8_t ttl_initial(uint8_t ttl)
{
    return ttl >> 4;
}

constexpr uint8_t ttl_remaining(uint8_t ttl)
{
    return ttl & 0x0F;
}

/** The ttl byte with both halves `n` (a frame's own TTL as it leaves its origin). */
constexpr uint8_t ttl_both(uint8_t n)
{
    return static_cast<uint8_t>((n & 0x0F) << 4 | (n & 0x0F));
}

/** Byte offsets of the relay-mutable header fields (05 §5.6): `flags` (RELAYED) and `ttl`. */
inline constexpr size_t kOffFlags = 1;
inline constexpr size_t kOffTtl = 16;

}  // namespace fr::net::util
