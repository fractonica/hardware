// fr:realtime
#include "fr/services/button_service.hpp"

#include <algorithm>

namespace fr {
namespace {

uint32_t held_ms(TimeUs from, TimeUs to)
{
    return to > from ? static_cast<uint32_t>((to - from) / 1000) : 0;
}

}  // namespace

ButtonService::ButtonService(hal::ButtonSource &src, const cap::ButtonConfig &cfg) : src_(src), cfg_(cfg)
{
    cfg_.multi_press_max = std::clamp<uint8_t>(cfg_.multi_press_max, 1, 5);
    traits_.long_press = cfg_.long_press_ms > 0;
    traits_.multi_press_max = cfg_.multi_press_max;
}

Status ButtonService::init(Core &core)
{
    core_ = &core;
    lockout_ = core.timer([this] { on_lockout_end(); });
    long_ = core.timer([this] { on_long(core_->now()); });
    gap_ = core.timer([this] { flush_clicks(core_->now()); });
    if (lockout_ == nullptr || long_ == nullptr || gap_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    if (auto st = src_.init(core, *this); !st) {
        return st;
    }
    // A button held through boot is reported as pressed but never becomes a click.
    stable_ = src_.level_pressed();
    pressed_ = stable_;
    no_click_ = stable_;
    press_at_ = core.now();
    return {};
}

hal::Selftest ButtonService::selftest()
{
    return src_.selftest();
}

void ButtonService::on_button_edge(bool, TimeUs at, uint32_t)
{
    if (lockout_->running()) {
        return;  // the re-sample at the end of the lockout catches up
    }
    // The sampled level is not trusted here: after coalesced edges it can equal the old state.
    accept(!stable_, at);
}

void ButtonService::on_lockout_end()
{
    bool level = src_.level_pressed();
    if (level != stable_) {
        accept(level, core_->now());
    }
}

void ButtonService::accept(bool level, TimeUs at)
{
    stable_ = level;
    lockout_->start(static_cast<uint32_t>(cfg_.debounce_ms) * 1000);
    if (level) {
        press(at, false);
    } else {
        release(at);
    }
}

void ButtonService::press(TimeUs at, bool raw)
{
    if (pressed_) {
        return;
    }
    pressed_ = true;
    press_at_ = at;
    no_click_ = false;
    raw_hold_ = raw;
    if (raw) {
        flush_clicks(at);
    } else {
        gap_->stop();  // a press inside the gap continues the multi-press sequence
    }
    emit_down({}, at);
    report_pressed(true, at);
    if (!raw && traits_.long_press) {
        TimeUs deadline = at + static_cast<TimeUs>(cfg_.long_press_ms) * 1000;
        if (!arm_at(long_, deadline)) {
            on_long(deadline);  // already due (a press in the past, as inject replays it)
        }
    }
}

void ButtonService::release(TimeUs at)
{
    if (!pressed_) {
        return;
    }
    pressed_ = false;
    long_->stop();
    emit_up({.held_ms = held_ms(press_at_, at)}, at);
    report_pressed(false, at);
    if (raw_hold_) {
        raw_hold_ = false;
        return;
    }
    if (no_click_) {
        count_ = 0;
        return;
    }
    ++count_;
    TimeUs gap_end = at + static_cast<TimeUs>(cfg_.multi_press_gap_ms) * 1000;
    if (count_ >= cfg_.multi_press_max) {
        flush_clicks(at);
    } else if (!arm_at(gap_, gap_end)) {
        flush_clicks(gap_end);
    }
}

void ButtonService::on_long(TimeUs at)
{
    if (!pressed_ || no_click_ || raw_hold_) {
        return;
    }
    no_click_ = true;
    flush_clicks(at);
    emit_long_press({.held_ms = held_ms(press_at_, at)}, at);
}

void ButtonService::flush_clicks(TimeUs at)
{
    gap_->stop();
    if (count_ > 0) {
        uint8_t n = count_;
        count_ = 0;
        emit_click({.count = n}, at);
    }
}

bool ButtonService::arm_at(Timer *t, TimeUs deadline)
{
    TimeUs now = core_->now();
    if (deadline <= now) {
        return false;
    }
    t->start(static_cast<uint32_t>(std::min<TimeUs>(deadline - now, UINT32_MAX)));
    return true;
}

#if FR_TEST_HOOKS
namespace {

// Preferred hold of an injected click (and gap inside an injected double click): like a quick tap.
constexpr TimeUs kInjectStepUs = 40'000;
// Hold used to replay long_press when the trait is off, so the replay matches a real long hold.
constexpr uint32_t kDefaultLongPressMs = 600;

}  // namespace

TimeUs ButtonService::inject_step() const
{
    // No shorter than the debounce lockout, which bounds a real hold and a real release-to-press gap,
    // but short enough to stay the requested gesture under any config: a double click starts 3 steps
    // before now, so its first release (2 steps back) must still be inside multi_press_gap_ms and its
    // first press must stay below long_press_ms, with margin for the time the replay itself takes.
    TimeUs step = std::max<TimeUs>(kInjectStepUs, static_cast<TimeUs>(cfg_.debounce_ms) * 1000);
    step = std::min<TimeUs>(step, static_cast<TimeUs>(cfg_.multi_press_gap_ms) * 1000 / 3);
    if (traits_.long_press) {
        step = std::min<TimeUs>(step, static_cast<TimeUs>(cfg_.long_press_ms) * 1000 / 4);
    }
    return step;
}

Status ButtonService::inject(const cap::ButtonInjectArgs &args)
{
    using G = cap::ButtonGesture;
    // Gestures replay through press()/release() with synthetic timestamps ending now, so held_ms, the
    // gap timer, long_press and every emission's time behave as for a real button; only the GPIO and
    // debounce are bypassed.
    TimeUs now = core_->now();
    if (args.gesture == G::release) {
        if (!pressed_ || !raw_hold_) {
            return std::unexpected(Err::busy);
        }
        release(now);
        return {};
    }
    if (pressed_) {
        return std::unexpected(Err::busy);  // a real or injected press is in progress
    }
    const TimeUs step = inject_step();
    switch (args.gesture) {
    case G::click:
        press(now - step, false);
        release(now);
        return {};
    case G::double_click:
        press(now - 3 * step, false);
        release(now - 2 * step);
        press(now - step, false);
        release(now);
        return {};
    case G::long_press: {
        uint32_t long_ms = cfg_.long_press_ms > 0 ? cfg_.long_press_ms : kDefaultLongPressMs;
        // The press starts far enough back that the long-press deadline has passed: press() fires it.
        press(now - static_cast<TimeUs>(long_ms) * 1000 - step, false);
        release(now);
        return {};
    }
    case G::press:
        press(now, true);
        return {};
    default:
        return std::unexpected(Err::invalid_args);
    }
}
#endif

}  // namespace fr
