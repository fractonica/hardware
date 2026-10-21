// The node descriptor (spec 07 §7.4, design c3 §2): what fr.node.describe returns and HELLO's
// descriptor_hash covers. IDF-free, so the host suite checks the exact bytes against the golden vector.
#pragma once

#include <cstddef>
#include <cstdint>
#include <span>
#include <string_view>

#include "fr/core/port.hpp"

namespace fr::core {

struct DescriptorSource {
    std::span<const uint8_t> fw_id_prefix;  // the first 8 bytes of the image's appended SHA-256
    uint32_t catalog_hash = 0;              // cap::catalog_hash()
    std::string_view profile;
    std::string_view board;
};

/** DescriptorCap.traits holds at most this many bytes (schema/protocol.yaml). */
inline constexpr size_t kMaxTraitsBytes = 16;

/**
 * Encodes the protobuf-wire Descriptor of the board instances (ports 1-239 with a capability, in port
 * order; the system ports are the same on every node and are left out) into `out`. Returns its size,
 * or 0 when it does not fit `out`, there are more instances than the Descriptor holds, or a
 * capability's traits exceed kMaxTraitsBytes. An instance whose init failed is still described: the
 * descriptor describes the firmware, so its hash does not change with the hardware's health.
 */
size_t build_descriptor(const DescriptorSource &src, std::span<const PortEntry> ports, std::span<uint8_t> out);

}  // namespace fr::core
