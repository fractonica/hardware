# raphael: minimal Linux for the Raspberry Pi 3 Model B

A small headless Buildroot system for the Raspberry Pi 3 Model B: SSH, Wi-Fi, Ethernet, and the GPIO, I2C and
SPI tools. Nothing else runs. A purpose gets added on top later.

It builds in the same Docker image and volume as [`hosts/uno-q`](../uno-q/README.md) (one Buildroot tree,
download cache and compiler cache), into its own output directory.

| Part | Choice |
|---|---|
| Board | Raspberry Pi 3 Model B (tested on v1.2): BCM2837, 4x Cortex-A53 at 1.2 GHz, 1 GB RAM, 2.4 GHz Wi-Fi (BCM43438), 100 Mbit Ethernet. The B+ device tree and firmware are in too, untested |
| Build | Buildroot 2026.08.1, 64-bit (aarch64), glibc toolchain built by Buildroot. The kernel is not compiled |
| Boot | GPU boot ROM → `bootcode.bin` → cut-down GPU firmware (`start_cd.elf`, 16 MB of GPU memory) → `kernel8.img`, all from the SD card's FAT partition. No U-Boot, no initramfs. About 25 s from power to SSH |
| Kernel | Raspberry Pi's own 64-bit build, `6.12.61-v8+`, with its device trees and modules (29 MB), taken from the firmware release Buildroot pins ([`package/rpi-kernel-bin`](br2-external/package/rpi-kernel-bin/rpi-kernel-bin.mk)). Modules load only for hardware that is present |
| Init | systemd with networkd, resolved (mDNS: `raphael.local`), timesyncd and the hardware watchdog (15 s) |
| Network | Ethernet (DHCP, preferred) and Wi-Fi through iwd, power save off |
| Access | OpenSSH (key-only), serial console on GPIO 14/15, login on the HDMI console |
| Peripherals | I2C1 and SPI0 on, Bluetooth off (it would take the UART), analog audio off. `gpiodetect`/`gpioget`/`gpioset`, `i2cdetect`, `spi-config`/`spi-pipe` |
| Storage | ext4 root, grown to fill the SD card on first boot; `/boot` mounted on demand |
| Footprint | 956 MB of RAM for Linux, about 55 MB of it in use after boot; 95 MB on disk |

## Use

```bash
make build                 # out/sdcard.img
diskutil list                # the card: "Built In SDXC Reader" (listed as internal) or a USB reader
make flash DISK=disk24     # the SD card's disk; refuses anything that is not removable, asks before writing, needs sudo
make ssh                   # root@raphael.local
```

`make build` first runs `scripts/setup-local.sh`, which creates `local/` (never committed):

- `authorized_keys`: your SSH public key, for root.
- A stable SSH host key, so reflashing doesn't change the Pi's identity.
- `timezone`: this computer's time zone.
- An `ssh_config` that pins the host key.

Wi-Fi networks are files in `local/wifi/`, in iwd's format. Add one with `make wifi`, which asks for the password
itself. The first image uses the network saved for the UNO Q. The Pi's radio is 2.4 GHz only.

## Notes

- **Disk.** The Pi's build output takes about 10 GB in the `qonu-build` Docker volume, on top of the UNO Q's.
  Docker Desktop's disk limit (Settings → Resources) has to leave room for both.
- **Boot report.** About a minute after each boot (two at most, if the network never comes up), the Pi writes
  `raphael-boot.txt` to the SD card's boot partition: failed services, addresses, Wi-Fi state and this boot's
  warnings. When the Pi can't be reached, put the card in a computer and read it. If the file is missing, the
  kernel never got as far as starting systemd.
- **Root password.** It is empty, as on the UNO Q, so the serial and HDMI consoles log straight in. SSH accepts
  keys only. Set a password before the Pi goes anywhere else.
- **Time.** The Pi has no clock that keeps time without power. It starts at the image's build date, timesyncd
  restores the last time it saved, and NTP corrects it. DNSSEC is off, because a wrong clock would fail every
  signature and keep NTP from ever fixing it.
- **Consoles.** HDMI shows the kernel's messages and systemd's, and a login. The serial console runs on the
  full UART (`ttyAMA0`): header pins 8 (TX), 10 (RX) and 6 (GND), 3.3 V levels, 115200 baud, kernel messages
  and a login. `make console` opens it through a USB-UART adapter.
- **Camera, video, 3D.** They need the standard or extended GPU firmware (`start.elf`, `start_x.elf`) and more
  `gpu_mem` in `config.txt`; the kernel and its modules already support them.
- **Why not our own kernel.** Buildroot's build of the same 6.12.61 source (GCC 15, `bcm2711_defconfig` with
  sound, video, DRM and Bluetooth turned off) never started on the Pi 3 B v1.2: no HDMI output, no USB, while
  Raspberry Pi's build boots the same card. Which of the two differences causes it, the compiler or the config,
  is not known yet. A custom kernel would have to find out first.
