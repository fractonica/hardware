// The T2-SCALE hub model and test node (design m2-c2 §4 S1, §5.2): the hub's side of router mode in C++, built from
// HubSim's frame builders (net_fakes.hpp) on a SimCore of its own, and Nets on SimCores with SimAir on the medium,
// talking to it over in-memory hub links. The hub answers HELLO with WELCOME (bcast_base: its BCAST counter), echoes
// every HEARTBEAT with an ACK (the session's keepalive), ACKs every ACK_REQ frame, fans node broadcasts out to the
// other nodes with ttl_remaining 1, and sends hub broadcasts as router/index.ts does: the next BCAST seq, dst 0xFFFF,
// ttl 2/2 within its flood rate (10/s, burst 8; over it ttl 2/1, TCP only), EXT valid_ms 2000, the same bytes to every
// welcomed session of every node (TCP and serial both). Each link delivers after the AP model's latency, U(0.8, 3) ms
// as the C5 medium's hub path, in order per link and direction; with `ip_medium` set, every TCP frame is also airtime
// on the channel (D4). restart() is a new hub run (epoch + 1, BCAST from 0): sessions end, and a serial port the hub
// held is closed and opened again, so the node HELLOs anew. Test code: it may allocate.
#pragma once

#include <deque>
#include <functional>
#include <map>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "fr/envelope.hpp"
#include "fr/net/net.hpp"
#include "fr/wire.hpp"
#include "messages.hpp"
#include "sim/executor.hpp"
#include "sim/medium.hpp"
#include "sim/rng.hpp"
#include "sim/sim_air.hpp"
#include "sim/sim_core.hpp"
#include "sim/topology.hpp"
#include "tests/net_air_fakes.hpp"

namespace frt {

class HubModel;

/** One node's in-memory hub link (TCP or serial), node side. */
class HubLink final : public fr::net::Link
{
public:
    HubLink(HubModel &hub, LinkKind kind, const fr::Core &core) : hub_(hub), kind_(kind), core_(core) {}

    LinkKind kind() const override { return kind_; }
    bool up() const override { return is_up; }
    fr::Status send(std::span<const uint8_t> envelope) override;
    void drop(fr::net::DropReason) override { ++drops; }

    /** The node's index at the hub (HubModel::add_node). */
    size_t node = SIZE_MAX;
    bool is_up = false;
    /** Keeps every frame the node sent (the parity suite reads binding_fired). */
    bool record = false;
    std::vector<Sent> sent;
    int drops = 0;

private:
    HubModel &hub_;
    LinkKind kind_;
    const fr::Core &core_;
};

struct HubOptions {
    uint16_t net = 0x00AB;
    uint16_t epoch = 41;
    uint32_t lat_min_us = 800;
    uint32_t lat_max_us = 3000;
    double flood_per_s = 10;
    double flood_burst = 8;
    uint32_t valid_ms = 2000;
    uint64_t seed = 1;
    /** Node broadcasts over TCP go to the other nodes with ttl_remaining 1 (router fan-out). */
    bool fan_out = true;
    /** When set, every hub-link frame is IP airtime on `channel` at `ip_mbps` (40 B of TCP/IP and the length prefix). */
    frsim::Medium *ip_medium = nullptr;
    uint8_t channel = 6;
    uint32_t ip_mbps = 24;
};

class HubModel
{
public:
    static constexpr fr::net::Mac kHubMac{0x02, 0xf2, 0xff, 0xff, 0xff, 0xfe};

    struct Stats {
        uint32_t hellos = 0;
        uint32_t welcomes = 0;
        uint32_t bcast_sent = 0;
        uint32_t bcast_seeded = 0;
        uint32_t bcast_tcp_only = 0;
        uint32_t fanned_out = 0;
        uint32_t frames_in = 0;
        uint32_t frames_out = 0;
    };

    HubModel(frsim::Executor &exec, HubOptions o) : exec_(exec), o_(o), core_(exec, "hub"), tokens_(o.flood_burst) {}
    HubModel(const HubModel &) = delete;
    HubModel &operator=(const HubModel &) = delete;

    /** A node's Net and its two links; returns its index. */
    size_t add_node(fr::net::Net &net, frsim::SimCore &core, uint16_t addr, const fr::net::Mac &mac, HubLink &serial, HubLink &tcp)
    {
        nodes_.push_back(std::make_unique<Node>(Node{.net = &net,
                                                     .core = &core,
                                                     .mac = mac,
                                                     .sim = HubSim(addr, o_.net),
                                                     .links = {&serial, &tcp},
                                                     .session = {false, false},
                                                     .last = {{{0, 0}, {0, 0}}},
                                                     .frames = 0}));
        nodes_.back()->sim.epoch = o_.epoch;
        serial.node = tcp.node = nodes_.size() - 1;
        return nodes_.size() - 1;
    }

    /** A frame the node sent reaches the hub's side of its link, after the uplink latency. */
    void from_node_later(size_t node, LinkKind kind, std::span<const uint8_t> env)
    {
        Node &n = *nodes_[node];
        account_ip(env.size());
        const fr::TimeUs at = when(n, kind, 1);
        exec_.at(at, [this, node, kind, bytes = std::vector<uint8_t>(env.begin(), env.end())] {
            from_node(node, kind, bytes);
        });
    }

    /**
     * One hub broadcast of MSG {topic, data} (router broadcast()): the next BCAST seq, ttl 2/2 within the flood rate
     * (else 2/1), to every welcomed session of every node. Returns its seq.
     */
    uint32_t broadcast(std::string_view topic, std::span<const uint8_t> data)
    {
        const fr::TimeUs now = exec_.now();
        tokens_ = std::min(o_.flood_burst, tokens_ + static_cast<double>(now - tokens_at_) * o_.flood_per_s / 1e6);
        tokens_at_ = now;
        const bool seeded = o_.flood_per_s <= 0 || tokens_ >= 1.0;
        if (seeded && o_.flood_per_s > 0) {
            tokens_ -= 1.0;
        }
        ++bcast_;
        ++stats.bcast_sent;
        ++(seeded ? stats.bcast_seeded : stats.bcast_tcp_only);
        for (size_t i = 0; i < nodes_.size(); ++i) {
            Node &n = *nodes_[i];
            n.sim.bcast = bcast_;  // the frame builder's counter is the hub's one BCAST space
            const auto env = hub_broadcast(n.sim, topic, data, seeded ? 0x22 : 0x21, bcast_, o_.valid_ms);
            for (LinkKind k : {LinkKind::serial, LinkKind::tcp}) {
                if (n.session[index_of(k)]) {
                    to_node(i, k, env);
                }
            }
        }
        return bcast_;
    }

    /** A hub broadcast frame as hub_broadcast() shapes it, with an explicit EXT valid_ms. */
    static std::vector<uint8_t> hub_broadcast(HubSim &hub, std::string_view topic, std::span<const uint8_t> data, uint8_t ttl,
                                              uint32_t seq, uint32_t valid_ms)
    {
        fr::wire::ExtBuilder ext;
        ext.add_value(fr::wire::kExtValidMs, valid_ms);
        const auto body = msg_body(topic, data);
        auto out = hub.frame(fr::wire::kFlagExt, fr::wire::kClsMsg, fr::proto::kKindMsgMsg, seq, fr::proto::kAddrBroadcast,
                             0, {}, body, ext.view());
        out[16] = ttl;
        return out;
    }

    /** `count` broadcasts of `topic`, `interval_us` apart from `start`, data = the index (6 digits) padded with '.' to
     * `data_bytes`; on the hub's own core (its timer), as the router's message_send job does. */
    void start_broadcasts(fr::TimeUs start, uint32_t count, uint32_t interval_us, std::string topic, size_t data_bytes = 6)
    {
        series_ = {.topic = std::move(topic), .count = count, .interval_us = interval_us, .data_bytes = data_bytes, .next = 0};
        if (timer_ == nullptr) {
            timer_ = core_.timer([this] { tick(); });
        }
        exec_.at(start, [this] { timer_->start(0); });
    }
    bool broadcasting() const { return series_.next < series_.count; }

    /** A new hub run: epoch + 1, BCAST from 0, every session gone; a held serial port closes and opens `gap_us` later. */
    void restart(uint32_t gap_us)
    {
        ++o_.epoch;
        bcast_ = 0;
        tokens_ = o_.flood_burst;
        for (size_t i = 0; i < nodes_.size(); ++i) {
            Node &n = *nodes_[i];
            n.sim = HubSim(n.sim.node, o_.net);
            n.sim.epoch = o_.epoch;
            n.session = {false, false};
            HubLink &serial = *n.links[index_of(LinkKind::serial)];
            if (serial.is_up) {
                serial.is_up = false;
                n.net->link_changed(LinkKind::serial);
                exec_.at(exec_.now() + gap_us, [this, i] {
                    Node &m = *nodes_[i];
                    m.links[index_of(LinkKind::serial)]->is_up = true;
                    m.net->link_changed(LinkKind::serial);
                });
            }
        }
    }

    uint16_t epoch() const { return o_.epoch; }
    uint32_t bcast() const { return bcast_; }
    bool session(size_t node, LinkKind k) const { return nodes_[node]->session[index_of(k)]; }
    size_t nodes() const { return nodes_.size(); }

    /** Sends `env` to `node` over `kind` after the downlink latency (dropped if the link is down by then). */
    void to_node(size_t node, LinkKind kind, std::vector<uint8_t> env)
    {
        Node &n = *nodes_[node];
        account_ip(env.size());
        ++stats.frames_out;
        const fr::TimeUs at = when(n, kind, 0);
        const uint32_t gen = n.core->generation();
        exec_.at(at, [this, node, kind, gen, bytes = std::move(env)] {
            Node &m = *nodes_[node];
            if (m.core->generation() == gen && m.links[index_of(kind)]->is_up) {
                m.net->receive(kind, bytes);
            }
        });
    }

    Stats stats;

private:
    struct Node {
        fr::net::Net *net;
        frsim::SimCore *core;
        fr::net::Mac mac;
        HubSim sim;
        std::array<HubLink *, 2> links;  // by LinkKind serial, tcp
        std::array<bool, 2> session;
        std::array<std::array<fr::TimeUs, 2>, 2> last;  // [link][0 down, 1 up]: in order per link and direction
        uint64_t frames;
    };

    struct Series {
        std::string topic;
        uint32_t count = 0;
        uint32_t interval_us = 0;
        size_t data_bytes = 6;
        uint32_t next = 0;
    };

    fr::TimeUs when(Node &n, LinkKind kind, size_t dir)
    {
        const uint32_t spread = o_.lat_max_us > o_.lat_min_us ? o_.lat_max_us - o_.lat_min_us : 0;
        const fr::net::Mac &from = dir == 1 ? n.mac : kHubMac;
        const fr::net::Mac &to = dir == 1 ? kHubMac : n.mac;
        const fr::TimeUs lat = o_.lat_min_us + frsim::rng::upto(o_.seed, from, ++n.frames, to, frsim::rng::Purpose::link_latency, spread);
        fr::TimeUs &last = n.last[index_of(kind)][dir];
        last = std::max(exec_.now() + lat, last + 1);
        return last;
    }

    void account_ip(size_t bytes)
    {
        if (o_.ip_medium != nullptr) {
            o_.ip_medium->account_ip(o_.channel, bytes + 42, o_.ip_mbps);
        }
    }

    void tick()
    {
        if (series_.next >= series_.count) {
            return;
        }
        std::string data = std::to_string(series_.next);
        data.insert(0, data.size() < 6 ? 6 - data.size() : 0, '0');
        if (data.size() < series_.data_bytes) {
            data.append(series_.data_bytes - data.size(), '.');
        }
        broadcast(series_.topic, std::span<const uint8_t>(reinterpret_cast<const uint8_t *>(data.data()), data.size()));
        if (++series_.next < series_.count) {
            timer_->start(series_.interval_us);
        }
    }

    void from_node(size_t node, LinkKind kind, const std::vector<uint8_t> &env)
    {
        Node &n = *nodes_[node];
        ++stats.frames_in;
        auto e = fr::wire::unpack_envelope(env);
        if (!e) {
            return;
        }
        const fr::wire::Header &h = e->header;
        const size_t k = index_of(kind);
        if (h.cls == fr::wire::kClsPresence && h.kind == fr::proto::kKindPresenceHello) {
            ++stats.hellos;
            ++stats.welcomes;
            n.session[k] = true;
            n.sim.bcast = bcast_;
            to_node(node, kind, n.sim.welcome(0, bcast_));
            return;
        }
        if (!n.session[k]) {
            return;  // outside a session the router drops everything but HELLO
        }
        if (h.cls == fr::wire::kClsPresence && h.kind == fr::proto::kKindPresenceBye) {
            n.session[k] = false;
            return;
        }
        if (h.cls == fr::wire::kClsPresence && h.kind == fr::proto::kKindPresenceHeartbeat) {
            to_node(node, kind, n.sim.ack(h.epoch, h.seq));  // the echo: the session's keepalive
            return;
        }
        if ((h.flags & fr::wire::kFlagAckReq) != 0 && h.dst == fr::proto::kAddrHub) {
            to_node(node, kind, n.sim.ack(h.epoch, h.seq));
        }
        if (o_.fan_out && h.dst == fr::proto::kAddrBroadcast && (h.ttl & 0x0F) > 1) {
            auto copy = env;
            copy[16] = static_cast<uint8_t>((h.ttl & 0xF0) | 1);
            for (size_t i = 0; i < nodes_.size(); ++i) {
                if (i == node) {
                    continue;
                }
                for (LinkKind lk : {LinkKind::serial, LinkKind::tcp}) {
                    if (nodes_[i]->session[index_of(lk)]) {
                        to_node(i, lk, copy);
                    }
                }
            }
            ++stats.fanned_out;
        }
    }

    frsim::Executor &exec_;
    HubOptions o_;
    frsim::SimCore core_;
    fr::Timer *timer_ = nullptr;
    std::vector<std::unique_ptr<Node>> nodes_;
    uint32_t bcast_ = 0;
    double tokens_ = 0;
    fr::TimeUs tokens_at_ = 0;
    Series series_;
};

inline fr::Status HubLink::send(std::span<const uint8_t> envelope)
{
    if (!is_up) {
        return std::unexpected(fr::Err::busy);
    }
    if (record) {
        sent.push_back({core_.now(), {envelope.begin(), envelope.end()}});
    }
    hub_.from_node_later(node, kind_, envelope);
    return {};
}

/** A node's MAC in the fleet's locally administered range (D9): 02:f2:00:00:xx:yy. */
inline fr::net::Mac fleet_mac(uint16_t i)
{
    return {0x02, 0xf2, 0x00, 0x00, static_cast<uint8_t>(i >> 8), static_cast<uint8_t>(i)};
}

/** One node: Net on its SimCore, with serial and TCP links to the hub model and SimAir on the medium. */
struct SimNetNode {
    SimNetNode(frsim::Executor &exec, frsim::Medium &medium, HubModel &hub, uint16_t addr, const fr::net::Mac &mac,
               const fr::net::Config &cfg, frsim::Rate bcast_rate = frsim::Rate::r1m, frsim::Rate ucast_rate = frsim::Rate::r1m)
        : name("sim-" + std::to_string(addr)), core(exec, name), host(core, addr, mac), serial(hub, LinkKind::serial, core),
          tcp(hub, LinkKind::tcp, core), air(medium, core, mac, 6, bcast_rate, ucast_rate), net(core, host, cfg)
    {
        net.attach(serial);
        net.attach(tcp);
        net.attach_stores(&stores, &stores);
        air.set_net(host.id.net);
        air.set_up(true);
        air.attach(net);
        net.attach_air(air);
        index = hub.add_node(net, core, addr, mac, serial, tcp);
        host.on_msg = [this](const AirHost::Msg &m) { ++delivered[m.topic][std::string(m.data.begin(), m.data.end())]; };
    }

    HubLink &link(LinkKind k) { return k == LinkKind::serial ? serial : tcp; }
    void link_up(LinkKind k)
    {
        link(k).is_up = true;
        net.link_changed(k);
    }
    void link_down(LinkKind k)
    {
        link(k).is_up = false;
        net.link_changed(k);
    }

    /** Distinct `topic` MSGs delivered, and deliveries beyond the first of one. */
    std::pair<uint32_t, uint32_t> tally(const std::string &topic) const
    {
        const auto it = delivered.find(topic);
        if (it == delivered.end()) {
            return {0, 0};
        }
        uint32_t distinct = 0;
        uint32_t dups = 0;
        for (const auto &[data, n] : it->second) {
            ++distinct;
            dups += static_cast<uint32_t>(n - 1);
        }
        return {distinct, dups};
    }

    std::string name;
    frsim::SimCore core;
    AirHost host;
    MemStores stores;
    HubLink serial;
    HubLink tcp;
    frsim::SimAir air;
    fr::net::Net net;
    size_t index = 0;
    std::map<std::string, std::map<std::string, int>> delivered;  // topic -> data -> deliveries
};

}  // namespace frt
