# Arduino UNO Q: Hardware and Stock (Official) Software Stack, as of November 2026

Research date: 2026-11-08. Primary sources were Arduino's own docs (read from the `arduino/docs-content` GitHub source, because docs.arduino.cc pages often render empty to fetchers), the GitHub API for the `arduino` org, Arduino's live image manifests on downloads.arduino.cc, and the mainline Linux tree. Secondary sources were CNX Software, Jeff Geerling, Tom's Hardware, Hackster, The Register and the Arduino forum. "NOW" means verified against a live source in Nov 2026. "LAUNCH-ONLY" means it was true in Oct 2025 and has since changed.

## 1. Exact hardware (SoC, memory SKUs, MCU, wireless, connectors, power, LED matrix, MPU and MCU wiring)

### Takeaway
The UNO Q (codename "Imola") pairs a Qualcomm Dragonwing QRB2210 (4x Cortex-A53 @ 2.0 GHz, Adreno 702, Hexagon v66 DSP; the "Agatti" family, the same SoC as the Qualcomm RB1) with an STM32U585 Cortex-M33 MCU. It ships in two SKUs: ABX00162 (2 GB / 16 GB) and ABX00173 (4 GB / 32 GB, launched Jan 2026). There is no newer UNO Q SKU. The MPU and MCU are joined by a UART (`/dev/ttyHS1`, used by arduino-router), an SPI link (spidev), and MPU GPIOs that bit-bang SWD plus NRST, so Linux can reflash the MCU through OpenOCD.

### Cited Findings
**SoC / MPU**
- The SoC is the Qualcomm Dragonwing QRB2210: 4x Arm Cortex-A53 @ 2.0 GHz (64-bit), Adreno 702 GPU @ 845 MHz, and dual ISPs (13 MP + 13 MP, or 25 MP @ 30 fps). The I/O runs at 1.8 V — [UNO Q datasheet (docs-content source)](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/datasheet/en-datasheet.md); [docs.arduino.cc product page](https://docs.arduino.cc/hardware/uno-q/)
- GPU API support: OpenGL ES 3.1, Vulkan 1.1, OpenCL 2.0. The DSP is a Hexagon QDSP6 v66. The VPU does 1080p30 encode and decode — [CNX Software launch article, 2025-10-07](https://www.cnx-software.com/2025/10/07/qualcomm-acquires-arduino-introduces-arduino-uno-q-dual-brain-sbc/)
- Mainline Linux describes the board as `qrb2210-arduino-imola.dts`. It sits next to `agatti.dtsi` and `qrb2210-rb1.dts`, which confirms it belongs to the Agatti/QCM2290 family and shares a lineage with the Qualcomm RB1 — [torvalds/linux arch/arm64/boot/dts/qcom](https://github.com/torvalds/linux/tree/master/arch/arm64/boot/dts/qcom)
- The PMIC is a Qualcomm **PM4125** per the datasheet, the Yocto config, and a mainline DT commit ("Fix pm4125 vbus regulator compatible", July 2026). The user manual says **PM4145**, which is probably a typo — [datasheet](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/datasheet/en-datasheet.md); [user manual source](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/tutorials/first-steps/user-manual/content.md); [mainline commit log for the imola DTS](https://github.com/torvalds/linux/commits/master/arch/arm64/boot/dts/qcom/qrb2210-arduino-imola.dts)
- An ANX7625 bridge converts MPU MIPI-DSI to DisplayPort Alt-Mode on the USB-C port — [datasheet](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/datasheet/en-datasheet.md)

**Memory / storage SKUs**
- ABX00162 = 2 GB RAM + 16 GB eMMC. ABX00173 = 4 GB RAM + 32 GB eMMC — [CNX Software](https://www.cnx-software.com/2025/10/07/qualcomm-acquires-arduino-introduces-arduino-uno-q-dual-brain-sbc/)
- The datasheet specifies the RAM as **LPDDR4X**, single-rank, 32-bit. The user manual and press coverage say "LPDDR4" — [datasheet](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/datasheet/en-datasheet.md); [user manual](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/tutorials/first-steps/user-manual/content.md)
- The 4 GB / 32 GB variant was announced 2026-01-20 at $59 — [Arduino blog](https://blog.arduino.cc/2026/01/20/arduino-uno-q-is-now-available-with-4gb-ram-and-32gb-storage/); [CNX Software 2026-01-21](https://www.cnx-software.com/2026/01/21/arduino-uno-q-4gb-board-with-4gb-ram-32gb-storage-available-59/)
- Prices rose effective 2026-07-06: 2 GB from $44 to $59, 4 GB from $59 to $79. Coverage attributes this to memory costs — [Arduino blog, 2026-06-26](https://blog.arduino.cc/2026/06/26/a-heads-up-on-the-arduino-uno-q-board-pricing-straight-from-marcello-majonchi/); [CNX Software](https://www.cnx-software.com/2026/01/21/arduino-uno-q-4gb-board-with-4gb-ram-32gb-storage-available-59/). **LAUNCH-ONLY:** the $44 launch price.
- Arduino recommends the 4 GB board for SBC/standalone use ("use a board with at least 4 GB of RAM") — [App Lab standalone setup doc](https://github.com/arduino/docs-content/blob/main/content/software/app-lab/1.setup/5.standalone/standalone.md)

**MCU**
- STM32U585: Cortex-M33 up to 160 MHz, 2 MB flash, 786 KB SRAM, FPU. It runs Arduino sketches on Zephyr OS — [docs product page](https://docs.arduino.cc/hardware/uno-q/); [user manual](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/tutorials/first-steps/user-manual/content.md)
- 47 MCU GPIOs: 22 on the UNO headers (JDIGITAL/JANALOG) and 25 on JMISC. 6 PWM, 16 interrupts, 3 USART + 2 UART, 4 I2C, 3 SPI, CAN FD, PSSI, 2 SAI, 6x 14-bit ADC, 2x 12-bit DAC, 2 op-amps. MCU I/O is 3.3 V (5 V tolerant on some pads) — [CNX Software](https://www.cnx-software.com/2025/10/07/qualcomm-acquires-arduino-introduces-arduino-uno-q-dual-brain-sbc/); [datasheet](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/datasheet/en-datasheet.md)

**Wireless**
- Module: **WCBN3536A**, Wi-Fi 5 802.11a/b/g/n/ac dual-band plus Bluetooth 5.1, shared PCB antenna. Wi-Fi uses SDIO and BT uses a UART — [datasheet](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/datasheet/en-datasheet.md)
- **Conflict on the underlying Qualcomm chip.** The datasheet says "WCBN3536A (Qualcomm **WCN3980**)". Arduino's Yocto layer HARDWARE.md lists "WCNBN3536A (**WCN3950**)" with **BT 5.0** — [datasheet](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/datasheet/en-datasheet.md); [meta-arduino HARDWARE.md](https://github.com/arduino/meta-arduino/blob/master/HARDWARE.md)

**Connectors**
- **USB-C (JUSB1):** USB 3.1 Gen 1 (5 Gb/s) with role switching, DisplayPort Alt-Mode through the ANX7625, and a 5 V / 3 A sink. Over a USB-C hub with PD you get HDMI, USB HID, Ethernet, storage and audio. Apple USB-C AV adapters are explicitly incompatible — [user manual](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/tutorials/first-steps/user-manual/content.md); [datasheet](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/datasheet/en-datasheet.md)
- **JMEDIA (60-pin, 1.8 V):** MIPI-DSI and MIPI-CSI-2 lanes ("four-lane camera and display signals"), CCI I2C, SOC_CAM_MCLK0/1, and VIN — [datasheet](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/datasheet/en-datasheet.md). CNX describes the media side as dual MIPI CSI camera plus MIPI DSI — [CNX Software](https://www.cnx-software.com/2025/10/07/qualcomm-acquires-arduino-introduces-arduino-uno-q-dual-brain-sbc/)
- **JMISC (60-pin, mixed 1.8 V / 3.3 V):** MCU PSSI, SDMMC1, TRACE, I2C4, MCO, OPAMP1. Up to about 12 MPU GPIOs (e.g. SOC_GPIO_0/1/2/3/18/28/82/86/98-101). Audio: Mic2, headphone L/R, line out, ear out — [datasheet](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/datasheet/en-datasheet.md)
- **JCTL (10-pin, 1.8 V):** SE4 UART system console (115200 baud, 1.8 V, shows SPL/U-Boot/kernel logs), a forced-USB-boot input (`USB_BOOT`, shorted to GND to enter EDL), PMIC reset input, and VBUS power-switch disable — [datasheet](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/datasheet/en-datasheet.md); [user manual](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/tutorials/first-steps/user-manual/content.md)
- **JSPI (6-pin):** MCU SPI (PC2 MISO, PC3 MOSI), MCU NRST, GND, 5V_SYS. **Qwiic:** I2C4 on PD13/PD12, 3.3 V — [datasheet](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/datasheet/en-datasheet.md)
- Carriers: Arduino documents a UNO Media Carrier and a UNO Breakout Carrier. Camera and display overlays are selected with the `arduino-linux-config` CLI (e.g. `carrier enable media-carrier camera1=type1-2lanes display=8-dsi-touch-a`) — [arduino-linux-config README](https://github.com/arduino/arduino-linux-config); [docs-content tree](https://github.com/arduino/docs-content/tree/main/content/hardware/uno/carriers)

**Power**
- Inputs: USB-C 5 V / 3 A (requests only the 5 V PD contract, no higher voltages), VIN 7-24 V via an onboard buck, or the 5V_SYS pin. USB VBUS and the buck output are diode-OR'd onto 5V_SYS. Operating temperature is -10 to 60 °C — [datasheet](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/datasheet/en-datasheet.md)
- Measured draw: about 0.5 W idle and 2-3 W at full load. The MCU cannot run on its own: shutting Linux down simply powers the board back up — [Jeff Geerling, 2025-10-31](https://www.jeffgeerling.com/blog/2025/arduino-uno-q-weird-hybrid-sbc)
- Power button: a 5+ second press reboots Linux. The board boots automatically when power is applied — [user manual](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/tutorials/first-steps/user-manual/content.md)

**LEDs**
- An 8x13 (104-pixel) **monochrome blue** LED matrix driven by the STM32. It shows the boot logo for about 20-30 s during Linux startup. Grayscale is set with `setGrayscaleBits()` (3-bit / 8 levels in the docs example; 8-bit is also shown) — [datasheet](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/datasheet/en-datasheet.md); [user manual](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/tutorials/first-steps/user-manual/content.md). CNX's launch article called it an "RGB LED matrix", which is wrong per the datasheet — [CNX Software](https://www.cnx-software.com/2025/10/07/qualcomm-acquires-arduino-introduces-arduino-uno-q-dual-brain-sbc/)
- 4 RGB LEDs. LEDs 1-2 are on the MPU and exposed in Linux as `/sys/class/leds/{red,green,blue}:user` and `red:panic`, `green:wlan`, `blue:bt`. LEDs 3-4 are on MCU GPIOs — [user manual](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/tutorials/first-steps/user-manual/content.md)

**MPU and MCU interconnect (stock wiring as seen from Linux)**
- UART: arduino-router opens `/dev/ttyHS1` at 115200 baud and serves a Unix socket at `/var/run/arduino-router.sock`. Users are told never to open `/dev/ttyHS1` themselves — [user manual](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/tutorials/first-steps/user-manual/content.md)
- The stock systemd unit runs `gpioset -c /dev/gpiochip1 -t0 37=0` before starting ("Put the micro in a ready state"). After starting it runs `gpioset ... 70=1` ("End the boot animation after the router is started") — [user manual](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/tutorials/first-steps/user-manual/content.md)
- SWD: OpenOCD uses the `linuxgpiod` adapter on the MPU, with `swclk` = gpiochip1 line 26, `swdio` = gpiochip1 line 25, `srst`/`trst` = gpiochip1 line 38, and `transport select swd` plus `stm32u5x.cfg` — [meta-arduino openocd_gpiod.cfg for imola](https://github.com/arduino/meta-arduino/blob/master/meta-arduino-qcom/recipes-devtools/openocd/files/imola/openocd_gpiod.cfg)
- arduino-app-cli hard-codes the UNO Q MCU reset pin as gpiochip1 line 38 and the FQBN as `arduino:zephyr:unoq` — [arduino-app-cli internal/platform/platform.go](https://github.com/arduino/arduino-app-cli/blob/main/internal/platform/platform.go)
- MCU flashing is wrapped by `remoteocd` (GPL-3.0), an OpenOCD wrapper. It runs locally on the MPU, over ADB from a PC, or over SSH — [arduino/remoteocd](https://github.com/arduino/remoteocd). The Zephyr core's `flash_bootloader.cfg` uses `reset_config srst_only ... connect_assert_srst` — [ArduinoCore-zephyr variant cfg](https://github.com/arduino/ArduinoCore-zephyr/blob/main/variants/arduino_uno_q_stm32u585xx/flash_bootloader.cfg)
- SPI: the mainline series added a dt-binding for an "Arduino SPI MCU interface", and a Feb 2026 mainline commit fixed a "faulty spidev node" in the imola DTS — [patchew series v3](https://patchew.org/linux/20251120155825.121483-1-r.mereu.kernel@arduino.cc); [mainline commit log](https://github.com/torvalds/linux/commits/master/arch/arm64/boot/dts/qcom/qrb2210-arduino-imola.dts)
- The datasheet adds that a 1.8 V MPU GPIO on JMISC or JCTL can serve as an extra ready/wake line to the MCU, but it needs level shifting — [datasheet](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/datasheet/en-datasheet.md)
- Form factor: 68.58 x 53.34 mm (UNO) — [CNX Software](https://www.cnx-software.com/2025/10/07/qualcomm-acquires-arduino-introduces-arduino-uno-q-dual-brain-sbc/)
- USB IDs: normal mode is VID 2341 / PID 0078. EDL mode is VID 05c6 / PID 9008 — [user manual](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/tutorials/first-steps/user-manual/content.md)

### Inferences
- Because the SoC is Agatti/QCM2290 (the RB1 platform), most mainline drivers and the Linaro/Qualcomm Debian tooling for RB1 should apply. That makes a custom distro much easier than on a typical vendor-BSP board.
- An agent-controlled MCU pipeline can rely on three stock hardware paths: UART (ttyHS1) for RPC, SWD via gpiod (lines 25/26/38) for flashing and debug, and SPI. gpiochip1 line 37 looks like an MCU boot-mode or "ready" control. Its exact function (e.g. BOOT0) is not documented.

### Gaps
- No SKU beyond ABX00162/ABX00173 was found as of Nov 2026.
- The exact semantics of gpiochip1 line 37 and line 70 are undocumented beyond the unit-file comments.
- MIPI lane split (CSI 2+2 vs 4, DSI 4-lane) is not stated precisely. Only "four-lane" and "type1-2lanes" camera options appear.
- The WCN3980 vs WCN3950 and BT 5.1 vs 5.0 conflict is unresolved.

## 2. Stock OS: Debian release, kernel, image locations, update mechanism, flashing, boot chain, partitions

### Takeaway
The stock OS is **Debian 13 "trixie"** (arm64). The newest image in Arduino's Stable manifest is **20260528-558 with kernel 7.0.0** (the launch images used 6.16.7). Images ship as `.tar.zst` from downloads.arduino.cc and are flashed over Qualcomm EDL (USB `05c6:9008`, entered by shorting JCTL `USB_BOOT` to GND) using Arduino Flasher CLI or the flasher built into App Lab. Day-to-day updates come through apt (Debian repos plus `apt-repo.arduino.cc stable`) and `arduino-app-cli system update`. The bootloader stack includes SPL/U-Boot (Arduino fork of U-Boot), and user data lives on a separate `userdata` partition mounted at `/home/arduino`.

### Cited Findings
- Image manifest at `https://downloads.arduino.cc/debian-im/Stable/info.json` (read 2026-11-08). The `latest` entry is `20260528-558`, kernel `linux-image-7.0.0-g122c2c22d838`, OS "Debian GNU/Linux 13 (trixie)", board "UNO Q". The URL pattern is `.../Stable/<ver>/arduino-unoq-debian-image-<ver>.tar.zst` — [Arduino Debian image index](https://downloads.arduino.cc/debian-im/Stable/info.json)
- Full image history from the same manifest:
  - 20250807-136: kernel 6.16.0 (pre-launch)
  - 20251002-387, 20251006-395, 20251024-412, 20251127-441, 20251229-457, 20260407-523: all kernel 6.16.7-g0dd6551ae96b
  - 20260528-558: kernel 7.0.0
  - All are Debian 13 trixie — [Arduino Debian image index](https://downloads.arduino.cc/debian-im/Stable/info.json). **LAUNCH-ONLY:** kernel 6.16.7. NOW: 7.0.0 in images.
- A second manifest, `ubuntu-im/Stable/info.json`, currently lists only **VENTUNO Q** Ubuntu 24.04.4 images (kernel 6.8.0-10xx-qcom, hosted on people.canonical.com). There is no Ubuntu image for UNO Q. The flash docs say: "The VENTUNO Q uses Ubuntu by default, and the UNO Q uses Debian" — [Ubuntu image index](https://downloads.arduino.cc/ubuntu-im/Stable/info.json); [Flash a Linux Image doc](https://github.com/arduino/docs-content/blob/main/content/software/app-lab/2.configure/4.flash/flash.md)
- Kernel source: [arduino/linux-qcom](https://github.com/arduino/linux-qcom) ("Arduino fork to mainline UNO Q"). Default branch is `qcom-v7.0.0-unoq`. Other branches include `qcom-v6.16.7-unoq`, `qcom-v6.19.0-unoq`, `qcom-v7.0.14-unoq` (last commit 2026-09-28), `qcom-v7.2.11-arduino` (2026-10-14), `qcom-v7.3.1-arduino`, plus topic branches (camss, dsi, venus, wlan, sound, anx, mezzanine, watchdog). Recent work includes the CAMSS Offline Processing Engine (OPE) driver and an Agatti ADSP remote-heap fix (Oct 2026) — GitHub API, [arduino/linux-qcom branches](https://github.com/arduino/linux-qcom/branches)
- **Mainline:** `qrb2210-arduino-imola.dts` was authored 2025-11-20 by Arduino (Riccardo Mereu's series "arm64: qcom: add support for Arduino UnoQ SBC", v3). It is in **Linux v7.0** but not v6.19 (checked via the GitHub compare API). The DSI/DP bridge description (Feb 2026) landed in **v7.1**. Mainline is now at v7.4-rc1 — [torvalds/linux commit 3f745bc0f11f](https://github.com/torvalds/linux/commit/3f745bc0f11f); [patchew series](https://patchew.org/linux/20251120155825.121483-1-r.mereu.kernel@arduino.cc)
- Package repos on a stock board: `deb.debian.org` trixie, trixie-updates, trixie-backports, trixie-security, plus `https://apt-repo.arduino.cc stable`. Users are told to run `sudo apt update && sudo apt upgrade`. Major OS upgrades and factory resets go through reflashing — [Debian guide](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/tutorials/linux/debian-guide/content.md)
- `arduino-app-cli system update` updates the system. `arduino-app-cli system cleanup` frees disk space. arduino-app-cli is "pre-installed on the board and updated together with the board's system" — [App CLI doc](https://github.com/arduino/docs-content/blob/main/content/software/app-lab/7.cli/1.cli/apps-lab-cli.md)
- **Arduino Flasher CLI** ([arduino/arduino-flasher-cli](https://github.com/arduino/arduino-flasher-cli), GPL-3.0). Latest stable is v0.5.4 (2026-09-23), with v0.5.5-rc.1 (2026-10-07). Commands: `flash unoq`, `download unoq`, `list unoq`, `cache list|clear`. Flags: `--preserve-user` (UNO Q only), `--version`, `--serial`, `--os`. It also runs as a gRPC `Flash` service. Built-in indexes are `debian-im` and `ubuntu-im`. `ARDUINO_FLASHER_ADDITIONAL_URLS` and `ARDUINO_FLASHER_ADDITIONAL_HEADERS` let you add custom image indexes — [flasher README](https://github.com/arduino/arduino-flasher-cli); [Flash doc](https://github.com/arduino/docs-content/blob/main/content/software/app-lab/2.configure/4.flash/flash.md)
- Flash procedure: short JCTL `GND` and `USB_BOOT` before plugging in USB, or the tool hangs at "Waiting for EDL device". The image is about 1 GB and needs 10 GB free on the host. On UNO Q, "Preserve existing data" keeps the `userdata` partition mounted at `/home/arduino` — [Flash doc](https://github.com/arduino/docs-content/blob/main/content/software/app-lab/2.configure/4.flash/flash.md)
- The App Lab Settings page can flash or reset the board and "switch distributions". In App Lab 0.11 the "Update now" button in Settings, Operating system, opens the flasher — [user manual](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/tutorials/first-steps/user-manual/content.md); [App Lab 0.11 release notes](https://github.com/arduino/docs-content/blob/main/content/software/app-lab/9.release-notes/03.release-0-11/content.md)
- Boot chain evidence:
  - The JCTL debug UART "provides access to low-level system messages printed by the bootloaders (e.g., SPL and U-Boot)" — [user manual](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/tutorials/first-steps/user-manual/content.md)
  - Arduino maintains a U-Boot fork, [arduino/u-boot](https://github.com/arduino/u-boot/tree/qcom-mainline) (branch `qcom-mainline`), with `qrb2210-arduino-imola-u-boot.dtsi` (SMBIOS product "Imola") and the upstream imola DTS in `dts/upstream`
  - The Yocto layer lists "Spl/U-Boot & Linux Kernel machines" — [meta-arduino README](https://github.com/arduino/meta-arduino)
- The Linaro/Qualcomm Debian build scripts ([qualcomm-linux/qcom-deb-images](https://github.com/qualcomm-linux/qcom-deb-images)) list "Project-specific builds: arduino images". The repo contains `.github/workflows/linux-arduino.yml` and `kernel-configs/arduino-accessories.config`. For RB1 (same SoC) it uses "prebuilt U-Boot binary for RB1 in Android boot image format", and its flash recipes take Qualcomm "boot binaries" plus DTBs — [qcom-deb-images README](https://github.com/qualcomm-linux/qcom-deb-images)
- Alternative official build system: [arduino/meta-arduino](https://github.com/arduino/meta-arduino) (MIT, created 2026-02-17, only the `scarthgap` branch is supported). Its machine `imola.conf` pins Arduino core `arduino:zephyr@0.55.0`, flashes a `Reflash_Bootanimation` sketch, pulls `arduino-router` and `arduino-default-firmware`, and offers a `linux-qcom-next-rt` kernel with `isolcpus=2,3 nohz_full=2,3 ...` — [imola.conf](https://github.com/arduino/meta-arduino/blob/master/meta-arduino-qcom/conf/machine/imola.conf)

### Inferences
- No Stable image has been published since 2026-05-28, yet the 7.0.x kernel branch was updated through Sept 2026. Kernel and userland updates after May are probably delivered as apt packages from `apt-repo.arduino.cc`. This is unverified: I did not confirm that the kernel package itself updates over apt.
- The boot chain is most likely Qualcomm PBL → XBL/SBL with TZ/RPM firmware (signed, proprietary) → ABL or a Qualcomm-provided loader → Arduino U-Boot (likely packed as an Android boot image, as on RB1) → kernel. The "SPL" wording suggests U-Boot SPL may sit in the chain, but this is unconfirmed. A custom distro can probably keep the Qualcomm boot firmware and the Arduino U-Boot and replace only the kernel and rootfs. The qcom-deb-images "arduino" target is the most direct starting point.
- The flasher's additional-index environment variables mean a custom distro can reuse Arduino's flasher, and possibly App Lab's built-in flasher, by publishing its own `info.json`.

### Gaps
- No partition table (GPT/LUN layout, rawprogram XML) was found in public docs. Only the `userdata` partition is named. Extracting the 1 GB image tarball was out of scope.
- Exact boot stages (XBL vs SBL naming on Agatti, whether ABL is present, UEFI capability) are not documented by Arduino.
- The repo or recipe that builds the official Debian image was not definitively identified. It is probably qcom-deb-images "arduino" builds, but Arduino does not state this.
- The desktop environment used in SBC mode (Wayland/X11, which DE) is not named in any doc I read.

## 3. Arduino App Lab and arduino-app-cli: architecture, packaging, default services, headless vs desktop

### Takeaway
App Lab is a Wails-based (Go plus web UI) desktop IDE, GPL-3.0. It runs on Windows, macOS and Linux, and is also pre-installed on the board for SBC mode. It drives `arduino-app-cli`, the on-board CLI and service that manages "Apps". An App is a folder with `app.yaml`, a mandatory `python/main.py`, an optional `sketch/` (Zephyr Arduino sketch for the MCU) and optional "Bricks": Python modules and/or Docker Compose services (`brick_compose.yaml`). The Python side and the sketch talk through the Bridge (MessagePack RPC via `arduino-router`). Current versions are App Lab 0.12.0 (2026-11-05 per docs) and arduino-app-cli v0.14.1 (2026-11-05).

### Cited Findings
- Repos and licenses:
  - [arduino/arduino-app-lab](https://github.com/arduino/arduino-app-lab): "cross-platform IDE ... built with Wails", GPL-3.0
  - [arduino/arduino-app-cli](https://github.com/arduino/arduino-app-cli): "The CLI and service that manages and runs Arduino Apps on hybrid Arduino boards", GPL-3.0
  - [arduino/app-bricks-py](https://github.com/arduino/app-bricks-py): Brick code, MPL-2.0
  - [arduino/app-bricks-examples](https://github.com/arduino/app-bricks-examples): MPL-2.0
  - [arduino/arduino-router](https://github.com/arduino/arduino-router): GPL-3.0-or-later
  - [arduino/arduino-router-bridge-py](https://github.com/arduino/arduino-router-bridge-py)
  - Source: GitHub API metadata
- Current versions (GitHub releases, read 2026-11-08):
  - arduino-app-cli v0.14.1 (2026-11-05); v0.14.0 (2026-10-22)
  - arduino-router v0.11.0 (2026-10-22); v0.10.0 (2026-08-11); v0.9.0 (2026-05-19)
  - App Lab GitHub releases: 0.11.0 (2026-10-23), 0.10.0 (2026-08-18), 0.9.0 (2026-07-10), 0.8.0 (2026-05-25), 0.7.0 (2026-04-29), 0.6.0 (2026-04-10)
  - app-bricks-py: `bricks/0.13.2` (2026-10-29), `media-stack/1.2.0` (2026-10-30), plus rolling `llamacpp/2026MMDD` builds
  - Sources: [app-cli releases](https://github.com/arduino/arduino-app-cli/releases); [router releases](https://github.com/arduino/arduino-router/releases); [App Lab releases](https://github.com/arduino/arduino-app-lab/releases); [app-bricks-py releases](https://github.com/arduino/app-bricks-py/releases)
- **Discrepancy:** the docs publish App Lab **0.12.0 release notes dated 2026-11-05**, but the GitHub releases page still listed 0.11.0 as latest on 2026-11-08 — [0.12 release notes](https://github.com/arduino/docs-content/blob/main/content/software/app-lab/9.release-notes/02.release-0-12/content.md)
- App anatomy:
  - `app.yaml`: manifest, mandatory
  - `python/main.py`: mandatory entry point
  - `python/requirements.txt`: optional
  - `sketch/sketch.ino` + `sketch/sketch.yaml`: optional
  - `bricks/`: custom Bricks
  - `python-libraries/*.whl`, `data/`, and generated `.cache/` (the App's Python venv)
  - Storage: user Apps live in `/home/arduino/ArduinoApps/`. Built-in examples and installed releases live read-only in `/var/lib/arduino-app-cli/examples/` and `/var/lib/arduino-app-cli/releases/`
  - Source: [About Apps doc](https://github.com/arduino/docs-content/blob/main/content/software/app-lab/4.apps/1.about-apps/about-apps.md)
- Bricks are "pre-packaged services running alongside your logic in isolated Docker containers" — [About Apps doc](https://github.com/arduino/docs-content/blob/main/content/software/app-lab/4.apps/1.about-apps/about-apps.md)
- Brick manifest `brick_config.yaml` keys: `id`, `category`, `ports`, `supported_boards` (`unoq`, `ventunoq`), `requires_services` (e.g. `arduino:genie`), `required_devices`, `mount_devices_into_container`, `model_name`, `model_by_boards`. `brick_compose.yaml` is a standard Docker Compose file run on an isolated compose network. Since App CLI 0.14.1 it can use `build:` to build images on the board at every App start — [Bricks reference](https://github.com/arduino/docs-content/blob/main/content/software/app-lab/5.bricks/4.bricks-reference/bricks-reference.md); [0.12 release notes](https://github.com/arduino/docs-content/blob/main/content/software/app-lab/9.release-notes/02.release-0-12/content.md)
- An App's first start "can take longer, because the board downloads the containers and AI models the App needs" — [App CLI doc](https://github.com/arduino/docs-content/blob/main/content/software/app-lab/7.cli/1.cli/apps-lab-cli.md)
- CLI surface in v0.14:
  - `app new|start|stop|logs --follow|list|ps|ports|details|build|install`
  - `brick list` and `app brick config`
  - `model install` (accepts Hugging Face IDs such as `llamacpp:owner/repo:quant`)
  - `properties set default user:<app>` (run at startup)
  - `system update`, `system cleanup`, and network-mode enable/disable
  - App releases are read-only `.ard` packages (`app build --target unoq|ventunoq`, `app install`)
  - Sources: [App CLI doc](https://github.com/arduino/docs-content/blob/main/content/software/app-lab/7.cli/1.cli/apps-lab-cli.md); [0.11 release notes](https://github.com/arduino/docs-content/blob/main/content/software/app-lab/9.release-notes/03.release-0-11/content.md)
- **arduino-router** is a MessagePack-RPC router in a star topology. It provides `$/register`, `$/unregister`, `$/reset`, `$/serial/open`, `$/serial/close` and `$/setMaxMsgSize`, and remaps request IDs between clients. Any number of Linux processes plus the MCU can register methods — [arduino-router README](https://github.com/arduino/arduino-router)
- Stock unit: `ExecStart=/usr/bin/arduino-router --unix-port /var/run/arduino-router.sock --serial-port /dev/ttyHS1 --serial-baudrate 115200`, with `Restart=always` — [user manual](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/tutorials/first-steps/user-manual/content.md)
- MCU-side Bridge (Arduino_RouterBridge library) API: `Bridge.begin/call/notify/provide/provide_safe`, `RpcCall`, and a `Monitor` object (RPC `mon/write`). The background RPC thread uses Zephyr `k_mutex`. Calling `Bridge.call()` or `Serial.print()` inside `provide()` causes deadlocks — [user manual](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/tutorials/first-steps/user-manual/content.md)
- In App Lab 0.11 the Python `Bridge` moved to the standalone `arduino-router-bridge` library. It raises `AppError` if the router is unreachable within 5 s — [0.11 release notes](https://github.com/arduino/docs-content/blob/main/content/software/app-lab/9.release-notes/03.release-0-11/content.md)
- Services and access on a stock board:
  - `adbd` is on by default over USB and gives a shell as the user (`sudo systemctl disable adbd` to turn it off) — [Security hardening guide](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/tutorials/linux/security-hardening-guide/content.md)
  - SSH as `arduino@<boardname>.local`, toggled from App Lab ("Remote access (SSH)") — [Debian guide](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/tutorials/linux/debian-guide/content.md); [0.11 release notes](https://github.com/arduino/docs-content/blob/main/content/software/app-lab/9.release-notes/03.release-0-11/content.md)
  - `arduino-router` (systemd)
  - mDNS (UDP 5353) for App Lab "Network Mode"
  - NetworkManager (`nmcli`)
  - Docker for Bricks
  - Sources: [user manual](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/tutorials/first-steps/user-manual/content.md); [Debian guide](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/tutorials/linux/debian-guide/content.md)
- Default user is `arduino`. The password is set at first boot or setup; there is no default password. The first-boot wizard asks for keyboard layout, board name and Wi-Fi — [standalone setup doc](https://github.com/arduino/docs-content/blob/main/content/software/app-lab/1.setup/5.standalone/standalone.md)
- Modes:
  - **PC-hosted / Connected Mode:** App Lab on a PC talks to the board over USB via ADB
  - **Network Mode:** over SSH with mDNS discovery
  - **SBC mode:** App Lab runs on the board's desktop, with monitor, keyboard and mouse through a USB-C PD hub; the docs recommend 4 GB
  - All three can be combined
  - The 0.10 Language Server is "not available in SBC Mode on UNO Q"
  - Sources: [user manual](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/tutorials/first-steps/user-manual/content.md); [App Lab 0.10 blog](https://blog.arduino.cc/2026/08/12/arduino-app-lab-0-10-meet-agentic-mode/)
- The OS boots straight into App Lab in SBC mode. Jeff Geerling found Docker container download and start "a bit sluggish" — [Jeff Geerling](https://www.jeffgeerling.com/blog/2025/arduino-uno-q-weird-hybrid-sbc)
- MCU toolchain: Arduino IDE 2.x or arduino-cli with FQBN `arduino:zephyr:unoq`. [ArduinoCore-zephyr](https://github.com/arduino/ArduinoCore-zephyr) (Apache-2.0, "Zephyr+llext") reached **1.0.0 on 2026-09-02** and 1.1.0 on 2026-10-29. Earlier 0.5x releases were beta (e.g. 0.56.0, June 2026) — [ArduinoCore-zephyr releases](https://github.com/arduino/ArduinoCore-zephyr/releases); [Arduino blog on core 0.56.0](https://blog.arduino.cc/2026/06/30/arduino-core-zephyr-0-56-0-try-it-out-now-and-help-us-get-closer-to-stable/)
- Stock AI and agent pieces (brief, since other researchers cover them):
  - An LLM Brick for UNO Q (0.9), using rolling llama.cpp container builds
  - An MCP Client Brick (0.11)
  - "Agent Mode": 0.10 added it, using MCP integrated with App CLI, bring-your-own-key, with Claude Code first. 0.11 added the agent panel. 0.12 added OpenCode plus agent tools for files and carrier status
  - A TPS Brick that uses Qualcomm's cloud location API
  - Sources: [0.9 notes](https://github.com/arduino/docs-content/blob/main/content/software/app-lab/9.release-notes/05.release-0-9/content.md); [0.10 blog](https://blog.arduino.cc/2026/08/12/arduino-app-lab-0-10-meet-agentic-mode/); [0.11 notes](https://github.com/arduino/docs-content/blob/main/content/software/app-lab/9.release-notes/03.release-0-11/content.md); [0.12 notes](https://github.com/arduino/docs-content/blob/main/content/software/app-lab/9.release-notes/02.release-0-12/content.md)
- Python is "the officially supported language for MPU-side development". Any language can talk MessagePack-RPC to the router socket — [Debian guide](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/tutorials/linux/debian-guide/content.md); [user manual](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/tutorials/first-steps/user-manual/content.md)

### Inferences
- For an agent or MCP pipeline, the cleanest stock seam is the router's Unix socket (`/var/run/arduino-router.sock`), not `/dev/ttyHS1`. You could keep arduino-router (GPL-3.0, small Go binary) and the Zephyr core plus RouterBridge while dropping App Lab, arduino-app-cli and Docker entirely. Doing so also frees RAM, which matters on 2 GB.
- App Lab's own Agent Mode already exposes the App CLI over MCP. If a custom distro wants Arduino-compatible tooling, arduino-app-cli is the component to reuse or emulate.

### Gaps
- Whether the main `python/main.py` itself runs inside a Docker container or in a host venv is not explicit in current docs. The docs mention an App-level `.cache/` venv, which suggests a host venv, while Bricks run in containers. Unverified.
- The full list of default systemd units and listening ports on a fresh image was not found. It would require inspecting a board or image.
- Container registry and base-image names for Bricks were not confirmed.

## 4. Release history and roadmap; Qualcomm acquisition and openness/licensing effects

### Takeaway
Qualcomm announced its acquisition of Arduino together with the UNO Q on 2025-10-07. Pre-orders opened at $44 and shipping began 2025-10-24. Arduino is now described as wholly owned by Qualcomm Technologies. Since launch: the 4 GB SKU (Jan 2026), roughly monthly App Lab releases (0.4 to 0.12), a move to kernel 7.0 and mainline DT support (Linux 7.0/7.1), Zephyr core 1.0 (Sep 2026), price hikes (Jul 2026), a Yocto layer, and a larger sibling board, the VENTUNO Q (Aug 2026). The Nov 2025 Terms-of-Service rewrite drew sharp community criticism. Arduino said "anything that was open, stays open".

### Cited Findings
- Timeline:
  - 2025-10-07: acquisition announced together with the UNO Q (pre-orders $44 / €47.60; shipping from 2025-10-24); the deal was subject to regulatory approval — [CNX Software](https://www.cnx-software.com/2025/10/07/qualcomm-acquires-arduino-introduces-arduino-uno-q-dual-brain-sbc/); [Hackster](https://www.hackster.io/news/qualcomm-acquires-arduino-launches-the-new-arduino-uno-q-single-board-computer-57d91d83e890)
  - 2025-11-20: mainline DTS series posted; landed in Linux v7.0 — [patchew](https://patchew.org/linux/20251120155825.121483-1-r.mereu.kernel@arduino.cc)
  - 2026-01-20: 4 GB / 32 GB SKU at $59 — [Arduino blog](https://blog.arduino.cc/2026/01/20/arduino-uno-q-is-now-available-with-4gb-ram-and-32gb-storage/)
  - 2026-02-04: App Lab 0.4 (one-click App import and export, per search-result summary) — [Arduino blog](https://blog.arduino.cc/2026/02/04/introducing-the-latest-arduino-app-lab-release/)
  - 2026-02-17: meta-arduino Yocto layer created — [meta-arduino](https://github.com/arduino/meta-arduino)
  - 2026-04-06/10: App Lab 0.6 (board settings page, new Bricks) — [Arduino blog](https://blog.arduino.cc/2026/04/06/arduino-app-lab-0-6-more-control-more-bricks-faster-ai/)
  - 2026-04-29: App Lab 0.7 (Custom Bricks, Python and/or Docker) — [Hackster](https://www.hackster.io/news/arduino-updates-its-uno-q-ventuno-q-app-lab-to-bring-custom-bricks-support-for-modular-making-6f22c2e1d500)
  - 2026-05-28: Debian image with kernel 7.0.0 — [image index](https://downloads.arduino.cc/debian-im/Stable/info.json)
  - 2026-07-06: price rise to $59 (2 GB) / $79 (4 GB) — [Arduino blog](https://blog.arduino.cc/2026/06/26/a-heads-up-on-the-arduino-uno-q-board-pricing-straight-from-marcello-majonchi/)
  - 2026-07-09: App Lab 0.9 (LLM Brick, model downloads) — [0.9 notes](https://github.com/arduino/docs-content/blob/main/content/software/app-lab/9.release-notes/05.release-0-9/content.md)
  - 2026-08-12: App Lab 0.10 (Agent Mode via MCP, language server, Arduino Cloud provisioning) — [Arduino blog](https://blog.arduino.cc/2026/08/12/arduino-app-lab-0-10-meet-agentic-mode/)
  - Aug 2026: VENTUNO Q announced, pre-order $299; raised to $399 on 2026-10-19 — [Qualcomm press release](https://www.qualcomm.com/news/releases/2026/08/arduino-ventuno-q-is-here--bringing-agentic-ai-to-the-physical-w); [Technobezz](https://www.technobezz.com/news/arduino-raises-ventuno-q-price)
  - 2026-09-02: ArduinoCore-zephyr 1.0.0 — [releases](https://github.com/arduino/ArduinoCore-zephyr/releases)
  - 2026-10-22: App Lab 0.11 (.ard App releases, Hugging Face models, board extensions) — [0.11 notes](https://github.com/arduino/docs-content/blob/main/content/software/app-lab/9.release-notes/03.release-0-11/content.md)
  - 2026-11-05: App Lab 0.12 / app-cli 0.14.1 — [0.12 notes](https://github.com/arduino/docs-content/blob/main/content/software/app-lab/9.release-notes/02.release-0-12/content.md)
- VENTUNO Q context (sibling board, codename "Monza", SKU ABX00181): Dragonwing IQ8 (QCS8275/QCS8300 family), STM32H5 MCU, Ubuntu 24.04 by default. Its mainline DTS is `monaco-arduino-monza.dts`. App Lab, App CLI, Bricks and the router are shared across both boards — [Ubuntu image index](https://downloads.arduino.cc/ubuntu-im/Stable/info.json); [mainline dts dir](https://github.com/torvalds/linux/tree/master/arch/arm64/boot/dts/qcom); [0.12 notes](https://github.com/arduino/docs-content/blob/main/content/software/app-lab/9.release-notes/02.release-0-12/content.md); [LinuxGizmos](https://linuxgizmos.com/ventuno-q-runs-ubuntu-on-dragonwing-iq8-with-40-tops-npu-along-with-real-time-stm32h5/)
- Acquisition status: Arduino's privacy policy states Arduino is wholly owned by Qualcomm Technologies, Inc. (as reported) — [The Register, 2025-11-21](https://www.theregister.com/2025/11/21/adafruit_makers_unhappy_with_arduino)
- ToS controversy (Nov 2025): the new terms barred reverse engineering, made the license on user-uploaded content irrevocable, and allowed account and AI-usage monitoring with data flowing to Qualcomm Group companies. Adafruit and the EFF criticized them — [The Register](https://www.theregister.com/2025/11/21/adafruit_makers_unhappy_with_arduino); [TechSpot](https://www.techspot.com/news/110375-qualcomm-rewrote-arduino-tos-community-not-taking-well.html)
- Arduino's response: the reverse-engineering ban applies only to the proprietary Arduino Cloud SaaS, and "anything that was open, stays open" — [Hackster](https://www.hackster.io/news/arduino-clarifies-terms-and-conditions-following-backlash-anything-that-was-open-stays-open-645e9ee9a51e)
- Stated roadmap items: Agent Mode "more providers planned" (delivered in 0.12 with OpenCode); "additional programming languages and alternative methods for MPU/MCU communication will become available" — [0.10 blog](https://blog.arduino.cc/2026/08/12/arduino-app-lab-0-10-meet-agentic-mode/); [Debian guide](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/tutorials/linux/debian-guide/content.md)

### Inferences
- In practice, the software repos have stayed open under GPL-3.0, MPL-2.0 and Apache-2.0 after the acquisition, and Arduino upstreams to the kernel and U-Boot. The openness risk is concentrated in cloud services (Arduino Cloud, Qualcomm TPS) and the ToS, not in the board's software stack.
- App Lab is still pre-1.0 (0.12) and changes monthly. Anything built on its internal APIs (app.yaml schema, Brick keys, CLI output) should be expected to break.

### Gaps
- The exact closing date of the acquisition was not found.
- No formal public roadmap document for the UNO Q software was found.

## 5. Known issues, limitations, community sentiment

### Takeaway
Reviewers agree the Linux side performs at roughly Raspberry Pi 3B+/Pi 4 level. The 2 GB SKU is tight for SBC or desktop use, SBC mode is slow, and media playback is poor. App Lab was buggy early on (board detection, update loops, serial console), and many of those bugs have since been fixed. Value as a pure SBC is criticized; the hybrid MPU+MCU design and Arduino integration are the main appeal.

### Cited Findings
- Jeff Geerling (2025-10-31): Linux performance is "about on par with a Pi 3 B+ or Pi 4". The 2 GB RAM is "a bit of a pain". A $45 Pi 5 is "2-4x faster", so "not a good value" as an SBC alone. Debian mostly works out of the box. App Lab Docker start is sluggish, and he had trouble with serial console output and connection stability — [Jeff Geerling](https://www.jeffgeerling.com/blog/2025/arduino-uno-q-weird-hybrid-sbc)
- Tom's Hardware: slow "SBC mode" and poor AI/LLM performance for untrained models; pre-trained models run acceptably — [Tom's Hardware review](https://www.tomshardware.com/raspberry-pi/arduino-uno-q-review)
- Notebookcheck (2 GB): Linux is usable but sluggish, and media playback is practically impossible — [Notebookcheck hands-on](https://www.notebookcheck.net/Arduino-UNO-Q-hands-on-Smarter-with-Qualcomm-and-capable-of-running-a-desktop-OS-like-a-Raspberry-Pi.1169110.0.html)
- Hackster 2 GB vs 4 GB: identical CPU performance; idle RAM about 0.4-0.5 GB on a clean install; built-in examples fit within 2 GB — [Hackster](https://www.hackster.io/vsupacha/arduino-uno-q-2gb-vs-4gb-any-difference-249c6b)
- Forum reports:
  - App Lab out-of-memory crash after copying about 1.8 GB of files — [forum 1451529](https://forum.arduino.cc/t/applab-crashing-with-out-of-memory-error/1451529)
  - 4 GB board not detected by App Lab 0.3.2 — [forum 1425692](https://forum.arduino.cc/t/the-arduino-app-lab-doesnt-detect-the-new-arduino-uno-q-4gb-version/1425692)
  - Board freezing — [forum 1418801](https://forum.arduino.cc/t/arduino-uno-q-freezing-up/1418801)
  - Stuck failed-update window — [forum 1413890](https://forum.arduino.cc/t/uno-q-cant-get-past-failed-update-window-to-enter-linux-password/1413890)
  - Mac detection problems — [forum 1422175](https://forum.arduino.cc/t/cannont-connect-uno-q-to-app-lab-on-macbook-pro-2016/1422175)
  - These are individual reports, not confirmed bugs
- Bugs Arduino itself fixed in 0.11:
  - Editor typing lag on UNO Q
  - Zephyr auto-update loop after a system update
  - SSH toggle broken in SBC mode
  - App Lab leaving flasher copies in temp, which "could fill the memory and make App Lab crash in Single-Board Computer Mode"
  - Source: [0.11 notes](https://github.com/arduino/docs-content/blob/main/content/software/app-lab/9.release-notes/03.release-0-11/content.md)
- 0.12 sped up board updates and `system init` by skipping redundant package installs — [0.12 notes](https://github.com/arduino/docs-content/blob/main/content/software/app-lab/9.release-notes/02.release-0-12/content.md)
- Network Mode depends on mDNS and can fail on guest, corporate or VPN networks. Linux hosts need udev rules for `2341:0078` and `05c6:9008` — [user manual](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/tutorials/first-steps/user-manual/content.md)
- Hardware constraints:
  - The single USB-C port means SBC use needs a PD hub; Apple adapters are incompatible
  - MPU I/O is 1.8 V and needs level shifting
  - Accessing the LED matrix during the 20-30 s boot animation can interfere with MCU startup
  - Sources: [datasheet](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/datasheet/en-datasheet.md); [user manual](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/tutorials/first-steps/user-manual/content.md)
- Community sentiment at launch: fear of Qualcomm closing things down, closed bootloaders, "painful" limited I/O, a questioned value for the LED matrix — [CNX Software comments](https://www.cnx-software.com/2025/10/07/qualcomm-acquires-arduino-introduces-arduino-uno-q-dual-brain-sbc/)
- Geerling's concern: whether Qualcomm will keep investing in the platform or drop it, as Intel did with Edison — [Jeff Geerling](https://www.jeffgeerling.com/blog/2025/arduino-uno-q-weird-hybrid-sbc)

### Inferences
- For a headless, agent-controlled custom distro, the main stock pain points (App Lab and Docker overhead, the SBC desktop, RAM pressure on 2 GB) are exactly the parts you would remove. The Cortex-A53 CPU ceiling is the hard limit that cannot be changed.

### Gaps
- I did not find a Phoronix or LWN article specific to the UNO Q.
- I did not find a Hackaday review in this pass.
- Quantitative benchmark numbers (Geekbench scores) were not extracted. Geerling's article gives charts only.

## 6. Openness: what is open, what is proprietary, licenses

### Takeaway
Open: schematics, pinout, STEP and CAD files; the kernel fork, now upstream in mainline 7.0+; the U-Boot fork; the Yocto layer (MIT); App Lab, App CLI, router, flasher, linux-config and remoteocd (GPL-3.0); Bricks and examples (MPL-2.0); the Zephyr core (Apache-2.0). Proprietary or unverified: Qualcomm boot firmware (PBL/XBL/TZ etc.) and the GPU, DSP, video and Wi-Fi firmware blobs, plus cloud services. Full PCB layout files were not published at launch.

### Cited Findings
- Hardware docs: pinout PDF, schematics PDF (`ABX00162-schematics.pdf`), CAD ZIP and STEP ZIP are published on the product page — [docs product page](https://docs.arduino.cc/hardware/uno-q/)
- Full PCB design files were not published at launch (Geerling footnote citing another user) — [Jeff Geerling](https://www.jeffgeerling.com/blog/2025/arduino-uno-q-weird-hybrid-sbc)
- QRB2210 datasheet availability: the chip is listed on DigiKey with a datasheet, which Geerling compares favorably to Broadcom's Pi SoCs — [Jeff Geerling](https://www.jeffgeerling.com/blog/2025/arduino-uno-q-weird-hybrid-sbc)
- Licenses from GitHub metadata:
  - GPL-3.0: arduino-app-cli, arduino-app-lab, arduino-router (GPL-3.0-or-later), arduino-flasher-cli, arduino-linux-config, remoteocd
  - MPL-2.0: app-bricks-py, app-bricks-examples
  - Apache-2.0: ArduinoCore-zephyr
  - MIT: meta-arduino
  - linux-qcom and u-boot show "NOASSERTION"; they are standard kernel and U-Boot trees (GPL-2.0 / GPL-2.0+). The U-Boot imola dtsi is `GPL-2.0+ OR MIT`
  - Sources: [arduino-app-cli](https://github.com/arduino/arduino-app-cli); [arduino-router](https://github.com/arduino/arduino-router); [app-bricks-py](https://github.com/arduino/app-bricks-py); [ArduinoCore-zephyr](https://github.com/arduino/ArduinoCore-zephyr); [meta-arduino](https://github.com/arduino/meta-arduino); [arduino/u-boot](https://github.com/arduino/u-boot/tree/qcom-mainline)
- Mainline status: the board DTS has been in mainline since v7.0, with DSI/DP bridge since v7.1 and further fixes through July 2026. The VENTUNO Q DTS is also upstream — [mainline DTS](https://github.com/torvalds/linux/blob/master/arch/arm64/boot/dts/qcom/qrb2210-arduino-imola.dts)
- The Linaro/Qualcomm Debian build scripts build images from "downloaded boot binaries" plus DTBs. Qualcomm boot binaries are fetched as prebuilt artifacts, not built from source — [qcom-deb-images README](https://github.com/qualcomm-linux/qcom-deb-images)
- Cloud and proprietary services in the stock stack: Arduino Cloud (proprietary SaaS; ToS reverse-engineering clause applies to it), and the Qualcomm TPS location API used by the TPS Brick (needs credentials) — [Hackster on ToS](https://www.hackster.io/news/arduino-clarifies-terms-and-conditions-following-backlash-anything-that-was-open-stays-open-645e9ee9a51e); [0.11 notes](https://github.com/arduino/docs-content/blob/main/content/software/app-lab/9.release-notes/03.release-0-11/content.md)

### Inferences
- On Agatti and RB1, the Adreno zap shader, ADSP/modem firmware, Venus video firmware and WCN Wi-Fi/BT firmware are Qualcomm-signed binaries, normally shipped through linux-firmware (`qcom/qcm2290` and related paths). The UNO Q almost certainly uses the same kind of redistributable but closed blobs. The early boot chain (PBL in ROM, XBL, TZ, RPM, and likely ABL) is signed and proprietary. A custom distro must carry these blobs, while the kernel, U-Boot and userland can be fully open. This inference is based on the RB1 precedent, not on an Arduino statement.
- The GPU should work with open Mesa freedreno (Adreno 7xx support plus the zap firmware). Whether the stock image uses freedreno or a Qualcomm proprietary driver is unverified.

### Gaps
- I found no Arduino document that lists the proprietary firmware files in the stock image or states their licenses.
- Whether secure boot or fuse-locking is enabled on retail boards is unknown. EDL flashing of arbitrary images via qdl/Arduino Flasher suggests boards are not locked to signed OS images, but the boot firmware itself is signed.
- I did not verify whether the stock image's Mesa or GPU stack is freedreno or proprietary.
