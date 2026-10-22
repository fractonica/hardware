// fr::msg: MSG for L4 app code (spec 03 §3.2, 07 §7.11, design c5 §3). A MSG is `{topic, data}` (05 §5.7,
// class MSG): `data` is UTF-8 JSON from the SDK and agents, any bytes from C++. It travels the paths runtime
// bindings use: to a node by ESP-NOW unicast with the fallback chain (via the hub, then a flooded unicast),
// to kBroadcast by an ESP-NOW broadcast plus the same bytes to the hub, which delivers it to apps as a `msg`
// event, to kHub over the hub link (a `msg` event), and to the node's own addr without leaving it. Node and
// broadcast MSGs need no hub session. Every call is for the core task (a service's init, a handler, a timer).
#pragma once

#include <cstddef>
#include <cstdint>
#include <span>
#include <string_view>

#include "fr/base.hpp"

namespace fr::msg {

/** `dst` of a MSG to every node (and the hub). */
inline constexpr uint16_t kBroadcast = 0xFFFF;
/** `dst` of a MSG to the hub only: apps see it as a `msg` event. */
inline constexpr uint16_t kHub = 0x0000;
/** MSG.MSG field limits (schema/protocol.yaml): a frame stays within the 250 B realtime MTU. */
inline constexpr size_t kTopicMax = 32;
inline constexpr size_t kDataMax = 168;
/** on() registrations a node holds. */
inline constexpr size_t kHandlersMax = 8;

/** A received MSG: its sender's addr (0x0000: the hub) and data, which live only for the call. */
using Handler = Callback<void(uint16_t src, std::span<const uint8_t> data), 24>;

/**
 * Sends MSG {topic, data} to `dst`: another node's addr, kBroadcast, kHub, or this node's own addr (its
 * bindings and handlers run, nothing is sent). `reliable` (a node or kHub) asks for an ACK: a node's is
 * retried end to end over ESP-NOW (05 §5.8), the hub's like a Q1 EVENT. invalid_args for an empty or
 * over-long topic, data over kDataMax or a group dst; not_provisioned for a node or a broadcast before
 * provisioning; busy when nothing can carry it now.
 */
Status send(uint16_t dst, std::string_view topic, std::span<const uint8_t> data, bool reliable = false);

/** send() with JSON (or any) text as the data, e.g. send(kBroadcast, "scene", R"({"mode":"party"})"). */
inline Status send(uint16_t dst, std::string_view topic, std::string_view text, bool reliable = false)
{
    return send(dst, topic, std::span<const uint8_t>(reinterpret_cast<const uint8_t *>(text.data()), text.size()),
                reliable);
}

/**
 * Calls `handler` for every MSG with exactly this topic that reaches this node, unicast or broadcast, from
 * the hub or a node, once each (duplicates are filtered below), after the bindings it triggers ran. Several
 * handlers may share a topic. invalid_args for a bad topic, busy when kHandlersMax are registered.
 */
Status on(std::string_view topic, Handler handler);

}  // namespace fr::msg
