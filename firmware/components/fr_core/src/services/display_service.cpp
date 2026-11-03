// fr:realtime
#include "fr/services/display_service.hpp"

#include <algorithm>
#include <cstring>
#include <string_view>

namespace fr {

DisplayService::DisplayService(hal::Display &panel, display::Backend &backend, const cap::DisplayConfig &cfg)
    : panel_(panel), backend_(backend), cfg_(cfg), brightness_(cfg.brightness)
{
}

void DisplayService::bind_touch(TouchService &touch)
{
    touch_ = true;
    touch.listen(*this, panel_.native_width(), panel_.native_height(), rotation());
}

Status DisplayService::init(Core &core)
{
    core_ = &core;
    if (auto st = panel_.init(core, rotation()); !st) {
        return st;
    }
    if (auto st = backend_.init(panel_, cfg_, core, [this](const cap::DisplayUi &e) { on_ui(e); }); !st) {
        return st;
    }
    ready_ = true;
    // After the backend's first frame, which is black: the backlight never shows the panel's power-up noise.
    return panel_.set_backlight(brightness_);
}

hal::Selftest DisplayService::selftest()
{
    return panel_.selftest();
}

cap::DisplayTraits DisplayService::traits() const
{
    const bool swap = hal::swaps_axes(rotation());
    return {.width = swap ? panel_.native_height() : panel_.native_width(),
            .height = swap ? panel_.native_width() : panel_.native_height(),
            .color = panel_.format() == hal::PixelFormat::rgb565 ? cap::DisplayColorFormat::rgb565
                                                                 : cap::DisplayColorFormat::mono1,
            .ui = backend_.ui(),
            .touch = touch_,
            .round = panel_.round()};
}

Status DisplayService::clear(const cap::DisplayClearArgs &args)
{
    if (!ready_) {
        return std::unexpected(Err::failed);
    }
    return backend_.clear(args.color & 0xFFFFFF);
}

Status DisplayService::text(const cap::DisplayTextArgs &args)
{
    if (!ready_) {
        return std::unexpected(Err::failed);
    }
    return backend_.text(args);
}

Status DisplayService::fill_rect(const cap::DisplayFillRectArgs &args)
{
    if (!ready_) {
        return std::unexpected(Err::failed);
    }
    return backend_.fill_rect(args);
}

Status DisplayService::set_brightness(const cap::DisplaySetBrightnessArgs &args)
{
    const bool changed = args.level != brightness_;
    brightness_ = args.level;
    Status st{};
    if (ready_) {
        st = panel_.set_backlight(brightness_);
    }
    if (changed) {
        report_brightness(brightness_);
    }
    return st;
}

std::expected<cap::DisplayUiLoadResult, Err> DisplayService::ui_load(const cap::DisplayUiLoadArgs &args)
{
    if (!backend_.ui()) {
        return std::unexpected(Err::unsupported);
    }
    if (!ready_) {
        return std::unexpected(Err::failed);
    }
    const auto n = backend_.ui_load(args.layout);
    if (!n) {
        return std::unexpected(n.error());
    }
    return cap::DisplayUiLoadResult{.widgets = *n};
}

Status DisplayService::ui_set(const cap::DisplayUiSetArgs &args)
{
    if (!backend_.ui()) {
        return std::unexpected(Err::unsupported);
    }
    if (!ready_) {
        return std::unexpected(Err::failed);
    }
    return backend_.ui_set(args);
}

#if FR_TEST_HOOKS
std::expected<cap::DisplaySnapshotResult, Err> DisplayService::snapshot()
{
    if (!ready_) {
        return std::unexpected(Err::failed);
    }
    const auto s = backend_.snapshot();
    if (!s) {
        return std::unexpected(s.error());
    }
    return cap::DisplaySnapshotResult{
        .crc = s->crc, .width = s->width, .height = s->height, .format = s->format, .bytes = s->bytes};
}

std::expected<cap::DisplaySnapshotReadResult, Err> DisplayService::snapshot_read(
    const cap::DisplaySnapshotReadArgs &args)
{
    if (!ready_) {
        return std::unexpected(Err::failed);
    }
    const size_t len = std::min<size_t>(args.len, sizeof(read_buf_));
    const auto n = backend_.snapshot_read(args.offset, {read_buf_, len});
    if (!n) {
        return std::unexpected(n.error());
    }
    return cap::DisplaySnapshotReadResult{.data = {read_buf_, *n}};
}
#endif

void DisplayService::on_touch(uint16_t x, uint16_t y, bool pressed)
{
    if (ready_) {
        backend_.touch(x, y, pressed);
    }
}

void DisplayService::on_ui(const cap::DisplayUi &e)
{
    // Any task (LVGL's): copy the event, emit it on the core task, which owns the Sink.
    if (core_ == nullptr) {
        return;
    }
    UiPost p{.self = this, .id = {}, .id_len = 0, .kind = static_cast<uint8_t>(e.kind), .value = e.value};
    p.id_len = static_cast<uint8_t>(std::min(e.id.size(), sizeof(p.id)));
    std::memcpy(p.id, e.id.data(), p.id_len);
    const bool posted = core_->post([p] {
        p.self->emit_ui({.id = std::string_view(p.id, p.id_len),
                         .kind = static_cast<cap::DisplayUiEventKind>(p.kind),
                         .value = p.value});
    });
    if (!posted) {
        ui_dropped_.fetch_add(1, std::memory_order_relaxed);
    }
}

}  // namespace fr
