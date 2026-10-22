// The Wi-Fi STA's rejoin and pin rules (spec 05 §5.4, design c5 §3), IDF-free so that wifi_sta.cpp on
// target and the host suite run the same rules: where a node that lost its AP looks for it (the pinned BSSID
// on channel C, any AP of the SSID on C, or an all-channel sweep), and which pin is channel C (nvs:fr_link's,
// or a net_set trial's, held in RAM until the trial is confirmed). Private to fr_net/src/esp.
#pragma once

#include <array>
#include <cstdint>
#include <cstring>

#include "air_detail.hpp"
#include "fr/base.hpp"

namespace fr::net::esp::detail {

/** 05 §5.4: an ESP-NOW frame, or a neighbour's Wi-Fi report, counts as recent this long. */
inline constexpr TimeUs kHeardWindowUs = 60'000'000;
/** 05 §5.4: neither the AP nor any ESP-NOW frame for this long: sweep all channels, then every this long. */
inline constexpr TimeUs kSweepAfterUs = 60'000'000;
/**
 * ESP-NOW neighbours heard, none of them on Wi-Fi: the router is off (every node on C waits for it) or it
 * moved channel. Sweep only after this long without the AP, then every this long: an outage shorter than
 * that never takes a node, and ESP-NOW with it, off C, and a router that came back elsewhere is still found.
 */
inline constexpr TimeUs kSweepQuietUs = 300'000'000;

/** A stamp (air_detail.hpp) no older than `window` at `now`. */
inline bool heard_within(uint32_t stamp, TimeUs now, TimeUs window)
{
    // Signed: a frame heard after `now` was read is a second "in the future", and recent all the same.
    return stamp != 0 && static_cast<int32_t>(stamp_s(now) - stamp) < static_cast<int32_t>(window / 1'000'000);
}

/** Where the STA looks for its AP next (05 §5.4). */
enum class Search : uint8_t {
    first,      // no usable pin: join by SSID on every channel (fr_ident's BSSID if it names one, else the strongest)
    pinned,     // scan only channel C (active, 30 ms) for the pinned BSSID, then connect to it
    ssid_on_c,  // the same scan for any AP of the SSID, the pinned one first
    sweep,      // join by SSID on every channel, a pin notwithstanding: the radio leaves C for a second or two
};

struct SearchFacts {
    TimeUs now = 0;
    TimeUs lost_since = 0;   // not associated since (0: associated, or never tried)
    TimeUs last_sweep = 0;   // 0: none yet
    uint32_t heard = 0;      // stamp: the last ESP-NOW frame of this network on C
    uint32_t wifi_up = 0;    // stamp: the last neighbour heartbeat on C that reported Wi-Fi up
    bool pinned = false;     // Pins::usable()
    bool any_bssid = false;  // the credentials name no BSSID: another AP of the SSID will do
};

inline Search search(const SearchFacts &f)
{
    if (!f.pinned) {
        return Search::first;
    }
    const TimeUs lost = f.lost_since != 0 ? f.now - f.lost_since : 0;
    if (heard_within(f.wifi_up, f.now, kHeardWindowUs)) {
        // A neighbour on C has Wi-Fi: an AP of the network is on C, and a sweep would only take ESP-NOW off it.
        // A pinned BSSID silent for 60 s (a replaced router, a mesh node switched off) yields to another AP of
        // the SSID that answers on C.
        return f.any_bssid && lost >= kSweepAfterUs ? Search::ssid_on_c : Search::pinned;
    }
    const TimeUs every = heard_within(f.heard, f.now, kHeardWindowUs) ? kSweepQuietUs : kSweepAfterUs;
    if (f.lost_since != 0 && lost >= every && f.now - f.last_sweep >= every) {
        return Search::sweep;
    }
    return Search::pinned;
}

/** A pinned AP: nvs:fr_link's fields (fr_link_pin_t). */
struct Pin {
    bool set = false;
    uint8_t channel = 0;
    std::array<uint8_t, 6> bssid{};
    uint32_t ssid_hash = 0;  // fr_id_ssid_hash of the SSID it was taken on

    bool operator==(const Pin &) const = default;
};

/**
 * The pins (05 §5.4): nvs:fr_link's, of the network the node uses for good, and a net_set trial's, held in RAM
 * and stored in fr_link only once the trial is confirmed, so a trial that is reverted leaves fr_link's pin,
 * and channel C with it, as they were. Joins use fr_link's pin only, and never during a trial.
 */
class Pins
{
public:
    /** fr_link as stored, at boot (before use()). */
    void load(const Pin &stored) { stored_ = stored; }

    /** The credentials in use: their SSID's hash, the BSSID they name (nullptr: none), and whether they are a
     * net_set trial. Drops the pin of an earlier trial. */
    void use(uint32_t ssid_hash, const uint8_t *bssid, bool trial)
    {
        // Until it associates, a trial keeps the C of the network before it, where the neighbours are.
        trial_home_ = !trial ? 0 : (trial_ ? trial_home_ : home());
        ssid_hash_ = ssid_hash;
        has_bssid_ = bssid != nullptr;
        bssid_ = {};
        if (bssid != nullptr) {
            std::memcpy(bssid_.data(), bssid, bssid_.size());
        }
        trial_ = trial;
        trial_pin_ = {};
    }

    /** The pin to join with: fr_link's when it was taken on these credentials' SSID and is the BSSID they name
     * (if they name one); none during a trial. */
    const Pin *usable() const
    {
        const bool ok =
            stored_.set && !trial_ && stored_.ssid_hash == ssid_hash_ && (!has_bssid_ || stored_.bssid == bssid_);
        return ok ? &stored_ : nullptr;
    }

    /**
     * Associated with `bssid` on `channel`, or (bssid nullptr) the associated AP moved to `channel`. A trial's
     * association pins the trial only. True when fr_link's pin changed and must be written (stored()).
     */
    bool associated(const uint8_t *bssid, uint8_t channel)
    {
        Pin &p = trial_ ? trial_pin_ : stored_;
        if (bssid == nullptr && !p.set) {
            return false;  // a channel change before any association pinned the AP
        }
        Pin next = p;
        next.set = true;
        next.channel = channel;
        if (bssid != nullptr) {
            std::memcpy(next.bssid.data(), bssid, next.bssid.size());
        }
        next.ssid_hash = ssid_hash_;
        if (next == p) {
            return false;  // unchanged: no flash write
        }
        p = next;
        return !trial_;
    }

    /** The trial got an address: its network is the node's now, and its pin fr_link's. True when fr_link's pin
     * changed and must be written. */
    bool confirm()
    {
        if (!trial_) {
            return false;
        }
        trial_ = false;
        const bool changed = trial_pin_.set && trial_pin_ != stored_;
        if (changed) {
            stored_ = trial_pin_;
        }
        trial_pin_ = {};
        return changed;
    }

    /**
     * Channel C while not associated (0: unknown): the usable pin's; during a trial, the trial AP's once it
     * associated, before that the C of the network before the trial (it looks elsewhere for 60 s at most).
     */
    uint8_t home() const
    {
        if (trial_) {
            return trial_pin_.set ? trial_pin_.channel : trial_home_;
        }
        const Pin *p = usable();
        return p != nullptr ? p->channel : 0;
    }

    const Pin &stored() const { return stored_; }

private:
    Pin stored_;
    Pin trial_pin_;
    uint32_t ssid_hash_ = 0;
    std::array<uint8_t, 6> bssid_{};
    bool has_bssid_ = false;
    bool trial_ = false;
    uint8_t trial_home_ = 0;
};

}  // namespace fr::net::esp::detail
