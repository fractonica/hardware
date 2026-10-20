# 01 — Tooling: what is installed, what we need

Status: inventory taken 2026-10-20 on the hub machine. The approved installs from §1.4 were completed the same day and verified (§1.6).

## 1.1 Host

| Item | Value |
|---|---|
| Machine | 16" MacBook Pro (MacBookPro18,2), Apple M1 Max, arm64. No Ethernet port |
| OS | macOS 26.6.2 (25G83) |
| Network | Wi-Fi (`en0`, 192.168.0.17). The default route currently goes through a VPN tunnel (`utun4`). LocalHostName is `dimas-3`, so nodes will reach the hub as `dimas-3.local` |
| Free disk | ~76 GB (the volume is 96% full). ESP-IDF v6.1 plus toolchains needs about 3–5 GB. |

## 1.2 Inventory vs requirement

| Tool | Installed | Framework needs | Action |
|---|---|---|---|
| ESP-IDF | v5.5.1 and v5.5 at `~/esp/…`; a stale v5.3.2 record in `~/.espressif/idf-env.json`. The v5.5.1 tree has local modifications (`git status` dirty). | **v6.1**, pinned by tag and commit ([03-firmware §3.1](03-firmware.md)) | Install side by side at `~/esp/v6.1/esp-idf` for targets `esp32c3,esp32c6,esp32s3`. Leave the 5.5 installs alone. |
| Xtensa/RISC-V GCC | esp-13.2.0 and esp-14.2.0 | esp-15.2.0_20251204 (comes with v6.1) | Installed by IDF's `install.sh` |
| esptool | 5.1.0 first on PATH (radioconda); the IDF 5.5 env pins 4.11 (old underscore CLI) | **5.6.0**, in a hub-owned uv venv and used through its Python API | Never rely on PATH. Bootstrapped by `fr doctor --fix` ([08-hub §8.5](08-hub.md)) |
| Python | `/usr/bin/python3` 3.9.6 (too old for esptool 5.6); radioconda 3.10 first on PATH; Homebrew 3.12–3.14 | 3.12, managed by uv, for `pytools` | `uv python install 3.12` |
| uv | 0.7.21 | recent | `uv self update` |
| Node.js | 24.11.1 (nvm, first on the shell PATH). Also installed: Homebrew 25.2.1 (end of life) and /usr/local 22.19.0, which apps that do not load your shell profile may pick up | ≥ 24.12; switch to **26** once it becomes Active LTS on 2026-10-28 | `nvm install 24` now, then `nvm install 26`. `fr doctor --fix` pins the absolute path into the `fr` shim ([08 §8.12](08-hub.md)) |
| pnpm | 11.15.1 | 11.x is fine (12.x is current; pin one deliberately) | none |
| cmake / ninja | Homebrew cmake 4.1.1 and radioconda ninja come first on PATH | IDF-managed cmake and ninja, so builds are reproducible | Builds run in a sanitized environment ([03-firmware §3.8](03-firmware.md)) |
| ccache | **missing** | recommended (incremental agent build loop) | `brew install ccache` |
| Docker | 29.6.1 | optional, **builds only**: Docker on macOS cannot pass USB serial through | none |
| git / gh | 2.40.0 / 2.92.0 | yes | This folder is not a git repo yet ([README open questions](README.md#open-questions)) |
| Claude Code | 2.1.286 | yes. In this version MCP tool descriptions and server instructions are cut at 2,048 characters | Keep tool descriptions short ([09-agent-api §9.6](09-agent-api.md)) |
| arduino-cli + esp32 core 3.3.4, PlatformIO 6.1.18, Rust 1.91 | installed | **not used** by the framework ([03-firmware §3.1](03-firmware.md)) | leave as is |
| esp-emulator, Wokwi CLI, EIM | not installed | optional (sim tier) | later ([10-testing](10-testing.md)) |

## 1.3 Attached hardware

| Port | USB identity | Inference |
|---|---|---|
| `/dev/cu.usbmodem1101` | VID 0x303A, PID 0x1001 (native USB-Serial/JTAG), serial `1C:DB:D4:16:BA:34`, bcdDevice 0x0101 | **ESP32-C3 0.42" OLED board** (`esp32c3-oled042`), C3 revision v0.4, 4 MB XMC flash. Identified with esptool and hwprobe on 2026-10-20 |

On the day of the inventory, the port was **held open by Google Chrome** (Web Serial, PID 715). It was released later the same day, and the board was flashed with hwprobe. The hub must be the only owner of serial ports ([08-hub §8.2](08-hub.md)).

## 1.4 Install plan (proposed, needs your OK)

```bash
brew install ccache
```

```bash
git clone -b v6.1 --recursive https://github.com/espressif/esp-idf.git ~/esp/v6.1/esp-idf
```

```bash
~/esp/v6.1/esp-idf/install.sh esp32c3,esp32c6,esp32s3
```

```bash
uv self update && uv python install 3.12
```

```bash
nvm install 24
```

After the clone, record the exact commit in `firmware/idf-version.lock`. `fr doctor` refuses to build when the commit it finds does not match the pin.

## 1.6 Installed and verified (2026-10-20)

| Item | Result |
|---|---|
| ESP-IDF | **v6.1** at `~/esp/v6.1/esp-idf`, commit `fff9895c82d744c7237be8847347bdd1b07c6643` (shallow clone, 24 submodules) → goes into `firmware/idf-version.lock` |
| Toolchains | riscv32 and xtensa `esp-15.2.0_20251204`, GDB 17.1, OpenOCD `v0.12.0-esp32-20260703`, esp-clangd |
| IDF Python env | `~/.espressif/python_env/idf6.1_py3.12_env`, created from uv's Python 3.12.11 (not radioconda). It bundles **esptool 5.6.0**, the same version the hub pins |
| IDF-managed build tools | CMake 4.0.3, Ninja 1.12.1 (used instead of the Homebrew and radioconda copies) |
| ccache | 4.14.2 (Homebrew); IDF picks it up with `IDF_CCACHE_ENABLE=1` |
| Node | 24.22.0 via nvm; nvm's default alias resolves to it in new zsh shells. Bash login shells still find `/usr/local/bin/node` 22.19, which is why the `fr` shim pins an absolute path |
| uv Python | 3.12.11 (`uv python install 3.12`) |
| Older installs | ESP-IDF 5.5 / 5.5.1, their toolchains and Python envs are untouched. The IDF installer offered to remove them; it was not done |

Smoke test, the `hello_world` example built in a sanitized environment (`env -i`, uv Python first on PATH, `export.sh`):

| Target | Clean build | App binary |
|---|---|---|
| esp32c3 | OK, 31 s | 126,688 B |
| esp32c6 | OK, 26 s | 133,296 B |
| esp32s3 | OK, 29 s | 150,720 B |

- No compiler warnings.
- A no-op rebuild takes 1 s.
- Nothing was flashed: the attached board's port is still held by Chrome.

## 1.5 Things deliberately not used

| Tool | Why not |
|---|---|
| Arduino-ESP32 as the base | Uses precompiled IDF libraries with a fixed sdkconfig. No per-board Kconfig, no component versioning, and rollback, partition and coexistence tuning are not first-class. Arduino libraries may come back later inside a single driver component, once Arduino 4.0 (built on IDF 6.1) is stable. |
| PlatformIO | An extra layer between us and IDF that has lagged on Arduino support. Not needed. |
| Rust (esp-hal) | esp-hal is 1.x, but `esp-radio` (which provides ESP-NOW) is still 1.0.0-beta.2. Keep the wire protocol language-neutral so Rust nodes can join later. |
| Zephyr | ESP-NOW exists only as a sample; it conflicts with an ESP-NOW-first design. |
| espressif/esp-now component as the transport | Its duplicate cache ignores the sender and it retransmits broadcasts blindly. We borrow its OTA-resume and security-handshake designs instead ([05-network §5.1](05-network.md)). |
| ESP-WIFI-MESH / ESP-Mesh-Lite | Heavy, slow to heal, tied to the router channel. |
| Docker for the hub | No USB serial passthrough on macOS. RFC2217 does not support USB-Serial/JTAG boards. |
| Bun for the hub | `serialport` panics on Bun (oven-sh/bun#18546 is still open). |
