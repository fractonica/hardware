// fr_display_render: the desktop renderer (design m2-c5-display D6). Draws a script of fr.display commands for one
// panel with the firmware's own display stack (session.hpp) and writes a PNG plus one JSON line.
//
// The contract (stable: the hub op display_render, also `fr display render`, and `fr display window` run it;
// tools/display/README.md):
//
//   fr_display_render --width W --height H --format rgb565|mono1 --rotation 0..3 --ui 0|1
//                     --script <file.jsonl | -> --out <file.png> [--window [--scale N]]
//
//   W, H      the panel's pixels after rotation (the profile's kPanels entry / fr.display traits), 1..4096.
//   rotation  quarter turns (kPanels' rotation); the panel's native size is H x W for 1 and 3.
//   ui        1: LVGL (fr_ui's LvglBackend; needs rgb565); 0: the 1-bit renderer (fr_core's MonoBackend; mono1).
//   script    JSON lines, `-` for stdin; blank lines are skipped. Each line {"cmd": C, "args": {...}}:
//               C = clear | text | fill_rect | set_brightness | ui_load | ui_set: args are exactly the generated
//                   fr.display command's fields (schema/capabilities/display.cap.yaml; enums by member name, colours
//                   as numbers 0xRRGGBB, ui_load's {"layout": {"bg": .., "widgets": [{"id", "kind", ...}]}}), checked
//                   by the generated JSON codec and dispatched as the board dispatches them;
//               C = touch: {"x", "y", "pressed": bool} is a raw pointer point into the panel's input (press, move,
//                   release), {"x", "y"[, "gesture"]} is fr.touch inject (tap by default) through TouchService.
//   out       the PNG: the frozen frame (snapshot + snapshot_read), encoded as the hub encodes a board's snapshot.
//   window    after the script, an SDL2 window (Homebrew SDL2) where the mouse is the finger; ui events print live as
//             {"event": {"id", "kind", "value"}} lines; closing it (or Esc) writes the PNG of the last frame.
//
// stdout, last line, exactly one JSON object:
//   success: {"crc": u32, "width": W, "height": H, "format": "rgb565"|"mono1", "bytes": n, "png": "<absolute path>",
//             "events": [{"id", "kind": "clicked|pressed|released|value_changed", "value"}...],
//             "errors": [{"line", "cmd", "error"}...]   (commands the board would refuse: busy, not_found...),
//             "lvgl_heap": {"total", "used", "max_used"}  (ui panels: LVGL's pool after the script)}
//   failure: {"error": {"code": "INVALID_ARGS|SCRIPT|UNAVAILABLE|IO|INTERNAL", "message": "..."}}
// Exit status: 0 success; 64 bad options; 65 a script line that is not a command (not JSON, unknown cmd, args the codec
// refuses); 69 --window without SDL2; 73 the PNG cannot be written; 70 anything else. Device-side refusals are not
// failures: they are listed in "errors" and the render goes on. crc is CRC-32/ISO-HDLC of the framebuffer as
// fr/display/backend.hpp lays it out, equal to the board's fr.display snapshot crc for the same commands.
#include <cJSON.h>
#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <string_view>

#include "fr/ui/lvgl_backend.hpp"
#include "png.hpp"
#include "session.hpp"
#include "window.hpp"

namespace {

constexpr int kExitUsage = 64;
constexpr int kExitScript = 65;
constexpr int kExitUnavailable = 69;
constexpr int kExitInternal = 70;
constexpr int kExitIo = 73;

int fail(int status, const char *code, const std::string &message)
{
    cJSON *o = cJSON_CreateObject();
    cJSON *e = cJSON_AddObjectToObject(o, "error");
    cJSON_AddStringToObject(e, "code", code);
    cJSON_AddStringToObject(e, "message", message.c_str());
    char *text = cJSON_PrintUnformatted(o);
    std::printf("%s\n", text);
    cJSON_free(text);
    cJSON_Delete(o);
    return status;
}

bool parse_uint(const char *s, unsigned long lo, unsigned long hi, unsigned long &out)
{
    char *end = nullptr;
    const unsigned long v = std::strtoul(s, &end, 10);
    if (s[0] == '\0' || s[0] == '-' || *end != '\0' || v < lo || v > hi) {
        return false;
    }
    out = v;
    return true;
}

}  // namespace

int main(int argc, char **argv)
{
    frd::Geometry geo;
    std::string script;
    std::string out;
    bool window = false;
    unsigned long scale = 2;
    bool have[6] = {};  // width height format rotation ui script/out
    const char *usage =
        "usage: fr_display_render --width W --height H --format rgb565|mono1 --rotation 0..3 --ui 0|1 "
        "--script <file.jsonl|-> --out <file.png> [--window [--scale N]]";
    for (int i = 1; i < argc; ++i) {
        const std::string_view a = argv[i];
        if (a == "--window") {
            window = true;
            continue;
        }
        if (i + 1 >= argc) {
            return fail(kExitUsage, "INVALID_ARGS", std::string(a) + " needs a value; " + usage);
        }
        const char *v = argv[++i];
        unsigned long n = 0;
        if (a == "--width" || a == "--height") {
            if (!parse_uint(v, 1, 4096, n)) {
                return fail(kExitUsage, "INVALID_ARGS", std::string(a) + " must be 1..4096");
            }
            (a == "--width" ? geo.width : geo.height) = static_cast<uint16_t>(n);
            have[a == "--width" ? 0 : 1] = true;
        } else if (a == "--format") {
            if (std::strcmp(v, "rgb565") == 0) {
                geo.format = fr::hal::PixelFormat::rgb565;
            } else if (std::strcmp(v, "mono1") == 0) {
                geo.format = fr::hal::PixelFormat::mono1;
            } else {
                return fail(kExitUsage, "INVALID_ARGS", "--format must be rgb565 or mono1");
            }
            have[2] = true;
        } else if (a == "--rotation") {
            if (!parse_uint(v, 0, 3, n)) {
                return fail(kExitUsage, "INVALID_ARGS", "--rotation must be 0..3 (quarter turns)");
            }
            geo.rotation = static_cast<fr::hal::Rotation>(n);
            have[3] = true;
        } else if (a == "--ui") {
            if (!parse_uint(v, 0, 1, n)) {
                return fail(kExitUsage, "INVALID_ARGS", "--ui must be 0 or 1");
            }
            geo.ui = n == 1;
            have[4] = true;
        } else if (a == "--script") {
            script = v;
        } else if (a == "--out") {
            out = v;
        } else if (a == "--scale") {
            if (!parse_uint(v, 1, 8, scale)) {
                return fail(kExitUsage, "INVALID_ARGS", "--scale must be 1..8");
            }
        } else {
            return fail(kExitUsage, "INVALID_ARGS", "unknown option " + std::string(a) + "; " + usage);
        }
    }
    have[5] = !script.empty() && !out.empty();
    for (bool h : have) {
        if (!h) {
            return fail(kExitUsage, "INVALID_ARGS", usage);
        }
    }

    std::string text;
    if (script == "-") {
        std::ostringstream ss;
        ss << std::cin.rdbuf();
        text = ss.str();
    } else {
        std::ifstream f(script, std::ios::binary);
        if (!f) {
            return fail(kExitIo, "IO", "cannot read the script " + script);
        }
        std::ostringstream ss;
        ss << f.rdbuf();
        text = ss.str();
    }

    frd::Session s(geo);
    if (auto st = s.start(); !st) {
        return fail(kExitUsage, "INVALID_ARGS", st.error());
    }
    size_t lineno = 0;
    for (size_t pos = 0; pos <= text.size();) {
        size_t nl = text.find('\n', pos);
        if (nl == std::string::npos) {
            nl = text.size();
        }
        std::string_view line(text.data() + pos, nl - pos);
        ++lineno;
        pos = nl + 1;
        if (!line.empty() && line.back() == '\r') {
            line.remove_suffix(1);
        }
        if (line.find_first_not_of(" \t") == std::string_view::npos) {
            continue;
        }
        if (auto r = s.run_line(line, lineno); !r) {
            return fail(kExitScript, "SCRIPT", r.error());
        }
    }

    if (window) {
        std::string why;
        if (int r = frd::run_window(s, static_cast<int>(scale), why); r != 0) {
            return fail(kExitUnavailable, "UNAVAILABLE", why);
        }
    }

    const auto snap = s.snapshot();
    if (!snap) {
        return fail(kExitInternal, "INTERNAL", std::string("snapshot failed: ") + fr::err_name(snap.error()));
    }
    const std::vector<uint8_t> fb = s.frame();
    if (fb.size() != snap->bytes) {
        return fail(kExitInternal, "INTERNAL", "snapshot_read returned " + std::to_string(fb.size()) + " of " +
                                                   std::to_string(snap->bytes) + " bytes");
    }
    std::error_code ec;
    const std::filesystem::path png = std::filesystem::absolute(out, ec);
    if (ec || !frd::write_png(png.string(), fb, snap->width, snap->height, geo.format)) {
        return fail(kExitIo, "IO", "cannot write the PNG " + out + ": " + std::strerror(errno));
    }

    cJSON *o = cJSON_CreateObject();
    cJSON_AddNumberToObject(o, "crc", snap->crc);
    cJSON_AddNumberToObject(o, "width", snap->width);
    cJSON_AddNumberToObject(o, "height", snap->height);
    cJSON_AddStringToObject(o, "format", geo.format == fr::hal::PixelFormat::rgb565 ? "rgb565" : "mono1");
    cJSON_AddNumberToObject(o, "bytes", snap->bytes);
    cJSON_AddStringToObject(o, "png", png.string().c_str());
    cJSON *events = cJSON_AddArrayToObject(o, "events");
    for (const frd::UiEvent &e : s.events()) {
        cJSON *j = cJSON_CreateObject();
        cJSON_AddStringToObject(j, "id", e.id.c_str());
        cJSON_AddStringToObject(j, "kind", frd::kind_name(e.kind));
        cJSON_AddNumberToObject(j, "value", e.value);
        cJSON_AddItemToArray(events, j);
    }
    cJSON *errors = cJSON_AddArrayToObject(o, "errors");
    for (const frd::LineError &e : s.errors()) {
        cJSON *j = cJSON_CreateObject();
        cJSON_AddNumberToObject(j, "line", static_cast<double>(e.line));
        cJSON_AddStringToObject(j, "cmd", e.cmd.c_str());
        cJSON_AddStringToObject(j, "error", e.error.c_str());
        cJSON_AddItemToArray(errors, j);
    }
    if (fr::ui::LvglBackend *l = s.lvgl()) {
        const fr::ui::HeapStats h = l->heap();
        cJSON *j = cJSON_AddObjectToObject(o, "lvgl_heap");
        cJSON_AddNumberToObject(j, "total", h.total);
        cJSON_AddNumberToObject(j, "used", h.used);
        cJSON_AddNumberToObject(j, "max_used", h.max_used);
    }
    char *json = cJSON_PrintUnformatted(o);
    std::printf("%s\n", json);
    cJSON_free(json);
    cJSON_Delete(o);
    return 0;
}
