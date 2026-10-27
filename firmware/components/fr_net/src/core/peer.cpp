// fr:realtime
// fr_net core, C5 (design c5 §3, spec 05 §5.8-5.10): node <-> node sends. A frame to another node takes
// the fallback chain of 05 §5.10, one step per failure: an ESP-NOW unicast to the target's MAC (the MAC ACK
// confirms the hop), via the hub while a hub session is up (the hub forwards it), else a flooded unicast
// (the broadcast MAC, dst the target). Reliable frames carry ACK_REQ and are retried end to end with the same
// seq until the target's RESULT or ACK; the target caches its RESULT, so a retry never runs a command twice.
// Answers this node owes go back the same way, starting with the asker's MAC. Node-originated broadcasts go
// over ESP-NOW and, unchanged, to the hub (05 §5.9). Everything runs on the core task; no heap.
#include <algorithm>
#include <cstring>

#include "fr/envelope.hpp"
#include "fr/net/net.hpp"
#include "fr/wire.hpp"
#include "messages.hpp"
#include "net_util.hpp"

namespace fr::net {

using namespace fr::wire;
using namespace util;

namespace {

constexpr uint8_t kStatusFailed = static_cast<uint8_t>(Err::failed);

constexpr uint32_t elapsed_us(TimeUs from, TimeUs to)
{
    return static_cast<uint32_t>(std::clamp<TimeUs>(to - from, 0, UINT32_MAX));
}

}  // namespace

// ---- public sends ----

Status Net::send_to_node(uint16_t addr, uint8_t cls, uint8_t kind, uint8_t port, std::span<const uint8_t> body,
                         Delivery delivery)
{
    if (!is_node_addr(addr) || addr == addr_ || prefix_type(cls) == PrefixType::result) {
        return std::unexpected(Err::invalid_args);  // answers are Net's own (RESULT, ACK)
    }
    if (!provisioned()) {
        return std::unexpected(Err::not_provisioned);
    }
    const TimeUs now = core_.now();
    uint8_t prefix[kTimePrefixSize];
    Writer pw(prefix, sizeof(prefix));
    if (prefix_type(cls) == PrefixType::time) {
        pack_time_prefix(low32(now), pw);
    }
    const Status st = node_send(addr, nullptr, delivery == Delivery::reliable ? kFlagAckReq : 0, cls, kind, port,
                                pw.bytes(), body, -1, now);
    flush_fired();
    arm();
    return st;
}

Status Net::broadcast(uint8_t cls, uint8_t kind, uint8_t port, std::span<const uint8_t> body, uint8_t ttl)
{
    const auto r = broadcast_frame(cls, kind, port, body, ttl);
    flush_fired();
    arm();
    if (!r) {
        return std::unexpected(r.error());
    }
    return {};
}

Status Net::send_msg(uint16_t dst, std::string_view topic, std::span<const uint8_t> data, Delivery delivery)
{
    if (topic.size() > 32 || data.size() > 168) {
        return std::unexpected(Err::invalid_args);  // MSG.MSG limits (schema/protocol.yaml)
    }
    uint8_t body[fr::proto::MsgMsg::kMaxSize];
    Writer w(body, sizeof(body));
    encode(fr::proto::MsgMsg{.topic = topic, .data = data}, w);
    if (w.overflow()) {
        return std::unexpected(Err::invalid_args);
    }
    if (dst == fr::proto::kAddrBroadcast) {
        return broadcast(kClsMsg, fr::proto::kKindMsgMsg, fr::proto::kPortNode, w.bytes());
    }
    if (provisioned() && dst == addr_) {
        deliver_msg(addr_, w.bytes());  // a MSG to oneself: its bindings and handlers, no network
        flush_fired();
        arm();
        return {};
    }
    if (dst != fr::proto::kAddrHub) {
        return send_to_node(dst, kClsMsg, fr::proto::kKindMsgMsg, fr::proto::kPortNode, w.bytes(), delivery);
    }
    // To the hub (apps see it as a `msg` event): a unicast MSG is Q1 (05 §5.8), sent and ACKed like an
    // EVENT, but not input, so exempt from the age rule.
    const uint8_t flags = delivery == Delivery::reliable ? kFlagAckReq : 0;
    const uint8_t via = route(kClsMsg, fr::proto::kKindMsgMsg, flags, kHeaderSize + w.size());
    if (via == 0) {
        return std::unexpected(Err::busy);
    }
    const uint32_t seq = ++seq_;
    auto env = build(flags, kClsMsg, fr::proto::kKindMsgMsg, seq, fr::proto::kAddrHub, fr::proto::kPortNode, {},
                     w.bytes());
    const uint8_t took = transmit(via, env);
    if (flags != 0) {
        track(env, seq, took, core_.now(), true);
    }
    arm();
    return {};
}

std::expected<Path, Err> Net::broadcast_frame(uint8_t cls, uint8_t kind, uint8_t port, std::span<const uint8_t> body,
                                              uint8_t ttl)
{
    if (!provisioned()) {
        return std::unexpected(Err::not_provisioned);
    }
    // 05 §5.8: a broadcast CMD means the same on every device only on port 0; answers are never broadcast.
    if ((cls == kClsCmd && port != fr::proto::kPortNode) || prefix_type(cls) == PrefixType::result) {
        return std::unexpected(Err::invalid_args);
    }
    const uint8_t ttl_cap = std::clamp<uint8_t>(cfg_.ttl_max, 1, 15);
    const uint8_t t = std::clamp<uint8_t>(ttl != 0 ? ttl : cfg_.ttl_default, 1, ttl_cap);
    const TimeUs now = core_.now();
    uint8_t prefix[kTimePrefixSize];
    Writer pw(prefix, sizeof(prefix));
    if (prefix_type(cls) == PrefixType::time) {
        pack_time_prefix(low32(now), pw);
    }
    const size_t len = kHeaderSize + pw.size() + body.size();
    if (len > kRtSize) {
        return std::unexpected(Err::invalid_args);  // a BULK frame never goes on the air
    }
    auto env = build(0, cls, kind, ++seq_, fr::proto::kAddrBroadcast, port, pw.bytes(), body, ttl_both(t));
    // ESP-NOW first: the neighbours hear it in about a millisecond and relay it within its TTL. A TTL-1
    // frame is link-local (never relayed), so it is no flood and needs no rate.
    bool air = false;
    const bool flood = t > 1;
    if (air_up() && (!flood || flood_rate_take(addr_, now))) {
        if (air_send(kBroadcastMac, env, AirPrio::normal, next_token())) {
            ++state_.relay.seeded;
            air = true;
        } else if (flood) {
            flood_rate_refund(addr_);  // design m2-c2 D17: the driver refused it, so no flood went out
        }
    }
    // 05 §5.9: the same bytes to the hub, which delivers them to apps and fans them out over TCP with
    // ttl_remaining 1 (so they are not seeded again). TTL-1 frames stay on ESP-NOW.
    bool hub = false;
    if (t > 1) {
        const uint8_t via = route(cls, kind, 0, env.size());
        if (via != 0) {
            transmit(via, env);
            hub = true;
        }
    }
    if (!air && !hub) {
        return std::unexpected(Err::busy);
    }
    return air ? Path::espnow : Path::hub;
}

// ---- the fallback chain ----

Status Net::node_send(uint16_t addr, const Mac *mac, uint8_t flags, uint8_t cls, uint8_t kind, uint8_t port,
                      std::span<const uint8_t> prefix, std::span<const uint8_t> body, int8_t slot, TimeUs trigger)
{
    const size_t len = kHeaderSize + prefix.size() + body.size();
    if (len > kRtSize) {
        return std::unexpected(Err::invalid_args);  // node -> node frames are realtime: ESP-NOW carries 250 B
    }
    if (!air_up() && route(cls, kind, flags, len) == 0) {
        return std::unexpected(Err::busy);  // neither ESP-NOW nor a hub session
    }
    NodeOut &o = take_out();
    o = NodeOut{};
    o.used = true;
    o.reliable = (flags & kFlagAckReq) != 0;
    o.slot = slot;
    o.attempts = 1;
    o.addr = addr;
    o.seq = ++seq_;
    o.trigger = trigger;
    auto env = build(flags, cls, kind, o.seq, addr, port, prefix, body);
    o.len = static_cast<uint8_t>(env.size());
    std::memcpy(o.bytes, env.data(), env.size());
    if (mac != nullptr) {
        o.mac = *mac;
        o.has_mac = true;
    } else {
        o.has_mac = mac_of(addr, o.mac);
    }
    ++state_.nodes.sent;
    if (!o.has_mac) {
        resolve(addr);  // the hub knows every addr -> MAC; this frame takes the hub or a flood meanwhile
    }
    // A fast frame that no path took is gone (out_fallback finished it): busy, as for no path at all. A
    // reliable one waits for a later attempt; a binding's outcome goes out as its node.binding_fired only.
    if (!out_attempt(o) && slot < 0 && !o.reliable) {
        return std::unexpected(Err::busy);
    }
    return {};
}

Net::NodeOut &Net::take_out()
{
    NodeOut *oldest = nullptr;
    for (NodeOut &o : node_out_) {
        if (!o.used) {
            return o;
        }
        if (oldest == nullptr || o.trigger < oldest->trigger) {
            oldest = &o;
        }
    }
    // Full: the newest frame matters more than the oldest one still unconfirmed. Its binding report is
    // queued like every node.binding_fired (fired()), so nothing rebuilds tx_buf_ under the caller.
    if (oldest->reliable) {
        ++state_.delivery_failed;
    }
    out_finish(*oldest, static_cast<uint8_t>(Err::busy), 0);
    return *oldest;
}

bool Net::out_attempt(NodeOut &o)
{
    const std::span<const uint8_t> env(o.bytes, o.len);
    // Answers and input-driven commands take the driver's URGENT queue (design c5 §3).
    const AirPrio prio = o.answer || (o.bytes[kOffFlags] & kFlagUrgent) != 0 ? AirPrio::urgent : AirPrio::normal;
    if (air_up() && o.has_mac) {
        const uint32_t token = next_token();
        const Status st = air_send(o.mac, env, prio, token);
        if (st) {
            const TimeUs now = core_.now();
            o.in_air = true;
            o.token = token;
            o.path = Path::espnow;
            o.air_deadline = now + ms_us(kAirDoneMs);
            if (o.reliable) {
                o.retry_at = now + node_timeout_us(o.attempts, 0);
            }
            return true;
        }
        // Every unicast peer slot of the driver is in recent use (design c5 §8.5): instead of churning the
        // peer table, the frame goes to the broadcast MAC with TTL 1, heard by radio neighbours, relayed by
        // none; the target takes it as a flooded unicast.
        if (st.error() == Err::busy && out_flood(o, 1)) {
            out_sent(o, Path::flood, 0);
            return true;
        }
    }
    return out_fallback(o);
}

bool Net::out_fallback(NodeOut &o)
{
    const std::span<const uint8_t> env(o.bytes, o.len);
    // 05 §5.10: via the hub while a hub session is up; it forwards the envelope over the target's link.
    const uint8_t via = route(env[2], env[3], env[1], env.size());
    if (via != 0) {
        transmit(via, env);
        out_sent(o, Path::hub, 1);
        return true;
    }
    // Else a flooded unicast: the broadcast MAC, dst the target, TTL_DEFAULT; its neighbours relay it.
    if (out_flood(o, cfg_.ttl_default)) {
        out_sent(o, Path::flood, 1);
        return true;
    }
    o.in_air = false;
    o.air_deadline = kNever;
    if (!o.reliable) {
        out_finish(o, static_cast<uint8_t>(Err::busy), 0);
        return false;
    }
    o.retry_at = core_.now() + node_timeout_us(o.attempts, 0);  // a later attempt may find a path
    return false;
}

bool Net::out_flood(NodeOut &o, uint8_t ttl)
{
    const TimeUs now = core_.now();
    // A flood from this node counts against its own rate; a TTL-1 frame is not relayed, so it is none.
    const bool flood = ttl > 1;
    if (!air_up() || (flood && !flood_rate_take(addr_, now))) {
        return false;
    }
    const uint8_t keep = o.bytes[kOffTtl];
    o.bytes[kOffTtl] = ttl_both(ttl);
    const AirPrio prio = o.answer || (o.bytes[kOffFlags] & kFlagUrgent) != 0 ? AirPrio::urgent : AirPrio::normal;
    const bool ok = air_send(kBroadcastMac, {o.bytes, o.len}, prio, next_token()).has_value();
    o.bytes[kOffTtl] = keep;  // a later attempt starts the chain again with the frame's own TTL
    if (flood) {
        if (ok) {
            ++state_.relay.seeded;
        } else {
            // Design m2-c2 D17: the driver refused it: the token goes back, so each retry of a reliable frame
            // through a full queue does not spend another of this node's floods.
            flood_rate_refund(addr_);
        }
    }
    return ok;
}

void Net::out_sent(NodeOut &o, Path path, uint8_t hops)
{
    o.path = path;
    o.in_air = false;
    o.air_deadline = kNever;
    if (!o.answer) {
        ++(path == Path::hub ? state_.nodes.via_hub : state_.nodes.via_flood);
    }
    if (!o.reliable) {
        out_finish(o, fr::proto::kStatusOk, 0);
        return;
    }
    // The answer comes back over the same kind of path: a hop more through the hub or a relay.
    o.retry_at = core_.now() + node_timeout_us(o.attempts, hops);
}

void Net::out_finish(NodeOut &o, uint8_t status, uint32_t rtt_us)
{
    if (status != fr::proto::kStatusOk && !o.answer) {
        ++state_.nodes.failed;
    }
    const int8_t slot = o.slot;
    const Path path = o.path;
    o.used = false;
    if (slot >= 0) {
        fired(static_cast<uint8_t>(slot), status, rtt_us, path);
    }
}

void Net::service_out(NodeOut &o, TimeUs now)
{
    if (o.in_air) {
        if (now >= o.air_deadline) {
            // The driver never reported the send (reset, queue lost): treat it as a hop that failed.
            ++ls(LinkKind::espnow).tx_fail;
            o.in_air = false;
            o.air_deadline = kNever;
            out_fallback(o);
        }
        return;
    }
    if (!o.reliable || o.retry_at > now) {
        return;
    }
    if (o.attempts >= cfg_.max_attempts) {
        // 05 §5.8: given up after FR_MAX_ATTEMPTS without the target's answer.
        ++state_.delivery_failed;
        out_finish(o, kStatusFailed, 0);
        return;
    }
    // Same seq: the target answers a DUP from its response cache (05 §5.8).
    ++o.attempts;
    ++ls(LinkKind::espnow).retries;
    out_attempt(o);
}

uint32_t Net::node_timeout_us(uint8_t attempt, uint8_t hops)
{
    // 05 §5.8: 20 ms + 10 ms per expected hop, x2 per attempt, +-25 %: ~300 ms to give up at 0 hops.
    const uint64_t base = uint64_t{cfg_.ack_base_ms} + uint64_t{cfg_.ack_per_hop_ms} * hops;
    const uint32_t shift = std::min<uint32_t>(attempt > 0 ? attempt - 1u : 0u, 16);
    const uint64_t ms = std::min<uint64_t>(base << shift, UINT32_MAX / 1250);
    return jittered_us(static_cast<uint32_t>(ms), 25);
}

// ---- requests from nodes and their answers ----

void Net::on_node_cmd(LinkKind from, const EnvelopeView &e, bool unicast, const Mac *src_mac)
{
    const Header &h = e.header;
    // As from the hub (05 §5.8): only port 0 takes broadcasts, and only a unicast with ACK_REQ is answered.
    if (!unicast && h.port != fr::proto::kPortNode) {
        ++state_.cmds_refused;
        ++ls(from).rx_drop;
        return;
    }
    const bool respond = unicast && (h.flags & kFlagAckReq) != 0;
    // The RESULT goes back over ESP-NOW or through the hub as a realtime frame.
    cap::Reply reply(std::span<uint8_t>(reply_buf_, cap::Reply::kRealtimeCapacity));
    Status st;
    if (h.ext.find(kExtExecAtUs)) {
        // Node -> node exec_at needs a clock both nodes share, which only M2's BEACON hub time gives: hub CMDs
        // alone are scheduled (design c6 D22).
        st = std::unexpected(Err::unsupported);
        ++state_.cmds_refused;
    } else {
        // expire_at_us is in hub-synced time, which another node cannot compute: not checked here.
        ++state_.cmds;
        st = host_.dispatch(h.port, h.kind, e.body, reply);
    }
    if (!respond) {
        return;
    }
    uint8_t prefix[kResultPrefixSize];
    Writer pw(prefix, sizeof(prefix));
    pack_result_prefix({.req_epoch = h.epoch, .req_seq = h.seq, .status = wire_status(st)}, pw);
    const std::span<const uint8_t> fields = st ? reply.bytes() : std::span<const uint8_t>{};
    auto env = build(0, kClsResult, h.kind, ++seq_, h.src, h.port, pw.bytes(), fields);
    if (env.empty()) {
        return;
    }
    cache(h.src, h.epoch, h.seq, env);
    send_answer(h.src, src_mac, env);
}

void Net::send_node_ack(const Header &h, const Mac *src_mac)
{
    uint8_t prefix[kResultPrefixSize];
    Writer pw(prefix, sizeof(prefix));
    pack_result_prefix({.req_epoch = h.epoch, .req_seq = h.seq, .status = fr::proto::kStatusOk}, pw);
    send_answer(h.src, src_mac, build(0, kClsAck, fr::proto::kKindAckAck, ++seq_, h.src, h.port, pw.bytes(), {}));
}

void Net::send_answer(uint16_t dst, const Mac *src_mac, std::span<const uint8_t> envelope)
{
    if (envelope.empty() || envelope.size() > kRtSize) {
        return;
    }
    NodeOut &o = take_out();
    o = NodeOut{};
    o.used = true;
    o.answer = true;
    o.addr = dst;
    o.trigger = core_.now();
    o.len = static_cast<uint8_t>(envelope.size());
    std::memcpy(o.bytes, envelope.data(), envelope.size());
    // Straight back to the MAC the request came from when it came unrelayed: no directory needed.
    if (src_mac != nullptr) {
        o.mac = *src_mac;
        o.has_mac = true;
    } else {
        o.has_mac = mac_of(dst, o.mac);
    }
    out_attempt(o);
}

bool Net::resend_cached_node(uint16_t src, uint16_t epoch, uint32_t req_seq, const Mac *src_mac)
{
    for (const Cached &c : cache_) {
        if (c.used && !c.bulk && c.src == src && c.epoch == epoch && c.req_seq == req_seq) {
            ++state_.cached_replies;
            send_answer(src, src_mac, std::span<const uint8_t>(c.bytes, c.len));
            return true;
        }
    }
    return false;  // evicted: dropped all the same, never run twice
}

void Net::on_node_answer(const EnvelopeView &e)
{
    const Header &h = e.header;
    if (e.result.req_epoch != epoch_) {
        return;  // an answer to an earlier boot's request
    }
    for (NodeOut &o : node_out_) {
        if (o.used && o.reliable && !o.answer && o.addr == h.src && o.seq == e.result.req_seq) {
            uint8_t status = e.result.status;
            if (h.cls == kClsAck && h.kind == fr::proto::kKindAckNack && status == fr::proto::kStatusOk) {
                status = kStatusFailed;
            }
            if (o.in_air && o.path == Path::espnow) {
                // The answer overtook the driver's send completion (both are posted to the core task, and a
                // busy one drains the receive ring first): the unicast plainly reached the target, so its
                // hop counts now, as air_sent() would have; the late completion then finds no entry.
                ++state_.nodes.via_espnow;
                if (Neighbor *n = neighbor_of(o.mac)) {
                    ++n->ack_ok;
                    n->last_heard = core_.now();
                }
            }
            out_finish(o, status, elapsed_us(o.trigger, core_.now()));
            return;
        }
    }
}

// ---- MSG ----

bool Net::deliver_msg(uint16_t src, std::span<const uint8_t> body)
{
    auto m = fr::proto::decode_msg_msg(body);
    if (!m) {
        return false;
    }
    count_topic(m->topic);
    // 07 §7.11: the bindings on its topic first (node -> node reactions never wait), then fr::msg::on.
    run_bindings(false, 0, 0, m->topic);
    host_.msg(src, m->topic, m->data);
    return true;
}

void Net::count_topic(std::string_view topic)
{
    for (MsgStats::Topic &t : msgs_.topics) {
        if (t.name[0] == '\0') {
            if (topic.empty() || topic.size() >= sizeof(t.name)) {
                break;
            }
            std::memcpy(t.name, topic.data(), topic.size());
            t.name[topic.size()] = '\0';
            ++t.n;
            return;
        }
        if (topic == std::string_view(t.name)) {
            ++t.n;
            return;
        }
    }
    ++msgs_.other;  // past kTopics topics (or an empty one)
}

}  // namespace fr::net
