#include "fr/core/descriptor.hpp"

#include "fr/wire.hpp"
#include "messages.hpp"  // generated fr::proto::Descriptor

namespace fr::core {

size_t build_descriptor(const DescriptorSource &src, std::span<const PortEntry> ports, std::span<uint8_t> out)
{
    using Caps = decltype(proto::Descriptor{}.caps);
    // The encoded traits must outlive the Descriptor's views until it is written.
    uint8_t traits[Caps::kCapacity][kMaxTraitsBytes];

    proto::Descriptor d;
    d.frame_version = 1;
    d.fw_id_prefix = src.fw_id_prefix;
    d.catalog_hash = src.catalog_hash;
    d.profile = src.profile;
    d.board = src.board;

    // Port order, whatever order the board table lists them in (at most a few dozen comparisons).
    unsigned after = 0;
    for (;;) {
        const PortEntry *next = nullptr;
        for (const PortEntry &p : ports) {
            if (p.cap != nullptr && p.port >= proto::kPortCapsFirst && p.port <= proto::kPortCapsLast &&
                p.port > after && (next == nullptr || p.port < next->port)) {
                next = &p;
            }
        }
        if (next == nullptr) {
            break;
        }
        after = next->port;
        if (d.caps.full()) {
            return 0;
        }
        wire::Writer tw(traits[d.caps.size()], kMaxTraitsBytes);
        next->cap->encode_traits(tw);
        if (tw.overflow()) {
            return 0;
        }
        const cap::Version v = next->cap->version();
        d.caps.push_back({.port = next->port,
                          .cap_id = next->cap->cap_id(),
                          .version = static_cast<uint16_t>(v.major << 8 | v.minor),
                          .name = next->name,
                          .traits = tw.bytes()});
    }

    wire::Writer w(out);
    encode(d, w);
    return w.overflow() ? 0 : w.size();
}

}  // namespace fr::core
