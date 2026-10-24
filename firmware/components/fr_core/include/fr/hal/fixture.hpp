// L1 HIL fixture line contract (spec 07 §7.7; design m2-c1-hil D4): one wired line of the fixture board. A
// driver (fixture_gpio, fixture_ws2812_rx) drives and captures its pin; FixtureService turns that into
// fr.fixture commands, events and the `level` property.
#pragma once

#include <cstdint>
#include <expected>
#include <span>

#include "fr/base.hpp"
#include "fr/core/core.hpp"
#include "fr/hal/selftest.hpp"

namespace fr::hal {

/** How a line drives its pin (fr.fixture `drive`). Every line starts released, before it becomes an output. */
enum class FixtureDrive : uint8_t {
    none,        // GPIO_MODE_INPUT: never drives (LED and test_pin taps)
    open_drain,  // GPIO_MODE_INPUT_OUTPUT_OD, no pulls: pulls a DUT BOOT line low, reads its own line back
    nfet_gate,   // push-pull, idle low, only ever wired to a MOSFET gate: high = press
};

/** What a line captures (fr.fixture `decode`). */
enum class FixtureDecode : uint8_t {
    level,   // an any-edge GPIO interrupt (decode level and open_drain lines)
    ws2812,  // RMT RX frames only: no edge interrupt, whose ~800 kHz bit edges would flood the ISR
};

/** The line's fr.fixture config as its service hands it over; the pin is the driver's own Config. */
struct FixtureLineMode {
    FixtureDrive drive = FixtureDrive::none;
    FixtureDecode decode = FixtureDecode::level;
    bool pull_up = false;  // the internal pull-up, on test_pin lines only
};

/** One captured edge: the level after it, stamped in the ISR (esp_timer µs, low 32 bits). */
struct FixtureEdge {
    uint32_t t_us;
    bool level;
};

/** One decoded WS2812 refresh: its start, its bit count and, when it had 24 bits, its GRB value. */
struct FixtureFrame {
    uint32_t start_us;  // done-callback time - (sum of symbol durations + idle threshold)
    uint8_t bits;
    uint32_t grb;
};

/** A started press: its first press edge (readback capture on open_drain, write stamp on nfet_gate). */
struct FixturePress {
    uint32_t at_us;
    uint32_t total_us;  // the segments' sum, clamped to the cap
};

/** Implemented by FixtureService; called on the core task, never from an ISR. */
class EdgeSink
{
public:
    /** Edges in capture order; `dropped` counts edge-ring overflows since the previous call. */
    virtual void on_edges(std::span<const FixtureEdge> edges, uint32_t dropped) = 0;
    /** One decoded refresh (decode ws2812); a frame that is not exactly 24 bits is a bad frame. */
    virtual void on_frame(const FixtureFrame &frame) = 0;

protected:
    ~EdgeSink() = default;
};

/** One fixture GPIO: open-drain or MOSFET-gate presses, edge capture, WS2812 decode. */
class FixtureLine
{
public:
    /** Configures the pin released, then arms capture; drain() delivers to `sink`. */
    virtual Status init(Core &core, const FixtureLineMode &mode, EdgeSink &sink) = 0;
    /**
     * Drives `segments_us` (press, release, press, ...) from ISR-dispatched timers and returns once the
     * first press edge is made. Whatever happens, the line is released min(total, cap_us) + 5 ms after it.
     * Err::busy while a press runs or when the line does not read released; Err::unsupported on drive none.
     */
    virtual std::expected<FixturePress, Err> press(std::span<const uint32_t> segments_us, uint32_t cap_us) = 0;
    /** Stops a running press and releases the line; idempotent. */
    virtual Status release() = 0;
    /** Whether a press is running. */
    virtual bool pressing() const = 0;
    /** The level the pin reads now (open_drain: the line itself, read back). */
    virtual bool level() const = 0;
    /**
     * Hands every edge and frame captured since the last drain to the sink, on the core task. The driver
     * runs it soon after a capture (never from its ISR); the service may also call it, before a flush or
     * a read.
     */
    virtual void drain() = 0;
    /** The line reads released at rest, and capture works where the hardware allows a check. */
    virtual Selftest selftest() = 0;

protected:
    ~FixtureLine() = default;
};

}  // namespace fr::hal
