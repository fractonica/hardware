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

`local/` is git-ignored. It holds your SSH public key, the board's SSH host key, Wi-Fi credentials, Arduino's per-PCB Wi-Fi calibration file and the downloaded EDL programmer. None of these are redistributable or belong in git.

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
br2-external/                 Buildroot external tree (BR2_EXTERNAL_QONU)
  configs/qonu_uno_q_defconfig
  board/uno-q/
    kernel-modules.txt        modules kept by localmodconfig
    linux-fragment.config     qonu kernel options
    linux.config              generated kernel defconfig (commit it)
    partitions-emmc-16gb.env  efi/rootfs offsets for the 16 GB board
    genimage.cfg, post-build.sh, post-image.sh
    rootfs-overlay/           systemd units, network, ssh, iwd, watchdog
  package/                    qrtr, rmtfs, tqftpserv, qbootctl, uno-q-firmware
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

## Measured on the board (16 GB UNO Q)

| Metric | Value |
|---|---|
| Power-on to multi-user | ~15 s: 6 s Qualcomm firmware and U-Boot, 1.5 s systemd-boot, 0.6 s kernel, 7.3 s userspace |
| RAM in use at idle | ~105-110 MB (stock Debian: ~386 MB) |
| Root filesystem in use | 89 MB |
| Loaded modules | 66 |
| Wi-Fi joined after boot | 13-20 s |
