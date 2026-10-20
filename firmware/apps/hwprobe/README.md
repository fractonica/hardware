# hwprobe

A standalone ESP-IDF app (no framework dependency) that identifies a board and measures its link to the hub host. It prints one JSON object per line, prefixed with `PROBE `, and shows progress on the OLED if one is found.

It runs these steps in order:

1. **Identity:** chip, revision, factory MAC, flash size, IDF version.
2. **I2C scan:** a full scan on the configured pins (default SDA 5 / SCL 6). If nothing answers there, it sweeps the safe pins for 0x3C/0x3D. Pins 8, 9, 11–19 are never touched.
3. **OLED:** SSD1306B 72×40 init and a test frame (border + corner marks) for 3 s.
4. **LED:** toggles the LED pin LOW/HIGH three times while the OLED shows the current level, so you can see which level lights it.
5. **Wi-Fi:** scan, connect, report channel, BSSID, RSSI and connect time. Sets `WIFI_PS_NONE`.
6. **mDNS:** resolves `<hub host>.local`.
7. **Round trips:** TCP and UDP, 200 × 16 B each, to `tools/hwprobe/echo_server.py`.
8. **Live loop:** BOOT button events (the LED follows the button), RSSI, and a `summary` line every 10 s.

## Build and flash

Wi-Fi credentials come from a git-ignored defaults file, never from the repo:

```bash
cat > /tmp/hwprobe-secrets.defaults <<'EOF'
CONFIG_HWPROBE_WIFI_SSID="<ssid>"
CONFIG_HWPROBE_WIFI_PASS="<password>"
CONFIG_HWPROBE_HUB_HOST="<LocalHostName>"
EOF
```

```bash
idf.py -C firmware/apps/hwprobe -B /tmp/hwprobe-build -DIDF_TARGET=esp32c3 -DSDKCONFIG_DEFAULTS="sdkconfig.defaults;/tmp/hwprobe-secrets.defaults" build
```

On the Mac, start the echo server:

```bash
python3 tools/hwprobe/echo_server.py 7421
```

Results from the first run are in [docs/spikes/2026-10-20-hwprobe-c3-oled.md](../../../docs/spikes/2026-10-20-hwprobe-c3-oled.md).
