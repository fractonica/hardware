// Test doubles for the ESP-NOW side of the fr_net core (design c5 §5): ScriptAir is an AirLink whose sends
// the test sees and completes by hand, AirHost a Host that also records MSGs, MemStores the nvs:fr_dir and
// nvs:fr_bind stand-ins, Peer another node's frames (its addr, epoch, MAC and sequence space), and AirRig a
// Net on FakeCore with the three hub links, the air and the stores attached. Test code: it may allocate.
#pragma once

#include <cstring>
#include <deque>
#include <functional>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "fr/envelope.hpp"
#include "fr/net/net.hpp"
#include "fr/wire.hpp"
#include "messages.hpp"
#include "node.hpp"
#include "tests/fake_core.hpp"
#include "tests/net_fakes.hpp"
#include "tests/test.hpp"

namespace frt {

using fr::net::Mac;
using fr::net::RxMeta;

/** One AirLink::send call. */
struct AirTx {
    fr::TimeUs at = 0;
    Mac dst{};
    std::vector<uint8_t> bytes;
    fr::net::AirPrio prio = fr::net::AirPrio::normal;
    uint32_t token = 0;

    bool broadcast() const { return dst == fr::net::kBroadcastMac; }
    Frame frame() const { return decode_frame({at, bytes}); }
};

/** An AirLink the test drives: every accepted send is recorded and waits for complete(). */
class ScriptAir final : public fr::net::AirLink
{
public:
    explicit ScriptAir(const fr::Core &core) : core_(core) {}

    bool up() const override { return is_up; }
    fr::Status send(const Mac &dst, std::span<const uint8_t> envelope, fr::net::AirPrio prio, uint32_t token) override
    {
        if (!is_up) {
            return std::unexpected(fr::Err::failed);
        }
        if (refuse) {
            const fr::Err e = *refuse;
            if (refuse_once) {
                refuse.reset();
            }
            return std::unexpected(e);
        }
        sent.push_back({core_.now(), dst, {envelope.begin(), envelope.end()}, prio, token});
        return {};
    }

    /** Sends to the broadcast MAC / to a unicast MAC, decoded. */
    std::vector<AirTx> broadcasts() const
    {
        std::vector<AirTx> out;
        for (const AirTx &t : sent) {
            if (t.broadcast()) {
                out.push_back(t);
            }
        }
        return out;
    }
    std::vector<AirTx> unicasts() const
    {
        std::vector<AirTx> out;
        for (const AirTx &t : sent) {
            if (!t.broadcast()) {
                out.push_back(t);
            }
        }
        return out;
    }
    /** Sends of one class (any destination). */
    std::vector<AirTx> of(uint8_t cls) const
    {
        std::vector<AirTx> out;
        for (const AirTx &t : sent) {
            if (t.bytes.size() > 2 && t.bytes[2] == cls) {
                out.push_back(t);
            }
        }
        return out;
    }

    bool is_up = true;
    std::optional<fr::Err> refuse;  // send() fails with it
    bool refuse_once = false;
    std::vector<AirTx> sent;

private:
    const fr::Core &core_;
};

/** In-memory nvs:fr_dir and nvs:fr_bind. */
class MemStores final : public fr::net::DirectoryStore, public fr::net::BindingStore
{
public:
    bool load(fr::net::Directory &out) override
    {
        if (!has_dir) {
            return false;
        }
        out = dir;
        return true;
    }
    void save(const fr::net::Directory &d) override
    {
        dir = d;
        has_dir = true;
        ++dir_saves;
    }
    bool load(fr::net::BindingTable &out) override
    {
        if (!has_bindings) {
            return false;
        }
        out = bindings;
        return true;
    }
    void save(const fr::net::BindingTable &t) override
    {
        bindings = t;
        has_bindings = true;
        ++binding_saves;
    }

    fr::net::Directory dir;
    fr::net::BindingTable bindings{};
    bool has_dir = false;
    bool has_bindings = false;
    int dir_saves = 0;
    int binding_saves = 0;
};

/** A Host that records dispatches and MSGs (FakeHost records no MSGs). */
class AirHost final : public fr::net::Host
{
public:
    struct Call {
        fr::TimeUs at;
        uint8_t port;
        uint8_t cmd;
        std::vector<uint8_t> args;
    };
    struct Msg {
        fr::TimeUs at;
        uint16_t src;
        std::string topic;
        std::vector<uint8_t> data;
    };
    using Dispatch = std::function<fr::Status(uint8_t port, uint8_t cmd, std::span<const uint8_t> args,
                                              fr::cap::Reply &reply)>;

    explicit AirHost(const fr::Core &core, uint16_t addr = 0x0005, Mac mac = {0xAA, 0xBB, 0xCC, 0x00, 0x00, 0x05})
        : core_(core)
    {
        id.addr = addr;
        id.net = 0x00AB;
        id.epoch = 9;
        std::memcpy(id.alias, "node", 4);
        hello.mac = mac;
        hello.caps = fr::net::kCapWifi | fr::net::kCapProvisioned | fr::net::kCapEspnowV2;
        wifi = {.wifi_up = true, .channel = 6, .bssid = {1, 2, 3, 4, 5, 6}, .rssi = -50};
        vit = {.free_heap_kb = 200};
    }

    fr::Status dispatch(uint8_t port, uint8_t cmd, std::span<const uint8_t> args, fr::cap::Reply &reply) override
    {
        calls.push_back({core_.now(), port, cmd, {args.begin(), args.end()}});
        return on_dispatch ? on_dispatch(port, cmd, args, reply) : fr::Status{};
    }
    void report_all() override {}
    fr::net::HelloInfo hello_info() override { return hello; }
    fr::net::Identity identity() override { return id; }
    fr::net::LinkInfo link_info() override { return wifi; }
    fr::net::Vitals vitals() override { return vit; }
    void ota_frame(fr::net::LinkKind, const fr::wire::Header &, std::span<const uint8_t>, fr::net::OtaReply &) override {}
    void msg(uint16_t src, std::string_view topic, std::span<const uint8_t> data) override
    {
        msgs.push_back({core_.now(), src, std::string(topic), {data.begin(), data.end()}});
        if (on_msg) {
            on_msg(msgs.back());
        }
    }

    fr::net::Identity id;
    fr::net::HelloInfo hello;
    fr::net::LinkInfo wifi;
    fr::net::Vitals vit;
    Dispatch on_dispatch;
    std::function<void(const Msg &)> on_msg;
    std::vector<Call> calls;
    std::vector<Msg> msgs;

private:
    const fr::Core &core_;
};

inline std::vector<uint8_t> bytes_of(std::string_view s)
{
    return {s.begin(), s.end()};
}

/** An encoded MSG.MSG body. */
inline std::vector<uint8_t> msg_body(std::string_view topic, std::span<const uint8_t> data = {})
{
    return HubSim::body_of(fr::proto::MsgMsg{.topic = topic, .data = data});
}

/** Another node on the air: builds its frames in its own ordinary and LATEST spaces. */
struct Peer {
    uint16_t addr = 0x0012;
    uint16_t net = 0x00AB;
    uint16_t epoch = 3;
    Mac mac{0x02, 0x00, 0x00, 0x00, 0x00, 0x12};
    uint32_t seq = 0;
    uint32_t latest_seq = 0;

    /** A frame; `use_seq` 0 takes the next seq of the space its flags name. */
    std::vector<uint8_t> frame(uint8_t flags, uint8_t cls, uint8_t kind, uint16_t dst, uint8_t port,
                               std::span<const uint8_t> prefix, std::span<const uint8_t> body, uint8_t ttl = 0x22,
                               uint32_t use_seq = 0, fr::wire::ExtView ext = {})
    {
        if (use_seq == 0) {
            use_seq = (flags & fr::wire::kFlagLatest) != 0 ? ++latest_seq : ++seq;
        }
        if (!ext.empty()) {
            flags |= fr::wire::kFlagExt;
        }
        std::vector<uint8_t> out(fr::wire::kMaxHeaderSize + prefix.size() + body.size());
        fr::wire::Writer w(out);
        fr::wire::pack_header({.flags = flags,
                               .cls = cls,
                               .kind = kind,
                               .seq = use_seq,
                               .net = net,
                               .src = addr,
                               .dst = dst,
                               .epoch = epoch,
                               .ttl = ttl,
                               .port = port,
                               .ext = ext},
                              w);
        w.raw(prefix);
        w.raw(body);
        out.resize(w.size());
        return out;
    }

    std::vector<uint8_t> msg(uint16_t dst, std::string_view topic, std::span<const uint8_t> data = {}, uint8_t flags = 0,
                             uint8_t ttl = 0x22)
    {
        const auto body = msg_body(topic, data);
        return frame(flags, fr::wire::kClsMsg, fr::proto::kKindMsgMsg, dst, 0, {}, body, ttl);
    }

    std::vector<uint8_t> cmd(uint16_t dst, uint8_t port, uint8_t kind, std::span<const uint8_t> args = {},
                             uint8_t flags = fr::wire::kFlagAckReq, uint8_t ttl = 0x22)
    {
        return frame(flags, fr::wire::kClsCmd, kind, dst, port, {}, args, ttl);
    }

    /** RESULT (cls RESULT, kind = the command id) or ACK (cls ACK) answering (req_epoch, req_seq). */
    std::vector<uint8_t> answer(uint8_t cls, uint8_t kind, uint16_t dst, uint16_t req_epoch, uint32_t req_seq,
                                uint8_t status = 0, std::span<const uint8_t> fields = {}, uint8_t port = 0)
    {
        uint8_t prefix[fr::wire::kResultPrefixSize];
        fr::wire::Writer pw(prefix, sizeof(prefix));
        fr::wire::pack_result_prefix({.req_epoch = req_epoch, .req_seq = req_seq, .status = status}, pw);
        return frame(0, cls, kind, dst, port, pw.bytes(), fields);
    }

    std::vector<uint8_t> heartbeat()
    {
        return frame(fr::wire::kFlagLatest, fr::wire::kClsPresence, fr::proto::kKindPresenceHeartbeat,
                     fr::proto::kAddrBroadcast, 0, {}, HubSim::body_of(fr::proto::PresenceHeartbeat{.uptime_s = 7}), 0x11);
    }

    /** What the radio reports for a frame from this peer. */
    RxMeta meta(bool to_broadcast = true, int8_t rssi = -60) const
    {
        return {.src_mac = mac, .to_broadcast = to_broadcast, .rssi = rssi, .channel = 6};
    }
};

/** A relay's copy of `env` (05 §5.9): RELAYED set, ttl_remaining - 1. */
inline std::vector<uint8_t> relayed(std::vector<uint8_t> env)
{
    env[1] |= fr::wire::kFlagRelayed;
    env[16] = static_cast<uint8_t>((env[16] & 0xF0) | ((env[16] & 0x0F) - 1));
    return env;
}

/** The hub's fan-out / forward of a node frame over TCP: ttl_remaining - 1 (forward) or 1 (fan-out). */
inline std::vector<uint8_t> with_ttl(std::vector<uint8_t> env, uint8_t ttl)
{
    env[16] = ttl;
    return env;
}

/** A hub broadcast MSG (BCAST space, dst 0xFFFF, ttl 0x22, EXT valid_ms 2000) as hub_seed's vector shapes it. */
inline std::vector<uint8_t> hub_broadcast(HubSim &hub, std::string_view topic, std::span<const uint8_t> data = {},
                                          uint8_t ttl = 0x22, uint32_t seq = 0)
{
    fr::wire::ExtBuilder ext;
    ext.add_value(fr::wire::kExtValidMs, 2000);
    const auto body = msg_body(topic, data);
    auto out = hub.frame(fr::wire::kFlagExt, fr::wire::kClsMsg, fr::proto::kKindMsgMsg, seq != 0 ? seq : ++hub.bcast,
                         fr::proto::kAddrBroadcast, 0, {}, body, ext.view());
    out[16] = ttl;
    return out;
}

/** Test configuration: fixed jitter (FR_NET_SEED overrides, as for NetRig). */
inline fr::net::Config air_config(uint32_t seed_offset = 0)
{
    fr::net::Config cfg = test_config();
    cfg.rng_seed += seed_offset;
    return cfg;
}

/** Net with the three hub links (down), ScriptAir (up) and MemStores attached, on FakeCore. */
struct AirRig {
    explicit AirRig(const fr::net::Config &cfg = air_config(), bool attach_air = true)
        : host(core), serial(LinkKind::serial, core), tcp(LinkKind::tcp, core), udp(LinkKind::udp, core), air(core),
          net(core, host, cfg), hub(host.id.addr, host.id.net)
    {
        net.attach(serial);
        net.attach(tcp);
        net.attach(udp);
        net.attach_stores(&stores, &stores);
        if (attach_air) {
            net.attach_air(air);
        }
        core.run_ready();
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
    void rx(const std::vector<uint8_t> &env, const RxMeta &meta)
    {
        net.receive_air(env, meta);
        core.run_ready();
    }
    /** The driver's completion of AirTx `t`. */
    void complete(const AirTx &t, bool acked = true)
    {
        net.air_sent(t.token, acked);
        core.run_ready();
    }
    /** Completes every send still open (MAC-ACKed). */
    void complete_all(bool acked = true)
    {
        for (size_t i = completed; i < air.sent.size(); ++i) {
            net.air_sent(air.sent[i].token, acked);
        }
        completed = air.sent.size();
        core.run_ready();
    }

    /** A TCP session (WELCOME) with the boot event ACKed. */
    void session(LinkKind k = LinkKind::tcp, uint32_t bcast_base = 0)
    {
        up(k);
        deliver(k, hub.welcome(0, bcast_base));
        for (const Frame &f : link(k).frames_of(fr::wire::kClsEvent)) {
            if ((f.flags & fr::wire::kFlagAckReq) != 0) {
                deliver(k, hub.ack(host.id.epoch, f.seq));
            }
        }
    }

    /** NET/DIRECTORY over `k`: one page per call (`page` of `pages`). */
    void directory(LinkKind k, std::vector<std::pair<uint16_t, Mac>> entries, uint8_t page = 0, uint8_t pages = 1)
    {
        fr::proto::NetDirectory d{.page = page, .pages = pages};
        for (const auto &[addr, mac] : entries) {
            macs.push_back(mac);
            d.entries.push_back({.addr = addr, .mac = std::span<const uint8_t>(macs.back())});
        }
        deliver(k, hub.frame(0, fr::wire::kClsNet, fr::proto::kKindNetDirectory, ++hub.ucast, host.id.addr, 0, {},
                             HubSim::body_of(d)));
    }

    void clear_sent()
    {
        serial.sent.clear();
        tcp.sent.clear();
        udp.sent.clear();
        air.sent.clear();
        completed = 0;
    }

    /** node.binding_fired events the node sent over `k`, decoded. */
    std::vector<fr::cap::NodeBindingFired> fired(LinkKind k = LinkKind::tcp) const
    {
        std::vector<fr::cap::NodeBindingFired> out;
        const FakeLink &l = k == LinkKind::serial ? serial : k == LinkKind::tcp ? tcp : udp;
        for (const Frame &f : l.frames(fr::wire::kClsEvent, fr::cap::Node::kEventBindingFired)) {
            if (f.port == fr::proto::kPortNode) {
                auto b = fr::cap::decode_node_binding_fired(f.body);
                if (b) {
                    out.push_back(*b);
                }
            }
        }
        return out;
    }

    FakeCore core;
    AirHost host;
    FakeLink serial;
    FakeLink tcp;
    FakeLink udp;
    ScriptAir air;
    MemStores stores;
    fr::net::Net net;
    HubSim hub;
    std::deque<Mac> macs;  // DirectoryEntry views point here
    size_t completed = 0;
};

}  // namespace frt
