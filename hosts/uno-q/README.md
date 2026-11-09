# qonu

A minimal, headless Linux for the **Arduino UNO Q** (Qualcomm QRB2210 + STM32U585), built with Buildroot. It's the base for an MCU control pipeline driven by agents over MCP.

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
| Wi-Fi | iwd 3.12. The modem DSP runs the WCN3990 firmware and is started by `rmtfs` + `tqftpserv`. |
| Access | OpenSSH (key-only), USB NCM network, USB serial console, debug UART |
| MCU link | `qonu-link` daemon and the qonu-fw Rust/Embassy firmware for the STM32U585, over the UART at 4 Mbaud with RTS/CTS (see [STM32 link](#stm32-link)) |
| MCU flashing | OpenOCD (pinned upstream commit, libgpiod v2) bit-banging SWD on the QRB2210's GPIOs; `qonu-mcu` wraps it |
| Agent access | `qonu-mcp`, an MCP server over stdio, reached through SSH with a key that can only start it (see [MCP server](#mcp-server)) |
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
- Requests: `Ping`, `GetInfo`, `Heartbeat{ttl}`, `ClearFailsafe`, `SetLed`, `Fault{Hang|Panic}`.
- The MCU also sends events: `Boot{reset_cause}` and `Failsafe{state}`.

### Firmware (`link/firmware`)

- UART receive is DMA ring-buffered.
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
| **4 Mbaud, RTS/CTS (default)** | **2046** | **0.34 ms** | **1.0 ms** | **0 / 100 000** |

For comparison, Arduino's stock bridge does about 18 ms per call at 115200 and about 8.3 ms at its best setting.

These recovery paths were verified on hardware:

| Event | Result |
|---|---|
| Firmware hang | Watchdog reset after about 1.3 s; the MCU reported `IndependentWatchdog` |
| Panic | `last_panic_line` points at the source line |
| External reset | The daemon sees `Boot` and re-arms the failsafe |
| Daemon stopped | The MCU latches `Tripped`; it is cleared and re-armed on restart |
| 3000 random bytes injected onto the live UART | 8 bad frames dropped, no lost requests |

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

`.mcp.json` registers the server as `uno-q` for this project. Open the project in Claude Code and approve the server when asked, then ask for something like "draw a heart on the LED matrix". To try it without an interactive session:

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
.mcp.json                     registers qonu-mcp with Claude Code (via ssh uriel-mcp)
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
