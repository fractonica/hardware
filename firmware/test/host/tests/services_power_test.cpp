// BatteryService and HapticService against FakeCore, a fake power cell, a fake haptic output and fake settings (design
// power-p1 D2-D7): the charger decoder's truth table, hold and blink rule; the divider, filter, levels with hysteresis,
// percent tables and reports; calibrate kept across a re-init; the test load (timer, floor, critical); the gate's
// automatic rule and the ceiling; inject; haptic compensation, programs, solenoid kick/hold, the supply's refusals and
// cuts, max_on and the cooldown budget.
#include <cstdint>
#include <vector>

#include "fr/power/charger.hpp"
#include "fr/services/battery_service.hpp"
#include "fr/services/haptic_service.hpp"
#include "tests/fake_core.hpp"
#include "tests/fixture_link.hpp"
#include "tests/scale_fakes.hpp"
#include "tests/test.hpp"

namespace {

using fr::BatteryService;
using fr::HapticService;
using fr::TimeUs;
using fr::cap::BatteryCellLevel;
using fr::cap::BatteryChargerMode;
using fr::cap::BatteryChemistry;
using fr::cap::BatteryConfig;
using fr::cap::HapticConfig;
using fr::cap::HapticCutReason;
using fr::cap::HapticKind;
using fr::hal::ChargerPins;
using fr::power::Charger;
using fr::power::ChargerDecoder;
using frt::FakeCore;
using frt::FakeSettings;
using frt::RecordingSink;

class FakeCell final : public fr::hal::PowerCell
{
public:
    explicit FakeCell(fr::hal::PowerCellFeatures f = {true, true, false}) : feat(f) {}

    fr::Status init(fr::Core &) override
    {
        ++inits;
        load = false;
        gate = false;
        return {};
    }
    fr::hal::PowerCellFeatures features() const override { return feat; }
    fr::Status read(fr::hal::AnalogReading &out) override
    {
        if (fail_read) {
            return std::unexpected(fr::Err::failed);
        }
        out.mv = pin_mv;
        out.raw = pin_mv;
        return {};
    }
    ChargerPins status() override { return pins; }
    fr::Status set_load(bool on) override
    {
        if (!feat.load) {
            return std::unexpected(fr::Err::unsupported);
        }
        load = on;
        load_writes.push_back(on);
        return {};
    }
    fr::Status set_gate(bool open) override
    {
        if (!feat.gate) {
            return std::unexpected(fr::Err::unsupported);
        }
        gate = open;
        gate_writes.push_back(open);
        return {};
    }
    fr::hal::Selftest selftest() override { return {true, "fake"}; }

    fr::hal::PowerCellFeatures feat;
    uint16_t pin_mv = 1900;  // x2 = 3800 mV
    ChargerPins pins{};      // unplugged
    bool fail_read = false;
    bool load = false;
    bool gate = false;
    std::vector<bool> load_writes;
    std::vector<bool> gate_writes;
    int inits = 0;
};

class FakeHapticOut final : public fr::hal::HapticOutput
{
public:
    explicit FakeHapticOut(const FakeCore &core, bool pwm = true) : core_(core), is_pwm(pwm) {}
    fr::Status init(fr::Core &) override
    {
        ++inits;
        return {};
    }
    bool pwm() const override { return is_pwm; }
    fr::Status write(uint16_t d) override
    {
        duty = d;
        writes.push_back({d, core_.now()});
        return {};
    }
    fr::hal::Selftest selftest() override { return {true, "fake"}; }

    struct Write {
        uint16_t duty;
        TimeUs at;
    };
    const FakeCore &core_;
    bool is_pwm;
    uint16_t duty = 0;
    std::vector<Write> writes;
    int inits = 0;
};

constexpr uint8_t kBatPort = 5;
constexpr uint8_t kHapPort = 7;

BatteryConfig lic_cfg()
{
    BatteryConfig c{};
    c.chemistry = BatteryChemistry::lic;
    c.full_mv = 4200;
    c.report_hz = 10;
    return c;
}

struct BatRig {
    explicit BatRig(BatteryConfig cfg = {}, fr::hal::PowerCellFeatures f = {true, true, false},
                    FakeSettings *shared = nullptr)
        : cell(f), settings(shared != nullptr ? *shared : own), svc(cell, settings, cfg)
    {
        svc.attach(kBatPort, "battery", sink);
        // A live hub on this rig's clock (the load's and the haptics' hub-silence rule read it).
        frt::fixture_link() = {};
        frt::fixture_link().core = &core;
    }
    bool start()
    {
        if (!svc.init(core)) {
            return false;
        }
        core.run_ready();
        return true;
    }
    /** The pin at mv / 2 (the default divider), held long enough for the EMA to settle. */
    void settle(uint16_t cell_mv, uint32_t ms = 3000)
    {
        cell.pin_mv = static_cast<uint16_t>(cell_mv / 2);
        core.advance_ms(ms);
    }
    std::vector<RecordingSink::Emission> events(uint8_t id) const
    {
        std::vector<RecordingSink::Emission> out;
        for (const auto &e : sink.events()) {
            if (e.id == id) {
                out.push_back(e);
            }
        }
        return out;
    }
    std::vector<uint64_t> props(uint8_t id) const
    {
        std::vector<uint64_t> out;
        for (const auto &e : sink.properties()) {
            if (e.id == id) {
                out.push_back(frt::field_u(e.bytes, 1));
            }
        }
        return out;
    }

    FakeCore core;
    RecordingSink sink{core};
    FakeCell cell;
    FakeSettings own;
    FakeSettings &settings;
    BatteryService svc;
};

// ---- the charger decoder ----

TEST(charger_decoder_truth_table)
{
    CHECK(fr::power::charger_of({true, false}) == Charger::charging);
    CHECK(fr::power::charger_of({false, true}) == Charger::charged);
    CHECK(fr::power::charger_of({false, false}) == Charger::unplugged);
    CHECK(fr::power::charger_of({true, true}) == Charger::fault);
}

TEST(charger_decoder_first_sample_counts_at_once_then_holds_300ms)
{
    ChargerDecoder d;
    auto first = d.update({false, false}, 0);
    REQUIRE(first.has_value());
    CHECK(*first == Charger::unplugged);
    // Plugged in: charging must hold 300 ms.
    CHECK(!d.update({true, false}, 100'000).has_value());
    CHECK(!d.update({true, false}, 300'000).has_value());
    auto c = d.update({true, false}, 400'000);
    REQUIRE(c.has_value());
    CHECK(*c == Charger::charging);
    // A 200 ms bounce to unplugged does not count.
    CHECK(!d.update({false, false}, 500'000).has_value());
    CHECK(!d.update({true, false}, 700'000).has_value());
    CHECK(!d.update({true, false}, 1'200'000).has_value());
    CHECK(d.state() == Charger::charging);
}

TEST(charger_decoder_fault_needs_two_seconds)
{
    ChargerDecoder d;
    d.update({false, true}, 0);  // charged
    TimeUs t = 0;
    for (int i = 0; i < 15; ++i) {
        t += 100'000;
        CHECK(!d.update({true, true}, t).has_value());
    }
    std::optional<Charger> got;
    for (int i = 0; i < 10 && !got; ++i) {
        t += 100'000;
        got = d.update({true, true}, t);
    }
    REQUIRE(got.has_value());
    CHECK(*got == Charger::fault);
}

TEST(charger_decoder_blinking_chrg_with_stdby_low_is_no_cell)
{
    ChargerDecoder d;
    d.update({false, true}, 0);
    // CHRG toggles every 600 ms with STDBY low (TP4056 with nothing on BAT).
    bool low = false;
    std::optional<Charger> last;
    for (TimeUs t = 100'000; t <= 6'000'000; t += 100'000) {
        if (t % 600'000 == 0) {
            low = !low;
        }
        if (auto c = d.update({low, true}, t)) {
            last = c;
        }
    }
    REQUIRE(last.has_value());
    CHECK(*last == Charger::no_cell);
    CHECK(d.state() == Charger::no_cell);
}

// ---- BatteryService ----

TEST(battery_first_sample_reports_everything_and_derives_traits)
{
    BatRig r;
    REQUIRE(r.start());
    CHECK(r.svc.traits().status_pins);
    CHECK(r.svc.traits().test_load);
    CHECK(!r.svc.traits().charge_gate);
    CHECK(r.svc.sampled());
    CHECK_EQ(r.svc.mv(), 3800);
    CHECK(r.svc.charger() == BatteryChargerMode::unplugged);
    CHECK(r.svc.level() == BatteryCellLevel::ok);
    CHECK_EQ(r.props(fr::cap::Battery::kPropMv).size(), 1u);
    CHECK_EQ(r.props(fr::cap::Battery::kPropPercent).size(), 1u);
    CHECK_EQ(r.props(fr::cap::Battery::kPropCharger).size(), 1u);
    CHECK_EQ(r.props(fr::cap::Battery::kPropLevel).size(), 1u);
    CHECK(r.events(fr::cap::Battery::kEventLevelChange).empty());  // ok at boot: no event
    CHECK(r.events(fr::cap::Battery::kEventCharge).empty());       // the boot state: no event
    CHECK_EQ(r.cell.inits, 1);
}

TEST(battery_chemistry_defaults_and_config_override)
{
    BatRig li;
    CHECK_EQ(li.svc.full_mv(), 4200);
    CHECK_EQ(li.svc.floor_mv(), 3000);
    BatteryConfig c{};
    c.chemistry = BatteryChemistry::lifepo4;
    BatRig fe(c);
    CHECK_EQ(fe.svc.full_mv(), 3600);
    CHECK_EQ(fe.svc.critical_mv(), 2800);
    BatRig lic(lic_cfg());
    CHECK_EQ(lic.svc.full_mv(), 4200);  // config
    CHECK_EQ(lic.svc.low_mv(), 3000);
    CHECK_EQ(lic.svc.floor_mv(), 2700);
    CHECK_EQ(lic.svc.charge_to_mv(), 4200);
}

TEST(battery_refuses_bad_config)
{
    BatteryConfig c{};
    c.low_mv = 3200;  // below critical 3300
    BatRig r(c);
    CHECK(!r.svc.init(r.core).has_value());
    BatteryConfig d{};
    d.report_hz = 0;
    BatRig r2(d);
    CHECK(!r2.svc.init(r2.core).has_value());
}

TEST(battery_percent_tables)
{
    using V = BatteryService::Voltages;
    const V li = BatteryService::chemistry_voltages(BatteryChemistry::liion);
    CHECK_EQ(BatteryService::percent_of(4250, BatteryChemistry::liion, li), 100);
    CHECK_EQ(BatteryService::percent_of(4200, BatteryChemistry::liion, li), 100);
    CHECK_EQ(BatteryService::percent_of(4150, BatteryChemistry::liion, li), 95);
    CHECK_EQ(BatteryService::percent_of(3000, BatteryChemistry::liion, li), 0);
    CHECK_EQ(BatteryService::percent_of(2500, BatteryChemistry::liion, li), 0);
    const V lic = {4000, 3000, 2800, 2700};
    CHECK_EQ(BatteryService::percent_of(2700, BatteryChemistry::lic, lic), 0);
    CHECK_EQ(BatteryService::percent_of(3350, BatteryChemistry::lic, lic), 50);
    CHECK_EQ(BatteryService::percent_of(4100, BatteryChemistry::lic, lic), 100);
    const V fe = BatteryService::chemistry_voltages(BatteryChemistry::lifepo4);
    CHECK_EQ(BatteryService::percent_of(3300, BatteryChemistry::lifepo4, fe), 70);
}

TEST(battery_ema_and_rate_limited_reports)
{
    BatRig r;  // report_hz 1, deadband 5
    REQUIRE(r.start());
    r.sink.clear();
    r.cell.pin_mv = 1950;  // 3900
    r.core.advance_ms(300);
    // The EMA moves toward 3900 but the first report waits for 1 s since the last.
    CHECK(r.props(fr::cap::Battery::kPropMv).empty());
    r.core.advance_ms(2000);
    auto mvs = r.props(fr::cap::Battery::kPropMv);
    REQUIRE(!mvs.empty());
    CHECK(mvs.size() <= 3u);
    r.core.advance_ms(3000);
    mvs = r.props(fr::cap::Battery::kPropMv);
    CHECK_EQ(mvs.back(), 3900u);
    CHECK_EQ(r.svc.mv(), 3900);
}

TEST(battery_levels_fall_at_once_and_rise_with_hysteresis)
{
    BatRig r;
    REQUIRE(r.start());
    r.settle(3450);  // below low 3500
    CHECK(r.svc.level() == BatteryCellLevel::low);
    r.settle(3520);  // above low but within the 50 mV hysteresis
    CHECK(r.svc.level() == BatteryCellLevel::low);
    r.settle(3560);
    CHECK(r.svc.level() == BatteryCellLevel::ok);
    auto ev = r.events(fr::cap::Battery::kEventLevelChange);
    REQUIRE_EQ(ev.size(), 2u);
    CHECK_EQ(frt::field_u(ev[0].bytes, 1), static_cast<uint64_t>(BatteryCellLevel::low));
    CHECK_EQ(frt::field_u(ev[1].bytes, 1), static_cast<uint64_t>(BatteryCellLevel::ok));
}

TEST(battery_boot_below_low_emits_level_change)
{
    BatRig r;
    r.cell.pin_mv = 1700;  // 3400: low
    REQUIRE(r.start());
    auto ev = r.events(fr::cap::Battery::kEventLevelChange);
    REQUIRE_EQ(ev.size(), 1u);
    CHECK_EQ(frt::field_u(ev[0].bytes, 1), static_cast<uint64_t>(BatteryCellLevel::low));
}

TEST(battery_charger_events_from_pins)
{
    BatRig r;
    REQUIRE(r.start());
    r.cell.pins = {true, false};
    r.core.advance_ms(500);
    CHECK(r.svc.charger() == BatteryChargerMode::charging);
    r.cell.pins = {false, true};
    r.core.advance_ms(500);
    CHECK(r.svc.charger() == BatteryChargerMode::charged);
    auto ev = r.events(fr::cap::Battery::kEventCharge);
    REQUIRE_EQ(ev.size(), 2u);
    CHECK_EQ(frt::field_u(ev[0].bytes, 1), static_cast<uint64_t>(BatteryChargerMode::charging));
    CHECK_EQ(frt::field_u(ev[1].bytes, 1), static_cast<uint64_t>(BatteryChargerMode::charged));
    CHECK(ev[1].prio == fr::cap::Priority::normal);
}

TEST(battery_without_status_pins_reports_none)
{
    BatRig r({}, {false, false, false});
    REQUIRE(r.start());
    r.cell.pins = {true, false};
    r.core.advance_ms(1000);
    CHECK(r.svc.charger() == BatteryChargerMode::none);
    CHECK(!r.svc.traits().status_pins);
}

TEST(battery_calibrate_keeps_divider_across_reinit)
{
    FakeSettings kept;
    {
        BatRig r({}, {true, true, false}, &kept);
        REQUIRE(r.start());
        r.settle(3800);
        auto res = r.svc.calibrate({.meter_mv = 3876});
        REQUIRE(res.has_value());
        CHECK_EQ(res->divider_milli, 2040);
        CHECK_EQ(res->adc_mv, 1900);
        CHECK_EQ(r.svc.mv(), 3876);
        CHECK(r.svc.calibrated());
        CHECK_EQ(std::string(r.svc.divider_key()), std::string("div.p5"));
    }
    BatRig again({}, {true, true, false}, &kept);
    REQUIRE(again.start());
    CHECK_EQ(again.svc.divider_milli(), 2040);
    CHECK(again.svc.calibrated());
    CHECK(again.svc.reset_calibration().has_value());
    CHECK_EQ(again.svc.divider_milli(), 2000);
    CHECK(!again.svc.calibrated());
    CHECK(kept.kept.empty());
}

TEST(battery_calibrate_refusals)
{
    BatRig r;
    CHECK(r.svc.calibrate({.meter_mv = 3800}).error() == fr::Err::busy);  // before init
    REQUIRE(r.start());
    CHECK(r.svc.calibrate({.meter_mv = 0}).error() == fr::Err::invalid_args);
    CHECK(r.svc.calibrate({.meter_mv = 60000}).error() == fr::Err::invalid_args);  // x31.6: out of range
    // A meter typo (3100 for 3900) is a divider of 1.632, more than 15 % from the configured 2.000: refused.
    CHECK(r.svc.calibrate({.meter_mv = 3100}).error() == fr::Err::invalid_args);
    CHECK(r.svc.calibrate({.meter_mv = 4400}).error() == fr::Err::invalid_args);  // 2.316: too high
    r.settings.refuse = fr::Err::busy;
    CHECK(r.svc.calibrate({.meter_mv = 3876}).error() == fr::Err::busy);
    CHECK_EQ(r.svc.divider_milli(), 2000);  // nothing changed
}

TEST(battery_load_runs_for_its_seconds_and_stops_itself)
{
    BatRig r;
    REQUIRE(r.start());
    CHECK(r.svc.load({.on = true, .seconds = 2}).has_value());
    CHECK(r.cell.load);
    CHECK(r.svc.load_on());
    r.core.advance_ms(1900);
    CHECK(r.cell.load);
    r.core.advance_ms(200);
    CHECK(!r.cell.load);
    CHECK(!r.svc.load_on());
    auto on = r.props(fr::cap::Battery::kPropLoadOn);
    REQUIRE_EQ(on.size(), 3u);  // boot false, true, false
    CHECK_EQ(on[1], 1u);
}

TEST(battery_load_refused_at_critical_and_cut_at_floor)
{
    BatRig r;
    REQUIRE(r.start());
    CHECK(r.svc.load({.on = true, .seconds = 600}).has_value());
    r.settle(3200);  // critical: a running load goes on
    CHECK(r.cell.load);
    // A renewal of the running load is accepted at critical (the hub's capacity test runs to the floor)...
    CHECK(r.svc.load({.on = true, .seconds = 10}).has_value());
    CHECK(r.cell.load);
    // ...but turning it on from off is not.
    CHECK(r.svc.load({.on = false}).has_value());
    CHECK(r.svc.load({.on = true, .seconds = 10}).error() == fr::Err::busy);
    CHECK(r.svc.load({.on = true, .seconds = 600}).error() == fr::Err::busy);
    r.settle(3600);  // back to ok
    CHECK(r.svc.load({.on = true, .seconds = 600}).has_value());
    r.settle(3200);
    CHECK(r.cell.load);
    r.settle(2950);  // empty
    CHECK(!r.cell.load);
    auto p = r.events(fr::cap::Battery::kEventProtect);
    REQUIRE_EQ(p.size(), 1u);
    CHECK_EQ(frt::field_u(p[0].bytes, 1), static_cast<uint64_t>(fr::cap::BatteryProtectReason::floor));
    CHECK(p[0].prio == fr::cap::Priority::realtime);
}

TEST(battery_load_and_gate_unsupported_without_pins)
{
    BatRig r({}, {true, false, false});
    REQUIRE(r.start());
    CHECK(r.svc.load({.on = true}).error() == fr::Err::unsupported);
    CHECK(r.svc.gate({.open = true}).error() == fr::Err::unsupported);
}

TEST(battery_gate_follows_charge_to_after_a_rest)
{
    BatteryConfig c = lic_cfg();
    c.full_mv = 4000;
    c.charge_to_mv = 3900;
    BatRig r(c, {true, false, true});
    r.cell.pin_mv = 1600;  // 3200
    r.cell.pins = {true, false};  // charging
    REQUIRE(r.start());
    CHECK(r.svc.gate_open());
    r.settle(3900);
    CHECK(!r.svc.gate_open());
    r.settle(3850);  // inside the 100 mV band: stays closed
    CHECK(!r.svc.gate_open());
    r.settle(3790);  // below the band, but the cell has not rested kGateDwellUs yet
    CHECK(!r.svc.gate_open());
    r.core.advance_ms(30'000);
    CHECK(r.svc.gate_open());
    // The input goes: closed.
    r.cell.pins = {false, false};
    r.core.advance_ms(500);
    CHECK(!r.svc.gate_open());
}

TEST(battery_gate_closed_reopens_through_no_cell_and_charged)
{
    // Closed, a TP4056 sees nothing on BAT: it blinks (no_cell) or says charged. Neither is "no input".
    BatteryConfig c = lic_cfg();
    c.full_mv = 4000;
    BatRig r(c, {true, false, true});
    r.cell.pin_mv = 1600;
    r.cell.pins = {false, true};  // charged (as a TP4056 with BAT disconnected reports it)
    REQUIRE(r.start());
    CHECK(r.svc.charger() == BatteryChargerMode::charged);
    CHECK(r.svc.gate_open());  // boot: closed, input not unplugged/fault, below charge_to: opens
    r.settle(4000);
    CHECK(!r.svc.gate_open());
    // Now blinking CHRG with STDBY low: no_cell. Once the cell has rested, low again, the gate reopens...
    const size_t closed_at = r.cell.gate_writes.size();
    r.settle(3700);
    for (int i = 0; i < 70; ++i) {
        r.cell.pins = {i % 2 == 0, true};
        r.core.advance_ms(500);
    }
    CHECK(r.svc.charger() == BatteryChargerMode::no_cell);
    bool reopened = false;
    for (size_t i = closed_at; i < r.cell.gate_writes.size(); ++i) {
        reopened = reopened || r.cell.gate_writes[i];
    }
    CHECK(reopened);
    // ...and, open, no_cell means the cell is not on the charger: closed again at once.
    CHECK(!r.svc.gate_open());
    // Unplugged while closed: stays closed however long it rests.
    r.cell.pins = {false, false};
    r.core.advance_ms(40'000);
    CHECK(r.svc.charger() == BatteryChargerMode::unplugged);
    CHECK(!r.svc.gate_open());
}

TEST(battery_gate_by_hand)
{
    BatteryConfig c = lic_cfg();
    c.full_mv = 4000;
    c.charge_to_mv = 3900;
    BatRig r(c, {true, false, true});
    r.cell.pin_mv = 1600;
    r.cell.pins = {true, false};
    REQUIRE(r.start());
    CHECK(r.svc.gate_open());
    // A hand close stands, rested or not, until the charger's state changes.
    CHECK(r.svc.gate({.open = false}).has_value());
    r.core.advance_ms(40'000);
    CHECK(!r.svc.gate_open());
    r.cell.pins = {false, false};
    r.core.advance_ms(500);
    r.cell.pins = {true, false};
    r.core.advance_ms(500);
    CHECK(r.svc.gate_open());  // the change cleared it; rested long ago
    // A hand open at or above charge_to is refused (the rule would close it at once)...
    r.settle(3950);
    CHECK(!r.svc.gate_open());
    CHECK(r.svc.gate({.open = true}).error() == fr::Err::busy);
    // ...and one opened by hand below charge_to closes when it gets there (review M1).
    r.settle(3700);
    CHECK(r.svc.gate({.open = true}).has_value());
    CHECK(r.svc.gate_open());
    r.settle(3910);
    CHECK(!r.svc.gate_open());
}

TEST(battery_gate_charge_to_and_ceiling_are_capped_by_the_chemistry)
{
    // A LIC at full 4200 (the ungated profile's) with a gate: the ceiling is the chemistry's 4200, never 4300, and the
    // gate stops 100 mV under it.
    BatteryConfig c = lic_cfg();  // full 4200
    BatRig r(c, {true, false, true});
    CHECK_EQ(r.svc.ceiling_mv(), 4200);
    CHECK_EQ(r.svc.charge_to_mv(), 4100);
    // full above the chemistry's maximum is a refused config.
    BatteryConfig bad = lic_cfg();
    bad.full_mv = 4300;
    BatRig b(bad);
    CHECK(!b.start());
}

TEST(battery_ceiling_closes_the_gate_and_fires_protect)
{
    BatteryConfig c = lic_cfg();
    c.full_mv = 4000;
    BatRig r(c, {true, false, true});
    r.cell.pin_mv = 1600;
    r.cell.pins = {true, false};
    REQUIRE(r.start());
    CHECK(r.svc.gate_open());
#if FR_TEST_HOOKS
    CHECK(r.svc.inject({.mv = 4150, .hold_ms = 500}).has_value());
#endif
    CHECK(!r.svc.gate_open());
    auto p = r.events(fr::cap::Battery::kEventProtect);
    REQUIRE_EQ(p.size(), 1u);
    CHECK_EQ(frt::field_u(p[0].bytes, 1), static_cast<uint64_t>(fr::cap::BatteryProtectReason::ceiling));
}

TEST(battery_inject_holds_mv_and_charger_then_lets_go)
{
    BatRig r;
    REQUIRE(r.start());
    CHECK(r.svc.inject({.mv = 3100, .charger = BatteryChargerMode::charging, .charger_set = true, .hold_ms = 1000})
              .has_value());
    CHECK_EQ(r.svc.mv(), 3100);
    CHECK(r.svc.level() == BatteryCellLevel::critical);
    CHECK(r.svc.charger() == BatteryChargerMode::charging);
    CHECK(r.svc.read()->injected);
    r.core.advance_ms(1200);
    CHECK_EQ(r.svc.mv(), 3800);
    CHECK(r.svc.charger() == BatteryChargerMode::unplugged);
    CHECK(r.svc.level() == BatteryCellLevel::ok);
    CHECK(!r.svc.read()->injected);
}

TEST(battery_read_busy_before_first_sample)
{
    BatRig r;
    CHECK(r.svc.read().error() == fr::Err::busy);
    REQUIRE(r.start());
    auto rd = r.svc.read();
    REQUIRE(rd.has_value());
    CHECK_EQ(rd->mv, 3800);
    CHECK_EQ(rd->adc_mv, 1900);
    CHECK_EQ(rd->divider_milli, 2000);
}

TEST(battery_calibration_from_nvs_outside_the_span_is_ignored)
{
    // A key left by another profile on this port (or written before the span rule): 1.500 against 2.000 configured.
    FakeSettings kept;
    REQUIRE(kept.set_i32("div.p5", 1500).has_value());
    BatRig r({}, {true, true, false}, &kept);
    REQUIRE(r.start());
    CHECK_EQ(r.svc.divider_milli(), 2000);
    CHECK(!r.svc.calibrated());
    FakeSettings ok;
    REQUIRE(ok.set_i32("div.p5", 2100).has_value());
    BatRig k({}, {true, true, false}, &ok);
    REQUIRE(k.start());
    CHECK_EQ(k.svc.divider_milli(), 2100);
    CHECK(k.svc.calibrated());
}

TEST(battery_load_ends_when_the_hub_goes_quiet_or_restarts)
{
    BatRig r;
    REQUIRE(r.start());
    CHECK(r.svc.load({.on = true, .seconds = 3600}).has_value());
    r.core.advance_ms(30'000);
    CHECK(r.cell.load);  // the hub is live
    frt::fixture_link().hub_stops();
    r.core.advance_ms(59'000);
    CHECK(r.cell.load);
    r.core.advance_ms(1'200);
    CHECK(!r.cell.load);  // 60 s after its newest frame

    BatRig e;
    REQUIRE(e.start());
    CHECK(e.svc.load({.on = true, .seconds = 3600}).has_value());
    e.core.advance_ms(1000);
    frt::fixture_link().epoch = 42;  // a WELCOME of another hub run
    e.core.advance_ms(200);
    CHECK(!e.cell.load);

    // Without a hub session at the start (a local app), the hub's silence does not end it.
    BatRig l;
    REQUIRE(l.start());
    frt::fixture_link().session = false;
    frt::fixture_link().hub_stops();
    CHECK(l.svc.load({.on = true, .seconds = 120}).has_value());
    l.core.advance_ms(90'000);
    CHECK(l.cell.load);
}

TEST(battery_persistent_read_errors_make_the_reading_stale)
{
    BatRig r;
    REQUIRE(r.start());
    CHECK(r.svc.load({.on = true, .seconds = 600}).has_value());
    r.cell.fail_read = true;
    r.core.advance_ms(500);
    CHECK(r.cell.load);  // a few failures are tolerated
    CHECK(r.svc.reading_ok());
    r.core.advance_ms(700);
    CHECK(!r.svc.reading_ok());
    CHECK(!r.cell.load);
    CHECK(r.svc.load({.on = true}).error() == fr::Err::busy);
    r.cell.fail_read = false;
    r.core.advance_ms(200);
    CHECK(r.svc.reading_ok());
    CHECK(r.svc.load({.on = true}).has_value());
}

#if FR_TEST_HOOKS
TEST(battery_inject_before_any_reading_leaves_none)
{
    BatRig r;
    r.cell.fail_read = true;
    REQUIRE(r.start());
    CHECK(!r.svc.sampled());
    CHECK(r.svc.inject({.mv = 3900, .hold_ms = 500}).has_value());
    CHECK(r.svc.reading_ok());
    CHECK_EQ(r.svc.mv(), 3900);
    r.core.advance_ms(700);
    CHECK(!r.svc.sampled());
    CHECK(!r.svc.reading_ok());
    CHECK(r.svc.read().error() == fr::Err::busy);
}

TEST(battery_inject_never_hides_a_lower_real_cell)
{
    BatRig r;
    REQUIRE(r.start());
    r.settle(3200);  // critical, really
    CHECK(r.svc.inject({.mv = 3900, .hold_ms = 5000}).has_value());
    CHECK_EQ(r.svc.mv(), 3900);                              // reported as held
    CHECK(r.svc.level() == BatteryCellLevel::critical);       // protected as real
    CHECK(r.svc.load({.on = true}).error() == fr::Err::busy);
    r.cell.pin_mv = 1450;  // 2900: empty, while 3900 is held
    r.core.advance_ms(3000);
    CHECK(r.svc.level() == BatteryCellLevel::empty);
}
#endif

// ---- HapticService ----

struct HapRig {
    explicit HapRig(HapticConfig cfg = {}, bool with_supply = true, bool pwm = true)
        : bat(lic_cfg(), {true, false, false}), out(bat.core, pwm), svc(out, cfg)
    {
        svc.attach(kHapPort, "buzz", bat.sink);
        if (with_supply) {
            svc.bind_supply(bat.svc);
        }
    }
    bool start()
    {
        bat.cell.pin_mv = 1800;  // 3600 on the LIC
        if (!bat.svc.init(bat.core) || !svc.init(bat.core)) {
            return false;
        }
        bat.core.run_ready();
        return true;
    }
    FakeCore &core() { return bat.core; }
    std::vector<RecordingSink::Emission> cuts() const
    {
        std::vector<RecordingSink::Emission> out_;
        for (const auto &e : bat.sink.events()) {
            if (e.port == kHapPort && e.id == fr::cap::Haptic::kEventCut) {
                out_.push_back(e);
            }
        }
        return out_;
    }
    std::vector<uint64_t> actives() const
    {
        std::vector<uint64_t> o;
        for (const auto &e : bat.sink.properties()) {
            if (e.port == kHapPort && e.id == fr::cap::Haptic::kPropActive) {
                o.push_back(frt::field_u(e.bytes, 1));
            }
        }
        return o;
    }

    BatRig bat;
    FakeHapticOut out;
    HapticService svc;
};

TEST(haptic_compensation_formula)
{
    CHECK_EQ(HapticService::compensate(100, 3000, 3600), 833);
    CHECK_EQ(HapticService::compensate(100, 3000, 3000), 1000);
    CHECK_EQ(HapticService::compensate(100, 3000, 2800), 1000);  // capped
    CHECK_EQ(HapticService::compensate(50, 3000, 4200), 357);
    CHECK_EQ(HapticService::compensate(80, 3000, 0), 800);  // no supply: no compensation
}

TEST(haptic_pulse_runs_its_ms_compensated)
{
    HapRig h;
    REQUIRE(h.start());
    CHECK(h.svc.traits().pwm);
    CHECK(h.svc.pulse({.ms = 200, .level = 100}).has_value());
    CHECK(h.svc.active());
    CHECK_EQ(h.out.duty, 833);  // 3000 / 3600
    h.core().advance_ms(190);
    CHECK(h.svc.active());
    h.core().advance_ms(20);
    CHECK(!h.svc.active());
    CHECK_EQ(h.out.duty, 0);
    auto a = h.actives();
    REQUIRE_EQ(a.size(), 2u);
    CHECK_EQ(a[0], 1u);
    CHECK_EQ(a[1], 0u);
    // The off write lands at 200 ms (step ends are timed, not left to the tick).
    CHECK_EQ(h.out.writes.back().at - h.out.writes.front().at, 200'000);
}

TEST(haptic_follows_the_supply_while_running)
{
    HapRig h;
    REQUIRE(h.start());
    CHECK(h.svc.pulse({.ms = 10000}).has_value());
    CHECK_EQ(h.out.duty, 833);
    h.bat.settle(3300, 3000);  // the cell sags to 3300
    CHECK_EQ(h.out.duty, 909);
    h.bat.settle(2900, 3000);  // below rated: capped
    CHECK_EQ(h.out.duty, 1000);
}

TEST(haptic_play_pattern_and_repeat)
{
    HapRig h;
    REQUIRE(h.start());
    fr::cap::HapticPlayArgs a{};
    a.steps.push_back(100);
    a.steps.push_back(50);
    a.steps.push_back(100);
    a.level = 100;
    a.repeat = 2;
    CHECK(h.svc.play(a).has_value());
    h.core().advance_ms(100);
    CHECK_EQ(h.out.duty, 0);  // the off step
    h.core().advance_ms(50);
    CHECK(h.out.duty > 0);
    h.core().advance_ms(100 + 240);  // into the second repeat (500 ms in all)
    CHECK(h.svc.active());
    h.core().advance_ms(20);
    CHECK(!h.svc.active());
    // on, off, on, off(gap between repeats is the next on directly) ...: count the on writes
    int ons = 0;
    for (size_t i = 0; i < h.out.writes.size(); ++i) {
        const bool on = h.out.writes[i].duty > 0;
        const bool was = i > 0 && h.out.writes[i - 1].duty > 0;
        ons += on && !was ? 1 : 0;
    }
    CHECK_EQ(ons, 3);  // 100 on | 50 off | 100 on, then repeat: the last on runs into the first on
}

TEST(haptic_refuses_bad_args)
{
    HapRig h;
    REQUIRE(h.start());
    CHECK(h.svc.pulse({.ms = 0}).error() == fr::Err::invalid_args);
    CHECK(h.svc.pulse({.ms = 10001}).error() == fr::Err::invalid_args);  // erm max_on 10,000
    fr::cap::HapticPlayArgs a{};
    CHECK(h.svc.play(a).error() == fr::Err::invalid_args);
    a.steps.push_back(0);
    a.steps.push_back(100);
    CHECK(h.svc.play(a).error() == fr::Err::invalid_args);  // no on-time at all
}

TEST(haptic_busy_on_a_critical_supply)
{
    HapRig h;
    REQUIRE(h.start());
#if FR_TEST_HOOKS
    CHECK(h.bat.svc.inject({.mv = 2790, .hold_ms = 5000}).has_value());
#endif
    CHECK(h.bat.svc.level() == BatteryCellLevel::critical);
    CHECK(h.svc.pulse({.ms = 100}).error() == fr::Err::busy);
}

TEST(haptic_cut_at_floor_and_low_supply)
{
    HapRig h;
    REQUIRE(h.start());
    CHECK(h.svc.pulse({.ms = 5000}).has_value());
#if FR_TEST_HOOKS
    CHECK(h.bat.svc.inject({.mv = 2650, .hold_ms = 5000}).has_value());
#endif
    h.core().advance_ms(20);
    CHECK(!h.svc.active());
    CHECK_EQ(h.out.duty, 0);
    auto c = h.cuts();
    REQUIRE_EQ(c.size(), 1u);
    CHECK_EQ(frt::field_u(c[0].bytes, 1), static_cast<uint64_t>(HapticCutReason::floor));
    // The battery fired its own protect too.
    CHECK_EQ(h.bat.events(fr::cap::Battery::kEventProtect).size(), 1u);

    HapRig l;
    REQUIRE(l.start());
    CHECK(l.svc.pulse({.ms = 5000}).has_value());
#if FR_TEST_HOOKS
    CHECK(l.bat.svc.inject({.mv = 2750, .hold_ms = 5000}).has_value());
#endif
    l.core().advance_ms(20);
    auto c2 = l.cuts();
    REQUIRE_EQ(c2.size(), 1u);
    CHECK_EQ(frt::field_u(c2[0].bytes, 1), static_cast<uint64_t>(HapticCutReason::low_supply));
}

TEST(haptic_without_supply_runs_uncompensated)
{
    HapRig h({}, false);
    REQUIRE(h.start());
    CHECK(h.svc.pulse({.ms = 100, .level = 70}).has_value());
    CHECK_EQ(h.out.duty, 700);
}

TEST(haptic_on_off_output_is_full_on)
{
    HapRig h({}, true, false);
    REQUIRE(h.start());
    CHECK(!h.svc.traits().pwm);
    CHECK(h.svc.pulse({.ms = 100, .level = 30}).has_value());
    CHECK_EQ(h.out.duty, 1000);
}

TEST(haptic_solenoid_kicks_then_holds)
{
    HapticConfig c{};
    c.kind = HapticKind::solenoid;
    c.rated_mv = 3600;
    HapRig h(c);
    REQUIRE(h.start());
    CHECK_EQ(h.svc.max_on_ms(), 1000);
    CHECK_EQ(h.svc.cooldown_pct(), 30);
    CHECK(h.svc.pulse({.ms = 200}).has_value());
    CHECK_EQ(h.out.duty, 1000);
    h.core().advance_ms(29);
    CHECK_EQ(h.out.duty, 1000);
    h.core().advance_ms(2);
    CHECK_EQ(h.out.duty, 400);  // hold_pct 40 at rated == supply
    CHECK(h.svc.pulse({.ms = 1001}).error() == fr::Err::invalid_args);
}

TEST(haptic_cooldown_budget)
{
    HapticConfig c{};
    c.kind = HapticKind::solenoid;  // 30 % of 10 s: 3,000 ms
    HapRig h(c);
    REQUIRE(h.start());
    for (int i = 0; i < 3; ++i) {
        CHECK(h.svc.pulse({.ms = 1000}).has_value());
        h.core().advance_ms(1100);
    }
    CHECK(h.svc.spent_ms() >= 2950u);
    CHECK(h.svc.pulse({.ms = 500}).error() == fr::Err::busy);
    h.core().advance_ms(10'000);
    CHECK(h.svc.pulse({.ms = 500}).has_value());
}

TEST(haptic_stop_is_idempotent)
{
    HapRig h;
    REQUIRE(h.start());
    CHECK(h.svc.stop().has_value());
    CHECK(h.svc.pulse({.ms = 3000}).has_value());
    CHECK(h.svc.stop().has_value());
    CHECK(!h.svc.active());
    CHECK_EQ(h.out.duty, 0);
    CHECK(h.cuts().empty());
}

TEST(haptic_continuous_on_time_is_cut_at_max_on)
{
    // An ERM pattern whose last on-step runs into the first (odd length, repeat): one continuous on-time.
    HapticConfig c{};
    c.max_on_ms = 1000;
    HapRig h(c);
    REQUIRE(h.start());
    fr::cap::HapticPlayArgs a{};
    a.steps.push_back(600);
    a.level = 100;
    a.repeat = 5;
    CHECK(h.svc.play(a).has_value());
    h.core().advance_ms(990);
    CHECK(h.svc.active());
    h.core().advance_ms(20);
    CHECK(!h.svc.active());
    auto c1 = h.cuts();
    REQUIRE_EQ(c1.size(), 1u);
    CHECK_EQ(frt::field_u(c1[0].bytes, 1), static_cast<uint64_t>(HapticCutReason::max_on));

    // Zero off-steps join on-steps the same way.
    HapRig z(c);
    REQUIRE(z.start());
    fr::cap::HapticPlayArgs b{};
    b.steps = {600, 0, 600};
    CHECK(z.svc.play(b).has_value());
    z.core().advance_ms(1010);
    CHECK(!z.svc.active());
    CHECK_EQ(z.cuts().size(), 1u);

    // A pulse that replaces a running one continues its on-time.
    HapRig p(c);
    REQUIRE(p.start());
    CHECK(p.svc.pulse({.ms = 800}).has_value());
    p.core().advance_ms(700);
    CHECK(p.svc.pulse({.ms = 800}).has_value());
    p.core().advance_ms(320);
    CHECK(!p.svc.active());
    CHECK_EQ(p.cuts().size(), 1u);

    // A single pulse of exactly max_on ends without a cut.
    HapRig e(c);
    REQUIRE(e.start());
    CHECK(e.svc.pulse({.ms = 1000}).has_value());
    e.core().advance_ms(1050);
    CHECK(!e.svc.active());
    CHECK(e.cuts().empty());
}

TEST(haptic_solenoid_patterns_need_real_breaks)
{
    HapticConfig c{};
    c.kind = HapticKind::solenoid;
    c.rated_mv = 3600;
    HapRig h(c);
    REQUIRE(h.start());
    fr::cap::HapticPlayArgs a{};
    a.steps = {100, 0, 100};
    CHECK(h.svc.play(a).error() == fr::Err::invalid_args);  // a zero off-step
    a.steps = {100, 200, 100};
    a.repeat = 2;
    CHECK(h.svc.play(a).error() == fr::Err::invalid_args);  // odd with repeat: the last on runs into the first
    a.repeat = 1;
    CHECK(h.svc.play(a).has_value());
    CHECK(h.svc.stop().has_value());
    a.steps = {100, 200};
    a.repeat = 3;
    CHECK(h.svc.play(a).has_value());
}

TEST(haptic_solenoid_kick_longer_than_max_on_is_refused)
{
    HapticConfig c{};
    c.kind = HapticKind::solenoid;
    c.kick_ms = 1500;  // max_on 1000
    HapRig h(c);
    CHECK(!h.start());
}

TEST(haptic_solenoid_needs_a_margin_above_critical)
{
    HapticConfig c{};
    c.kind = HapticKind::solenoid;
    c.rated_mv = 3600;
    HapRig h(c);
    REQUIRE(h.start());
    h.bat.settle(3050, 3000);  // ok for the LIC (critical 2800), but under 2800 + 300
    CHECK(h.bat.svc.level() == BatteryCellLevel::ok);
    CHECK(h.svc.pulse({.ms = 100}).error() == fr::Err::busy);
    h.bat.settle(3150, 3000);
    CHECK(h.svc.pulse({.ms = 100}).has_value());
    // An ERM on the same cell starts at 3050.
    HapRig e;
    REQUIRE(e.start());
    e.bat.settle(3050, 3000);
    CHECK(e.svc.pulse({.ms = 100}).has_value());
}

TEST(haptic_stops_when_the_hub_goes_quiet)
{
    HapRig h;
    REQUIRE(h.start());
    CHECK(h.svc.pulse({.ms = 10000}).has_value());
    frt::fixture_link().hub_stops();
    h.core().advance_ms(9'000);
    CHECK(h.svc.active());
    h.core().advance_ms(1'100);
    CHECK(!h.svc.active());
    CHECK_EQ(h.out.duty, 0);
    CHECK(h.cuts().empty());  // nobody to hear it
}

#if FR_TEST_HOOKS
TEST(haptic_cut_by_a_zero_supply_reading)
{
    // A supply reading 0 mV is empty (no 0 sentinel any more): a running program is cut, a start refused.
    HapRig h;
    REQUIRE(h.start());
    CHECK(h.svc.pulse({.ms = 5000}).has_value());
    CHECK(h.bat.svc.inject({.mv = 0, .hold_ms = 5000}).has_value());
    h.core().advance_ms(20);
    CHECK(!h.svc.active());
    auto c = h.cuts();
    REQUIRE_EQ(c.size(), 1u);
    CHECK_EQ(frt::field_u(c[0].bytes, 1), static_cast<uint64_t>(HapticCutReason::floor));
    CHECK(h.svc.pulse({.ms = 100}).error() == fr::Err::busy);
}
#endif

TEST(haptic_cut_when_the_supply_reading_goes_stale)
{
    HapRig h;
    REQUIRE(h.start());
    CHECK(h.svc.pulse({.ms = 5000}).has_value());
    h.bat.cell.fail_read = true;
    h.core().advance_ms(1200);
    CHECK(!h.svc.active());
    auto c = h.cuts();
    REQUIRE_EQ(c.size(), 1u);
    CHECK_EQ(frt::field_u(c[0].bytes, 1), static_cast<uint64_t>(HapticCutReason::low_supply));
    CHECK(h.svc.pulse({.ms = 100}).error() == fr::Err::busy);
}

TEST(haptic_cooldown_counts_microseconds)
{
    // 30 % of 10 s is 3,000 ms: 300 pulses of 9.5 ms (each just under a 10 ms tick) must not slip past it.
    HapticConfig c{};
    c.kind = HapticKind::solenoid;
    c.kick_ms = 5;
    HapRig h(c);
    REQUIRE(h.start());
    int started = 0;
    for (int i = 0; i < 400; ++i) {
        if (h.svc.pulse({.ms = 9}).has_value()) {
            ++started;
        }
        h.core().advance_us(9'500);
    }
    CHECK(started <= 340);  // 3,000 ms / 9 ms = 333 at most
}

}  // namespace
