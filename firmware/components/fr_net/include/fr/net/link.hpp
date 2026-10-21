// A transport to the hub, envelope-level (design c3 §3, spec 10 §10.3): the link adds and strips its own
// framing (TCP `len u16 LE`, serial ENV lines, one UDP datagram per envelope) and hands Net whole
// envelopes. Implemented in src/esp (Wi-Fi TCP/UDP, fr_serial) and by FakeLink in host tests.
#pragma once

#include <cstddef>
#include <cstdint>
#include <span>

#include "fr/base.hpp"

namespace fr::net {

/** The links Net knows; a value indexes State::links. */
enum class LinkKind : uint8_t { serial = 0, tcp = 1, udp = 2 };  // espnow = 3 in C5
inline constexpr size_t kLinkKinds = 3;

constexpr size_t index_of(LinkKind k)
{
    return static_cast<size_t>(k);
}

/** Why Net gave a session up (Link::drop), for the link's log line. */
enum class DropReason : uint8_t {
    hub_silent,     // 3.5 heartbeat intervals with nothing from the hub (05 §5.11)
    hub_bye,        // the hub said BYE
    hub_restarted,  // a WELCOME on the other link came from a new hub run
};

class Link
{
public:
    virtual LinkKind kind() const = 0;
    /** Transport connected: TCP socket open, USB host present, UDP socket bound. */
    virtual bool up() const = 0;
    /** Queues one envelope; the link adds framing and never blocks the core task (a full queue fails). */
    virtual Status send(std::span<const uint8_t> envelope) = 0;
    /**
     * Net lost the hub session on this link (05 §5.11: 3.5 heartbeat intervals with nothing from the hub).
     * A connection-oriented link closes and reconnects (TCP: backoff 0.25 -> 5 s, re-resolving hub_host);
     * the others ignore it.
     */
    virtual void drop(DropReason) {}
    /**
     * `net drop_hub_link` (09 §9.7: no reconnect while it lasts): while held, a connection-oriented link
     * that closes stays closed (TCP: no resolve, no connect); released, it reconnects at once. A connection
     * still open stays open. The others ignore it.
     */
    virtual void hold(bool) {}

protected:
    ~Link() = default;
};

}  // namespace fr::net
