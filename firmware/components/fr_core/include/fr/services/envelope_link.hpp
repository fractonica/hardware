// The node's protocol endpoint in C2 (design c2 §5 "Sink" and "CMD over serial ENV", spec 05 §5.6-5.8):
// turns capability emissions into EVENT/STATE envelopes and answers CMD envelopes addressed to this
// node with RESULT envelopes. IDF-free, so the host suite tests the exact bytes; fr_core hands the
// envelopes to fr_serial as ENV frames. No hub session yet: nothing sets ACK_REQ (decision 8).
#pragma once

#include <cstddef>
#include <cstdint>
#include <span>

#include "fr/base.hpp"
#include "fr/cap/capability.hpp"
#include "fr/core/core.hpp"

namespace fr {

/** One addressable endpoint: a board instance or a system capability (node 0, diag 241). */
struct PortEntry {
    uint8_t port;
    const char *name;
    cap::Capability *cap;
    bool ok;  // false: init failed; CMDs answer FAILED
};

class EnvelopeLink final : public cap::Sink
{
public:
    static constexpr uint16_t kAddrHub = 0x0000;
    static constexpr uint16_t kAddrUnassigned = 0xFFFE;
    static constexpr uint16_t kAddrBroadcast = 0xFFFF;
    static constexpr uint8_t kTtl = 0x22;  // initial 2, remaining 2 (FR_TTL_DEFAULT)
    /** Header + RESULT prefix + the largest body this link builds (a Reply, or capability fields). */
    static constexpr size_t kMaxEnvelope = 18 + 7 + 480;

    /** Origin fields of every envelope this node sends; addr is 0xFFFE and net 0 when unassigned. */
    struct Origin {
        uint16_t net = 0;
        uint16_t addr = kAddrUnassigned;
        uint16_t epoch = 0;
    };

    struct Stats {
        uint32_t sent = 0;
        uint32_t dropped = 0;  // emission too large for one envelope
        uint32_t cmds = 0;     // CMDs dispatched
        uint32_t ignored = 0;  // well-formed but not for this node (class, dst, broadcast to a non-0 port)
        uint32_t bad = 0;      // envelopes that failed to decode
    };

    /** `out` receives each finished envelope on the core task (fr_core: an ENV serial line). */
    using Out = Callback<void(std::span<const uint8_t>), 16>;

    EnvelopeLink(Core &core, Out out) : core_(core), out_(out) {}

    void set_origin(const Origin &o) { origin_ = o; }
    const Origin &origin() const { return origin_; }
    void set_ports(std::span<const PortEntry> ports) { ports_ = ports; }
    const PortEntry *find_port(uint8_t port) const;

    /** t_us is the low 32 bits of `at`, or of Core::now() for cap::kNowUs (any negative `at`). */
    void event(uint8_t port, uint8_t event_id, cap::Priority prio, std::span<const uint8_t> fields,
               TimeUs at) override;
    void property(uint8_t port, uint8_t prop_id, std::span<const uint8_t> value, TimeUs at) override;

    /** An envelope from the hub link (C2: serial ENV). CMDs addressed to this node are dispatched and
     * answered; returns false only if it did not decode. */
    bool receive(std::span<const uint8_t> envelope);

    const Stats &stats() const { return stats_; }
    void reset_stats() { stats_ = {}; }

private:
    uint32_t t_us(TimeUs at) const;
    void send(uint8_t flags, uint8_t cls, uint8_t kind, uint32_t seq, uint16_t dst, uint8_t port,
              std::span<const uint8_t> prefix, std::span<const uint8_t> body);

    Core &core_;
    Out out_;
    Origin origin_;
    std::span<const PortEntry> ports_;
    Stats stats_;
    // Per-boot sequence spaces (05 §5.8): one ordinary, one LATEST; both start at 1.
    uint32_t seq_ = 0;
    uint32_t latest_seq_ = 0;
    uint8_t buf_[kMaxEnvelope];
};

}  // namespace fr
