// The fr_net contract of the C3 and C5 foundations (design c3 §3, c5 §3): the Link, AirLink, Host and store
// interfaces can be implemented as declared, Net keeps its link table (ESP-NOW included) and its binding
// table. The rules themselves are stream N1's net_*.cpp tests.
#include <vector>

#include "fr/net/net.hpp"
#include "fr/wire.hpp"
#include "messages.hpp"
#include "tests/fake_core.hpp"
#include "tests/test.hpp"

namespace {

using fr::net::LinkKind;

class StubLink final : public fr::net::Link
{
public:
    explicit StubLink(LinkKind k) : kind_(k) {}
    LinkKind kind() const override { return kind_; }
    bool up() const override { return up_; }
    fr::Status send(std::span<const uint8_t> envelope) override
    {
        sent.emplace_back(envelope.begin(), envelope.end());
        return {};
    }

    bool up_ = false;
    std::vector<std::vector<uint8_t>> sent;

private:
    LinkKind kind_;
};

class StubHost final : public fr::net::Host
{
public:
    fr::Status dispatch(uint8_t, uint8_t, std::span<const uint8_t>, fr::cap::Reply &) override
    {
        return std::unexpected(fr::Err::not_found);
    }
    void report_all() override {}
    fr::net::HelloInfo hello_info() override { return {}; }
    fr::net::Identity identity() override { return {}; }
    fr::net::LinkInfo link_info() override { return {}; }
    fr::net::Vitals vitals() override { return {}; }
    void ota_frame(LinkKind, const fr::wire::Header &, std::span<const uint8_t>, fr::net::OtaReply &) override {}
};

class StubAir final : public fr::net::AirLink
{
public:
    bool up() const override { return up_; }
    fr::Status send(const fr::net::Mac &, std::span<const uint8_t>, fr::net::AirPrio, uint32_t) override
    {
        return std::unexpected(fr::Err::busy);
    }

    bool up_ = false;
};

/** In-memory stores: what the node keeps in nvs:fr_dir and nvs:fr_bind. */
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
    int binding_saves = 0;
};

// schema/vectors/messages.json Binding.nn_boot_down_blink, Binding.msg_ping_broadcast_pong and BindingList.two.
constexpr const char *kBindingNn = "1001 1803 2001 3206a0b1c2d3e4f5 3834 4002 4804 5003 62021801 6801";
constexpr const char *kBindingMsg = "080f 1807 2a0470696e67 38ffff03 4807 5a04706f6e67 62027b7d";
constexpr const char *kBindingListTwo =
    "0a1c 1001 1803 2001 3206a0b1c2d3e4f5 3834 4002 4804 5003 62021801 6801"
    "0a1a 080f 1807 2a0470696e67 38ffff03 4807 5a04706f6e67 62027b7d";

}  // namespace

TEST(fr_net_skeleton_tracks_links)
{
    frt::FakeCore core;
    StubHost host;
    fr::net::Net net(core, host, fr::net::Config{});
    StubLink tcp(LinkKind::tcp);
    net.attach(tcp);
    CHECK(net.state().link(LinkKind::tcp).attached);
    CHECK(!net.state().link(LinkKind::tcp).up);
    CHECK(!net.state().link(LinkKind::serial).attached);
    tcp.up_ = true;
    net.link_changed(LinkKind::tcp);
    CHECK(net.state().link(LinkKind::tcp).up);
    CHECK(!net.state().hub_link());

    // Defaults are the Kconfig defaults (design c3 §6); an unprovisioned identity is UNASSIGNED.
    const fr::net::Config cfg;
    CHECK_EQ(cfg.heartbeat_ms, 1000u);
    CHECK_EQ(cfg.offline_x10, 35);
    CHECK_EQ(cfg.max_attempts, 4);
    CHECK_EQ(fr::net::Identity{}.addr, 0xFFFE);
    CHECK(fr::net::Identity{}.alias_view().empty());
}

TEST(fr_net_c5_skeleton_espnow_link)
{
    // design c5 §2: LinkKind::espnow = 3 (m2-c4-gateway D10 adds gateway = 4: five link kinds).
    static_assert(fr::net::index_of(LinkKind::espnow) == 3 && fr::net::kLinkKinds == 5);
    frt::FakeCore core;
    StubHost host;
    fr::net::Net net(core, host, fr::net::Config{});
    // A Link that claims to be ESP-NOW is refused: ESP-NOW frames need RxMeta and send completions.
    StubLink fake(LinkKind::espnow);
    net.attach(fake);
    CHECK(!net.state().link(LinkKind::espnow).attached);

    StubAir air;
    net.attach_air(air);
    CHECK(net.state().link(LinkKind::espnow).attached);
    CHECK(!net.state().link(LinkKind::espnow).up);
    air.up_ = true;
    net.link_changed(LinkKind::espnow);
    CHECK(net.state().link(LinkKind::espnow).up);
    CHECK(!net.state().link(LinkKind::espnow).session);
    CHECK(!net.state().hub_link());

    // The skeleton counts and drops what the air brings (stream N1 delivers it).
    const auto env = frt::from_hex("a10007002800000002011200ffff030022000a04706f6e6712027b7d");  // msg.flood_node_origin
    net.receive_air(env, fr::net::RxMeta{.src_mac = {2, 0, 0, 0, 0, 0x12}, .to_broadcast = true, .rssi = -40, .channel = 6});
    CHECK_EQ(net.state().link(LinkKind::espnow).rx, 1u);
    CHECK_EQ(net.state().link(LinkKind::espnow).rx_drop, 1u);
    net.air_sent(1, true);

    // Node <-> node sends name a node address.
    CHECK(net.send_to_node(fr::proto::kAddrBroadcast, fr::wire::kClsMsg, 0, 0, {}, fr::net::Delivery::fast).error() ==
          fr::Err::invalid_args);
    CHECK(net.send_to_node(fr::proto::kAddrHub, fr::wire::kClsCmd, 3, 2, {}, fr::net::Delivery::reliable).error() ==
          fr::Err::invalid_args);

    // Defaults of design c5 §7 (spec 05 §5.17).
    const fr::net::Config cfg;
    CHECK_EQ(cfg.ttl_default, 2);
    CHECK_EQ(cfg.ttl_max, 7);
    CHECK_EQ(cfg.ack_per_hop_ms, 10u);
    CHECK_EQ(cfg.espnow_hb_ms, 5000u);
    CHECK(cfg.relay.enabled);
    CHECK_EQ(cfg.relay.k, 2);
    CHECK_EQ(cfg.relay.jmin_ms, 1u);
    CHECK_EQ(cfg.relay.jmax_ms, 16u);
    CHECK_EQ(fr::net::kDirectoryMax, 64u);
    CHECK_EQ(fr::net::kBindingsMax, 16u);
    CHECK_EQ(fr::net::kNeighborsMax, 20u);
    CHECK_EQ(net.neighbors().count, 0u);
    CHECK_EQ(net.msg_stats().other, 0u);
    CHECK_EQ(net.state().bcast.watermark, 0u);  // the hub BCAST window's, before any WELCOME
}

TEST(fr_net_c5_skeleton_binding_table)
{
    frt::FakeCore core;
    StubHost host;
    MemStores stores;
    fr::net::Net net(core, host, fr::net::Config{});
    net.attach_stores(&stores, &stores);
    CHECK(!stores.has_bindings);

    // bind_set's args are an encoded Binding; the table keeps them by slot and saves on every change.
    REQUIRE(net.set_binding(frt::from_hex(kBindingMsg)));
    REQUIRE(net.set_binding(frt::from_hex(kBindingNn)));
    CHECK_EQ(stores.binding_saves, 2);
    CHECK(net.bindings()[0].used && net.bindings()[15].used && !net.bindings()[1].used);
    uint8_t buf[fr::proto::BindingList::kMaxSize];
    auto list = net.encode_bindings(buf);
    REQUIRE(list.has_value());
    CHECK_BYTES(*list, frt::from_hex(kBindingListTwo));
    // Too small for the list: failed, as bind_list answers it.
    CHECK(net.encode_bindings(std::span<uint8_t>(buf, 10)).error() == fr::Err::failed);

    // Refused: slot 16, on_cls not EVENT|MSG, to_cls not CMD|MSG, a short MAC, bytes that do not decode.
    CHECK(net.set_binding(frt::from_hex("0810 1803 4804")).error() == fr::Err::invalid_args);
    CHECK(net.set_binding(frt::from_hex("0801 1804 4804")).error() == fr::Err::invalid_args);
    CHECK(net.set_binding(frt::from_hex("0801 1803 4805")).error() == fr::Err::invalid_args);
    CHECK(net.set_binding(frt::from_hex("0801 1803 4804 3203010203")).error() == fr::Err::invalid_args);
    CHECK(net.set_binding(frt::from_hex("08")).error() == fr::Err::invalid_args);
    CHECK_EQ(stores.binding_saves, 2);

    // A node that boots again loads the table, and drops slots it cannot fire (another firmware's bytes).
    stores.bindings[3] = {.used = true, .len = 2, .bytes = {0x08, 0x05}};  // claims slot 5 in slot 3
    fr::net::Net again(core, host, fr::net::Config{});
    again.attach_stores(nullptr, &stores);
    CHECK(again.bindings()[0].used && again.bindings()[15].used && !again.bindings()[3].used);
    CHECK_BYTES(again.bindings()[0].encoded(), frt::from_hex(kBindingNn));

    // bind_clear: one slot, then every slot with 255; other slots are invalid.
    REQUIRE(net.clear_binding(15));
    CHECK(!net.bindings()[15].used && net.bindings()[0].used);
    CHECK(net.clear_binding(16).error() == fr::Err::invalid_args);
    REQUIRE(net.clear_binding(fr::net::kBindSlotAll));
    CHECK(std::none_of(net.bindings().begin(), net.bindings().end(), [](const fr::net::BindingSlot &x) { return x.used; }));
    list = net.encode_bindings(buf);
    REQUIRE(list.has_value());
    CHECK(list->empty());

    // The directory comes back from its store.
    stores.dir.entries[0] = {.addr = 0x0034, .mac = {0xa0, 0xb1, 0xc2, 0xd3, 0xe4, 0xf5}};
    stores.dir.count = 1;
    stores.has_dir = true;
    fr::net::Net third(core, host, fr::net::Config{});
    third.attach_stores(&stores, nullptr);
    REQUIRE(third.directory().find(0x0034) != nullptr);
    CHECK_EQ(third.directory().find(0x0034)->mac[5], 0xf5);
    CHECK(third.directory().find(0x0035) == nullptr);
}

TEST(fr_net_m2c4_gateway_link_kind)
{
    // design m2-c4-gateway D10: LinkKind::gateway = 4 has its State::links row; attach() refuses a gateway Link
    // until GatewayLink and the D12 rules exist, so nothing changes for the other links.
    static_assert(fr::net::index_of(LinkKind::gateway) == 4 && fr::net::kLinkKinds == 5);
    frt::FakeCore core;
    StubHost host;
    fr::net::Net net(core, host, fr::net::Config{});
    StubLink gw(LinkKind::gateway);
    gw.up_ = true;
    net.attach(gw);
    net.link_changed(LinkKind::gateway);
    core.advance_ms(2000);
    CHECK(!net.state().link(LinkKind::gateway).attached);
    CHECK(!net.state().link(LinkKind::gateway).session);
    CHECK(gw.sent.empty());  // no HELLO over it
    CHECK(!net.state().hub_link());
}
