// fr_net over ESP-NOW, receive side (design c5 §5; spec 05 §5.3, §5.8, §5.10): node windows per (src, epoch)
// with their LRU, the receive filter, LATEST frames, neighbour learning (only unrelayed, full-TTL frames,
// plus MAC-ACK counts), the router-mode ESP-NOW heartbeat, and the directory (NET/DIRECTORY sets, RESOLVE,
// persistence through DirectoryStore).
#include <algorithm>

#include "tests/net_air_fakes.hpp"

namespace {

using frt::AirRig;
using frt::Frame;
using frt::Peer;
using fr::net::LinkKind;
namespace wire = fr::wire;
namespace proto = fr::proto;

constexpr uint16_t kBcast = proto::kAddrBroadcast;

/** A broadcast MSG from `p` with an explicit seq (its ordinary space). */
std::vector<uint8_t> msg_seq(Peer &p, uint32_t seq, std::string_view topic = "t")
{
    return p.frame(0, wire::kClsMsg, proto::kKindMsgMsg, kBcast, 0, {}, frt::msg_body(topic), 0x22, seq);
}

}  // namespace

TEST(net_air_node_window_per_source_and_epoch)
{
    AirRig r;
    Peer p;
    // A node's broadcast MSG is delivered once, with its src (Host::msg).
    const auto m1 = p.msg(kBcast, "t", frt::bytes_of("1"));
    r.rx(m1, p.meta());
    REQUIRE_EQ(r.host.msgs.size(), 1u);
    CHECK_EQ(r.host.msgs[0].src, p.addr);
    CHECK_EQ(r.host.msgs[0].topic, "t");
    CHECK_BYTES(r.host.msgs[0].data, frt::bytes_of("1"));
    // A relay's copy and the frame again are DUPs (05 §5.8: one window per (src, epoch), whatever the path).
    Peer relay{.addr = 0x0013, .mac = {2, 0, 0, 0, 0, 0x13}};
    r.rx(frt::relayed(m1), relay.meta());
    r.rx(m1, p.meta());
    CHECK_EQ(r.host.msgs.size(), 1u);
    CHECK_EQ(r.net.state().nodes.dup, 2u);
    // Out of order inside the window: each delivered once.
    r.rx(msg_seq(p, 3), p.meta());
    r.rx(msg_seq(p, 2), p.meta());
    r.rx(msg_seq(p, 3), p.meta());
    CHECK_EQ(r.host.msgs.size(), 3u);
    // Far ahead slides the window; below its 128 bits is OLD.
    r.rx(msg_seq(p, 200), p.meta());
    r.rx(msg_seq(p, 72), p.meta());  // 200 - 128: just outside
    r.rx(msg_seq(p, 73), p.meta());  // just inside, never seen
    CHECK_EQ(r.host.msgs.size(), 5u);
    CHECK_EQ(r.net.state().nodes.old, 1u);
    // 05 §5.8: a lower epoch (an older boot of that node) is dropped; a higher one starts a new window.
    p.epoch = 2;
    r.rx(msg_seq(p, 201), p.meta());
    CHECK_EQ(r.host.msgs.size(), 5u);
    CHECK_EQ(r.net.state().nodes.old, 2u);
    p.epoch = 4;
    r.rx(msg_seq(p, 1), p.meta());
    r.rx(msg_seq(p, 1), p.meta());
    CHECK_EQ(r.host.msgs.size(), 6u);
    CHECK_EQ(r.net.state().nodes.dup, 4u);  // + the seq 3 replay and this one
    // The epoch-3 history is gone with the reboot: its frames are OLD now.
    p.epoch = 3;
    r.rx(msg_seq(p, 202), p.meta());
    CHECK_EQ(r.host.msgs.size(), 6u);
    CHECK_EQ(r.net.state().nodes.delivered, 6u);
    // Windows are per source: another node's seq 1 is its own.
    Peer q{.addr = 0x0020, .mac = {2, 0, 0, 0, 0, 0x20}};
    r.rx(msg_seq(q, 1), q.meta());
    CHECK_EQ(r.host.msgs.size(), 7u);
    CHECK_EQ(r.net.state().link(LinkKind::espnow).rx, 14u);
    CHECK_EQ(r.net.state().link(LinkKind::espnow).rx_drop, 0u);  // DUP/OLD are not bad frames
}

TEST(net_air_sources_are_kept_lru)
{
    AirRig r;
    // FR_WINDOW_SOURCES_NODE: 64 sources at once.
    std::vector<Peer> peers;
    for (uint16_t i = 0; i < 64; ++i) {
        peers.push_back(Peer{.addr = static_cast<uint16_t>(0x100 + i), .mac = {2, 0, 0, 0, 1, static_cast<uint8_t>(i)}});
        r.rx(msg_seq(peers.back(), 10), peers.back().meta());
    }
    CHECK_EQ(r.host.msgs.size(), 64u);
    // Source 0 is heard again (most recent now); a 65th source evicts the least recently heard, source 1.
    r.rx(msg_seq(peers[0], 11), peers[0].meta());
    Peer extra{.addr = 0x0200, .mac = {2, 0, 0, 0, 2, 0}};
    r.rx(msg_seq(extra, 1), extra.meta());
    CHECK_EQ(r.host.msgs.size(), 66u);
    // Source 0 is remembered: its frames are still DUPs.
    r.rx(msg_seq(peers[0], 10), peers[0].meta());
    r.rx(msg_seq(peers[0], 11), peers[0].meta());
    CHECK_EQ(r.host.msgs.size(), 66u);
    // Source 1 starts afresh at its next frame, and everything below that counts as received: a late relay
    // of an older frame is never delivered a second time. Only presumed received, so OLD, never DUP: a
    // DUP would be ACKed again.
    r.rx(msg_seq(peers[1], 12), peers[1].meta());
    r.rx(msg_seq(peers[1], 10), peers[1].meta());
    r.rx(msg_seq(peers[1], 11), peers[1].meta());
    CHECK_EQ(r.host.msgs.size(), 67u);
    CHECK_EQ(r.net.state().nodes.dup, 2u);
    CHECK_EQ(r.net.state().nodes.old, 2u);
}

TEST(net_air_frames_before_a_window_starts)
{
    AirRig r;
    Peer p;
    const uint16_t me = r.host.id.addr;
    auto reliable_msg = [&](uint32_t seq, std::string_view topic) {
        return p.frame(wire::kFlagAckReq, wire::kClsMsg, proto::kKindMsgMsg, me, 0, {}, frt::msg_body(topic), 0x22,
                       seq);
    };
    // A source new to this node: its frame 8 (a broadcast, straight over ESP-NOW) overtakes 7, a reliable
    // MSG to this node that took the hub path. Nothing says 7 was delivered here: it is OLD, not DUP, so it
    // gets no ACK for a delivery that never happened (its sender ends FAILED), nor does its retry.
    const auto m7 = reliable_msg(7, "seven");
    r.rx(msg_seq(p, 8, "eight"), p.meta());
    r.clear_sent();
    r.rx(m7, p.meta(false));
    r.rx(m7, p.meta(false));
    REQUIRE_EQ(r.host.msgs.size(), 1u);
    CHECK_EQ(r.host.msgs[0].topic, "eight");
    CHECK(r.air.of(wire::kClsAck).empty());
    CHECK_EQ(r.net.state().nodes.old, 2u);
    // A frame this node did take is a DUP, and its retry is ACKed again (the first ACK was lost).
    const auto m9 = reliable_msg(9, "nine");
    r.rx(m9, p.meta(false));
    r.rx(m9, p.meta(false));
    CHECK_EQ(r.host.msgs.size(), 2u);
    CHECK_EQ(r.air.of(wire::kClsAck).size(), 2u);
    CHECK_EQ(r.net.state().nodes.dup, 1u);
    // A newer boot of that node: none of its seqs reached this node yet, so the frame its seq 3 overtook is
    // delivered and ACKed when it arrives, and is a DUP after that.
    p.epoch = 4;
    r.clear_sent();
    const auto m2 = reliable_msg(2, "two");
    r.rx(msg_seq(p, 3, "three"), p.meta());
    r.rx(m2, p.meta(false));
    r.rx(m2, p.meta(false));
    REQUIRE_EQ(r.host.msgs.size(), 4u);
    CHECK_EQ(r.host.msgs[3].topic, "two");
    CHECK_EQ(r.air.of(wire::kClsAck).size(), 2u);
    CHECK_EQ(r.net.state().nodes.dup, 2u);
    // Its window still has 128 bits: far below the first frame of the boot is OLD.
    r.rx(msg_seq(p, 300, "late"), p.meta());
    r.rx(msg_seq(p, 100, "far"), p.meta());
    CHECK_EQ(r.host.msgs.size(), 5u);
}

TEST(net_air_receive_filter)
{
    // An unprovisioned node stays out of the ESP-NOW network: it has no net to filter on.
    {
        AirRig u(frt::air_config(), false);
        u.host.id.addr = proto::kAddrUnassigned;
        u.net.attach_air(u.air);
        Peer p;
        u.rx(p.msg(kBcast, "t"), p.meta());
        CHECK(u.host.msgs.empty());
        CHECK_EQ(u.net.state().link(LinkKind::espnow).rx_drop, 1u);
    }
    AirRig r;
    Peer p;
    Peer other_net{.net = 0x00AC};
    r.rx(other_net.msg(kBcast, "t"), other_net.meta());
    Peer self{.addr = r.host.id.addr};  // this node's own frame, back through a relay
    r.rx(frt::relayed(self.msg(kBcast, "t")), p.meta());
    r.rx(p.msg(kBcast, "t", {}, 0, 0x88), p.meta());  // initial TTL 8 > FR_TTL_MAX
    r.rx(p.msg(kBcast, "t", {}, 0, 0x23), p.meta());  // remaining above initial
    r.rx(p.msg(kBcast, "t", {}, wire::kFlagBulk), p.meta());
    Peer unassigned{.addr = proto::kAddrUnassigned};
    r.rx(unassigned.msg(kBcast, "t"), unassigned.meta());
    r.rx(frt::from_hex("a1 00 07"), p.meta());  // truncated
    const std::vector<uint8_t> raw(240, 0x00);
    const std::vector<uint8_t> big = p.frame(0, wire::kClsMsg, 0, kBcast, 0, {}, raw);
    r.rx(big, p.meta());  // beyond the 250 B ESP-NOW MTU
    // Sent to this node's MAC but for another addr: the sender's directory is stale.
    r.rx(p.msg(0x0099, "t"), p.meta(false));
    CHECK(r.host.msgs.empty());
    CHECK_EQ(r.net.state().link(LinkKind::espnow).rx, 9u);
    CHECK_EQ(r.net.state().link(LinkKind::espnow).rx_drop, 9u);
    // Only the misaddressed unicast came from a sender in range (straight, full TTL): it teaches the table.
    REQUIRE_EQ(r.net.neighbors().count, 1u);
    CHECK(r.net.neighbors().items[0].mac == p.mac);
}

TEST(net_air_latest_frames_keep_the_newest)
{
    AirRig r;
    Peer p;
    // The ESP-NOW heartbeat is LATEST (05 §5.10): its own space, newest wins.
    const auto hb1 = p.heartbeat();
    const auto hb2 = p.heartbeat();
    r.rx(hb2, p.meta());
    r.rx(hb1, p.meta());  // older: stale
    r.rx(hb2, p.meta());  // same: stale too
    CHECK_EQ(r.net.state().nodes.delivered, 1u);
    CHECK_EQ(r.net.state().nodes.old, 2u);
    // The ordinary space is apart: seq 1 of it is fresh although LATEST seq 2 was seen.
    r.rx(msg_seq(p, 1), p.meta());
    CHECK_EQ(r.host.msgs.size(), 1u);
    // Heartbeats are never relayed (TTL 1); the MSG broadcast is (TTL 2).
    r.core.advance_ms(50);
    for (const frt::AirTx &t : r.air.sent) {
        const Frame f = t.frame();
        CHECK(f.src != p.addr || f.cls == wire::kClsMsg);
    }
}

TEST(net_air_neighbors_learn_from_unrelayed_full_ttl_frames)
{
    AirRig r;
    Peer p;
    r.core.advance_ms(10);
    r.rx(p.heartbeat(), p.meta(true, -48));
    auto n = r.net.neighbors();
    REQUIRE_EQ(n.count, 1u);
    CHECK(n.items[0].mac == p.mac);
    CHECK_EQ(n.items[0].addr, p.addr);
    CHECK_EQ(n.items[0].rssi, -48);
    CHECK_EQ(n.items[0].last_heard, r.core.now());
    // A relayed frame carries the relay's MAC, a frame below its initial TTL came through someone: neither
    // says who is in range (05 §5.10).
    Peer q{.addr = 0x0030, .mac = {2, 0, 0, 0, 0, 0x30}};
    Peer relay{.addr = 0x0031, .mac = {2, 0, 0, 0, 0, 0x31}};
    r.rx(frt::relayed(q.msg(kBcast, "t")), relay.meta());
    r.rx(q.msg(kBcast, "t", {}, 0, 0x21), q.meta());
    CHECK_EQ(r.net.neighbors().count, 1u);
    // Heard again: RSSI and time follow.
    r.core.advance_ms(10);
    r.rx(p.msg(kBcast, "t"), p.meta(true, -70));
    n = r.net.neighbors();
    CHECK_EQ(n.items[0].rssi, -70);
    CHECK_EQ(n.items[0].last_heard, r.core.now());
    // MAC ACKs of unicasts to it count, and refresh it (the MAC came from the neighbour table: no directory).
    r.clear_sent();
    r.core.advance_ms(10);
    REQUIRE(r.net.send_to_node(p.addr, wire::kClsMsg, 0, 0, frt::msg_body("a"), fr::net::Delivery::fast));
    auto u = r.air.unicasts();
    REQUIRE_EQ(u.size(), 1u);
    CHECK(u[0].dst == p.mac);
    r.complete(u[0], true);
    REQUIRE(r.net.send_to_node(p.addr, wire::kClsMsg, 0, 0, frt::msg_body("b"), fr::net::Delivery::fast));
    u = r.air.unicasts();
    REQUIRE_EQ(u.size(), 2u);
    r.complete(u[1], false);
    n = r.net.neighbors();
    CHECK_EQ(n.items[0].ack_ok, 1u);
    CHECK_EQ(n.items[0].ack_fail, 1u);
    CHECK_EQ(n.items[0].last_heard, r.core.now());
    // At most 20; the least recently heard goes first.
    for (uint8_t i = 0; i < 20; ++i) {
        r.core.advance_ms(1);
        Peer x{.addr = static_cast<uint16_t>(0x40 + i), .mac = {2, 0, 0, 0, 3, i}};
        r.rx(x.heartbeat(), x.meta());
    }
    n = r.net.neighbors();
    CHECK_EQ(n.count, fr::net::kNeighborsMax);
    CHECK(std::none_of(n.items.begin(), n.items.end(), [&](const fr::net::Neighbor &x) { return x.mac == p.mac; }));
}

TEST(net_air_heartbeat_every_5s)
{
    AirRig r;
    r.session(LinkKind::tcp);
    const uint32_t state_seq = r.net.state().state_seq;
    r.core.advance_ms(60'000);
    auto hbs = r.air.of(wire::kClsPresence);
    REQUIRE(hbs.size() >= 10u);
    REQUIRE(hbs.size() <= 16u);
    // The first within one interval of the air coming up, then every 5 s +-20 % (05 §5.10).
    CHECK(hbs[0].at - 1'000'000 <= 5'000'000);
    for (size_t i = 1; i < hbs.size(); ++i) {
        const fr::TimeUs gap = hbs[i].at - hbs[i - 1].at;
        CHECK(gap >= 4'000'000);
        CHECK(gap <= 6'000'000);
    }
    for (const frt::AirTx &t : hbs) {
        const Frame f = t.frame();
        CHECK(t.broadcast());
        CHECK(f.is(wire::kClsPresence, proto::kKindPresenceHeartbeat));
        CHECK_EQ(f.flags, wire::kFlagLatest);
        CHECK_EQ(f.ttl, 0x11);
        CHECK_EQ(f.dst, kBcast);
        CHECK_EQ(f.src, r.host.id.addr);
        CHECK(proto::decode_presence_heartbeat(f.body).has_value());
    }
    // LATEST seqs that never go to the hub do not move state_seq (05 §5.8), and none went over TCP.
    CHECK_EQ(r.net.state().state_seq, state_seq);
    for (const Frame &f : r.tcp.frames(wire::kClsPresence, proto::kKindPresenceHeartbeat)) {
        CHECK_EQ(f.ttl, 0x22);
    }
    // Air down: none; up again: they resume (without a hub session too).
    r.down(LinkKind::tcp);
    r.air.is_up = false;
    r.net.link_changed(LinkKind::espnow);
    const size_t before = r.air.sent.size();
    r.core.advance_ms(20'000);
    CHECK_EQ(r.air.sent.size(), before);
    r.air.is_up = true;
    r.net.link_changed(LinkKind::espnow);
    r.core.advance_ms(11'000);
    CHECK(r.air.of(wire::kClsPresence).size() >= hbs.size() + 2);
}

TEST(net_air_wifi_up_neighbors_are_noted)
{
    AirRig r;
    Peer p;
    auto heartbeat = [&](uint32_t state) {
        return p.frame(wire::kFlagLatest, wire::kClsPresence, proto::kKindPresenceHeartbeat, kBcast, 0, {},
                       frt::HubSim::body_of(proto::PresenceHeartbeat{.uptime_s = 8, .state = state}), 0x11);
    };
    CHECK_EQ(r.net.wifi_up_neighbor_heard_at(), 0);
    // A neighbour whose Wi-Fi is down says nothing about where the AP is.
    r.rx(heartbeat(fr::net::kStateHubLink), p.meta());
    CHECK_EQ(r.net.wifi_up_neighbor_heard_at(), 0);
    // One with Wi-Fi up is associated on this channel: noted, with the time (05 §5.4, the sweep rule).
    r.core.advance_ms(10);
    r.rx(heartbeat(fr::net::kStateWifiUp | fr::net::kStateHubLink), p.meta());
    const fr::TimeUs at = r.core.now();
    CHECK_EQ(r.net.wifi_up_neighbor_heard_at(), at);
    // Its later heartbeat without the bit, and a stale copy with it, leave that time as it was.
    r.core.advance_ms(10);
    const auto stale = heartbeat(fr::net::kStateWifiUp);
    r.rx(heartbeat(0), p.meta());
    r.rx(stale, p.meta());
    CHECK_EQ(r.net.wifi_up_neighbor_heard_at(), at);
    // What another node's Net puts on the air carries the bit as its Wi-Fi says.
    AirRig other(frt::air_config(1), false);
    other.host.id.addr = 0x0031;
    other.host.hello.mac = {2, 0, 0, 0, 0, 0x31};
    other.net.attach_air(other.air);
    other.core.advance_ms(6000);
    auto sent = other.air.of(wire::kClsPresence);
    REQUIRE(!sent.empty());
    r.core.advance_ms(10);
    r.rx(sent.back().bytes, Peer{.addr = 0x0031, .mac = other.host.hello.mac}.meta());
    CHECK_EQ(r.net.wifi_up_neighbor_heard_at(), r.core.now());
}

TEST(net_air_jitter_waits_for_the_mac)
{
    // fr_core attaches the air before its HELLO facts (the MAC) exist: a seed taken from that all-zero MAC
    // would give every node the same heartbeat times and relay delays.
    auto air_heartbeats = [](uint8_t last) {
        fr::net::Config cfg = frt::air_config();
        cfg.rng_seed = 0;
        AirRig r(cfg, false);
        r.host.hello.mac = {};
        r.net.attach_air(r.air);
        r.host.hello.mac = {0xAA, 0xBB, 0xCC, 0x00, 0x00, last};
        r.session(LinkKind::tcp);
        r.core.advance_ms(60'000);
        std::vector<fr::TimeUs> out;
        for (const frt::AirTx &t : r.air.of(wire::kClsPresence)) {
            out.push_back(t.at);
        }
        return out;
    };
    CHECK(air_heartbeats(1) == air_heartbeats(1));
    CHECK(air_heartbeats(1) != air_heartbeats(2));
}

TEST(net_air_directory_sets_replace_and_persist)
{
    AirRig r;
    r.session(LinkKind::tcp);
    const uint16_t me = r.host.id.addr;
    const frt::Mac self = r.host.hello.mac;
    const frt::Mac m1{2, 0, 0, 0, 0, 0x21}, m2{2, 0, 0, 0, 0, 0x22}, m3{2, 0, 0, 0, 0, 0x23};
    // Two pages: nothing changes before the set is complete. The hub's sets list every provisioned device,
    // this node included.
    r.directory(LinkKind::tcp, {{me, self}, {0x21, m1}}, 0, 2);
    CHECK_EQ(r.net.directory().count, 0u);
    CHECK_EQ(r.stores.dir_saves, 0);
    r.directory(LinkKind::tcp, {{0x22, m2}, {0x23, m3}}, 1, 2);
    REQUIRE_EQ(r.net.directory().count, 4u);
    CHECK(r.net.directory().find(0x22)->mac == m2);
    CHECK_EQ(r.stores.dir_saves, 1);
    // The same set again (every WELCOME, every registry change): not written again (NVS wear).
    r.directory(LinkKind::tcp, {{me, self}, {0x21, m1}}, 0, 2);
    r.directory(LinkKind::tcp, {{0x22, m2}, {0x23, m3}}, 1, 2);
    CHECK_EQ(r.stores.dir_saves, 1);
    // A set replaces the table; a page of another set waits for its page 0.
    r.directory(LinkKind::tcp, {{0x21, m1}}, 1, 3);
    CHECK_EQ(r.net.directory().count, 4u);
    r.directory(LinkKind::tcp, {{me, self}, {0x24, m1}});
    REQUIRE_EQ(r.net.directory().count, 2u);
    CHECK(r.net.directory().find(0x24) != nullptr);
    CHECK(r.net.directory().find(0x21) == nullptr);
    CHECK_EQ(r.stores.dir_saves, 2);
    CHECK_EQ(r.stores.dir.count, 2u);
    // A set without this node is not the hub's directory (nor is an empty page): it replaces nothing.
    r.directory(LinkKind::tcp, {{0x31, m1}, {0x32, m2}});
    r.directory(LinkKind::tcp, {{0x31, m1}}, 0, 2);
    r.directory(LinkKind::tcp, {{0x32, m2}}, 1, 2);
    r.directory(LinkKind::tcp, {});
    CHECK_EQ(r.net.directory().count, 2u);
    CHECK_EQ(r.stores.dir_saves, 2);
    // Entries that are no node or carry no 6-byte MAC are skipped.
    r.directory(LinkKind::tcp, {{0x0000, m1}, {0xFFFF, m2}, {me, self}, {0x25, m3}});
    CHECK_EQ(r.net.directory().count, 2u);
    CHECK(r.net.directory().find(0x25) != nullptr);
    // Beyond FR_DIRECTORY_MAX the table keeps the first 64; this node listed after them still makes the set
    // the hub's.
    {
        AirRig big;
        big.session(LinkKind::tcp);
        for (uint8_t page = 0; page < 5; ++page) {
            std::vector<std::pair<uint16_t, frt::Mac>> entries;
            for (uint8_t i = 0; i < 14 && page * 14 + i < 64; ++i) {
                const auto n = static_cast<uint8_t>(page * 14 + i);
                entries.push_back({static_cast<uint16_t>(0x100 + n), frt::Mac{2, 0, 0, 0, 1, n}});
            }
            if (page == 4) {
                entries.push_back({big.host.id.addr, big.host.hello.mac});
            }
            big.directory(LinkKind::tcp, entries, page, 5);
        }
        CHECK_EQ(big.net.directory().count, fr::net::kDirectoryMax);
        CHECK(big.net.directory().find(big.host.id.addr) == nullptr);
    }

    // The next boot loads it, and unicasts with it before any hub session (bindings with the hub stopped).
    AirRig again(frt::air_config(), false);
    again.stores = r.stores;
    again.net.attach_stores(&again.stores, &again.stores);
    again.net.attach_air(again.air);
    REQUIRE(again.net.send_to_node(0x25, wire::kClsMsg, 0, 0, frt::msg_body("x"), fr::net::Delivery::fast));
    auto u = again.air.unicasts();
    REQUIRE_EQ(u.size(), 1u);
    CHECK(u[0].dst == m3);
}

TEST(net_air_resolve_asks_the_hub_for_a_missing_mac)
{
    AirRig r;
    r.session(LinkKind::tcp);
    const frt::Mac self = r.host.hello.mac;
    const frt::Mac m1{2, 0, 0, 0, 0, 0x21}, m9{2, 0, 0, 0, 0, 0x99};
    r.directory(LinkKind::tcp, {{r.host.id.addr, self}, {0x21, m1}});
    r.clear_sent();
    // No MAC for 0x99: RESOLVE {addr} to the hub, and the frame goes via the hub meanwhile (05 §5.10).
    REQUIRE(r.net.send_to_node(0x99, wire::kClsMsg, 0, 0, frt::msg_body("x"), fr::net::Delivery::fast));
    auto res = r.tcp.frames(wire::kClsNet, proto::kKindNetResolve);
    REQUIRE_EQ(res.size(), 1u);
    CHECK_EQ(res[0].dst, proto::kAddrHub);
    CHECK_EQ(frt::field_u(res[0].body, 1), 0x99u);
    auto via_hub = r.tcp.frames(wire::kClsMsg, 0);
    REQUIRE_EQ(via_hub.size(), 1u);
    CHECK_EQ(via_hub[0].dst, 0x99);
    CHECK(r.air.sent.empty());
    CHECK_EQ(r.net.state().nodes.resolves, 1u);
    CHECK_EQ(r.net.state().nodes.via_hub, 1u);
    // Not asked again within a second.
    REQUIRE(r.net.send_to_node(0x99, wire::kClsMsg, 0, 0, frt::msg_body("y"), fr::net::Delivery::fast));
    CHECK_EQ(r.tcp.count(wire::kClsNet, proto::kKindNetResolve), 1u);
    // The one-entry answer joins the table instead of replacing it.
    r.directory(LinkKind::tcp, {{0x99, m9}});
    CHECK_EQ(r.net.directory().count, 3u);
    CHECK(r.net.directory().find(0x21)->mac == m1);
    CHECK(r.net.directory().find(0x99)->mac == m9);
    r.clear_sent();
    REQUIRE(r.net.send_to_node(0x99, wire::kClsMsg, 0, 0, frt::msg_body("z"), fr::net::Delivery::fast));
    auto u = r.air.unicasts();
    REQUIRE_EQ(u.size(), 1u);
    CHECK(u[0].dst == m9);
    // An empty page 0 of 1 answering a RESOLVE says "unknown": it leaves the table as it was.
    REQUIRE(r.net.send_to_node(0x55, wire::kClsMsg, 0, 0, frt::msg_body("v"), fr::net::Delivery::fast));
    CHECK_EQ(r.tcp.count(wire::kClsNet, proto::kKindNetResolve), 1u);
    r.directory(LinkKind::tcp, {});
    CHECK_EQ(r.net.directory().count, 3u);
    // Without a hub to ask, no RESOLVE: the frame floods.
    r.down(LinkKind::tcp);
    r.clear_sent();
    REQUIRE(r.net.send_to_node(0x77, wire::kClsMsg, 0, 0, frt::msg_body("w"), fr::net::Delivery::fast));
    CHECK_EQ(r.tcp.count(wire::kClsNet, proto::kKindNetResolve), 0u);
    auto b = r.air.broadcasts();
    REQUIRE_EQ(b.size(), 1u);
    CHECK_EQ(b[0].frame().dst, 0x77);
}

TEST(net_air_resolve_answers_merge_whatever_is_outstanding)
{
    AirRig r;
    r.session(LinkKind::tcp);
    const uint16_t me = r.host.id.addr;
    const frt::Mac self = r.host.hello.mac;
    const frt::Mac m1{2, 0, 0, 0, 0, 0x21}, ma{2, 0, 0, 0, 0, 0x41}, mb{2, 0, 0, 0, 0, 0x42}, mc{2, 0, 0, 0, 0, 0x43};
    r.directory(LinkKind::tcp, {{me, self}, {0x21, m1}});
    const int saves = r.stores.dir_saves;
    r.clear_sent();
    auto send = [&](uint16_t addr) {
        REQUIRE(r.net.send_to_node(addr, wire::kClsMsg, 0, 0, frt::msg_body("x"), fr::net::Delivery::fast));
    };
    // Two unknown addrs within one round trip: each is asked about once, however the sends alternate, and
    // again only a second later (design c5 §7: once per second per addr).
    send(0x41);
    send(0x42);
    send(0x41);
    send(0x42);
    CHECK_EQ(r.tcp.count(wire::kClsNet, proto::kKindNetResolve), 2u);
    CHECK_EQ(r.net.state().nodes.resolves, 2u);
    // The answer about the addr asked first arrives after the second was asked: it joins the table, which
    // keeps every other entry, in the store too.
    r.directory(LinkKind::tcp, {{0x41, ma}});
    REQUIRE_EQ(r.net.directory().count, 3u);
    CHECK(r.net.directory().find(0x21)->mac == m1);
    CHECK(r.net.directory().find(0x41)->mac == ma);
    CHECK_EQ(r.stores.dir.count, 3u);
    r.directory(LinkKind::tcp, {{0x42, mb}});
    CHECK_EQ(r.net.directory().count, 4u);
    CHECK_EQ(r.stores.dir_saves, saves + 2);
    // A second answer (the hub answered a RESOLVE and its retry) changes nothing and writes nothing.
    r.directory(LinkKind::tcp, {{0x41, ma}});
    CHECK_EQ(r.net.directory().count, 4u);
    CHECK_EQ(r.stores.dir_saves, saves + 2);
    // An answer arriving in the middle of a page set neither replaces the table nor drops the set's pages:
    // the set completes and replaces the table as usual.
    r.directory(LinkKind::tcp, {{me, self}, {0x21, m1}}, 0, 2);
    r.directory(LinkKind::tcp, {{0x43, mc}});
    CHECK_EQ(r.net.directory().count, 5u);
    r.directory(LinkKind::tcp, {{0x41, ma}}, 1, 2);
    CHECK_EQ(r.net.directory().count, 3u);
    CHECK(r.net.directory().find(0x41) != nullptr);
    CHECK(r.net.directory().find(0x43) == nullptr);
    // Past kResolvesMax addrs within a second, the one asked longest ago is forgotten, and asked again.
    r.core.advance_ms(1100);
    r.clear_sent();
    for (uint16_t a = 0x51; a <= 0x55; ++a) {
        send(a);
        r.core.advance_ms(1);
    }
    CHECK_EQ(r.tcp.count(wire::kClsNet, proto::kKindNetResolve), 5u);
    send(0x52);
    CHECK_EQ(r.tcp.count(wire::kClsNet, proto::kKindNetResolve), 5u);
    send(0x51);
    CHECK_EQ(r.tcp.count(wire::kClsNet, proto::kKindNetResolve), 6u);
}
