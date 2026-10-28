// fr:realtime
#include "fr/display/mono_backend.hpp"

#include <algorithm>
#include <cstring>

namespace fr::display {

Status MonoBackend::init(hal::Display &panel, const cap::DisplayConfig &cfg, Core &core, UiEventSink sink)
{
    static_cast<void>(sink);  // no widgets, so no ui events
    if (panel.format() != hal::PixelFormat::mono1) {
        return std::unexpected(Err::invalid_args);
    }
    const uint16_t w = panel.width();
    const uint16_t h = panel.height();
    if (w == 0 || h == 0 || w > kMaxWidth || h > kMaxHeight) {
        return std::unexpected(Err::unsupported);
    }
    timer_ = core.timer([this] { flush_page(); });
    if (timer_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    panel_ = &panel;
    core_ = &core;
    w_ = w;
    h_ = h;
    flush_us_ = static_cast<uint32_t>(cfg.flush_ms) * 1000u;
    std::memset(fb_, 0, sizeof(fb_));
    // The panel came up black; flushing the whole screen once makes sure of it.
    mark(0, 0, w_ - 1, h_ - 1);
    return {};
}

Status MonoBackend::clear(uint32_t rgb)
{
    if (panel_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    fill(0, 0, w_, h_, mono_lit(rgb));
    return {};
}

Status MonoBackend::fill_rect(const cap::DisplayFillRectArgs &a)
{
    if (panel_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    fill(a.x, a.y, a.w, a.h, mono_lit(a.color));
    return {};
}

Status MonoBackend::text(const cap::DisplayTextArgs &a)
{
    if (panel_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    const int s = std::clamp<int>(a.size, 1, 4);
    const bool fg = mono_lit(a.color);
    const bool bg = mono_lit(a.bg);
    int cx = a.x;
    for (char ch : a.text) {
        if (cx >= w_) {
            break;  // the rest is off the right edge
        }
        const auto u = static_cast<uint8_t>(ch);
        if (u >= 0x80 && u <= 0xBF) {
            continue;  // a UTF-8 continuation byte: its lead byte drew the '?'
        }
        const auto g = glyph(u >= 0x80 ? '?' : ch);
        fill(cx, a.y, kCellW * s, kCellH * s, bg);
        if (fg != bg) {
            for (int col = 0; col < kGlyphW; ++col) {
                for (int row = 0; row < kGlyphH; ++row) {
                    if (((g[col] >> row) & 1u) != 0) {
                        fill(cx + col * s, a.y + row * s, s, s, fg);
                    }
                }
            }
        }
        cx += kCellW * s;
    }
    return {};
}

std::expected<Snapshot, Err> MonoBackend::snapshot()
{
    if (panel_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    const size_t n = bytes();
    std::memcpy(frozen_, fb_, n);
    frozen_bytes_ = static_cast<uint32_t>(n);
    has_frozen_ = true;
    return Snapshot{.crc = crc32({frozen_, n}),
                    .width = w_,
                    .height = h_,
                    .format = cap::DisplayColorFormat::mono1,
                    .bytes = frozen_bytes_};
}

std::expected<size_t, Err> MonoBackend::snapshot_read(uint32_t offset, std::span<uint8_t> out)
{
    if (!has_frozen_) {
        return std::unexpected(Err::failed);
    }
    if (offset > frozen_bytes_) {
        return std::unexpected(Err::invalid_args);
    }
    const size_t n = std::min<size_t>(out.size(), frozen_bytes_ - offset);
    std::memcpy(out.data(), frozen_ + offset, n);
    return n;
}

bool MonoBackend::pixel(int x, int y) const
{
    if (x < 0 || y < 0 || x >= w_ || y >= h_) {
        return false;
    }
    return ((fb_[static_cast<size_t>(y) * stride() + static_cast<size_t>(x) / 8] >> (7 - x % 8)) & 1u) != 0;
}

void MonoBackend::set(int x, int y, bool on)
{
    uint8_t &b = fb_[static_cast<size_t>(y) * stride() + static_cast<size_t>(x) / 8];
    const auto bit = static_cast<uint8_t>(0x80u >> (x % 8));
    b = on ? static_cast<uint8_t>(b | bit) : static_cast<uint8_t>(b & ~bit);
}

void MonoBackend::fill(int x, int y, int w, int h, bool on)
{
    const int x0 = std::max(x, 0);
    const int y0 = std::max(y, 0);
    const int x1 = std::min(x + w, static_cast<int>(w_)) - 1;
    const int y1 = std::min(y + h, static_cast<int>(h_)) - 1;
    if (x0 > x1 || y0 > y1) {
        return;
    }
    for (int yy = y0; yy <= y1; ++yy) {
        for (int xx = x0; xx <= x1; ++xx) {
            set(xx, yy, on);
        }
    }
    mark(x0, y0, x1, y1);
}

void MonoBackend::mark(int x0, int y0, int x1, int y1)
{
    if (!dirty()) {
        dirty_ = {x0, y0, x1, y1};
    } else {
        dirty_ = {std::min(dirty_.x0, x0), std::min(dirty_.y0, y0), std::max(dirty_.x1, x1), std::max(dirty_.y1, y1)};
    }
    schedule();
}

void MonoBackend::schedule()
{
    if (timer_ == nullptr || timer_->running() || !dirty()) {
        return;
    }
    const TimeUs now = core_->now();
    const TimeUs due = flushed_once_ ? last_flush_ + flush_us_ : now;
    timer_->start(due > now ? static_cast<uint32_t>(due - now) : 0);
}

void MonoBackend::flush_page()
{
    if (!dirty()) {
        return;
    }
    // A flush begins with the first page of a dirty rectangle; the coalescing period counts from there.
    if (!flushing_) {
        flushing_ = true;
        flushed_once_ = true;
        last_flush_ = core_->now();
    }
    const int r0 = dirty_.y0 / 8 * 8;
    const int r1 = std::min(r0 + 8, static_cast<int>(h_)) - 1;
    const int x0 = dirty_.x0;
    const int x1 = dirty_.x1;
    const int w = x1 - x0 + 1;
    const int rows = r1 - r0 + 1;
    const size_t out_stride = (static_cast<size_t>(w) + 7u) / 8u;
    uint8_t area[kMaxWidth / 8 * 8] = {};
    for (int r = 0; r < rows; ++r) {
        for (int c = 0; c < w; ++c) {
            if (pixel(x0 + c, r0 + r)) {
                area[static_cast<size_t>(r) * out_stride + static_cast<size_t>(c) / 8] |=
                    static_cast<uint8_t>(0x80u >> (c % 8));
            }
        }
    }
    if (!panel_->flush(static_cast<uint16_t>(x0), static_cast<uint16_t>(r0), static_cast<uint16_t>(w),
                       static_cast<uint16_t>(rows), {area, out_stride * static_cast<size_t>(rows)})) {
        ++flush_errors_;  // dropped: the next change of this area sends it again
    }
    if (r1 >= dirty_.y1) {
        dirty_ = {};
        flushing_ = false;
        return;
    }
    dirty_.y0 = r1 + 1;
    timer_->start(0);  // the next page after the core task's other work
}

}  // namespace fr::display
