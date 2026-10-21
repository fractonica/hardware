// fr:realtime
#include "fr/services/envelope_link.hpp"

#include "fr/envelope.hpp"
#include "fr/wire.hpp"

namespace fr {

using namespace fr::wire;

const PortEntry *EnvelopeLink::find_port(uint8_t port) const
{
    for (const PortEntry &p : ports_) {
        if (p.port == port) {
            return &p;
        }
    }
    return nullptr;
}

uint32_t EnvelopeLink::t_us(TimeUs at) const
{
    // The low 32 bits of the device clock (05 §5.7), compared with serial arithmetic: when the event
    // happened (an edge timestamp, say), or now when the emitter passed kNowUs.
    return static_cast<uint32_t>(at < 0 ? core_.now() : at);
}

void EnvelopeLink::event(uint8_t port, uint8_t event_id, cap::Priority prio, std::span<const uint8_t> fields,
                         TimeUs at)
{
    uint8_t flags = prio == cap::Priority::realtime ? kFlagUrgent : prio == cap::Priority::bulk ? kFlagBulk : 0;
    uint8_t prefix[kTimePrefixSize];
    Writer pw(prefix, sizeof(prefix));
    pack_time_prefix(t_us(at), pw);
    send(flags, kClsEvent, event_id, ++seq_, kAddrHub, port, pw.bytes(), fields);
}

void EnvelopeLink::property(uint8_t port, uint8_t prop_id, std::span<const uint8_t> value, TimeUs at)
{
    uint8_t prefix[kTimePrefixSize];
    Writer pw(prefix, sizeof(prefix));
    pack_time_prefix(t_us(at), pw);
    send(kFlagLatest, kClsState, prop_id, ++latest_seq_, kAddrHub, port, pw.bytes(), value);
}

bool EnvelopeLink::receive(std::span<const uint8_t> envelope)
{
    auto env = unpack_envelope(envelope);
    if (!env) {
        ++stats_.bad;
        return false;
    }
    const Header &h = env->header;
    bool unicast = h.dst == origin_.addr;
    // Port 0 (fr.node) is the only port with the same meaning on every device, so it alone accepts
    // broadcast (05 §5.8); such CMDs carry no ACK_REQ and get no RESULT.
    bool broadcast = h.dst == kAddrBroadcast && h.port == 0;
    if (h.cls != kClsCmd || (!unicast && !broadcast)) {
        ++stats_.ignored;
        return true;
    }

    ++stats_.cmds;
    cap::Reply reply;
    Status st;
    const PortEntry *p = find_port(h.port);
    if (p == nullptr || p->cap == nullptr) {
        st = std::unexpected(Err::not_found);
    } else if (!p->ok) {
        st = std::unexpected(Err::failed);
    } else {
        st = p->cap->dispatch(h.kind, env->body, reply);
    }
    if (!unicast) {
        return true;
    }

    uint8_t prefix[kResultPrefixSize];
    Writer pw(prefix, sizeof(prefix));
    pack_result_prefix({.req_epoch = h.epoch, .req_seq = h.seq, .status = wire_status(st)}, pw);
    // Only a successful dispatch owns what it wrote into the reply.
    std::span<const uint8_t> fields = st && !reply.fields().overflow() ? reply.bytes() : std::span<const uint8_t>{};
    send(0, kClsResult, h.kind, ++seq_, h.src, h.port, pw.bytes(), fields);
    return true;
}

void EnvelopeLink::send(uint8_t flags, uint8_t cls, uint8_t kind, uint32_t seq, uint16_t dst, uint8_t port,
                        std::span<const uint8_t> prefix, std::span<const uint8_t> body)
{
    Writer w(buf_, sizeof(buf_));
    pack_header({.flags = flags,
                 .cls = cls,
                 .kind = kind,
                 .seq = seq,
                 .net = origin_.net,
                 .src = origin_.addr,
                 .dst = dst,
                 .epoch = origin_.epoch,
                 .ttl = kTtl,
                 .port = port},
                w);
    w.raw(prefix);
    w.raw(body);
    if (w.overflow()) {
        ++stats_.dropped;
        return;
    }
    ++stats_.sent;
    out_(w.bytes());
}

}  // namespace fr
