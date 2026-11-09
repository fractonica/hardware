# Arduino UNO Q: STM32U585 MCU side and the Linux<->MCU bridge (state as of Nov 2026)

Method note: most findings below come from reading the primary source code and configs in Arduino's GitHub repos with `gh` on 2026-11-08: arduino-router v0.11.0, Arduino_RouterBridge 0.4.4, Arduino_RPClite 0.3.1, ArduinoCore-zephyr 1.1.0, arduino-router-bridge-py, app-bricks-py, remoteocd, arduino-app-cli, and arduino/docs-content. Secondary sources are blogs, forum threads, and GitHub issues. Code-level facts are linked to the file. Claims taken only from search-result snippets are marked "(snippet only)".

Version timeline, for flagging "changed since launch":
- **ArduinoCore-zephyr**
  - 0.51.0 (2025-10-15) added UNO Q support on an Arduino fork of Zephyr 4.2.0. It stayed on 4.2.0 through 0.90.0 (2026-07-27).
  - 1.0.0 (2026-09-02) moved to Zephyr 4.4.1 and added VENTUNO Q.
  - 1.1.0 (2026-10-29) is on Zephyr 4.4.2. — [0.51.0 release](https://github.com/arduino/ArduinoCore-zephyr/releases/tag/0.51.0), [1.0.0](https://github.com/arduino/ArduinoCore-zephyr/releases/tag/1.0.0), [1.1.0](https://github.com/arduino/ArduinoCore-zephyr/releases/tag/1.1.0), [west.yml](https://github.com/arduino/ArduinoCore-zephyr/blob/main/west.yml)
- **arduino-router**
  - Around launch it was 0.5.x. A user report cites "arduino-router 0.5.3" with "arduino:zephyr 0.51.0 (the stock image's core)". — [RPClite #43 comment](https://github.com/arduino-libraries/Arduino_RPClite/issues/43)
  - Latest is v0.11.0 (2026-10-22). — [releases](https://github.com/arduino/arduino-router/releases)
- **Arduino_RouterBridge** (MCU library): 0.3.0 (2025-12-15) to 0.4.4 (2026-10-19). — [repo](https://github.com/arduino-libraries/Arduino_RouterBridge)
- **Arduino_RPClite**: 0.2.0 (2025-09) to 0.3.1 (2026-09-09). 0.4.0 is an open RC. — [repo](https://github.com/arduino-libraries/Arduino_RPClite)
- **Python client**: split out of App Lab into `arduino-router-bridge` (repo created 2026-08-25). App Lab bricks pin version 0.5.1. — [arduino-router-bridge-py](https://github.com/arduino/arduino-router-bridge-py)

---

## 1. Physical links between MPU (QRB2210) and MCU (STM32U585); flashing, debugging and sketch upload

### Takeaway
The two chips are linked by:
- A UART: QRB2210 `/dev/ttyHS1` to STM32 LPUART1 on PG5–PG8, which has RTS/CTS pins but runs at 115200 without flow control in the stock configuration.
- An internal SPI bus: STM32 SPI3 as slave, unused by the stock bridge.
- Several QRB2210 GPIO lines (via `/dev/gpiochip1`) for MCU ready/boot/reset handshakes.
- SWD lines that Linux bit-bangs with OpenOCD's `linuxgpiod` driver.

Linux can therefore flash and debug the MCU directly. Every sketch upload, from App Lab or `arduino-cli`, ends up as an OpenOCD run on the QRB2210, wrapped by the `remoteocd` tool in one of three modes: local, over adb, or over SSH.

### Cited Findings
**Bridge UART**
- The router claims `/dev/ttyHS1`. Arduino warns: "Do not attempt to open `/dev/ttyHS1` (on Linux) in your own code. This interface is exclusively locked by the `arduino-router` service." — [UNO Q user manual (docs-content source)](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/tutorials/first-steps/user-manual/content.md)
- The UNO Q drop-in for the router service starts `/usr/bin/arduino-router --unix-port /var/run/arduino-router.sock --serial-port /dev/ttyHS1 --serial-baudrate 115200 --after-ready '/usr/bin/gpioset -c /dev/gpiochip1 -t0 70=1'`. It also has:
  - `ExecStartPre=-/usr/bin/gpioset -c /dev/gpiochip1 -t0 37=0`, commented "Put the micro in a ready state".
  - `ExecStopPost` lines that set line 70=0 and pulse line 38 (0 then 1), commented "Restart the boot animation if the router is stopped". — [10-imola.conf](https://github.com/arduino/arduino-router/blob/main/debian/arduino-router/var/lib/arduino-router/config/10-imola.conf)
- A systemd generator picks the drop-in by board model: "Imola" is the UNO Q, "Monza" is the VENTUNO Q. It reads `/sys/class/dmi/id/product_name` or the devicetree `compatible`. — [systemd-arduino-router.sh](https://github.com/arduino/arduino-router/blob/main/debian/arduino-router/usr/lib/systemd/system-generators/systemd-arduino-router.sh)
- MCU side, mainline Zephyr devicetree: `&lpuart1 { pinctrl-0 = <&lpuart1_tx_pg7 &lpuart1_rx_pg8 &lpuart1_rts_pg6 &lpuart1_cts_pg5>; current-speed = <115200>; }`. The same file has `&spi3` on PG9/PG10/PB5/PG12 and `&spi2` on PB13–15/PB9, with a comment pointing at the ICSP alternative. The IWDG is enabled with alias `watchdog0`. — [arduino_uno_q-common.dtsi](https://github.com/zephyrproject-rtos/zephyr/blob/main/boards/arduino/uno_q/arduino_uno_q-common.dtsi)
- Arduino core overlay:
  - `arduino,router-serial = <&lpuart1>; /* 'Serial' is provided by the Monitor */`
  - `serials = <&usart1>, <&lpuart1>, <&usart3>;`
  - `&spi3` is configured as `compatible = "zephyr,spi-slave"` with `zephyr,deferred-init`.
  - `control-gpios = <&gpiog 13 ...>, /* Internal SPI RDY */ <&gpiog 15 ...>; /* FORCED_USB_BOOT status */`
  — [arduino_uno_q_stm32u585xx.overlay](https://github.com/arduino/ArduinoCore-zephyr/blob/main/variants/arduino_uno_q_stm32u585xx/arduino_uno_q_stm32u585xx.overlay)
- Zephyr's board page: "Internal UART and SPI buses connected to the QRB2210". The QRB2210 acts as the SWD debug adapter, using an on-board `openocd`, reachable through adb port forwarding. — [Zephyr board doc](https://docs.zephyrproject.org/latest/boards/arduino/uno_q/doc/index.html)
- Molloy's devicetree reading (July 2026):
  - usart1 (PB6/PB7) is the Zephyr console and comes out on header D0/D1.
  - "lpuart1 (PG5-PG8, and the only one with RTS/CTS hardware flow control) has no header pins at all and is the internal link to the Qualcomm MPU."
  - "/dev/ttyHS1 is the Bridge, and it pairs with lpuart1." — [Derek Molloy, Vanilla Zephyr on the Cortex-M33 (2026-07-30)](https://derekmolloy.ie/under-the-hood-of-the-arduino-uno-q-vanilla-zephyr-on-the-cortex-m33/)

**SWD, flashing and debugging from Linux**
- OpenOCD on the board bit-bangs SWD over GPIO. Its log shows "Linux GPIOD JTAG/SWD bitbang driver (libgpiod v2)", "adapter 'linuxgpiod' doesn't support configurable speed", and "SWD DPIDR 0x0be12477". Debug flow: `adb forward tcp:3333 tcp:3333` then `adb shell arduino-debug`, then `west debug -r openocd` on the PC.
  - libgpiod gives a line to only one consumer, so a running `arduino-debug` session makes `burn-bootloader` fail with "Error requesting gpio line swdio".
  - `west flash` was "not yet wired" to the on-board adapter at the time of writing. — [Molloy](https://derekmolloy.ie/under-the-hood-of-the-arduino-uno-q-vanilla-zephyr-on-the-cortex-m33/)
- `remoteocd` is "a versatile wrapper for OpenOCD" with three modes: local flashing from the UNO Q's Linux, adb over USB, and SSH from a remote PC. It runs `/opt/openocd/bin/openocd -d2 -s /opt/openocd -s /opt/openocd/share/openocd/scripts -f openocd_gpiod.cfg ...`. License: GPL-3.0. — [remoteocd README](https://github.com/arduino/remoteocd), [flash.go](https://github.com/arduino/remoteocd/blob/main/flash.go)
- Board definition: `unoq.upload.tool=remoteocd`, `unoq.upload.tool.network=remoteocd_network` (password field), `unoq.bootloader.tool=remoteocd`, `unoq.upload.target=stm32u585zitxq`, USB VID/PID 0x2341/0x0078. The upload pattern passes `--adb-path` and the board serial number. — [boards.txt](https://github.com/arduino/ArduinoCore-zephyr/blob/main/boards.txt), [platform.txt](https://github.com/arduino/ArduinoCore-zephyr/blob/main/platform.txt)
- The OpenOCD flash script uses `reset_config srst_only srst_nogate srst_push_pull connect_assert_srst` (OpenOCD drives the MCU NRST line). It writes:
  - the loader image (`filename0`) at its ELF addresses (0x08000000 per Molloy's verify log);
  - the sketch (`filename1`) at `0x8100000`, verifying first and erasing/writing only on mismatch;
  - after reset, `mww 0x40036400 0xCAFFEEEE`, then it clears DHCSR (`mww 0xE000EDF0 0xA05F0000`).
  — [flash_sketch.cfg](https://github.com/arduino/ArduinoCore-zephyr/blob/main/variants/arduino_uno_q_stm32u585xx/flash_sketch.cfg), [flash_bootloader.cfg](https://github.com/arduino/ArduinoCore-zephyr/blob/main/variants/arduino_uno_q_stm32u585xx/flash_bootloader.cfg)
- Restoring the Arduino loader after vanilla firmware: `adb shell arduino-cli burn-bootloader -b arduino:zephyr:unoq -P jlink`, or the same command without `adb shell` on the board itself. — [Zephyr board doc](https://docs.zephyrproject.org/latest/boards/arduino/uno_q/doc/index.html)
- The SWD pins are not exposed externally, so the MPU serves as the internal debug bridge. — [unoq-starter-mpu crate docs (snippet only)](https://docs.rs/unoq-starter-mpu)
- MCU NRST and BOOT0 are on the headers: JANALOG pin 1 `MCU_BOOT0` and pin 3 `MCU_NRST`; JSPI also carries MCU reset (NRST). — [UNO Q datasheet (docs-content source)](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/datasheet/en-datasheet.md)

**How App Lab uploads**
- `arduino-app-cli` has `legacyUploadSketchInRam`, which uploads with FQBN suffix `:flash_mode=ram`. If that fails, it first uploads an empty binary with `:flash_mode=flash`, because "This is required to be able to upload sketches in ram mode after if there is already a sketch in flash". It also knows the menu option `wait_linux_boot=app` ("WaitForApp"). — [sketch_flash.go](https://github.com/arduino/arduino-app-cli/blob/main/internal/orchestrator/sketch_flash.go)
- **Changed since launch:** core 0.53.1 had a `flash_mode` menu (Flash / RAM, using `flash_sketch_ram.cfg`). By 0.90.0 (July 2026) it was gone, replaced by `wait_linux_boot` = `yes` ("Wait for Linux") / `no` ("Immediate") / `app` ("Wait for App"). The `set-to-ram-mode.sh` script, still in the variant folder, says RAM mode "is volatile, so after a power cycle the micro will not execute the sketch anymore". — [boards.txt @0.53.1](https://github.com/arduino/ArduinoCore-zephyr/blob/0.53.1/boards.txt), [boards.txt @1.0.0](https://github.com/arduino/ArduinoCore-zephyr/blob/1.0.0/boards.txt), [set-to-ram-mode.sh](https://github.com/arduino/ArduinoCore-zephyr/blob/main/variants/arduino_uno_q_stm32u585xx/scripts/set-to-ram-mode.sh)
- The STM32 has no USB of its own. An uploaded binary goes over USB to Linux, and Linux writes it into the STM32 through its debug lines. — [mischianti.org getting started (snippet only)](https://mischianti.org/?p=36041)

### Inferences
- The QRB2210 GPIO handshake lines appear to map as follows. Only the gpiochip1/70 to PG13 link is strongly supported, by matching router config to loader code.
  - `gpiochip1` line 70 drives the MCU's PG13 ("Internal SPI RDY"). The loader reads `control-gpios[0]` as `mpu_booted` and keeps playing the boot animation until it goes high. The router sets 70=1 only after it is ready.
  - Line 38 is very likely MCU NRST (it is pulsed on router stop to "restart the boot animation").
  - Line 37 is likely BOOT0 or a similar strap held low.
- `0x40036400` is the STM32U5 backup-SRAM region. The loader declares `backup.wait_for_app_magic` in `__stm32_backup_sram_section`. Writing `0xCAFFEEEE` there after a flash most likely releases a "Wait for App" sketch immediately after upload. On a cold boot, something on the Linux side has to write that magic, probably App Lab when it starts an app; the mechanism was not traced.
- Because the MCU can be fully reflashed, reset and debugged from Linux, a Linux agent stack could in principle (re)deploy MCU firmware itself through `arduino-cli upload` or `remoteocd`. That is a powerful and dangerous capability to expose to an AI agent; it should be gated.
- RPMsg/OpenAMP does not apply: the chips share no memory and are linked only by UART, SPI, GPIO and SWD. Any "IPC" is a serial protocol.

### Gaps
- The exact contents of `/opt/openocd/openocd_gpiod.cfg` (which QRB2210 GPIO numbers carry SWDIO, SWCLK and NRST) were not retrieved. It is on the board image, not in the repos inspected.
- No official pin table for the gpiochip1 lines 37/38/70 was found. The mapping above is inferred.
- The Linux-side device for the internal SPI (a spidev node?) and whether the stock Debian image enables it are unverified. The Rust project below uses SPI, so it is usable.
- How App Lab sets the backup-SRAM "app ready" magic on a cold boot was not traced.

---

## 2. Arduino's MCU firmware: Zephyr-based core, LLEXT loader, memory, real-time behaviour

### Takeaway
The MCU runs a prebuilt Zephyr "loader" image from ArduinoCore-zephyr (Apache-2.0), now on an Arduino fork of Zephyr 4.4.2.
- The loader sits at the start of flash. It reads a sketch header from the second 1 MB flash bank (0x08100000) and either:
  - loads the sketch as a Zephyr LLEXT (ELF extension) in "dynamic" link mode, executing it from flash, or
  - jumps directly into a fully linked image in "static" mode.
- Sketches get the Arduino API plus whatever Zephyr symbols the loader exports, including devicetree devices.
- The full Zephyr kernel (threads, mutexes, dynamic interrupts) sits underneath, but there is no official real-time benchmark, and no Watchdog library ships with the core.

### Cited Findings
- The core describes itself as "Arduino Core based on Zephyr+llext" (Apache-2.0). — [ArduinoCore-zephyr](https://github.com/arduino/ArduinoCore-zephyr)
- Zephyr revision: `zephyr-arduino-v4.2.0` for core 0.51.0 through 0.90.0; `zephyr-arduino-v4.4.2` in 1.1.0. The 1.0.0 notes say "Zephyr 4.4.1 update". — [west.yml](https://github.com/arduino/ArduinoCore-zephyr/blob/main/west.yml), [1.0.0 release](https://github.com/arduino/ArduinoCore-zephyr/releases/tag/1.0.0)
- The UNO Q is in mainline Zephyr as board `arduino_uno_q`, status "Maintained". The hardware list says 2 MB flash and 786 KB RAM; the target section says 768 KiB, so the page contradicts itself. — [Zephyr board doc](https://docs.zephyrproject.org/latest/boards/arduino/uno_q/doc/index.html)
- MCU spec: Cortex-M33 up to 160 MHz, 2 MB flash, 786 KB SRAM, "It runs the Zephyr OS". — [user manual](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/tutorials/first-steps/user-manual/content.md)

**Loader behaviour** — [loader/main.c](https://github.com/arduino/ArduinoCore-zephyr/blob/main/loader/main.c)
- It reads and verifies a `sketch_header_v1` from the sketch flash area. An invalid header gives "Invalid sketch header" and a `recoverable_error_led()`.
- If the sketch is not flagged `SKETCH_FLAG_IMMEDIATE`, it plays a boot animation on the LED matrix until the `mpu_booted` GPIO goes high.
- If flagged `SKETCH_FLAG_WAIT_FOR_APP`, it then also polls `backup.wait_for_app_magic` every 100 ms.
- If `SKETCH_FLAG_LINKED`, it jumps directly to the sketch's entry point, passing the LLEXT heap.
- Otherwise it calls `llext_load(ldr, "sketch", &ext, &ldr_parm)` on an `LLEXT_BUF_LOADER` that points straight at flash. With `CONFIG_LLEXT_STORAGE_WRITABLE=n` the sketch is not copied to RAM.
- `SKETCH_RAM_BUFFER_LEN` is 131072, the legacy RAM-mode buffer. Core 0.53.1 notes "loader: unoq: increase ram buffer".

**Board menus**
- `link_mode` = Dynamic (default) / Static (`upload.extension=bin-zsk.bin`).
- `wait_linux_boot` = Wait for Linux / Immediate / Wait for App.
- Immediate mode was added in 0.52.0 ("unoq: enable menu for immediate mode"). — [boards.txt](https://github.com/arduino/ArduinoCore-zephyr/blob/main/boards.txt), [0.52.0 release](https://github.com/arduino/ArduinoCore-zephyr/releases/tag/0.52.0)

**Loader Kconfig** (`prj.conf`): `CONFIG_LLEXT=y`, `CONFIG_LLEXT_STORAGE_WRITABLE=n`, `CONFIG_LLEXT_EXPORT_DEVICES=y`, `CONFIG_LLEXT_RODATA_NO_RELOC=y`, `CONFIG_LLEXT_EDK=y` (extension development kit headers), `CONFIG_MAIN_STACK_SIZE=32768`, `CONFIG_HEAP_MEM_POOL_SIZE=32768`. — [loader/prj.conf](https://github.com/arduino/ArduinoCore-zephyr/blob/main/loader/prj.conf)

**UNO Q variant Kconfig in 1.1.0**
- Memory: `CONFIG_HEAP_MEM_POOL_SIZE=32768`, `CONFIG_LLEXT_HEAP_SIZE=256`.
- Peripherals: `CONFIG_FPU`, ADC/DAC/PWM, `CONFIG_I2C_TARGET`, I/D-cache, `CONFIG_DMA`, `CONFIG_SPI_ASYNC`, `CONFIG_SPI_SLAVE`, `CONFIG_CAN_FD_MODE`, `CONFIG_RTC_STM32`, `CONFIG_STM32_BACKUP_SRAM`.
- Threads and interrupts: `CONFIG_DYNAMIC_THREAD` (pool 2), `CONFIG_DYNAMIC_INTERRUPTS=y`, `CONFIG_SHARED_INTERRUPTS=y`.
- `CONFIG_ARM_MPU=n`, with the comment "ARMv8-M built-in stack guard provides HW_STACK_PROTECTION".
- At 0.51.0 the variant instead had `HEAP_MEM_POOL_SIZE=131072` and `LLEXT_HEAP_SIZE=128`. — [variant .conf @main](https://github.com/arduino/ArduinoCore-zephyr/blob/main/variants/arduino_uno_q_stm32u585xx/arduino_uno_q_stm32u585xx.conf), [@0.51.0](https://github.com/arduino/ArduinoCore-zephyr/blob/0.51.0/variants/arduino_uno_q_stm32u585xx/arduino_uno_q_stm32u585xx.conf)

**Robustness features added in 1.1.0 (Oct 2026):** "Enabled stack protection and null pointer detection", "Failures Dump Logs and new blink patterns for troubleshooting", "loader: blink error LED on sketch load failures and crashes", OTA plumbing in the loader (for other boards), and "Maaaaaany fixes for overall system stability". The flash scripts now keep "DWT null pointer hits raise DebugMonitor instead of halting". — [1.1.0 release](https://github.com/arduino/ArduinoCore-zephyr/releases/tag/1.1.0), [flash_sketch.cfg](https://github.com/arduino/ArduinoCore-zephyr/blob/main/variants/arduino_uno_q_stm32u585xx/flash_sketch.cfg)

**Threads and scheduling**
- The Bridge library creates a Zephyr thread "bridge" with `UPDATE_THREAD_STACK_SIZE 4096` and `UPDATE_THREAD_PRIORITY 5`.
- `provide_safe` callbacks run in the sketch's loop context via the weak `__loopHook()`.
- The 0.52.0 notes include "unoq: restore main thread priority to 5". — [bridge.h](https://github.com/arduino-libraries/Arduino_RouterBridge/blob/main/src/bridge.h), [0.52.0 release](https://github.com/arduino/ArduinoCore-zephyr/releases/tag/0.52.0)

**Libraries shipped with the core:** Arduino_LED_Matrix, CAN, Camera, Ethernet, OTA, PDM, RTC, SPI, SocketWrapper, Storage, WiFi, Wire, Zephyr_SDRAM, ea_malloc. There is no Watchdog library. — [ArduinoCore-zephyr libraries/](https://github.com/arduino/ArduinoCore-zephyr/tree/main/libraries)

**Community notes**
- A forum thread asks whether an LLEXT sketch can call functions exported from a custom precompiled Zephyr loader, for example for GPDMA ADC capture at 2.5 MS/s, and asks for a documented build and recovery procedure. No authoritative answer was found. — [forum (snippet only)](https://forum.arduino.cc/t/uno-q-simultaneous-adc1-adc4-timer-triggered-dma-capture-at-up-to-2-5-ms-s/1448253)
- A PlatformIO community platform builds sketches as Zephyr LLEXT modules against ArduinoCore-zephyr (release-candidate status). — [PlatformIO community (snippet only)](https://community.platformio.org/t/a-custom-development-platform-for-arduino-uno-q/54299)
- Molloy compares the two worlds:

  | | Arduino core | Vanilla Zephyr |
  |---|---|---|
  | MCU footprint | "The full core, always" | "32 KB: what you configured" |
  | Upload | "Sketch-only uploads (llext)" | "Full image per change" |

  — [Molloy](https://derekmolloy.ie/under-the-hood-of-the-arduino-uno-q-vanilla-zephyr-on-the-cortex-m33/)

### Inferences
- `CONFIG_LLEXT_HEAP_SIZE` is specified in KB in Zephyr, so roughly 256 KB of the 786 KB SRAM is reserved for LLEXT sections and relocations in 1.1.0. Combined with the 32 KB main stack and 32 KB kernel heap, a large share of SRAM is committed before user code runs. This is from the Kconfig; actual free RAM was not measured.
- What a sketch can touch is bounded by the loader's export table (`loader/llext_exports.c`, plus exported devicetree devices). Anything not exported, such as advanced DMA/ISR plumbing or possibly the Zephyr `wdt` API, needs either a custom loader (undocumented), "static" link mode, or abandoning the Arduino loader for vanilla Zephyr.
- Static link mode appears to give a fully linked sketch that the loader jumps into, which avoids LLEXT symbol limits but keeps the loader's boot/handshake behaviour. This was not tested.
- For hard real-time work, the MCU is a normal preemptive Zephyr system. Control loops should run in their own high-priority Zephyr thread or timer ISR, not in `loop()`, because `loop()` shares priority 5 with the bridge thread and must yield (see section 7).

### Gaps
- No official numbers were found for free RAM/flash available to sketches, interrupt latency, or jitter under the Arduino core.
- Whether Zephyr's watchdog (`wdt_*`) and counter/timer APIs are exported to LLEXT sketches was not verified. `llext_exports.c` was not inspected line by line.
- The exact flash partition map for loader and sketch beyond "sketch at 0x08100000" was not verified. Molloy notes the mainline board has an MCUboot-shaped table (64 KB boot, two 416 KB slots, 128 KB storage) that his vanilla build ignored.

---

## 3. The bridge: arduino-router + MessagePack-RPC (RPClite / RouterBridge on the MCU, Python/C++/others on Linux)

### Takeaway
`arduino-router` is a Go daemon (GPL-3.0) and a star-topology MessagePack-RPC router.
- It listens on the Unix socket `/var/run/arduino-router.sock` and optionally on TCP.
- It owns the MCU UART (`/dev/ttyHS1` at 115200 8N1) and treats it as just another client.
- Any client (the MCU sketch, Python apps, C++ programs) registers method names with `$/register`. The router forwards requests to the owning client and remaps message IDs.
- On the MCU, `Arduino_RouterBridge` (MPL-2.0) wraps `Arduino_RPClite` (MPL-2.0) and provides `Bridge.provide`, `provide_safe`, `call` and `notify`.
- On Linux, `arduino-router-bridge` (Python, MPL-2.0) provides `call` (with a timeout), `notify`, `provide` and `unprovide`, with auto-reconnect.
- Small-call round-trip latency is about 7–18 ms at 115200 baud depending on payload and method, about 8 ms at 460800. The serial link dominates the cost.

### Cited Findings
**Router protocol**
- "This module implements a MessagePack RPC Router that allows RPC calls between multiple MessagePack RPC clients, connected together in a star topology network, where the Router is the central node."
- Wire format is the msgpack-rpc spec: `[REQUEST(0), id, method, params]`, `[RESPONSE(1), id, error, result]`, `[NOTIFY(2), method, params]`.
- Example: `[REQUEST, 50, "$/register", ["ping"]]` gets `[RESPONSE, 50, null, true]`, or the error `[RESPONSE, 50, [5, "route already exists: ping"], null]`.
- "the request ID has been remapped by the Router: it keeps track of all active requests so the message IDs will not conflict between different clients."
- "When a client disconnects all the registered methods from that client are dropped." — [arduino-router README](https://github.com/arduino/arduino-router)

**Router built-in methods**
- Routing and control: `$/register`, `$/unregister` (added v0.11.0), `$/reset`, `$/serial/open`, `$/serial/close`, `$/setMaxMsgSize`, `$/version`.
- Monitor: `mon/connected`, `mon/read`, `mon/write`, `mon/reset`.
- Networking for the MCU through Linux: `tcp/connect`, `tcp/listen`, `tcp/accept`, `tcp/read`, `tcp/write`, `tcp/close`, `tcp/connectSSL`, `udp/*`.
- Bluetooth HCI passthrough: `hci/open`, `hci/send`, `hci/recv`, `hci/avail`, `hci/close`.
— [main.go](https://github.com/arduino/arduino-router/blob/main/main.go), [monitor-api.go](https://github.com/arduino/arduino-router/blob/main/internal/monitorapi/monitor-api.go), [network-api.go](https://github.com/arduino/arduino-router/blob/main/internal/network-api/network-api.go), [hci-api_linux.go](https://github.com/arduino/arduino-router/blob/main/internal/hciapi/hci-api_linux.go)

**Router CLI flags** (`--listen-port/-l`: TCP listener, off by default):
- `--unix-port/-u`, default `/var/run/arduino-router.sock`, overridable with `ARDUINO_ROUTER_SOCKET`
- `--serial-port/-p`, `--serial-baudrate/-b` (default 115200)
- `--monitor-port/-m`, default `127.0.0.1:7500`: TCP proxy for the MCU "Monitor" text stream
- `--after-ready`
- The serial port opens 8N1 with no flow-control option, and the router reopens it automatically, waiting on fsnotify. — [main.go](https://github.com/arduino/arduino-router/blob/main/main.go)

**Socket permissions and USB monitor**
- Since v0.11.0 the socket is chmod 0660 and chowned to group `arduino-router` ("Lower `arduino-router.sock` permissions / Added `arduino-router` group"). — [main.go](https://github.com/arduino/arduino-router/blob/main/main.go), [v0.11.0 release](https://github.com/arduino/arduino-router/releases/tag/v0.11.0)
- `arduino-router-serial.service` runs `socat file:/dev/ttyGS0,raw,echo=0,b9600,crtscts=0 tcp:127.0.0.1:7500`. This bridges the MCU Monitor stream to the USB gadget serial port seen by a host PC, only when `/dev/ttyGS0` exists. — [arduino-router-serial.service](https://github.com/arduino/arduino-router/blob/main/debian/arduino-router/usr/lib/systemd/system/arduino-router-serial.service)

**Router error codes:** 1 InvalidParams, 2 MethodNotAvailable, 3 FailedToSendRequests, 4 GenericError, 5 RouteAlreadyExists, 6 BufferLimitExceeded. — [errors.go](https://github.com/arduino/arduino-router/blob/main/internal/msgpackrouter/errors.go)

**Max message size**
- A peer can announce a cap with `$/setMaxMsgSize`; values must be greater than 127.
- Oversized CALLs get an immediate error, oversized NOTIFICATIONs are dropped, and oversized RESPONSEs are replaced by an error.
- Notifications to a method nobody registered are lost (router.go comment: "if the method is not registered, the notifitication is lost"). — [README](https://github.com/arduino/arduino-router), [router.go](https://github.com/arduino/arduino-router/blob/main/internal/msgpackrouter/router.go)

**Router changelog highlights**
- v0.8.0 (2026-03-26): max-message-size, `arduino-router-cli` tool, "post start command", VENTUNO ("monza") support.
- v0.8.1: "wait for usb serial".
- v0.9.0: start `arduino-router-serial` only if serial is available.
- v0.10.0 (2026-08-11): "RPC parameters and results are now forwarded byte-by-byte; re-encoding them could reorder the fields of objects, so routing is now fully transparent".
- v0.11.0 (2026-10-22): socket group, systemd units moved to `/usr/lib/systemd/system`, `$/unregister`.
- `$/version` was added in Nov 2025 (issue #10). — [releases](https://github.com/arduino/arduino-router/releases), [issues](https://github.com/arduino/arduino-router/issues?q=is%3Aissue)

**MCU library (Arduino_RouterBridge)**
- `Bridge.begin(baud=115200)` opens the router UART, which is `lpuart1` per the overlay.
- On UNO Q it first writes the string "MCU starting RPC Bridge communication" to "Flush broken RPCs from the previous run".
- It spawns the "bridge" update thread, then calls `$/reset` (blocking until the router answers) and notifies `$/setMaxMsgSize` with `BRIDGE_RPC_BUFFER_SIZE`.
- `provide()` calls `$/register` and binds a handler executed on the bridge thread. `provide_safe()` binds handlers executed from `__loopHook()` in the main loop.
- `RpcCall::result()` loops until a response arrives, with no timeout.
- `~RpcCall()` calls `result()`, so a discarded call still blocks.
- `notify()` is fire-and-forget.
— [bridge.h](https://github.com/arduino-libraries/Arduino_RouterBridge/blob/main/src/bridge.h), [README](https://github.com/arduino-libraries/Arduino_RouterBridge)
- Arduino's warnings:
  - "Calling `Bridge.call` from within an RPC callback may cause an MCU–CPU IPC deadlock". — [RouterBridge README](https://github.com/arduino-libraries/Arduino_RouterBridge)
  - "Do not use `Bridge.call()`, `Monitor.print()` or `Serial.print()` inside `provide()` functions." — [user manual](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/tutorials/first-steps/user-manual/content.md)

**RPClite sizing and errors**
- `#define DECODER_BUFFER_SIZE 1024`, `RPCLITE_MAX_TRANSPORTS 3`, and `DEFAULT_RPC_BUFFER_SIZE (DECODER_BUFFER_SIZE / 4)`.
- Peer error codes: `PARSING_ERR 0xFC`, `MALFORMED_CALL_ERR 0xFD`, `FUNCTION_NOT_FOUND_ERR 0xFE`, `GENERIC_ERR 0xFF`.
— [Arduino_RPClite.h](https://github.com/arduino-libraries/Arduino_RPClite/blob/main/src/Arduino_RPClite.h), [request.h](https://github.com/arduino-libraries/Arduino_RPClite/blob/main/src/request.h), [error.h](https://github.com/arduino-libraries/Arduino_RPClite/blob/main/src/error.h)

**Python client (arduino-router-bridge)**
- Default address `unix:///var/run/arduino-router.sock`. `tcp://host:port` "is meant for development and debugging only: it is unauthenticated and unencrypted".
- `connect(timeout)` keeps reconnecting in the background, and handlers are "re-registered transparently whenever it is re-established".
- Handlers run sequentially on one thread and must not call `call/provide/unprovide`; doing so raises `RuntimeError`.
- Limits: incoming messages are capped at 1 MiB and pending handler executions at 1024.
- Error mapping: `TimeoutError`, `ConnectionError`, and `RpcError(code, message)`. Codes 1–6 come from the router; 253/254/255 come from the peer (wrong params / no handler / handler failed).
- Security model: "The router socket is the trust boundary: any process that can connect to it can invoke the provided methods and forge RPC responses." — [arduino-router-bridge-py README](https://github.com/arduino/arduino-router-bridge-py)

**App Lab wrapper (`arduino.app_utils.Bridge`)**
- A process-wide singleton connected on first use to `APP_SOCKET` or the default address.
- It raises `AppError` if the router is not reachable within 5 s.
- `Bridge.call(method, *params, timeout=10)` defaults to 10 s. `Bridge.notify` is best-effort and "dropped if the router is not connected". — [app_utils/bridge.py](https://github.com/arduino/app-bricks-py/blob/main/src/arduino/app_utils/bridge.py)
- **Changed since launch:** App Lab originally embedded its own bridge. The standalone `arduino-router-bridge` package (repo created 2026-08-25, v0.5.1 vendored by bricks) is now the implementation. — [dep record](https://github.com/arduino/app-bricks-py/tree/main/.licenses/python-apps-base/pip), [repo metadata](https://github.com/arduino/arduino-router-bridge-py)

**Other languages**
- Arduino documents raw clients in C++ (with `libmsgpack-cxx-dev`, `AF_UNIX` socket and a background reader thread) and plain Python over the socket. It says "Multiple Linux processes can communicate with the MCU simultaneously". — [routerbridge-multilanguage tutorial (docs-content source)](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/tutorials/linux/routerbridge-multilanguage/content.md)
- Community clients: Dart (`arduino_bridge` on pub.dev), Elixir (`arduino_router_bridge_ex` on hex.pm), Node.js (`@raasimpact/arduino-uno-q-bridge`). — [pub.dev](https://pub.dev/documentation/arduino_bridge/1.0.2/), [hex.pm](https://readme.hex.pm/arduino_router_bridge_ex/0.1.3), [n8n project (snippet only)](https://projecthub.arduino.cc/linucs/n8n-workflow-automation-on-the-uno-q-sensors-gpio-and-ai-agent-control-8919bb)

**Latency and throughput (community measurements, no official figures found)**

| Baud | Small call p50 / p95 | Failures |
|---|---|---|
| 115200 | 18.07 / 19.04 ms | 0/5000 |
| 230400 | 11.33 / 12.96 ms | 0/5000 |
| 460800 | 8.32 / 8.88 ms | 0/5000 |
| 921600 | 5.58 / 6.43 ms (only 14 succeeded) | 486/500 |
| 2000000 | — | all failed |

- Setup for the table: router 0.10.0, RouterBridge 0.4.3, core 1.0.0, requests up to 96 characters. "roughly 70% of a 115200 call in serial transfer time". At 921600 and above the router logs "decoding packet: invalid packet, expected array", attributed to the missing flow control. — [arduino-router #75 (2026-11-05)](https://github.com/arduino/arduino-router/issues/75)
- Python call to the MCU over 10 calls (Jan 2026): raw latency min 6.72 / max 7.84 / avg 7.04 ms; a temperature-read call averaged 7.93 ms. With strings: about 8 ms at 10 chars versus about 14.3–14.5 ms at 80 chars, and a "speed hack" (higher baud) gave a 2–3x improvement. One reply says 460800 "is the max" (unverified by that poster). — [forum: Evaluated Uno Q Router/Bridge Latency](https://forum.arduino.cc/t/evaluated-uno-q-router-bridge-latency-with-max31855/1423998)
- A robot use case streamed 9-int (about 43-byte) Linux-to-MCU notifications at 100 Hz and MCU-to-Linux state notifications at 200 Hz at 460800 baud. It hit the decoder stall described in section 7. — [RPClite #43 comment](https://github.com/arduino-libraries/Arduino_RPClite/issues/43)

### Inferences
- By RPClite's formula the MCU-side RPC buffer is 256 bytes (1024/4), and `Bridge.begin()` announces it to the router. So single messages to or from the MCU are effectively limited to roughly 256 bytes, and larger ones get router error 6. This is derived from the source; not tested on hardware.
- Neither the router nor the MCU-side `RpcCall::result()` enforces a call timeout. Only Linux clients do (Python default 10 s). An MCU sketch that does `Bridge.call()` toward Linux can block forever if the Linux service dies, and so can a discarded `RpcCall`, because the destructor waits.
- One owner per method name and no pub/sub (issue #71 open) mean only one Linux process can provide a given MCU-callable method. Notifications from the MCU go to exactly one subscriber. An agent stack should therefore have a single Linux "MCU supervisor" daemon that owns the bridge names and fans out to MCP tools.
- Capacity: at 115200 baud (about 11.5 KB/s raw per direction) and about 7–18 ms per synchronous call, a single caller can do on the order of 50–140 sequential calls/s. Throughput-heavy data should be batched into one call or streamed as notifications.
- The MCP server process must run as root or in the `arduino-router` group (v0.11.0+). Anything with socket access is fully trusted.

### Gaps
- No official latency, throughput, or reliability specs from Arduino were found.
- The arXiv paper cited in #75 (arXiv:2611.01598, "QFabric") was not read. Its results are unverified here.
- Ordering and fairness under multiple concurrent clients (head-of-line blocking on the single UART) was not measured in any source found.

---

## 4. Alternatives to the stock bridge and stock firmware

### Takeaway
Two alternatives are documented as working on the UNO Q:
- **Vanilla Zephyr** (`west build -b arduino_uno_q`, debug and flash through the on-board OpenOCD/adb), which drops the loader, App Lab and the Bridge.
- **A Rust-on-Zephyr stack** that replaces the UART bridge with MessagePack-RPC over the internal SPI plus a custom Linux "arduino-spi-router".

No UNO Q-specific evidence was found for embassy, STM32Cube bare-metal, micro-ROS, Firmata or Modbus RTU on the MCU, though the SWD/OpenOCD path makes any STM32U585 firmware technically flashable. OpenAMP/RPMsg does not apply (separate chips, no shared memory).

### Cited Findings
- **Mainline Zephyr board:**
  - `arduino_uno_q`, "a current Zephyr workspace ... builds for it out of the box", with device tree "maintained upstream, some of it by Qualcomm engineers".
  - Verified by Molloy against "Zephyr 4.4.99" and Zephyr SDK 1.0.1: "any Zephyr from 4.3-ish with the arduino_uno_q board will do".
  - Cost: "The Bridge to Linux ... Gone: yours to rebuild if needed"; "at this level the internal UART is just a UART, and structured communication is yours to design".
  - "the whole exercise is reversible to the Arduino ecosystem with one documented command". — [Molloy](https://derekmolloy.ie/under-the-hood-of-the-arduino-uno-q-vanilla-zephyr-on-the-cortex-m33/)
- Zephyr board page runners: `jlink`, `openocd` (debug), `stm32cubeprogrammer` (flash) for external probes. The on-board adapter is "not yet integrated with the `west flash` command". — [Zephyr board doc](https://docs.zephyrproject.org/latest/boards/arduino/uno_q/doc/index.html)
- **Rust:**
  - "Rust ports of Arduino libraries for the Arduino Uno Q (STM32U585) using Zephyr RTOS". MCU and MPU "communicate via **SPI** (primary) or UART (legacy), using MessagePack-RPC protocol".
  - Linux side: "arduino-spi-router (SPI controller + Unix socket)" running as a systemd service, flashed with `make flash` via ADB. Includes an LED-matrix RPC server and a PQC demo.
  - Dual Apache-2.0/MIT. Created 2026-03-12, last push 2026-03-18 (appears dormant). — [FeurJak/arduino-libraries-rust](https://github.com/FeurJak/arduino-libraries-rust), [Hackster coverage](https://www.hackster.io/news/taras-woronjanski-turns-to-the-zephyr-rtos-to-make-the-arduino-uno-q-a-little-rusty-10125eac7167)
- `unoq-starter-mpu` crate targets `thumbv8m.main-none-eabihf` for the MCU and cross-compiles the MPU side. — [docs.rs (snippet only)](https://docs.rs/unoq-starter-mpu)
- Other listings that exist but were not read: TinyGo has a UNO Q reference page, and Edge Impulse has an "arduino-unoq-zephyr" tutorial. — [TinyGo (search result only)](https://tinygo.org/docs/reference/microcontrollers/featured/arduino-uno-q/), [Edge Impulse (search result only)](https://docs.edgeimpulse.com/tutorials/topics/zephyr/arduino-unoq-zephyr)
- An early forum reply claims users cannot load their own Zephyr build onto the MCU. This is contradicted by the mainline Zephyr board support and Molloy's 2026 walkthrough. — [forum CAN thread (snippet only)](https://forum.arduino.cc/t/uno-q-can-library/1416035); contradicted by [Zephyr board doc](https://docs.zephyrproject.org/latest/boards/arduino/uno_q/doc/index.html)
- **Research runtime:** QFabric (Apache-2.0) is "Research runtime for contract-driven recovery across Linux and RTOS execution domains on the Arduino UNO Q". It can move a bounded function between Linux and the MCU: "observe → detect → check safety → switch → verify → commit or roll back", waiting for a "zero-inflight epoch boundary". It claims no hard real-time certification. — [elixpo/qfabric](https://github.com/elixpo/qfabric)
- **Modbus:** only a forum question about Modbus TCP (Linux-side networking) was found, with no answer in the snippets. — [forum (snippet only)](https://forum.arduino.cc/t/arduino-uno-q-modbus-tcp/1414776)
- **ROS 2:** Arduino's tutorials run ROS 2 (rclpy) on the Linux side. No micro-ROS on the MCU was found. — [ROS 2 first project (docs-content source)](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/tutorials/robotics/ros2-first-project/ros2-first-project.md)

### Inferences
Options for a custom MPU-to-MCU control pipeline, in order of effort and risk:
1. **Keep the stock router and Bridge, harden the edges.**
   - Opt into 460800 baud on both sides (`Bridge.begin(460800)` plus a router drop-in with `--serial-baudrate 460800`).
   - Run a single Linux supervisor client.
   - Put interlocks, heartbeat and watchdog on the MCU (section 5).
   - Watch the decoder-resync fix: RPClite PR #45 `reset()` and the 0.4.0 RC.
   - Lowest effort, keeps App Lab compatibility. Residual risk is the unframed, no-CRC stream.
2. **Keep Arduino core and loader, replace the transport.**
   - Stop `arduino-router` (or point it at no serial port).
   - Write your own Linux daemon on `/dev/ttyHS1` with COBS/SLIP framing, CRC, sequence numbers and acks, plus a matching sketch that uses `Serial`/lpuart1 directly.
   - App Lab bricks that expect the router break.
3. **Vanilla Zephyr firmware** (C or Rust) with your own protocol over lpuart1, ideally enabling the wired RTS/CTS, and/or SPI3 slave plus the PG13 ready line.
   - Full control of threads, IWDG, DMA and priorities.
   - Loses App Lab orchestration and sketch-only uploads. Reversible with `burn-bootloader`.
   - Protobuf/nanopb is in the Arduino west manifest allowlist (`nanopb`), so it is a natural payload format.
4. **Rust embassy or STM32Cube bare-metal:** feasible via the same OpenOCD/SWD path, but no UNO Q examples were found. You would have to recreate the board pin map and boot handshake yourself.
- MessagePack-RPC is still a reasonable payload format for agent-driven control. The weakness is the lack of framing and integrity checks on the UART, not the encoding.

### Gaps
- No UNO Q reports were found for embassy, STM32Cube, micro-ROS, Firmata, or Modbus RTU.
- Whether the stock Linux device tree exposes a spidev for the internal SPI, and whether the Linux UART driver supports RTS/CTS on ttyHS1, is unverified. The Rust project implies SPI works.

---

## 5. Patterns for safe, deterministic control (real-time loops, interlocks, watchdogs, failsafe)

### Takeaway
Arduino publishes no specific safety, failsafe or heartbeat guidance for the UNO Q beyond "MCU handles time-critical tasks", the deadlock warnings, and threading notes. The building blocks exist:
- the STM32 IWDG, enabled in the mainline devicetree;
- Zephyr threads and priorities;
- `notify` for one-way traffic;
- the router's GPIO ready line and reset control from Linux.

The safety architecture has to be designed by the integrator.

### Cited Findings
- Arduino's framing: "MCU side (STM32, Zephyr RTOS): Handles time-critical tasks and exposes functions to the MPU via RPC". Use `provide_safe` "if your function interacts with standard Arduino APIs (like `digitalWrite` or `Serial`) to avoid concurrency crashes". — [user manual](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/tutorials/first-steps/user-manual/content.md)
- The mainline devicetree enables `&iwdg` with alias `watchdog0`, and the Zephyr board page lists "watchdogs" among supported features. — [arduino_uno_q-common.dtsi](https://github.com/zephyrproject-rtos/zephyr/blob/main/boards/arduino/uno_q/arduino_uno_q-common.dtsi), [Zephyr board doc](https://docs.zephyrproject.org/latest/boards/arduino/uno_q/doc/index.html)
- For a carrier-board "ready" indicator, the datasheet suggests firmware "can dedicate a 1.8V MPU GPIO on JMISC, or an available JCTL GPIO, as a ready or wake output", received on an MCU GPIO through a level shifter or open-drain plus pull-up. It adds that "activity on the selected transport (USB CDC, UART, or SPI) can serve as a wake source". — [datasheet](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/datasheet/en-datasheet.md)
- `Bridge.begin()` waits for the router with no timeout ("returns only when arduino-router is active"). Open issue: "Bridge must check Linux is ready before begin". — [mischianti.org (snippet only)](https://mischianti.org/?p=36479), [RouterBridge #30](https://github.com/arduino-libraries/Arduino_RouterBridge/issues/30), [bridge.h](https://github.com/arduino-libraries/Arduino_RouterBridge/blob/main/src/bridge.h)
- A non-yielding `loop()` starves the bridge thread: "`delay(1)` was insufficient, `delay(5)` was sufficient to unblock it". — [RouterBridge #76](https://github.com/arduino-libraries/Arduino_RouterBridge/issues/76)
- Linux-side tools exist: the router restarts on failure (`Restart=always`, `RestartSec=3`), and `sudo systemctl restart arduino-router` is Arduino's documented fix for "If the communication seems stuck". — [arduino-router.service](https://github.com/arduino/arduino-router/blob/main/debian/arduino-router/usr/lib/systemd/system/arduino-router.service), [user manual](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/tutorials/first-steps/user-manual/content.md)
- A community robot project patched RPClite with a resync on the rpclib array-plus-type signature "so for us the stall can't come back". — [RPClite #43](https://github.com/arduino-libraries/Arduino_RPClite/issues/43)

### Inferences (recommended pattern for an agent-driven pipeline)
- **Agent layer (MCP tools) to Linux supervisor:**
  - Tools issue high-level, bounded intents ("move to X at max speed V", "set heater target T"), never raw PWM or pin writes.
  - The supervisor validates schema, ranges and units, rate-limits per tool, and logs every command with an ID.
  - Expose only an allow-listed set of MCU methods. The router's own socket gives any client full power, so do not hand the socket to the agent.
- **Supervisor to MCU:**
  - Use `notify` for setpoints with a monotonically increasing sequence number and TTL.
  - Use `call` only for queries and acknowledgements, with short Linux-side timeouts (100–500 ms rather than the 10 s default).
  - Send a heartbeat notify at a fixed rate (for example 10–20 Hz).
- **MCU:**
  - Run the control loop in a dedicated high-priority Zephyr thread or timer ISR, independent of the bridge thread.
  - Clamp every setpoint to hard-coded limits (interlocks live only in MCU code) and ramp-limit changes.
  - Drop stale or out-of-order sequence numbers.
  - On heartbeat loss (for example more than 3 missed periods), go to a defined safe state and latch until an explicit re-arm.
  - Feed the IWDG only from the control thread when all health checks pass.
  - Never `Bridge.call` from the control path, since `RpcCall::result()` has no timeout.
  - Optionally watch the PG13 "MPU ready" line: the router drives it low on stop (`ExecStopPost ... 70=0`), which gives a hardware "Linux side went away" signal.
- **Recovery ladder from Linux:**
  1. Restart `arduino-router`.
  2. Pulse MCU reset (gpiochip1 line 38 or OpenOCD `reset`). The line-38 mapping is inferred.
  3. Reflash the known-good sketch with `remoteocd`.
  Reserve 2 and 3 for the supervisor, not the agent.

### Gaps
- No official Arduino example of heartbeat/failsafe or IWDG use on the UNO Q was found, and no Watchdog library ships with the Arduino core.
- Whether the Zephyr `wdt` API is callable from an LLEXT sketch was not verified.

---

## 6. Peripheral access from Linux directly (which pins/buses are wired to the QRB2210)

### Takeaway
Essentially all maker-facing I/O is wired to the STM32: the UNO R3 headers, JSPI/ICSP, and 25 JMISC pins, 47 MCU digital pins in total. Linux owns:
- the 1.8 V SoC GPIOs on JMISC, which Arduino labels "interface-dedicated (not maker GPIO)";
- JMEDIA (MIPI-CSI/DSI camera and display, plus CCI I2C);
- JCTL (console UART and boot/reset straps);
- the RGB LEDs 1 and 2 via `/sys/class/leds`;
- USB-C.

Linux can use libgpiod (the router itself drives `/dev/gpiochip1` with `gpioset`), but for headers and shields the MCU, reached through an RPC layer, is the intended path.

### Cited Findings
- "The UNO Q has 47x digital pins controlled by the **STM32 microcontroller**, 22x of them exposed through the UNO-styled connector and 25x exposed through JMISC connector". — [user manual](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/tutorials/first-steps/user-manual/content.md)
- "LEDs #1 and #2 are controlled by the MPU", via `/sys/class/leds` (for example `/sys/class/leds/red:user/brightness`). "LED 2 is used to show system status: `PANIC`, `WLAN` and `BT`". — [user manual](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/tutorials/first-steps/user-manual/content.md)
- LED-to-SoC GPIO mapping:
  - LED1: `red:user` = GPIO_41, `green:user` = GPIO_42, `blue:user` = GPIO_60.
  - LED2: `red:panic` = GPIO_39, `green:wlan` = GPIO_40, `blue:bt` = GPIO_47.
  — [datasheet](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/datasheet/en-datasheet.md)
- JMISC carries 1.8 V MPU pins (`SOC_GPIO_0_SE0`, `SOC_GPIO_1_SE0`, `SOC_GPIO_2_SE0`, `SOC_GPIO_3_SE0`, `SOC_GPIO_86_SE0`, `SOC_GPIO_98`, `SOC_GPIO_82_SE0`, `SOC_GPIO_99`, `SOC_GPIO_18`, `SOC_GPIO_100`, `SOC_GPIO_28`, `SOC_GPIO_101`, among others) next to 3.3 V MCU signals (for example `MCU_I2C4_SCL/SDA` on PF14/PF15). Note: "SoC GPIO lines on JMISC are interface-dedicated (not maker GPIO). MCU are at 3.3 V logic, MPU are at 1.8 V logic". — [datasheet](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/datasheet/en-datasheet.md)
- "Do not use the Qualcomm Dragonwing QRB2210 lines reserved for I²C, JMEDIA CCI (Camera Control Interface), or MI2S0 (I²S audio bus) as general-purpose I/O ... reserved in the Linux device tree."
  - JCTL is 1.8 V with "SE4 UART console", "Forced USB boot input", and "PMIC reset input".
  - JMEDIA is MIPI-DSI/CSI with the CCI I²C "dedicated, not general-purpose GPIO".
  - JSPI is 3.3 V MCU SPI (MISO PC2, MOSI PC3) plus MCU NRST. — [datasheet](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/datasheet/en-datasheet.md)
- `gpioset -c /dev/gpiochip1` is used by the stock router service, so libgpiod tools are on the image and gpiochip1 holds the MCU control lines. — [10-imola.conf](https://github.com/arduino/arduino-router/blob/main/debian/arduino-router/var/lib/arduino-router/config/10-imola.conf)

### Inferences
- An agent wanting to touch shield or header hardware has to go through MCU firmware. Direct Linux GPIO is limited to a handful of 1.8 V JMISC SoC lines, which need level shifting for 3.3 V/5 V parts, and the status LEDs.
- An agent stack must not let tools freely toggle `/dev/gpiochip1`. Lines 37, 38 and 70 control the MCU's boot/ready/reset state, and SWD lines are bit-banged there too. Consider udev rules or a dedicated group to keep agent processes off gpiochip1.

### Gaps
- No Arduino doc was found mapping Linux `gpiochipN`/line offsets to JMISC SOC_GPIO pins, and no doc on whether Linux exposes a spidev or i2c-dev on headers.
- Which bus the Qwiic connector uses (MCU I2C instance) was not verified in this pass.

---

## 7. Known issues and complaints (GitHub and forum)

### Takeaway
The biggest reliability risk is the "bridge wedge". The UART stream is unframed MessagePack with no CRC and no flow control at 115200, and RPClite's decoder can permanently stall, or with certain bytes crash, after a single corrupted byte. The sketch keeps running while the bridge goes silent until a restart. This is acknowledged by the maintainer and only partially mitigated: core 1.0.0 enlarged the serial buffer, and a `reset()` PR and RPClite 0.4.0 RC are open. Other recurring issues are blocking semantics (no timeouts on the MCU side, deadlocks from nested calls), loop starvation, Monitor quirks, and missing pub/sub and auth.

### Cited Findings
**RPClite decoder stall**
- RPClite #43 (open, 2026-06-15): "The wire protocol is unframed — there is no length prefix or delimiter". A dropped or corrupted byte "leaves the decoder unable to recover ... all subsequent RPC traffic is lost until the device restarts". Byte `0xC1` or a garbage `str32`/`array32` length can drive the unpacker to huge allocations, causing a hard fault or hang. This "appears to be the mechanism behind the Arduino UNO Q 'bridge wedge'".
- The maintainer (eigen-value) replied that "these limitations in stream robustness were admittedly the trade-off for keeping the footprint small" and proposed a resync on rpclib array signatures.
- A user hit it in normal robot operation (100 Hz/200 Hz notifications, 460800 baud). The maintainer noted "the ring buffer was increased in Core 1.0.0 exactly to lower the likelihood of loss events". — [RPClite #43](https://github.com/arduino-libraries/Arduino_RPClite/issues/43)
- Open RPClite PRs: #45 "Add reset() to drop buffered data and parsing state" (2026-10-14), #46 "Add unbind method", #47 "Ver 0 4 0 rc" (2026-10-30). — [RPClite PRs](https://github.com/arduino-libraries/Arduino_RPClite/pulls)
- Earlier RPClite fixes: 0.3.0 (2026-05-25), "Decoders can skip plain ascii codes during parsing"; 0.2.1, "decoder.h can pick 1st available response anywhere in the buffer". — [RPClite releases](https://github.com/arduino-libraries/Arduino_RPClite/releases)

**Router issues** — [arduino-router issues](https://github.com/arduino/arduino-router/issues)
- #16 "Add control flow to serial (UART) connection", open since 2025-11-19.
- #75 baud bottleneck (115200 default; 460800 measured clean).
- #71 "add a pub/sub feature to allow multiple parties to subscribe to same notifications" (open).
- #49 "--listen-port: what's the intended auth / trust model for the TCP listener?" (open).
- #20 "Rationalize error codes from internal API" (open).
- #55, closed: the router reordered map keys, fixed in v0.10.0 by byte-transparent forwarding.

**RouterBridge issues** — [RouterBridge issues](https://github.com/arduino-libraries/Arduino_RouterBridge/issues)
- #76 (open): `.begin()` on a second hardware UART "permanently breaks the Bridge's RPC channel" (core 0.90.0 / RouterBridge 0.4.3). A maintainer could not reproduce it on core 1.0.0 with RPClite 0.3.1.
- #30 (open): "Bridge must check Linux is ready before begin".
- #77, closed: "Limited stack space defined in bridge.h causing problems with Zephyr Networking: Server sockets".
- #79 (open): BridgeTCPClient API differences.
- Closed Monitor bugs: #37 "Monitor hangs forever", #38 "Monitor begin crashes the STM32 uC", #52 "Output sent via `Monitor` object arrives out of order and corrupted".

**Forum reports**
- No documented way to read MCU Monitor output from a pure CLI session without App Lab; the user tried the socket method `mon/read`. — [forum](https://forum.arduino.cc/t/title-arduino-uno-q-cannot-read-serial-monitor-output-via-cli-without-app-lab/1438432)
- A 3 ms wait around `rpc.result()` is "not enough for Bridge.call response". — [forum (snippet only)](https://forum.arduino.cc/t/uno-q-overview-of-bidirectional-data-transfer-between-mcu-and-mpu-via-router-bridge/1446178)
- A user did not learn "what happened to the router bridge" after an App Lab 0.4.0 fix. — [forum (snippet only)](https://forum.arduino.cc/t/my-uno-q-is-not-doing-well-in-app-lab-0-4-0/1429436)
- Hangs when `Monitor.begin()` and a sensor `begin()` are combined. — [forum (snippet only)](https://forum.arduino.cc/t/issues-witho-monitor-and-bridge/1416857)

### Inferences
- The router's Monitor proxy is plain TCP on `127.0.0.1:7500` (`--monitor-port`), so `nc 127.0.0.1 7500` on the board should show the sketch's Monitor stream without App Lab. This is derived from monitor-api.go and not tested; it may be the answer the forum user was missing.
- For an AI-agent pipeline, assume the bridge can silently wedge. The Linux supervisor should run an end-to-end liveness probe (a periodic `call("ping")` with a short timeout) and escalate automatically: router restart, then MCU reset. The MCU should failsafe on heartbeat loss rather than rely on Linux to notice.
- Many launch-era (Oct–Dec 2025) complaints, such as Monitor crashes, key reordering, and the missing version RPC, are fixed. The decoder-resync and flow-control issues remain open as of Nov 2026.

### Gaps
- No Arduino statement was found on a timeline for UART flow control, baud negotiation, or the RPClite 0.4.0 release.
- Forum threads were mostly seen as search snippets. The Arduino forum blocks automated fetching (HTTP 403) except via the Discourse JSON endpoint used for the latency thread.
