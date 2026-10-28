// fr:realtime
#include "fr/services/touch_service.hpp"

#include <algorithm>
#include <cstdlib>

namespace fr {
namespace {

using hal::Rotation;
using hal::TouchGesture;

constexpr TimeUs ms(uint32_t v)
{
    return static_cast<TimeUs>(v) * 1000;
}

/** A swipe's direction as a unit step (screen y grows downwards); {0, 0} for anything else. */
struct Dir {
    int dx, dy;
};

Dir dir_of(TouchGesture g)
{
    switch (g) {
    case TouchGesture::swipe_up:
        return {0, -1};
    case TouchGesture::swipe_down:
        return {0, 1};
    case TouchGesture::swipe_left:
        return {-1, 0};
    case TouchGesture::swipe_right:
        return {1, 0};
    default:
        return {0, 0};
    }
}

TouchGesture swipe_of(Dir d)
{
    if (d.dy < 0) {
        return TouchGesture::swipe_up;
    }
    if (d.dy > 0) {
        return TouchGesture::swipe_down;
    }
    return d.dx < 0 ? TouchGesture::swipe_left : TouchGesture::swipe_right;
}

/** A native-frame swipe in the rotated frame (the point mapping of TouchService, differentiated). */
TouchGesture rotate_gesture(TouchGesture g, Rotation r)
{
    const Dir d = dir_of(g);
    if (d.dx == 0 && d.dy == 0) {
        return g;  // tap, long press, none
    }
    switch (r) {
    case Rotation::r0:
        return g;
    case Rotation::r90:
        return swipe_of({-d.dy, d.dx});
    case Rotation::r180:
        return swipe_of({-d.dx, -d.dy});
    case Rotation::r270:
        return swipe_of({d.dy, -d.dx});
    }
    return g;
}

uint16_t clamp_to(int v, uint16_t size)
{
    return static_cast<uint16_t>(std::clamp(v, 0, size > 0 ? size - 1 : 0xFFFF));
}

}  // namespace

TouchService::TouchService(hal::TouchSource &src, const cap::TouchConfig &cfg) : src_(src), cfg_(cfg) {}

void TouchService::listen(TouchListener &listener, uint16_t native_width, uint16_t native_height,
                          hal::Rotation rotation)
{
    listener_ = &listener;
    native_w_ = native_width;
    native_h_ = native_height;
    rotation_ = rotation;
}

Status TouchService::init(Core &core)
{
    core_ = &core;
    timer_ = core.timer([this] { on_tick(); });
    if (timer_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    return src_.init(core, *this);
}

hal::Selftest TouchService::selftest()
{
    return src_.selftest();
}

cap::TouchTraits TouchService::traits() const
{
    if (listener_ == nullptr) {
        return {.width = 0, .height = 0, .display = cfg_.display};
    }
    const bool swap = hal::swaps_axes(rotation_);
    return {.width = swap ? native_h_ : native_w_, .height = swap ? native_w_ : native_h_, .display = cfg_.display};
}

void TouchService::on_touch(uint16_t x, uint16_t y, bool pressed, hal::TouchGesture gesture, TimeUs at)
{
    if (injecting_) {
        return;  // an injected touch runs to its end undisturbed
    }
    last_report_ = core_->now();
    if (listener_ == nullptr) {
        handle(x, y, pressed, gesture, at);
        return;
    }
    const int W = native_w_;
    const int H = native_h_;
    const int cx = std::clamp<int>(x, 0, std::max(W - 1, 0));
    const int cy = std::clamp<int>(y, 0, std::max(H - 1, 0));
    int rx = cx;
    int ry = cy;
    switch (rotation_) {
    case Rotation::r0:
        break;
    case Rotation::r90:
        rx = H - 1 - cy;
        ry = cx;
        break;
    case Rotation::r180:
        rx = W - 1 - cx;
        ry = H - 1 - cy;
        break;
    case Rotation::r270:
        rx = cy;
        ry = W - 1 - cx;
        break;
    }
    handle(static_cast<uint16_t>(std::max(rx, 0)), static_cast<uint16_t>(std::max(ry, 0)), pressed,
           rotate_gesture(gesture, rotation_), at);
}

void TouchService::handle(uint16_t x, uint16_t y, bool pressed, hal::TouchGesture gesture, TimeUs at)
{
    if (pressed) {
        if (pressed_) {
            if (x != last_x_ || y != last_y_) {
                last_x_ = x;
                last_y_ = y;
                if (listener_ != nullptr) {
                    listener_->on_touch(x, y, true);
                }
            }
            return;
        }
        pressed_ = true;
        long_done_ = false;
        long_armed_ = true;
        down_x_ = last_x_ = x;
        down_y_ = last_y_ = y;
        down_at_ = core_->now();
        emit_down({.x = x, .y = y}, at);
        report_pressed(true, at);
        if (listener_ != nullptr) {
            listener_->on_touch(x, y, true);
        }
        rearm();
        return;
    }
    if (!pressed_) {
        return;  // a release without a touch (a poll after the end, a stray report)
    }
    pressed_ = false;
    last_x_ = x;
    last_y_ = y;
    emit_up({.x = x, .y = y}, at);
    report_pressed(false, at);
    if (listener_ != nullptr) {
        listener_->on_touch(x, y, false);
    }
    if (!long_done_) {
        emit(gesture != TouchGesture::none ? gesture : recognise(x, y), at);
    }
    rearm();
}

TouchGesture TouchService::recognise(uint16_t x, uint16_t y) const
{
    const int dx = static_cast<int>(x) - down_x_;
    const int dy = static_cast<int>(y) - down_y_;
    if (std::max(std::abs(dx), std::abs(dy)) < kSwipeMinPx) {
        return TouchGesture::tap;
    }
    if (std::abs(dx) >= std::abs(dy)) {
        return dx > 0 ? TouchGesture::swipe_right : TouchGesture::swipe_left;
    }
    return dy > 0 ? TouchGesture::swipe_down : TouchGesture::swipe_up;
}

void TouchService::emit(hal::TouchGesture g, TimeUs at)
{
    if (g == TouchGesture::none) {
        return;
    }
    emit_gesture({.kind = static_cast<cap::TouchGestureKind>(static_cast<uint8_t>(g) - 1)}, at);
}

void TouchService::on_tick()
{
    const TimeUs now = core_->now();
    while (injecting_ && next_step_ < n_steps_ && steps_[next_step_].at <= now) {
        const Step s = steps_[next_step_++];
        handle(s.x, s.y, s.pressed, s.gesture, now);
    }
    if (injecting_ && next_step_ >= n_steps_) {
        injecting_ = false;
    }
    if (pressed_ && long_armed_ && now >= down_at_ + ms(kLongPressMs)) {
        long_armed_ = false;
        // A finger that wandered off is on its way to a swipe, not a long press.
        if (recognise(last_x_, last_y_) == TouchGesture::tap) {
            long_done_ = true;
            emit(TouchGesture::long_press, now);
        }
    }
    if (pressed_ && !injecting_ && now >= last_report_ + ms(kPollMs)) {
        last_report_ = now;
        (void)src_.poll();  // reports through on_touch, a release included
    }
    rearm();
}

void TouchService::rearm()
{
    TimeUs next = -1;
    const auto consider = [&next](TimeUs t) {
        if (next < 0 || t < next) {
            next = t;
        }
    };
    if (injecting_ && next_step_ < n_steps_) {
        consider(steps_[next_step_].at);
    }
    if (pressed_ && long_armed_) {
        consider(down_at_ + ms(kLongPressMs));
    }
    if (pressed_ && !injecting_) {
        consider(last_report_ + ms(kPollMs));
    }
    if (next < 0) {
        timer_->stop();
        return;
    }
    const TimeUs now = core_->now();
    timer_->start(next > now ? static_cast<uint32_t>(next - now) : 0);
}

#if FR_TEST_HOOKS
Status TouchService::inject(const cap::TouchInjectArgs &args)
{
    if (core_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    if (pressed_ || injecting_) {
        return std::unexpected(Err::busy);
    }
    const cap::TouchTraits t = traits();
    if (listener_ != nullptr && (args.x >= t.width || args.y >= t.height)) {
        return std::unexpected(Err::invalid_args);
    }
    const TimeUs now = core_->now();
    const auto g = static_cast<TouchGesture>(static_cast<uint8_t>(args.gesture) + 1);
    const uint16_t x = args.x;
    const uint16_t y = args.y;
    n_steps_ = 0;
    steps_[n_steps_++] = {now, x, y, true, TouchGesture::none};
    switch (g) {
    case TouchGesture::tap:
        steps_[n_steps_++] = {now + ms(kTapHoldMs), x, y, false, TouchGesture::tap};
        break;
    case TouchGesture::long_press:
        // The long press comes from the recognition at kLongPressMs; the release then adds nothing.
        steps_[n_steps_++] = {now + ms(kLongPressMs + kTapHoldMs), x, y, false, TouchGesture::none};
        break;
    default: {
        const Dir d = dir_of(g);
        const uint16_t ex = clamp_to(x + d.dx * kInjectSwipePx, t.width);
        const uint16_t ey = clamp_to(y + d.dy * kInjectSwipePx, t.height);
        const auto mx = static_cast<uint16_t>((x + ex) / 2);
        const auto my = static_cast<uint16_t>((y + ey) / 2);
        steps_[n_steps_++] = {now + ms(kInjectStepMs), mx, my, true, TouchGesture::none};
        steps_[n_steps_++] = {now + ms(2 * kInjectStepMs), ex, ey, true, TouchGesture::none};
        steps_[n_steps_++] = {now + ms(3 * kInjectStepMs), ex, ey, false, g};
        break;
    }
    }
    injecting_ = true;
    next_step_ = 1;
    handle(x, y, true, TouchGesture::none, now);  // the down, at once
    return {};
}
#endif

}  // namespace fr
