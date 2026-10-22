// The Wi-Fi STA's rejoin and pin rules (spec 05 §5.4, design c5 §3; fr_net/src/esp/sta_rules.hpp), which
// wifi_sta.cpp follows on target: where a node that lost its AP looks for it, so that a router outage keeps
// every node (and ESP-NOW) on channel C while a router that came back elsewhere is still found, and which pin
// channel C comes from across a net_set trial and its revert.
#include <array>

#include "../../../components/fr_net/src/esp/sta_rules.hpp"
#include "tests/test.hpp"

namespace {

using fr::TimeUs;
using fr::net::esp::detail::kSweepAfterUs;
using fr::net::esp::detail::kSweepQuietUs;
using fr::net::esp::detail::Pin;
using fr::net::esp::detail::Pins;
using fr::net::esp::detail::Search;
using fr::net::esp::detail::search;
using fr::net::esp::detail::SearchFacts;
using fr::net::esp::detail::stamp_s;

constexpr TimeUs kS = 1'000'000;

/** A node pinned to its AP, which it lost at `lost_at`, at `now`. */
SearchFacts lost(TimeUs lost_at, TimeUs now)
{
    SearchFacts f;
    f.now = now;
    f.lost_since = lost_at;
    f.pinned = true;
    f.any_bssid = true;
    return f;
}

constexpr uint32_t kHashA = 0xA;
constexpr uint32_t kHashT = 0x7;
constexpr std::array<uint8_t, 6> kApA{0x10, 0, 0, 0, 0, 1};
constexpr std::array<uint8_t, 6> kApT{0x20, 0, 0, 0, 0, 2};

Pin pin_a(uint8_t channel = 6)
{
    return {.set = true, .channel = channel, .bssid = kApA, .ssid_hash = kHashA};
}

}  // namespace

TEST(esp_sta_search_without_a_pin_joins_by_ssid)
{
    SearchFacts f = lost(10 * kS, 20 * kS);
    f.pinned = false;
    CHECK(search(f) == Search::first);
}

TEST(esp_sta_search_alone_sweeps_after_60_s_then_every_60_s)
{
    // No ESP-NOW frame at all (05 §5.4): the router may have moved channel, and nothing on C is lost by looking.
    const TimeUs t0 = 100 * kS;
    CHECK(search(lost(t0, t0 + 59 * kS)) == Search::pinned);
    CHECK(search(lost(t0, t0 + kSweepAfterUs)) == Search::sweep);
    SearchFacts f = lost(t0, t0 + 90 * kS);
    f.last_sweep = t0 + 60 * kS;
    CHECK(search(f) == Search::pinned);
    f.now = t0 + 120 * kS;
    CHECK(search(f) == Search::sweep);
    // Frames heard more than 60 s ago do not hold it back.
    f.heard = stamp_s(t0 + 59 * kS);
    CHECK(search(f) == Search::sweep);
}

TEST(esp_sta_search_router_outage_keeps_nodes_on_c_for_5_min_then_sweeps)
{
    // Every node lost the router; each still hears the others' ESP-NOW heartbeats (every 5 s), none of which
    // reports Wi-Fi up. A 120 s outage (T-FLOOD-B) never takes a node off C; a router that came back on
    // another channel is found after 5 min, where 05 §5.4 as written never swept again.
    const TimeUs t0 = 1'000 * kS;
    for (TimeUs at = t0 + 5 * kS; at < t0 + kSweepQuietUs; at += 5 * kS) {
        SearchFacts f = lost(t0, at);
        f.heard = stamp_s(at - 2 * kS);
        REQUIRE(search(f) == Search::pinned);
    }
    SearchFacts f = lost(t0, t0 + kSweepQuietUs);
    f.heard = stamp_s(f.now - kS);
    CHECK(search(f) == Search::sweep);
    // Then every 5 min, not every 60 s.
    f.last_sweep = f.now;
    f.now += 4 * 60 * kS;
    f.heard = stamp_s(f.now - kS);
    CHECK(search(f) == Search::pinned);
    f.now = f.last_sweep + kSweepQuietUs;
    f.heard = stamp_s(f.now - kS);
    CHECK(search(f) == Search::sweep);
    // A boot counts the 5 min from its own start (lost_since = boot).
    SearchFacts boot = lost(30 * kS, 30 * kS + 200 * kS);
    boot.heard = stamp_s(boot.now);
    CHECK(search(boot) == Search::pinned);
}

TEST(esp_sta_search_neighbour_on_wifi_keeps_the_radio_on_c)
{
    // A neighbour heard on C reports Wi-Fi up: an AP of the network is on C. No sweep, however long.
    const TimeUs t0 = 1'000 * kS;
    SearchFacts f = lost(t0, t0 + 30 * kS);
    f.heard = stamp_s(f.now);
    f.wifi_up = stamp_s(f.now - 3 * kS);
    CHECK(search(f) == Search::pinned);
    // Silent for 60 s, the pinned BSSID yields to any AP of the SSID answering on C (a replaced router, a
    // mesh node switched off), the radio still on C.
    f.now = t0 + kSweepAfterUs;
    f.wifi_up = stamp_s(f.now - 3 * kS);
    CHECK(search(f) == Search::ssid_on_c);
    f.now = t0 + 3'600 * kS;
    f.wifi_up = stamp_s(f.now - 3 * kS);
    f.heard = stamp_s(f.now);
    CHECK(search(f) == Search::ssid_on_c);
    // Credentials that name a BSSID (fr_ident) take that one only.
    f.any_bssid = false;
    CHECK(search(f) == Search::pinned);
    // A report older than 60 s no longer counts: the 5-min rule again.
    f.any_bssid = true;
    f.wifi_up = stamp_s(f.now - 61 * kS);
    CHECK(search(f) == Search::sweep);
}

TEST(esp_sta_heard_within_counts_whole_seconds)
{
    using fr::net::esp::detail::heard_within;
    const TimeUs now = 500 * kS + 300'000;
    CHECK(!heard_within(0, now, 60 * kS));
    CHECK(heard_within(stamp_s(now), now, 60 * kS));
    CHECK(heard_within(stamp_s(now + kS), now, 60 * kS));  // heard after `now` was read
    CHECK(heard_within(stamp_s(now - 59 * kS), now, 60 * kS));
    CHECK(!heard_within(stamp_s(now - 60 * kS), now, 60 * kS));
    CHECK_EQ(stamp_s(0), 0u);
    CHECK_EQ(stamp_s(1), 1u);
}

TEST(esp_sta_pins_join_only_the_pin_of_the_credentials)
{
    Pins p;
    p.load(pin_a());
    p.use(kHashA, nullptr, false);
    REQUIRE(p.usable() != nullptr);
    CHECK_EQ(p.home(), 6);
    // Another SSID: the pin is not joined, C is unknown.
    p.use(kHashT, nullptr, false);
    CHECK(p.usable() == nullptr);
    CHECK_EQ(p.home(), 0);
    // fr_ident names another BSSID of the same SSID: that one first.
    p.use(kHashA, kApT.data(), false);
    CHECK(p.usable() == nullptr);
    p.use(kHashA, kApA.data(), false);
    CHECK(p.usable() != nullptr);
}

TEST(esp_sta_pins_association_writes_fr_link_only_when_it_changed)
{
    Pins p;
    p.use(kHashA, nullptr, false);
    CHECK_EQ(p.home(), 0);
    CHECK(p.associated(nullptr, 3) == false);  // a channel change with nothing pinned yet
    CHECK(p.associated(kApA.data(), 6));
    CHECK(p.stored() == pin_a());
    CHECK_EQ(p.home(), 6);
    CHECK(p.associated(kApA.data(), 6) == false);  // the same AP again: no flash write
    // The router moved channel while associated (HOME_CHANNEL_CHANGE): re-pinned.
    CHECK(p.associated(nullptr, 11));
    CHECK(p.stored() == pin_a(11));
    CHECK_EQ(p.home(), 11);
}

TEST(esp_sta_pins_trial_that_associates_without_an_address_leaves_fr_link)
{
    // Finding: the trial's association overwrote fr_link with the trial AP, and its revert left C there.
    Pins p;
    p.load(pin_a());
    p.use(kHashA, nullptr, false);
    p.use(kHashT, nullptr, true);  // net_set
    CHECK(p.usable() == nullptr);  // 05 §5.4: no pin during a trial
    CHECK_EQ(p.home(), 6);         // the neighbours' C until the trial associates
    CHECK(p.associated(kApT.data(), 11) == false);  // pinned in RAM only
    CHECK(p.stored() == pin_a());
    CHECK_EQ(p.home(), 11);
    CHECK(p.associated(nullptr, 1) == false);  // the trial AP moved: still not fr_link's
    CHECK_EQ(p.home(), 1);
    // No address within 60 s: reverted. fr_link's pin is joined again, and C is its channel.
    p.use(kHashA, nullptr, false);
    REQUIRE(p.usable() != nullptr);
    CHECK(*p.usable() == pin_a());
    CHECK_EQ(p.home(), 6);
}

TEST(esp_sta_pins_boot_during_a_trial_keeps_c_and_gets_it_back_on_revert)
{
    // Finding: a node that booted with an unconfirmed fr_net2 had C unknown (ESP-NOW down), and kept it
    // unknown after the revert although the base network's pin was usable again.
    Pins p;
    p.load(pin_a());
    p.use(kHashA, nullptr, false);  // configure(): the base network first
    p.use(kHashT, nullptr, true);   // then the trial from fr_net2
    CHECK_EQ(p.home(), 6);
    p.use(kHashA, nullptr, false);  // reverted
    CHECK_EQ(p.home(), 6);
    CHECK(p.usable() != nullptr);
    // A base network never joined before the trial: C unknown before, during and after.
    Pins q;
    q.use(kHashA, nullptr, false);
    q.use(kHashT, nullptr, true);
    CHECK_EQ(q.home(), 0);
    q.use(kHashA, nullptr, false);
    CHECK_EQ(q.home(), 0);
}

TEST(esp_sta_pins_confirmed_trial_becomes_fr_link)
{
    Pins q;
    q.load(pin_a());
    q.use(kHashA, nullptr, false);
    q.use(kHashT, nullptr, true);
    q.associated(kApT.data(), 11);
    CHECK(q.confirm());
    const Pin t{.set = true, .channel = 11, .bssid = kApT, .ssid_hash = kHashT};
    CHECK(q.stored() == t);
    REQUIRE(q.usable() != nullptr);  // the trial's credentials are the node's now
    CHECK_EQ(q.home(), 11);
    CHECK(q.confirm() == false);
    // A second net_set while a trial runs drops the first trial's pin, and keeps the C before the first.
    Pins r;
    r.load(pin_a());
    r.use(kHashA, nullptr, false);
    r.use(kHashT, nullptr, true);
    r.associated(kApT.data(), 11);
    r.use(kHashT + 1, nullptr, true);
    CHECK_EQ(r.home(), 6);
    CHECK(r.confirm() == false);
    CHECK(r.stored() == pin_a());
}
