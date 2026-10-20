# Spike result — hwprobe on ESP32-C3 0.42" OLED board (2026-10-20)

**Covers:** parts of S0 (IDF v6.1 builds and flashes), S1 (USB-Serial/JTAG on macOS), S2 (Wi-Fi link), S4 (latency baseline) and S5 (macOS Local Network Privacy).

**Probe:** [`firmware/apps/hwprobe`](../../firmware/apps/hwprobe) with [`tools/hwprobe/echo_server.py`](../../tools/hwprobe/echo_server.py) running on the Mac.

**Device:** `1c:db:d4:16:ba:34`. Its original firmware (your PlatformIO/Arduino tiny-OLED sketch) was backed up before flashing; the backup is not in the repo.

## Board facts (measured)

| Fact | Value | How |
|---|---|---|
| Chip | ESP32-C3 (QFN32), revision v0.4, single core | esptool `flash-id`, `esp_chip_info` |
| Flash | 4 MB embedded, XMC (manufacturer 0x46, device 0x4016) | esptool `flash-id`; `esp_flash_get_physical_size` = 4194304 |
| Security | Secure boot off, flash encryption off | esptool `get-security-info` |
| USB | Native USB-Serial/JTAG, 303A:1001, bcdDevice 0x0101, serial = MAC | ioreg |
| OLED | I2C **SDA GPIO5, SCL GPIO6**, address **0x3C**. The SSD1306B init (72×40 window at column 28, multiplex 0x27, internal IREF 0xAD 0x30) works: the test frame and text render correctly framed | full 0x08–0x77 scan on 5/6 found only 0x3C; confirmed by eye |
| BOOT button | GPIO9, idle level 1 (pull-up) | `gpio_get_level` |
| LED | GPIO8, **active-low**: the blue LED is on while the pin is LOW | toggled by the probe with the level shown on the OLED; confirmed by eye |
| Wi-Fi radio | b/g/n with `TENRETNI` | `esp_wifi_sta_get_ap_info` |

## Link facts (measured)

| Fact | Value |
|---|---|
| Router | `TENRETNI`, **channel 1**, BSSID `74:9d:79:03:69:6e`, WPA2 (auth 4), no 11ax. 2 APs visible in total |
| Node RSSI at the desk | −67 to −69 dBm |
| Association + DHCP | 3.2 s |
| mDNS `dimas-3.local` → Mac | OK in 238 ms. The Mac's DHCP address had changed from .17 to .29 since the morning inventory, which validates resolving the hub by mDNS name |
| TCP round trip node ↔ Mac (Mac on Wi-Fi), 200 × 16 B, `TCP_NODELAY`, node `WIFI_PS_NONE` | p50 **8.7 ms**, p99 **100 ms**, max 118 ms; connect 8 ms |
| UDP round trip, 200 × 16 B | p50 **9.8 ms**, p99 **104 ms**, max 115 ms, **0 lost** |
| Mac → node UDP send from a process launched by Claude | 200/200 sent, 0 errors. Local Network Privacy did not block it in this setup |
| esptool over USB-Serial/JTAG | read 4 MB in 14.4 s (2.3 Mbit/s); write 892 KB app in 3.3 s (2.2 Mbit/s compressed) |
| Build | IDF v6.1, clean build OK with no warnings; app 892 KB (46% of the 1,920 KB `fr-4mb-v1` slot) |

## What it means

- **Router mode works**, but with the Mac on Wi-Fi the **tail latency fails the go/no-go**: p99 is about 100 ms against the ≤ 30 ms target. The median (~9 ms round trip, so ~4–5 ms one way) is fine.
  - A tail of about 100 ms matches one beacon interval (102.4 ms). That points to frames being buffered for a dozing station, most likely the Mac's Wi-Fi power save or AWDL, because the node runs `WIFI_PS_NONE`.
- **Next measurements**, before choosing (a) a wired hub on the dedicated router or (b) a USB gateway:
  1. Repeat with 2,000 samples and per-sample timestamps, to see whether the tail is periodic (~102 ms) or bursty (AWDL).
  2. Repeat with AWDL disabled (`sudo ifconfig awdl0 down`; it comes back on reboot) and with the Mac on the dedicated router.
  3. Measure the one-way node → hub path (the input path) separately from the round trip, using the TIME-synced timestamps from 05 §5.12.4.
- **Resolved spec questions:**
  - The router channel is 1.
  - `dimas-3.local` resolves from the node.
  - macOS did not block hub → node UDP in this setup.
  - The 0.42" OLED board facts match the research.
