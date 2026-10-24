// Rigs for the fixture drivers' own code on the IDF shim (firmware/test/host/shim/esp_sim.hpp; design m2-c1-hil §4 S1):
// FixtureService over the real fixture_gpio and fixture_ws2812_rx, on FakeCore's clock.
#pragma once

#include <cstdint>
#include <cstdio>
#include <string>

#include "esp_sim.hpp"
#include "fixture.hpp"
#include "fr/drv/fixture_gpio.hpp"
#include "fr/drv/fixture_ws2812_rx.hpp"
#include "fr/services/fixture_service.hpp"
#include "tests/fake_core.hpp"
#include "tests/fixture_link.hpp"

namespace frt {

/** The shim and the drivers' RAM as a power-on finds them, for one rig's life (one at a time). Construct it after the
 * FakeCore and before any line: a line notes its pin when constructed. */
class SimScope
{
public:
    explicit SimScope(fr::Core &core)
    {
        clear();
        esp_sim::attach(core);
    }
    ~SimScope() { clear(); }
    SimScope(const SimScope &) = delete;
    SimScope &operator=(const SimScope &) = delete;

    static void clear()
    {
        esp_sim::reset();
        fr::drv::fixture_gpio_host_reset();
        fr::drv::fixture_ws2812_rx_host_reset();
    }
};

/** An EdgeSink that keeps nothing: a line driven without FixtureService (the reset-path tests). */
class NullSink final : public fr::hal::EdgeSink
{
public:
    void on_edges(std::span<const fr::hal::FixtureEdge> edges, uint32_t) override { edges_ += edges.size(); }
    void on_frame(const fr::hal::FixtureFrame &) override {}
    size_t edges_ = 0;
};

inline fr::cap::FixtureConfig fixture_config(fr::cap::FixtureDrive drive,
                                             fr::cap::FixtureDecode decode = fr::cap::FixtureDecode::level)
{
    fr::cap::FixtureConfig c;
    c.drive = drive;
    c.decode = decode;
    return c;
}

/** The net a line's pin sits on, as the bench wires it: a DUT's BOOT pull-up on an open_drain line, the MOSFET gate's
 * pull-down on an nfet_gate line (D12). */
inline void wire_net(int gpio, fr::cap::FixtureDrive drive)
{
    if (drive == fr::cap::FixtureDrive::open_drain) {
        esp_sim::set_pull(gpio, esp_sim::Pull::up);
    } else if (drive == fr::cap::FixtureDrive::nfet_gate) {
        esp_sim::set_pull(gpio, esp_sim::Pull::down);
    }
}

/** Output-register writes of `gpio` as "0:0 80000:1" (µs after `t0`, level). */
inline std::string sim_writes(int gpio, fr::TimeUs t0)
{
    std::string out;
    char buf[48];
    for (const esp_sim::Write &w : esp_sim::writes(gpio)) {
        std::snprintf(buf, sizeof(buf), "%s%lld:%d", out.empty() ? "" : " ", static_cast<long long>(w.at - t0),
                      w.level ? 1 : 0);
        out += buf;
    }
    return out;
}

/** FixtureService over the real fixture_gpio on `gpio`, with a live hub (fixture_link) and the bench's net. */
struct GpioRig {
    static constexpr uint8_t kPort = 3;

    explicit GpioRig(const fr::cap::FixtureConfig &cfg, int pin = 42)
        : sim(core), gpio(pin), line({.gpio = static_cast<uint8_t>(pin)}), svc(line, cfg)
    {
        fixture_link() = {.core = &core};
        wire_net(gpio, cfg.drive);
        svc.attach(kPort, "ch0", sink);
    }

    /** FixtureService::init, then the writes init made are forgotten. */
    bool init()
    {
        const bool ok = static_cast<bool>(svc.init(core));
        esp_sim::clear_writes();
        return ok;
    }
    esp_timer *segment() { return esp_sim::timer("fix_segment", &line); }
    esp_timer *guard() { return esp_sim::timer("fix_cap", &line); }
    std::string writes(fr::TimeUs t0) const { return sim_writes(gpio, t0); }

    FakeCore core;
    SimScope sim;
    int gpio;
    fr::drv::FixtureGpio line;
    RecordingSink sink{core};
    fr::FixtureService svc;
};

/** FixtureService over the real fixture_ws2812_rx on `gpio` (decode ws2812). */
struct WsRig {
    static constexpr uint8_t kPort = 8;

    explicit WsRig(int pin = 6)
        : sim(core), gpio(pin), line({.gpio = static_cast<uint8_t>(pin)}),
          svc(line, fixture_config(fr::cap::FixtureDrive::none, fr::cap::FixtureDecode::ws2812))
    {
        fixture_link() = {.core = &core};
        esp_sim::set_drive(gpio, esp_sim::Drive::low);  // the DUT's RMT holds its data line low between refreshes
        svc.attach(kPort, "ch6", sink);
    }

    bool init() { return static_cast<bool>(svc.init(core)); }

    FakeCore core;
    SimScope sim;
    int gpio;
    fr::drv::FixtureWs2812Rx line;
    RecordingSink sink{core};
    fr::FixtureService svc;
};

}  // namespace frt
