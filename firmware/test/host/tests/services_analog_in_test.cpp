// AnalogInService against FakeCore and a fake ADC channel (spec 07 §7.3; design m2-c3-inputs D2): sampling,
// filters, mapping, the report rule (deadband, rate limit, trailing report), `crossed` with hysteresis, inject.
#include <string>
#include <vector>

#include "fr/services/analog_in_service.hpp"
#include "tests/fake_core.hpp"
#include "tests/test.hpp"

namespace {

using frt::FakeCore;
using frt::RecordingSink;
using fr::cap::AnalogInConfig;
using fr::cap::AnalogInFilter;

constexpr uint8_t kPort = 3;

/** One ADC channel: returns `mv` (plus `step` more on each read), or fails while fail_reads is set. */
class FakeAnalog final : public fr::hal::AnalogSource
{
public:
    fr::Status init(fr::Core &) override
    {
        ++inits;
        if (fail_init) {
            return std::unexpected(fr::Err::unsupported);
        }
        return {};
    }
    fr::Status read(fr::hal::AnalogReading &out) override
    {
        ++reads;
        if (fail_reads) {
            return std::unexpected(fr::Err::failed);
        }
        out.mv = static_cast<uint16_t>(mv);
        out.raw = static_cast<uint16_t>(mv * 4095 / 2500);
        mv += step;
        return {};
    }
    uint8_t resolution_bits() const override { return 12; }
    uint16_t full_scale_mv() const override { return 2500; }
    fr::hal::Selftest selftest() override { return {true, "fake"}; }

    int mv = 0;
    int step = 0;
    bool fail_init = false;
    bool fail_reads = false;
    int inits = 0;
    int reads = 0;
};

/** min_mv 0, max_mv 65535: value == mV, which keeps the arithmetic in the tests readable. */
AnalogInConfig identity_cfg()
{
    AnalogInConfig c{};
    c.filter = AnalogInFilter::none;
    c.min_mv = 0;
    c.max_mv = 65535;
    c.deadband = 0;
    c.hysteresis = 0;
    return c;  // sample_hz 200 (5 ms), report_hz 20 (50 ms)
}

struct Rig {
    explicit Rig(AnalogInConfig cfg = identity_cfg()) : svc(src, cfg) { svc.attach(kPort, "analog", sink); }

    /** init and the first tick (which runs as soon as the core does). */
    bool start()
    {
        if (!svc.init(core)) {
            return false;
        }
        core.run_ready();
        return true;
    }

    /** Every reported value, in order. */
    std::vector<uint64_t> reports() const
    {
        std::vector<uint64_t> out;
        for (const auto &e : sink.properties()) {
            out.push_back(frt::field_u(e.bytes, 1));
        }
        return out;
    }

    /** `crossed` events as "r0@1100 f1@900": direction, index and value. */
    std::string crossings() const
    {
        std::string out;
        for (const auto &e : sink.events()) {
            if (!out.empty()) {
                out += ' ';
            }
            out += frt::field_u(e.bytes, 2) == 1 ? 'f' : 'r';
            out += std::to_string(frt::field_u(e.bytes, 1)) + "@" + std::to_string(frt::field_u(e.bytes, 3));
        }
        return out;
    }

    /** Sets the input and runs one tick (5 ms at the default sample_hz). */
    void tick(int mv)
    {
        src.mv = mv;
        core.advance_ms(5);
    }

    FakeCore core;
    FakeAnalog src;
    RecordingSink sink{core};
    fr::AnalogInService svc;
};

}  // namespace

TEST(analog_first_sample_reports_and_traits_come_from_the_driver)
{
    AnalogInConfig c = identity_cfg();
    c.min_mv = 0;
    c.max_mv = 2500;
    c.thresholds = {100, 30000};
    Rig r(c);
    r.src.mv = 1250;
    CHECK_EQ(r.svc.traits().resolution_bits, 12);
    CHECK_EQ(r.svc.traits().full_scale_mv, 2500);
    CHECK(!r.svc.read());  // nothing sampled yet
    REQUIRE(r.start());
    CHECK_EQ(r.src.inits, 1);
    CHECK_EQ(r.core.timers_used(), 1u);
    REQUIRE_EQ(r.reports().size(), 1u);
    CHECK_EQ(r.reports()[0], 32768u);  // 1250 of 0..2500 mV, rounded
    CHECK_EQ(r.svc.value(), 32768);
    CHECK_EQ(r.crossings(), "");  // the initial threshold state is set without events
    auto rd = r.svc.read();
    REQUIRE(rd);
    CHECK_EQ(rd->mv, 1250);
    CHECK_EQ(rd->raw, 2047);
    CHECK_EQ(rd->value, 32768);
    CHECK(!rd->injected);
}

TEST(analog_samples_at_sample_hz_on_a_fixed_grid)
{
    AnalogInConfig c = identity_cfg();
    c.sample_hz = 200;
    Rig r(c);
    REQUIRE(r.start());
    CHECK_EQ(r.src.reads, 1);
    r.core.advance_ms(1000);
    CHECK_EQ(r.src.reads, 201);
    c.sample_hz = 1;
    Rig slow(c);
    REQUIRE(slow.start());
    slow.core.advance_ms(2999);
    CHECK_EQ(slow.src.reads, 3);
}

TEST(analog_maps_the_mv_range_and_clamps)
{
    AnalogInConfig c = identity_cfg();
    c.min_mv = 500;
    c.max_mv = 1500;
    Rig r(c);
    r.src.mv = 400;
    REQUIRE(r.start());
    CHECK_EQ(r.svc.value(), 0);
    r.tick(500);
    CHECK_EQ(r.svc.value(), 0);
    r.tick(1000);
    CHECK_EQ(r.svc.value(), 32768);
    r.tick(1500);
    CHECK_EQ(r.svc.value(), 65535);
    r.tick(2400);
    CHECK_EQ(r.svc.value(), 65535);
    r.tick(501);
    CHECK_EQ(r.svc.value(), 66);  // 65535 / 1000, rounded
}

TEST(analog_deadband_holds_back_small_changes)
{
    AnalogInConfig c = identity_cfg();
    c.deadband = 512;
    Rig r(c);
    r.src.mv = 10000;
    REQUIRE(r.start());
    r.core.advance_ms(100);  // past the rate limit
    r.tick(10511);
    r.tick(9489);
    r.core.advance_ms(200);
    CHECK_EQ(r.reports().size(), 1u);  // 511 either way is inside the deadband
    r.tick(10512);
    REQUIRE_EQ(r.reports().size(), 2u);
    CHECK_EQ(r.reports()[1], 10512u);
    // The deadband is measured from the last report, not the last sample: small steps add up.
    for (int mv = 10612; mv <= 11200; mv += 100) {
        r.core.advance_ms(60);
        r.tick(mv);
    }
    CHECK_EQ(r.reports().size(), 3u);
    CHECK_EQ(r.reports().back(), 11112u);  // 11012 was still 500 from 10512
}

TEST(analog_deadband_zero_reports_any_change)
{
    Rig r;  // deadband 0
    r.src.mv = 1000;
    REQUIRE(r.start());
    r.core.advance_ms(60);
    r.tick(1001);
    REQUIRE_EQ(r.reports().size(), 2u);
    CHECK_EQ(r.reports()[1], 1001u);
    r.core.advance_ms(60);
    r.tick(1001);  // no change: nothing
    CHECK_EQ(r.reports().size(), 2u);
}

TEST(analog_rate_limit_caps_reports_at_report_hz)
{
    Rig r;  // report_hz 20: one report per 50 ms at most
    r.src.mv = 1000;
    r.src.step = 7;  // a change on every sample
    REQUIRE(r.start());
    r.core.advance_ms(1000);
    CHECK_EQ(r.reports().size(), 21u);  // the first, then one per 50 ms
    const auto props = r.sink.properties();
    for (size_t i = 1; i < props.size(); ++i) {
        CHECK_EQ(props[i].emitted - props[i - 1].emitted, 50'000);
    }
}

TEST(analog_change_held_by_the_rate_limit_reports_when_the_period_ends)
{
    Rig r;
    r.src.mv = 1000;
    REQUIRE(r.start());
    const fr::TimeUs t0 = r.core.now();
    r.tick(1200);  // 5 ms after the first report: held back
    CHECK_EQ(r.reports().size(), 1u);
    r.core.advance_ms(30);
    CHECK_EQ(r.reports().size(), 1u);
    r.core.advance_ms(20);  // t0 + 55 ms; the period ended at t0 + 50 ms
    REQUIRE_EQ(r.reports().size(), 2u);
    CHECK_EQ(r.reports()[1], 1200u);
    CHECK_EQ(r.sink.properties()[1].emitted, t0 + 50'000);
    // A change that came back inside the deadband before the period ended is not reported.
    AnalogInConfig c = identity_cfg();
    c.deadband = 100;
    Rig b(c);
    b.src.mv = 1000;
    REQUIRE(b.start());
    b.tick(1300);
    b.tick(1050);
    b.core.advance_ms(100);
    CHECK_EQ(b.reports().size(), 1u);
}

TEST(analog_ema_filter_alpha_quarter)
{
    AnalogInConfig c = identity_cfg();
    c.filter = AnalogInFilter::ema;
    Rig r(c);
    r.src.mv = 0;
    REQUIRE(r.start());
    CHECK_EQ(r.svc.value(), 0);
    r.tick(1000);
    CHECK_EQ(r.svc.value(), 250);
    r.tick(1000);
    CHECK_EQ(r.svc.value(), 438);  // 437.5, rounded
    r.tick(1000);
    CHECK_EQ(r.svc.value(), 578);
    auto rd = r.svc.read();
    REQUIRE(rd);
    CHECK_EQ(rd->mv, 1000);  // read.mv is the unfiltered reading
    CHECK_EQ(rd->value, 578);
    r.core.advance_ms(500);
    CHECK_EQ(r.svc.value(), 1000);  // settles exactly on a constant input
}

TEST(analog_median3_filter_rejects_a_single_spike)
{
    AnalogInConfig c = identity_cfg();
    c.filter = AnalogInFilter::median3;
    Rig r(c);
    r.src.mv = 1000;
    REQUIRE(r.start());
    r.tick(5000);
    CHECK_EQ(r.svc.value(), 1000);
    r.tick(1000);
    r.tick(1000);
    CHECK_EQ(r.svc.value(), 1000);
    r.tick(5000);
    CHECK_EQ(r.svc.value(), 1000);
    r.tick(5000);  // two in a row are a level, not a spike
    CHECK_EQ(r.svc.value(), 5000);
    r.tick(0);
    CHECK_EQ(r.svc.value(), 5000);
}

TEST(analog_crossed_with_hysteresis)
{
    AnalogInConfig c = identity_cfg();
    c.thresholds = {1000, 2000};
    c.hysteresis = 200;  // rise at t + 100, fall at t - 100
    Rig r(c);
    r.src.mv = 500;
    REQUIRE(r.start());
    r.tick(1099);
    CHECK_EQ(r.crossings(), "");
    r.tick(1100);
    CHECK_EQ(r.crossings(), "r0@1100");
    // Noise around the threshold, inside the band: no chatter.
    for (int i = 0; i < 50; ++i) {
        r.tick(i % 2 == 0 ? 901 : 1099);
    }
    CHECK_EQ(r.crossings(), "r0@1100");
    r.tick(900);
    CHECK_EQ(r.crossings(), "r0@1100 f0@900");
    r.sink.clear();
    // A jump across both: rises from the lowest up; a drop: falls from the highest down.
    r.tick(2500);
    r.tick(0);
    CHECK_EQ(r.crossings(), "r0@2500 r1@2500 f1@0 f0@0");
    // crossed is realtime and stamped with the sample's time.
    auto ev = r.sink.events();
    REQUIRE_EQ(ev.size(), 4u);
    CHECK(ev[0].prio == fr::cap::Priority::realtime);
    CHECK_EQ(ev[0].port, kPort);
}

TEST(analog_crossed_initial_state_comes_from_the_first_sample)
{
    AnalogInConfig c = identity_cfg();
    c.thresholds = {1000, 2000};
    c.hysteresis = 200;
    Rig r(c);
    r.src.mv = 1500;  // above 1000, below 2000
    REQUIRE(r.start());
    CHECK_EQ(r.crossings(), "");
    r.tick(1500);
    r.tick(2100);
    r.tick(800);
    CHECK_EQ(r.crossings(), "r1@2100 f1@800 f0@800");
}

TEST(analog_crossed_without_hysteresis_does_not_chatter_on_the_threshold)
{
    AnalogInConfig c = identity_cfg();
    c.thresholds = {1000};
    Rig r(c);  // hysteresis 0
    r.src.mv = 999;
    REQUIRE(r.start());
    for (int i = 0; i < 20; ++i) {
        r.tick(1000);
    }
    CHECK_EQ(r.crossings(), "r0@1000");
    r.tick(999);
    CHECK_EQ(r.crossings(), "r0@1000 f0@999");
}

TEST(analog_crossed_hysteresis_clamps_at_the_range_ends)
{
    AnalogInConfig c = identity_cfg();
    c.thresholds = {50, 65500};
    c.hysteresis = 1000;
    Rig r(c);
    r.src.mv = 30000;  // above 50, below 65500
    REQUIRE(r.start());
    r.tick(65535);  // 65500 + 500 clamps to 65535
    r.tick(1);
    r.tick(0);  // 50 - 500 clamps to 0
    CHECK_EQ(r.crossings(), "r1@65535 f1@1 f0@0");
}

TEST(analog_inject_holds_a_value_in_place_of_the_adc)
{
    Rig r;
    r.src.mv = 600;
    REQUIRE(r.start());
    r.core.advance_ms(100);
    const int reads = r.src.reads;
    const fr::TimeUs t = r.core.now();
    REQUIRE(r.svc.inject({.value = 50000, .hold_ms = 200}));
    REQUIRE_EQ(r.reports().size(), 2u);
    CHECK_EQ(r.reports()[1], 50000u);  // at once, not at the next tick
    CHECK_EQ(r.sink.properties()[1].emitted, t);
    auto rd = r.svc.read();
    REQUIRE(rd);
    CHECK(rd->injected);
    CHECK_EQ(rd->value, 50000);
    CHECK_EQ(rd->mv, 600);  // the last real reading
    r.core.advance_ms(195);
    CHECK_EQ(r.src.reads, reads);  // the ADC stays idle while the hold lasts
    CHECK_EQ(r.svc.value(), 50000);
    r.core.advance_ms(10);
    CHECK(r.src.reads > reads);
    CHECK(!r.svc.read()->injected);
    CHECK_EQ(r.reports().back(), 600u);
}

TEST(analog_inject_hold_defaults_clamps_and_is_replaced)
{
    Rig r;
    r.src.mv = 600;
    REQUIRE(r.start());
    REQUIRE(r.svc.inject({.value = 100, .hold_ms = 0}));  // 0 means 1,000 ms
    r.core.advance_ms(995);
    CHECK(r.svc.read()->injected);
    r.core.advance_ms(10);
    CHECK(!r.svc.read()->injected);
    REQUIRE(r.svc.inject({.value = 100, .hold_ms = 65535}));  // at most 60,000 ms
    r.core.advance_ms(59'995);
    CHECK(r.svc.read()->injected);
    r.core.advance_ms(10);
    CHECK(!r.svc.read()->injected);
    // A newer inject replaces the value and the hold.
    REQUIRE(r.svc.inject({.value = 100, .hold_ms = 5000}));
    r.core.advance_ms(100);
    REQUIRE(r.svc.inject({.value = 40000, .hold_ms = 100}));
    CHECK_EQ(r.svc.value(), 40000);
    r.core.advance_ms(105);
    CHECK(!r.svc.read()->injected);
    CHECK_EQ(r.svc.value(), 600);
}

TEST(analog_inject_drives_crossed_and_reseeds_the_filter)
{
    AnalogInConfig c = identity_cfg();
    c.filter = AnalogInFilter::ema;
    c.thresholds = {30000};
    c.hysteresis = 1000;
    Rig r(c);
    r.src.mv = 600;
    REQUIRE(r.start());
    REQUIRE(r.svc.inject({.value = 50000, .hold_ms = 100}));
    CHECK_EQ(r.crossings(), "r0@50000");
    r.src.mv = 2000;
    r.core.advance_ms(105);
    // The first real sample after the hold seeds the EMA (no blend with the pre-hold 600 mV), and falls.
    CHECK_EQ(r.svc.value(), 2000);
    CHECK_EQ(r.crossings(), "r0@50000 f0@2000");
}

TEST(analog_read_errors_keep_the_last_value)
{
    Rig r;
    r.src.mv = 700;
    REQUIRE(r.start());
    r.src.fail_reads = true;
    r.tick(900);
    r.tick(900);
    CHECK_EQ(r.svc.read_errors(), 2u);
    CHECK_EQ(r.svc.value(), 700);
    r.src.fail_reads = false;
    r.core.advance_ms(60);
    CHECK_EQ(r.svc.value(), 900);
}

TEST(analog_invalid_config_is_refused_at_init)
{
    auto refused = [](AnalogInConfig c) {
        Rig r(c);
        fr::Status st = r.svc.init(r.core);
        // Refused before the driver or a timer is touched.
        return !st && st.error() == fr::Err::invalid_args && r.src.inits == 0 && r.core.timers_used() == 0;
    };
    AnalogInConfig c = identity_cfg();
    c.min_mv = 1000;
    c.max_mv = 1000;
    CHECK(refused(c));
    c.max_mv = 999;
    CHECK(refused(c));
    c = identity_cfg();
    c.thresholds = {2000, 1000};
    CHECK(refused(c));
    c.thresholds = {1000, 1000};  // strictly ascending
    CHECK(refused(c));
    c = identity_cfg();
    c.sample_hz = 0;
    CHECK(refused(c));
    c = identity_cfg();
    c.report_hz = 0;
    CHECK(refused(c));
    c = identity_cfg();
    c.filter = static_cast<AnalogInFilter>(7);
    CHECK(refused(c));
    // The defaults (and the c3o-analog thresholds) are fine.
    AnalogInConfig d{};
    d.thresholds = {16384, 32768, 49152};
    Rig ok(d);
    CHECK(ok.start());
}

TEST(analog_driver_init_failure_is_returned)
{
    Rig r;
    r.src.fail_init = true;
    fr::Status st = r.svc.init(r.core);
    REQUIRE(!st);
    CHECK(st.error() == fr::Err::unsupported);
    r.core.advance_ms(100);
    CHECK_EQ(r.src.reads, 0);
}
