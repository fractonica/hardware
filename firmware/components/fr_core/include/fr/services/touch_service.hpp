// L2 touch service (spec 07 §7.7-7.8; design m2-c5-display D4): fr.touch over any hal::TouchSource. Host-buildable.
#pragma once

#include <cstdint>

#include "fr/base.hpp"
#include "fr/core/core.hpp"
#include "fr/hal/display.hpp"
#include "fr/hal/touch.hpp"
#include "touch.hpp"  // generated fr::cap::Touch

namespace fr {

/** Where touches go besides the fr.touch events: the bound panel's DisplayService (its backend's pointer input). */
class TouchListener
{
public:
    /** (x, y) in the panel's coordinates (after rotation); pressed false is the release at the last position. */
    virtual void on_touch(uint16_t x, uint16_t y, bool pressed) = 0;

protected:
    ~TouchListener() = default;
};

/**
 * One finger, on the core task.
 *
 * Coordinates: the driver reports the controller's native ones (its panel at rotation 0); DisplayService::bind_touch
 * hands over the panel's native size and rotation, and every report is clamped to that size and rotated into the
 * panel's coordinates (r90: x' = H-1-y, y' = x; r180: x' = W-1-x, y' = H-1-y; r270: x' = y, y' = W-1-x, for a native
 * W x H panel), so a touch at (x, y) is the fr.display pixel (x, y). An unbound instance (config display 0) passes
 * coordinates through and reports width and height 0.
 *
 * Events: `down` at the first pressed report, `up` at the release with the last position (both stamped with the
 * report's time), `pressed` follows them. Moves in between go only to the listener. Gestures are recognised here:
 * long_press once at kLongPressMs while held (that touch then ends without another gesture); at the release a swipe
 * when the finger moved at least kSwipeMinPx from where it went down (the longer axis gives the direction), else a
 * tap. A gesture the source recognised itself (hal::TouchGesture other than none on the release) replaces the one
 * recognised here, rotated like the coordinates.
 *
 * Release poll: while a finger is down the timer ticks every kPollMs, and a tick that finds no report for kPollMs
 * reads the controller (TouchSource::poll), so a lost release interrupt still ends the touch.
 *
 * inject (test hook) feeds the same path from the timer, in the panel's coordinates: tap = down, up kTapHoldMs later;
 * long_press = down, up kLongPressMs + kTapHoldMs later (the long_press comes from the recognition above); swipe_* =
 * down at (x, y), two moves and up kInjectSwipePx away in that direction (clamped to the panel), the release carrying
 * the swipe. Nothing is polled during an injected touch, and source reports are ignored until it ends; Err::busy while
 * a finger is down, Err::invalid_args for a point off the bound panel.
 */
class TouchService final : public cap::Touch, private hal::TouchSink
{
public:
    static constexpr uint32_t kLongPressMs = 600;
    static constexpr uint32_t kPollMs = 50;
    static constexpr uint16_t kSwipeMinPx = 24;
    static constexpr uint32_t kTapHoldMs = 50;
    static constexpr uint16_t kInjectSwipePx = 60;
    static constexpr uint32_t kInjectStepMs = 20;

    TouchService(hal::TouchSource &src, const cap::TouchConfig &cfg);

    /** Before init(): the panel this touch covers (DisplayService::bind_touch), its native size and rotation. */
    void listen(TouchListener &listener, uint16_t native_width, uint16_t native_height, hal::Rotation rotation);

    Status init(Core &core);
    hal::Selftest selftest();

#if FR_TEST_HOOKS
    Status inject(const cap::TouchInjectArgs &args) override;
#endif
    bool pressed() const override { return pressed_; }
    cap::TouchTraits traits() const override;

private:
    struct Step {
        TimeUs at;
        uint16_t x, y;
        bool pressed;
        hal::TouchGesture gesture;
    };

    void on_touch(uint16_t x, uint16_t y, bool pressed, hal::TouchGesture gesture, TimeUs at) override;
    /** The common path: (x, y) and `gesture` already in the panel's coordinates. */
    void handle(uint16_t x, uint16_t y, bool pressed, hal::TouchGesture gesture, TimeUs at);
    void on_tick();
    void rearm();
    void emit(hal::TouchGesture g, TimeUs at);
    hal::TouchGesture recognise(uint16_t x, uint16_t y) const;

    hal::TouchSource &src_;
    cap::TouchConfig cfg_;
    TouchListener *listener_ = nullptr;
    uint16_t native_w_ = 0;
    uint16_t native_h_ = 0;
    hal::Rotation rotation_ = hal::Rotation::r0;
    Core *core_ = nullptr;
    Timer *timer_ = nullptr;

    bool pressed_ = false;
    bool long_done_ = false;   // this touch already became a long press
    bool long_armed_ = false;  // its long-press deadline is still ahead
    uint16_t down_x_ = 0, down_y_ = 0;
    uint16_t last_x_ = 0, last_y_ = 0;
    TimeUs down_at_ = 0;
    TimeUs last_report_ = 0;

    // An injected touch: its steps, run from the timer.
    Step steps_[5] = {};
    uint8_t n_steps_ = 0;
    uint8_t next_step_ = 0;
    bool injecting_ = false;
};

}  // namespace fr
