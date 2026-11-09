# qonu

A minimal, headless Linux for the **Arduino UNO Q** (Qualcomm QRB2210 + STM32U585), built with Buildroot. It's the base for an MCU control pipeline driven by agents over MCP.

qonu is part of Fractonica and lives in `hosts/uno-q/`. Run every command below from this folder (`cd hosts/uno-q`). It doesn't use the pnpm workspace or ESP-IDF. One piece builds against the rest of the checkout: `qonu-node`, which the builder reads from `/fr`.

Goals for this first layer:
- a stable kernel
- two independent ways in (Wi-Fi and USB-C), plus serial consoles
- as little running as possible

## What's in the image

| Piece | Choice |
|---|---|
| Kernel | Linux **7.3.3** (mainline stable) with the upstream `qrb2210-arduino-imola` device tree. Plan: move to 7.4 LTS once released. |
| Kernel config | Arduino's stock config, trimmed with `localmodconfig` to the 85 modules the board actually uses. Audio, video codec, Docker and adb are dropped, and every non-Qualcomm ARM platform is disabled. |
| Init | systemd 258 with networkd, resolved (mDNS), timesyncd and a hardware watchdog (`qcom_wdt`, 20 s) |
| Wi-Fi | iwd 3.12, with power save off (it added 15-80 ms to every packet). The modem DSP runs the WCN3990 firmware and is started by `rmtfs` + `tqftpserv`. Measured over SSH with the Mac on Wi-Fi too: about 2 MB/s on 2.4 GHz; on 5 GHz (802.11ac, 80 MHz, 433 Mbit/s link) 6.5-8 MB/s from the board and 3-4.4 MB/s to it. |
| Access | OpenSSH (key-only), USB NCM network, USB serial console, debug UART |
| MCU link | `qonu-link` daemon and the qonu-fw Rust/Embassy firmware for the STM32U585, over the UART at 4 Mbaud with RTS/CTS (see [STM32 link](#stm32-link)) |
| MCU flashing | OpenOCD (pinned upstream commit, libgpiod v2) bit-banging SWD on the QRB2210's GPIOs; `qonu-mcu` wraps it |
| Agent access | `qonu-mcp`, an MCP server over stdio, reached through SSH with a key that can only start it (see [MCP server](#mcp-server)) |
| Display | 1.47" ST7789 IPS panel on the STM32's SPI2, with a vitals dashboard from `qonu-dash` (see [Display dashboard](#display-dashboard)) |
| Front panel | Buttons on D2-D4 move between four pages: SYSTEM, SERVICES, CONTROL (a QR code for a phone terminal from `qonu-web`) and WI-FI. An LED&KEY module (TM1638) types Wi-Fi passwords and shows the time (see [Front panel](#front-panel)) |
| Fractonica | `qonu-node`: the board as a Fractonica device, with LED3 and the LED matrix as `fr.led` and `fr.display` (see [Fractonica device](#fractonica-device)) |
| Rootfs | ext4, mounted read-only by the kernel, then fsck'd, remounted rw, and grown to the 10 GB partition by systemd |
| Size | No package manager, no Docker, no desktop. See `out/flash` after a build. |

### Boot chain

The first stages are signed and left exactly as Arduino ships them:

```
PBL (ROM) → XBL → ABL → U-Boot (boot_a/b)
```

From U-Boot onwards, qonu takes over:

```
→ systemd-boot (efi partition) → Linux 7.3 + DTB → systemd
```

qonu writes **only** the `efi` (p67) and `rootfs` (p68) partitions. The GPT, Qualcomm firmware, U-Boot and `userdata` (p69, mounted at `/data`) are never touched. The Arduino Flasher can always restore stock, and EDL lives in ROM, so a bad image can't brick the board.

### Ways into the board

| Path | Address | Needs |
|---|---|---|
| Wi-Fi + mDNS | `ssh root@uriel.local` (`make ssh`) | a network in `local/wifi/` |
| USB-C network (NCM) | `ssh root@10.55.0.1` (`make ssh-usb`) | just the USB-C cable |
| USB-C serial console | `/dev/cu.usbmodem*` (`make console`) | just the USB-C cable |
| Debug UART | JCTL pins 4 (TX) / 6 (RX) / 1 (GND), 115200, **1.8 V** | a 1.8 V USB-UART adapter |

The USB network hands your computer an address by DHCP but no route or DNS, so your internet connection is unaffected. Over SSH the board's host key is pinned in `local/known_hosts`, so reflashing never triggers a host-key warning.

## Quick start (macOS with Docker)

```bash
make build      # first run 45-75 min; incremental afterwards
make flash      # needs `brew install qdl` and a jumper on JCTL USB_BOOT-GND
make ssh-usb    # works as soon as the board boots, over the USB-C cable
make wifi       # prompts for SSID/passphrase; saved in local/wifi/ for every
                # future image, and pushed to the board if it is on USB
make ssh        # over Wi-Fi: uriel.local
```

Flashing: fit the jumper, plug in USB-C, and qdl writes both partitions in about 25 s. Then remove the jumper and replug. The first boot reaches SSH over USB in about 15 s.

`local/` is git-ignored. It holds:
- your SSH public key and the board's SSH host key
- Wi-Fi credentials
- the board's time zone (`local/timezone`, your computer's by default; on the board, `timedatectl set-timezone`)
- Arduino's per-PCB Wi-Fi calibration file
- the downloaded EDL programmer
- the MCU flash backup

None of these are redistributable or belong in git.

## STM32 link

The STM32U585 runs `qonu-fw`, a Rust firmware built on Embassy. On Linux, `qonu-link daemon` is the only process that talks to it. Everything else, including the future MCP layer, goes through the daemon's socket.

### Wiring

The wiring was confirmed on the board.

| Signal | QRB2210 (Linux) | STM32U585 | Notes |
|---|---|---|---|
| UART | `/dev/ttyHS1`: TLMM GPIO 6/7, CTS 71, RTS 80 | LPUART1: TX PG7, RX PG8, RTS PG6, CTS PG5 | Port G needs VDDIO2 enabled in firmware |
| SWD | gpiochip1 lines 25 (SWDIO), 26 (SWCLK) | SWD | OpenOCD `linuxgpiod`, about 14.5 KiB/s |
| Reset | line 38 | NRST | OpenOCD `srst` |
| BOOT0 | line 37 | BOOT0 | Floating reads high, so a reset would boot ST's ROM bootloader. `qonu-mcu-boot0.service` holds it low from early boot. |
| Linux ready | line 70 | PG13 | Used only by Arduino's loader; unused by qonu |

### Protocol (`link/proto`)

- Each frame is `COBS(seq ‖ postcard(body) ‖ CRC-32) ‖ 0x00`.
- A corrupted byte costs one frame. The receiver resynchronizes at the next `0x00`.
- `seq` sits outside the body, so an older MCU can still answer `BadRequest` to a request it doesn't know.
- Requests: `Ping`, `GetInfo`, `Heartbeat{ttl}`, `ClearFailsafe`, `SetLed`, `Fault{Hang|Panic}`, `Matrix{rows}`, `Draw{ops}`, and since protocol v4 `Panel{digits, leds, level}` and `PanelStatus` (the LED&KEY module).
- The MCU also sends events: `Boot{reset_cause}`, `Failsafe{state}`, `Button{id, pressed, t_ms}` and, since v4, `Panel{present}`.

### Firmware (`link/firmware`)

- **UART receive** is a DMA ring that runs from boot on and is polled every 250 µs. Receive errors never stop it: the UART's error and idle interrupts stay off, a damaged byte isn't transferred, and the CRC drops the frame. (embassy's `RingBufferedUartRx` stops on an error, and its restart kept a stale read position: after one framing error, such as a glitch while the MCU is flashed, every answer waited 0.6-1.6 s for the next half-buffer mark until a reset.)
- **LED matrix:** its scan runs on an interrupt-priority executor, so drawing on the display never holds one row lit longer than the others (that showed as random flicker).
- **Failsafe:** the daemon sends a heartbeat every 150 ms with a 600 ms TTL. A missed deadline latches `Tripped`, and host-owned outputs go to their safe level.
- **Watchdog:** the independent watchdog has a 1 s timeout. It is fed only while both link tasks make progress.
- **Panics:** a panic records its source line in RAM that survives the reset, and `info` reports it after boot.
- **LED4:** green blink = disarmed, solid green = armed, red blink = failsafe tripped.

### Daemon (`link/daemon`)

- Serves a JSON-lines socket at `/run/qonu/link.sock`. Each request is `{"id","method","params"}`.
- Retries each request once after a 100 ms timeout. Every request is idempotent, so the retry is safe.
- Clears a trip on its own once the MCU answers again; pass `--latch` to require `qonu-link clear` instead.
- Counts frames, CRC failures, timeouts and MCU reboots.

```bash
qonu-link ping            # round trip, MCU uptime
qonu-link info            # firmware version, reset cause, UID, MCU-side link counters
qonu-link stats           # daemon-side counters and latency percentiles
qonu-link led 1 0 1       # LED3 red + blue
qonu-link bench 10000     # back-to-back round trips
qonu-link fault hang      # prove the watchdog resets the MCU (fault panic: the panic path)
qonu-link panel "HELLO 42" 10100000 4   # the LED&KEY: 8 characters, LEDs (LED 1 first), brightness 1-8
qonu-link screen          # what the panels show: the display's texts, the LED&KEY, the matrix
qonu-mcu info|flash [elf]|verify [elf]|reset|backup FILE
                          # SWD; without a file, flash/verify use the image's firmware
```

From the Mac:
- `make mcu-flash` builds the firmware and flashes it over SWD.
- `make link-push` updates the daemon.
- `make link-test` runs the protocol tests.

### Measured

Measured with `qonu-link bench`, sequential round trips through the daemon:

| Link | Calls/s | p50 | p99 | Errors |
|---|---|---|---|---|
| 115200, no flow control | 167 | 6.4 ms | 8.1 ms | 0 / 2000 |
| 921600, no flow control | 735 | 1.2 ms | 3.2 ms | 0 / 2000 |
| 2 Mbaud, no flow control | 1434 | 0.67 ms | 1.2 ms | 0 / 2000 |
| 4 Mbaud, RTS/CTS, embassy's ring receiver (before protocol v4) | 2046 | 0.34 ms | 1.0 ms | 0 / 100 000 |
| **4 Mbaud, RTS/CTS, the polled ring (default)** | **911** | **1.08 ms** | **3.0 ms** | **0 / 6000** |

The polled receiver costs about 0.7 ms per round trip: it is the price of a receiver that no error can wedge. The dashboard's traffic is a few calls a second.

For comparison, Arduino's stock bridge does about 18 ms per call at 115200 and about 8.3 ms at its best setting.

These recovery paths were verified on hardware:

| Event | Result |
|---|---|
| Firmware hang | Watchdog reset after about 1.3 s; the MCU reported `IndependentWatchdog` |
| Panic | `last_panic_line` points at the source line |
| External reset | The daemon sees `Boot` and re-arms the failsafe |
| Daemon stopped | The MCU latches `Tripped`; it is cleared and re-armed on restart |
| 3000 random bytes injected onto the live UART | 8 bad frames dropped, no lost requests |
| 300 bytes at the wrong baud rate (hundreds of framing errors), three times | The next request answered in about 1 ms |
| Flashed over SWD while the daemon and dashboard kept sending | Answers within 1 ms after boot, three times out of three |
| Overload: 10 000 back-to-back calls, 300 redraws and 60 panel writes at once | Heartbeats fell behind and the failsafe tripped; the daemon cleared it by itself once the load ended |

The image's firmware is built from the same tree, with the same flags and the same target directories as `make mcu-flash`. Only its debug sections are stripped. `qonu-mcu verify` therefore confirms byte for byte that the MCU runs the image's firmware. It halts the MCU in reset to do so, then restarts it.

### Going back to Arduino's firmware

`local/mcu-backup/arduino-factory.bin` is the full 2 MiB flash read off this board. To restore it:
1. Copy it to the board.
2. Run `systemctl stop qonu-link`.
3. Run `qonu-mcu flash /tmp/arduino-factory.bin`.

Arduino's loader also waits for line 70 to go high before it starts a sketch.

## MCP server

`qonu-mcp` (in `link/mcp`) exposes the board to agents as Model Context Protocol tools. It is built on rmcp 3.9, the official Rust SDK, and speaks MCP over stdio. It holds no hardware itself: every call goes through the `qonu-link` socket, so the daemon's failsafe and validation apply to agents too.

```
Claude Code ──ssh uriel-mcp──▶ qonu-mcp ──/run/qonu/link.sock──▶ qonu-link ──4 Mbaud UART──▶ STM32
```

| Tool | Does | Hints |
|---|---|---|
| `get_status` | link state, MCU firmware, uptime, reset cause, failsafe, last panic, latency, error count | read-only |
| `matrix_draw` | static image: 8 rows × 13 chars, `#` on, `.` off | idempotent |
| `matrix_text` | text in a 3×5 font; up to 3 chars shown centered, longer text scrolls | idempotent |
| `matrix_animate` | 1-64 frames at 40-2000 ms each, up to 10 loops, at most 30 s per call | idempotent |
| `matrix_clear` | all LEDs off; stops a running animation | idempotent |
| `set_led` | RGB LED3: off, red, green, blue, yellow, cyan, magenta or white | idempotent |

All tools return structured output with output schemas. A newer matrix command interrupts a running animation.

### Use it from Claude Code

`.mcp.json` registers the server as `uno-q`. There are two copies: one at the Fractonica repo root and one in this folder, so it works wherever Claude Code is started. Approve the server when asked, then ask for something like "draw a heart on the LED matrix". To try it without an interactive session, from this folder:

```bash
claude -p "draw a smiley on the uno-q LED matrix" --mcp-config .mcp.json --strict-mcp-config --allowedTools mcp__uno-q
```

### How access is limited

- `make local` generates `local/ssh/mcp_ed25519`. Its line in the board's `authorized_keys` is `command="/usr/bin/qonu-mcp",restrict`.
- That key starts only the MCP server, whatever command a client sends. It gets no shell, no terminal, and no port, agent or X11 forwarding.
- Nothing listens on the network. Reaching the tools takes that key and the board's pinned host key.
- **Still to do:** `qonu-mcp` runs as root behind the forced command. A dedicated unprivileged user with access to only the link socket comes next.

### Measured

Claude Code driven headless (`claude -p`) checked status, drew a smiley, scrolled `HELLO QONU`, redrew the smiley and set LED3 green. Every call went through SSH → `qonu-mcp` → `qonu-link` → the STM32, with 0 link errors. A second run played a 12-frame animation and left a heart on the matrix. Checked by eye on the board: the heart is upright and LED3 is green. This confirms the charlieplex pin map and the row and column orientation.

## Display dashboard

A 1.47" 172×320 ST7789 IPS module (sold as GMT147SPI) sits on the STM32's SPI2 at the UNO header. It is driven in landscape, 320×172.

| Display | UNO Q header | STM32 |
|---|---|---|
| GND | GND | — |
| VDD | 3.3V | — |
| SCL | D13 | PB13, SPI2 SCK |
| SDA | D11 | PB15, SPI2 MOSI |
| RES | D8 | PB4 |
| DC | D9 | PB8 |
| CS | D10 | PB9 |
| BL | D6 | PB1 |

**Firmware (`link/firmware/src/display.rs`):**
- Draw ops paint a 110 KB back buffer in the STM32's SRAM.
- `Present` copies the rows that changed into a front buffer and streams them to the panel over SPI with DMA at 40 MHz (`QONU_LCD_MHZ` overrides it). The panel never shows a half-drawn frame, and the link never waits for SPI.
- At power-up the STM32 shows a splash screen. If the failsafe trips, it shows a "LINK LOST" banner by itself.

**Protocol:** `Request::Draw { ops }` carries up to 24 ops of these kinds:
- `Clear`, `Rect`, `Line`
- `Text` in 4 fonts with alignment and background
- `Bars`, a bar graph of 0-100 values
- `Present`, `Backlight`

The daemon's `draw` method takes the ops as JSON (`{"op":"text","x":4,"y":2,"text":"hi","font":"large","color":"#fff"}`) and packs them into as few link frames as fit.

**`qonu-dash`** (`link/dash`, `qonu-dash.service`) redraws the whole screen once a second. It shows:
- hostname, clock and uptime
- CPU load as a total, per core (4 cores) and a 60-second history
- load average and memory
- temperatures from the thermal zones (CPU, GPU, Wi-Fi, modem)
- disk use of `/` and `/data`
- Wi-Fi network name, signal (from `iwctl`), IP address and receive/transmit rates
- the STM32 link: firmware version, round-trip time, errors and failsafe state

A full redraw costs about 1 KB on the link and 22 ms of SPI. Because each frame is complete, the picture heals by itself after an MCU reset or a failsafe trip. `make dash-push` updates it.

## Front panel

**Three push buttons, each between a header pin and GND, with no resistors, and an LED&KEY module:**

| Pin | STM32 | Button |
|---|---|---|
| D2 | PB3 | confirm |
| D3 | PB0 | up |
| D4 | PA12 | down |

The STM32 enables the internal pull-ups and polls the pins every 5 ms. A change counts after 20 ms, so contact bounce never reaches Linux. Each change goes to Linux as a protocol v3 `Event::Button` (id 0, 1 or 2):
- `qonu-link events` prints them.
- `qonu-link press confirm|up|down` acts as a press, for tests and agents.

Polling rather than pin interrupts. (An EXTI interrupt on PA12 once seemed to make the link answer late; the likelier cause was the receive bug described under [Firmware](#firmware-linkfirmware), since flashing the MCU was enough to set it off.)

**LED&KEY module** (a TM1638: 8 seven-segment digits, 8 red LEDs, keys S1-S8):

| Module | UNO Q header | STM32 |
|---|---|---|
| VCC | 3.3V (5V also works) | — |
| GND | GND | — |
| STB | D12 | PB14 |
| CLK | D7 | PB2 |
| DIO | D5 | PA11 |

- The STM32 drives the three lines open drain with pull-ups and reads the keys every 10 ms, debounced over two reads. S1-S8 reach Linux as `Event::Button` ids 8-15 (`qonu-link press s1` acts as one).
- It finds the module by itself (`qonu-link call panel_status`) and repaints it every second, so it can be plugged in later. The failsafe turns it off.
- `qonu-dash` owns it: the time (`21-36-58`) and the CPU load as a bar of LEDs; while a password is typed, its last 8 characters, and the LED of the key whose letter is open.

`qonu-dash` shows four pages:

| Page | Shows | Confirm |
|---|---|---|
| SYSTEM | CPU, load and uptime, memory, temperatures, disk, Wi-Fi, the STM32 link | — |
| SERVICES | The board's services (`qonu-*`, `fractonica-*`) and the deployed apps (`fr-app-*`): state and memory | Select a service |
| CONTROL | A QR code with a one-time terminal link from `qonu-web` | A new code |
| WI-FI | The network, signal and address; the saved networks | Scan and list the networks in range |

**Moving around:**
- Up and down move between pages; on the LED&KEY, S1-S4 jump straight to one.
- In SERVICES, confirm selects a service; up and down move the selection, and up from the first row leaves the list.
- Confirm on a service opens its menu:
  - **Logs:** this boot's journal, following new lines. Up and down scroll (holding repeats); confirm goes back.
  - **Restart**
  - **Stop** (asks first) or **Start**
  - **Remove**, for apps (asks first): `fr app rm`, which keeps the app's data and settings for a redeploy
  - **Back**
- `qonu-dash` and `qonu-link` have no Stop: without them the display can't show the way back.
- Two minutes without a press returns to the page view (five while typing).

**Wi-Fi from the panel.** Confirm on WI-FI scans and lists the networks in range, strongest first, then the saved ones out of range.
- A new network with a password opens the typing screen at once. A saved or open one opens a menu: **Connect**, **Password** (a new one), **Forget** (asks first), **Back**.
- Typing works like an old phone, on the LED&KEY: a key cycles through its letters, and a pause of 1.2 s or another key keeps the letter shown. Holding a key steps through its letters.

  | Key | abc / ABC | 123 |
  |---|---|---|
  | S1-S6 | `abcd` `efgh` `ijkl` `mnop` `qrst` `uvwx` | 1-6 |
  | S7 | `y` `z` space | 7 |
  | S8 | ``. - _ @ ! ? # $ % & * + = / : ; , ' " ( ) [ ] { } < > ~ ^ \| \ ` `` | 8 9 0 |

  UP switches abc / ABC / 123, DOWN deletes (held, it repeats; on an empty line it goes back), confirm connects.
- The board writes the password to iwd's profile (`/var/lib/iwd`, root only), joins, and shows the new address. If the network refuses it, the profile goes back to how it was, iwd returns to the network it had, and typing again starts from what was typed. The password is never logged.
- WPA-Enterprise networks are set up with `iwctl`.

**The phone terminal (`qonu-web`, port 80).**
- Scan the code with a phone on the same Wi-Fi to get a root shell in the browser: xterm.js with a key row for Esc, Tab, Ctrl, the arrows and ^C.
- It opens with a short list of useful commands. Root's home directory is nearly empty, so a plain `ls` there shows nothing; the board's data is in `/data`.
- The prompt shows user, host and directory, and `ll` and `la` are aliases.
- Each code opens one 12-hour session, and the code changes after each use and every 10 minutes. Only someone who can read the panel can get in.
- HTTP is plain: it is meant for the home LAN.

`make web-push` and `make dash-push` update them. Design: [docs/design/uno-q-services.md](../../docs/design/uno-q-services.md).

## Fractonica hub on the board

The board runs its own Fractonica hub (`fractonica-hub.service`), which stays up while the Mac sleeps. It runs from `/data/fractonica/hub`, with `FR_HOME` at `/data/fractonica/home`; both survive image reflashes. Node.js 24.22.0 (`/usr/bin/node`, npm) comes with the image.

```bash
make hub-push      # stage the hub from this checkout (linux-arm64 node_modules) and install it
make hub-tunnel    # forward its API to the Mac, then: FR_HUB=http://127.0.0.1:7520 fr devices ls
```

**Ports:**
- The API is on port 7520, on loopback only. It isn't 7420 so that it can be forwarded to the Mac next to the lab hub: the hub checks the `Host` header against its own port.
- Node links are on 7421 and images on 7422.

**Apps.** Background services and websites in Node.js run as `fr-app-<name>` units next to the hub.
- From the Mac: `fr app deploy <folder>`, then `fr app ls`, `fr app logs`, `fr app env`, and `fr app restart`, `stop`, `start` and `rm`. The format and examples are in [apps/README.md](../../apps/README.md).
- Websites answer on their own ports (8100 up), and `http://<board>/` links them.
- The UNO Q itself is a provisioned device on this hub: `fr devices adopt uriel` gave it an address over its session. Apps drive it like any device.

On the board, `fr` (the Fractonica CLI) talks to this hub. `--no-serial` and `--no-advert` are set for now: there is no USB host on the board yet, and the advert uses macOS's `dns-sd`.

## Fractonica device

`qonu-node` ([node/](node/README.md)) runs Fractonica's own node runtime (`firmware/components/fr_posix`) on Linux. It joins the hub like an ESP32 node: HELLO, heartbeats, commands, state and BYE, over TCP and UDP to the hub found by name over mDNS. It offers the STM32's outputs through `qonu-link`:

| Instance | Capability |
|---|---|
| `led3` | `fr.led`, rgb, on/off per channel |
| `matrix` | `fr.display`, 13×8 mono1, drawn by Fractonica's 5×7 renderer |

The hub, CLI, MCP and apps drive it like any device: `fr send uriel matrix.text '{"x":1,"y":0,"text":"Hi"}'`.

It connects to the board's own hub (`qonu-node set-hub 127.0.0.1`), or to any hub you name with `set-hub`, then `systemctl restart qonu-node`. `make node-push` updates it.

Design and status: [docs/design/uno-q-host.md](../../docs/design/uno-q-host.md).

**Not yet:** the ST7789 panel as `fr.display` (LVGL and a blit op), the Linux vitals as `fr.host`, and hub support for non-ESP devices. The hub lists the board with no address or chip.

## Layout

```
Makefile                      host entry points
docker/Dockerfile             build environment (Debian trixie, arm64)
scripts/
  build.sh                    Buildroot build (runs in the container)
  gen-kernel-config.sh        regenerates board/uno-q/linux.config
  setup-local.sh              creates local/ (SSH keys, ssh config)
  add-wifi.sh                 adds a Wi-Fi network to local/wifi/
  flash.sh                    qdl flashing of efi + rootfs
  push.sh                     copy files from the last build onto the running board
  link.sh                     Rust builds/tests for link/ (runs in the container)
link/                         the STM32 link, in Rust
  proto/                      wire protocol shared by both ends (no_std, tested)
  firmware/                   qonu-fw for the STM32U585 (Embassy)
  daemon/                     qonu-link: Linux daemon + CLI
  mcp/                        qonu-mcp: MCP server (tools over stdio)
  dash/                       qonu-dash: the display's three pages
  web/                        qonu-web: LAN front door, phone terminal (xterm.js vendored, MIT)
node/                         qonu-node: the board as a Fractonica device (C++, fr_posix)
.mcp.json                     registers qonu-mcp with Claude Code (via ssh uriel-mcp);
                              the repo root has a copy with this folder's path
br2-external/                 Buildroot external tree (BR2_EXTERNAL_QONU)
  configs/qonu_uno_q_defconfig
  board/uno-q/
    kernel-modules.txt        modules kept by localmodconfig
    linux-fragment.config     qonu kernel options
    linux.config              generated kernel defconfig (commit it)
    partitions-emmc-16gb.env  efi/rootfs offsets for the 16 GB board
    genimage.cfg, post-build.sh, post-image.sh
    rootfs-overlay/           systemd units, network, ssh, iwd, watchdog
  package/                    qrtr, rmtfs, tqftpserv, qbootctl, uno-q-firmware,
                              uno-q-openocd, qonu-link
board-snapshot/               stock kernel config, lsmod, service units (reference)
```

Build state lives in the Docker volume `qonu-build` (it has to be on a case-sensitive filesystem). Use `make shell` to get into it.

## Recovery

- **Back to stock:** use the Arduino Flasher CLI (`arduino-flasher-cli flash unoq`). It needs the same EDL jumper.
- **Board shows up as `18d1:d00d` (fastboot):** ABL gave up on an unmarked slot. `qbootctl-mark.service` prevents this; reflash with `make flash` to recover.

## Known limits of this first layer

- 16 GB board only. The 32 GB board's partition offsets need their own `.env`.
- Single rootfs. A/B updates (Mender or systemd-boot boot counting) come later.
- The empty root password is for console login during development. SSH is key-only regardless.
- No audio, camera or video codec.
- No Wi-Fi regulatory country is set (world domain plus AP hints).
- **Clock:** the PMIC RTC is read-only to Linux and reads 1970 at power-up, so the time comes from NTP.
  - Across reboots, systemd restores the last synced time.
  - After a power loss with no network, the clock starts at the build date.
  - DNSSEC is off, because with a wrong clock DNSSEC validation fails, names never resolve, and NTP never runs.
- **Modem stall:** in 1 of the first 4 boots, the modem DSP (which runs the Wi-Fi firmware) stalled during startup.
  - Its own watchdog restarted it after 40 s, and Wi-Fi came up at about 55 s instead of about 15 s.
  - USB access is not affected.
  - rmtfs runs with the same flags as stock (`-r -P -s`).
- **MCU firmware updates are manual:**
  - The image ships `/usr/share/qonu/mcu/qonu-fw.elf`, but nothing flashes it automatically.
  - Run `qonu-mcu flash` after reflashing the board.
  - `qonu-link info` reports the firmware version actually on the MCU.
- **SWD is slow:** bit-banged through libgpiod at about 14.5 KiB/s.
  - qonu-fw (22 KB) flashes in about 2 s.
  - A full 2 MiB backup takes about 2.5 min.
- **The daemon and qonu-mcp run as root:** dedicated users with access to only `ttyHS1` (daemon) and the link socket (qonu-mcp) are next.

## Measured on the board (16 GB UNO Q)

| Metric | Value |
|---|---|
| Power-on to multi-user | ~15 s: 6 s Qualcomm firmware and U-Boot, 1.5 s systemd-boot, 0.6 s kernel, 7.3 s userspace |
| RAM in use at idle | ~105-110 MB (stock Debian: ~386 MB) |
| Root filesystem in use | 89 MB |
| Loaded modules | 66 |
| Wi-Fi joined after boot | 13-20 s |
