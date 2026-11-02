// What every node -> hub stream shares (design audio-a1 D3, D5; csi-c1 D11), neutral of what it carries: where a
// stream connects (the hub's node HTTP port, the address of the TCP session), the runtime that tells it (StreamHost),
// and the fr_stream half of a service (Worker). The one Engine (fr/audio/engine.hpp, fr_core's src/audio) runs the
// fr_stream task over every Worker, the audio services' and fr.csi's alike, and fr_audio over the audio ones only.
// IDF-free. fr::audio keeps its names for these (aliases), so the audio services read as they did.
#pragma once

#include <cstddef>
#include <cstdint>

#include "fr/base.hpp"

namespace fr::stream {

/** The hub's node HTTP port (spec 08 §8.10; fr_ota's kHttpPort): the stream routes are beside the OTA ones. */
inline constexpr uint16_t kHubHttpPort = 7422;

/** Where a stream connects (design audio-a1 D3): the hub's IPv4 of the node's TCP session, as OTA uses, and its HTTP
 * port. */
struct Endpoint {
    uint32_t ipv4 = 0;  // a.b.c.d as a << 24 | b << 16 | c << 8 | d
    uint16_t port = kHubHttpPort;
};

/** "a.b.c.d" into `out` (at least 16 bytes). */
void format_ipv4(uint32_t ipv4, char *out, size_t len);
/** A dotted IPv4; false for anything else. */
bool parse_ipv4(const char *text, uint32_t &out);

/** What the streams need from the runtime: fr_core's on target, fr_net_node's on the host, a fake in tests. */
class StreamHost
{
public:
    /** The hub endpoint of the current TCP session; false without one (the stream then ends net_lost). Core task. */
    virtual bool endpoint(Endpoint &out) = 0;
    /** The node's device id, 12 lowercase hex digits (fr_ident's device_id): the streams' X-Fr-Device. */
    virtual const char *device_id() const = 0;

protected:
    ~StreamHost() = default;
};

/** The runtime's StreamHost (nullptr: none, every stream ends net_lost). Before any stream; core task. */
void set_stream_host(StreamHost *host);
StreamHost *stream_host();

/** A service's fr_stream half (fr.audio_in, fr.audio_out, fr.csi). */
class Worker
{
public:
    /** fr_stream: one pass; it may block on its socket (up to the stream's stall limit). False when idle. */
    virtual bool stream_pass() = 0;

protected:
    ~Worker() = default;
};

}  // namespace fr::stream
