# tools/display: the desktop renderer

Design m2-c5-display D5, D6. `fr_display_render` draws a script of `fr.display` commands for one panel, as the board
would, and writes a PNG plus one JSON line. It is the board's own display stack built for the Mac:

- fr_core's `DisplayService` and `TouchService`, and the generated dispatch and JSON args codec of fr_caps;
- fr_ui's `LvglBackend` (ui panels) over the same LVGL release and `lv_conf.h` as the firmware, or fr_core's
  `MonoBackend` (mono1 panels: the C3 OLED);
- a host panel that keeps every flush, and a virtual clock (core timers and LVGL's tick move together, 5 ms steps).

Users of the contract: the hub op `display_render` (packages/hub/src/display/render.ts, also `fr display render`),
and `fr display window` (packages/cli/src/display.ts: the same binary with `--window`, no hub).

## Building

```
node tools/display-build.mjs            # configure + build build/host-display/fr_display_render
node tools/display-build.mjs --test     # also build and run fr_display_tests (a filter may follow)
```

The first configure downloads LVGL `v9.6.0` from GitHub (SHA256 pinned in CMakeLists.txt) into `build/_deps`; the
firmware gets the same release from the IDF component registry (`lvgl/lvgl ==9.6.0~1`, fr_ui/idf_component.yml; the
registry's `~1` differs from the tag only in its manifest and an ESP-IDF < 6 fallback for the P4's PPA). Keep both
pins in step. The build script touches the binary when it succeeds, so "a source file newer than the binary" (the
staleness rule its callers use) settles even when nothing needed relinking. The renderer is built from tools/display,
fr_ui, fr_core, fr_caps and fr_proto. Optional: Homebrew SDL2 (`pkg-config sdl2`) for `--window`.

## Command line (stable)

```
fr_display_render --width W --height H --format rgb565|mono1 --rotation 0..3 --ui 0|1
                  --script <file.jsonl | -> --out <file.png> [--window [--scale N]]
```

| option | meaning |
| --- | --- |
| `--width`, `--height` | pixels after rotation (the profile's `kPanels` entry, the fr.display traits), 1..4096 |
| `--format` | `rgb565` or `mono1` (trait color) |
| `--rotation` | quarter turns (`kPanels` rotation); the native panel is H x W for 1 and 3 |
| `--ui` | `1`: LVGL (needs rgb565); `0`: the 1-bit renderer (needs mono1, at most 128x64) |
| `--script` | JSON lines, `-` for stdin; blank lines are skipped |
| `--out` | the PNG to write |
| `--window` | after the script, an SDL2 window: the mouse is the finger; Esc or closing it ends the run |
| `--scale` | window pixels per panel pixel, 1..8 (default 2) |

Script lines are `{"cmd": C, "args": {...}}`:

- `clear`, `text`, `fill_rect`, `set_brightness`, `ui_load`, `ui_set`: `args` are exactly the generated command's
  fields (schema/capabilities/display.cap.yaml): enums by member name, colours as numbers `0xRRGGBB` (JSON has no hex:
  `16711680`), `ui_load` as `{"layout": {"bg": .., "widgets": [{"id", "kind", "x", "y", "w", "h", "text", "value",
  "min", "max", "color", "bg", "font", "align"}]}}`. They are encoded by the generated JSON codec and dispatched by
  the generated `fr.display` dispatch, as on the board.
- `touch` `{"x", "y", "pressed": true|false}`: a raw point into the panel's pointer input (press, move, release).
- `touch` `{"x", "y"[, "gesture"]}`: `fr.touch` inject (tap by default) through `TouchService`, with its timing (a tap
  is down, then up 50 ms later).

`snapshot` and `snapshot_read` are not script commands: the renderer takes the snapshot itself at the end.

**stdout**: the last line is exactly one JSON object.

```
{"crc": u32, "width": W, "height": H, "format": "rgb565"|"mono1", "bytes": n, "png": "<absolute path>",
 "events": [{"id", "kind": "clicked"|"pressed"|"released"|"value_changed", "value"}, ...],
 "errors": [{"line", "cmd", "error"}, ...],
 "lvgl_heap": {"total", "used", "max_used"}}
```

`errors` lists the commands the board would refuse (`busy`, `not_found`, `unsupported`); the render goes on, as the
board would. `lvgl_heap` (ui panels only) is LVGL's pool after the script, with the Mac's 64-bit pointers. With
`--window`, each ui event also prints as `{"event": {"id", "kind", "value"}}` as it happens, before the result line.

On failure the last line is `{"error": {"code", "message"}}` and the exit status says which:

| exit | code | when |
| --- | --- | --- |
| 0 | | rendered |
| 64 | `INVALID_ARGS` | bad options, or a geometry/format/ui combination no backend draws |
| 65 | `SCRIPT` | a line that is not a command: not JSON, an unknown cmd, args the codec refuses (message names the line) |
| 69 | `UNAVAILABLE` | `--window` without SDL2, or SDL cannot open a window |
| 73 | `IO` | the script cannot be read or the PNG written |
| 70 | `INTERNAL` | anything else |

**crc** is CRC-32/ISO-HDLC (zlib's) of the framebuffer as fr_core's `fr/display/backend.hpp` lays it out (rgb565:
row-major little-endian u16; mono1: rows of ceil(W/8) bytes, MSB first, lit = 1): the same number the board's
`fr.display snapshot` reports for the same commands.

**PNG**: the hub's encoding (packages/hub/src/display/png.ts): rgb565 as 8-bit RGB (colour type 2), each channel
widened by repeating its top bits (`r<<3|r>>2`, `g<<2|g>>4`, `b<<3|b>>2`); mono1 as 1-bit greyscale (colour type 0)
whose rows are the framebuffer's rows, lit = white; filter 0 on every row; one IDAT deflated at level 9; IEND. The
renderer deflates with the macOS SDK's zlib and the hub with Node's, so the two files hold the same pixels but their
compressed bytes may differ: compare CRCs, or decoded pixels, not PNG files.

## Determinism

The pixels depend only on the LVGL version, fr_ui's `config/lv_conf.h` (one file for both builds) and fr_ui's code.
`LV_KCONFIG_IGNORE` alone does not keep menuconfig out on IDF 6.1: picolibc's `<stdint.h>` includes `sdkconfig.h`, and
`lv_conf_internal.h` then takes `CONFIG_LV_*` for every option `lv_conf.h` leaves unset, on the board only. So
`lv_conf.h` sets each such option to LVGL's default, and a check compares the two builds:

```
node tools/display/lv-conf-check.mjs [--board-build build/idf-<x>/s3t-pad-debug]
```

It preprocesses LVGL's `lv_obj.c` with the board build's own compile command (its `compile_commands.json`) and with
this project's flags, expands every `LV_*` option on both sides, and lists those whose values differ or that the
board still takes from `CONFIG_LV_*` (exit 1). The pool's size and place, the pointer width and printf formats are
expected to differ and are skipped. Run it after an LVGL upgrade or a change to `lv_conf.h`. The config keeps the renderer on integer code paths: no
`LV_USE_FLOAT`, matrix or vector graphics, no assembly blending (`LV_DRAW_SW_ASM_NONE`), one draw unit and no OS
layer, the default theme pinned (light, blue/red, no transitions, no grow-on-press), no animations or scrolling on
any object. The board renders in partial bands of 1/10 screen and so does the Mac, with the same buffers. What still
differs: the board renders as commands arrive and the Mac renders at the snapshot (the final frame is the same:
every invalidated area is redrawn from the final object tree); LVGL's pool is 64 KB in PSRAM on the board and
128 KB static on the Mac (where it lives changes no pixel unless it runs out); compiled by GCC for Xtensa vs clang
for arm64. T-DISPLAY 2 is where the parity is proven on the boards.
