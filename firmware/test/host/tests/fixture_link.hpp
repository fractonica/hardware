// What fr::core::link_info() answers in the host suite (fixture_link.cpp defines it; core.cpp and fr_net_node do on
// their runtimes): FixtureService's D11 release rule reads the hub's last frame and run from it (design m2-c1-hil).
#pragma once

#include <cstdint>

#include "fr/core/core.hpp"
#include "fr/net/net.hpp"

namespace frt {

struct FixtureLink {
    /** A Net-backed test points this at its Net: link_info() is then hub_link_info() over it, as on target. */
    const fr::net::Net *net = nullptr;
    /** Otherwise: a live hub (its newest frame now, on `core`'s clock) or the stamp below. */
    const fr::Core *core = nullptr;
    bool hub_live = true;
    fr::TimeUs heard_at = 0;
    uint16_t epoch = 41;
    bool session = true;

    /** The hub goes quiet now: its newest frame stays where the clock is. */
    void hub_stops()
    {
        heard_at = core != nullptr ? core->now() : 0;
        hub_live = false;
    }
    /** One frame from the hub now. */
    void hub_frame() { heard_at = core != nullptr ? core->now() : 0; }
};

/** The suite's one link record; each fixture rig resets it. */
FixtureLink &fixture_link();

}  // namespace frt
