# UNOQ-2: the UNO Q as the always-on home for services, websites and devices

> **Draft, 2026-11-09.** Asked for: "ability to deploy and run background services there (for example a Telegram bot) and also host websites. It should be connected to the hub, so other Fractonica devices could be connected to it. For example, I should be able to connect a device with a camera that records a timelapse, and access the frames via a web API." The display gets three default pages (system stats, services, external control by QR code), switched by a button. It builds on UNOQ-1 ([uno-q-host.md](uno-q-host.md)), where the UNO Q became a fleet device (`qonu-node`). Anything marked *inferred* was not checked on the bench.

## 1. Decisions (yours, 2026-11-09)

| # | Question | Answer |
|---|---|---|
| 1 | Where the hub runs | **On the UNO Q**: always on. Devices, services and websites keep working while the Mac sleeps |
| 2 | Runtimes for services | **Node.js only**. It matches the hub and `@fractonica/sdk`, so a service talks to devices through the typed SDK |
| 3 | How to deploy | **One `fr` command**: `fr app deploy ./my-bot` from the Mac |

**Proposed (not yet asked): two hubs, two networks.**
- **The Mac keeps its lab hub** for building, USB flashing, the HIL fixture and the gateway. All of those need the Mac's USB ports and ESP-IDF.
- **The UNO Q runs the home hub** on its own network id.
- A device is moved from one to the other by provisioning it for the other hub. Both hubs speak the same protocol, so nothing in the firmware changes.

## 2. Pieces

| Piece | Where | What it does | Status |
|---|---|---|---|
| Front-panel buttons | STM32: confirm D2 (PB3), up D3 (PB0), down D4 (PA12), each to GND with the internal pull-up, polled every 5 ms → protocol v3 `Event::Button` → `qonu-link` `subscribe` | A level counts after 20 ms. Any client can subscribe to MCU events (`qonu-link events`); `qonu-link press` acts as a press. Polled, not on EXTI. (An EXTI line on PA12 once seemed to make the MCU answer late; the likelier cause was the link receiver bug in §4, which a flash alone sets off) | **built**. The user wired all three and tried them by hand |
| Pages | `qonu-dash` | **SYSTEM** (vitals), **SERVICES** (the `qonu-*`, `fractonica-*` and `fr-app-*` units: state and memory), **CONTROL** (the terminal QR code), **WI-FI**. Up and down (or S1-S4 on the LED&KEY) move between pages. In SERVICES, confirm selects a service and opens its menu: Logs (scrolling, following new lines), Restart, Stop (asks first) or Start, Remove for apps (asks first; `fr app rm`, data kept), Back. There is no Stop for `qonu-dash` or `qonu-link`. Confirm on CONTROL gives a new code | **built**. Tried with injected presses: restarting `qonu-web`, the logs view, a new code, and removing a throwaway app |
| LED&KEY module | A TM1638 (8 seven-segment digits, 8 LEDs, keys S1-S8) on D12 STB (PB14), D7 CLK (PB2), D5 DIO (PA11), bit-banged by the STM32: protocol v4 `Panel{digits, leds, level}`, `PanelStatus`, keys as `Event::Button` ids 8-15, `Event::Panel{present}` | `qonu-dash` shows the time and the CPU load on it, and uses it as the keyboard for Wi-Fi passwords. The daemon's `panel` takes text (its 7-segment font) or raw segments; `screen` returns what the display, the LED&KEY and the matrix show, for tests and agents | **built**, and confirmed by hand 2026-11-09: digits, LEDs and keys work |
| Wi-Fi from the panel | `qonu-dash` WI-FI page, iwd over D-Bus (`busctl`) | Scan, list (signal, saved, connected), join, new password, forget. Passwords are typed phone style on the LED&KEY (abc / ABC / 123, 1.2 s to keep a letter), written to iwd's profile (0600) and never logged; a refused password puts the profile back, and iwd returns to its network | **built**. Scan and typing tried with injected presses; one join with a wrong password (by accident, see §4) showed the rollback |
| Time zone | `local/timezone` (the Mac's zone, from `setup-local.sh`) → `/etc/localtime` at build; `timedatectl set-timezone` on the board | The panel's clock was UTC. `qonu-dash` calls `tzset`, so a change shows without a restart; apps without `TZ` follow the board | **built**; the board is on Europe/Moscow |
| `Bitmap` draw op | protocol v3, firmware, daemon | A 1-bit image at 1–5× scale: a QR code is one op of about 110 B | **built** |
| Phone terminal | `qonu-web` on port 80 | `/t/<token>` is a one-time link, shown only on the panel as a QR code. It is replaced after each use and every 10 minutes, and opens a 12-hour session cookie. `/term` serves xterm.js with a phone key row (Esc, Tab, Ctrl, arrows, ^C). `/term/ws` bridges a WebSocket to a login shell on a PTY | **built**, tested over the USB link: one use per link, a reused link gets 403 |
| Node.js 24 | the image (`/usr/bin/node`, npm) | The runtime for the hub and the apps. Buildroot ships Node 22.23.2 and the hub needs ≥ 24.12, so this is the official linux-arm64 binary of the Mac's version (24.22.0) as a package | **built** (package `node-official`, hash from nodejs.org's SHASUMS256): 118 MB node + 19 MB npm |
| The hub | `/data/fractonica/hub` (code) and `/data/fractonica/home` (`FR_HOME`), `fractonica-hub.service` | The Fractonica hub as on the Mac: run from a staged checkout with the linux-arm64 `node_modules`, `--no-serial --no-advert`. Its **API is on port 7520**, not 7420, so `make hub-tunnel` can forward it to the Mac next to the lab hub: the hub checks the `Host` header against its own port, and a 7520→7420 forward is refused with 421. `qonu-node` connects to it over loopback, and `/usr/bin/fr` on the board points at it | **built** 2026-11-09: `make hub-push` stages 79 MB (70 MB `node_modules`) and swaps it into `/data` whole. The hub uses about 215 MB of RSS. The UNO Q is online on it, and `matrix.text` through the tunnel answers in 1 ms |
| Apps | hub ops `app_upload`, `app_deploy` (job `app`), `app_list`, `app_logs`, `app_env`, `app_restart`, `app_stop`, `app_start`, `app_remove` (`packages/protocol/src/ops/app-host.ts`, `packages/hub/src/app-host/`); `fr app deploy <dir>` (hand-written: packs the folder as plain ustar.gz, sends 512 KB base64 chunks, starts the job); one systemd unit `fr-app-<name>.service` each | A manifest, `fractonica.app.json` ([apps/README.md](../../apps/README.md)). Releases live under `FR_HOME/apps/<name>/releases` with a `current` symlink. `npm ci --omit=dev`; `@fractonica/sdk` is linked from the hub's checkout. A unit with `ProtectSystem=strict`, writable `DATA_DIR`, and the env file `FR_HUB_URL`, `FR_APP_TOKEN`, `PORT` plus the settings (0600). A failed check rolls back to the previous release. After a reflash, the hub's start rewrites the units. `apps.json` feeds `qonu-web`'s landing page | **built** 2026-11-09. Deployed from the Mac through the tunnel: `hello-web` (active, port 8100, its API lists the board's devices through the SDK) and `matrix-clock` (it drives the UNO Q's matrix through the hub; `fr app env … TZ=` restarts it with the setting). A hub test covers it with systemd faked; REGISTRY_HASH `c930b40dea94` |
| Websites | Each web app on its own port (8100 up) on the LAN; `qonu-web`'s `/` links them on the host the visitor came by | Simpler than a path proxy: any framework works unchanged | **built** |
| `device_adopt` | `fr devices adopt <device>`: the registry row prepared and marked provisioned as a flash would, the identity sent as a MSG `fr.adopt` from the hub; `fr_posix` saves it and restarts | The SDK's apps see only provisioned devices; a Linux node has no `fr_ident` to flash (UNOQ-1 step 5) | **built**: the UNO Q is `uriel`, addr 1, on the board hub's network |
| Example | `apps/timelapse` | Takes a frame from an `fr.camera` device every N seconds through the SDK, keeps them under `/data`, and serves `GET /timelapse/frames` and `/frames/<n>.jpg` | after websites |

## 3. Security

| Surface | How it is protected |
|---|---|
| The terminal (a root shell) | Only through the panel's code: whoever can read the screen can open a session. HTTP is plain, for the home LAN, and each session is logged with the client address. *Proposed later:* TLS with a local certificate, and a user other than root |
| The hub API | Stays on loopback, as the spec has it; the Mac uses an SSH tunnel |
| Websites | Public on the LAN, which is what a website is |

## 4. Found while building

**The Mac and the board can't reach each other over Wi-Fi.**
- Neither can ping or open TCP to the other, although both are on TENRETNI (192.168.0.29 and .24) and ARP resolves on both sides.
- The board reaches the router and the internet.
- `cam-esp32` reaches the Mac's hub over Wi-Fi.
- Over the USB link (10.55.0.x) everything works.

**Likely cause:** the router isolates this client (AP or client isolation, or a guest class), or the Mac's tunnel (`utun4`) filters LAN traffic. If the router isolates it, a phone can't reach the terminal either, so it is to check in the router's settings.

**One UART receive error wedged the link until the next MCU reset.** embassy's `RingBufferedUartRx` stops its DMA on a framing, noise or overrun error, and its restart (`start_uart`) restarts the DMA without resetting the ring's read position. From then on every answer waited for the next half-buffer mark: 0.6-1.6 s, so every call timed out. Flashing the MCU while the daemon kept sending was enough to cause one error; 300 bytes at the wrong baud reproduced it every time. `read_until_idle` was no way out either: it reads the data register itself and takes a byte off the FIFO when frames arrive back to back. The firmware now runs its own DMA ring on LPUART1 from boot, polled every 250 µs and never stopped (no error or idle interrupts; it reads only bytes that were there 2 µs earlier, since the DMA counts a byte before it lands in RAM). Cost: a round trip went from 0.34 to about 1 ms.

**The matrix flickered at random**: its scan ran in thread mode, so drawing on the display held one row lit for milliseconds. It now runs on an interrupt-priority executor. `qonu-node` also holds a changed picture 60 ms before sending it, so an app's clear-then-draw is one frame, not a blank flash.

**A test press joined the wrong network.** Injected presses meant for SERVICES landed in a password screen left open by an earlier test, and confirm tried to join 5TENRETNI5 with the typed junk. The handshake failed, the profile was removed and iwd went back to TENRETNI within seconds. Tests now restart `qonu-dash` first, so they start from a known screen.

## 5. Order

1. Button, pages, bitmap op, `qonu-web`. **Done 2026-11-09.**
2. Node.js 24 in the image; the hub on the board as a service; the SSH tunnel; `qonu-node` on the local hub. **Done 2026-11-09.**
3. Apps: the manifest, the hub ops, `fr app deploy|ls|logs|env|rm`, the units, the SERVICES page. **Done 2026-11-09**, with `device_adopt`.
4. Websites: **done** (own ports, linked from `qonu-web`). Next: the timelapse example with a camera device moved to the home hub.
5. Moving devices between the lab and home hubs (`fr device move`, *proposed*), and a wiring guide in the hub for the panel and the buttons.
6. The LED&KEY module, Wi-Fi from the panel, Remove on SERVICES, the board's time zone, the link receiver fix. **Done 2026-11-09.**
