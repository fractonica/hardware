// L2 button service (spec 07 §7.7-7.8, design c2 §5): fr.button over any hal::ButtonSource. Host-buildable.
#pragma once

#include <cstdint>

#include "button.hpp"  // generated fr::cap::Button
#include "fr/base.hpp"
#include "fr/core/core.hpp"
#include "fr/hal/button.hpp"

namespace fr {

/**
 * Debounce, gestures and the `pressed` property, all on the core task.
 *
 * Debounce adds no latency: the first edge from a stable state is accepted at once, because the edge
 * itself proves a transition even when the ISR sampled late (after a flash stall). A debounce_ms lockout
 * then ignores edges and re-samples level_pressed() at its end, so a release inside the window is not
 * lost; a re-sampled change is accepted the same way and starts another lockout.
 *
 * Gestures: long_press fires once at long_press_ms while held and suppresses that press's click.
 * Clicks are counted until multi_press_gap_ms passes after a release (or at once when the count reaches
 * multi_press_max; multi_press_max 1 clicks on release without waiting). A long press first flushes the
 * clicks counted before it, so `click, long press` reads as click{1} then long_press.
 *
 * Every emission carries the time it describes: down, up and `pressed` the edge timestamp the ISR took
 * (or the lockout's end, for a change the re-sample found); click and long_press the time the gesture
 * was decided, which is when its timer fired, or the release that completed it.
 */
class ButtonService final : public cap::Button, private hal::ButtonSink
{
public:
    ButtonService(hal::ButtonSource &src, const cap::ButtonConfig &cfg);

    Status init(Core &core);
    hal::Selftest selftest();

#if FR_TEST_HOOKS
    Status inject(const cap::ButtonInjectArgs &args) override;
#endif
    bool pressed() const override { return pressed_; }
    cap::ButtonTraits traits() const override { return traits_; }

private:
    void on_button_edge(bool pressed, TimeUs at, uint32_t edges) override;
    void on_lockout_end();
    void accept(bool level, TimeUs at);
    void press(TimeUs at, bool raw);
    void release(TimeUs at);
    void on_long(TimeUs at);
    void flush_clicks(TimeUs at);
    /** Starts `t` to fire at `deadline`; returns false (without starting) if that is already past. */
    bool arm_at(Timer *t, TimeUs deadline);
#if FR_TEST_HOOKS
    /** Hold of an injected click and the release-to-press gap of a double click, from the config. */
    TimeUs inject_step() const;
#endif

    hal::ButtonSource &src_;
    cap::ButtonConfig cfg_;
    cap::ButtonTraits traits_;
    Core *core_ = nullptr;
    Timer *lockout_ = nullptr;
    Timer *long_ = nullptr;
    Timer *gap_ = nullptr;

    bool stable_ = false;    // debounced physical level
    bool pressed_ = false;   // logical state: drives events and the property
    bool raw_hold_ = false;  // held by inject `press`: down/up only, no gestures
    bool no_click_ = false;  // this press already became a long press (or predates init)
    uint8_t count_ = 0;      // clicks counted, not yet emitted
    TimeUs press_at_ = 0;
};

}  // namespace fr
