// fixture_gpio's IDF-free parts (design m2-c1-hil D4, D11): the edge ring and its overflow counts, the press
// Plan its segment timer runs (segments to line levels, the cap cut, the cap release), the pin levels per
// drive, and which lines take the any-edge interrupt.
#include <array>
#include <cstdint>
#include <string>
#include <vector>

#include "edge_ring.hpp"
#include "fr/drv/fixture_gpio.hpp"
#include "tests/test.hpp"

namespace {

using fr::drv::FixtureGpio;
using fr::drv::fixture::EdgeRing;
using fr::drv::fixture::RingEdge;
using fr::hal::FixtureDecode;
using fr::hal::FixtureDrive;
using fr::hal::FixtureLineMode;

/** A plan as "80000:0 180000:1 260000:0" (boundary offset : pressed after it). */
std::string show(const FixtureGpio::Plan &p)
{
    std::string out;
    for (size_t i = 0; i < p.n; ++i) {
        out += (i ? " " : "") + std::to_string(p.ends[i]) + ":" + (p.pressed_after(i) ? "1" : "0");
    }
    return out;
}

std::expected<FixtureGpio::Plan, fr::Err> plan(std::vector<uint32_t> segments, uint32_t cap_us = 15'000'000)
{
    return FixtureGpio::Plan::make(segments, cap_us);
}

}  // namespace

// ---- the edge ring ----

TEST(fixture_ring_is_fifo_across_lines)
{
    EdgeRing<8, 4> ring;
    CHECK(ring.empty());
    CHECK(ring.push(100, 0, false));
    CHECK(ring.push(105, 2, true));
    CHECK(ring.push(110, 0, true));
    CHECK_EQ(ring.size(), 3u);
    RingEdge e{};
    REQUIRE(ring.pop(e));
    CHECK_EQ(e.t_us, 100u);
    CHECK_EQ(e.ch, 0u);
    CHECK_EQ(e.level, 0u);
    REQUIRE(ring.pop(e));
    CHECK_EQ(e.t_us, 105u);
    CHECK_EQ(e.ch, 2u);
    CHECK_EQ(e.level, 1u);
    REQUIRE(ring.pop(e));
    CHECK_EQ(e.t_us, 110u);
    CHECK(!ring.pop(e));
}

TEST(fixture_ring_counts_overflows_per_line)
{
    EdgeRing<256, 16> ring;  // the driver's
    CHECK_EQ(decltype(ring)::kCapacity, 256u);
    for (uint32_t i = 0; i < 256; ++i) {
        CHECK(ring.push(i, static_cast<uint8_t>(i % 2), (i & 1) != 0));
    }
    // Full: the new edge is dropped on its own line, and what the ring holds stays.
    CHECK(!ring.push(1000, 1, true));
    CHECK(!ring.push(1001, 1, false));
    CHECK(!ring.push(1002, 5, true));
    CHECK_EQ(ring.size(), 256u);
    CHECK_EQ(ring.take_dropped(0), 0u);
    CHECK_EQ(ring.take_dropped(1), 2u);
    CHECK_EQ(ring.take_dropped(1), 0u);  // taken
    CHECK_EQ(ring.take_dropped(5), 1u);
    RingEdge e{};
    REQUIRE(ring.pop(e));
    CHECK_EQ(e.t_us, 0u);  // the oldest survived
    CHECK(ring.push(2000, 3, true));  // room again
    CHECK_EQ(ring.take_dropped(3), 0u);
    // Out of range: refused, nothing counted anywhere.
    CHECK(!ring.push(1, 16, true));
    CHECK_EQ(ring.take_dropped(16), 0u);
}

TEST(fixture_ring_wraps)
{
    EdgeRing<4, 1> ring;
    RingEdge e{};
    for (uint32_t i = 0; i < 1000; ++i) {
        REQUIRE(ring.push(i, 0, (i & 1) != 0));
        REQUIRE(ring.push(i + 1'000'000, 0, true));
        REQUIRE(ring.pop(e));
        REQUIRE_EQ(e.t_us, i);
        REQUIRE(ring.pop(e));
        REQUIRE_EQ(e.t_us, i + 1'000'000);
    }
    CHECK(ring.empty());
    CHECK_EQ(ring.take_dropped(0), 0u);
}

// ---- presses: the Plan the segment timer runs ----

TEST(fixture_plan_maps_segments_to_boundaries)
{
    // design m2-c1-hil §2.1: click, double_click, long_press, bounce.
    auto p = plan({80'000});
    REQUIRE(p);
    CHECK_EQ(show(*p), "80000:0");
    CHECK_EQ(p->total_us, 80'000u);
    p = plan({80'000, 100'000, 80'000});
    REQUIRE(p);
    CHECK_EQ(show(*p), "80000:0 180000:1 260000:0");
    CHECK_EQ(p->total_us, 260'000u);
    p = plan({800'000});
    REQUIRE(p);
    CHECK_EQ(show(*p), "800000:0");
    p = plan({600, 400, 600, 400, 80'000});
    REQUIRE(p);
    CHECK_EQ(show(*p), "600:0 1000:1 1600:0 2000:1 82000:0");
    // A trailing release segment: the press runs until it ends, released after its first boundary.
    p = plan({80'000, 100'000});
    REQUIRE(p);
    CHECK_EQ(show(*p), "80000:0 180000:0");
    CHECK_EQ(p->total_us, 180'000u);
    // 16 segments, the most a press carries.
    std::vector<uint32_t> many(16, 1'000);
    p = plan(many);
    REQUIRE(p);
    CHECK_EQ(p->n, 16u);
    CHECK_EQ(p->total_us, 16'000u);
    CHECK(!p->pressed_after(15));
}

TEST(fixture_plan_is_cut_at_the_cap)
{
    auto p = plan({80'000, 100'000, 80'000}, 100'000);
    REQUIRE(p);
    CHECK_EQ(show(*p), "80000:0 100000:0");  // the cut lands in the release segment: nothing more runs
    CHECK_EQ(p->total_us, 100'000u);
    p = plan({20'000'000}, 15'000'000);
    REQUIRE(p);
    CHECK_EQ(show(*p), "15000000:0");
    CHECK_EQ(p->total_us, 15'000'000u);
    p = plan({10'000'000, 1'000'000, 10'000'000}, 15'000'000);
    REQUIRE(p);
    CHECK_EQ(show(*p), "10000000:0 11000000:1 15000000:0");  // cut inside a press: released at the cap
    p = plan({15'000'000, 1'000}, 15'000'000);
    REQUIRE(p);
    CHECK_EQ(show(*p), "15000000:0");  // exactly at the cap
    // No overflow: the sum of 16 near-u32 segments is cut, not wrapped.
    std::vector<uint32_t> huge(16, 0xFFFF'FFF0u);
    p = plan(huge, 30'000'000);
    REQUIRE(p);
    CHECK_EQ(p->total_us, 30'000'000u);
    CHECK_EQ(p->n, 1u);
}

TEST(fixture_plan_cap_release_follows_total)
{
    // The second timer lets go at min(total, cap) + 5 ms, whatever the segment timer did.
    auto p = plan({80'000});
    REQUIRE(p);
    CHECK_EQ(p->guard_us(), 85'000u);
    p = plan({20'000'000}, 15'000'000);
    REQUIRE(p);
    CHECK_EQ(p->guard_us(), 15'005'000u);
    CHECK_EQ(FixtureGpio::kGuardUs, 5'000u);
}

TEST(fixture_plan_refuses_bad_segments)
{
    CHECK(plan({}).error() == fr::Err::invalid_args);
    CHECK(plan({80'000, 0}).error() == fr::Err::invalid_args);
    CHECK(plan({80'000}, 0).error() == fr::Err::invalid_args);
    std::vector<uint32_t> too_many(17, 1'000);
    CHECK(plan(too_many).error() == fr::Err::invalid_args);
    // constexpr: the driver's sequencing is checkable at compile time too.
    static_assert(
        FixtureGpio::Plan::make(std::array<uint32_t, 3>{80'000, 100'000, 80'000}, 15'000'000)->total_us == 260'000);
}

// ---- pin levels and interrupts ----

TEST(fixture_pin_levels_per_drive)
{
    // open_drain pulls the DUT's BOOT low and lets go high; nfet_gate drives its MOSFET's gate high to press.
    static_assert(!FixtureGpio::pin_level(FixtureDrive::open_drain, true));
    static_assert(FixtureGpio::pin_level(FixtureDrive::open_drain, false));
    static_assert(FixtureGpio::pin_level(FixtureDrive::nfet_gate, true));
    static_assert(!FixtureGpio::pin_level(FixtureDrive::nfet_gate, false));
    CHECK(true);
}

TEST(fixture_no_edge_interrupt_on_ws2812_or_nfet_gate_lines)
{
    // Input taps and open_drain lines (their readback) capture edges; nfet_gate lines report their writes.
    CHECK(FixtureGpio::edge_irq(FixtureLineMode{.drive = FixtureDrive::none, .decode = FixtureDecode::level}));
    CHECK(FixtureGpio::edge_irq(
        FixtureLineMode{.drive = FixtureDrive::none, .decode = FixtureDecode::level, .pull_up = true}));
    CHECK(FixtureGpio::edge_irq(FixtureLineMode{.drive = FixtureDrive::open_drain, .decode = FixtureDecode::level}));
    CHECK(!FixtureGpio::edge_irq(FixtureLineMode{.drive = FixtureDrive::nfet_gate, .decode = FixtureDecode::level}));
    // decode ws2812: RMT RX only; its ~800 kHz bit edges would flood the ISR.
    CHECK(!FixtureGpio::edge_irq(FixtureLineMode{.drive = FixtureDrive::none, .decode = FixtureDecode::ws2812}));
    CHECK(!FixtureGpio::edge_irq(FixtureLineMode{.drive = FixtureDrive::open_drain, .decode = FixtureDecode::ws2812}));
}
