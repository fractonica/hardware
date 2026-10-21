// fr:realtime
#include "fr/services/led_service.hpp"

#include <algorithm>

namespace fr {
namespace {

hal::Rgb rgb_of(uint32_t c)
{
    return {static_cast<uint8_t>(c >> 16), static_cast<uint8_t>(c >> 8), static_cast<uint8_t>(c)};
}

}  // namespace

LedService::LedService(hal::LightOutput &out, const cap::LedConfig &cfg)
    : out_(out), max_brightness_(cfg.max_brightness)
{
    steady_.brightness = max_brightness_;
}

Status LedService::init(Core &core)
{
    timer_ = core.timer([this] { on_phase(); });
    if (timer_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    if (auto st = out_.init(core); !st) {
        return st;
    }
    features_ = out_.features();
    return show_steady();
}

hal::Selftest LedService::selftest()
{
    hal::Selftest r = out_.selftest();
    // The self-test drove the pin; put back what the LED is supposed to show.
    if (blinking_ && phase_on_) {
        (void)show_blink_on();
    } else if (blinking_) {
        (void)out_.write({.on = false, .brightness = steady_.brightness, .color = rgb_of(steady_.color)});
    } else {
        (void)show_steady();
    }
    return r;
}

cap::LedTraits LedService::traits() const
{
    return {.color = features_.rgb ? cap::LedColorMode::rgb : cap::LedColorMode::mono,
            .dimmable = features_.dimmable};
}

Status LedService::set(const cap::LedSetArgs &args)
{
    Steady before = steady_;
    steady_.on = args.on;
    // Brightness and colour the driver cannot show are ignored, not stored: the properties that would
    // describe them are hidden, so a stored value could only make `on` lie about what is shown.
    if (args.has_brightness && features_.dimmable) {
        steady_.brightness = std::min(args.brightness, max_brightness_);
    }
    if (args.has_color && features_.rgb) {
        steady_.color = args.color & 0xFFFFFF;
    }
    bool ended = end_blink();
    Status st = show_steady();
    report_changes(before);
    if (ended) {
        emit_effect_done({.effect = cap::LedEffect::blink});
    }
    return st;
}

Status LedService::toggle()
{
    Steady before = steady_;
    steady_.on = !steady_.on;
    bool ended = end_blink();
    Status st = show_steady();
    report_changes(before);
    if (ended) {
        emit_effect_done({.effect = cap::LedEffect::blink});
    }
    return st;
}

Status LedService::blink(const cap::LedBlinkArgs &args)
{
    blinking_ = true;
    phase_on_ = true;
    on_ms_ = args.on_ms;
    off_ms_ = args.off_ms;
    remaining_ = args.count;
    forever_ = args.count == 0;
    blink_color_ = args.has_color ? args.color & 0xFFFFFF : steady_.color;
    Status st = show_blink_on();
    if (!st) {
        end_blink();
        (void)show_steady();
        return st;
    }
    timer_->start(static_cast<uint32_t>(on_ms_) * 1000);
    return {};
}

Status LedService::stop()
{
    if (!end_blink()) {
        return {};
    }
    Status st = show_steady();
    emit_effect_done({.effect = cap::LedEffect::blink});
    return st;
}

void LedService::on_phase()
{
    if (!blinking_) {
        return;
    }
    if (phase_on_) {
        phase_on_ = false;
        (void)out_.write({.on = false, .brightness = steady_.brightness, .color = rgb_of(blink_color_)});
        timer_->start(static_cast<uint32_t>(off_ms_) * 1000);
        return;
    }
    if (!forever_ && --remaining_ == 0) {
        blinking_ = false;
        (void)show_steady();
        emit_effect_done({.effect = cap::LedEffect::blink});
        return;
    }
    phase_on_ = true;
    (void)show_blink_on();
    timer_->start(static_cast<uint32_t>(on_ms_) * 1000);
}

bool LedService::end_blink()
{
    if (!blinking_) {
        return false;
    }
    blinking_ = false;
    timer_->stop();
    return true;
}

Status LedService::show_steady()
{
    return out_.write({.on = steady_.on, .brightness = steady_.brightness, .color = rgb_of(steady_.color)});
}

Status LedService::show_blink_on()
{
    return out_.write({.on = true, .brightness = steady_.brightness, .color = rgb_of(blink_color_)});
}

void LedService::report_changes(const Steady &before)
{
    if (steady_.on != before.on) {
        report_on(steady_.on);
    }
    if (features_.dimmable && steady_.brightness != before.brightness) {
        report_brightness(steady_.brightness);
    }
    if (features_.rgb && steady_.color != before.color) {
        report_color(steady_.color);
    }
}

}  // namespace fr
