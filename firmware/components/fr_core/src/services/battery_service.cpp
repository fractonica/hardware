// fr:realtime
#include "fr/services/battery_service.hpp"

#include <algorithm>
#include <cstddef>
#include <initializer_list>

// fr::core::link_info(): the hub's newest frame and run, for the test load's hub-silence rule (as FixtureService's
// D11 rule; core.cpp defines it on target, tests/fixture_link.cpp in the host suite).
#include "fr/core/node_net.hpp"

namespace fr {
namespace {

constexpr uint16_t kMinDivider = 1000;
constexpr uint16_t kMaxDivider = 20000;
constexpr uint8_t kMaxReportHz = 10;
constexpr uint32_t kMaxLoadS = 86400;

struct Point {
    uint16_t mv;
    uint8_t pct;
};

// Open-circuit tables (inferred from common resting-voltage tables; the hub replaces percent with a cell's learned
// curve, design power-p1 D9). Descending voltage.
constexpr Point kLiion[] = {{4200, 100}, {4100, 90}, {4000, 80}, {3920, 70}, {3870, 60}, {3820, 50}, {3790, 40},
                            {3770, 30},  {3740, 20}, {3680, 10}, {3450, 5},  {3000, 0}};
constexpr Point kLifepo4[] = {{3600, 100}, {3400, 99}, {3350, 95}, {3320, 90}, {3300, 70}, {3270, 40}, {3260, 30},
                              {3250, 20},  {3220, 15}, {3200, 12}, {3000, 9},  {2800, 5},  {2500, 0}};

template <size_t N>
uint8_t interpolate(const Point (&t)[N], uint16_t mv)
{
    if (mv >= t[0].mv) {
        return t[0].pct;
    }
    for (size_t i = 1; i < N; ++i) {
        if (mv >= t[i].mv) {
            const uint32_t span = t[i - 1].mv - t[i].mv;
            const uint32_t over = mv - t[i].mv;
            const uint32_t dp = t[i - 1].pct - t[i].pct;
            return static_cast<uint8_t>(t[i].pct + (over * dp + span / 2) / span);
        }
    }
    return t[N - 1].pct;
}

/** "<prefix>.p<port>" into a key buffer (at most 15 characters). */
template <size_t N>
void make_key(std::array<char, N> &out, const char *prefix, uint8_t port)
{
    size_t i = 0;
    for (const char *p = prefix; *p != '\0' && i + 1 < N; ++p) {
        out[i++] = *p;
    }
    for (char c : {'.', 'p'}) {
        if (i + 1 < N) {
            out[i++] = c;
        }
    }
    char digits[3];
    size_t nd = 0;
    unsigned v = port;
    do {
        digits[nd++] = static_cast<char>('0' + v % 10);
        v /= 10;
    } while (v != 0 && nd < sizeof(digits));
    while (nd > 0 && i + 1 < N) {
        out[i++] = digits[--nd];
    }
    out[i] = '\0';
}

}  // namespace

BatteryService::Voltages BatteryService::chemistry_voltages(cap::BatteryChemistry c)
{
    switch (c) {
    case cap::BatteryChemistry::lifepo4:
        return {3600, 3000, 2800, 2500};
    case cap::BatteryChemistry::lic:
        return {4000, 3000, 2800, 2700};
    case cap::BatteryChemistry::liion:
    default:
        return {4200, 3500, 3300, 3000};
    }
}

uint16_t BatteryService::chemistry_max_mv(cap::BatteryChemistry c)
{
    switch (c) {
    case cap::BatteryChemistry::lifepo4:
        return 3650;
    case cap::BatteryChemistry::lic:
        return 4200;  // the LIC-H sheet's maximum charge and surge voltage
    case cap::BatteryChemistry::liion:
    default:
        return 4250;
    }
}

cap::BatteryCellLevel BatteryService::classify(uint16_t mv, const Voltages &v)
{
    if (mv < v.floor) {
        return cap::BatteryCellLevel::empty;
    }
    if (mv < v.critical) {
        return cap::BatteryCellLevel::critical;
    }
    if (mv < v.low) {
        return cap::BatteryCellLevel::low;
    }
    return cap::BatteryCellLevel::ok;
}

uint8_t BatteryService::percent_of(uint16_t mv, cap::BatteryChemistry c, const Voltages &v)
{
    switch (c) {
    case cap::BatteryChemistry::lifepo4:
        return interpolate(kLifepo4, mv);
    case cap::BatteryChemistry::lic: {
        // A capacitor's charge is about C x V: linear from the floor (0 %) to full (100 %).
        if (mv <= v.floor || v.full <= v.floor) {
            return 0;
        }
        if (mv >= v.full) {
            return 100;
        }
        const uint32_t span = v.full - v.floor;
        return static_cast<uint8_t>((static_cast<uint32_t>(mv - v.floor) * 100 + span / 2) / span);
    }
    case cap::BatteryChemistry::liion:
    default:
        return interpolate(kLiion, mv);
    }
}

BatteryService::BatteryService(hal::PowerCell &cell, hal::Settings &settings, const cap::BatteryConfig &cfg)
    : cell_(cell), settings_(settings), cfg_(cfg), divider_(cfg.divider_milli)
{
    // What the bind wired, so the descriptor is right before init.
    const hal::PowerCellFeatures f = cell_.features();
    traits_.status_pins = f.status_pins;
    traits_.test_load = f.load;
    traits_.charge_gate = f.gate;
    const Voltages d = chemistry_voltages(cfg_.chemistry);
    v_.full = cfg_.full_mv != 0 ? cfg_.full_mv : d.full;
    v_.low = cfg_.low_mv != 0 ? cfg_.low_mv : d.low;
    v_.critical = cfg_.critical_mv != 0 ? cfg_.critical_mv : d.critical;
    v_.floor = cfg_.floor_mv != 0 ? cfg_.floor_mv : d.floor;
    charge_to_ = cfg_.charge_to_mv != 0 ? cfg_.charge_to_mv : v_.full;
    ceiling_mv_ = std::min<uint16_t>(static_cast<uint16_t>(v_.full + kCeilingMarginMv), chemistry_max_mv(cfg_.chemistry));
    if (traits_.charge_gate && charge_to_ + kGateReopenMv > ceiling_mv_) {
        // The gate stops below the ceiling, so the ceiling is only ever a backstop.
        charge_to_ = static_cast<uint16_t>(ceiling_mv_ - kGateReopenMv);
    }
}

bool BatteryService::divider_ok(int64_t d) const
{
    const int64_t c = cfg_.divider_milli;
    return d >= kMinDivider && d <= kMaxDivider && d * 100 >= c * (100 - kCalibrateSpanPct) &&
           d * 100 <= c * (100 + kCalibrateSpanPct);
}

bool BatteryService::reading_ok() const
{
    if (!sampled_ || core_ == nullptr) {
        return false;
    }
    return holding(core_->now()) || (seeded_ && !stale_);
}

Status BatteryService::init(Core &core)
{
    // The driver first (review B1): the load off and the gate closed before anything here can fail, so a refused
    // config or a missing timer never leaves an output as a CPU reset left it.
    if (auto st = cell_.init(core); !st) {
        return st;
    }
    if (cfg_.report_hz < 1 || cfg_.report_hz > kMaxReportHz || cfg_.divider_milli < kMinDivider ||
        cfg_.divider_milli > kMaxDivider || !cap::is_known(cfg_.chemistry) || !(v_.floor < v_.critical) ||
        !(v_.critical < v_.low) || !(v_.low < v_.full) || charge_to_ > v_.full || charge_to_ <= v_.floor ||
        v_.full > chemistry_max_mv(cfg_.chemistry)) {
        return std::unexpected(Err::invalid_args);
    }
    core_ = &core;
    tick_ = core.timer([this] { on_tick(); });
    if (tick_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    report_us_ = 1'000'000 / cfg_.report_hz;
    // The key of this port (attach ran first): the slots.lock freezes it, so two cells on one node keep apart.
    make_key(key_div_, "div", port_);
    if (auto v = settings_.get_i32(key_div_.data()); v && divider_ok(*v)) {
        divider_ = static_cast<uint16_t>(*v);
        calibrated_ = true;
    }
    next_tick_ = core.now();
    tick_->start(0);
    return {};
}

hal::Selftest BatteryService::selftest()
{
    return cell_.selftest();
}

uint16_t BatteryService::mv_of(uint32_t adc_q16) const
{
    const uint64_t num = static_cast<uint64_t>(adc_q16) * divider_;
    const uint64_t den = 1000ULL << 16;
    return static_cast<uint16_t>(std::min<uint64_t>((num + den / 2) / den, 0xFFFF));
}

void BatteryService::on_tick()
{
    const TimeUs now = core_->now();
    const TimeUs grid = next_tick_;
    next_tick_ += kTickUs;
    if (next_tick_ <= now) {
        next_tick_ += ((now - next_tick_) / kTickUs + 1) * kTickUs;
    }
    tick_->start(static_cast<uint32_t>(next_tick_ - now));

    // The pin: read even while a hold is on (calibrate takes the real pin), but the hold's mv is what counts.
    hal::AnalogReading r{};
    if (cell_.read(r)) {
        failed_in_row_ = 0;
        stale_ = false;
        adc_mv_ = r.mv;
        const uint32_t q = static_cast<uint32_t>(r.mv) << 16;
        if (!seeded_) {
            ema_q16_ = q;
            seeded_ = true;
        } else {
            const int64_t step = (static_cast<int64_t>(q) - static_cast<int64_t>(ema_q16_)) / 4;
            ema_q16_ = static_cast<uint32_t>(static_cast<int64_t>(ema_q16_) + step);
        }
    } else {
        ++read_errors_;
        if (++failed_in_row_ >= kStaleTicks) {
            stale_ = true;  // the last good reading is too old to run a load on
        }
    }
    if (traits_.status_pins) {
        (void)decoder_.update(cell_.status(), now);
    }
    if (hold_until_ != 0 && now >= hold_until_) {
        hold_until_ = 0;
        if (!seeded_) {
            sampled_ = false;  // an inject before any real reading leaves none behind
        }
    }
    check_load(now);
    if (!seeded_ && !holding(now)) {
        return;  // nothing to say yet
    }
    sample(grid);
}

void BatteryService::check_load(TimeUs now)
{
    if (!load_on_) {
        return;
    }
    bool off = now >= load_until_ || !reading_ok();
    if (!off && load_hub_) {
        const net::LinkInfo li = core::link_info();
        off = li.hub_epoch != load_epoch_ || now - li.hub_heard_at >= kLoadHubSilentUs;
    }
    if (off) {
        set_load_out(false, now);
    }
}

void BatteryService::sample(TimeUs grid)
{
    const TimeUs now = core_->now();
    const bool first = !sampled_;
    const bool held = holding(now);
    const uint16_t real = mv_of(ema_q16_);
    mv_ = held ? held_mv_ : real;
    percent_ = percent_of(mv_, cfg_.chemistry, v_);
    // Protection on the lower of held and real, the ceiling on the higher (review m3): a held value never hides the
    // real cell. Without a fresh real reading only the held one counts.
    const bool real_ok = seeded_ && !stale_;
    const uint16_t lo = held && real_ok ? std::min(held_mv_, real) : mv_;
    const uint16_t hi = held && real_ok ? std::max(held_mv_, real) : mv_;

    cap::BatteryChargerMode c = cap::BatteryChargerMode::none;
    if (held && held_charger_set_) {
        c = held_charger_;
    } else if (traits_.status_pins && decoder_.started()) {
        c = static_cast<cap::BatteryChargerMode>(decoder_.state());
    }
    if (first) {
        charger_ = c;  // reported below; no event for the state found at boot
    } else if (c != charger_) {
        set_charger(c, true, now);
    }
    update_level(now, first, lo);

    // The ceiling (D3): with a gate, close it above full (at most the chemistry's maximum).
    if (traits_.charge_gate) {
        if (!ceiling_ && hi >= ceiling_mv_) {
            ceiling_ = true;
            set_gate_out(false, now);
            emit_protect({cap::BatteryProtectReason::ceiling, hi}, now);
        } else if (ceiling_ && hi + kHysteresisMv < charge_to_) {
            ceiling_ = false;
        }
        update_gate(now, hi);
    }
    sampled_ = true;
    maybe_report(grid, now, first);
}

void BatteryService::set_charger(cap::BatteryChargerMode c, bool event, TimeUs at)
{
    charger_ = c;
    manual_closed_ = false;  // a hand close stands until the charger's state changes
    report_charger(c, at);
    if (event) {
        emit_charge({c, mv_}, at);
    }
}

void BatteryService::update_level(TimeUs at, bool first, uint16_t lo_mv)
{
    const cap::BatteryCellLevel now_level = classify(lo_mv, v_);
    cap::BatteryCellLevel next = level_;
    if (first) {
        next = now_level;
    } else if (now_level > level_) {
        next = now_level;  // falls at once
    } else if (now_level < level_) {
        // Rises only past the next threshold plus the hysteresis.
        const uint16_t lowered = lo_mv > kHysteresisMv ? static_cast<uint16_t>(lo_mv - kHysteresisMv) : 0;
        const cap::BatteryCellLevel with_margin = classify(lowered, v_);
        if (with_margin < level_) {
            next = with_margin;
        }
    }
    const bool changed = first || next != level_;
    const bool entered_empty = next == cap::BatteryCellLevel::empty && (first || level_ != cap::BatteryCellLevel::empty);
    level_ = next;
    if (!changed) {
        return;
    }
    if (!first) {
        report_level(level_, at);
    }
    if (!first || level_ != cap::BatteryCellLevel::ok) {
        emit_level_change({level_, mv_}, at);
    }
    if (entered_empty) {
        // D3: loads off at the floor; every fr.haptic drawing from here reads `level` and stops itself.
        if (load_on_) {
            set_load_out(false, at);
        }
        emit_protect({cap::BatteryProtectReason::floor, lo_mv}, at);
    }
}

void BatteryService::update_gate(TimeUs at, uint16_t hi_mv)
{
    using M = cap::BatteryChargerMode;
    if (gate_open_) {
        // Open: the module sees the cell, so anything but charging or charged (or no pins) means no input.
        const bool input = charger_ == M::charging || charger_ == M::charged || charger_ == M::none;
        if (!input || hi_mv >= charge_to_ || ceiling_) {
            set_gate_out(false, at);
        }
        return;
    }
    // Closed: a TP4056 with nothing on BAT blinks (no_cell) or reports charged; only unplugged and fault mean no input.
    const bool input = charger_ != M::unplugged && charger_ != M::fault;
    const bool rested = !gate_closed_once_ || at - gate_closed_at_ >= kGateDwellUs;
    if (input && rested && !manual_closed_ && !ceiling_ && hi_mv + kGateReopenMv < charge_to_) {
        set_gate_out(true, at);
    }
}

void BatteryService::maybe_report(TimeUs grid, TimeUs at, bool first)
{
    if (first) {
        last_reported_mv_ = mv_;
        last_reported_pct_ = percent_;
        last_report_grid_ = grid;
        report_mv(mv_, at);
        report_percent(percent_, at);
        report_charger(charger_, at);
        report_level(level_, at);
        report_load_on(load_on_, at);
        report_gate_open(gate_open_, at);
        return;
    }
    const uint16_t moved = mv_ > last_reported_mv_ ? mv_ - last_reported_mv_ : last_reported_mv_ - mv_;
    const uint16_t band = std::max<uint16_t>(cfg_.deadband_mv, 1);
    if (moved >= band && grid - last_report_grid_ >= report_us_) {
        last_reported_mv_ = mv_;
        last_report_grid_ = grid;
        report_mv(mv_, at);
        if (percent_ != last_reported_pct_) {
            last_reported_pct_ = percent_;
            report_percent(percent_, at);
        }
    }
}

void BatteryService::set_load_out(bool on, TimeUs at)
{
    if (!traits_.test_load) {
        return;
    }
    // Off is recorded even if the pin write failed: the next command retries, and on is never claimed falsely.
    const bool ok = static_cast<bool>(cell_.set_load(on));
    const bool now_on = on && ok;
    if (!now_on) {
        load_until_ = 0;
    }
    if (now_on != load_on_) {
        load_on_ = now_on;
        if (sampled_) {
            report_load_on(load_on_, at);
        }
    }
}

void BatteryService::set_gate_out(bool open, TimeUs at)
{
    if (!traits_.charge_gate) {
        return;
    }
    const bool ok = static_cast<bool>(cell_.set_gate(open));
    const bool now_open = open && ok;
    if (gate_open_ && !now_open) {
        gate_closed_once_ = true;
        gate_closed_at_ = at;
    }
    if (now_open != gate_open_) {
        gate_open_ = now_open;
        if (sampled_) {
            report_gate_open(gate_open_, at);
        }
    }
}

std::expected<cap::BatteryReadResult, Err> BatteryService::read()
{
    if (!sampled_) {
        return std::unexpected(Err::busy);
    }
    return cap::BatteryReadResult{.mv = mv_,
                                  .adc_mv = static_cast<uint16_t>((ema_q16_ + 0x8000) >> 16),
                                  .percent = percent_,
                                  .charger = charger_,
                                  .level = level_,
                                  .divider_milli = divider_,
                                  .calibrated = calibrated_,
                                  .load = load_on_,
                                  .gate = gate_open_,
                                  .injected = holding(core_->now())};
}

std::expected<cap::BatteryCalibrateResult, Err> BatteryService::calibrate(const cap::BatteryCalibrateArgs &args)
{
    if (core_ == nullptr || !seeded_) {
        return std::unexpected(Err::busy);  // no reading at the pin yet
    }
    const uint32_t adc_q16 = ema_q16_;
    const uint16_t adc = static_cast<uint16_t>((adc_q16 + 0x8000) >> 16);
    if (adc_q16 == 0 || args.meter_mv == 0) {
        return std::unexpected(Err::invalid_args);
    }
    // divider = meter / adc, x1000, on the filtered pin voltage (Q16), rounded.
    const uint64_t num = (static_cast<uint64_t>(args.meter_mv) * 1000) << 16;
    const uint64_t div = (num + adc_q16 / 2) / adc_q16;
    if (!divider_ok(static_cast<int64_t>(div))) {
        return std::unexpected(Err::invalid_args);
    }
    // Kept before it is used: a refused write changes nothing.
    if (auto st = settings_.set_i32(key_div_.data(), static_cast<int32_t>(div)); !st) {
        return std::unexpected(st.error());
    }
    divider_ = static_cast<uint16_t>(div);
    calibrated_ = true;
    const TimeUs now = core_->now();
    sample(now);
    // A deliberate change: reported now, whatever the rate limit.
    last_reported_mv_ = mv_;
    last_report_grid_ = now;
    report_mv(mv_, now);
    return cap::BatteryCalibrateResult{.divider_milli = divider_, .adc_mv = adc};
}

Status BatteryService::reset_calibration()
{
    if (core_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    const char *const keys[] = {key_div_.data()};
    if (auto st = settings_.erase(keys); !st) {
        return st;
    }
    divider_ = cfg_.divider_milli;
    calibrated_ = false;
    if (seeded_ || holding(core_->now())) {
        const TimeUs now = core_->now();
        sample(now);
        last_reported_mv_ = mv_;
        last_report_grid_ = now;
        report_mv(mv_, now);
    }
    return {};
}

Status BatteryService::load(const cap::BatteryLoadArgs &args)
{
    if (!traits_.test_load) {
        return std::unexpected(Err::unsupported);
    }
    if (core_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    const TimeUs now = core_->now();
    if (!args.on) {
        set_load_out(false, now);
        return {};
    }
    // Turning it on needs a level above critical; renewing a running load only needs one above empty (the floor
    // turns it off), so a capacity test runs to the floor (cap doc: "BUSY turning it on").
    const cap::BatteryCellLevel limit = load_on_ ? cap::BatteryCellLevel::empty : cap::BatteryCellLevel::critical;
    if (!reading_ok() || level_ >= limit) {
        return std::unexpected(Err::busy);
    }
    const uint32_t s = args.seconds == 0 ? kDefaultLoadS : std::min(args.seconds, kMaxLoadS);
    set_load_out(true, now);
    if (!load_on_) {
        return std::unexpected(Err::failed);
    }
    load_until_ = now + static_cast<TimeUs>(s) * 1'000'000;
    // The hub that asked: its silence or a new run ends the load (renewed by every `load {on}`).
    const net::LinkInfo li = core::link_info();
    load_hub_ = li.hub_session;
    load_epoch_ = li.hub_epoch;
    return {};
}

Status BatteryService::gate(const cap::BatteryGateArgs &args)
{
    if (!traits_.charge_gate) {
        return std::unexpected(Err::unsupported);
    }
    if (core_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    if (args.open && (!reading_ok() || mv_ >= charge_to_ || ceiling_)) {
        return std::unexpected(Err::busy);  // the rule would close it at once (review M1)
    }
    manual_closed_ = !args.open;
    set_gate_out(args.open, core_->now());
    if (gate_open_ != args.open) {
        return std::unexpected(Err::failed);
    }
    return {};
}

#if FR_TEST_HOOKS
Status BatteryService::inject(const cap::BatteryInjectArgs &args)
{
    if (core_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    const uint16_t ms = args.hold_ms == 0 ? kDefaultHoldMs : std::min(args.hold_ms, kMaxHoldMs);
    const TimeUs now = core_->now();
    hold_until_ = now + static_cast<TimeUs>(ms) * 1000;
    held_mv_ = args.mv;
    held_charger_set_ = args.charger_set;
    held_charger_ = args.charger;
    // Applied at once (protection too); the rate limit still holds the mv report back if it must.
    sample(now);
    return {};
}
#endif

}  // namespace fr
