// One render on the Mac (design m2-c5-display D6): the firmware's display stack over a host panel, a script line at
// a time. See session.hpp.
#include "session.hpp"

#include <algorithm>
#include <cJSON.h>
#include <cstring>

#include "diag_json.hpp"
#include "fr/display/mono_backend.hpp"
#include "fr/ui/lvgl_backend.hpp"
#include "touch.hpp"

namespace frd {

// ---- HostPanel ----

HostPanel::HostPanel(uint16_t native_w, uint16_t native_h, fr::hal::PixelFormat format)
    : native_w_(native_w), native_h_(native_h), format_(format)
{
}

fr::Status HostPanel::init(fr::Core &core, fr::hal::Rotation rotation)
{
    static_cast<void>(core);
    rotation_ = rotation;
    const size_t bytes = format_ == fr::hal::PixelFormat::rgb565 ? static_cast<size_t>(width()) * height() * 2
                                                                 : static_cast<size_t>((width() + 7) / 8) * height();
    fb_.assign(bytes, 0);
    return {};
}

fr::Status HostPanel::flush(uint16_t x, uint16_t y, uint16_t w, uint16_t h, std::span<const uint8_t> pixels)
{
    const uint16_t W = width();
    const uint16_t H = height();
    if (w == 0 || h == 0 || x + w > W || y + h > H) {
        return std::unexpected(fr::Err::invalid_args);
    }
    ++flushes_;
    if (format_ == fr::hal::PixelFormat::rgb565) {
        const size_t row = static_cast<size_t>(w) * 2;
        if (pixels.size() < row * h) {
            return std::unexpected(fr::Err::invalid_args);
        }
        for (uint16_t r = 0; r < h; ++r) {
            std::memcpy(&fb_[(static_cast<size_t>(y + r) * W + x) * 2], &pixels[r * row], row);
        }
        return {};
    }
    // mono1: the area's rows of ceil(w / 8) bytes, MSB first, into the screen's rows.
    const size_t in_stride = (w + 7u) / 8u;
    const size_t out_stride = (W + 7u) / 8u;
    if (pixels.size() < in_stride * h) {
        return std::unexpected(fr::Err::invalid_args);
    }
    for (uint16_t r = 0; r < h; ++r) {
        for (uint16_t c = 0; c < w; ++c) {
            const bool on = (pixels[r * in_stride + c / 8] >> (7 - c % 8)) & 1;
            uint8_t &byte = fb_[static_cast<size_t>(y + r) * out_stride + (x + c) / 8];
            const auto bit = static_cast<uint8_t>(0x80 >> ((x + c) % 8));
            byte = on ? static_cast<uint8_t>(byte | bit) : static_cast<uint8_t>(byte & ~bit);
        }
    }
    return {};
}

fr::hal::Selftest HostPanel::selftest()
{
    return {};
}

fr::Status HostTouch::init(fr::Core &core, fr::hal::TouchSink &sink)
{
    static_cast<void>(core);
    static_cast<void>(sink);
    return {};
}

fr::hal::Selftest HostTouch::selftest()
{
    return {};
}

// ---- Session ----

namespace {

uint16_t native_w(const Geometry &g)
{
    return fr::hal::swaps_axes(g.rotation) ? g.height : g.width;
}

uint16_t native_h(const Geometry &g)
{
    return fr::hal::swaps_axes(g.rotation) ? g.width : g.height;
}

/** A JSON number that is an integer in [lo, hi]. */
bool json_int(const cJSON *j, double lo, double hi, double &out)
{
    if (!cJSON_IsNumber(j)) {
        return false;
    }
    const double v = j->valuedouble;
    if (v < lo || v > hi || v != static_cast<double>(static_cast<int64_t>(v))) {
        return false;
    }
    out = v;
    return true;
}

}  // namespace

const char *kind_name(fr::cap::DisplayUiEventKind k)
{
    const char *n = fr::cap::to_name(k);
    return n != nullptr ? n : "unknown";
}

Session::Session(const Geometry &g) : geo_(g), panel_(native_w(g), native_h(g), g.format) {}

Session::~Session()
{
    // The services hold the backend; LVGL goes last (LvglBackend's destructor deletes it).
    touch_.reset();
    display_.reset();
    backend_.reset();
}

std::expected<void, std::string> Session::start()
{
    if (geo_.width == 0 || geo_.height == 0) {
        return std::unexpected("the panel needs a width and a height");
    }
    if (geo_.ui && geo_.format != fr::hal::PixelFormat::rgb565) {
        return std::unexpected("--ui 1 needs --format rgb565 (LVGL panels are RGB565)");
    }
    if (!geo_.ui && geo_.format != fr::hal::PixelFormat::mono1) {
        return std::unexpected("--ui 0 needs --format mono1 (the built-in renderer is the 1-bit one)");
    }
    if (geo_.ui) {
        auto b = std::make_unique<fr::ui::LvglBackend>();
        lvgl_ = b.get();
        backend_ = std::move(b);
    } else {
        if (geo_.width > fr::display::MonoBackend::kMaxWidth || geo_.height > fr::display::MonoBackend::kMaxHeight) {
            return std::unexpected("a mono1 panel is at most 128x64");
        }
        backend_ = std::make_unique<fr::display::MonoBackend>();
    }
    fr::cap::DisplayConfig cfg{};
    cfg.rotation = static_cast<fr::cap::DisplayRotation>(geo_.rotation);
    display_ = std::make_unique<fr::DisplayService>(panel_, *backend_, cfg);
    fr::cap::TouchConfig tcfg{};
    tcfg.display = kDisplayPort;
    touch_ = std::make_unique<fr::TouchService>(touch_src_, tcfg);
    display_->bind_touch(*touch_);
    display_->attach(kDisplayPort, "lcd", *this);
    touch_->attach(kTouchPort, "touch", *this);
    if (auto s = display_->init(core_); !s) {
        return std::unexpected(std::string("the display did not start: ") + fr::err_name(s.error()));
    }
    if (auto s = touch_->init(core_); !s) {
        return std::unexpected(std::string("the touch did not start: ") + fr::err_name(s.error()));
    }
    settle();
    return {};
}

std::expected<void, std::string> Session::run_line(std::string_view json, size_t line)
{
    cJSON *root = fr::cap::parse_args_json(json);
    if (root == nullptr) {
        return std::unexpected("line " + std::to_string(line) + ": not JSON");
    }
    struct Free {
        cJSON *p;
        ~Free() { cJSON_Delete(p); }
    } free_root{root};
    const cJSON *cmd = cJSON_GetObjectItemCaseSensitive(root, "cmd");
    const cJSON *args = cJSON_GetObjectItemCaseSensitive(root, "args");
    if (!cJSON_IsObject(root) || !cJSON_IsString(cmd)) {
        return std::unexpected("line " + std::to_string(line) + R"(: expected {"cmd": <command>, "args": {...}})");
    }
    for (const cJSON *it = root->child; it != nullptr; it = it->next) {
        if (std::strcmp(it->string, "cmd") != 0 && std::strcmp(it->string, "args") != 0) {
            return std::unexpected("line " + std::to_string(line) + ": unknown key " + it->string);
        }
    }
    if (args != nullptr && !cJSON_IsObject(args) && !cJSON_IsNull(args)) {
        return std::unexpected("line " + std::to_string(line) + ": args must be an object");
    }
    const std::string name = cmd->valuestring;
    auto refuse = [&](const char *why) {
        return std::unexpected("line " + std::to_string(line) + ": " + name + ": " + why);
    };

    if (name == "touch") {
        const cJSON *pressed = cJSON_GetObjectItemCaseSensitive(args, "pressed");
        if (pressed != nullptr) {
            // A raw pointer point: {x, y, pressed}.
            double x = 0, y = 0;
            if (!cJSON_IsBool(pressed) || !json_int(cJSON_GetObjectItemCaseSensitive(args, "x"), 0, 0xFFFF, x) ||
                !json_int(cJSON_GetObjectItemCaseSensitive(args, "y"), 0, 0xFFFF, y)) {
                return refuse("expected {x: 0..65535, y: 0..65535, pressed: true|false}");
            }
            for (const cJSON *it = args->child; it != nullptr; it = it->next) {
                if (std::strcmp(it->string, "x") != 0 && std::strcmp(it->string, "y") != 0 &&
                    std::strcmp(it->string, "pressed") != 0) {
                    return refuse("a raw touch takes only x, y and pressed");
                }
            }
            touch(static_cast<uint16_t>(x), static_cast<uint16_t>(y), cJSON_IsTrue(pressed));
            settle();
            return {};
        }
        // fr.touch inject: {x, y, gesture?}, through TouchService as on the board.
        uint8_t id = 0;
        uint8_t buf[64];
        fr::wire::Writer w(buf);
        if (auto s = fr::cap::encode_args_json(fr::cap::Touch::kId, "inject", args, &id, w); !s) {
            return refuse("args are not fr.touch inject's {x, y, gesture} (or a raw {x, y, pressed})");
        }
        fr::cap::StaticReply<> reply;
        if (auto s = touch_->dispatch(id, w.bytes(), reply); !s) {
            errors_.push_back({line, name, fr::err_name(s.error())});
        }
        settle();
        return {};
    }

    static constexpr const char *kAllowed[] = {"clear", "text", "fill_rect", "set_brightness", "ui_load", "ui_set"};
    if (std::find_if(std::begin(kAllowed), std::end(kAllowed), [&](const char *a) { return name == a; }) ==
        std::end(kAllowed)) {
        return refuse("unknown command (clear, text, fill_rect, set_brightness, ui_load, ui_set, touch)");
    }
    uint8_t id = 0;
    static uint8_t buf[4096];
    fr::wire::Writer w(buf);
    if (auto s = fr::cap::encode_args_json(fr::cap::Display::kId, name.c_str(), args, &id, w); !s) {
        return refuse("args do not match the command's fields (the generated schema: names, types, ranges)");
    }
    fr::cap::StaticReply<fr::cap::Reply::kBulkCapacity> reply;
    if (auto s = display_->dispatch(id, w.bytes(), reply); !s) {
        errors_.push_back({line, name, fr::err_name(s.error())});
    }
    settle();
    return {};
}

void Session::touch(uint16_t x, uint16_t y, bool pressed)
{
    backend_->touch(x, y, pressed);
    core_.run_ready();
}

void Session::advance(uint32_t ms)
{
    while (ms > 0) {
        const uint32_t step = std::min(ms, kStepMs);
        if (lvgl_ != nullptr) {
            lvgl_->host_advance(step);
        }
        core_.advance_to(core_.now() + static_cast<fr::TimeUs>(step) * 1000);
        ms -= step;
    }
}

void Session::settle(uint32_t max_ms)
{
    core_.run_ready();
    for (uint32_t t = 0; t < max_ms && core_.timers_running(); t += kStepMs) {
        advance(kStepMs);
    }
}

std::expected<fr::display::Snapshot, fr::Err> Session::snapshot()
{
    settle();
    return backend_->snapshot();
}

std::vector<uint8_t> Session::frame()
{
    std::vector<uint8_t> out;
    uint8_t chunk[1024];
    for (uint32_t off = 0;;) {
        auto n = backend_->snapshot_read(off, chunk);
        if (!n || *n == 0) {
            break;
        }
        out.insert(out.end(), chunk, chunk + *n);
        off += static_cast<uint32_t>(*n);
    }
    return out;
}

void Session::event(uint8_t port, uint8_t event_id, fr::cap::Priority prio, std::span<const uint8_t> fields,
                    fr::TimeUs at, bool ordered)
{
    static_cast<void>(prio);
    static_cast<void>(at);
    static_cast<void>(ordered);
    if (port != kDisplayPort || event_id != fr::cap::Display::kEventUi) {
        return;
    }
    if (auto e = fr::cap::decode_display_ui(fields)) {
        events_.push_back({std::string(e->id), e->kind, e->value});
    }
}

void Session::property(uint8_t port, uint8_t prop_id, std::span<const uint8_t> value, fr::TimeUs at)
{
    static_cast<void>(port);
    static_cast<void>(prop_id);
    static_cast<void>(value);
    static_cast<void>(at);
}

}  // namespace frd
