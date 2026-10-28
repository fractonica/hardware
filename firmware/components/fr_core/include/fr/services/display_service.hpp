// L2 display service (spec 07 §7.7-7.8; design m2-c5-display D1, D3): fr.display over any hal::Display, drawing through
// a display::Backend (MonoBackend or fr_ui's LvglBackend, chosen by codegen from the driver's traits). Host-buildable.
#pragma once

#include <atomic>
#include <cstdint>

#include "display.hpp"  // generated fr::cap::Display
#include "fr/base.hpp"
#include "fr/core/core.hpp"
#include "fr/display/backend.hpp"
#include "fr/hal/display.hpp"
#include "fr/services/touch_service.hpp"

namespace fr {

/**
 * The commands go to the backend, which never draws inside dispatch (fr/display/backend.hpp): clear, text and
 * fill_rect always; ui_load and ui_set answer what the backend answers (UNSUPPORTED on MonoBackend). Before init(),
 * or when the panel's init failed, every drawing command answers FAILED.
 *
 * Brightness: the property starts at config brightness, which init() applies after the backend's first (black)
 * frame; set_brightness stores and reports a change and drives panel.set_backlight (a panel without backlight control
 * ignores it, the property still says what was asked).
 *
 * Traits come from the panel (size after config rotation, format) and the backend (ui); touch once bind_touch() ran.
 * ui events from the backend may come from any task: they are copied and posted to the core task, then emitted
 * (dropped when the post queue is full).
 *
 * snapshot and snapshot_read (test hooks) answer the backend's; a read hands back at most `len` bytes of the frame
 * snapshot froze.
 */
class DisplayService final : public cap::Display, private TouchListener
{
public:
    DisplayService(hal::Display &panel, display::Backend &backend, const cap::DisplayConfig &cfg);

    /** Before init(): `touch` covers this panel; its touches reach the backend (trait touch). */
    void bind_touch(TouchService &touch);

    Status init(Core &core);
    hal::Selftest selftest();

    Status clear(const cap::DisplayClearArgs &args) override;
    Status text(const cap::DisplayTextArgs &args) override;
    Status fill_rect(const cap::DisplayFillRectArgs &args) override;
    Status set_brightness(const cap::DisplaySetBrightnessArgs &args) override;
    std::expected<cap::DisplayUiLoadResult, Err> ui_load(const cap::DisplayUiLoadArgs &args) override;
    Status ui_set(const cap::DisplayUiSetArgs &args) override;
#if FR_TEST_HOOKS
    std::expected<cap::DisplaySnapshotResult, Err> snapshot() override;
    std::expected<cap::DisplaySnapshotReadResult, Err> snapshot_read(const cap::DisplaySnapshotReadArgs &args) override;
#endif
    uint8_t brightness() const override { return brightness_; }
    cap::DisplayTraits traits() const override;

    /** ui events dropped because the core's post queue was full. */
    uint32_t ui_dropped() const { return ui_dropped_.load(std::memory_order_relaxed); }

private:
    /** A ui event on its way to the core task: fits Core::post's 32-byte callable with `this`. */
    struct UiPost {
        DisplayService *self;
        char id[16];
        uint8_t id_len;
        uint8_t kind;
        int32_t value;
    };

    void on_touch(uint16_t x, uint16_t y, bool pressed) override;
    void on_ui(const cap::DisplayUi &e);
    hal::Rotation rotation() const { return static_cast<hal::Rotation>(cfg_.rotation); }

    hal::Display &panel_;
    display::Backend &backend_;
    cap::DisplayConfig cfg_;
    Core *core_ = nullptr;
    bool ready_ = false;
    bool touch_ = false;
    uint8_t brightness_;
    std::atomic<uint32_t> ui_dropped_{0};  // any task
#if FR_TEST_HOOKS
    uint8_t read_buf_[1024] = {};  // snapshot_read's chunk (len <= 1024)
#endif
};

}  // namespace fr
