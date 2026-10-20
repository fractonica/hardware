# 06 — Identity, provisioning, flash layout, OTA

## 6.1 Decisions at a glance

| # | Decision |
|---|---|
| I1 | `device_id` = factory MAC, read with `esp_read_mac(…, ESP_MAC_EFUSE_FACTORY)`. It equals the ESP-NOW source MAC and the USB serial number. The hub assigns `addr` (u16), `alias` and `net`. |
| I2 | Identity and network settings live in a **read-only NVS partition `fr_ident`**, written by the hub at flash time in the same `write_flash` as the firmware. It survives OTA and app reflashes. The hub registry is the source of truth and can restore it. |
| I3 | Flash layout: **two equal OTA slots, no factory app**, rollback enabled, frozen from the first serial flash. There is one CSV per flash size. |
| I4 | OTA = **HTTP pull** from the hub's node-facing HTTP port (7422) into one `ota_sink` built on `esp_ota_ops`. The node pulls after an OFFER that pins the image digest. ESP-NOW relay OTA is M2+; delta OTA comes after that. |
| I5 | A new image boots `PENDING_VERIFY`. A **firmware-armed health deadline** (60 s) either marks it valid or calls `esp_ota_mark_app_invalid_rollback_and_reboot()`. Any reset before it is validated rolls back. |
| I6 | Lab security level **L0**: plain HTTP on the LAN with digest pinning. Secure boot and flash encryption are never used on lab devices (they burn eFuses irreversibly). **L1** (opt-in): signed apps without secure boot. |
| I7 | The hub flashes through **esptool 5.6's Python API** in a pinned uv venv (`pytools`), one process per job. Never PATH esptool, never `idf.py flash`. |

## 6.2 Flash layout v1

The bootloader is at `0x0` and the partition table at `0x8000` on all three chips. All three CSVs validate with `gen_esp32part.py` (checked with v5.5.1; v6.1 applies the same rules).

`firmware/partitions/fr-4mb-v1.csv` (C3/C6 Super Mini, S3FH4R2 boards) is **frozen once the first device is provisioned**:
```csv
# Name,   Type, SubType,  Offset,   Size,     Flags
nvs,      data, nvs,      0x9000,   0x5000,
otadata,  data, ota,      0xE000,   0x2000,
ota_0,    app,  ota_0,    0x10000,  0x1E0000,
ota_1,    app,  ota_1,    0x1F0000, 0x1E0000,
storage,  data, littlefs, 0x3D0000, 0x1C000,
coredump, data, coredump, 0x3EC000, 0x10000,
fr_ident, data, nvs,      0x3FC000, 0x4000,   readonly
```

`fr-8mb-v1.csv` (S3 N8R8) is frozen when the first 8 MB board is provisioned:
```csv
# Name,   Type, SubType,  Offset,   Size,     Flags
nvs,      data, nvs,      0x9000,   0x5000,
otadata,  data, ota,      0xE000,   0x2000,
ota_0,    app,  ota_0,    0x10000,  0x300000,
ota_1,    app,  ota_1,    0x310000, 0x300000,
storage,  data, littlefs, 0x610000, 0x1DC000,
coredump, data, coredump, 0x7EC000, 0x10000,
fr_ident, data, nvs,      0x7FC000, 0x4000,   readonly
```

`fr-16mb-v1.csv` (S3 N16R8; also used for 32 MB parts) is frozen when the first such board is provisioned:
```csv
# Name,   Type, SubType,  Offset,   Size,     Flags
nvs,      data, nvs,      0x9000,   0x5000,
otadata,  data, ota,      0xE000,   0x2000,
ota_0,    app,  ota_0,    0x10000,  0x400000,
ota_1,    app,  ota_1,    0x410000, 0x400000,
relay,    data, undefined,0x810000, 0x200000,
storage,  data, littlefs, 0xA10000, 0x5DC000,
coredump, data, coredump, 0xFEC000, 0x10000,
fr_ident, data, nvs,      0xFFC000, 0x4000,   readonly
```

| `part_profile` | Max app per slot | Notes |
|---|---|---|
| `fr-4mb-v1` | 1,920 KB | CI warns at 80% of the slot and fails at 95% |
| `fr-8mb-v1` | 3 MB | |
| `fr-16mb-v1` | 4 MB | `relay` stages images for ESP-NOW relay OTA when this board is the gateway (M2+) |

Rules:
- **CSV syntax.** Comments go on lines of their own; `gen_esp32part` rejects trailing comments.
- **`fr_ident`** is always the last 16 KB and is found **by label**. A 0x4000 read-only NVS partition is legal.
- **Frozen means frozen.** CI fails if a frozen CSV changes. A layout change means a new `vN` profile plus a serial migration job. IDF can OTA the bootloader and partition table on these chips, but with a brick window, so we do not.
- **Spelling.** The id `fr-4mb-v1` is used everywhere. The field is named `part_profile` in the manifests, `fr_app_desc` and the `fr_ident` NVS key (12 characters, within the 15-character limit).
- **littlefs.** `littlefs` partitions need the `joltwallet/littlefs` component when used.

## 6.3 Identity

| Field | Definition | Stored |
|---|---|---|
| `device_id` | 12 lowercase hex of the factory MAC | derived (eFuse); also in `fr_ident` to detect a moved image |
| `short_id` | last 3 bytes; display only (`pad-16ba34`) | derived |
| `addr` | u16 network address | `fr_ident` |
| `alias` + `alias_rev` | RFC 1123 label + revision | `fr_ident`; a runtime rename goes to RW `nvs:fr_ovr`. The **highest `alias_rev` wins** |
| `net` | u16 network id | `fr_ident` |
| `epoch_floor` | u16, written at every provision (`registry.last_epoch + 1`) | `fr_ident`; boot epoch = `max(nvs epoch, epoch_floor) + 1` |
| `board`, `profile`, `part_profile` | strings | `fr_ident`; the OTA compatibility gate |
| `fw_id` | SHA-256 appended to an unsigned image (its last 32 B) | image; `esp_partition_get_sha256()` |

On-device rules:
- `fr_id_get_mac()` wraps `esp_read_mac(mac, ESP_MAC_EFUSE_FACTORY)`. Never call `esp_efuse_mac_get_default()`: on the C6 it writes 8 bytes (an EUI-64).
- `esp_base_mac_addr_set()` and custom MACs are banned by lint. At boot, assert that the STA MAC equals `device_id`.

**Renames.**
1. `device_update {alias}` updates the registry (`alias_rev += 1`).
2. If the node is online, the hub sends `fr.node.set_alias {alias, rev}`, which the node stores in `fr_ovr`.
3. On every HELLO the hub compares alias and rev and re-sends if they differ. The registry wins.
4. Bindings that name the alias are re-resolved, and SDK clients get `registry.drift`.

**`fr_ident` content** (schema 1; key names ≤ 15 characters):

```csv
key,type,encoding,value
fr_id,namespace,,
schema,data,u8,1
mac,data,hex2bin,1cdbd416ba34
addr,data,u16,7
net,data,u16,41235
alias,data,string,pad-red-1
alias_rev,data,u32,1
epoch_floor,data,u16,1
board,data,string,esp32c6-supermini
profile,data,string,c6-pad
part_profile,data,string,fr-4mb-v1
prov_ts,data,u32,1792512000
fr_net,namespace,,
ssid,data,string,LabNet
pass,data,string,<wifi password>
bssid,data,hex2bin,<6 bytes, optional>
country,data,string,LV
hub_host,data,string,dimas-3.local
hub_ip,data,string,192.168.0.17
```

- **Generation.** The image is built with `esp-idf-nvs-partition-gen` (`generate fr_ident.csv fr_ident.bin 0x4000`) and round-trip checked with `nvs_tool`.
- **Secrets handling.** The CSV is rendered in a 0700 temp directory from the **active network record** plus its secret, and deleted when the job ends. It never appears in logs, `dry_run` output or job results.
- **Where the network record comes from.** `network_set` ([09 §9.4](09-agent-api.md)). The Wi-Fi password lives in `~/.fractonica/secrets.json` (mode 0600) and is never in SQLite.
- **RW namespaces in `nvs`:**
  - `fr_ovr`: alias + rev, groups (M2), and `addr`/`net` written by adoption (M2);
  - `fr_link`: the last channel C and the pinned BSSID ([05 §5.4](05-network.md));
  - `fr_bind`: bindings, ≤ 16 ([07 §7.11](07-capabilities-sdk.md));
  - `fr_dir`: directory cache;
  - `fr_net2`: pushed Wi-Fi override, reverted after 60 s on failure;
  - `fr_ota`: job id, target `fw_id`, size, resume offset, `hub_seen`;
  - `fr_boot`: epoch;
  - M3 keys also go in an RW namespace, because `fr_ident` is read-only at runtime.

## 6.4 Provisioning flow (first flash)

`fr devices provision --port <usb-serial> [--profile c6-pad] [--alias pad-red-1]`, the dashboard wizard, or MCP `device_provision`:

1. **Discover.** USB VID 0x303A / PID 0x1001 gives the MAC from the serial number without opening the port ([04 §4.5](04-boards.md)).
2. **Acquire.** Take an exclusive port lease. If a foreign process holds the port, fail with `PORT_BUSY_EXTERNAL` and name it (e.g. "Google Chrome, PID 715: close the Web Serial tab").
3. **Probe.** Using the esptool API ([§6.10](#610-esptool-integration-hub-pytools)), read chip, revision, features (embedded flash and PSRAM), flash size, MAC and security info. Refuse if secure boot or flash encryption is enabled.
4. **Registry.** Upsert by `device_id`:
   - reuse `addr` and `alias` if known, otherwise allocate the next `addr` and an alias (`{profile}-{short_id}`, or the requested one);
   - set `epoch_floor = last_epoch + 1`;
   - enforce uniqueness.
5. **Select.**
   - Choose the profile: requested, then registry, then board detection.
   - Choose the artifact:
     - `--build B` if given, else the newest `debug` artifact for `(node, profile)`.
     - If the profile came from board detection, use the newest artifact whose `board` matches, and ask if artifacts exist for more than one profile.
     - If there is none, fail with `NOT_FOUND`, remediation `fr build --profile <P>`. The hub never builds implicitly.
   - Check artifact compatibility: target, chip revision range, flash size → `part_profile`. Also check that the board manifest's PSRAM mode and voltage match what the probe reported.
   - Check that a network record exists; if not, fail with `ENV_MISSING` and hint `fr net set`.
6. **Render** `fr_ident.bin` (§6.3).
7. **Flash.** One `write_flash`: `0x0` bootloader, `0x8000` partition table, `0xE000` ota_data_initial, `0x10000` app, `fr_ident` at its offset. A full erase is done only when explicitly asked.
8. **Boot.**
   - The pytools child resets the chip with `--after hard-reset` and exits.
   - The hub reopens the port at once (DTR and RTS deasserted), re-resolving it by serial number, and waits for the `@fr1` HELLO on serial (≤ 10 s).
   - The node repeats HELLO on the serial link every 1 s until it receives a WELCOME there.
9. **Join.** The node joins Wi-Fi, connects to the hub over TCP and sends HELLO. The hub replies WELCOME and marks it `online + provisioned` (`device.provisioned`). The hub ends the provisioning lease; its monitor stays attached.

**Flash plans**

| Plan | Writes | Use |
|---|---|---|
| `full` | bootloader, partition table, otadata, app, fr_ident | first provision; profile or layout change |
| `app` | `0xE000` ota_data_initial + `0x10000` app (`--diff-with` the previous image when available) | serial dev loop. **Must include otadata**, or a device that last booted `ota_1` keeps running the old image |
| `identity` | `fr_ident` only | rename, new Wi-Fi, new hub host, without touching firmware |
| `recover` | `full` + identity restored from the registry | after `erase-flash` or third-party flashing |

**Adopting foreign devices.** A node flashed by plain `idf.py flash` has no `fr_ident`.
- It boots as `UNASSIGNED` (`0xFFFE`, HELLO `caps.b5 provisioned = 0`).
- It uses Kconfig dev-fallback Wi-Fi credentials if present.
- The hub lists it as *pending adoption*. In M1 the only way to adopt it is to reprovision it over USB (`fr devices provision`, plan `full`). Adoption over the link (`device_adopt`, trust on first use, lab only), which writes `addr`, `net` and the alias into `fr_ovr`, is M2.

## 6.5 OTA transports

| Transport | When | Estimated time for 1 MB |
|---|---|---|
| Serial (esptool, compressed) | USB-attached nodes, the gateway, recovery | ~5–15 s (to be measured) |
| **Wi-Fi HTTP pull** from `http://<hub_host>:7422/ota/<fw_id>.bin` (Range supported) | default for networked nodes | ~5–15 s; flash erase/write dominates |
| ESP-NOW relay via the gateway (M2+) | ESP-NOW-only nodes | ~45–90 s at 1 Mbps; faster at ≥ 6 Mbps |
| Delta OTA (`esp_delta_ota`, M3+) | ESP-NOW nodes, small changes | depends on patch size |

The node-facing HTTP port (7422) serves only `fw_id`s that have an outstanding OFFER to the requesting node ([08 §8.10](08-hub.md)).

## 6.6 Node side: `ota_sink` and state machine

```c
typedef struct {
    char     job_id[24];
    uint8_t  fw_id[32];        // appended image SHA-256, pinned by the OFFER
    uint32_t size;
    char     version[32];
    uint32_t flags;            // FR_OTA_FORCE | FR_OTA_DEFER_COMMIT | FR_OTA_ALLOW_DOWNGRADE
} fr_ota_offer_t;              // decoded from OTA/OFFER (05 §5.7)

esp_err_t fr_ota_begin(const fr_ota_offer_t *o);              // CHECK, then esp_ota_begin(next, OTA_WITH_SEQUENTIAL_WRITES)
esp_err_t fr_ota_write(const void *d, size_t n);               // sequential esp_ota_write ONLY (never mixed with _with_offset)
esp_err_t fr_ota_finish(void);                                 // esp_ota_end; esp_partition_get_sha256(next) == fw_id
esp_err_t fr_ota_commit(bool reboot);                          // esp_ota_set_boot_partition(next) [+ BYE{ota}, esp_restart()]
void      fr_ota_on_boot(void);                                // PENDING_VERIFY handling, health deadline, rollback report
void      fr_health_set(uint32_t bit);                         // CORE | CAPS | NET | HUB_ACK
```

The download runs on `fr_worker`, never `fr_core`.

**CHECK** runs on the first bytes, before any flash write:
- The device is not itself `PENDING_VERIFY`; IDF rejects a new OTA then.
- The image `chip_id` matches, and the chip revision is within min/max.
- `fr_app_desc` `board`, `profile` and `part_profile` match `fr_ident` (unless FORCE).
- `size` fits the slot.
- `fw_id` differs from both the running image and the last invalid one (unless FORCE).
- The version is not lower (unless ALLOW_DOWNGRADE).

**Erase pacing.** `OTA_WITH_SEQUENTIAL_WRITES` erases one sector at a time, instead of pre-erasing 2 MB, which would stall the radio for seconds. While downloading, the node advertises `ota_busy` and stops relaying floods.

```
IDLE ─OFFER→ CHECK ─fail→ REJECT(code)
CHECK ─ok→ DOWNLOAD ─err→ FAILED(code)
DOWNLOAD ─done→ VERIFY (digest == fw_id) ─fail→ FAILED
VERIFY ─ok→ STAGED ─(DEFER_COMMIT: wait COMMIT)→ REBOOT: set boot partition, BYE{ota}, esp_restart()
BOOT (bootloader: NEW → PENDING_VERIFY) → SELFTEST: arm esp_timer health deadline (60 s)
    all required bits set → esp_ota_mark_app_valid_cancel_rollback() → CONFIRMED → report success
    deadline expires      → esp_ota_mark_app_invalid_rollback_and_reboot()
    panic / WDT / any reset before valid → bootloader marks ABORTED → previous image boots
ROLLED BACK (old image): esp_ota_get_last_invalid_partition() != NULL → report rolled_back {fw_id, reason}
```

**Download retries and resume**
- **Within one boot,** a failed GET keeps the open handle and re-issues `Range: bytes=<written>-`.
- **After a reboot,** resume works like this:
  - The node persists `fr_ota.off` (rounded down to 4 KB, written every 64 KB by `fr_worker`) together with `fw_id` and `size`.
  - On a new OFFER with the same `fw_id`, and if the running app is not `PENDING_VERIFY`, it calls `esp_ota_resume(next, OTA_WITH_SEQUENTIAL_WRITES, off, &h)` and continues with `Range: bytes=off-`. The 4 KB-aligned offset makes `esp_ota_write()` re-erase that sector.
  - `esp_ota_resume()` skips the checks `esp_ota_begin()` performs, so CHECK runs again on the descriptor read back from flash.
  - `fr_ota.off` is cleared after `esp_ota_end()`.

**Required health bits**
- `CORE`: boot complete.
- `CAPS`: every bound capability initialised.
- `NET`: Wi-Fi up.
- `HUB_ACK`: WELCOME received. Required only if `fr_ota.hub_seen` shows the hub was reachable before the update; otherwise a hub outage would roll back every node.

**Hub duty during VERIFYING:** never reset the device. That means no esptool probe and no DTR/RTS on port open.

**Crash reports.** After any crash, if `esp_core_dump_image_check()` passes, the node POSTs the ELF core dump to `http://<hub_host>:7422/node/v1/coredump/<device_id>` once its TCP link has been WELCOMEd. It has to wait, because port 7422 accepts only IPs bound to a live 7421 link ([08 §8.10](08-hub.md)). The node erases the dump after a 2xx response. The hub decodes it against the stored ELF of that `fw_id`.

## 6.7 Hub side: OTA job and rollout

**Per-device job:**

`QUEUED → OFFERED (ACCEPT ≤ 10 s) → DOWNLOADING (progress ≥ every 5% or 1 s) → STAGED → REBOOTING (back online ≤ 60 s) → VERIFYING (new fw_id + pending; confirmed ≤ 70 s) → SUCCEEDED`

Terminal failures:
- `FAILED(code)`: retried up to 3 times with 5/15/45 s backoff.
- `ROLLED_BACK`: the device returns with its old `fw_id`, and its last invalid image is the target.
- `TIMED_OUT`: flagged `needs_serial_recovery`.
- `CANCELLED`.

Every transition is persisted and emitted as `ota.job.state`.

**Fleet deploy.**
- M1: a selector plus `max_parallel` (default 4) and `on_failure: halt|continue`.
- M3: canary and waves with soak time, a failure ratio, and an atomic commit across devices (`DEFER_COMMIT`, then a broadcast COMMIT) for breaking protocol changes.

**Transport `auto`:** serial if the device is attached and idle, otherwise Wi-Fi, otherwise ESP-NOW relay (M2+). A USB gateway is flashed over serial, always last.

## 6.8 Artifacts

```
~/.fractonica/artifacts/
  blobs/sha256/<aa>/<sha256>                                       # bin, elf, map, bootloader, ptable
  builds/<app>/<profile>/<build_type>/<fw_id[0:12]>/manifest.json   # build_id = "<app>/<profile>/<build_type>/<fw_id[0:12]>"
```

```json
{
  "schema": "fractonica.artifact/1",
  "build_id": "node/c6-pad/debug/9f2c1e07ab12",
  "app": "node", "profile": "c6-pad", "build_type": "debug", "board": "esp32c6-supermini",
  "target": "esp32c6", "chip_id": 13, "min_chip_rev": 0, "max_chip_rev": 99,
  "part_profile": "fr-4mb-v1", "proto": "1.0", "catalog_hash": "9c1e44a0",
  "version": "0.1.0+g1a2b3c4.dirty.9f2c1e07",
  "source_dir": "/Users/dimas/projects/fractonica-hardware", "git": { "sha": "…", "dirty": true },
  "idf": { "tag": "v6.1", "commit": "…" },
  "fw_id": "9f2c1e07ab12…", "elf_sha256": "…", "size": 912384,
  "flash": { "mode": "dio", "freq": "80m", "size": "4MB",
             "files": [ { "offset": "0x0", "blob": "sha256:…", "role": "bootloader" },
                        { "offset": "0x8000", "blob": "sha256:…", "role": "partition_table" },
                        { "offset": "0xe000", "blob": "sha256:…", "role": "ota_data_initial" },
                        { "offset": "0x10000", "blob": "sha256:…", "role": "app" } ] },
  "caps": [ { "port": 1, "name": "boot", "cap": "fr.button", "v": "1.0" },
            { "port": 2, "name": "status", "cap": "fr.led", "v": "1.0" } ]
}
```

- **Version label.** `version` is a display label. A dirty tree gets `.dirty.<fw_id[0:8]>`.
- **Flash offsets** come from `flasher_args.json`. Any esptool v4 spellings (`default_reset`) are normalised to v5 (`default-reset`).
- **Header parsing.** The hub parses image headers itself: `0xE9` magic; `chip_id` at offset 12; min/max chip revision at 15 and 17; `esp_app_desc_t` at 32; the custom `fr_app_desc_t` at **288** (24 + 8 + 256); the appended hash in the last 32 bytes for unsigned images.
- **`fr_app_desc` definition rules.** It is defined once, in C (or `extern "C"`), as `const __attribute__((used, section(".rodata_custom_desc"))) fr_app_desc_t fr_app_desc = {…};`, with a leading magic word, `_Static_assert` on its size, and `target_link_libraries(${COMPONENT_LIB} INTERFACE "-u fr_app_desc")`. A namespace-scope C++ `const` has internal linkage and would be dropped. CI checks the magic at offset 288 and exactly one symbol in `.rodata_custom_desc`.

## 6.9 Security levels

| Level | What | Default |
|---|---|---|
| L0 | HTTP on the LAN, with `fw_id` pinned in the OFFER (which arrives over the hub's TCP link). No TLS | **PoC** |
| L1 | Signed apps without secure boot (`CONFIG_SECURE_SIGNED_APPS_NO_SECURE_BOOT` + `CONFIG_SECURE_SIGNED_ON_UPDATE_NO_SECURE_BOOT`). The running app verifies new images; no eFuses are burned. Its trust anchor is the running app's signature block, so the first signed image must be installed over L0 or serial, and after that the device refuses unsigned OTA, including a return to L0. For L1 images, `fw_id` comes from the image (a segment walk to `image_len − 32`), not from the file's last 32 bytes, and the slot check uses `ALIGN_UP(image_len, 4 KB) + 4 KB`. Combine with M3 envelope security for an authenticated OFFER | opt-in |
| L2 | Secure boot v2 + flash encryption | **never on lab devices** |

## 6.10 esptool integration (hub `pytools`)

- **Environment.** `tools/pytools` is a uv project: Python 3.12, `esptool==5.6.0` (stub v1.4.1; fallback pin 5.5.0, qualified in S1), `esp-idf-nvs-partition-gen` and `esp-idf-panic-decoder`.
- **Process model.** The hub spawns `~/.fractonica/pytools/bin/python -I -m pytools`, one process per job, speaking JSON lines over stdio. esptool's logger is global, and a process per job also gives clean cancellation.
- **API.**
  - `esptool.cmds`: `detect_chip` / `connect_esp`, `detect_flash_size` (returns a string), `write_flash` (multiple offset/file pairs, compressed, verify), `erase_region`, `reset_chip`.
  - `ESPLoader` methods: `esp.get_chip_description()`, `esp.get_chip_features()`, `esp.read_mac('BASE_MAC')`, `esp.get_security_info()` (a dict).
  - The `cmds` functions `read_mac`, `get_security_info` and `flash_id` **only log**, so they are not used.
  - All calls live in one adapter module with per-chip contract tests. A custom logger turns progress into JSON events.
- **Reset modes:**
  - `--before default-reset` (auto USJ reset), `--after hard-reset`.
  - `device_reset {mode: bootloader}` = connect with `default-reset`, then `reset_chip(esp, 'no-reset')`.
  - A stuck download-mode node is recovered with `watchdog-reset` on C3/S3, or RST on C6.
- **Fallback:** the pinned esptool CLI with `NO_COLOR=1`, parsing only exit codes and coarse progress.
