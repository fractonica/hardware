// L2 fixture service (spec 07 §7.7-7.8; design m2-c1-hil D3, D4, D11): fr.fixture over any hal::FixtureLine.
// Host-buildable. Declared by the M2-C1 foundation; src/services/fixture_service.cpp implements it.
#pragma once

#include <cstddef>
#include <cstdint>
#include <span>

#include "fixture.hpp"  // generated fr::cap::Fixture
#include "fr/base.hpp"
#include "fr/core/core.hpp"
#include "fr/hal/fixture.hpp"

namespace fr {

/**
 * One HIL fixture line, on the core task. The generated glue builds it as `FixtureService service{driver,
 * kConfig}` and calls init(core), as for ButtonService and LedService.
 *
 * Presses: `press` hands its segments to the line and answers at the first press edge (at_us, total_us),
 * with BUSY while a press runs or when the line does not read released, and UNSUPPORTED on drive none; the
 * line itself releases after min(total, cap_ms) + 5 ms. `release` is idempotent.
 *
 * Edges: what the line captures goes out as `edges` events of at most kBatchMax edges, one batch flush_us
 * after its last edge and at most kBatchMaxUs after its first; the event's t_us is the first edge, dt_us
 * the offsets from it, `levels` bit i the level after edge i, `dropped` the ring overflows. `level` is
 * reported after a flush when it changed. Decoded WS2812 refreshes go out as `frame` events; a frame that
 * is not 24 bits counts in `bad_frames` (`read`).
 *
 * Safety (D11 item 3): a press is let go kHubSilentUs after the newest frame the hub sent (link_info()'s
 * hub_heard_at: the session flag would outlive a dead hub by the session timeout, and drop_hub_link keeps it set),
 * and within 100 ms of a WELCOME of another hub run than the press's.
 *
 * PWM setpoints (design m2-c3-inputs §3): a pwm line takes `set_duty` (0..10,000, answered with the time the line
 * applied it) and refuses `press` (UNSUPPORTED); `release` sets it to duty 0, as the driver's release-all and reset
 * paths do. Its `level` (the property and `read`) is duty > 0. A setpoint holds until changed or released: the D11
 * hub rule is about presses, which a DUT's BOOT line feels, and a held voltage on an ADC input is harmless.
 *
 * Traits: `drive` and `decode`, from the config.
 */
class FixtureService final : public cap::Fixture, private hal::EdgeSink
{
public:
    /** Edges per `edges` event (its dt_us max). */
    static constexpr size_t kBatchMax = 32;
    /** A batch is flushed at most this long after its first edge. */
    static constexpr uint32_t kBatchMaxUs = 20'000;
    /** This long after the hub's newest frame, a press is released (D11 item 3). */
    static constexpr uint32_t kHubSilentUs = 2'000'000;

    FixtureService(hal::FixtureLine &line, const cap::FixtureConfig &cfg);

    Status init(Core &core);
    hal::Selftest selftest();

    std::expected<cap::FixturePressResult, Err> press(const cap::FixturePressArgs &args) override;
    Status release() override;
    std::expected<cap::FixtureReadResult, Err> read() override;
    /** A pwm line's duty (design m2-c3-inputs §3); UNSUPPORTED on any other drive, INVALID_ARGS beyond 10,000. */
    std::expected<cap::FixtureSetDutyResult, Err> set_duty(const cap::FixtureSetDutyArgs &args) override;
    bool level() const override { return level_; }
    cap::FixtureTraits traits() const override { return traits_; }

private:
    void on_edges(std::span<const hal::FixtureEdge> edges, uint32_t dropped) override;
    void on_frame(const hal::FixtureFrame &frame) override;
    /** Emits the pending batch, then `level` if it changed. */
    void flush();
    /** µs until the hub check (D11 item 3) is due while a press runs; UINT32_MAX when none runs. */
    uint32_t hub_check_us(TimeUs now) const;
    /** A pwm line's duty is now `duty` (applied at `at`): `level` follows duty > 0. */
    void duty_changed(uint16_t duty, TimeUs at);

    hal::FixtureLine &line_;
    cap::FixtureConfig cfg_;
    cap::FixtureTraits traits_;
    Core *core_ = nullptr;
    Timer *flush_ = nullptr;

    bool level_ = false;  // the reported `level`
    cap::FixtureEdges batch_{};
    uint32_t batch_first_us_ = 0;
    uint32_t edges_ = 0;       // since init (read)
    uint32_t dropped_ = 0;     // since init (read)
    uint32_t bad_frames_ = 0;  // since init (read)
    uint16_t press_epoch_ = 0;  // the hub run the running press came from (LinkInfo::hub_epoch at press())
    uint16_t duty_ = 0;         // a pwm line's duty as last applied (set_duty, release)
};

}  // namespace fr
