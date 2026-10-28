// Fakes for the fr.display and fr.touch services (design m2-c5-display D3, D4): a panel that records what it is
// flushed, a touch source the test drives, and a backend that records what DisplayService hands it.
#pragma once

#include <cstdint>
#include <span>
#include <string>
#include <vector>

#include "fr/display/backend.hpp"
#include "fr/hal/display.hpp"
#include "fr/hal/touch.hpp"

namespace frt {

/** A panel of any size and format; flushes are recorded with their pixels. */
class FakePanel final : public fr::hal::Display
{
public:
    struct Flush {
        uint16_t x, y, w, h;
        std::vector<uint8_t> pixels;
    };

    FakePanel(uint16_t w, uint16_t h, fr::hal::PixelFormat f, bool backlight = false)
        : w_(w), h_(h), format_(f), backlight_(backlight)
    {
    }

    fr::Status init(fr::Core &, fr::hal::Rotation r) override
    {
        ++inits;
        if (fail_init) {
            return std::unexpected(fr::Err::failed);
        }
        rotation_ = r;
        return {};
    }
    uint16_t native_width() const override { return w_; }
    uint16_t native_height() const override { return h_; }
    fr::hal::PixelFormat format() const override { return format_; }
    fr::hal::Rotation rotation() const override { return rotation_; }
    fr::Status flush(uint16_t x, uint16_t y, uint16_t w, uint16_t h, std::span<const uint8_t> pixels) override
    {
        flushes.push_back({x, y, w, h, {pixels.begin(), pixels.end()}});
        if (fail_flush) {
            return std::unexpected(fr::Err::failed);
        }
        return {};
    }
    bool has_backlight() const override { return backlight_; }
    fr::Status set_backlight(uint8_t level) override
    {
        backlight.push_back(level);
        return {};
    }
    fr::hal::Selftest selftest() override { return {true, "fake panel"}; }

    std::vector<Flush> flushes;
    std::vector<uint8_t> backlight;
    bool fail_init = false;
    bool fail_flush = false;
    int inits = 0;

private:
    uint16_t w_, h_;
    fr::hal::PixelFormat format_;
    bool backlight_;
    fr::hal::Rotation rotation_ = fr::hal::Rotation::r0;
};

/** A touch controller the test drives: report() is its interrupt's read, poll() answers what `finger` says. */
class FakeTouch final : public fr::hal::TouchSource
{
public:
    fr::Status init(fr::Core &, fr::hal::TouchSink &sink) override
    {
        sink_ = &sink;
        return {};
    }
    fr::Status poll() override
    {
        ++polls;
        sink_->on_touch(x, y, down, fr::hal::TouchGesture::none, poll_at);
        return {};
    }
    fr::hal::Selftest selftest() override { return {true, "fake touch"}; }

    /** The controller reports (x, y) now. */
    void report(uint16_t nx, uint16_t ny, bool pressed, fr::TimeUs at,
                fr::hal::TouchGesture g = fr::hal::TouchGesture::none)
    {
        x = nx;
        y = ny;
        down = pressed;
        sink_->on_touch(nx, ny, pressed, g, at);
    }

    uint16_t x = 0, y = 0;
    bool down = false;
    fr::TimeUs poll_at = 0;
    int polls = 0;

private:
    fr::hal::TouchSink *sink_ = nullptr;
};

/** A backend that only records (ui true), and hands out the UiEventSink it got. */
class RecordingBackend final : public fr::display::Backend
{
public:
    fr::Status init(fr::hal::Display &panel, const fr::cap::DisplayConfig &cfg, fr::Core &, fr::display::UiEventSink s) override
    {
        width = panel.width();
        height = panel.height();
        flush_ms = cfg.flush_ms;
        sink = s;
        log.push_back("init");
        return {};
    }
    bool ui() const override { return true; }
    fr::Status clear(uint32_t rgb) override
    {
        log.push_back("clear " + std::to_string(rgb));
        return {};
    }
    fr::Status text(const fr::cap::DisplayTextArgs &a) override
    {
        log.push_back("text " + std::string(a.text));
        return {};
    }
    fr::Status fill_rect(const fr::cap::DisplayFillRectArgs &a) override
    {
        log.push_back("fill " + std::to_string(a.w) + "x" + std::to_string(a.h));
        return {};
    }
    std::expected<uint8_t, fr::Err> ui_load(const fr::cap::DisplayUiLayout &l) override
    {
        log.push_back("ui_load " + std::to_string(l.widgets.size()));
        return static_cast<uint8_t>(l.widgets.size());
    }
    fr::Status ui_set(const fr::cap::DisplayUiSetArgs &a) override
    {
        if (a.id != "known") {
            return std::unexpected(fr::Err::not_found);
        }
        log.push_back("ui_set " + std::string(a.id));
        return {};
    }
    void touch(uint16_t x, uint16_t y, bool pressed) override
    {
        log.push_back("touch " + std::to_string(x) + "," + std::to_string(y) + (pressed ? " down" : " up"));
    }
    std::expected<fr::display::Snapshot, fr::Err> snapshot() override
    {
        return fr::display::Snapshot{0x1234, width, height, fr::cap::DisplayColorFormat::rgb565, 7};
    }
    std::expected<size_t, fr::Err> snapshot_read(uint32_t offset, std::span<uint8_t> out) override
    {
        size_t n = 0;
        for (; n < out.size() && offset + n < 7; ++n) {
            out[n] = static_cast<uint8_t>(offset + n);
        }
        return n;
    }

    std::vector<std::string> log;
    fr::display::UiEventSink sink;
    uint16_t width = 0, height = 0, flush_ms = 0;
};

}  // namespace frt
