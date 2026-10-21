// The fr_net contract of the C3 foundation (design c3 §3): the Link and Host interfaces can be implemented
// as declared and Net keeps its link table. The rules themselves are stream N1's net_*.cpp tests.
#include <vector>

#include "fr/net/net.hpp"
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
};

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
