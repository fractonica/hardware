// The C3 OLED's renderer (design m2-c5-display D3): a 1-bit framebuffer at the panel's size, the built-in 5x7 font and
// a flush of the dirty area from a core timer. IDF-free: the host suite and the desktop renderer (tools/display) build
// the same file, so a mono profile's render is this code's output, byte for byte.
#pragma once

#include <cstddef>
#include <cstdint>
#include <expected>
#include <span>

#include "fr/display/backend.hpp"

namespace fr::display {

/** Whether a mono panel lights a pixel of colour `rgb` (0xRRGGBB): Rec. 601 luma at least 50 %. */
constexpr bool mono_lit(uint32_t rgb)
{
    const uint32_t r = (rgb >> 16) & 0xFF;
    const uint32_t g = (rgb >> 8) & 0xFF;
    const uint32_t b = rgb & 0xFF;
    return 299 * r + 587 * g + 114 * b >= 127'500;  // x1000: 0.5 * 255
}

/** The built-in font: 5x7 glyphs for 0x20..0x7E, one byte per column, bit 0 the top row. */
inline constexpr int kGlyphW = 5;
inline constexpr int kGlyphH = 7;
/** A character cell at size 1: the glyph plus one blank column and one blank row. */
inline constexpr int kCellW = 6;
inline constexpr int kCellH = 8;
/** The glyph for `c`; '?' for anything outside 0x20..0x7E. */
std::span<const uint8_t, kGlyphW> glyph(char c);

/**
 * fr.display primitives on a mono1 panel of at most kMaxWidth x kMaxHeight (the SSD1306's GDDRAM).
 *
 * Drawing (core task, inside dispatch) only touches the RAM framebuffer, in the snapshot layout of
 * fr/display/backend.hpp, and grows a dirty rectangle. The flush timer (the one timer codegen budgets for
 * fr.display) starts on the first change after a flush, at most flush_ms after the previous flush began, and writes
 * one 8-row page of the dirty rectangle per firing (re-arming at once for the next), so the core task handles its
 * inputs between pages (an SSD1306 page at 400 kHz is about 2 ms of I2C).
 *
 * Text: each character is a cell of 6 x 8 pixels times `size` (the 5x7 glyph, one blank column on the right, one
 * blank row at the bottom), left to right from (x, y) with no wrapping; glyph pixels take `color`, the rest of the cell
 * `bg`. Bytes outside 0x20..0x7E draw '?', except UTF-8 continuation bytes (0x80..0xBF), which draw nothing, so one
 * multi-byte character is one '?'. Everything is clipped to the screen. Colours go through mono_lit().
 */
class MonoBackend final : public Backend
{
public:
    static constexpr uint16_t kMaxWidth = 128;
    static constexpr uint16_t kMaxHeight = 64;
    static constexpr size_t kMaxBytes = kMaxWidth / 8 * kMaxHeight;

    Status init(hal::Display &panel, const cap::DisplayConfig &cfg, Core &core, UiEventSink sink) override;
    Status clear(uint32_t rgb) override;
    Status text(const cap::DisplayTextArgs &a) override;
    Status fill_rect(const cap::DisplayFillRectArgs &a) override;
    std::expected<Snapshot, Err> snapshot() override;
    std::expected<size_t, Err> snapshot_read(uint32_t offset, std::span<uint8_t> out) override;

    /** The framebuffer as drawn (snapshot layout), for tests and the desktop renderer. */
    std::span<const uint8_t> framebuffer() const { return {fb_, bytes()}; }
    bool pixel(int x, int y) const;
    uint16_t width() const { return w_; }
    uint16_t height() const { return h_; }
    /** Whether a part of the framebuffer still waits for its flush. */
    bool dirty() const { return dirty_.x0 <= dirty_.x1; }
    /** panel.flush() calls that failed (the area is dropped, not retried). */
    uint32_t flush_errors() const { return flush_errors_; }

private:
    /** Inclusive; empty while x0 > x1. */
    struct Box {
        int x0 = 1, y0 = 1, x1 = 0, y1 = 0;
    };

    size_t stride() const { return (w_ + 7u) / 8u; }
    size_t bytes() const { return stride() * h_; }
    void set(int x, int y, bool on);
    /** Fills the clipped rectangle (x, y, w, h) and marks it dirty. */
    void fill(int x, int y, int w, int h, bool on);
    void mark(int x0, int y0, int x1, int y1);
    void schedule();
    void flush_page();

    hal::Display *panel_ = nullptr;
    Core *core_ = nullptr;
    Timer *timer_ = nullptr;
    uint16_t w_ = 0;
    uint16_t h_ = 0;
    uint32_t flush_us_ = 0;
    TimeUs last_flush_ = 0;
    bool flushed_once_ = false;
    bool flushing_ = false;  // a flush has sent some pages of the dirty rectangle, not all
    Box dirty_;
    uint32_t flush_errors_ = 0;
    uint8_t fb_[kMaxBytes] = {};
    uint8_t frozen_[kMaxBytes] = {};  // the frame the last snapshot() froze
    uint32_t frozen_bytes_ = 0;
    bool has_frozen_ = false;
};

}  // namespace fr::display
