// ScaleService against FakeCore, a fake load cell and fake settings (design scale-round-c1 D6, D7, D9, D11): the weight
// arithmetic, the filters, the report rule (rate limit, deadband, the held-back value), watch_start/stop, stable and
// `settled`, tare and calibrate (their windows and BUSY/INVALID_ARGS/FAILED), the calibration kept across a re-init,
// inject, and a dead part. Latency (§11): each conversion processed when its ready hook fires, the wake-ups coalesced
// and a refused one left to the tick, every conversion reported at report_hz 100, report times strictly increasing.
#include <algorithm>
#include <cstdint>
#include <limits>
#include <vector>

#include "fr/services/scale_service.hpp"
#include "tests/fake_core.hpp"
#include "tests/scale_fakes.hpp"
#include "tests/test.hpp"

namespace {

using fr::ScaleService;
using fr::TimeUs;
using fr::cap::ScaleConfig;
using fr::cap::ScaleFilter;
using frt::FakeCore;
using frt::FakeLoadCell;
using frt::FakeSettings;
using frt::RecordingSink;

constexpr uint8_t kPort = 3;
constexpr int64_t kQ = 65536;
constexpr uint32_t k80Hz = 12'500;  // µs between conversions

/** counts_per_kg 1,000,000: one count is one mg, which keeps the arithmetic in the tests readable. */
ScaleConfig mg_cfg()
{
    ScaleConfig c{};
    c.filter = ScaleFilter::none;
    c.counts_per_kg = 1'000'000;
    return c;  // report_hz 10, deadband 100 mg, stable 500 mg for 500 ms, settle_min 2,000 mg
}

struct Report {
    int32_t mg;
    TimeUs at;       // the time the report carries
    TimeUs emitted;  // the clock when the service sent it
};

/** Report times strictly increase (the hub drops a STATE older than the last it kept). */
bool strictly_increasing(const std::vector<Report> &w)
{
    for (size_t i = 1; i < w.size(); ++i) {
        if (w[i].at <= w[i - 1].at) {
            return false;
        }
    }
    return true;
}

/** The profile c6w-scale's: every change at up to 100 a second, no filter. */
ScaleConfig stream_cfg()
{
    ScaleConfig c = mg_cfg();
    c.report_hz = 100;
    c.deadband_mg = 0;
    return c;
}

struct Rig {
    explicit Rig(ScaleConfig cfg = mg_cfg(), FakeSettings *shared = nullptr)
        : settings(shared != nullptr ? *shared : own), svc(cell, settings, cfg)
    {
        svc.attach(kPort, "scale", sink);
    }

    bool start()
    {
        if (!svc.init(core)) {
            return false;
        }
        core.run_ready();
        return true;
    }

    /** n conversions of `raw`, one every period_us from now, each taken by the service's next tick. */
    void feed(int32_t raw, int n, uint32_t period_us = k80Hz)
    {
        for (int i = 0; i < n; ++i) {
            const TimeUs t = core.now() + period_us;
            core.advance_to(t);
            cell.push(raw, t);
        }
        core.advance_us(ScaleService::kTickUs);
    }

    /** n conversions one every period_us, the i-th of raw_of(i). */
    template <class F>
    void feed_each(int n, uint32_t period_us, F raw_of)
    {
        for (int i = 0; i < n; ++i) {
            const TimeUs t = core.now() + period_us;
            core.advance_to(t);
            cell.push(raw_of(i), t);
        }
        core.advance_us(ScaleService::kTickUs);
    }

    /** `raw` for `ms` at 80 Hz. */
    void hold(int32_t raw, uint32_t ms) { feed(raw, static_cast<int>(ms * 1000 / k80Hz)); }

    std::vector<Report> weights() const
    {
        std::vector<Report> out;
        for (const auto &e : sink.properties()) {
            if (e.id == fr::cap::Scale::kPropWeightMg) {
                out.push_back({*fr::cap::decode_scale_weight_mg_state(e.bytes), e.at, e.emitted});
            }
        }
        return out;
    }
    std::vector<bool> stables() const
    {
        std::vector<bool> out;
        for (const auto &e : sink.properties()) {
            if (e.id == fr::cap::Scale::kPropStable) {
                out.push_back(*fr::cap::decode_scale_stable_state(e.bytes));
            }
        }
        return out;
    }
    std::vector<uint8_t> rates() const
    {
        std::vector<uint8_t> out;
        for (const auto &e : sink.properties()) {
            if (e.id == fr::cap::Scale::kPropRateHz) {
                out.push_back(*fr::cap::decode_scale_rate_hz_state(e.bytes));
            }
        }
        return out;
    }
    std::vector<bool> calibrateds() const
    {
        std::vector<bool> out;
        for (const auto &e : sink.properties()) {
            if (e.id == fr::cap::Scale::kPropCalibrated) {
                out.push_back(*fr::cap::decode_scale_calibrated_state(e.bytes));
            }
        }
        return out;
    }
    std::vector<fr::cap::ScaleSettled> settled() const
    {
        std::vector<fr::cap::ScaleSettled> out;
        for (const auto &e : sink.events()) {
            out.push_back(*fr::cap::decode_scale_settled(e.bytes));
        }
        return out;
    }

    FakeCore core;
    FakeLoadCell cell{core};
    FakeSettings own;
    FakeSettings &settings;
    RecordingSink sink{core};
    ScaleService svc;
};

}  // namespace

TEST(scale_weight_arithmetic_rounds_clamps_and_rebases)
{
    CHECK_EQ(ScaleService::weight_of(420'000 * kQ, 0, 420'000), 1'000'000);
    CHECK_EQ(ScaleService::weight_of((607'150 + 420) * kQ, 607'150, 420'000), 1000);
    CHECK_EQ(ScaleService::weight_of(-420 * kQ, 0, 420'000), -1000);
    CHECK_EQ(ScaleService::weight_of(1 * kQ, 0, 3'000'000), 0);    // 0.33 mg
    CHECK_EQ(ScaleService::weight_of(2 * kQ, 0, 3'000'000), 1);    // 0.67 mg
    CHECK_EQ(ScaleService::weight_of(-2 * kQ, 0, 3'000'000), -1);  // halves and beyond away from zero
    CHECK_EQ(ScaleService::weight_of(1000 * kQ, 0, -1'000'000), -1000);  // a cell wired the other way round
    CHECK_EQ(ScaleService::weight_of(kQ / 2, 0, 1'000'000), 1);  // a filtered code between two counts
    CHECK_EQ(ScaleService::weight_of(8'388'607 * kQ, -8'388'608, 1), std::numeric_limits<int32_t>::max());
    CHECK_EQ(ScaleService::weight_of(-8'388'608 * kQ, 8'388'607, 1), std::numeric_limits<int32_t>::min());
    CHECK_EQ(ScaleService::rebase(500, 0, 1'000'000, 500, 1'000'000), 0);         // a tare at 500
    CHECK_EQ(ScaleService::rebase(1000, 0, 1'000'000, 0, 2'000'000), 500);        // a factor twice as large
    CHECK_EQ(ScaleService::rebase(1000, 200, 420'000, 0, 1'000'000), 620);        // reset: raw 620 in mg-counts
}

TEST(scale_init_traits_keys_and_first_report)
{
    Rig r;
    CHECK_EQ(r.svc.traits().resolution_bits, 24);
    CHECK_EQ(r.svc.traits().max_rate_hz, 80);
    REQUIRE(r.start());
    CHECK_EQ(r.cell.inits, 1);
    CHECK_EQ(r.cell.starts, 1);
    CHECK(r.cell.gain == fr::hal::LoadCellGain::a128);
    CHECK_EQ(r.core.timers_used(), 1u);
    CHECK_EQ(r.svc.offset_key(), "off.p3");
    CHECK_EQ(r.svc.factor_key(), "cpk.p3");
    CHECK(!r.svc.calibrated());
    CHECK_EQ(r.weights().size(), 0u);  // nothing measured yet
    auto rd0 = r.svc.read();
    REQUIRE(rd0);
    CHECK_EQ(rd0->raw, 0);
    CHECK_EQ(rd0->rate_hz, 0);

    r.feed(1234, 1);
    REQUIRE_EQ(r.weights().size(), 1u);
    CHECK_EQ(r.weights()[0].mg, 1234);
    auto rd = r.svc.read();
    REQUIRE(rd);
    CHECK_EQ(rd->raw, 1234);
    CHECK_EQ(rd->weight_mg, 1234);
    CHECK_EQ(rd->offset, 0);
    CHECK_EQ(rd->counts_per_kg, 1'000'000);
    CHECK(!rd->calibrated);
    CHECK(!rd->injected);
}

TEST(scale_init_refuses_a_bad_config_and_a_failed_part)
{
    ScaleConfig c = mg_cfg();
    c.report_hz = 0;
    {
        Rig r(c);
        CHECK(r.svc.init(r.core).error() == fr::Err::invalid_args);
    }
    c = mg_cfg();
    c.report_hz = 101;
    {
        Rig r(c);
        CHECK(r.svc.init(r.core).error() == fr::Err::invalid_args);
    }
    c = mg_cfg();
    c.counts_per_kg = 0;
    {
        Rig r(c);
        CHECK(r.svc.init(r.core).error() == fr::Err::invalid_args);
    }
    {
        Rig r;
        r.cell.fail_init = true;
        CHECK(r.svc.init(r.core).error() == fr::Err::failed);
    }
    c = mg_cfg();
    c.gain = fr::cap::ScaleGain::b32;
    {
        Rig r(c);
        REQUIRE(r.start());
        CHECK(r.cell.gain == fr::hal::LoadCellGain::b32);
    }
}

TEST(scale_filters_ema_and_median5)
{
    ScaleConfig c = mg_cfg();
    c.filter = ScaleFilter::ema;
    c.deadband_mg = 0;
    c.report_hz = 80;
    {
        Rig r(c);
        REQUIRE(r.start());
        r.feed(0, 1);
        r.feed(1000, 1);
        CHECK_EQ(r.svc.weight_mg(), 250);
        r.feed(1000, 1);
        CHECK_EQ(r.svc.weight_mg(), 438);  // 437.5, rounded
        r.feed(1000, 1);
        CHECK_EQ(r.svc.weight_mg(), 578);
        r.feed(1000, 40);
        CHECK_EQ(r.svc.weight_mg(), 1000);
    }
    c.filter = ScaleFilter::median5;
    {
        Rig r(c);
        REQUIRE(r.start());
        r.feed(0, 1);  // seeds all five
        r.feed(100'000, 1);
        CHECK_EQ(r.svc.weight_mg(), 0);  // one spike is not the median
        r.feed(100'000, 1);
        CHECK_EQ(r.svc.weight_mg(), 0);
        r.feed(100'000, 1);
        CHECK_EQ(r.svc.weight_mg(), 100'000);  // three of five
    }
    c.filter = ScaleFilter::none;
    {
        Rig r(c);
        REQUIRE(r.start());
        r.feed(-777, 1);
        CHECK_EQ(r.svc.weight_mg(), -777);
    }
}

TEST(scale_reports_at_most_report_hz_beyond_the_deadband)
{
    Rig r;  // report_hz 10, deadband 100
    REQUIRE(r.start());
    // A weight rising 50 mg a conversion at 80 Hz for a second: one report every 100 ms, on the conversions' times.
    r.feed_each(80, k80Hz, [](int i) { return i * 50; });
    const auto w = r.weights();
    REQUIRE(w.size() >= 9u);
    CHECK(w.size() <= 11u);
    for (size_t i = 1; i < w.size(); ++i) {
        CHECK_EQ(w[i].at - w[i - 1].at, 100'000);
    }
    // Below the deadband: changes of 50 mg back and forth from the last reported weight are never reported.
    r.hold(10000, 300);
    r.sink.clear();
    r.feed_each(40, k80Hz, [](int i) { return 10000 + (i % 2) * 50; });
    CHECK_EQ(r.weights().size(), 0u);
}

TEST(scale_held_back_change_is_sent_when_the_period_ends)
{
    Rig r;
    REQUIRE(r.start());
    r.feed(0, 1);
    REQUIRE_EQ(r.weights().size(), 1u);
    const TimeUs first = r.weights()[0].at;
    r.feed(500, 1);  // 12.5 ms later: held back by the rate limit
    CHECK_EQ(r.weights().size(), 1u);
    const TimeUs conv = r.cell.times.back();
    r.core.advance_ms(200);  // no more conversions: the next tick after first + 100 ms sends it
    REQUIRE_EQ(r.weights().size(), 2u);
    CHECK_EQ(r.weights()[1].mg, 500);
    CHECK(r.weights()[1].emitted >= first + 100'000);
    CHECK(r.weights()[1].emitted < first + 100'000 + ScaleService::kTickUs);
    CHECK_EQ(r.weights()[1].at, conv);  // stamped with its conversion's time, not the tick's
}

TEST(scale_conversion_is_processed_when_it_lands)
{
    // The driver's hook wakes the core: the conversion is taken and reported at once, between two ticks.
    Rig r(stream_cfg());
    REQUIRE(r.start());
    const TimeUs t = r.core.now() + 3'000;  // 7 ms before the next tick
    r.core.advance_to(t);
    r.cell.push(1234, t);
    r.core.run_ready();  // no time passes
    REQUIRE_EQ(r.weights().size(), 1u);
    CHECK_EQ(r.weights()[0].mg, 1234);
    CHECK_EQ(r.weights()[0].at, t);
    CHECK_EQ(r.weights()[0].emitted, t);
    CHECK_EQ(r.svc.wakes_refused(), 0u);

    // A driver without the hook: the same conversion waits for the tick (the fallback).
    Rig q(stream_cfg());
    q.cell.notify = false;
    REQUIRE(q.start());
    const TimeUs tq = q.core.now() + 3'000;
    q.core.advance_to(tq);
    q.cell.push(1234, tq);
    q.core.run_ready();
    CHECK_EQ(q.weights().size(), 0u);
    q.core.advance_us(ScaleService::kTickUs);
    REQUIRE_EQ(q.weights().size(), 1u);
    CHECK_EQ(q.weights()[0].at, tq);
    CHECK_EQ(q.weights()[0].emitted - tq, 7'000);
}

TEST(scale_wake_ups_coalesce_and_a_refused_one_falls_back_to_the_tick)
{
    Rig r(stream_cfg());
    REQUIRE(r.start());
    // A burst of five before the core runs: one wake-up posted, the queue's last free slot, nothing refused.
    const TimeUs t0 = r.core.now() + 5'000;
    r.core.advance_to(t0);
    for (size_t i = 0; i + 1 < FakeCore::kPosts; ++i) {
        REQUIRE(r.core.post([] {}));
    }
    for (int i = 0; i < 5; ++i) {
        r.cell.push(100 * (i + 1), t0 - 4'000 + i * 1'000);
    }
    CHECK(!r.core.post([] {}));  // the one wake-up took the last slot
    CHECK_EQ(r.svc.wakes_refused(), 0u);
    r.core.run_ready();
    CHECK(r.cell.queue.empty());  // all five drained by the one wake-up
    CHECK_EQ(r.svc.weight_mg(), 500);

    // The core's queue full: the post is refused and counted, and the tick drains the conversion.
    r.core.advance_ms(50);  // past the rate limit's grid: the next weight is not held back
    const TimeUs t1 = r.core.now() + 1'000;
    r.core.advance_to(t1);
    for (size_t i = 0; i < FakeCore::kPosts; ++i) {
        REQUIRE(r.core.post([] {}));
    }
    r.cell.push(7000, t1);
    CHECK_EQ(r.svc.wakes_refused(), 1u);
    r.core.run_ready();  // the fillers run; nothing posted for the conversion
    CHECK_EQ(r.cell.queue.size(), 1u);
    r.core.advance_us(ScaleService::kTickUs);
    CHECK(r.cell.queue.empty());
    CHECK_EQ(r.svc.weight_mg(), 7000);
    CHECK_EQ(r.weights().back().at, t1);
    CHECK(r.weights().back().emitted > t1);

    // Nothing left pending by the refusal: the next conversion wakes the core again.
    const TimeUs t2 = r.core.now() + 1'000;
    r.core.advance_to(t2);
    r.cell.push(8000, t2);
    r.core.run_ready();
    CHECK_EQ(r.svc.weight_mg(), 8000);
    CHECK_EQ(r.weights().back().emitted, t2);
    CHECK_EQ(r.svc.wakes_refused(), 1u);
}

TEST(scale_every_conversion_reported_at_100_hz)
{
    // The bench part's ~96 conversions a second (10.42 ms) at report_hz 100: every changed weight goes, the moment its
    // conversion lands, at its conversion's time; and so with +-2 ms of jitter on the conversions' times.
    for (const TimeUs jitter : {TimeUs{0}, TimeUs{2'000}}) {
        Rig r(stream_cfg());
        REQUIRE(r.start());
        const TimeUs t0 = r.core.now();
        constexpr int kN = 96 * 3;
        for (int i = 0; i < kN; ++i) {
            const TimeUs j = i >= 20 ? (i % 2 != 0 ? jitter : -jitter) : 0;
            const TimeUs t = t0 + 10'000 + static_cast<TimeUs>(i) * 10'417 + j;
            r.core.advance_to(t);
            r.cell.push(1000 + i * 7 * (i % 2 != 0 ? 1 : -1), t);
        }
        r.core.advance_ms(50);
        const auto w = r.weights();
        REQUIRE_EQ(w.size(), static_cast<size_t>(kN));
        for (size_t i = 0; i < w.size(); ++i) {
            CHECK_EQ(w[i].at, r.cell.times[i]);
            CHECK_EQ(w[i].emitted, w[i].at);  // no wait for a tick
        }
        CHECK(strictly_increasing(w));
        CHECK_EQ(r.svc.wakes_refused(), 0u);
    }
    // The same through a watch at 100 Hz on the default config (deadband 100 mg, report_hz 10).
    Rig r;
    REQUIRE(r.start());
    r.hold(0, 100);
    REQUIRE(r.svc.watch_start({.report_hz = 100, .seconds = 10}));
    r.sink.clear();
    const size_t first = r.cell.times.size();
    r.feed_each(96 * 2, 10'417, [](int i) { return (i % 2 + 1) * 10; });
    const auto w = r.weights();
    CHECK_EQ(w.size(), static_cast<size_t>(96 * 2));
    CHECK(strictly_increasing(w));
    CHECK_EQ(w.front().at, r.cell.times[first]);
    CHECK(r.svc.watch_start({.report_hz = 101, .seconds = 1}).error() == fr::Err::invalid_args);
}

TEST(scale_report_times_strictly_increase_with_trailing_reports)
{
    // report_hz 10: most changes are held back and go as trailing reports, each at its conversion's time, never at
    // the tick's (a conversion whose edge fell before the tick but that reaches the service after it must not be
    // older than the report the tick sent).
    Rig r;
    REQUIRE(r.start());
    for (int burst = 0; burst < 6; ++burst) {
        r.feed_each(3, k80Hz, [burst](int i) { return burst * 1000 + i * 200; });
        r.core.advance_ms(120);  // a pause: the held-back change goes with the tick after its grid point
    }
    auto w = r.weights();
    REQUIRE(w.size() >= 6u);
    CHECK(strictly_increasing(w));
    size_t trailing = 0;
    for (const Report &x : w) {
        CHECK(std::find(r.cell.times.begin(), r.cell.times.end(), x.at) != r.cell.times.end());
        trailing += x.emitted > x.at ? 1 : 0;
    }
    CHECK(trailing >= 5u);

    // The late one: an edge 50 µs before the tick that sent a trailing report, pushed after it.
    r.feed(20'000, 1);
    r.feed(20'500, 1);  // 12.5 ms later: held back
    r.core.advance_ms(120);
    w = r.weights();
    const Report tr = w.back();
    REQUIRE(tr.emitted > tr.at);
    r.core.advance_to(tr.emitted + 30);
    r.cell.push(30'000, tr.emitted - 50);
    r.core.advance_ms(200);
    w = r.weights();
    CHECK(strictly_increasing(w));
    CHECK_EQ(w.back().mg, 30'000);
    CHECK_EQ(w.back().at, tr.emitted - 50);

    // A calibration's weight is stamped at the clock: a conversion older than it, processed after, goes just after.
    Rig s(stream_cfg());
    REQUIRE(s.start());
    s.hold(1000, 700);
    REQUIRE(s.svc.stable());
    REQUIRE(s.svc.tare({.samples = 16}));
    const Report tare = s.weights().back();
    CHECK_EQ(tare.mg, 0);
    CHECK_EQ(tare.at, s.core.now());
    s.cell.push(1500, s.core.now() - 100);
    s.core.advance_ms(50);
    CHECK_EQ(s.weights().back().mg, 500);
    CHECK_EQ(s.weights().back().at, tare.at + 1);
    CHECK(strictly_increasing(s.weights()));
}

TEST(scale_watch_reports_every_change_then_falls_back)
{
    Rig r;  // deadband 100: the 10 mg steps below are only seen during a watch
    REQUIRE(r.start());
    r.hold(0, 200);
    r.sink.clear();
    REQUIRE(r.svc.watch_start({.report_hz = 80, .seconds = 2}));
    CHECK(r.svc.watching());
    r.feed_each(80, k80Hz, [](int i) { return (i % 2) * 10; });
    CHECK(r.weights().size() >= 79u);  // every conversion changed, at 80 Hz
    r.core.advance_ms(1100);  // past the watch's 2 s
    CHECK(!r.svc.watching());
    r.sink.clear();
    r.feed_each(40, k80Hz, [](int i) { return (i % 2) * 10; });
    CHECK_EQ(r.weights().size(), 0u);  // the deadband again

    // watch_stop ends it now; a newer watch_start replaces the running one (its own end).
    REQUIRE(r.svc.watch_start({.report_hz = 80, .seconds = 1}));
    REQUIRE(r.svc.watch_start({.report_hz = 20, .seconds = 3}));
    r.core.advance_ms(1500);
    CHECK(r.svc.watching());
    REQUIRE(r.svc.watch_stop());
    CHECK(!r.svc.watching());
    CHECK(r.svc.watch_stop());  // OK when none runs
    CHECK(r.svc.watch_start({.report_hz = 0, .seconds = 1}).error() == fr::Err::invalid_args);
    CHECK(r.svc.watch_start({.report_hz = 80, .seconds = 0}).error() == fr::Err::invalid_args);
}

TEST(scale_watch_on_a_fast_part_reports_at_most_its_rate)
{
    // The bench part converts ~96 times a second (10.42 ms): a watch at 80 Hz reports nearly 80 a second, never more.
    Rig r;
    REQUIRE(r.start());
    r.hold(0, 100);
    REQUIRE(r.svc.watch_start({.report_hz = 80, .seconds = 10}));
    r.sink.clear();
    r.feed_each(96 * 3, 10'417, [](int i) { return i * 7; });
    const auto w = r.weights();
    // ~3 s of conversions (the feed's drain ticks add a little): 3 x 80 = 240 at most, plus the grid's one-period burst.
    CHECK(w.size() >= 225u);
    CHECK(w.size() <= 242u);
    for (size_t i = 1; i < w.size(); ++i) {
        CHECK(w[i].at - w[i - 1].at >= 6'250);  // never faster than half a period
    }
}

TEST(scale_stable_and_settled)
{
    Rig r;  // stable 500 mg for 500 ms, settle_min 2,000 mg
    REQUIRE(r.start());
    r.hold(0, 450);
    CHECK(!r.svc.stable());
    r.hold(0, 200);
    CHECK(r.svc.stable());
    CHECK_EQ(r.settled().size(), 0u);  // 0 from 0: nothing put on

    r.hold(100'000, 100);  // 100 g put on
    CHECK(!r.svc.stable());
    r.hold(100'000, 600);
    CHECK(r.svc.stable());
    REQUIRE_EQ(r.settled().size(), 1u);
    CHECK_EQ(r.settled()[0].weight_mg, 100'000);
    CHECK_EQ(r.settled()[0].delta_mg, 100'000);

    r.hold(101'000, 700);  // 1 g more: unstable, stable again, but under settle_min
    CHECK(r.svc.stable());
    CHECK_EQ(r.settled().size(), 1u);

    r.hold(0, 700);  // taken off: from the last settled weight (100 g), not from the 101 g
    REQUIRE_EQ(r.settled().size(), 2u);
    CHECK_EQ(r.settled()[1].weight_mg, 0);
    CHECK_EQ(r.settled()[1].delta_mg, -100'000);

    // Noise within +-400 mg keeps it stable, and so does a slow drift (2 g over 5 s: the run is renewed).
    const size_t before = r.stables().size();
    r.feed_each(80, k80Hz, [](int i) { return (i % 2) * 800 - 400; });
    r.hold(0, 1100);
    r.feed_each(400, k80Hz, [](int i) { return i * 5; });
    CHECK(r.svc.stable());
    CHECK_EQ(r.stables().size(), before);
    std::vector<bool> expect{true, false, true, false, true, false, true};
    CHECK(r.stables() == expect);
}

TEST(scale_tare_window_busy_failed_and_kept)
{
    Rig r;
    REQUIRE(r.start());
    r.hold(5000, 100);
    CHECK(r.svc.tare({.samples = 16}).error() == fr::Err::busy);  // not stable yet
    r.hold(5000, 500);
    REQUIRE(r.svc.stable());
    CHECK(r.svc.tare({.samples = 64}).error() == fr::Err::busy);  // fewer held since it was last unstable
    REQUIRE_EQ(r.settled().size(), 1u);                           // 5 g settled from 0

    // The mean of the last 16 conversions: 4990 and 5010 alternating.
    r.feed_each(16, k80Hz, [](int i) { return 4990 + (i % 2) * 20; });
    r.settings.refuse = fr::Err::busy;  // fr_worker's queue full: nothing changes
    CHECK(r.svc.tare({.samples = 16}).error() == fr::Err::busy);
    CHECK_EQ(r.svc.offset(), 0);
    r.settings.refuse.reset();
    auto t = r.svc.tare({.samples = 16});
    REQUIRE(t);
    CHECK_EQ(t->offset, 5000);
    CHECK_EQ(t->raw, 5000);
    CHECK_EQ(r.svc.offset(), 5000);
    CHECK_EQ(r.settings.kept["off.p3"], 5000);
    CHECK(r.svc.stable());  // a tare is not a change of what is on the scale
    r.hold(5000, 700);
    CHECK_EQ(r.svc.weight_mg(), 0);
    CHECK(r.weights().back().mg >= -10 && r.weights().back().mg <= 10);  // reported at once (+-10), then in the deadband
    CHECK_EQ(r.settled().size(), 1u);  // the tare was not taken for something taken off
    r.hold(0, 700);                    // the 5 g taken off reads -5 g
    REQUIRE_EQ(r.settled().size(), 2u);
    CHECK_EQ(r.settled()[1].weight_mg, -5000);
    CHECK_EQ(r.settled()[1].delta_mg, -5000);

    // The part stops answering: FAILED once a second went by without a conversion.
    r.core.advance_ms(1100);
    CHECK(r.svc.tare({.samples = 16}).error() == fr::Err::failed);
}

TEST(scale_calibrate_invalid_busy_and_factor)
{
    Rig r;  // counts_per_kg 1,000,000 until calibrated
    REQUIRE(r.start());
    r.hold(0, 700);
    CHECK(r.svc.calibrate({.known_mg = 0, .samples = 16}).error() == fr::Err::invalid_args);
    CHECK(r.svc.calibrate({.known_mg = 500'000, .samples = 16}).error() == fr::Err::invalid_args);  // nothing on it
    r.hold(400, 700);  // 400 mg: within stable_mg of zero, still "at the offset"
    CHECK(r.svc.calibrate({.known_mg = 500'000, .samples = 16}).error() == fr::Err::invalid_args);
    r.hold(210'000, 100);
    CHECK(r.svc.calibrate({.known_mg = 500'000, .samples = 16}).error() == fr::Err::busy);  // not stable yet
    r.hold(210'000, 600);
    auto c = r.svc.calibrate({.known_mg = 500'000, .samples = 16});
    REQUIRE(c);
    CHECK_EQ(c->counts_per_kg, 420'000);
    CHECK_EQ(c->raw, 210'000);
    CHECK(r.svc.calibrated());
    CHECK(r.calibrateds() == std::vector<bool>{true});
    CHECK_EQ(r.svc.counts_per_kg(), 420'000);
    CHECK_EQ(r.settings.kept["cpk.p3"], 420'000);
    CHECK_EQ(r.svc.weight_mg(), 500'000);
    const size_t settled = r.settled().size();
    r.hold(210'000, 700);
    CHECK_EQ(r.settled().size(), settled);  // the known mass was settled before: no event for the new factor
    r.hold(0, 700);                         // taken off
    CHECK_EQ(r.settled().back().weight_mg, 0);
    CHECK_EQ(r.settled().back().delta_mg, -500'000);
    // A factor beyond i32: INVALID_ARGS.
    r.hold(8'000'000, 700);
    CHECK(r.svc.calibrate({.known_mg = 1, .samples = 16}).error() == fr::Err::invalid_args);
}

TEST(scale_calibrate_judges_an_empty_scale_in_raw_counts)
{
    // A mistyped calibration (known_mg 500 for a 500 g mass: a factor 1000 times too large) makes the mass read
    // 500 mg. The next calibration must not take that for an empty scale: emptiness is judged in raw counts.
    Rig r;
    REQUIRE(r.start());
    r.hold(0, 700);
    REQUIRE(r.svc.tare({.samples = 16}));
    r.hold(210'000, 700);
    auto wrong = r.svc.calibrate({.known_mg = 500, .samples = 16});
    REQUIRE(wrong);
    CHECK_EQ(wrong->counts_per_kg, 420'000'000);
    CHECK_EQ(r.svc.weight_mg(), 500);  // within stable_mg of zero in the factor in use
    auto right = r.svc.calibrate({.known_mg = 500'000, .samples = 16});
    REQUIRE(right);
    CHECK_EQ(right->counts_per_kg, 420'000);
    CHECK_EQ(r.svc.weight_mg(), 500'000);

    // Noise (the config's factor, 1 count a mg; the filter averages pairs so the weight stays stable): codes
    // 800 +- 300 about the offset are within 4 standard deviations of it (nothing on the scale), though beyond
    // stable_mg (500 counts at the config's factor); 3,000 +- 300 is a mass.
    ScaleConfig ema = mg_cfg();
    ema.filter = ScaleFilter::ema;
    Rig n(ema);
    REQUIRE(n.start());
    n.hold(0, 700);
    REQUIRE(n.svc.tare({.samples = 16}));
    n.feed_each(60, k80Hz, [](int i) { return 800 + (i % 2 ? 300 : -300); });
    CHECK(n.svc.calibrate({.known_mg = 500'000, .samples = 16}).error() == fr::Err::invalid_args);
    n.feed_each(60, k80Hz, [](int i) { return 3000 + (i % 2 ? 300 : -300); });
    auto noisy = n.svc.calibrate({.known_mg = 500'000, .samples = 16});
    REQUIRE(noisy);
    CHECK_EQ(noisy->counts_per_kg, 6'000);
}

TEST(scale_calibration_is_kept_across_a_reinit_until_reset)
{
    FakeSettings nvs;
    {
        Rig a(mg_cfg(), &nvs);
        REQUIRE(a.start());
        a.hold(5000, 700);
        REQUIRE(a.svc.tare({.samples = 16}));
        a.hold(5000 + 210'000, 700);
        REQUIRE(a.svc.calibrate({.known_mg = 500'000, .samples = 16}));
    }
    CHECK_EQ(nvs.kept["off.p3"], 5000);
    CHECK_EQ(nvs.kept["cpk.p3"], 420'000);

    Rig b(mg_cfg(), &nvs);  // a reboot
    REQUIRE(b.start());
    CHECK(b.svc.calibrated());
    CHECK_EQ(b.svc.offset(), 5000);
    CHECK_EQ(b.svc.counts_per_kg(), 420'000);
    b.feed(5000 + 420'000, 1);
    CHECK_EQ(b.svc.weight_mg(), 1'000'000);
    auto rd = b.svc.read();
    REQUIRE(rd);
    CHECK_EQ(rd->offset, 5000);
    CHECK_EQ(rd->counts_per_kg, 420'000);
    CHECK(rd->calibrated);

    nvs.refuse = fr::Err::busy;
    CHECK(b.svc.reset_calibration().error() == fr::Err::busy);
    CHECK(b.svc.calibrated());
    CHECK_EQ(nvs.kept.size(), 2u);  // nothing forgotten: both keys go in one write or neither does
    CHECK_EQ(b.svc.offset(), 5000);
    nvs.refuse.reset();
    REQUIRE(b.svc.reset_calibration());
    CHECK_EQ(nvs.log.back(), "erase off.p3 cpk.p3");
    CHECK(nvs.kept.empty());
    CHECK(!b.svc.calibrated());
    CHECK(b.calibrateds() == std::vector<bool>{false});
    CHECK_EQ(b.svc.offset(), 0);
    CHECK_EQ(b.svc.counts_per_kg(), 1'000'000);
    CHECK_EQ(b.svc.weight_mg(), 425'000);  // the same conversion in the config's factor
    CHECK(b.svc.reset_calibration());      // idempotent

    // A kept offset that is no 24-bit code is not ours; a store that cannot be read leaves the config's.
    FakeSettings odd;
    odd.kept["off.p3"] = 1 << 24;
    Rig c(mg_cfg(), &odd);
    REQUIRE(c.start());
    CHECK_EQ(c.svc.offset(), 0);
    FakeSettings broken;
    broken.kept["cpk.p3"] = 420'000;
    broken.fail_get = true;
    Rig d(mg_cfg(), &broken);
    REQUIRE(d.start());
    CHECK(!d.svc.calibrated());
    CHECK_EQ(d.svc.counts_per_kg(), 1'000'000);
}

TEST(scale_inject_holds_a_weight)
{
    Rig r;
    REQUIRE(r.start());
    r.hold(1000, 700);
    REQUIRE(r.svc.inject({.weight_mg = 250'000, .hold_ms = 0}));
    CHECK_EQ(r.svc.weight_mg(), 250'000);
    auto rd = r.svc.read();
    REQUIRE(rd);
    CHECK(rd->injected);
    CHECK_EQ(rd->weight_mg, 250'000);
    r.hold(1000, 900);  // the part goes on converting; the held weight wins, and settles
    CHECK_EQ(r.svc.weight_mg(), 250'000);
    CHECK(r.svc.read()->raw == 1000);
    REQUIRE(!r.settled().empty());
    CHECK_EQ(r.settled().back().weight_mg, 250'000);
    r.hold(1000, 200);  // past 1,000 ms
    CHECK(!r.svc.read()->injected);
    CHECK_EQ(r.svc.weight_mg(), 1000);  // the filter re-seeded by the first real conversion
    CHECK(strictly_increasing(r.weights()));  // held weights at the clock, conversions at their times

    // hold_ms is clamped to 60,000.
    REQUIRE(r.svc.inject({.weight_mg = 5, .hold_ms = 65'000}));
    r.core.advance_ms(59'990);
    CHECK(r.svc.read()->injected);
    r.core.advance_ms(20);
    CHECK(!r.svc.read()->injected);
}

TEST(scale_inject_works_with_a_dead_part)
{
    Rig r;
    REQUIRE(r.start());
    REQUIRE(r.svc.inject({.weight_mg = 100'000, .hold_ms = 5000}));
    r.core.advance_ms(700);
    CHECK(r.svc.stable());
    REQUIRE_EQ(r.settled().size(), 1u);
    CHECK_EQ(r.settled()[0].weight_mg, 100'000);
    CHECK_EQ(r.weights().back().mg, 100'000);
    CHECK(r.svc.tare({.samples = 1}).error() == fr::Err::failed);  // tare needs the part
    r.core.advance_ms(5000);
    CHECK(!r.svc.stable());  // the hold ended and nothing converts
}

TEST(scale_dead_part_reads_rate_zero)
{
    Rig r;
    REQUIRE(r.start());
    r.core.advance_ms(2500);
    CHECK_EQ(r.svc.rate_hz(), 0);
    CHECK(r.rates().empty());  // 0 from the start: nothing to report
    CHECK(!r.svc.stable());
    CHECK(r.svc.tare({.samples = 16}).error() == fr::Err::failed);
    CHECK(r.svc.calibrate({.known_mg = 1000, .samples = 16}).error() == fr::Err::failed);
    auto rd = r.svc.read();
    REQUIRE(rd);
    CHECK_EQ(rd->rate_hz, 0);

    // Converting at 80 Hz: 80 at the next whole second. The part then stops: 0, and stable falls.
    // (The fake counts (now - 1 s, now]: a tick that lands on a conversion's time runs before it is pushed, so 79.)
    r.hold(0, 2000);
    CHECK(r.svc.rate_hz() >= 79 && r.svc.rate_hz() <= 80);
    CHECK(r.svc.stable());
    r.core.advance_ms(2100);
    CHECK_EQ(r.svc.rate_hz(), 0);
    CHECK(!r.svc.stable());
    const auto rates = r.rates();  // partial seconds may show between: ~80 while converting, 0 at the end
    CHECK(std::any_of(rates.begin(), rates.end(), [](uint8_t v) { return v >= 79; }));
    REQUIRE(!rates.empty());
    CHECK_EQ(rates.back(), 0);
}

TEST(scale_rate_is_not_clamped_to_the_nominal_80)
{
    Rig r;
    REQUIRE(r.start());
    r.feed(0, 96 * 3, 10'417);  // the bench part: ~96 conversions a second
    CHECK(r.svc.rate_hz() >= 95);
    CHECK(r.svc.rate_hz() <= 97);
    CHECK_EQ(r.svc.traits().max_rate_hz, 80);
}
