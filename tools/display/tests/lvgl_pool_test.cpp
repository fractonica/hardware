// fr_ui and a full LVGL pool (design scale-round-c1 D4): the board without PSRAM has a small pool of internal RAM, and
// an LVGL allocation that fails while drawing dereferences NULL. ui_load answers FAILED up front for a layout the
// pool cannot hold, the renderer abandons what it cannot build, and nothing crashes. The pool is squeezed with
// lv_malloc blocks, so these run in any build (the Mac's 128 KB pool or a board's, FR_DISPLAY_LV_MEM_SIZE).
#include <algorithm>
#include <string>
#include <vector>

#include "fr/ui/lvgl_backend.hpp"
#include "lvgl.h"
#include "session.hpp"
#include "tests/test.hpp"

namespace {

using fr::hal::PixelFormat;
using fr::hal::Rotation;
using fr::ui::LvglBackend;

/** The C6 scale board's GC9A01 (profile c6w-scale): 240 x 240, round. */
constexpr frd::Geometry kRound{240, 240, PixelFormat::rgb565, Rotation::r0, true, true};

/** Takes LVGL's pool down to about `keep` bytes free with lv_malloc blocks; gives them back when it goes. */
struct Squeeze {
    std::vector<void *> blocks;
    explicit Squeeze(size_t keep)
    {
        for (;;) {
            lv_mem_monitor_t m;
            lv_mem_monitor(&m);
            if (m.free_size <= keep + 64) {
                break;
            }
            size_t take = std::min<size_t>(m.free_biggest_size, m.free_size - keep);
            take = take > 64 ? take - 32 : 0;  // the block's own header
            void *p = take != 0 ? lv_malloc(take) : nullptr;
            if (p == nullptr) {
                break;
            }
            blocks.push_back(p);
        }
    }
    ~Squeeze()
    {
        for (void *p : blocks) {
            lv_free(p);
        }
    }
    Squeeze(const Squeeze &) = delete;
    Squeeze &operator=(const Squeeze &) = delete;
};

size_t pool_free()
{
    lv_mem_monitor_t m;
    lv_mem_monitor(&m);
    return m.free_size;
}

/** A ui_load of `n` widgets, the kinds in turn, with long texts. */
std::string layout(int n, const char *prefix = "w")
{
    static const char *kinds[] = {"label", "button", "bar", "slider", "arc", "switch", "rect"};
    std::string s = R"({"cmd":"ui_load","args":{"layout":{"bg":255,"widgets":[)";
    for (int i = 0; i < n; ++i) {
        s += (i ? "," : "") + std::string(R"({"id":")") + prefix + std::to_string(i) + R"(","kind":")" + kinds[i % 7] +
             R"(","x":)" + std::to_string(30 + (i % 3) * 60) + R"(,"y":)" + std::to_string(20 + (i / 3) * 25) +
             R"(,"w":50,"h":20,"text":"Widget )" + std::to_string(i) + R"( with a long text","value":50})";
    }
    return s + "]}}}";
}

const std::string kSet0 = R"({"cmd":"ui_set","args":{"id":"w0","text":"set","fields":1}})";

}  // namespace

TEST(display_lvgl_pool_layout_too_big_is_refused_up_front)
{
    frd::Session s(kRound);
    REQUIRE(s.start().has_value());
    REQUIRE(s.run_line(layout(2, "old"), 1).has_value());
    const size_t keep = LvglBackend::kRenderReserve + 3 * 1024;
    {
        const Squeeze squeeze(keep + 4096);  // the old layout's widgets are freed by the clear below
        REQUIRE(s.run_line(R"({"cmd":"clear","args":{"color":0}})", 2).has_value());  // measures the empty screen
        REQUIRE(s.errors().empty());
        // 24 widgets need far more than the pool has: FAILED at once, nothing queued, nothing built.
        const uint32_t abandoned = s.lvgl()->heap().abandoned;
        REQUIRE(s.run_line(layout(24), 3).has_value());
        REQUIRE_EQ(s.errors().size(), 1u);
        CHECK_EQ(s.errors()[0].error, "failed");
        CHECK_EQ(s.lvgl()->heap().abandoned, abandoned);
        // ui_set has no layout to talk to.
        REQUIRE(s.run_line(kSet0, 4).has_value());
        REQUIRE_EQ(s.errors().size(), 2u);
        CHECK_EQ(s.errors()[1].error, "not_found");
        // A small layout still fits, and works.
        REQUIRE(s.run_line(layout(2), 5).has_value());
        REQUIRE(s.run_line(kSet0, 6).has_value());
        CHECK_EQ(s.errors().size(), 2u);
        s.advance(100);
    }
    // The pool back: the big layout loads.
    REQUIRE(s.run_line(R"({"cmd":"clear","args":{"color":0}})", 7).has_value());
    REQUIRE(s.run_line(layout(24), 8).has_value());
    REQUIRE(s.run_line(kSet0, 9).has_value());
    CHECK_EQ(s.errors().size(), 2u);
}

TEST(display_lvgl_pool_exhausted_while_building_abandons_the_layout)
{
    frd::Session s(kRound);
    REQUIRE(s.start().has_value());
    LvglBackend &b = *s.lvgl();
    {
        // Accepted up front (the empty screen had room), then the pool shrinks before the renderer builds it.
        b.host_hold(true);
        REQUIRE(s.run_line(layout(24), 1).has_value());
        REQUIRE(s.errors().empty());
        const Squeeze squeeze(LvglBackend::kRenderReserve + LvglBackend::kObjectBytes + 3 * 1024);
        b.host_hold(false);
        s.settle();
        CHECK(b.heap().abandoned >= 1u);
        // Abandoned whole: no widget answers, the panel still draws (the reserve was kept for it).
        REQUIRE(s.run_line(kSet0, 2).has_value());
        REQUIRE_EQ(s.errors().size(), 1u);
        CHECK_EQ(s.errors()[0].error, "failed");
        s.advance(100);
        CHECK(pool_free() + 64 >= LvglBackend::kRenderReserve);
        auto snap = s.snapshot();
        REQUIRE(snap.has_value());
    }
    // The pool back (a clear measures it again): the next ui_load builds and its ui_set answers.
    REQUIRE(s.run_line(R"({"cmd":"clear","args":{"color":0}})", 3).has_value());
    REQUIRE(s.run_line(layout(24), 3).has_value());
    REQUIRE(s.run_line(kSet0, 4).has_value());
    CHECK_EQ(s.errors().size(), 1u);
    CHECK(s.snapshot().has_value());
}

TEST(display_lvgl_pool_primitives_stop_at_the_reserve)
{
    frd::Session s(kRound);
    REQUIRE(s.start().has_value());
    LvglBackend &b = *s.lvgl();
    const Squeeze squeeze(LvglBackend::kRenderReserve + 6 * 1024);
    // 64 primitives: the first fit, then BUSY up front once the pool has no room for one more; nothing crashes.
    for (int i = 0; i < 64; ++i) {
        const std::string line = R"({"cmd":"text","args":{"x":)" + std::to_string(20 + i * 3) + R"(,"y":)" +
                                 std::to_string(20 + i * 3) + R"(,"text":"primitive number )" + std::to_string(i) +
                                 R"(","size":)" + std::to_string(1 + i % 4) + "}}";
        REQUIRE(s.run_line(line, static_cast<size_t>(i + 1)).has_value());
    }
    CHECK(!s.errors().empty());
    CHECK(s.errors().size() < 64u);
    for (const auto &e : s.errors()) {
        CHECK_EQ(e.error, "busy");
    }
    CHECK_EQ(b.heap().abandoned, 0u);  // refused up front, none answered OK and then skipped
    // Queued behind a busy renderer (the up-front check counts what is queued), then built or skipped.
    REQUIRE(s.run_line(R"({"cmd":"clear","args":{"color":0}})", 100).has_value());
    const size_t before = s.errors().size();
    b.host_hold(true);
    size_t accepted = 0;
    for (int i = 0; i < 15; ++i) {
        const fr::cap::DisplayFillRectArgs r{.x = static_cast<int16_t>(40 + i), .y = 40, .w = 4, .h = 4, .color = 255};
        accepted += b.fill_rect(r) ? 1 : 0;
    }
    b.host_hold(false);
    s.settle();
    CHECK(accepted > 0u && accepted < 15u);
    CHECK_EQ(s.errors().size(), before);
    CHECK(pool_free() + 64 >= LvglBackend::kRenderReserve);
    CHECK(s.snapshot().has_value());
}
