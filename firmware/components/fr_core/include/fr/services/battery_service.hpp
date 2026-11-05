// L2 battery service (spec 07 §7.3, §7.7-7.8; design power-p1 D2-D5): fr.battery over any hal::PowerCell, its divider
// calibration kept through a hal::Settings. Host-buildable.
#pragma once

#include <array>
#include <cstdint>
#include <expected>

#include "battery.hpp"  // generated fr::cap::Battery
#include "fr/base.hpp"
#include "fr/core/core.hpp"
#include "fr/hal/power_cell.hpp"
#include "fr/hal/settings.hpp"
#include "fr/power/charger.hpp"

namespace fr {

/**
 * Everything on the core task, on one timer ticking every kTickUs (10 Hz) on a fixed grid whatever report_hz is, so
 * protection never waits for a report.
 *
 * A tick reads the pin (hal::PowerCell::read, the mean of several conversions), filters it (EMA alpha 1/4 in Q16, the
 * first reading seeds it) and multiplies by the divider: mv = adc_mv x divider_milli / 1000, rounded. The charger's
 * state comes from the status pins through power::ChargerDecoder (`none` without them). inject holds mv (and, with
 * charger_set, the charger) for hold_ms instead; protection acts on held values as on real ones.
 *
 * Voltages: config, else the chemistry's (full/low/critical/floor): liion 4200/3500/3300/3000, lifepo4
 * 3600/3000/2800/2500, lic 4000/3000/2800/2700. `level` is ok, low (mv < low), critical (mv < critical) or empty
 * (mv < floor); it falls at once and rises only once mv clears the next threshold by kHysteresisMv. A change of level
 * emits `level_change` (the first sample too, when it is not ok). `percent` comes from the chemistry's open-circuit
 * table (Li-ion, LiFePO4), linear from floor to full for a LIC, clamped to 0..100.
 *
 * Protection (D3): on entering `empty` the test load goes off and `protect {floor}` fires; every fr.haptic drawing from
 * this instance reads `level` and stops itself. While an inject holds, levels and the floor follow the lower of the
 * held and the real voltage (so a test value never hides a draining cell) and the ceiling the higher. With a gate, at
 * the ceiling (full + kCeilingMarginMv, at most the chemistry's maximum: liion 4250, lifepo4 3650, lic 4200) the gate
 * closes and `protect {ceiling}` fires.
 *
 * A reading that fails kStaleTicks ticks in a row (1 s) is stale: the test load goes off, `load` and every fr.haptic
 * drawing from here answer BUSY (reading_ok() false) until a reading succeeds again. An inject that ends before the
 * first real reading leaves no reading at all.
 *
 * The test load: `load {on}` turns it on only above critical (BUSY at or below); while it is on, `load {on}` renews
 * its time at any level above empty (the hub's capacity test renews it down to the floor). It goes off at its time,
 * at the floor, on a stale reading, at boot, and when the hub that turned it on goes quiet: kLoadHubSilentUs after the
 * hub's newest frame (fr::core::link_info().hub_heard_at), or at once on a WELCOME of another hub run (hub_epoch).
 *
 * The charge gate (D5; the sense and the loads sit on the cell's side of the gate). Open: it closes when the input
 * goes (anything but charging, charged or none), at charge_to_mv (config, else full, at most the ceiling -
 * kGateReopenMv) or at the ceiling. Closed: the module cannot see the cell, so only unplugged and fault mean no input
 * (no_cell and charged are what a TP4056 reports with nothing on BAT); it reopens below charge_to - kGateReopenMv once
 * it has been closed kGateDwellUs (the cell rests: an open-circuit reading, not one raised by I x ESR), except after a
 * hand close, which stands until the charger's state changes. A hand open is BUSY at or above charge_to. It starts
 * closed (the driver closes it at init) and may open at the first sample.
 *
 * The divider kept by `calibrate` lives under key "div.p<port>"; init reads it. `calibrate` and init accept a
 * divider only within kCalibrateSpanPct of config divider_milli (a typo in the meter reading, or a key left by another
 * profile on this port, would move every threshold).
 */
class BatteryService final : public cap::Battery
{
public:
    BatteryService(hal::PowerCell &cell, hal::Settings &settings, const cap::BatteryConfig &cfg);

    /** Err::invalid_args for a config codegen should have refused (report_hz, divider, voltages out of order). */
    Status init(Core &core);
    hal::Selftest selftest();

    std::expected<cap::BatteryReadResult, Err> read() override;
    std::expected<cap::BatteryCalibrateResult, Err> calibrate(const cap::BatteryCalibrateArgs &args) override;
    Status reset_calibration() override;
    Status load(const cap::BatteryLoadArgs &args) override;
    Status gate(const cap::BatteryGateArgs &args) override;
#if FR_TEST_HOOKS
    Status inject(const cap::BatteryInjectArgs &args) override;
#endif

    uint16_t mv() const override { return mv_; }
    uint8_t percent() const override { return percent_; }
    cap::BatteryChargerMode charger() const override { return charger_; }
    cap::BatteryCellLevel level() const override { return level_; }
    bool load_on() const override { return load_on_; }
    bool gate_open() const override { return gate_open_; }
    cap::BatteryTraits traits() const override { return traits_; }

    /** A reading exists (mv and level mean something). */
    bool sampled() const { return sampled_; }
    /** A reading exists and is fresh (or held by inject): loads may run on it. */
    bool reading_ok() const;
    uint16_t divider_milli() const { return divider_; }
    bool calibrated() const { return calibrated_; }
    const char *divider_key() const { return key_div_.data(); }
    /** The effective voltages (config, else the chemistry's). */
    uint16_t full_mv() const { return v_.full; }
    uint16_t low_mv() const { return v_.low; }
    uint16_t critical_mv() const { return v_.critical; }
    uint16_t floor_mv() const { return v_.floor; }
    uint16_t charge_to_mv() const { return charge_to_; }
    uint16_t ceiling_mv() const { return ceiling_mv_; }
    uint32_t read_errors() const { return read_errors_; }

    static constexpr uint32_t kTickUs = 100'000;
    static constexpr uint16_t kHysteresisMv = 50;
    static constexpr uint16_t kCeilingMarginMv = 100;
    static constexpr uint16_t kGateReopenMv = 100;
    static constexpr uint32_t kDefaultLoadS = 60;
    static constexpr uint16_t kDefaultHoldMs = 1000;
    static constexpr uint16_t kMaxHoldMs = 60000;
    static constexpr uint32_t kStaleTicks = 10;
    static constexpr TimeUs kLoadHubSilentUs = 60'000'000;
    static constexpr TimeUs kGateDwellUs = 30'000'000;
    static constexpr uint16_t kCalibrateSpanPct = 15;

    struct Voltages {
        uint16_t full, low, critical, floor;
    };
    /** The chemistry's defaults. */
    static Voltages chemistry_voltages(cap::BatteryChemistry c);
    /** The chemistry's maximum charge voltage (the ceiling's cap; full_mv above it is refused). */
    static uint16_t chemistry_max_mv(cap::BatteryChemistry c);
    /** The level of `mv` with no hysteresis. */
    static cap::BatteryCellLevel classify(uint16_t mv, const Voltages &v);
    /** percent of `mv` for a chemistry (the table for liion and lifepo4, linear floor..full for lic). */
    static uint8_t percent_of(uint16_t mv, cap::BatteryChemistry c, const Voltages &v);

private:
    void on_tick();
    void sample(TimeUs now);
    void set_charger(cap::BatteryChargerMode c, bool event, TimeUs at);
    void update_level(TimeUs at, bool first, uint16_t lo_mv);
    void update_gate(TimeUs at, uint16_t hi_mv);
    void check_load(TimeUs now);
    bool divider_ok(int64_t d) const;
    void maybe_report(TimeUs grid, TimeUs at, bool first);
    void set_load_out(bool on, TimeUs at);
    void set_gate_out(bool open, TimeUs at);
    uint16_t mv_of(uint32_t adc_q16) const;
    bool holding(TimeUs now) const { return hold_until_ != 0 && now < hold_until_; }

    hal::PowerCell &cell_;
    hal::Settings &settings_;
    cap::BatteryConfig cfg_;
    cap::BatteryTraits traits_;
    Voltages v_{};
    uint16_t charge_to_ = 0;
    uint16_t ceiling_mv_ = 0;
    Core *core_ = nullptr;
    Timer *tick_ = nullptr;
    TimeUs next_tick_ = 0;
    TimeUs report_us_ = 0;
    std::array<char, hal::Settings::kKeyMax + 1> key_div_{};

    uint16_t divider_ = 0;
    bool calibrated_ = false;

    // readings
    bool sampled_ = false;
    bool seeded_ = false;
    uint32_t ema_q16_ = 0;  // the filtered pin mV in Q16
    uint16_t adc_mv_ = 0;   // the last reading at the pin, unfiltered
    uint32_t read_errors_ = 0;
    uint32_t failed_in_row_ = 0;
    bool stale_ = false;

    // state
    uint16_t mv_ = 0;
    uint8_t percent_ = 0;
    cap::BatteryChargerMode charger_ = cap::BatteryChargerMode::none;
    cap::BatteryCellLevel level_ = cap::BatteryCellLevel::ok;
    power::ChargerDecoder decoder_;
    bool load_on_ = false;
    TimeUs load_until_ = 0;
    bool load_hub_ = false;       // a hub session existed when the load went on: its silence ends the load
    uint16_t load_epoch_ = 0;     // that hub's run
    bool gate_open_ = false;
    bool gate_closed_once_ = false;  // closed by a decision (not at boot): the dwell counts from gate_closed_at_
    TimeUs gate_closed_at_ = 0;
    bool manual_closed_ = false;  // a hand close: stands until the charger's state changes
    bool ceiling_ = false;        // at or above the ceiling (protect fired)

    // reports
    uint16_t last_reported_mv_ = 0;
    uint8_t last_reported_pct_ = 0;
    TimeUs last_report_grid_ = 0;

    // inject
    TimeUs hold_until_ = 0;
    uint16_t held_mv_ = 0;
    bool held_charger_set_ = false;
    cap::BatteryChargerMode held_charger_ = cap::BatteryChargerMode::none;
};

}  // namespace fr
