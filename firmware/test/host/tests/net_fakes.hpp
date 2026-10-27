// Test doubles for the fr_net core (design c3 §5, spec 10 §10.3): FakeLink records what Net sends per
// link, FakeHost stands in for fr_core (dispatch, identity, Wi-Fi, vitals), HubSim builds the hub's side
// of the conversation (WELCOME, CMD, ACK echoes, PING, SYNC_REQ, keepalives) with its sequence spaces,
// and NetRig wires them to a Net on FakeCore's clock. Test code: it may allocate.
#pragma once

#include <cstdlib>
#include <cstring>
#include <functional>
#include <optional>
#include <set>
#include <span>
#include <string_view>
#include <vector>

#include "fr/envelope.hpp"
#include "fr/net/net.hpp"
#include "fr/wire.hpp"
#include "messages.hpp"
#include "node.hpp"  // generated fr::cap::Node member ids
#include "tests/fake_core.hpp"
#include "tests/test.hpp"

namespace frt {

using fr::net::LinkKind;

/** One envelope a link was handed, with the fake clock at that moment. */
struct Sent {
    fr::TimeUs at;
    std::vector<uint8_t> bytes;
};

/** A node frame decoded for assertions. The only EXT a node sends is an ordered port's port_seq (design m2-c3-inputs
 * D8): `flags` has kFlagExt then. */
struct Frame {
    fr::TimeUs at = 0;
    std::vector<uint8_t> bytes;
    uint8_t flags = 0, cls = 0, kind = 0, port = 0, ttl = 0;
    uint32_t seq = 0;
    uint16_t net = 0, src = 0, dst = 0, epoch = 0;
    std::optional<uint32_t> port_seq;  // EXT 0x05
    uint32_t t_us = 0;
    fr::wire::ResultPrefix result;
    std::vector<uint8_t> body;

    bool is(uint8_t c, uint8_t k) const { return cls == c && kind == k; }
};

inline Frame decode_frame(const Sent &s)
{
    Frame f;
    f.at = s.at;
    f.bytes = s.bytes;
    auto e = fr::wire::unpack_envelope(s.bytes);
    if (!e) {
        fail(__FILE__, __LINE__, "node sent an undecodable envelope: " + hex(s.bytes));
        return f;
    }
    const fr::wire::Header &h = e->header;
    f.flags = h.flags;
    f.cls = h.cls;
    f.kind = h.kind;
    f.port = h.port;
    f.ttl = h.ttl;
    f.seq = h.seq;
    f.net = h.net;
    f.src = h.src;
    f.dst = h.dst;
    f.epoch = h.epoch;
    f.port_seq = h.ext.value(fr::wire::kExtPortSeq);
    f.t_us = e->t_us;
    f.result = e->result;
    f.body.assign(e->body.begin(), e->body.end());
    return f;
}

class FakeLink final : public fr::net::Link
{
public:
    explicit FakeLink(LinkKind k, const fr::Core &core) : kind_(k), core_(core) {}

    LinkKind kind() const override { return kind_; }
    bool up() const override { return is_up; }
    fr::Status send(std::span<const uint8_t> envelope) override
    {
        if (!is_up || refuse) {
            return std::unexpected(fr::Err::busy);
        }
        sent.push_back({core_.now(), {envelope.begin(), envelope.end()}});
        return {};
    }
    void drop(fr::net::DropReason why) override
    {
        ++drops;
        drop_reasons.push_back(why);
        if (drop_goes_down) {
            is_up = false;
        }
    }
    void hold(bool on) override { holds.push_back(on); }
    size_t queued() const override { return queued_bytes; }

    /** Every frame sent, or those of one class/kind. */
    std::vector<Frame> frames() const
    {
        std::vector<Frame> out;
        for (const Sent &s : sent) {
            out.push_back(decode_frame(s));
        }
        return out;
    }
    std::vector<Frame> frames(uint8_t cls, uint8_t kind) const
    {
        std::vector<Frame> out;
        for (const Sent &s : sent) {
            Frame f = decode_frame(s);
            if (f.is(cls, kind)) {
                out.push_back(f);
            }
        }
        return out;
    }
    std::vector<Frame> frames_of(uint8_t cls) const
    {
        std::vector<Frame> out;
        for (const Sent &s : sent) {
            Frame f = decode_frame(s);
            if (f.cls == cls) {
                out.push_back(f);
            }
        }
        return out;
    }
    size_t count(uint8_t cls, uint8_t kind) const { return frames(cls, kind).size(); }

    bool is_up = false;
    bool refuse = false;          // send() fails (queue full)
    bool drop_goes_down = false;  // drop() closes the link (TCP), the owner then calls link_changed
    size_t queued_bytes = 0;      // what queued() says: the TX FIFO's fill (design m2-c2 D20, LOG waits for 0)
    int drops = 0;
    std::vector<fr::net::DropReason> drop_reasons;
    std::vector<bool> holds;  // every hold() call, in order
    std::vector<Sent> sent;

private:
    LinkKind kind_;
    const fr::Core &core_;
};

class FakeHost final : public fr::net::Host
{
public:
    struct Call {
        uint8_t port;
        uint8_t cmd;
        std::vector<uint8_t> args;
        size_t capacity;
    };
    using Dispatch = std::function<fr::Status(uint8_t port, uint8_t cmd, std::span<const uint8_t> args,
                                              fr::cap::Reply &reply)>;
    /** One Host::ota_frame call. */
    struct OtaCall {
        LinkKind from;
        fr::wire::Header header;
        std::vector<uint8_t> body;
    };
    using OnOta = std::function<void(const OtaCall &call, fr::net::OtaReply &reply)>;

    FakeHost()
    {
        id.addr = 0x0005;
        id.net = 0x00AB;
        set_alias("c6-pad-d55e64", 2);
        id.epoch = 9;
        hello.mac = {0xAA, 0xBB, 0xCC, 0xD5, 0x5E, 0x64};
        hello.chip = 13;
        hello.chip_rev = 1;
        hello.fw_id_prefix = {1, 2, 3, 4, 5, 6, 7, 8};
        hello.descriptor_hash = 0x347FD1C7;
        hello.board_hash = 0x4088F3CE;
        hello.caps = fr::net::kCapWifi | fr::net::kCapProvisioned;
        hello.reset_reason = 3;
        hello.ota_state = fr::proto::OtaState::valid;
        wifi = {.wifi_up = true, .channel = 6, .bssid = {0x10, 0x20, 0x30, 0x40, 0x50, 0x60}, .rssi = -52};
        vit = {.free_heap_kb = 210, .vbat_mv = 0, .ota_busy = false, .low_batt = false};
    }

    void set_alias(std::string_view a, uint32_t rev)
    {
        std::memset(id.alias, 0, sizeof(id.alias));
        std::memcpy(id.alias, a.data(), std::min(a.size(), fr::net::Identity::kAliasMax));
        id.alias_rev = rev;
    }

    fr::Status dispatch(uint8_t port, uint8_t cmd, std::span<const uint8_t> args, fr::cap::Reply &reply) override
    {
        calls.push_back({port, cmd, {args.begin(), args.end()}, reply.capacity()});
        if (on_dispatch) {
            return on_dispatch(port, cmd, args, reply);
        }
        return {};
    }
    void report_all() override { ++report_alls; }
    fr::net::HelloInfo hello_info() override { return hello; }
    fr::net::Identity identity() override { return id; }
    fr::net::LinkInfo link_info() override { return wifi; }
    fr::net::Vitals vitals() override { return vit; }
    void ota_frame(LinkKind from, const fr::wire::Header &h, std::span<const uint8_t> body,
                   fr::net::OtaReply &reply) override
    {
        ota_calls.push_back({from, h, {body.begin(), body.end()}});
        if (on_ota) {
            on_ota(ota_calls.back(), reply);
        }
    }

    fr::net::Identity id;
    fr::net::HelloInfo hello;
    fr::net::LinkInfo wifi;
    fr::net::Vitals vit;
    Dispatch on_dispatch;
    std::vector<Call> calls;
    OnOta on_ota;
    std::vector<OtaCall> ota_calls;
    int report_alls = 0;
};

/** The hub's side: frames from src 0x0000 with its epoch and sequence spaces (05 §5.8). */
class HubSim
{
public:
    HubSim(uint16_t node_addr, uint16_t net) : node(node_addr), net(net) {}

    std::vector<uint8_t> frame(uint8_t flags, uint8_t cls, uint8_t kind, uint32_t seq, uint16_t dst, uint8_t port,
                               std::span<const uint8_t> prefix, std::span<const uint8_t> body,
                               fr::wire::ExtView ext = {}) const
    {
        std::vector<uint8_t> out(fr::wire::kMaxHeaderSize + prefix.size() + body.size());
        fr::wire::Writer w(out);
        fr::wire::pack_header({.flags = flags,
                               .cls = cls,
                               .kind = kind,
                               .seq = seq,
                               .net = net,
                               .src = src,
                               .dst = dst,
                               .epoch = epoch,
                               .ttl = 0x22,
                               .port = port,
                               .ext = ext},
                              w);
        w.raw(prefix);
        w.raw(body);
        out.resize(w.size());
        return out;
    }

    template <class Msg>
    static std::vector<uint8_t> body_of(const Msg &m)
    {
        std::vector<uint8_t> out(Msg::kMaxSize);
        fr::wire::Writer w(out);
        encode(m, w);
        out.resize(w.size());
        return out;
    }

    std::vector<uint8_t> welcome(uint32_t ucast_floor = 0, uint32_t bcast_base = 0)
    {
        ucast = std::max(ucast, ucast_floor);
        bcast = std::max(bcast, bcast_base);
        const auto body = body_of(fr::proto::NetWelcome{.hub_epoch = epoch,
                                                        .ucast_floor = ucast,
                                                        .bcast_base = bcast,
                                                        .hub_time_us = 5'000'000,
                                                        .net_mode = 0,
                                                        .channel = 6});
        return frame(0, fr::wire::kClsNet, fr::proto::kKindNetWelcome, ++ucast, node, 0, {}, body);
    }

    /** A unicast CMD (reliable: ACK_REQ) with its own seq; `seq_out` gets it. */
    std::vector<uint8_t> cmd(uint8_t port, uint8_t kind, std::span<const uint8_t> args = {},
                             uint8_t flags = fr::wire::kFlagAckReq, fr::wire::ExtView ext = {},
                             uint32_t *seq_out = nullptr)
    {
        const uint32_t seq = ++ucast;
        if (seq_out != nullptr) {
            *seq_out = seq;
        }
        if (!ext.empty()) {
            flags |= fr::wire::kFlagExt;
        }
        return frame(flags, fr::wire::kClsCmd, kind, seq, node, port, {}, args, ext);
    }

    /** A CMD to BROADCAST or a group: BCAST space, no ACK_REQ (05 §5.8). */
    std::vector<uint8_t> group_cmd(uint16_t dst, uint8_t port, uint8_t kind, std::span<const uint8_t> args = {})
    {
        return frame(0, fr::wire::kClsCmd, kind, ++bcast, dst, port, {}, args);
    }

    std::vector<uint8_t> ack(uint16_t node_epoch, uint32_t req_seq, uint8_t kind = fr::proto::kKindAckAck)
    {
        uint8_t prefix[fr::wire::kResultPrefixSize];
        fr::wire::Writer pw(prefix, sizeof(prefix));
        fr::wire::pack_result_prefix({.req_epoch = node_epoch, .req_seq = req_seq, .status = 0}, pw);
        return frame(0, fr::wire::kClsAck, kind, ++ucast, node, 0, pw.bytes(), {});
    }

    std::vector<uint8_t> heartbeat()
    {
        return frame(0, fr::wire::kClsPresence, fr::proto::kKindPresenceHeartbeat, ++ucast, node, 0, {},
                     body_of(fr::proto::PresenceHeartbeat{.uptime_s = 100}));
    }

    std::vector<uint8_t> ping(uint32_t t0)
    {
        return frame(fr::wire::kFlagAckReq, fr::wire::kClsPresence, fr::proto::kKindPresencePing, ++ucast, node, 0,
                     {}, body_of(fr::proto::PresencePing{.t0 = t0}));
    }

    std::vector<uint8_t> bye(uint8_t reason = fr::net::kByeShutdown)
    {
        return frame(0, fr::wire::kClsPresence, fr::proto::kKindPresenceBye, ++ucast, node, 0, {},
                     body_of(fr::proto::PresenceBye{.reason = reason}));
    }

    /** An OTA-class frame on port 240 (OFFER with ACK_REQ, COMMIT, ABORT; design c4 §3). */
    std::vector<uint8_t> ota(uint8_t kind, std::span<const uint8_t> body, uint8_t flags = 0,
                             uint8_t port = fr::proto::kPortOta, uint32_t *seq_out = nullptr)
    {
        const uint32_t seq = ++ucast;
        if (seq_out != nullptr) {
            *seq_out = seq;
        }
        return frame(flags, fr::wire::kClsOta, kind, seq, node, port, {}, body);
    }

    std::vector<uint8_t> sync_req(uint64_t t1)
    {
        return frame(fr::wire::kFlagAckReq, fr::wire::kClsTime, fr::proto::kKindTimeSyncReq, ++ucast, node, 0, {},
                     body_of(fr::proto::TimeSyncReq{.t1 = t1}));
    }

    uint16_t node;
    uint16_t net;
    uint16_t src = fr::proto::kAddrHub;  // tests forge other origins
    uint16_t epoch = 41;                 // this hub run
    uint32_t ucast = 0;   // UNICAST counter for `node`
    uint32_t bcast = 0;   // BCAST counter
};

/** Fixed jitter; FR_NET_SEED=<n> runs the suite under another seed (the timing checks hold for any). */
inline fr::net::Config test_config()
{
    fr::net::Config cfg;
    cfg.rng_seed = 0xC0FFEE;
    if (const char *s = std::getenv("FR_NET_SEED"); s != nullptr && *s != '\0') {
        cfg.rng_seed = static_cast<uint32_t>(std::strtoul(s, nullptr, 0));
    }
    return cfg;
}

/** Net with FakeCore, FakeHost and three FakeLinks, all attached and down. */
struct NetRig {
    explicit NetRig(const fr::net::Config &cfg = test_config())
        : serial(LinkKind::serial, core), tcp(LinkKind::tcp, core), udp(LinkKind::udp, core),
          net(core, host, cfg), hub(host.id.addr, host.id.net)
    {
        net.attach(serial);
        net.attach(tcp);
        net.attach(udp);
    }

    FakeLink &link(LinkKind k) { return k == LinkKind::serial ? serial : k == LinkKind::tcp ? tcp : udp; }

    void up(LinkKind k)
    {
        link(k).is_up = true;
        net.link_changed(k);
        core.run_ready();
    }
    void down(LinkKind k)
    {
        link(k).is_up = false;
        net.link_changed(k);
        core.run_ready();
    }
    void deliver(LinkKind k, const std::vector<uint8_t> &env)
    {
        net.receive(k, env);
        core.run_ready();
    }

    /** Link up, its HELLO out, the hub's WELCOME in, and the hub's ACK of fr.node.boot: a session on `k`. */
    void session(LinkKind k, uint32_t ucast_floor = 0, uint32_t bcast_base = 0)
    {
        up(k);
        deliver(k, hub.welcome(ucast_floor, bcast_base));
        ack_events(k);
    }

    /** The hub ACKs over `k` every Q1 EVENT the node has sent and it has not ACKed yet. */
    void ack_events(LinkKind k)
    {
        for (FakeLink *l : {&serial, &tcp, &udp}) {
            for (const Frame &f : l->frames_of(fr::wire::kClsEvent)) {
                if ((f.flags & fr::wire::kFlagAckReq) != 0 && acked.insert(f.seq).second) {
                    deliver(k, hub.ack(host.id.epoch, f.seq));
                }
            }
        }
    }

    /** TCP and UDP up, a TCP session, and udp_ok from the hub's echo of the first UDP HEARTBEAT. */
    void udp_ok_session()
    {
        up(LinkKind::udp);
        session(LinkKind::tcp);
        echo_last_udp_heartbeat();
    }

    /** The hub's ACK over TCP echoing the newest HEARTBEAT that went over UDP (05 §5.10). */
    void echo_last_udp_heartbeat()
    {
        auto hbs = udp.frames(fr::wire::kClsPresence, fr::proto::kKindPresenceHeartbeat);
        if (hbs.empty()) {
            fail(__FILE__, __LINE__, "no UDP HEARTBEAT to echo");
            return;
        }
        deliver(LinkKind::tcp, hub.ack(host.id.epoch, hbs.back().seq));
    }

    void clear_sent()
    {
        serial.sent.clear();
        tcp.sent.clear();
        udp.sent.clear();
    }

    FakeCore core;
    FakeHost host;
    FakeLink serial;
    FakeLink tcp;
    FakeLink udp;
    fr::net::Net net;
    HubSim hub;
    std::set<uint32_t> acked;  // node EVENT seqs ack_events() answered
};

}  // namespace frt
