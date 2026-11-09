# Building a Custom Linux Distribution for the Arduino UNO Q (QRB2210 / QCM2290 "Agatti"), as of November 2026

Scope note: Linux/MPU side only. The board codename is **"imola"**. The SoC is QRB2210, which is the IoT/robotics part of the QCM2290 family. In mainline it uses `agatti.dtsi`. Mainline is at **v7.4-rc1** as of this research (checked with the GitHub API on torvalds/linux tags). Most findings below were checked directly against the repositories (GitHub API reads of the source files). Anything resting only on a forum post or search snippet is flagged as such.

---

## 1. Mainline Linux support: is the UNO Q device tree upstream, since which version, and what works upstream vs. vendor-only?

### Takeaway
Yes. `arch/arm64/boot/dts/qcom/qrb2210-arduino-imola.dts` was merged for **Linux 7.0** (released 2026-04-12). Mainline 7.2+ covers the whole "headless robot controller" set: eMMC, USB gadget/host, Wi-Fi (ath10k/WCN3990), BT (WCN3988), the UART and SPI links to the STM32, I2C, GPIO/LEDs, ADSP/modem remoteprocs, and the A702 GPU kernel driver. Audio, camera/ISP, carrier-board overlays and some display panels still need Arduino's out-of-tree patches. Venus video fails on mainline because of a firmware-path mismatch.

### Cited Findings
**Upstreaming history (merged):**
- Riccardo Mereu (Arduino) posted the series "[PATCH v3 0/6] arm64: qcom: add support for Arduino UnoQ SBC". v1 went out 2025-11-06, v2 on 2025-11-14 and v3 on 2025-11-20. It has 6 patches: an Arduino vendor prefix, a trivial-devices binding for the "arduino spi mcu interface", a spidev compatible, the qcom board binding for "arduino imola", a `uart2` node in agatti.dtsi, and the board DTS. The cover letter says the DTS boots to a shell with UART, I2C, SPI, onboard LEDs, eMMC and WLAN/BT — [ratatoskr LKML archive](https://ratatoskr.run/lkml/2025/11/3306164/t); [patchew v3](https://patchew.org/linux/20251120155825.121483-1-r.mereu.kernel@arduino.cc); [patchew v1 DTS patch](https://patchew.org/linux/20251106153119.266840-1-r.mereu@arduino.cc/20251106153119.266840-6-r.mereu@arduino.cc)
- Reviews came from Krzysztof Kozlowski (Ack/Reviewed-by), Dmitry Baryshkov and Konrad Dybcio. Loic Poulain confirmed that the Wi-Fi `firmware-name = "qcm2290"` is needed. Mark Brown applied the spidev patches to spi for-next on 2025-11-21. Bjorn Andersson applied the DT and binding patches on 2026-01-05 — [ratatoskr LKML archive](https://ratatoskr.run/lkml/2025/11/3306164/t)
- Mainline git history of `qrb2210-arduino-imola.dts` (GitHub API on torvalds/linux):
  - `3f745bc0f11f` "arm64: dts: qcom: qrb2210: add dts for Arduino unoq" (committed 2026-01-03)
  - `1a040df09fab` "arduino-imola: fix faulty spidev node" (2026-03-26)
  - `d5574bb935e3` "qrb2210-arduino-imola: describe DSI / DP bridge" (2026-03-26)
  - `cab6d9627ef4` "Fix pm4125 vbus regulator compatible and constraints" (2026-07-15)
  - Source: [torvalds/linux history for the DTS](https://github.com/torvalds/linux/commits/master/arch/arm64/boot/dts/qcom/qrb2210-arduino-imola.dts)
- Armbian's maintainer states the Imola DTS "first shipped in Linux 7.0", is present from v7.0-rc1, and that 7.0 was released 2026-04-12 — [armbian/build PR #9710](https://github.com/armbian/build/pull/9710)
- `drivers/spi/spidev.c` in mainline contains `{ .compatible = "arduino,unoq-mcu" }` and the `"unoq-mcu"` id. The MCU SPI link therefore works with stock spidev — [mainline spidev.c](https://github.com/torvalds/linux/blob/master/drivers/spi/spidev.c)
- **Under review / not merged:** an April 2026 series "[PATCH 0/3] arm64: qcom: imola: add support…" proposes renaming the DTS to `-base.dts` and adding carrier-board overlays (`.dtbo`), such as a media carrier. As of v7.4-rc1 mainline still has only `qrb2210-arduino-imola.dts`, with no `-base` file or Imola overlays — [ratatoskr devicetree archive](https://ratatoskr.run/linux-devicetree/2026/04/3538739/t); [mainline qcom dts dir](https://github.com/torvalds/linux/tree/master/arch/arm64/boot/dts/qcom). Arduino's vendor stack already uses `qrb2210-arduino-imola-base.dtb` plus `fdtoverlay`-merged overlays through `arduino-linux-config carrier enable` — [yoe UNO Q docs](https://docs.yoebuild.org/machine-uno-q.html)
- The sibling board **VENTUNO Q** (`monaco-arduino-monza.dts`, QCS8300) is also in mainline — [mainline qcom dts dir](https://github.com/torvalds/linux/tree/master/arch/arm64/boot/dts/qcom)

**What the mainline DTS enables (read from the file at v7.4-rc1):**
- Nodes set to okay:
  - `gpi_dma0`, `gpu` (zap shader `qcom/qcm2290/a702_zap.mbn`), `i2c0`, `i2c1`
  - the `analogix,anx7625` DSI→DP bridge with a `usb-c-connector`
  - `mdss`, `mdss_dsi0`, `mdss_dsi0_phy`, `pm4125_vbus`, `qupv3_id_0`
  - `remoteproc_adsp` (`qcom/qcm2290/adsp.mbn`) and `remoteproc_mpss` (`qcom/qcm2290/modem.mbn`)
  - `sdhc_1` (eMMC), `spi5` with `arduino,unoq-mcu`
  - `uart2` (MCU link), `uart3` with `qcom,wcn3988-bt`, `uart4` as `qcom,geni-debug-uart`
  - `usb` with QMP/HS PHYs, and `wifi` (`firmware-name = "qcm2290"`)
  - Source: [mainline qrb2210-arduino-imola.dts](https://github.com/torvalds/linux/blob/master/arch/arm64/boot/dts/qcom/qrb2210-arduino-imola.dts)
- `agatti.dtsi` defines `camss` (`qcom,qcm2290-camss`), `cci`, `venus` and `fastrpc` under the ADSP, but the Imola DTS does not enable CAMSS or a sound card — [mainline agatti.dtsi](https://github.com/torvalds/linux/blob/master/arch/arm64/boot/dts/qcom/agatti.dtsi)

**SoC driver support in mainline (verified in source):**
- GPU: `a6xx_catalog.c` has an A702 entry (chip IDs 0x07000200/0x07000400) with `a702_sqe.fw` and `a702_zap.mbn` — [mainline a6xx_catalog.c](https://github.com/torvalds/linux/blob/master/drivers/gpu/drm/msm/adreno/a6xx_catalog.c)
- CAMSS: the driver has `qcom,qcm2290-camss` — [mainline camss.c](https://github.com/torvalds/linux/blob/master/drivers/media/platform/qcom/camss/camss.c)
- Video: Venus has `qcm2290_res` tables and the Iris driver matches `qcom,qcm2290-venus` — [mainline venus core.c](https://github.com/torvalds/linux/blob/master/drivers/media/platform/qcom/venus/core.c); [mainline iris_probe.c](https://github.com/torvalds/linux/blob/master/drivers/media/platform/qcom/iris/iris_probe.c)
- Audio:
  - `sound/soc/qcom/sm8250.c` matches `qcom,qrb2210-sndcard` — [mainline sm8250.c](https://github.com/torvalds/linux/blob/master/sound/soc/qcom/sm8250.c)
  - the PM4125 codec (`SND_SOC_PM4125`, `SND_SOC_PM4125_SDW`) exists — [mainline sound/soc/codecs/Kconfig](https://github.com/torvalds/linux/blob/master/sound/soc/codecs/Kconfig)
  - `pinctrl-qcm2290.c` exists — [mainline drivers/pinctrl/qcom](https://github.com/torvalds/linux/tree/master/drivers/pinctrl/qcom)

**Hands-on feature matrix with mainline 7.2 (Nerves system, Oct 2026):**
- Reported by the Nerves system for the UNO Q, which runs mainline 7.2 — [jimsynz/nerves_system_arduino_uno_q README](https://github.com/jimsynz/nerves_system_arduino_uno_q):
  - GPIO/I2C/SPI work.
  - Wi-Fi works (ath10k WCN3990). `wlan0` appears about 13 s after power-on, once `rmtfs` and `tqftpserv` have started the modem DSP.
  - BT: `hci0` comes up; otherwise untested.
  - USB Ethernet gadget works.
  - MCU via `arduino-router` on `/dev/ttyHS1` works.
  - GPU: the msm DRM driver binds and gives `/dev/dri/renderD128`. The system ships no Mesa.
  - Display: `card0` with a `DP-1` connector appears; untested with a monitor.
  - Video: **Venus fails to probe.** The driver asks for `qcom/venus-6.0/venus.mbn`, but linux-firmware ships the AR50-Lite firmware as `qcom/vpu/ar50lt_p1_gen2_s6.mbn`. While the codec is unprobed, clock/interconnect `sync_state` never finishes, so unused clocks stay on.
  - Audio: none. The ADSP boots, but the mainline DT has no sound card.
  - Camera/ISP: none. CAMSS is disabled in the mainline DT, and the OPE ISP driver exists only in Arduino's kernel.
  - `/dev/fastrpc-adsp` exists, but there is no FastRPC userspace. "The QRB2210 has no separate compute DSP."
- Armbian's analysis of the gap between `v7.0` and Arduino's `qcom-v7.0.0-unoq` branch found **48 extra commits**:
  - audio: pm4125 codec, LPASS Agatti, qdsp6/sm8250 fixes
  - Type-C DP in anx7625, Waveshare DSI panels and the touch GPIO controller
  - Imola media-carrier overlays
  - A702 firmware auto-included in the initramfs
  - The author says the base path (serial, eMMC, USB gadget RNDIS/ADB, Wi-Fi ath10k, BT, rootfs resize) is covered by mainline v7.0. Armbian carries the 48 patches under `patch/kernel/qrb2210-edge/` — [armbian/build PR #9710](https://github.com/armbian/build/pull/9710)
- Arduino's own kernel fork is [arduino/linux-qcom](https://github.com/arduino/linux-qcom), described as "Arduino fork to mainline UNO Q". Its branches include:
  - qcom-v6.16.7-unoq, qcom-v6.19.0-unoq, qcom-v7.0.0-unoq (the default), qcom-v7.0.14-unoq
  - qcom-v7.2.8-arduino, qcom-v7.2.11-arduino, qcom-v7.3.1-arduino
  - topic branches: topic/camss, topic/dsi, topic/sound, topic/venus, topic/wlan, topic/clk, topic/watchdog, topic/mezzanine, and others
  - Source: GitHub API branch list of [arduino/linux-qcom](https://github.com/arduino/linux-qcom)
- Qualcomm's Debian CI builds an "arduino" kernel from `qualcomm-linux/kernel-topics` ref `early/hwe/arduino` — [arduino-deb-images linux-arduino.yml workflow](https://github.com/arduino/arduino-deb-images/blob/arduino/.github/workflows/linux-arduino.yml)
- The vendor setup requires the kernel arguments `clk_ignore_unused pd_ignore_unused` — [yoe UNO Q docs](https://docs.yoebuild.org/machine-uno-q.html). Qualcomm's `uno-q.conf` adds `deferred_probe_timeout=30` — [meta-qcom-arduino uno-q.conf](https://github.com/qualcomm-linux/meta-qcom-arduino/blob/main/conf/machine/uno-q.conf)
- A Qualcomm CI health report (Oct 2026) reportedly lists a known `fastrpc_test` failure on Imola across the arduino, linux-next and mainline kernels. This means the board is in Qualcomm's LAVA lab for mainline and linux-next testing. Seen in a search snippet only, not opened — [qcom-deb-images issue #733](https://github.com/qualcomm-linux/qcom-deb-images/issues/733)
- Linaro/Qualcomm reference platform: the RB1 (`qrb2210-rb1.dts` plus `qrb2210-rb1-vision-mezzanine.dtso`) is in mainline — [mainline qcom dts dir](https://github.com/torvalds/linux/tree/master/arch/arm64/boot/dts/qcom). The yoe docs claim the board "reaches a login shell on recent mainline kernels using the qrb2210-rb1 device tree". This looks **outdated** now that the dedicated Imola DTS is upstream — [yoe UNO Q docs](https://docs.yoebuild.org/machine-uno-q.html)

### Inferences
- The DSI/DP bridge and spidev fixes were committed to the qcom tree on 2026-03-26, during the 7.0-rc cycle. They most likely reached mainline in **v7.1**. The pm4125 vbus fix (2026-07-15) most likely landed in 7.2 or 7.3. These versions are inferred from the commit dates, not verified against tags.
- For a headless agentic-control distro, **mainline ≥ 7.2 is sufficient**. Everything the router/bridge stack needs (spidev, `ttyHS1`, GPIO, Wi-Fi, USB gadget) is upstream. Only audio, camera and multimedia push you onto Arduino's fork or the 48-patch carry set.
- If you don't need video, consider disabling Venus in the DT or installing a correctly-named firmware symlink. Otherwise unused clocks stay on, with a likely cost in power and heat.

### Gaps
- I did not find Phoronix coverage of the specific 7.0 Qualcomm DT merge, and I didn't check exact tag containment for the post-7.0 fixes.
- I couldn't find the lore.kernel.org Message-IDs for the April 2026 overlay series or its review state. The ratatoskr archive page wasn't opened.
- There are no published per-subsystem test results for mainline beyond the Nerves README and the Armbian PR claims.
- I didn't verify whether the CAMSS/OPE or audio patches have been posted upstream yet. The topic branches suggest they are being prepared.

---

## 2. Arduino's own build system: how is the stock Debian image built, and can users reproduce it?

### Takeaway
The stock image is **Debian 13 (trixie) built with debos** from [arduino/arduino-deb-images](https://github.com/arduino/arduino-deb-images). This is a "continuously rebased" downstream of Qualcomm's [qcom-deb-images](https://github.com/qualcomm-linux/qcom-deb-images). Both the recipes and the boot-binary bundle are public, so you can reproduce it in principle. However, the repo warns not to use it as an upstream, and it pulls packages from Arduino's apt repo. Arduino also maintains a separate Yocto layer, `meta-arduino` (see Q3).

### Cited Findings
- The repo description is "[Continuously rebased, don't use as upstream] Arduino Debian Linux build scripts, based on Qualcomm Linux Debian". The default branch is `arduino` and it was last pushed 2026-11-02 — GitHub API, [arduino/arduino-deb-images](https://github.com/arduino/arduino-deb-images)
- The README (inherited from qcom-deb-images) describes:
  - debos recipes "based on Debian trixie", requiring debos ≥ 1.1.5 and qdl ≥ 2.1
  - the build steps `make rootfs.tar` → `make disk-ufs.img` / `make disk-sdcard.img` → `make flash`
  - optional custom kernel debs via `EXTRA_DEBOS_OPTS="-t localdebs:local-debs/ -t kernelpackages:none"`
  - images are flashed and tested on real boards in a LAVA lab
  - Source: [arduino-deb-images README](https://github.com/arduino/arduino-deb-images)
- Recipe files in the repo:
  - `debos-recipes/qualcomm-linux-debian-rootfs.yaml`, `…-rootfs-arduino-extra.yaml`, `…-rootfs-variant.yaml`
  - `…-image.yaml`, `…-image-arduino.yaml`, `…-flash.yaml`
  - kernel config fragments: `kernel-configs/arduino.config`, `arduino-accessories.config`, `docker.config`, `incus.config`, `panel.config`, `systemd-boot.config`, `squashfs.config`, `watchdog.config`, `usb-can.config`, and others
  - scripts: `build-linux-deb.py`, `build-u-boot-rb1.sh`, `gen-ptool.sh`
  - Source: [arduino-deb-images tree](https://github.com/arduino/arduino-deb-images/tree/arduino/debos-recipes)
- The Arduino image recipe creates an ESP (vfat, 512 MB) and an ext4 root (default 4 GiB). For `targetboard == "unoq"` it adds an ext4 `/home` partition (default 1 GiB) — [qualcomm-linux-debian-image-arduino.yaml](https://github.com/arduino/arduino-deb-images/blob/arduino/debos-recipes/qualcomm-linux-debian-image-arduino.yaml)
- The flash recipe defines board `qrb2210-arduino-imola`:
  - it downloads boot binaries from `https://downloads.arduino.cc/debian-im/unoq-bootloader-emmc-linux-251020.zip` (sha256 `c606e95d…`)
  - it uses the ptool platform `qrb2210-unoq-abl/emmc-16GB-arduino` and DTB `qcom/qrb2210-arduino-imola.dtb`
  - it also has an RB1-style `qrb2210-arduino-uno-q` entry that copies a U-Boot binary to `boot.img`
  - Source: [qualcomm-linux-debian-flash.yaml](https://github.com/arduino/arduino-deb-images/blob/arduino/debos-recipes/qualcomm-linux-debian-flash.yaml)
- Upstream **qcom-deb-images** (Qualcomm) also contains the `qrb2210-arduino-imola` board, with platform `qrb2210-unoq/emmc-16GB`. Its CI badges include "arduino", "mainline" and "linux-next" image builds — [qcom-deb-images flash recipe](https://github.com/qualcomm-linux/qcom-deb-images/blob/main/debos-recipes/qualcomm-linux-debian-flash.yaml); [qcom-deb-images README](https://github.com/qualcomm-linux/qcom-deb-images)
- Arduino-specific overlays (`debos-recipes/overlays/arduino-common-releases/`) include:
  - an Arduino apt keyring and `sources.list.d/arduino.list`
  - an Avahi service, a Docker `daemon.json`, a LightDM greeter patch
  - sshd/avahi systemd presets, a `key_events.service`
  - udev rules for LEDs, gpiod and touchscreen
  - Source: [arduino-deb-images tree](https://github.com/arduino/arduino-deb-images/tree/arduino/debos-recipes/overlays/arduino-common-releases)
- The vendor kernel ships as a pinned Debian package (e.g. `linux-image-7.0.0-g122c2c22d838`) from `apt-repo.arduino.cc`. Board config lives in the `arduino-linux-config` package, which handles carrier/overlay enablement. Firmware comes from `firmware-qcom-soc`, `firmware-atheros` and `arduino-unoq-radio-firmware` — [yoe UNO Q docs](https://docs.yoebuild.org/machine-uno-q.html); [arduino/arduino-linux-config](https://github.com/arduino/arduino-linux-config)
- The factory image download is about **2.2 GB `.tar.zst`** — [technosec-dev/arduino-uno-q-toolkit](https://github.com/technosec-dev/arduino-uno-q-toolkit)
- [arduino/arduino-flasher-cli](https://github.com/arduino/arduino-flasher-cli) commands:
  - `flash unoq` (latest image from an online manifest)
  - `flash path/to/image` (a local archive or directory, so it can flash custom qdl bundles)
  - `download unoq --dest-dir`
  - `cache list|clear`
  - Source: [arduino-flasher-cli README](https://github.com/arduino/arduino-flasher-cli)
- Arduino maintains static qdl builds in [arduino/qdl-packing](https://github.com/arduino/qdl-packing) (GitHub API description: "Release pipelines to create static builds of the qdl tool").

### Inferences
- **Reproducibility:** the debos path can be reproduced (recipes are public, and the boot zip and apt repo are reachable). It is not hermetically pinned, though: it uses a moving Debian mirror, Arduino's apt repo and a rebased branch. For bit-for-bit reproducibility, the Yocto/kas lockfile path (Q3) is the better fit.
- A lean fork is straightforward: fork upstream `qcom-deb-images` rather than the "continuously rebased" Arduino fork. Drop the Docker/LightDM/desktop overlays and pass `-t kernelpackages:none` with your own mainline kernel deb.
- The stock image puts the App Lab apps in Docker (Docker `daemon.json`, the `docker.config` kernel fragment). If your agentic stack doesn't use containers, removing Docker frees a meaningful amount of RAM and storage on the 2 GB SKU (see Q8).

### Gaps
- I didn't verify which exact kernel branch and commit the current stock image release uses. The candidates are the Arduino apt `linux-image-7.0.0-g…` package and the `early/hwe/arduino` CI branch.
- The Arduino "Flash a Linux Image" doc page failed to fetch, so the official flasher-driven EDL steps come from secondary sources.

---

## 3. Yocto/OpenEmbedded: meta-qcom status, Arduino layers, MACHINE names, Qualcomm Linux releases, commercial support

### Takeaway
UNO Q Yocto support is first-class and **maintained by Qualcomm** in [qualcomm-linux/meta-qcom-arduino](https://github.com/qualcomm-linux/meta-qcom-arduino), with `MACHINE = "uno-q"`. It sits on top of meta-qcom and has a `wrynose` (Yocto 6.0 LTS, Qualcomm Linux 2.x, linux-qcom 6.18) branch and a `main` branch (linux-qcom-next). Arduino's own [arduino/meta-arduino](https://github.com/arduino/meta-arduino) adds `MACHINE = "imola"` (which wraps `uno-q`), product images, a PREEMPT_RT kernel and committed kas lockfiles. Mender has a verified A/B integration. Foundries.io supports the board only as a "container-only" factory.

### Cited Findings
- **meta-qcom-arduino** (created 2026-08-19, pushed 2026-11-05) is "maintained by Qualcomm and builds on top of meta-qcom". It depends on openembedded-core (master) and qualcomm-linux/meta-qcom (master). Branches:
  - **main**: "focus on upstream support… linux-qcom-next as the default kernel"
  - **wrynose**: "LTS branch based on the Yocto Project 6.0 release, used by Qualcomm Linux 2.x, with linux-qcom 6.18 as the default kernel"
  - Machines: `uno-q` (QRB2210/QCM2290) and `ventuno-q` (QCS8275)
  - Source: [meta-qcom-arduino README](https://github.com/qualcomm-linux/meta-qcom-arduino)
- `conf/machine/uno-q.conf` contents — [uno-q.conf](https://github.com/qualcomm-linux/meta-qcom-arduino/blob/main/conf/machine/uno-q.conf):
  - `require conf/machine/include/qcom-qcm2290.inc`
  - `MACHINE_FEATURES = "efi usbhost usbgadget alsa wifi bluetooth"`
  - `PREFERRED_PROVIDER_virtual/bootloader ?= "u-boot-arduino"`, with `UBOOT_CONFIG[qrb2210-arduino-imola] = "qcom_defconfig"`
  - `KERNEL_DEVICETREE = qcom/qrb2210-arduino-imola.dtb`
  - it RRECOMMENDS `qbootctl`, with the comment "The boot firmware will switch to slot B and fail to boot otherwise"
  - `QCOM_PARTITION_FILES_SUBDIR ?= "partitions/qrb2210-unoq-abl/emmc"`
  - `QCOM_BOOT_FIRMWARE = "firmware-qcom-boot-qrb2210-arduino-imola"`
- Kernel recipes:
  - `linux-arduino_7.2.bb` builds `LINUX_VERSION 7.2.11` from `github.com/arduino/linux-qcom` (branch comment `qcom-v7.2.11-arduino`, SRCREV `f56a3e0c…`) using defconfig plus fragments — [linux-arduino_7.2.bb](https://github.com/qualcomm-linux/meta-qcom-arduino/blob/main/recipes-kernel/linux/linux-arduino_7.2.bb)
  - kas CI files also cover `linux-qcom-next`, `linux-qcom-next-rt`, `linux-qcom-6.18` and `linux-qcom-rt-6.18` — [meta-qcom-arduino ci/](https://github.com/qualcomm-linux/meta-qcom-arduino/tree/main/ci)
- U-Boot recipe `u-boot-arduino_git.bb`:
  - source is `github.com/arduino/u-boot.git` branch `qcom-mainline`, `PV = "2025.10+2026.01-rc3+git"`
  - it gzips U-Boot, appends the DTB, and wraps it with `mkbootimg --base 0x80000000 --pagesize 4096` into an Android boot image deployed as `boot-${MACHINE}.img`
  - Source: [u-boot-arduino_git.bb](https://github.com/qualcomm-linux/meta-qcom-arduino/blob/main/recipes-bsp/u-boot/u-boot-arduino_git.bb)
- The boot firmware recipe fetches `https://downloads.arduino.cc/debian-im/unoq-bootloader-emmc-linux-251020.zip` under `LICENSE = "LicenseRef-LICENSE.qcom"` — [firmware-qcom-boot-qrb2210-arduino-imola_251020.bb](https://github.com/qualcomm-linux/meta-qcom-arduino/blob/main/recipes-bsp/firmware-boot/firmware-qcom-boot-qrb2210-arduino-imola_251020.bb)
- The firmware packagegroup `packagegroup-uno-q` pulls — [packagegroup-uno-q.bb](https://github.com/qualcomm-linux/meta-qcom-arduino/blob/main/recipes-bsp/packagegroups/packagegroup-uno-q.bb):
  - `linux-firmware-qcom-adreno-a702` and `linux-firmware-qcom-qcm2290-adreno` (only if opengl/vulkan/opencl is enabled)
  - `linux-firmware-ath10k-wcn3990` and `linux-firmware-qcom-qcm2290-wifi`
  - `linux-firmware-qca-wcn3988` (BT)
  - `linux-firmware-qcom-qcm2290-audio`, `linux-firmware-qcom-qcm2290-modem`, `linux-firmware-qcom-venus-6.0`
  - `hexagon-dsp-binaries-thundercomm-rb1-adsp`
  - kernel modules `anx7625`, `leds-group-multicolor`, `spidev`
- **meta-qcom** (master) has the RB1 reference machines and the SoC support. There is no UNO Q machine in meta-qcom itself. Relevant contents — GitHub API tree of [qualcomm-linux/meta-qcom](https://github.com/qualcomm-linux/meta-qcom):
  - `conf/machine/qrb2210-rb1-core-kit.conf`, `rb1-core-kit.conf`, `include/qcom-qcm2290.inc`
  - RB1 boot firmware and CDT recipes, `linux-yocto-7.2` BSP fragments `qcom-qcm2290.cfg/.scc`
  - CI configs including `qcom-distro-sota.yml`, `linux-qcom-next-rt.yml` and secure-boot/capsule test-key configs
- **arduino/meta-arduino** (created 2026-02-17) contains — [meta-arduino README](https://github.com/arduino/meta-arduino):
  - `meta-arduino-common`: ADB, arduino-cli, arduino-app-cli, arduino-router, USB gadget, images (console, container, weston, multimedia, OTBR)
  - `meta-arduino-qcom`: Imola/UNO Q and Monza/VENTUNO Q
  - `meta-arduino-nxp`, and `meta-arduino-lmp` (Foundries LmP compatibility; scarthgap only)
- In DEVELOPERS.md, QCom builds use kas-container — [meta-arduino DEVELOPERS.md](https://github.com/arduino/meta-arduino/blob/master/DEVELOPERS.md):
  - build command: `./kas-container --runtime-args "--memory=48g" build meta-arduino-qcom/ci/imola.yml`
  - "the only supported image for QCom boards is `arduino-container-image`"
  - committed `.lock.yml` files exist "to ensure reproducible builds"
  - flash with `qdl --storage emmc --debug prog_firehose_ddr.elf rawprogram0.xml patch0.xml` from the `…qcomflash.tar.gz` output
- `imola.conf` — [imola.conf](https://github.com/arduino/meta-arduino/blob/master/meta-arduino-qcom/conf/machine/imola.conf):
  - `require conf/machine/uno-q.conf`
  - when the kernel is `linux-qcom-next-rt` it adds `isolcpus=2,3 nohz_full=2,3 rcu_nocbs=2,3 irqaffinity=0-1 rcupdate.rcu_expedited=1 cpuidle.off=1`
  - it pins the Arduino Zephyr core `0.55.0`, `zephyr-arduino_uno_q_stm32u585xx` and a default sketch
  - it RRECOMMENDS `arduino-router`
- `linux-arduino-rt.bb` adds `preempt-rt.cfg` on top of linux-arduino 7.2 — [linux-arduino-rt.bb](https://github.com/arduino/meta-arduino/blob/master/meta-arduino-qcom/recipes-kernel/linux/linux-arduino-rt.bb)
- The kas base pulls `meta-qcom-arduino` from `github.com/qualcomm-linux/meta-qcom-arduino.git` branch `main`. Targets are `arduino-console-image`, `arduino-container-image` and `arduino-full-image` — [meta-arduino-qcom/ci/base.yml](https://github.com/arduino/meta-arduino/blob/master/meta-arduino-qcom/ci/base.yml)
- **Mender** (posted 2026-07-15) — [Mender Hub: Arduino Uno Q](https://hub.mender.io/t/arduino-uno-q-main-system-yocto/8321); [theyoctojester/mender-community-images](https://github.com/theyoctojester/mender-community-images):
  - Yocto 6.0 wrynose, `MACHINE: uno-q`
  - kas file `yocto/wrynose/floating/uno-q.yml` in mender-community-images, using `meta-mender-qcom`
  - it reuses Qualcomm-native A/B slots (ABL + `qbootctl`) through a custom `qbootctl-rootfs` Update Module, with no U-Boot/GRUB integration
  - "Runtime verified on hardware against Hosted Mender, including… rollback of a deliberately broken artifact"
  - it inherits meta-qcom CI defaults such as root with an empty password
  - the post names the BSP layers as meta-qcom + meta-qcom-3rdparty
- A community toolkit uses meta-qcom (wrynose) + meta-qcom-arduino (main) + meta-lts-mixins (for linux-firmware) + meta-exein, with `MACHINE = uno-q` and `INIT_MANAGER = "systemd"`. It says the resulting image is "a few hundred megabytes" — [technosec-dev/arduino-uno-q-toolkit](https://github.com/technosec-dev/arduino-uno-q-toolkit)
- **[yoe] distribution** has an `arduino-uno-q` machine (`machines/arduino-uno-q.star`, BSP in `module-qcom`) — [yoe UNO Q docs](https://docs.yoebuild.org/machine-uno-q.html); [yoebuild/module-qcom](https://github.com/yoebuild/module-qcom):
  - it wraps the Arduino BSP apt feed with the vendor kernel, U-Boot → systemd-boot, and writes only the `efi` and `rootfs` partitions
  - `yoe deploy <unit> <host>` updates units over SSH
- **Foundries.io:** the UNO Q is "supported by the Container-only Factory solution", the board ships with Debian, and the Community Edition is free — [Foundries.io docs: Arduino UNO Q](https://docs.foundries.io/latest/getting-started/arduino-uno-q/); [foundries.io/arduino-uno-q](https://foundries.io/arduino-uno-q)

### Inferences
- **MACHINE naming conflict to note:** use `uno-q` with Qualcomm's meta-qcom-arduino, and `imola` with Arduino's meta-arduino (which requires `uno-q.conf`).
- The Mender post (July 2026) mentions meta-qcom-3rdparty, while meta-qcom-arduino was created in August 2026. The machine likely moved from meta-qcom-3rdparty into meta-qcom-arduino, so older guides may point at the wrong layer. This is inferred from the dates.
- For a **lean, reproducible headless distro**, the strongest base is meta-qcom-arduino `wrynose` (LTS) or `main`. Use your own distro and image recipe (start from `core-image-minimal`, not `arduino-container-image`), plus kas lockfiles. You get pinned SRCREVs, SBOM/CVE tooling (meta-arduino ships `sbom-cve-check.yml`) and an RT kernel option for free.
- Foundries "container-only" means FoundriesFactory manages Docker apps on top of Arduino's Debian. It is not an LmP OSTree base image for the UNO Q. I did not verify this beyond the doc wording.
- **Agent-tooling note:** both meta-arduino and meta-qcom-arduino ship `AGENTS.md`/`CLAUDE.md` files in their repo trees, which signals that the maintainers expect AI-assisted development.

### Gaps
- I didn't find a Qualcomm Linux release-notes document that formally lists QRB2210/UNO Q as supported in "Qualcomm Linux 2.x". The only statement is the meta-qcom-arduino README's wrynose branch note.
- I didn't verify meta-qcom-3rdparty's current contents, or whether a meta-qcom "qcom-distro-sota" (OSTree) build is enabled for `uno-q`.
- Foundries' LmP machine support for the UNO Q, if any, was not confirmed.

---

## 4. Buildroot: any defconfig for UNO Q or QRB2210/RB1, and community attempts?

### Takeaway
Upstream Buildroot has **no** UNO Q, RB1 or QRB2210 defconfig. The most mature Buildroot-based work is the **Nerves system** by jimsynz (`nerves_system_arduino_uno_q` v0.1.3, 2026-10-28). It uses mainline 7.2 with Wi-Fi, the MCU router, a squashfs A/B rootfs and qdl provisioning, so it doubles as a ready reference for a minimal mainline Buildroot UNO Q build.

### Cited Findings
- The GitHub API listing of `buildroot/buildroot/configs` shows no files matching uno, rb1, qrb, qcom, arduino or 2290 — [buildroot configs](https://github.com/buildroot/buildroot/tree/master/configs)
- Forks: `jimsynz/buildroot` has an `arduino_uno_q` branch (GitHub API) — [jimsynz/buildroot](https://github.com/jimsynz/buildroot/tree/arduino_uno_q). A KozhinovAlexander fork with an arduino_uno_q branch is mentioned in an Arduino forum thread (search snippet only) — [Arduino forum: Buildroot support for UNO Q](https://forum.arduino.cc/t/buildroot-support-for-uno-q/1410877)
- In the same forum thread (snippet only), one user could not get a patched Buildroot build running. Another said building U-Boot with arduino/u-boot's `qcom_defconfig` "Just worked" — [Arduino forum: UNO Q U-Boot support](https://forum.arduino.cc/t/arduino-uno-q-qrb2210-u-boot-support/1459030) (page returned 403; content from a search snippet)
- **Nerves system** (`jimsynz/nerves_system_arduino_uno_q`, releases v0.1.1–v0.1.3 on 2026-10-27/28) — [jimsynz/nerves_system_arduino_uno_q](https://github.com/jimsynz/nerves_system_arduino_uno_q):
  - mainline 7.2, Arduino's U-Boot fork loaded by Qualcomm's ABL
  - console on `ttyMSM0`, USB Ethernet gadget, Wi-Fi via VintageNet
  - MCU via `arduino-router` and an `unoq-mcu` OpenOCD SWD wrapper
  - eMMC layout: partitions 1–66 untouched (Qualcomm); 67/68 `boot_a`/`boot_b` (FAT with Image + DTB); 69/70 `rootfs_a`/`rootfs_b` (squashfs); 71 `data` (f2fs)
  - "fwup can't write a GPT with this many entries", so `mix firmware.qdl` writes the GPT and fwup writes only inside it
  - updates go over USB networking or Wi-Fi with `mix upload` (Nerves A/B handled by U-Boot)
- Earlier Nerves state (Dec 2025): the board booted but Wi-Fi did not come up — [Elixir Forum thread](https://elixirforum.com/t/nerves-buildroot-for-arduino-uno-q/73411). An older `mlainez/nerves_system_arduino_uno_q` also exists (last pushed 2025-11-02) — GitHub search API.

### Inferences
- A plain Buildroot BSP can be derived from the Nerves system:
  - kernel: mainline 7.2+ with arm64 defconfig plus Qualcomm options
  - U-Boot: arduino/u-boot `qcom-mainline` with `qcom_defconfig`, wrapped with mkbootimg as `boot.img`
  - rootfs: `rmtfs`, `tqftpserv`, `qrtr`, the linux-firmware subset, arduino-router, and the gpiod/spidev tools
  - Buildroot then gives the leanest image (squashfs, no package manager), with fwup or SWUpdate for A/B.
- Upstreaming a `arduino_uno_q_defconfig` to Buildroot looks feasible now that the DTS is in mainline and in U-Boot's `dts/upstream`. As far as I found, nobody has done it yet.

### Gaps
- I couldn't fetch the Arduino forum threads (403), and I didn't inspect the `jimsynz/buildroot` branch contents.
- I found no Buildroot mailing-list submission for the UNO Q.

---

## 5. Other distros: Armbian, postmarketOS, Fedora/Ubuntu/Alpine/NixOS, Debian upstream, Linaro RB1 reference

### Takeaway
**Armbian** is the most turnkey alternative. It offers "Standard"-support images for Debian 13 and Ubuntu 26.04 on a mainline-based edge kernel (7.1.7 stable, 7.2.3 rolling), and a minimal CLI image of about 300 MB. **Debian proper** works through Qualcomm's qcom-deb-images (with mainline and linux-next variants in CI). No postmarketOS, Fedora, Alpine or NixOS port was found. Forum users are attempting Devuan and Maemo Leste ports. The RB1 is the Linaro/Qualcomm reference twin and shares the SoC enablement.

### Cited Findings
- **Armbian board page** — [armbian.com/boards/arduino-uno-q](https://armbian.com/boards/arduino-uno-q):
  - support level "Standard"; maintainers SuperKali and Sander; images are "QDL image" type (Armbian Imager recommended)
  - Aug 8, 2026 builds on edge **7.1.7**: Ubuntu 26.04 GNOME (1.1 GB), KDE (1.5 GB), Ubuntu 26.04 minimal (295 MB), Debian 13 minimal (302 MB), plus Kali, Home Assistant and OMV variants
  - Nov 4, 2026 rolling builds on edge **7.2.3**: Ubuntu 26.04 minimal (330 MB), Debian 13 minimal (334 MB)
  - build command: `./compile.sh BOARD=arduino-uno-q RELEASE=trixie BUILD_DESKTOP=no BUILD_MINIMAL=yes KERNEL_CONFIGURE=no`
- Armbian history:
  - initial support PR #9623 — [armbian/build PR #9623](https://github.com/armbian/build/pull/9623)
  - CI fix that fetches "qcombin" at image creation time, so Qualcomm boot binaries are not redistributed in-tree — [PR #9642](https://github.com/armbian/build/pull/9642)
  - switch from the Arduino fork to mainline v7.0 plus 48 carried patches, merged 2026-04-22 — [PR #9710](https://github.com/armbian/build/pull/9710)
  - bump to mainline 7.1 — [PR #10171](https://github.com/armbian/build/pull/10171)
  - the board config file is `config/boards/arduino-uno-q.csc` with the DTB `qcom/qrb2210-arduino-imola.dtb` — [arduino-uno-q.csc](https://github.com/armbian/build/blob/main/config/boards/arduino-uno-q.csc)
- An Armbian firmware PR adds QCM2290 firmware: ath10k WCN3990 Wi-Fi, QCA BT, A702 GPU, ADSP, modem and Venus 6.0 — [armbian/firmware PR #123](https://github.com/armbian/firmware/pull/123) (seen through a search result)
- **Debian:** qcom-deb-images builds Debian trixie images, with CI variants "Debian", "linux-next", "mainline" and "arduino", and includes the `qrb2210-arduino-imola` board — [qcom-deb-images](https://github.com/qualcomm-linux/qcom-deb-images)
- **RB1 reference:** the Linaro RB1 rescue boot bundle (23.12) is at artifacts.codelinaro.org, and qcom-deb-images builds U-Boot for RB1 via `scripts/build-u-boot-rb1.sh` — [arduino-deb-images flash recipe](https://github.com/arduino/arduino-deb-images/blob/arduino/debos-recipes/qualcomm-linux-debian-flash.yaml); [qcom-deb-images README](https://github.com/qualcomm-linux/qcom-deb-images). meta-qcom carries `qrb2210-rb1-core-kit` machine support — [meta-qcom](https://github.com/qualcomm-linux/meta-qcom)
- **Community ports:** forum users report attempts to port Maemo Leste and Devuan. The Devuan user hit an early boot issue and was pointed to the 1.8 V debug UART — [Arduino forum: Error while porting OS](https://forum.arduino.cc/t/error-while-porting-os-to-uno-q/1456415); [Arduino forum: Booting issue with porting](https://forum.arduino.cc/t/booting-issue-with-uno-q-porting/1444112) (both from search summaries, not opened)
- **NixOS:** the generic NixOS-on-ARM policy is that support is "just as much as mainline Linux and U-Boot supports them". No UNO Q-specific page exists — [NixOS on ARM wiki](https://wiki.nixos.org/wiki/NixOS_on_ARM)
- **DietPi:** a DietPi GitHub issue appeared in search results about UNO Q images; status unknown — [DietPi issue #7916](https://github.com/MichaIng/DietPi/issues/7916) (not opened)

### Inferences
- The U-Boot (UEFI) → systemd-boot/GRUB chain plus a mainline DTB is in place. Any generic arm64 UEFI distro (Fedora, Alpine, NixOS, Ubuntu generic) should be able to boot from the `efi`/`rootfs` partitions in principle. The UNO Q-specific work is limited to:
  1. writing the image through qdl (no SD/USB boot by default)
  2. firmware packaging plus the `rmtfs`/`tqftpserv`/`qrtr` userspace for Wi-Fi
  3. running `qbootctl -m` after boot
  4. the 1.8 V UART for debugging
  - I didn't verify this, because no one has published a Fedora/Alpine/NixOS UNO Q success report.
- On Armbian's support tier, the board page says "Standard" while the config file uses the `.csc` (community-supported config) extension. Treat support status as uncertain.

### Gaps
- postmarketOS: I found no device port for the UNO Q or any QCM2290 device. The pmaports GitLab API query returned nothing (possibly an auth requirement).
- I didn't verify whether Debian's own `linux-image-arm64` (forky/sid with 7.x) ships `qrb2210-arduino-imola.dtb` and the required modules. It is likely, since Debian builds all arm64 qcom DTBs, but unconfirmed.
- No Fedora, Alpine, NixOS or Ubuntu-generic boot report was found.

---

## 6. Boot chain and flashing: XBL/ABL/U-Boot/UEFI, locked/signed, flashing tools, partition layout, USB/SD/network boot, recovery

### Takeaway
The production chain is: **PBL (ROM) → XBL → TZ/RPM/HYP → Qualcomm ABL → U-Boot (an Android boot image in `boot_a/b`) → EFI → systemd-boot (or direct kernel) from the `efi` partition → rootfs**. Everything up to and including ABL is Qualcomm-signed, factory-provisioned firmware that you reuse as a binary bundle. U-Boot onward is fully replaceable. Flashing is done with **qdl in EDL mode** (jumper `USB_BOOT` to `GND` on the JCTL header), which lives in ROM, so the board can't be hard-bricked from eMMC. The A/B "boot successful" marking (`qbootctl -m`) is mandatory, or ABL flips slots or drops to fastboot after a few boots.

### Cited Findings
- Nerves documents the chain as: "Qualcomm's boot firmware (PBL, XBL, ABL) is left as Arduino ships it. ABL loads U-Boot from the Android boot image in the `boot_a` partition." U-Boot keeps its environment in eMMC at 4 MiB and adds the Wi-Fi MAC and BT address to the DT. "ABL stops in fastboot if the active slot isn't marked successful within seven boots." — [nerves_system_arduino_uno_q README](https://github.com/jimsynz/nerves_system_arduino_uno_q)
- The Qualcomm U-Boot recipe confirms the packaging: U-Boot plus DTB is wrapped with `mkbootimg` into `boot-uno-q.img` — [u-boot-arduino_git.bb](https://github.com/qualcomm-linux/meta-qcom-arduino/blob/main/recipes-bsp/u-boot/u-boot-arduino_git.bb)
- The yoe docs give: PBL → XBL → TrustZone/RPM/Hypervisor → U-Boot ("in the `abl` slot") → systemd-boot 257.8 → BLS Type #1 → kernel + initrd. U-Boot presents UEFI 2.11 and loads the DTB from `/boot/efi/dtb/qcom/qrb2210-arduino-imola.dtb` on the ESP. `qbootctl -m` must run after `boot-complete.target`, "or the firmware eventually switches slots and the board stops booting" — [yoe UNO Q docs](https://docs.yoebuild.org/machine-uno-q.html). The yoe "abl slot" wording **conflicts** with Nerves and the Qualcomm recipe (U-Boot in `boot_a/b`). The ptool layout below has both `abl_a/b` (abl.elf) and `boot_a/b` (boot.img), which supports the Nerves description.
- **U-Boot sources:**
  - [arduino/u-boot](https://github.com/arduino/u-boot/tree/qcom-mainline) branch `qcom-mainline`, plus branches `qcom-mainline-v2026.10-rc2/rc5` and `qcom-denx-mainline(-emmc)`
  - recent commits: "boards: arduino: add UNO Q support", "qcom_defconfig: Add VID/PID to represent fastboot device", "qcom: of_fixup: Add Bluetooth BDADDR fixup for qcom,wcn3988-bt", "qrb2210: Imola: Add SMBIOS U-Boot DT node", "mmc: msm_sdhci: Fix incorrect divider calculation", and "DO_NOT_UPSTREAM: backport qrb2290 dts" (Dec 2025)
  - Source: GitHub API on arduino/u-boot
  - **Upstream U-Boot** (v2026.10 / v2027.01-rc1) already contains `dts/upstream/src/arm64/qcom/qrb2210-arduino-imola.dts` and `agatti.dtsi` (synced from Linux) — [u-boot dts/upstream qcom](https://github.com/u-boot/u-boot/tree/master/dts/upstream/src/arm64/qcom)
- **Partition layout** (qcom-ptool `_common/qrb2210-abl-emmc.yaml`, used by `qrb2210-unoq-abl`) — [qcom-ptool qrb2210-abl-emmc.yaml](https://github.com/qualcomm-linux/qcom-ptool/blob/main/platforms/_common/qrb2210-abl-emmc.yaml); [qrb2210-unoq-abl-arduino.yaml](https://github.com/qualcomm-linux/qcom-ptool/blob/main/platforms/boards/qrb2210-unoq-abl-arduino.yaml):
  - A/B pairs: `xbl_a/b` (xbl.elf), `xbl_config`, `tz`, `rpm`, `hyp`, **`boot_a/b` (4 MB, boot.img)**, `uefi_a/b`, `uefi_dtb`, `dtb_a/b` (64 MB, dtb.bin), `keymaster`, `mdtp`, **`abl_a/b` (1 MB, abl.elf)**, `imagefv`, `uefisecapp`, `devcfg`, `featenabler`, `qupfw`, `multiimgoem`
  - single partitions: `persist`, `misc`, `devinfo`, `modemst1/2`, `fsg`, `fsc` (modem EFS, needed by rmtfs), `splash`, `logdump`, `uefivarstore`, and others
  - **`efi` (512 MB, efi.bin)** and **`rootfs` (~10 GB, rootfs.img)**
  - the Arduino SKU variant adds `userdata` (~2 GB)
  - The yoe docs count 69 GPT entries, with `[yoe]` owning 67 `efi`, 68 `rootfs` and 69 `userdata`. The eMMC boot0/boot1 hardware areas hold `bdaddr`, `wlanaddr`, `CDT` and others — [yoe UNO Q docs](https://docs.yoebuild.org/machine-uno-q.html)
- qcom-ptool also defines a **non-ABL** `qrb2210-unoq` layout. It has no `abl`/`boot` partitions and has `uefi_a/b` with `uefi.elf` plus `uefi_dtbs.elf`. Upstream qcom-deb-images uses this platform for Imola (`qrb2210-unoq/emmc-16GB`) — [qcom-ptool qrb2210-emmc.yaml](https://github.com/qualcomm-linux/qcom-ptool/blob/main/platforms/_common/qrb2210-emmc.yaml); [qcom-deb-images flash recipe](https://github.com/qualcomm-linux/qcom-deb-images/blob/main/debos-recipes/qualcomm-linux-debian-flash.yaml)
- **EDL / qdl flashing** — [yoe UNO Q docs](https://docs.yoebuild.org/machine-uno-q.html); [technosec toolkit](https://github.com/technosec-dev/arduino-uno-q-toolkit); [Mender Hub](https://hub.mender.io/t/arduino-uno-q-main-system-yocto/8321); [nerves README](https://github.com/jimsynz/nerves_system_arduino_uno_q):
  - power off, jumper JCTL `USB_BOOT` to `GND`, connect USB-C; the board enumerates as `05c6:9008` (normal mode is `2341:xxxx`)
  - stop ModemManager or set `ID_MM_DEVICE_IGNORE`, and unload or blacklist `qcserial`/`qmi_wwan`
  - run `qdl --allow-missing --storage emmc prog_firehose_ddr.elf rawprogram0.xml patch0.xml`
  - remove the jumper afterwards, or the board re-enters EDL on every boot
  - "EDL lives in ROM, so no eMMC image can block it"
- [linux-msm/qdl](https://github.com/linux-msm/qdl) ≥ 2.1 is recommended — [qcom-deb-images README](https://github.com/qualcomm-linux/qcom-deb-images). The Arduino flasher's bundled qdl is amd64-only, so Windows-on-ARM users hit "qdl: unable to open USB device" (search snippet) — [Arduino forum WoA request](https://forum.arduino.cc/t/request-windows-arm64-build-of-arduino-flasher-cli-for-uno-q-qualcomm-windows-pcs/1431089)
- **Serial console:** SE4 UART as `ttyMSM0`, 115200 8N1, **1.8 V** levels. JCTL pin 4 is TX, pin 6 is RX, pin 1/7 is GND — [yoe UNO Q docs](https://docs.yoebuild.org/machine-uno-q.html)
- **Fastboot:** Arduino's U-Boot `qcom_defconfig` has a fastboot VID/PID (GitHub API commit list of arduino/u-boot). Nerves boards that weren't marked successful show up as `18d1:d00d` (fastboot) — [nerves README](https://github.com/jimsynz/nerves_system_arduino_uno_q). A third-party guide describes flashing the bootloader in EDL and then uploading images over fastboot (search snippet) — [codeembedded.com blog](https://www.codeembedded.com/blog/arduino_uno_q_journey_1/)

### Inferences
- **The bootloader is "locked" only below ABL.** XBL, TZ and ABL are signed Qualcomm/Arduino binaries from the `unoq-bootloader-emmc-linux-251020.zip` bundle; you can't rebuild them, so treat them as opaque. ABL boots an unsigned Android boot image (U-Boot) and U-Boot boots anything. In practice the OS stack is fully open.
- **Development loop options:**
  1. **Fastboot** via U-Boot (`fastboot boot`/`flash`) over USB-C, no jumper. This is the fastest kernel iteration.
  2. **U-Boot network boot** (TFTP/PXE/EFI HTTP) over a USB-Ethernet dongle or USB gadget. I didn't find this documented for UNO Q, but it is a standard U-Boot capability.
  3. **SSH-based unit deploy** (`yoe deploy`, `mix upload`).
  4. A full **qdl** reflash of only the `efi` and `rootfs` partitions (yoe writes only these).
  - The board has no SD slot. USB mass-storage boot through U-Boot is plausible but unverified.
- The non-ABL `qrb2210-unoq` ptool layout (with `uefi.elf`) suggests Qualcomm is moving the UNO Q toward a UEFI-firmware boot (XBL → UEFI) without ABL/Android boot images. This is inferred and not verified.

### Gaps
- **Secure-boot fuse state:** I found no official statement. A search summary mentioned a single user's boot log showing "Secure Boot: Off", but I couldn't identify or verify that thread. It is very likely that production units are not fused to an Arduino OEM key, since custom U-Boot and kernels boot, but the XBL/ABL signature policy is unconfirmed.
- I couldn't confirm the exact contents of `unoq-bootloader-emmc-linux-251020.zip`. I did not download it.
- The Arduino "Flash a Linux Image" doc fetch failed, so I don't know whether the official flasher can enter EDL without the jumper (e.g. via `adb reboot edl`).

---

## 7. Required proprietary firmware: which blobs, where from, licensing

### Takeaway
Everything the OS needs at runtime is in **upstream linux-firmware**:
- `qcom/qcm2290/{a702_zap.mbn, adsp.mbn, modem.mbn}` plus their JSN files
- `qcom/a702_sqe.fw`
- `ath10k/WCN3990/hw1.0/` with a `qcm2290` board-data subdir and `wlanmdsp.mbn`
- QCA WCN3988 BT
- Venus/AR50-Lite

Debian packages these as `firmware-qcom-soc` / `firmware-atheros`. The exceptions are the **boot firmware bundle** (XBL/TZ/ABL/etc.), a per-board radio-calibration package, and the ADSP Hexagon userspace binaries (only needed for audio/FastRPC). All three come from Arduino or Qualcomm downloads under Qualcomm's license.

### Cited Findings
- The linux-firmware tree has `qcom/qcm2290/`: `a702_zap.mbn, adsp.mbn, adspr.jsn, adsps.jsn, adspua.jsn, modem.mbn, modemr.jsn, modemuw.jsn`. `qcom/a702_sqe.fw` exists. `ath10k/WCN3990/hw1.0/` contains `qcm2290/`, `shikra/`, `board-2.bin`, `firmware-5.bin`, `notice.txt_wlanmdsp` and `wlanmdsp.mbn` — GitLab API on [kernel-firmware/linux-firmware](https://gitlab.com/kernel-firmware/linux-firmware/-/tree/main/qcom/qcm2290)
- The mainline DTS references `qcom/qcm2290/a702_zap.mbn`, `qcom/qcm2290/adsp.mbn`, `qcom/qcm2290/modem.mbn` and Wi-Fi `firmware-name = "qcm2290"` — [mainline imola DTS](https://github.com/torvalds/linux/blob/master/arch/arm64/boot/dts/qcom/qrb2210-arduino-imola.dts)
- The Qualcomm Yocto packagegroup names the needed packages: `linux-firmware-qcom-adreno-a702`, `-qcom-qcm2290-adreno`, `-ath10k-wcn3990`, `-qcom-qcm2290-wifi`, `-qca-wcn3988`, `-qcom-qcm2290-audio`, `-qcom-qcm2290-modem`, `-qcom-venus-6.0`, plus `hexagon-dsp-binaries-thundercomm-rb1-adsp` — [packagegroup-uno-q.bb](https://github.com/qualcomm-linux/meta-qcom-arduino/blob/main/recipes-bsp/packagegroups/packagegroup-uno-q.bb)
- Debian/vendor sources — [yoe UNO Q docs](https://docs.yoebuild.org/machine-uno-q.html):
  - `firmware-qcom-soc` (Debian non-free-firmware): ADSP, modem, WLAN MDSP, GPU zap
  - `firmware-atheros`: Wi-Fi/BT
  - `arduino-unoq-radio-firmware`: per-PCB board data
  - boot firmware is factory-provisioned
- Wi-Fi depends on the modem DSP. It needs `rmtfs` (serves `modemst1/2`/`fsg` read-only) and `tqftpserv` (serves Wi-Fi firmware) from linux-msm before `wlan0` appears — [nerves README](https://github.com/jimsynz/nerves_system_arduino_uno_q)
- **Venus naming mismatch:** the driver requests `qcom/venus-6.0/venus.mbn`, while linux-firmware ships `qcom/vpu/ar50lt_p1_gen2_s6.mbn` — [nerves README](https://github.com/jimsynz/nerves_system_arduino_uno_q)
- The boot firmware bundle `unoq-bootloader-emmc-linux-251020.zip` is hosted at downloads.arduino.cc and licensed `LicenseRef-LICENSE.qcom` in Yocto — [firmware-qcom-boot recipe](https://github.com/qualcomm-linux/meta-qcom-arduino/blob/main/recipes-bsp/firmware-boot/firmware-qcom-boot-qrb2210-arduino-imola_251020.bb). Armbian fetches "qcombin" at image creation time rather than committing it — [armbian/build PR #9642](https://github.com/armbian/build/pull/9642)
- The board's Wi-Fi MAC, BT address and board revision live in eMMC `boot0`. U-Boot reads them and patches the DT — [nerves README](https://github.com/jimsynz/nerves_system_arduino_uno_q)
- The MCU side ships `/lib/firmware/mcuboot.bin` and `zephyr.signed.bin` in the custom Yocto toolkit; the MCU is flashed over SWD by OpenOCD from Linux GPIOs — [technosec toolkit](https://github.com/technosec-dev/arduino-uno-q-toolkit); [nerves README](https://github.com/jimsynz/nerves_system_arduino_uno_q)

### Inferences
- Licensing:
  - linux-firmware blobs are redistributable under their WHENCE terms.
  - The boot bundle is under a Qualcomm license that build systems avoid committing; Armbian and Yocto download it at build time. For a public distro, follow the same pattern: download at build time and don't redistribute in your repo unless you have checked the LICENSE.qcom terms.
- Minimal headless firmware set (no GPU, audio or video):
  - `qcom/qcm2290/modem.mbn` + JSNs (needed for Wi-Fi)
  - `ath10k/WCN3990/hw1.0/*` incl. `qcm2290/`
  - the WCN3988 BT files, if BT is wanted
  - optionally `adsp.mbn` (it can be left out if audio and sensors aren't used, unverified)
  - `rmtfs`, `tqftpserv`, `qrtr`
  - `arduino-unoq-radio-firmware` or the board-2.bin calibration, if `qcm2290` board data isn't sufficient (unverified)

### Gaps
- I didn't confirm whether `arduino-unoq-radio-firmware` contains anything beyond what linux-firmware's `qcm2290` board data provides, or what its license is.
- The exact WCN3988 BT firmware filenames weren't verified in linux-firmware.
- I didn't read the full text of `LICENSE.qcom` for the boot bundle.

---

## 8. Practical guidance: kernel cross-compile, minimal rootfs, 2 GB RAM footprint, PREEMPT_RT, OTA (RAUC/Mender/SWUpdate/OSTree)

### Takeaway
Cross-compile mainline (≥ 7.2) or `arduino/linux-qcom` with arm64 `defconfig` plus a small board fragment (`ARCH_QCOM`, spidev, ath10k_snoc, qcom remoteproc/rmtfs, anx7625, leds-group-multicolor). Install the DTB on the ESP for U-Boot/systemd-boot. A minimal Debian/Ubuntu image is about 300 MB compressed (Armbian) and a Yocto image is "a few hundred MB". The stock Arduino image idles at about 0.4–0.5 GB RAM. PREEMPT_RT is already packaged by Arduino and Qualcomm (`linux-arduino-rt`, `linux-qcom-next-rt`) with CPU-isolation args. For OTA, **Mender is proven on UNO Q** (using Qualcomm A/B slots), **Nerves/fwup A/B** is proven, and Qualcomm's own stack points to **capsule + OSTree**. I found no RAUC or SWUpdate integration.

### Cited Findings
- **Kernel config:** the Qualcomm recipe copies the in-tree `defconfig` and merges fragments (`arduino.cfg`, `uno-q.cfg`) with `merge_config.sh` — [linux-arduino_7.2.bb](https://github.com/qualcomm-linux/meta-qcom-arduino/blob/main/recipes-kernel/linux/linux-arduino_7.2.bb). Arduino's Debian fragments include `arduino.config`, `docker.config`, `systemd-boot.config`, `squashfs.config` and `watchdog.config` — [arduino-deb-images kernel-configs](https://github.com/arduino/arduino-deb-images/tree/arduino/kernel-configs). Needed modules include `anx7625`, `leds-group-multicolor` and `spidev` — [packagegroup-uno-q.bb](https://github.com/qualcomm-linux/meta-qcom-arduino/blob/main/recipes-bsp/packagegroups/packagegroup-uno-q.bb)
- **Custom kernel into the Debian build:** use `scripts/build-linux-deb.py`, then `EXTRA_DEBOS_OPTS="-t localdebs:local-debs/ -t kernelpackages:none" make rootfs.tar` — [arduino-deb-images README](https://github.com/arduino/arduino-deb-images)
- **Image sizes:**
  - Armbian Debian 13 minimal: 302–334 MB; Ubuntu 26.04 minimal: 295–330 MB — [Armbian board page](https://armbian.com/boards/arduino-uno-q)
  - Arduino factory image: about 2.2 GB `.tar.zst`; a Yocto image: "a few hundred megabytes" — [technosec toolkit](https://github.com/technosec-dev/arduino-uno-q-toolkit)
  - meta-arduino builds suggest giving kas-container `--memory=48g` — [meta-arduino DEVELOPERS.md](https://github.com/arduino/meta-arduino/blob/master/DEVELOPERS.md); Mender notes about 100 GB of disk for a Yocto build (search snippet) — [Mender Hub](https://hub.mender.io/t/arduino-uno-q-main-system-yocto/8321)
- **RAM:** a reviewer measured the stock image at 0.4–0.5 GB idle on the 4 GB model (3.6 GB usable) and about 0.6 GB running an App Lab example. They judged the 2 GB model "perfectly capable" for the examples. App Lab runs one app at a time — [Hackster 2GB vs 4GB](https://www.hackster.io/vsupacha/arduino-uno-q-2gb-vs-4gb-any-difference-249c6b). CNX notes the 2 GB model may swap heavily with multiple heavy processes or AI models (search summary) — [CNX Software 4GB announcement](https://www.cnx-software.com/2026/01/21/arduino-uno-q-4gb-board-with-4gb-ram-32gb-storage-available-59/)
- **PREEMPT_RT:**
  - meta-arduino has `linux-arduino-rt.bb` (linux-arduino 7.2 + `preempt-rt.cfg`) and `linux-qcom-next-rt` bbappends with `preempt-rt.cfg`
  - `imola.conf` adds `isolcpus=2,3 nohz_full=2,3 rcu_nocbs=2,3 irqaffinity=0-1 rcupdate.rcu_expedited=1 cpuidle.off=1` when the RT kernel is selected
  - Sources: [linux-arduino-rt.bb](https://github.com/arduino/meta-arduino/blob/master/meta-arduino-qcom/recipes-kernel/linux/linux-arduino-rt.bb); [imola.conf](https://github.com/arduino/meta-arduino/blob/master/meta-arduino-qcom/conf/machine/imola.conf)
  - meta-qcom-arduino CI has `linux-qcom-next-rt.yml` and `linux-qcom-rt-6.18.yml` — [meta-qcom-arduino ci/](https://github.com/qualcomm-linux/meta-qcom-arduino/tree/main/ci)
- **OTA:**
  - **Mender** — [Mender Hub](https://hub.mender.io/t/arduino-uno-q-main-system-yocto/8321):
    - Yocto wrynose; `system_a/b` rootfs plus `boot_a/b`, `dtbo_a/b` and a persistent `/data`
    - a `qbootctl-rootfs` Update Module with commit and rollback verified on hardware (July 2026)
    - "firmware-level rollback path has not been tested"
  - **Nerves/fwup:** U-Boot-driven A/B with squashfs `rootfs_a/b` and FAT `boot_a/b`, independent of ABL slots; `mix firmware.qdl` pre-marks both ABL slots successful — [nerves README](https://github.com/jimsynz/nerves_system_arduino_uno_q)
  - **Qualcomm Linux:** the documented model is UEFI capsule updates for firmware plus OSTree for the OS — [Qualcomm OTA for Qualcomm Linux](https://docs.qualcomm.com/bundle/publicresource/80-70020-27/topics/ota_update_for_qualcomm_linux.md). meta-qcom has `ci/qcom-distro-sota.yml` and capsule test-key configs — [meta-qcom ci/](https://github.com/qualcomm-linux/meta-qcom/tree/master/ci)
  - **Foundries.io:** container-only OTA on top of the Debian base — [Foundries docs](https://docs.foundries.io/latest/getting-started/arduino-uno-q/)
  - **yoe:** `yoe deploy` per-unit over SSH; the docs say full reflash otherwise and describe "no true OTA mechanism" — [yoe UNO Q docs](https://docs.yoebuild.org/machine-uno-q.html)
- **Distro requirements from the Arduino userspace** — [nerves README](https://github.com/jimsynz/nerves_system_arduino_uno_q); [technosec toolkit](https://github.com/technosec-dev/arduino-uno-q-toolkit); [Mender Hub](https://hub.mender.io/t/arduino-uno-q-main-system-yocto/8321):
  - `arduino-router` talks MsgPack-RPC to the MCU over `/dev/ttyHS1` and exposes `/var/run/arduino-router.sock`; when ready it raises GPIO 70, which tells the MCU that Linux is up
  - MCU flashing uses OpenOCD bit-banging SWD over QRB2210 GPIOs (libgpiod)
  - a USB gadget (CDC-ECM/RNDIS/ADB) is effectively required for headless bring-up: "A custom image with no USB gadget looks dead from the host even when it boots"
  - `qbootctl` must be in the image
- `arduino-router`, `arduino-app-cli`, `arduino-cli` and the USB-gadget setup already have Yocto recipes in `meta-arduino-common` — [meta-arduino tree](https://github.com/arduino/meta-arduino)

### Inferences
**Path comparison for a lean, reproducible, headless agentic-control distro:**

| Path | Maturity (Nov 2026) | Kernel | Effort | Reproducibility | Footprint | Notes |
|---|---|---|---|---|---|---|
| Arduino stock Debian (debos, arduino-deb-images) | Production / factory | Arduino vendor 7.0.x–7.3 | Low | Medium (moving apt and rebased branch) | ~2.2 GB compressed; 0.4–0.5 GB RAM idle | Full features (audio, camera, GPU userspace); heavy (Docker, desktop) |
| Fork of qcom-deb-images (debos), trimmed | Qualcomm CI-tested incl. mainline/linux-next | mainline / qcom-next / arduino | Low–Med | Medium | Can approach Armbian minimal | Debian ecosystem, apt; good if you want apt + mainline |
| **Yocto: meta-qcom + meta-qcom-arduino (`uno-q`)**, optionally meta-arduino (`imola`) | Qualcomm-maintained, nightly CI, LTS branch | linux-qcom 6.18 (wrynose) / qcom-next / linux-arduino 7.2.11 / RT variants | Med–High | **High** (kas lockfiles, SBOM/CVE) | "few hundred MB" | Best fit for reproducible product distro; Mender proven; OSTree via qcom-distro-sota likely |
| Armbian | "Standard" board, regular builds | mainline edge 7.1/7.2 + 48 patches | Low | Medium (Armbian build framework) | ~300 MB minimal | Fastest way to a mainline Debian/Ubuntu; not lean-by-design |
| Buildroot / Nerves | WIP but functional (v0.1.3) | mainline 7.2 | Med | High (Buildroot is deterministic) | Smallest (squashfs) | No upstream defconfig; needs your own A/B (fwup/SWUpdate/RAUC) |
| yoe | Working, vendor-feed based | Arduino vendor 7.0 | Med | Medium | 10 GB rootfs partition (actual smaller) | Interesting dev loop (`yoe deploy`), but tied to Arduino apt |
| Fedora/Alpine/NixOS generic UEFI | Unproven on UNO Q | distro mainline | Med–High | Varies (NixOS high) | Varies | Should boot via U-Boot EFI; untested; must add rmtfs/tqftpserv/qbootctl/firmware |

**2 GB SKU budgeting:** a systemd + NetworkManager + sshd minimal image typically idles well under 200 MB. Most of the stock image's 0.4–0.5 GB comes from Docker, the desktop and Arduino services. For an agentic stack, budget RAM for the agent runtime and any local model; the AI researchers cover those requirements. Disable Venus, the GPU and ADSP if unused, which also saves the firmware-load time and RAM.

**PREEMPT_RT:** PREEMPT_RT is mainline since 6.12, so a mainline 7.x kernel only needs `CONFIG_PREEMPT_RT=y`. Arduino's isolcpus/nohz_full layout (cores 2–3 isolated) is a good starting template if a Linux-side control loop needs determinism. Hard real-time I/O remains the STM32's job.

**OTA recommendation by base:**
- Yocto: Mender (proven) or OSTree via Qualcomm's sota config (unverified for uno-q).
- Buildroot: fwup (Nerves-proven layout) or RAUC/SWUpdate. Copy the Nerves trick of writing the 70-entry GPT with qdl, since tooling can't create it.
- Any base: keep the Qualcomm partitions 1–66 untouched, and run `qbootctl -m` or pre-mark the ABL slots.

**Dev workflow:** use the 1.8 V UART plus the USB gadget, then U-Boot fastboot for kernel iteration. Use qdl to reflash only `efi`/`rootfs`, and keep the 2.2 GB factory image locally for recovery.

### Gaps
- I found no RAUC or SWUpdate integration for the UNO Q, and no OSTree build explicitly targeting `uno-q`.
- I found no measured RAM footprint for a minimal Yocto or Buildroot UNO Q image, and no 2 GB-specific measurement of the stock image.
- I didn't verify cross-compile specifics: the exact defconfig options in `uno-q.cfg`/`arduino.cfg`, or toolchain versions.
- I found no published PREEMPT_RT latency figures (cyclictest) for the QRB2210.
