// The charger's state from its two open-drain status pins (design power-p1 D4): TP4056 and TP5000 share the truth
// table. A pure, host-tested function of the pin levels sampled on a clock; BatteryService feeds it every 100 ms.
//
//   CHRG     STDBY   state
//   low      high    charging
//   high     low     charged
//   high     high    unplugged (no input; also TP4056's temperature fault, which the modules disable)
//   toggling low     no_cell (TP4056 blinks CHRG with nothing on BAT: more than 2 CHRG edges within 4 s, inferred)
//   low      low     fault
//
// A new state must hold kHoldUs before it counts (a plug-in settling, a contact bouncing); `fault` must hold
// kFaultHoldUs, longer than a no_cell blink's low phase (inferred: about 0.5-2 s), so a blinking CHRG is not first
// reported as a fault. Its `charged` phases can still count before the third edge shows the blink.
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>

#include "fr/base.hpp"
#include "fr/hal/power_cell.hpp"

namespace fr::power {

/** fr.battery ChargerMode's values (the decoder never answers `none`: that is "no status pins", the service's). */
enum class Charger : uint8_t { none = 0, unplugged = 1, charging = 2, charged = 3, no_cell = 4, fault = 5 };

/** The state the pins show right now, before the blink rule and the hold. */
constexpr Charger charger_of(hal::ChargerPins p)
{
    if (p.chrg_low && !p.stdby_low) {
        return Charger::charging;
    }
    if (!p.chrg_low && p.stdby_low) {
        return Charger::charged;
    }
    if (p.chrg_low && p.stdby_low) {
        return Charger::fault;
    }
    return Charger::unplugged;
}

class ChargerDecoder
{
public:
    static constexpr TimeUs kHoldUs = 300'000;
    static constexpr TimeUs kFaultHoldUs = 2'000'000;
    static constexpr TimeUs kBlinkWindowUs = 4'000'000;
    /** More than this many CHRG edges within kBlinkWindowUs, with STDBY low: no_cell. */
    static constexpr size_t kBlinkEdges = 2;

    /**
     * One sample of the pins at `now` (non-decreasing). The first sample sets the state at once (no hold: what the
     * module shows at boot); after that, the new state when one has held long enough, else nothing.
     */
    std::optional<Charger> update(hal::ChargerPins p, TimeUs now)
    {
        if (have_last_ && p.chrg_low != last_.chrg_low) {
            edges_[edge_next_] = now;
            edge_next_ = (edge_next_ + 1) % edges_.size();
            edge_count_ = edge_count_ < edges_.size() ? edge_count_ + 1 : edge_count_;
        }
        last_ = p;
        have_last_ = true;

        Charger seen = charger_of(p);
        if (p.stdby_low && edges_within(now) > kBlinkEdges) {
            seen = Charger::no_cell;
        }
        if (!have_state_) {
            have_state_ = true;
            state_ = seen;
            candidate_ = seen;
            since_ = now;
            return state_;
        }
        if (seen != candidate_) {
            candidate_ = seen;
            since_ = now;
        }
        const TimeUs hold = candidate_ == Charger::fault ? kFaultHoldUs : kHoldUs;
        if (candidate_ != state_ && now - since_ >= hold) {
            state_ = candidate_;
            return state_;
        }
        return std::nullopt;
    }

    /** The state counted so far (unplugged before the first sample). */
    Charger state() const { return have_state_ ? state_ : Charger::unplugged; }
    bool started() const { return have_state_; }

private:
    size_t edges_within(TimeUs now) const
    {
        size_t n = 0;
        for (size_t i = 0; i < edge_count_; ++i) {
            n += now - edges_[i] < kBlinkWindowUs ? 1 : 0;
        }
        return n;
    }

    std::array<TimeUs, 8> edges_{};
    size_t edge_next_ = 0;
    size_t edge_count_ = 0;
    hal::ChargerPins last_{};
    bool have_last_ = false;
    bool have_state_ = false;
    Charger state_ = Charger::unplugged;
    Charger candidate_ = Charger::unplugged;
    TimeUs since_ = 0;
};

}  // namespace fr::power
