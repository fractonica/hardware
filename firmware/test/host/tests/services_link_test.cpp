// EnvelopeLink: the exact EVENT/STATE/RESULT envelopes the node sends in C2 (spec 05 §5.6-5.8, design c2
// §5 Sink and CMD over serial ENV), and FakeCore's own core-task ordering.
#include <vector>

#include "fr/envelope.hpp"
#include "fr/services/button_service.hpp"
#include "fr/services/envelope_link.hpp"
#include "fr/services/led_service.hpp"
#include "tests/fake_core.hpp"
#include "tests/test.hpp"

namespace {

using frt::FakeCore;
using frt::FakeLight;

struct Rig {
    Rig()
        : link(core, [this](std::span<const uint8_t> env) { out.emplace_back(env.begin(), env.end()); }),
          led(light, {}), broken_led(broken_light, {})
    {
        link.set_origin({.net = 0, .addr = fr::EnvelopeLink::kAddrUnassigned, .epoch = 7});
        led.attach(2, "status", link);
        broken_led.attach(3, "spare", link);
        link.set_ports(ports);
    }

    bool init() { return led.init(core) && broken_led.init(core); }

    FakeCore core;
    std::vector<std::vector<uint8_t>> out;
    fr::EnvelopeLink link;
    FakeLight light{{.rgb = true, .dimmable = true}};
    FakeLight broken_light;
    fr::LedService led;
    fr::LedService broken_led;
    fr::PortEntry ports[2] = {{2, "status", &led, true}, {3, "spare", &broken_led, false}};
};

std::vector<uint8_t> cmd(uint16_t dst, uint8_t port, uint8_t kind, uint32_t seq, std::string_view body_hex)
{
    uint8_t buf[256];
    fr::wire::Writer w(buf, sizeof(buf));
    fr::wire::pack_header({.flags = fr::wire::kFlagAckReq,
                           .cls = fr::wire::kClsCmd,
                           .kind = kind,
                           .seq = seq,
                           .net = 0,
                           .src = 0x0000,
                           .dst = dst,
                           .epoch = 5,
                           .ttl = 0x22,
                           .port = port},
                          w);
    auto body = frt::from_hex(body_hex);
    w.raw(body);
    return {w.bytes().begin(), w.bytes().end()};
}

}  // namespace

TEST(link_event_envelope_bytes)
{
    Rig r;
    REQUIRE(r.init());
    // fr.button down on port 1: realtime -> URGENT, ordinary seq 1, t_us = low 32 bits of now (1 s).
    r.link.event(1, 1, fr::cap::Priority::realtime, {}, fr::cap::kNowUs);
    REQUIRE_EQ(r.out.size(), 1u);
    CHECK_BYTES(r.out[0], frt::from_hex("a1 20 03 01 01000000 0000 feff 0000 0700 22 01 40420f00"));
    // Normal priority: no flag; bulk: BULK. The ordinary seq keeps counting.
    r.link.event(1, 3, fr::cap::Priority::normal, frt::from_hex("08 02"), fr::cap::kNowUs);
    CHECK_BYTES(r.out[1], frt::from_hex("a1 00 03 03 02000000 0000 feff 0000 0700 22 01 40420f00 0802"));
    r.link.event(1, 3, fr::cap::Priority::bulk, {}, fr::cap::kNowUs);
    CHECK_EQ(r.out[2][1], fr::wire::kFlagBulk);
}

TEST(link_state_envelopes_use_latest_and_their_own_seq)
{
    Rig r;
    REQUIRE(r.init());
    r.link.event(1, 1, fr::cap::Priority::realtime, {}, fr::cap::kNowUs);
    r.core.advance_ms(1);
    r.link.property(2, 1, frt::from_hex("08 01"), fr::cap::kNowUs);
    REQUIRE_EQ(r.out.size(), 2u);
    CHECK_BYTES(r.out[1], frt::from_hex("a1 10 06 01 01000000 0000 feff 0000 0700 22 02 28460f00 0801"));
    auto env = fr::wire::unpack_envelope(r.out[1]);
    REQUIRE(env.has_value());
    CHECK_EQ(env->t_us, 1'001'000u);
}

TEST(link_t_us_is_the_emission_time_the_capability_gives)
{
    // An edge timestamp from the ISR, earlier than the core task's clock, becomes t_us; any negative
    // time (kNowUs) is stamped with now. Only the low 32 bits travel (05 §5.7).
    Rig r;
    REQUIRE(r.init());
    r.core.advance_ms(5);
    r.link.event(1, 1, fr::cap::Priority::realtime, {}, 1'000'250);
    r.link.property(1, 1, frt::from_hex("08 01"), 1'000'250);
    r.link.event(1, 1, fr::cap::Priority::realtime, {}, -7);
    r.link.event(1, 1, fr::cap::Priority::realtime, {}, (fr::TimeUs{3} << 32) + 0x12345678);
    REQUIRE_EQ(r.out.size(), 4u);
    auto t_us = [&](size_t i) { return fr::wire::unpack_envelope(r.out[i])->t_us; };
    CHECK_EQ(t_us(0), 1'000'250u);
    CHECK_EQ(t_us(1), 1'000'250u);
    CHECK_EQ(t_us(2), 1'005'000u);
    CHECK_EQ(t_us(3), 0x12345678u);
    CHECK_BYTES(r.out[0], frt::from_hex("a1 20 03 01 01000000 0000 feff 0000 0700 22 01 3a430f00"));
}

TEST(link_button_edge_time_reaches_t_us)
{
    // The ISR took the edge 1.5 ms before the core task got to it: EVENT down and STATE pressed carry
    // the edge's time, not the core task's (T-LAT measures from it).
    FakeCore core;
    std::vector<std::vector<uint8_t>> out;
    fr::EnvelopeLink link(core, [&out](std::span<const uint8_t> env) { out.emplace_back(env.begin(), env.end()); });
    frt::FakeButton src;
    fr::ButtonService button(src, {});
    button.attach(1, "boot", link);
    REQUIRE(button.init(core));
    fr::TimeUs edge = core.now() - 1500;
    src.edge(true, edge);
    core.run_ready();
    REQUIRE_EQ(out.size(), 2u);
    for (const auto &bytes : out) {
        auto env = fr::wire::unpack_envelope(bytes);
        REQUIRE(env.has_value());
        CHECK_EQ(env->t_us, static_cast<uint32_t>(edge));
    }
    CHECK_EQ(out[0][2], fr::wire::kClsEvent);
    CHECK_EQ(out[1][2], fr::wire::kClsState);
}

TEST(link_cmd_is_dispatched_and_answered_with_a_result)
{
    Rig r;
    REQUIRE(r.init());
    // fr.led set {on: true} to port 2, addressed to the unassigned node.
    CHECK(r.link.receive(cmd(0xFFFE, 2, 1, 42, "08 01")));
    CHECK(r.led.on());
    REQUIRE_EQ(r.out.size(), 2u);  // STATE on=1, then the RESULT
    CHECK_EQ(r.out[0][2], fr::wire::kClsState);
    CHECK_BYTES(r.out[1], frt::from_hex("a1 00 05 01 01000000 0000 feff 0000 0700 22 02 0500 2a000000 00"));
    CHECK_EQ(r.link.stats().cmds, 1u);
}

TEST(link_cmd_failures_map_to_status_codes)
{
    Rig r;
    REQUIRE(r.init());
    CHECK(r.link.receive(cmd(0xFFFE, 9, 1, 1, "")));  // no such port
    CHECK(r.link.receive(cmd(0xFFFE, 3, 1, 2, "")));  // init failed
    CHECK(r.link.receive(cmd(0xFFFE, 2, 7, 3, "")));  // unknown command
    CHECK(r.link.receive(cmd(0xFFFE, 2, 1, 4, "08 05")));  // bool out of range
    REQUIRE_EQ(r.out.size(), 4u);
    auto status = [&](size_t i) { return fr::wire::unpack_envelope(r.out[i])->result.status; };
    CHECK_EQ(status(0), 8);  // NOT_FOUND
    CHECK_EQ(status(1), 4);  // FAILED
    CHECK_EQ(status(2), 1);  // UNSUPPORTED
    CHECK_EQ(status(3), 2);  // INVALID_ARGS
    CHECK_EQ(fr::wire::unpack_envelope(r.out[3])->result.req_seq, 4u);
}

TEST(link_ignores_what_is_not_addressed_to_it)
{
    Rig r;
    REQUIRE(r.init());
    CHECK(r.link.receive(cmd(0x0007, 2, 1, 1, "08 01")));  // another node
    CHECK(r.link.receive(cmd(0xFFFF, 2, 1, 2, "08 01")));  // broadcast to a non-0 port
    CHECK(!r.led.on());
    CHECK(r.out.empty());
    CHECK_EQ(r.link.stats().ignored, 2u);
    CHECK(!r.link.receive(frt::from_hex("a2 00 04 01")));  // not an envelope
    CHECK_EQ(r.link.stats().bad, 1u);
}

TEST(link_broadcast_to_port_zero_runs_without_a_result)
{
    Rig r;
    REQUIRE(r.init());
    fr::PortEntry ports[1] = {{0, "node", &r.led, true}};  // stands in for fr.node
    r.link.set_ports(ports);
    CHECK(r.link.receive(cmd(0xFFFF, 0, 1, 1, "08 01")));
    CHECK(r.led.on());
    REQUIRE_EQ(r.out.size(), 1u);  // only the STATE frame
    CHECK_EQ(r.out[0][2], fr::wire::kClsState);
}

TEST(link_uses_the_provisioned_origin)
{
    Rig r;
    REQUIRE(r.init());
    r.link.set_origin({.net = 0xA113, .addr = 0x0007, .epoch = 0x0102});
    CHECK(r.link.receive(cmd(0x0007, 2, 2, 9, "")));  // toggle, addressed to addr 7
    REQUIRE_EQ(r.out.size(), 2u);
    auto env = fr::wire::unpack_envelope(r.out[1]);
    REQUIRE(env.has_value());
    CHECK_EQ(env->header.net, 0xA113);
    CHECK_EQ(env->header.src, 0x0007);
    CHECK_EQ(env->header.epoch, 0x0102);
    CHECK_EQ(env->result.req_epoch, 5);
    CHECK(r.link.receive(cmd(0xFFFE, 2, 2, 10, "")));  // the unassigned address is no longer ours
    CHECK_EQ(r.out.size(), 2u);
}

TEST(fake_core_runs_inputs_then_timers_then_posts)
{
    FakeCore core;
    std::vector<int> order;
    fr::Timer *t = core.timer([&] { order.push_back(2); });
    fr::InputSlot *s = core.input_slot([&](const fr::InputSample &smp) { order.push_back(smp.edges == 2 ? 1 : -1); });
    REQUIRE(t != nullptr && s != nullptr);
    CHECK(core.post([&] { order.push_back(3); }));
    t->start(0);
    s->update_from_isr(true, core.now());
    s->update_from_isr(false, core.now());
    core.run_ready();
    CHECK(order == std::vector<int>({1, 2, 3}));
    CHECK(!t->running());
}

TEST(fake_core_timers_fire_in_deadline_order_at_their_time)
{
    FakeCore core;
    std::vector<fr::TimeUs> fired;
    fr::Timer *a = core.timer([&] { fired.push_back(core.now()); });
    fr::Timer *b = core.timer([&] { fired.push_back(-core.now()); });
    fr::TimeUs t0 = core.now();
    a->start(3000);
    b->start(1000);
    a->start(2000);  // restart replaces the first deadline
    core.advance_ms(10);
    CHECK(fired == std::vector<fr::TimeUs>({-(t0 + 1000), t0 + 2000}));
    b->start(500);
    b->stop();
    core.advance_ms(10);
    CHECK_EQ(fired.size(), 2u);
}

TEST(fake_core_pools_are_bounded)
{
    FakeCore core;
    for (size_t i = 0; i < FakeCore::kPosts; ++i) {
        CHECK(core.post([] {}));
    }
    CHECK(!core.post([] {}));
    for (size_t i = 0; i < FakeCore::kSlots; ++i) {
        CHECK(core.input_slot([](const fr::InputSample &) {}) != nullptr);
    }
    CHECK(core.input_slot([](const fr::InputSample &) {}) == nullptr);
}
