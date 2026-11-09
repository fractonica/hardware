# UNOQ-1: how the Arduino UNO Q fits Fractonica

> **Draft, 2026-11-09.** Asked for: merge qonu into Fractonica. The user chose to move it in first (done: `hosts/uno-q/`, branch `uno-q`) and to decide on the integration from this note. Everything here is a proposal. Anything marked *inferred* was not read in code, in a datasheet or on the bench.

## 0. What is there now

- **The board.** The Arduino UNO Q has two processors:
  - a Qualcomm QRB2210 (4× Cortex-A53, 2 GB RAM of which Linux sees 1.7 GB, 16 GB eMMC, Wi-Fi on a WCN3990);
  - an STM32U585, linked to Linux over a UART at 4 Mbaud with RTS/CTS.

  The board is `uriel` on the bench.
- **qonu** (`hosts/uno-q/`) is built with Buildroot 2026.08.1 in Docker. Its glibc toolchain has C++.
  - **Linux:** Linux 7.3.3, systemd, iwd.
  - **The STM32:** runs Rust/Embassy firmware with protocol v2 (COBS, postcard, CRC-32). Its outputs:
    - the 13×8 LED matrix;
    - the two RGB LEDs (on/off per channel);
    - a 320×172 ST7789 panel on SPI2, double-buffered.

    It also has a heartbeat failsafe that shows "LINK LOST" by itself.
  - **On Linux:**
    - `qonu-link` owns the UART and serves a JSON socket (`/run/qonu/link.sock`);
    - `qonu-dash` draws the vitals screen once a second;
    - `qonu-mcp` gives agents 6 tools over SSH.
- **None of it speaks Fractonica's protocol.** No envelope, no HELLO, no capabilities. The hub doesn't know the board exists.

## 1. Roles the UNO Q could take

| Role | What it means | Main cost |
|---|---|---|
| **A. A device** | The UNO Q joins the fleet like an ESP32 node. Its panel, matrix, LEDs and Linux vitals become `fr.*` capability instances. The Mac hub, CLI, MCP and apps drive them | A protocol runtime on Linux, a non-ESP device class in the hub |
| **B. The hub host** | The hub runs on the UNO Q instead of the Mac, in the Raspberry Pi's place ([08 §8.12](../spec/08-hub.md)) | Node ≥ 24.12, SQLite, Python and esptool in the image; ESP-IDF builds have to stay on the Mac |
| A + B | Both, on one board | Both costs |

A and B don't exclude each other. They also don't depend on each other.

## 2. Role A: the UNO Q as a device

### 2.1 Capabilities

| Hardware | Instance | Capability | Mapping |
|---|---|---|---|
| ST7789 320×172 | `lcd` | `fr.display` 1.2. Traits: width 320, height 172, colour `rgb565`, `ui` false | <ul><li>`clear`, `text` and `fill_rect` become qonu Draw ops (`Clear`, `Text`, `Rect`), then `Present`.</li><li>`set_brightness` is on/off until PB1 gets PWM (TIM3_CH4, *inferred*).</li><li>`ui_load` and `ui_set` answer `UNSUPPORTED`, because there is no LVGL on the STM32. This is the same rule as on the C3 OLED.</li><li>`snapshot` could read the STM32's 110 KB front buffer over the link: about 0.3 s at 4 Mbaud (*calc*).</li></ul> |
| LED matrix 13×8 | `matrix` | `fr.display`. Colour `mono1`, 13×8 | The same primitives, with a 5×7 font as on the C3 OLED. The other choice is a new capability; see Q4 |
| LED3, LED4 | `led3`, `led4` | `fr.led`. Colour `rgb`, `dimmable` false | `set {on, color}` lights each channel at 50 % or more, the rule `fr.display` uses for mono panels. `blink` and `toggle` run on Linux |
| Linux vitals | `host` | **new** `fr.host` (proposed id `0x0011`) | Properties, sent as STATE (LATEST) at 1 Hz: `cpu_pct`, `load1`, `mem_used_mb`, `temp_c` (the hottest zone), `disk_pct`, `wifi_rssi`, `uptime_s`. The hub mirrors them and the dashboard and apps read them. This works for any future Linux host |
| STM32 link | (`diag`) | `fr.diag` counters | Link stats (frames, CRC errors, failsafe trips) as diag `stats` |

**Updated after the spike: draw on Linux, send pixels.** Fractonica's panels draw on the node. `DisplayService` and its backend (`LvglBackend` in `fr_ui`, `MonoBackend` in `fr_core`) keep the framebuffer, and the driver (`hal::Display`) only flushes finished areas. On the UNO Q:
- **The panel (`lcd`):** `LvglBackend` runs on Linux. Its `hal::Display::flush` sends each dirty area to the STM32 as a new qonu op, `Blit {x, y, w, h, rgb565}`, into the back buffer, followed by `Present`.
- **The matrix:** `MonoBackend` at 13×8 flushes as `Matrix` rows.

This replaces the Draw-op mapping in the table above. It makes `lcd` `ui: true`, with layouts and widgets, and its pixels are the ones `display_render` produces, so T-DISPLAY applies as it does for the ESP32 panels.

**The cost:** a full 320×172 frame is 110 KB, about 0.3 s at 4 Mbaud (*calc*). LVGL sends only the areas that changed, so layouts and primitives are fine, but full-screen animation isn't. qonu's Draw ops stay for `qonu-dash`.

The `qonu-dash` screen stays as the default screen while no hub session is up. When the hub or an app draws on `lcd`, the dashboard stops drawing (*proposed*: the first `fr.display` command takes the panel, and a `release` or a session loss gives it back).

### 2.2 Who speaks the protocol

A Linux daemon, `qonu-node`, holds the hub session and calls `qonu-link` for the hardware. There are two ways to build it:

| | A1. Rust | A2. Fractonica's C++ core on Linux |
|---|---|---|
| What | A new Rust daemon beside `qonu-link` with: <ul><li>the envelope and hub link ([05 §5.12.1–2](../spec/05-network.md): TCP `len u16 \| envelope` plus UDP to :7421);</li><li>HELLO/WELCOME, TIME answers, `describe`, `get_state`, CMD/RESULT, STATE, HEARTBEAT and PRESENCE</li></ul> | Build `firmware/components/fr_net/src/core` and the generated `fr_caps` dispatch for aarch64 Linux. Add a POSIX hub link in place of `src/esp/hub_link.cpp` and `wifi_sta`, and backends that call `qonu-link` |
| Codecs | A new Rust backend for `fr gen`, held to the golden vectors (`schema/vectors/`) and to fuzz-digest parity like C++ and TS ([10 §10.4](../spec/10-testing.md)) | The existing generated C++, already gated by T-CODEC |
| Fits | qonu's Rust-end-to-end choice | P2/P3 ([02 §2.2](../spec/02-architecture.md)): one runtime per protocol, nothing to keep in step |
| Risk | A third runtime to keep byte-identical; most of the work is codegen | How much of the core assumes IDF or FreeRTOS. The host suite and `fr_fleet` already build it on the Mac with shims (`firmware/test/host/shim`), but the Linux path is untested ([11](../spec/11-roadmap.md) open items) |

**Proposed: A2, after a half-day spike.** The spike builds the host suite and `fr_net` core in the qonu builder (Debian trixie, arm64), which also closes the "Linux: untested" item in 11. If the core needs more than a POSIX link and a timer shim, fall back to A1.

**Spike result (2026-11-09): A2.** The core needs nothing beyond POSIX. `firmware/test/host` already has POSIX TCP and UDP links, a host `Core` and `fr.node` (`tools/net_node.cpp`, `sim/`), and the core ran unchanged on the board.

**The build.** The whole host suite builds with GCC 14.2 on aarch64 Linux with no source change:
- what it covers: `fr_proto`, `fr_caps`, the `fr_core` services, the `fr_net` and `fr_ota` cores, `fr_gw` and the T2 kit;
- how: Debug, `-Wall -Wextra -Werror`, ASan and UBSan.

**The suite: 974 of 975 tests pass on Linux.**
- `camera_service_set_during_a_both_stream` fails on Linux and passes on the Mac.
- `camera_service_set_between_grabs_and_a_stream_s_own_settings` failed in one of two Linux runs.
- T2-SCALE matches the Mac to the digit: 30 nodes, 5.489 transmissions per broadcast.

**On the board.** A release `fr_net_node` (1.8 MB stripped, linked only to libc and libm, libstdc++ static) ran on the UNO Q against a private hub on the Mac. That hub had its own `FR_HOME`, ports 7520–7522, `--no-serial` and `--no-advert`; the lab hub wasn't touched. Over the USB link:

| Check | Result |
|---|---|
| Handshake and TIME sync | 8 samples, ±345 µs |
| `fr send uriel status.blink` | `ok` in 3 ms, then `status.effect_done` |
| `fr input uriel boot click` | `boot.down`, `boot.up`, `boot.click` |
| Input → hub | p50 0.73 ms |
| TCP ping | p50 0.72 ms |

**Finding the hub:** systemd-resolved on the board already resolves `dimas-3.local` and the `_fractonica._tcp` advert.

**Lesson.** A restart with the same epoch has its frames dropped as duplicates (the router's `dup` counter). `qonu-node` must persist the epoch and raise it before its first transmit, as §2.3 says.

**Framework findings from the Linux build** (to fix in Fractonica, apart from the UNO Q work):
1. **A null pointer in `memcpy`.** `fr_caps/gen/diag_json.cpp` `json_string` calls `memcpy(tmp, s.data(), 0)` with a null `data()` for an empty string. That is undefined behaviour. glibc declares the argument non-null, so GCC's UBSan stops on it; macOS's libc doesn't. Fix it in the codegen template: skip the copy when the string is empty.
2. **A false warning that breaks release builds.** `fr_net/src/core/bench.cpp:83`: `std::sort` over a 4-element `std::array` sets off GCC 14's `-Warray-bounds` at `-O2`, a known false positive below `std::sort`'s 16-element insertion threshold. With `-Werror` that fails release builds, not Debug. Fix: an insertion loop, or a local pragma.
3. **LeakSanitizer fails the Linux run.** It is on by default on Linux, and `host-test.mjs` turns it off only on macOS. It finds 59 allocations (2,944 B), all left by tests: audio `Rt::mutex_create` and `signal_create` (host), `AudioInService::init` and `CameraService::init`. Linux runs fail at exit until they are freed, or until `detect_leaks=0` applies on Linux too.
4. **The camera test above:** a timing or ordering difference in `CameraService` under GCC on Linux, not yet investigated. It isn't on the UNO Q's path.

### 2.3 Identity and provisioning

- **`device_id`:** wlan0's MAC. To check: it must be stable across boots and reflashes. It comes from the board's calibration data (*inferred*).
- **`epoch`:** a u16 boot counter in `/data/fractonica/`, committed before the first transmit ([05 §5.5](../spec/05-network.md)). `/data` survives image reflashes.
- **`addr` and alias:**
  - **Today:** ESP32 nodes get these at flash time in `fr_ident` ([06 §6.3](../spec/06-identity-ota.md)).
  - **The UNO Q:** it HELLOs as UNASSIGNED (`0xFFFE`), the hub creates its `provisioned: false` row, and a hub op provisions it over the session into `/data/fractonica/ident`.
  - **This is a hub change:** provisioning without a serial flash.
- **Finding the hub:** the same order as [05 §5.12.5](../spec/05-network.md), with the mDNS lookups done by systemd-resolved.

### 2.4 What doesn't apply

- **OTA:** `fr.ota` is ESP-partition based. On this device it answers `UNSUPPORTED`, and `deploy` and `flash` refuse it. Images stay `make flash` and `make mcu-flash` in `hosts/uno-q`.
- **ESP-NOW:** the UNO Q has no ESP-NOW radio. It is a hub-link-only node, so node → node bindings reach it through the hub's forwarding ([08 §8.4](../spec/08-hub.md) Routing).
- **Board manifest:** `hardware/boards/*.board.yaml` describes ESP32 pins. The UNO Q gets a minimal entry (`arduino-uno-q`, `kind: linux`, *proposed*) so the registry and dashboard can name it. It has no profile build.

### 2.5 Work order (if A2)

1. **Spike:** host suite plus `fr_net` core on aarch64 Linux. **Done 2026-11-09** (§2.2).
2. **A production POSIX runtime.** **Built 2026-11-09:** `firmware/components/fr_posix` (written alongside the test kit; moving `fr_net_node` and the fleet kit onto it is still to do). Move these out of the test kit into a component, `fr_posix` (*proposed*), without the stdin command channel and the fakes:
   - from `tools/net_node.cpp`: `HostCore`, `TcpLink`, `UdpLink`;
   - from `sim/`: `Device` and `NodeDiag`.

   The fleet kit and `fr_net_node` then build on it too.
3. **`qonu-node`:** **Started 2026-11-09:** `hosts/uno-q/node` runs `node`, `led3` and `matrix`. Since 2026-11-09 it is a Buildroot package and a systemd service (`make node-push`, `qonu-node set-hub`), online on the lab hub; `lcd` is next.
   - `fr_posix` with identity and epoch in `/data/fractonica/`;
   - `fr.node`, `fr.diag`;
   - `lcd` (`LvglBackend` with a `Blit` flush) and `matrix` (`MonoBackend`);
   - `led3`, `led4` (`hal::LightOutput` through `qonu-link`).

   On the qonu side: the `Blit` op in protocol v3, the firmware and the daemon. `qonu-node` ships as a Buildroot package (CMake, with LVGL 9.6.0 pinned as in `tools/display`) next to `qonu-link`.
4. **`fr.host`:** the capability YAML, then `fr gen`, then the backend that reads `/proc` and `/sys`. The code that reads the vitals moves out of `qonu-dash`.
5. **Hub:**
   - the non-ESP device class (no probe, flash or OTA);
   - provisioning over the session;
   - the board entry.
6. **Gate T-UNOQ:**
   - handshake and describe;
   - `fr display` primitives on both panels, compared with `display_render` where the renderer supports the panel;
   - the vitals stream;
   - the hub going away, which brings `qonu-dash` back;
   - Linux going away, which brings up the STM32's LINK LOST.
7. **Docs:** the manual section, a plugin skill `uno-q`, and a wiring guide for the panel (`hardware/wiring/uno-q-lcd`).

## 3. Role B: the UNO Q as the hub host

- **Runtime:**
  - **Node:** Buildroot 2026.08.1 ships Node **22.23.2** (`nodejs`, `nodejs-bin`), and the hub needs ≥ 24.12 ([08 §8.1](../spec/08-hub.md)). That means a version bump in our external tree, or the official linux-arm64 tarball (the toolchain is glibc, which it needs).
  - **Native addons:** `serialport` has linux-arm64 prebuilds (08 §8.1). `better-sqlite3` prebuilds for linux-arm64 glibc are *inferred*.
  - **Flashing:** the pytools sidecar needs Python 3.12 and esptool 5.6 in the image.
- **Builds stay on the Mac.** ESP-IDF builds on 4× A53 with 2 GB are not practical (*inferred*; Mac builds already take 10–20 min under load). The hub would take artifacts built elsewhere, which changes [08 §8.6](../spec/08-hub.md): today every build names a `source_dir` on the hub's own machine.
- **USB:** ESP boards on the UNO Q's single USB-C port need a powered USB-C hub in host mode (*inferred*: Arduino documents dongle use).
- **Gains:**
  - The hub is off the Mac, so there is no Local Network Privacy.
  - There are no event-loop stalls from Mac load (up to 1.1 s seen; [11](../spec/11-roadmap.md) M1 notes).
  - The hub is always on, and the panel can show hub status.
- **Costs:**
  - The rootfs grows by about 100 MB or more (*inferred*), against qonu's "as light as possible" goal.
  - Packaging the hub (08 §8.12 "Later") becomes a prerequisite.

## 4. Recommendation

Do **A first**, by the A2 route after the spike. It uses hardware that already works and is verified. The hub already has a place for foreign firmware: when no manifest names the firmware, its descriptor is the only description ([07 §7.4](../spec/07-capabilities-sdk.md)). It also gives every agent and app the UNO Q through one API.

Revisit **B** once the hub has a packaged build (08 §8.12). A also leaves B's path open: a UNO Q that is already a device can later host the hub too.

## 5. Questions for you

1. **Role:** A first (proposed), B first, or both now? **Answered 2026-11-09: A, a fleet device.**
2. **Runtime for A:** the C++ core after a spike (proposed), or Rust with a new `fr gen` backend? **Settled by the spike, 2026-11-09: A2, the C++ core** (§2.2).
3. **Agents:** with A, the hub's MCP (`fr mcp`) can drive the UNO Q like any device. Should `qonu-mcp` stay as a direct path that works without the hub, or be retired?
4. **The LED matrix:** an `fr.display` (mono1, 13×8; proposed), or a new matrix capability with frames and animations as in `qonu-mcp`?
5. **Name:** keep "qonu" for the image and its daemons, or rename into the `fr` namespace?
