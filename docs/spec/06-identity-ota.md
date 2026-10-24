# 06 — Identity, provisioning, flash layout, OTA

## 6.1 Decisions at a glance

| # | Decision |
|---|---|
| I1 | `device_id` = factory MAC, read with `esp_read_mac(…, ESP_MAC_EFUSE_FACTORY)`. It equals the ESP-NOW source MAC and the USB serial number. The hub assigns `addr` (u16), `alias` and `net`. |
| I2 | Identity and network settings live in a **read-only NVS partition `fr_ident`**, written by the hub at flash time in the same `write_flash` as the firmware. It survives OTA and app reflashes. The hub registry is the source of truth and can restore it. |
| I3 | Flash layout: **two equal OTA slots, no factory app**, rollback enabled, frozen from the first serial flash. There is one CSV per flash size. |
| I4 | OTA = **HTTP pull** from the hub's node-facing HTTP port (7422) into `fr_ota`'s one sequential sink on `esp_ota_ops`, through `fr_ota`'s own HTTP/1.1 GET over lwIP sockets (no `esp_http_client`). The node pulls after an OFFER that pins the image digest. ESP-NOW relay OTA is M2+; delta OTA comes after that. |
| I5 | A new image boots `PENDING_VERIFY`. A **firmware-armed health deadline** (60 s) either marks it valid or calls `esp_ota_mark_app_invalid_rollback_and_reboot()`. Any reset before it is validated rolls back. |
| I6 | Lab security level **L0**: plain HTTP on the LAN with digest pinning. Secure boot and flash encryption are never used on lab devices (they burn eFuses irreversibly). **L1** (opt-in): signed apps without secure boot. |
| I7 | The hub flashes through **esptool 5.6's Python API** in a pinned uv venv (`pytools`), one process per job. Never PATH esptool, never `idf.py flash`. |

## 6.2 Flash layout v1

The bootloader is at `0x0` and the partition table at `0x8000` on all three chips. All three CSVs validate with `gen_esp32part.py` (checked with v5.5.1; v6.1 applies the same rules).

`firmware/partitions/fr-4mb-v1.csv` (C3/C6 Super Mini, S3FH4R2 boards; since M1 step 7 also the Waveshare ESP32-S3-LCD-1.9, which has 16 MB of flash and uses the first 4 MB, [04 §4.2](04-boards.md)) is **frozen once the first device is provisioned**:
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
| `addr` | u16 network address, allocated from `0x0001` at provisioning and never reused for another device (kv `registry.addr_hwm`, which a HELLO on this hub's net also raises) | `fr_ident` |
| `alias` + `alias_rev` | RFC 1123 label + revision. Default `<profile>-<short_id>` (`c6-pad-d55e64`) | `fr_ident`; a runtime rename goes to RW `nvs:fr_ovr`. The **highest `alias_rev` wins** |
| `net` | u16 network id: the network record's `net_id`, random in 1..65535, created with the record and kept by later changes | `fr_ident` |
| `epoch_floor` | u16, written at every provision (`registry.last_epoch + 1`) | `fr_ident`; boot epoch = `max(nvs epoch, epoch_floor) + 1` |
| `board`, `profile`, `part_profile` | strings | `fr_ident`; the OTA compatibility gate |
| `fw_id` | SHA-256 appended to an unsigned image (its last 32 B) | image; `esp_partition_get_sha256()` |

On-device rules:
- `fr_id_get_mac()` wraps `esp_read_mac(mac, ESP_MAC_EFUSE_FACTORY)`. Never call `esp_efuse_mac_get_default()`: on the C6 it writes 8 bytes (an EUI-64).
- `esp_base_mac_addr_set()` and custom MACs are banned by lint. At boot, assert that the STA MAC equals `device_id`.

**Alias rules.** At most 31 characters, stored lower case and unique ignoring case. Reserved: the instance names of [03 §3.6](03-firmware.md), `all`, `offline`, and anything shaped like a 12-hex device id (a selector reads those as ids, [09 §9.2](09-agent-api.md)).

**Renames.**
1. `device_update {alias}` updates the registry (`alias_rev += 1`).
2. If the node is online, the hub sends `fr.node.set_alias {alias, rev}`, which the node stores in `fr_ovr`.
3. On every HELLO the hub compares alias and rev and re-sends if they differ. The registry wins: its `alias_rev` moves past any rev a HELLO reports.
4. Bindings that name the alias are re-resolved (their text only: the bytes a node holds carry no alias, [07 §7.11](07-capabilities-sdk.md)), and SDK clients get `registry.drift`.

**Devices seen only through HELLO.** A device that says HELLO without a registry row (foreign firmware, a board flashed by port) gets a row with `provisioned: false` and `addr: null`, and is WELCOMEd. Its alias is its HELLO alias when valid and free, else `<chip>-<short_id>`. Provisioning replaces that made-up alias, and the firmware's UNASSIGNED placeholder `new-<short_id>` while its `alias_rev` is 0, never one a person chose.

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

- **Generation.** The pytools sidecar's `nvs_gen` builds the image with `esp-idf-nvs-partition-gen` (0x4000); no event or error it emits carries the CSV's content. A round-trip check with `nvs_tool` is planned. Every write gets a fresh `prov_ts`.
- **Secrets handling.** The CSV is rendered from the **active network record** plus its secret, in its own 0700 directory under `~/.fractonica/tmp/ident`. The CSV is deleted as soon as `nvs_gen` returns, the directory after the flash (or by an exit hook). A hub start, holding `hub.lock`, removes whatever a killed hub left there, and this user's `fr-ident-*` directories older than 10 min in the system temp directory, where older hubs rendered. The password never appears in SQLite, logs, job logs, `dry_run` output or results.
- **Where the network record comes from.** `network_set` ([09 §9.4](09-agent-api.md)). The Wi-Fi password lives in `~/.fractonica/secrets.json` (mode 0600) and is never in SQLite.
- **RW namespaces in `nvs`:**
  - `fr_ovr`: alias + rev, groups (M2), and `addr`/`net` written by adoption (M2);
  - `fr_link`: the last channel C, the pinned BSSID and `ssid_h`, the hash of the SSID they belong to ([05 §5.4](05-network.md)); a `net_set` trial's pin is written only once the trial is confirmed;
  - `fr_bind`: bindings, ≤ 16, whose encoded `BindingList` stays ≤ 1400 B ([07 §7.11](07-capabilities-sdk.md));
  - `fr_dir`: directory cache, ≤ 64 entries ([05 §5.10](05-network.md));
  - `fr_bind` and `fr_dir` (since C5) each hold one blob, key `table`: `ver=1 | count | entries`, decoded in place and written on `fr_worker` ([03 §3.4](03-firmware.md));
  - `fr_net2`: the Wi-Fi override `fr.node.net_set` pushes, with `base` (the `prov_ts` it was pushed under) and `ok`. It is applied 300 ms after the RESULT and reverted after 60 s if it fails to connect; once it joins it stays. A reprovision (a new `prov_ts`) drops it;
  - `fr_ota`: the OTA job record (§6.6): `job`, `fw` (the target `fw_id`), `size`, `off` (resume offset), `hub_seen`, `slot` (the address of the slot it downloads into) and `state` (0 download, 1 installed, 2 health_timeout);
  - `fr_boot`: epoch;
  - M3 keys also go in an RW namespace, because `fr_ident` is read-only at runtime.

## 6.4 Provisioning flow (first flash)

`fr devices provision --port <usb-serial> [--profile c6-pad] [--alias pad-red-1]`, the dashboard wizard, or MCP `device_provision`. It is one job of kind `provision`. Whatever can fail without touching the board (a missing network record, an unknown `--build` or `--profile`, a taken alias) fails before the job starts.

1. **Discover.** USB VID 0x303A / PID 0x1001 gives the MAC from the serial number without opening the port ([04 §4.5](04-boards.md)).
2. **Acquire.** Before the job starts, the port must be free: a lease fails it with `PORT_LEASED`, a foreign holder with `PORT_BUSY_EXTERNAL` naming it from `lsof` (`/dev/cu.usbmodem2101 (pad-c3b) is held by Google Chrome (pid 715)`, `details.holders`, a remediation per holder), and no job starts. The same check runs before `flash_start` and `device_reset` jobs ([09 §9.4](09-agent-api.md)). The job then takes the port exclusively; a pytools busy error inside it names the holder the same way. Checked on the bench at C6 (T-PORTS: Chrome holding the port by Web Serial).
3. **Probe.** Using the esptool API ([§6.10](#610-esptool-integration-hub-pytools)), read chip, revision, features (embedded flash and PSRAM), flash size, MAC and security info. Refuse (`INCOMPATIBLE_PROFILE`) if secure boot or flash encryption is enabled.
4. **Select** (before the registry, so a missing artifact costs no address).
   - Choose the profile: requested, then registry, then board detection (M1: the profiles with a `debug` node artifact built for the probed chip).
   - Choose the artifact:
     - `--build B` if given, else the newest `debug` artifact for `(node, profile)` (never a fault build, §6.8).
     - If the profile came from board detection: one candidate is used; several fail with `INVALID_ARGS` and the candidates (pick one with `--profile`).
     - If there is none, fail with `NOT_FOUND`, remediation `fr build --profile <P>`. The hub never builds implicitly.
   - Check artifact compatibility: the target must be the probed chip (`TARGET_MISMATCH`), and the flash must hold the artifact's flash size (`INCOMPATIBLE_PROFILE`). The chip-revision range and the board manifest's PSRAM mode and voltage are not checked yet ([11 §11.4](11-roadmap.md)). The one PSRAM board, the S3's `s3l-pad`, runs with SPIRAM off in M1 ([04 §4.2](04-boards.md)).
5. **Registry.** A network record is required (`ENV_MISSING`, hint `fr net set`). Upsert by `device_id`:
   - reuse `addr` and `alias` if known, otherwise allocate the next `addr` (never reused, §6.3) and an alias (`{profile}-{short_id}`, or the requested one). A HELLO-only row's made-up alias, and the firmware's `new-<short_id>` placeholder at `alias_rev` 0, give way to the default (§6.3);
   - set `net` from the network record and `epoch_floor = last_epoch + 1`;
   - enforce uniqueness.
6. **Render** `fr_ident.bin` (§6.3), with a fresh `prov_ts`.
7. **Flash.** One `write_flash`: `0x0` bootloader, `0x8000` partition table, `0xE000` ota_data_initial, `0x10000` app, `fr_ident` at its offset. A full erase is done only when explicitly asked. The rendered files are deleted, the row is marked provisioned with its provision record (never the password), and the hub publishes `device.provisioned`.
8. **Boot.**
   - The pytools child finishes with `--after no-reset` (the chip waits in the ROM loader) and exits.
   - The hub reopens the port at once (DTR and RTS deasserted), re-resolving it by serial number, then resets the chip itself by pulsing RTS on its own handle. A USJ chip reset does not re-enumerate ([04 §4.4](04-boards.md)), so the hub captures the ROM and bootloader lines and the boot banner. If esptool reset the chip instead, the banner would be printed while no host had the port open, and the USJ console drops output nobody reads (seen at checkpoint C1).
   - The hub waits for the HELLO on serial (≤ 10 s): the router's `device.online` or `device.link {up: true}` with `link: serial`, or the HELLO frame in the log store. None is `TIMEOUT` with `details.flashed: true` and the boot log tail.
   - The node repeats HELLO on the serial link every 1 s until it receives a WELCOME there.
9. **Join.** The node joins Wi-Fi, connects to the hub over TCP and sends HELLO. The hub waits up to 30 s for it (the same events with `link: tcp`: a node already online over USB gets `device.link`, not a second `device.online`). The result reports `wifi: joined | not_joined`; not joining is a warning, not a failure. The hub ends the provisioning lease; its monitor stays attached.

**Flash plans**

| Plan | Writes | Use |
|---|---|---|
| `full` | bootloader, partition table, otadata, app; `fr_ident` rendered from the registry for a provisioned device, erased for any other (it boots UNASSIGNED) | first provision; profile or layout change |
| `app` | `0xE000` ota_data_initial + `0x10000` app (`--diff-with` the previous image when available) | serial dev loop. **Must include otadata**, or a device that last booted `ota_1` keeps running the old image |
| `identity` | `fr_ident` only, at the offset of the device's artifact or its last provision record | rename, new Wi-Fi, new hub host, without touching firmware |
| `recover` | `full` + identity restored from the registry | after `erase-flash` or third-party flashing |

- `flash_start` names the board by `device` (a selector matching one device) or `port`, exactly one ([09 §9.4](09-agent-api.md)); `profile` defaults to the registry's. `identity` and `recover` need a provisioned device (`NOT_FOUND` otherwise).
- Whether `full` writes or erases `fr_ident` is decided again when the job holds the port and device locks, not when it is queued: a provisioning queued ahead of it may have registered the board meanwhile. The request-time decision serves only dry runs and early validation.
- Every plan that writes `fr_ident` renders it fresh (same `addr` and alias, `net` from the network record, `epoch_floor = last_epoch + 1`, a new `prov_ts`) and stores a provision record (`device_get` `provision`). Dry runs show the plan, the `ident` region and the `identity` (addr, alias, net, hub host), never the image.

**Adopting foreign devices.** A node flashed by plain `idf.py flash` has no `fr_ident`.
- It boots as `UNASSIGNED` (`0xFFFE`, HELLO `caps.b5 provisioned = 0`).
- It uses the Kconfig dev-fallback Wi-Fi credentials and hub host if set (`CONFIG_FR_DEV_WIFI_SSID`, `CONFIG_FR_DEV_WIFI_PASS`, `CONFIG_FR_DEV_HUB_HOST`, in `sdkconfig.local`; empty by default). It never uses UDP ([05 §5.5](05-network.md)).
- The hub registers it on its first HELLO as a row with `provisioned: false` and `addr: null` (§6.3) and WELCOMEs it, so it can be commanded. In M1 the only way to adopt it is to reprovision it over USB (`fr devices provision`, plan `full`). Adoption over the link (`device_adopt`, trust on first use, lab only), which writes `addr`, `net` and the alias into `fr_ovr`, is M2.

## 6.5 OTA transports

| Transport | When | Time (measured at checkpoint C4, images of 1.1–1.3 MB) |
|---|---|---|
| Serial (esptool, compressed; the `flash_start` `app` plan) | USB-attached nodes, the gateway, recovery | 5.9 s (C3), 6.8 s (C6) |
| **Wi-Fi HTTP pull** from `http://<hub IP of the node's TCP session>:7422/ota/<fw_id>.bin` (Range supported) | default for networked nodes | 15.6 s (C3), 18.8 s (C6) end to end, including the reboot, the health gate and the deploy's expectation; 40–52 s for three boards at once, two of them on marginal C3 links ([04 §4.6](04-boards.md)) |
| ESP-NOW relay via the gateway (M2+) | ESP-NOW-only nodes | ~45–90 s at 1 Mbps; faster at ≥ 6 Mbps (estimate) |
| Delta OTA (`esp_delta_ota`, M3+) | ESP-NOW nodes, small changes | depends on patch size |

The node-facing HTTP port (7422) serves an image only to the node it is OFFERED to, recognised by the source IP of that node's live TCP session ([08 §8.10](08-hub.md)).

## 6.6 Node side: `fr_ota`

`fr_ota` is the one sink for every transport. `src/core` (the job state machine, CHECK, resume bookkeeping, the health gate) and `src/http` build on the host ([10 §10.4](10-testing.md)); the core runs over four interfaces:

| Interface | Implemented by | Does |
|---|---|---|
| `Flash` | `src/esp` (`esp_ota_ops`) | `begin(size, resume_off)` (`OTA_WITH_SEQUENTIAL_WRITES`; `esp_ota_resume` from an offset), sequential `write`, `finish` (`esp_ota_end`, then the slot's SHA-256), `set_boot`, `abort`, `read` (the slot, for a resume's CHECK), `mark_valid`, `rollback`, and `running()`: fw_id, version, pending_verify, the last invalid fw_id, chip id and revision, slot size and address, whether this boot follows a crash |
| `Fetch` | `HttpGet` (`src/http`) | the image GET with Range |
| `Store` | `src/esp` (`nvs:fr_ota`) | the job record: `job, fw, size, off, hub_seen, slot, state` (§6.3) |
| `Host` | `fr_core` | `Net::send_ota`, the hub endpoint of the TCP session, BYE `ota` + restart |

**Threads.** `Ota` lives on the core task; `fr_core` owns it and forwards it `Net`'s OTA frames. Everything that blocks or writes flash (HTTP, the slot, otadata, `nvs:fr_ota`) runs on `fr_worker` ([03 §3.4](03-firmware.md)), one download step per worker job, so other slow work interleaves; when the queue is full the next step runs at once in the same job rather than stall. Results come back through atomics the core task reads when the worker pokes it (`Core::post`), and at Ota's 1 s tick at the latest, so a lost poke only delays. The tick and the health deadline share one Core timer.

**OFFER.** Frames and fields are in [05 §5.7](05-network.md). An OFFER with an empty `job_id` or an undecodable body gets no answer. One the OFFER alone decides (a REJECT; ACCEPT again for a re-sent OFFER of the job in progress) is answered at once through `Net`, which caches the answer for a DUP. Otherwise ACCEPT or REJECT follows once CHECK has read the image's first 400 bytes (`kCheckBytes` = 288 + 112: through the end of `fr_app_desc`), as an ordinary OTA frame. ACCEPT `code` is 0 fresh or 1 resumed.

**CHECK** runs before the first flash write:

| REJECT | Name | When | Decided from |
|---|---|---|---|
| 1 | `busy` | a job is running, or an ABORTed one is still winding down; the running app is `PENDING_VERIFY` (IDF refuses an update then); a mark-valid or rollback is in flight; there is no TCP session to download over; the `fr_worker` queue is full | the node's state |
| 2 | `chip` | the image's chip id (header byte 12) is not the running chip's, or the chip revision is outside its min/max (bytes 15 and 17; IDF's rule: the maximum applies only when set) | first 400 bytes |
| 3 | `identity` | `fr_app_desc` `board`, `profile` or `part_profile` differs from `fr_ident` (unless FORCE) | first 400 bytes |
| 4 | `size` | larger than the update slot | OFFER |
| 5 | `same_fw` | `fw_id` is the running image's or the last invalid one's (unless FORCE) | OFFER |
| 6 | `downgrade` | the image's own `esp_app_desc_t.version` (offset 48) has a lower leading semver (`[v]X.Y.Z`) than the running image's; a label that is not semver never counts (unless ALLOW_DOWNGRADE) | first 400 bytes |
| 7 | `bad_image` | `fw_id` is not 32 bytes or the size is under 400; no `0xE9` magic, `hash_appended` ≠ 1, or no `esp_app_desc_t` or `fr_app_desc` magic | OFFER, then first 400 bytes |

Only `busy` is worth retrying (§6.7).

**Download**
- **URL.** `http://<hub IP of the TCP session>:7422/ota/<lowercase hex fw_id>.bin`: the address the node's TCP link is connected to, not a fresh lookup of `hub_host`.
- **`HttpGet`** (`fr::ota::HttpGet`, one source for lwIP on the target and POSIX in the host tools) is an HTTP/1.1 GET to a dotted IPv4 with `Connection: close` and `Range: bytes=N-`. A 206 must carry a Content-Range that starts at the offset asked for; a 200 to a Range request is skipped up to it; the body is Content-Length long or runs to the close; chunked encoding is refused. `kHttpTimeoutMs` (10 s, below the hub's 15 s stall limit) bounds the non-blocking connect and every send and receive. A GET allocates no heap; the response head must fit a 512 B buffer.
- **Why not `esp_http_client`.** It pulled about 110 KB into the image (esp-tls, `tcp_transport`, `http_parser` and TLS code, HTTPS off or not). `HttpGet` is about 5 KB of flash, and each debug image shrank by about 111 KB. Of the 1,966,080 B slot: `c6-pad` 61.3 % (was 67.0 %), `c6-pad-mono` 60.1 % (65.8 %), `c3o-pad` 55.1 % (60.9 %), about 32–35 KB more than at C3.
- **Writes.** Whole 4 KB chunks, sequentially: `OTA_WITH_SEQUENTIAL_WRITES` erases one sector at a time instead of pre-erasing the slot, which would stall the radio for seconds, and is never mixed with `esp_ota_write_with_offset`. While a job runs, the node sets HEARTBEAT `ota_busy` and relays no floods ([05 §5.9](05-network.md)).
- **Within a boot**, a failed connect or read re-issues `Range: bytes=<received>-`, at most 5 times per job (`FR_OTA_RANGE_RETRIES`); after that, RESULT failed `download`.
- **Resume.** `off`, a whole number of 4 KB sectors, is saved every 64 KB (`FR_OTA_RESUME_STRIDE`), only after those bytes are in flash. An OFFER of the same `fw_id`, size and slot, while the record is still in the download state with `off` ≥ 400, resumes through `esp_ota_resume` (after a reboot, or a hub retry within the boot) and continues with `Range: bytes=off-`; its ACCEPT says `resumed`. `esp_ota_resume` skips the checks `esp_ota_begin` makes, so CHECK runs again on the descriptors read back from the slot. A slot that will not reopen starts over.
- **STATUS** `downloading` with `bytes` at least every 5 % or 1 s.
- **VERIFY.** `esp_ota_end` must validate the image and the slot's SHA-256 must equal the OFFER's `fw_id`, else RESULT failed `digest`; the resume offset is cleared, so the next OFFER starts over.
- **Install.** Without DEFER_COMMIT: record `state installed`, set the boot partition, STATUS `rebooting` (bytes = size), BYE `ota` on every session, restart 250 ms later; the RESULT comes from the next boot. With DEFER_COMMIT (M3; the hub never sets it in M1): STATUS `staged`, and COMMIT installs.
- **RESULT failed** reasons: 1 `download` (HTTP still failing after the re-issues), 2 `digest`, 3 `flash` (opening, writing or closing the slot, or setting the boot partition).

**ABORT** (`{job_id}`)
- In `checking` or `downloading` the worker sees it at its next step; until then the job is `aborting` (the worker can sit in a 10 s read). A re-OFFER meanwhile, with its own `job_id` too, gets REJECT `busy`.
- An ABORTed attempt sends nothing more: no deferred ACCEPT, no REJECT, no RESULT, whichever way the worker ended it.
- Two more cancel checks catch an ABORT that lands during the finish step: after VERIFY, before staging or installing (the resume offset stays, so the next attempt continues from it), and after `installed` is saved, just before `set_boot` (the record goes back to the download state with `off` 0: the next attempt starts over).
- An ABORT while `esp_ota_set_boot_partition` itself runs is past the point of no return: the node sends STATUS `rebooting` and restarts into the image (pointing the boot partition back would leave the running image `PENDING_VERIFY` on the next boot). The hub waits for that word (§6.7).
- A staged job's ABORT drops it; the slot is never booted.

```
IDLE ─OFFER→ CHECK (OFFER) ─fail→ REJECT(code)
CHECK ─ok→ DOWNLOAD: first 400 B → CHECK (image) → ACCEPT | REJECT; then STATUS ─err→ RESULT failed(reason)
DOWNLOAD ─done→ VERIFY (digest == fw_id) ─fail→ RESULT failed(digest)
VERIFY ─ok→ [STAGED ─COMMIT→] INSTALL: state installed, set boot partition, STATUS rebooting, BYE{ota}, restart
ABORT: checking | downloading → aborting → IDLE (nothing sent); staged → IDLE
BOOT (bootloader: NEW → PENDING_VERIFY) → health deadline (60 s)
    all required bits set → esp_ota_mark_app_valid_cancel_rollback() → RESULT success after a WELCOME
    deadline expires      → state health_timeout; esp_ota_mark_app_invalid_rollback_and_reboot()
    panic / WDT / any reset before valid → the bootloader rolls back → previous image boots
ROLLED BACK (old image): the record names the invalid image → RESULT rolled_back {fw_id_prefix, reason}
```

**Health gate** (`Ota::on_boot`, boot step 2 of [03 §3.5](03-firmware.md)). A `PENDING_VERIFY` image has 60 s (`FR_OTA_HEALTH_DEADLINE_MS`) to set every required bit:

| Bit | Set when |
|---|---|
| `CORE` | boot complete (`fr_core`'s `run_ports`) |
| `CAPS` | every bound capability's `init()` succeeded. Never in a fault build ([03 §3.8](03-firmware.md)) |
| `NET` | Wi-Fi is up (on link changes, plus a 250 ms poll while it is still required); on a radio-off image (`CONFIG_FR_NET_RADIO=n`, the HIL fixture, since M2-C1) its serial session's WELCOME ([design m2-c1-hil](../design/m2-c1-hil.md) D6; `fr_core` `core.cpp`) |
| `HUB_ACK` | a WELCOME gave a link its session. Required only when the installing job's record has `hub_seen`, which an OFFER over a hub session sets (the hub was reachable before the update); otherwise a hub outage would roll back every node |

- All required bits → mark valid; RESULT success goes once a WELCOME has arrived, and the hub marks the image `valid` from it (the node HELLOs only on a new session). A mark-valid already on the worker when the deadline fires decides; one that fails is not retried, and the deadline rolls the image back.
- Deadline → `state health_timeout` is saved, then `esp_ota_mark_app_invalid_rollback_and_reboot()`.
- **Never during `PENDING_VERIFY`** accept an OFFER (REJECT `busy`). If no rollback is possible (no other valid app), the image stays `PENDING_VERIFY` and REJECTs `busy` until a serial flash.

**Rollback detection and report.** On boot, the stored job rolled back when the record's state is not `download`, the running `fw_id` is not the record's, and the last invalid partition's SHA-256 equals the record's `fw_id`. The state check avoids a false report when power was cut between saving `installed` and `set_boot`. After the first WELCOME the node sends RESULT `rolled_back {fw_id_prefix: the invalid image's, reason}`:

| Reason | When |
|---|---|
| 1 `health_timeout` | the record's state is `health_timeout`: the image missed its deadline and asked for the rollback |
| 2 `crash` | the reset that ended its boot was PANIC, INT_WDT, TASK_WDT or WDT |
| 3 `unknown` | anything else |

A RESULT success that an earlier boot did not get out (valid, then a reset) goes after the next WELCOME the same way. Each report goes once, then the record is cleared. "Once" means `Net::send_ota` accepted it, so a RESULT lost with its TCP session leaves the hub to its own rules (§6.7).

| Node constant | Value |
|---|---|
| `FR_OTA_HEALTH_DEADLINE_MS` | 60000 |
| `FR_OTA_CHUNK` / `FR_OTA_RESUME_STRIDE` | 4096 / 65536 B |
| `FR_OTA_RANGE_RETRIES` | 5 per job |
| `FR_OTA_STATUS_MS` | 1000 (and every 5 %) |
| `kCheckBytes` / `kHttpTimeoutMs` | 400 B / 10000 ms (connect, and every send and receive) |
| restart after BYE `ota` | 250 ms |

**Hub duty during VERIFYING:** never reset the device. That means no esptool probe and no DTR/RTS on port open.

**Crash reports (deferred; not built in C4).** After any crash, if `esp_core_dump_image_check()` passes, the node will POST the ELF core dump to `http://<hub IP>:7422/node/v1/coredump/<device_id>` once its TCP link has been WELCOMEd. It has to wait, because port 7422 serves only nodes with a live 7421 link ([08 §8.10](08-hub.md)). The node erases the dump after a 2xx response. The hub decodes it against the stored ELF of that `fw_id`. Until then the coredump partition stays and 7422 answers that route with 501.

## 6.7 Hub side: OTA job and rollout

`ota_deploy` ([09 §9.4](09-agent-api.md)) starts a parent job (kind `ota`, no lock) and one child job (kind `ota`) per device. A Wi-Fi child holds `device:<id>` for its whole run.

**Per-device job (Wi-Fi):**

`QUEUED → OFFERED → DOWNLOADING → [STAGED] → REBOOTING → VERIFYING → SUCCEEDED`

| State | Entered on | Deadline | When it runs out |
|---|---|---|---|
| `OFFERED` | the OFFER (ACK_REQ; TCP, else serial) | ACCEPT within 10 s | ABORT; `FAILED accept_timeout` (retried) |
| `DOWNLOADING` | ACCEPT | 15 s without progress | ABORT; `FAILED stalled` (retried) |
| `STAGED` | STATUS `staged` | the stall deadline keeps running (no DEFER_COMMIT in M1) | ABORT; `FAILED stalled` (retried) |
| `REBOOTING` | the node's word that it installed the image (below) | back online within 60 s | `TIMED_OUT not_back_online` (`needs_serial_recovery`) |
| `VERIFYING` | `device.online` with the new `fw_id` | RESULT success within 70 s | `TIMED_OUT not_confirmed`. Offline again: 60 s to come back, else `TIMED_OUT not_back_online` (`needs_serial_recovery`) |

Terminal: `SUCCEEDED`, `FAILED(code)`, `ROLLED_BACK {reason}`, `TIMED_OUT {code, needs_serial_recovery}`, `CANCELLED`.

- **Retries.** An attempt that fails retryably (`accept_timeout`, `stalled`, `device_offline`, `no_tcp_session`, REJECT `busy`, RESULT failed `download`, `digest` or `flash`) publishes `QUEUED {code, message, attempt}`, and the next attempt starts after 5, 15 or 45 s (3 retries). `FAILED` is published only when final. Any other REJECT is final (`FAILED` with its name), and so is `no_http_listener`.
- **ABORT.** After an ACCEPT timeout, a stall or a cancel the hub sends ABORT. The REJECT `busy` that answers the next OFFER, the first after that ABORT, is free: the node is still ending the aborted attempt (§6.6), so the same attempt goes again after the same wait (`QUEUED {code: busy}` says so in `message`), once per ABORT.
- **Stall.** The deadline restarts whenever the node's STATUS `bytes` grow (DOWNLOADING or STAGED) and on every chunk 7422 serves it, bytes served again after a Range re-issue included (the socket's flow control paces the stream to the node). `bytes` keeps the most, for display and events. A stream left from an earlier attempt feeds nothing into the next.
- **Where an attempt's download starts.** The child job's log names each attempt's first GET to 7422: `first GET of this attempt from byte <n> of <size>`, with `(Range: resuming)` when n > 0 (the node's stored offset, a whole 64 KB stride). It is the hub's own record of a resume for a board whose USB log is not there (T-OTA's power cut, [10 §10.5](10-testing.md)); from M1 step 7.
- **Installed?** Only the node's word counts: STATUS `rebooting` or BYE `ota`, or every byte in its STATUS (a device that then goes away is taken as rebooting). STATUS `rebooting` enters REBOOTING without waiting for the BYE. What 7422 served says nothing: it runs ahead of the node by the socket buffers between them (100 KB and more), so a power cut late in a download would look like a reboot. A device that goes away before it installed the image is `FAILED device_offline` (retried; the next OFFER resumes).
- **Already installed.** A retry that finds the device already on the target `fw_id` (its last STATUS and BYE lost) goes straight to VERIFYING instead of offering the image again, but only when an earlier attempt reached DOWNLOADING, STAGED or REBOOTING, or the device was not on the target when planned: a forced reinstall of the running image is offered again.
- **VERIFYING.** `device.online` carries HELLO `ota_state`: `pending_verify` waits for RESULT success (one that arrived before `device.online` is kept), `valid` is confirmed at once.
- **ROLLED_BACK.** RESULT `rolled_back` in OFFERED, DOWNLOADING, STAGED, REBOOTING or VERIFYING ends the job at once with its reason. So does one for a child waiting out its retry backoff: it wakes the backoff, because another OFFER would only get REJECT `same_fw`. A device back on another `fw_id` after it installed the image waits 5 s for that RESULT, else `ROLLED_BACK unknown`. Back on another `fw_id` without having installed it is `FAILED device_offline` (retried).
- **Cancel** (`job_cancel`, the parent's cancel, a hub stop). ABORT to a node in OFFERED, DOWNLOADING or STAGED, then CANCELLED. A node that has reported every byte may already be setting its boot partition, past its last cancel check (§6.6): the child waits `abortGraceMs` (3 s) for STATUS `rebooting` or BYE `ota`, and with one follows that boot as usual (REBOOTING, VERIFYING, SUCCEEDED: the cancel came too late, and the job says what happened); without one it is CANCELLED.
- **Serial child** (`via serial`, or `auto` with the device's USB port open). It takes no lock itself: its `flash_start {plan: app}` job takes `port:<id>` and `device:<id>`. `QUEUED → DOWNLOADING` (the flash job) `→ REBOOTING` (online on the new `fw_id` within 60 s) `→ SUCCEEDED` or `TIMED_OUT`. No RESULT: a serially flashed image is never `PENDING_VERIFY`, so a reset then is harmless. A cancel also cancels the flash job, even one `flash_start` returns after the cancel. A fault build never goes this way (§6.8).
- **Records.** Every transition is persisted in `ota_jobs` (the row `ota_status` answers) and in the child job's stage, and published as `ota.job.state` ([08 §8.7](08-hub.md)); DOWNLOADING also every 10 %. A hub start marks rows a stopped hub left unfinished `FAILED hub_restarted`. A Wi-Fi SUCCEEDED records the full `fw_id`, profile and board in the registry.

| Hub constant | Value |
|---|---|
| ACCEPT / stall / back online / confirmed | 10 s / 15 s / 60 s / 70 s |
| retry backoff | 5, 15, 45 s (3 retries) |
| rollback reason grace / abort grace | 5 s / 3 s |
| progress event | every 10 % |

**Fleet deploy.**
- M1: a selector plus `max_parallel` (default 4) and `on_failure: halt|continue`. `halt` stops new devices before the failing child frees its slot; they end `CANCELLED halted`.
- M3: canary and waves with soak time, a failure ratio, and an atomic commit across devices (`DEFER_COMMIT`, then a broadcast COMMIT) for breaking protocol changes.

**Transport `auto`:** serial if the hub holds the device's USB port open (not closed, leased or held by another program), otherwise Wi-Fi, otherwise ESP-NOW relay (M2+). A fault build always goes over Wi-Fi. A USB gateway is flashed over serial, always last.

## 6.8 Artifacts

```
~/.fractonica/artifacts/
  blobs/sha256/<aa>/<sha256>                                       # bin, elf, map, bootloader, ptable
  builds/<app>/<profile>/<build_type>/<fw_id[0:12]>/manifest.json   # build_id = "<app>/<profile>/<build_type>/<fw_id[0:12]>"
  builds/<app>/<profile>/debug-fault/<fw_id[0:12]>/manifest.json    # a fault build (03 §3.8): build_id "<app>/<profile>/debug-fault/<fw_id[0:12]>"
```

```json
{
  "schema": "fractonica.artifact/1",
  "build_id": "node/c6-pad/debug/9f2c1e07ab12",
  "app": "node", "profile": "c6-pad", "build_type": "debug", "board": "esp32c6-supermini",
  "target": "esp32c6", "chip_id": 13, "min_chip_rev": 0, "max_chip_rev": 99,
  "part_profile": "fr-4mb-v1", "proto": "1.0", "catalog_hash": 3639287564, "test_pin": 20,
  "version": "6d074fa-dirty.9f2c1e07",
  "source_dir": "/Users/dimas/projects/fractonica-hardware", "git": { "sha": "6d074fa…", "dirty": true },
  "idf": { "tag": "v6.1", "commit": "…" },
  "fw_id": "9f2c1e07ab12…", "elf_sha256": "…", "size": 1204448,
  "app_desc": { "board": "esp32c6-supermini", "profile": "c6-pad", "part_profile": "fr-4mb-v1", "catalog_hash": 3639287564, "fault": 0 },
  "flash": { "mode": "dio", "freq": "80m", "size": "4MB",
             "files": [ { "offset": "0x0", "blob": "sha256:…", "role": "bootloader" },
                        { "offset": "0x8000", "blob": "sha256:…", "role": "partition_table" },
                        { "offset": "0xe000", "blob": "sha256:…", "role": "ota_data_initial" },
                        { "offset": "0x10000", "blob": "sha256:…", "role": "app" } ] },
  "debug": { "elf": { "blob": "sha256:…", "size": 6815744 }, "map": { "blob": "sha256:…", "size": 1048576 } },
  "caps": [ { "name": "boot", "port": 1, "cap": "fr.button", "cap_id": 1, "version": "1.0", "driver": "button_gpio",
              "config": { "debounce_ms": 20, "long_press_ms": 600, "multi_press_gap_ms": 250, "multi_press_max": 2 },
              "traits": { "long_press": true, "multi_press_max": 2 } },
            { "name": "status", "port": 2, "cap": "fr.led", "cap_id": 2, "version": "1.0", "driver": "led_ws2812",
              "config": { "max_brightness": 64 }, "traits": { "color": "rgb", "dimmable": true } } ]
}
```

- **Caps.** Ingest copies `caps` (with each port's effective service config) and `catalog_hash` (u32) from the build's `fr_manifest.json` ([03 §3.8](03-firmware.md)); the hub names a device's frames from them ([08 §8.3](08-hub.md)).
- **Traits** (since C6). Each cap carries `traits`, every trait of the capability as the firmware reports it (default, then the driver.yaml `traits:`, then what the service derives from its config; [03 §3.6](03-firmware.md)). `ManifestCap.traits` is a record of bool, number or string, nullable and optional: absent in builds from before C6. `capability_list`, the `/app` welcome and the dashboard take each instance's traits from its firmware's manifest; null (a build from before C6, or firmware the hub did not build) shows every trait-gated member ([07 §7.9](07-capabilities-sdk.md)).
- **`test_pin`** (since C6). The board's T-LAT test pin GPIO (0..48), null without one, absent in builds from before C6 ([03 §3.4](03-firmware.md), [04 §4.3](04-boards.md)).
- **Version label.** `version` is a display label: `<sha>-dirty.<fw_id[0:8]>` for a tree that is dirty at ingest, plain `<sha>` for a clean one. `<sha>` is the image's own `esp_app_desc_t.version` (IDF's `git describe --always --tags --dirty` at configure time: the short commit while the repo has no tags) without a trailing `-dirty`, so `-dirty` appears once. The tree's git state at ingest decides, not the image's suffix, which IDF fixes at configure time and can be stale; the `fw_id` part tells two dirty builds of one commit apart.
- **Fault builds** ([03 §3.8](03-firmware.md)) keep `build_type: debug` and add `"fault": "health"`; `app_desc.fault` is 1. The `artifacts.fault` column keeps them out of every newest-artifact pick (flash, provision, OTA, deploy): they are used only when named by `build_id`.
- **Debug files.** `debug.elf` and `debug.map` keep the app ELF and linker map of every `fw_id` (never flashed), for panic and core-dump decoding after the build dir has been reused. Ingest checks `sha256(ELF) == elf_sha256`. The blob store has no GC yet: each distinct build adds about 7 MB.
- **Flash offsets** come from `flasher_args.json`. Any esptool v4 spellings (`default_reset`) are normalised to v5 (`default-reset`).
- **Header parsing.** The hub parses image headers itself: `0xE9` magic; `chip_id` at offset 12; min/max chip revision at 15 and 17; `esp_app_desc_t` at 32; the custom `fr_app_desc_t` at **288** (24 + 8 + 256); the appended hash in the last 32 bytes for unsigned images.
- **`fr_app_desc_t`** (`fr/app_desc.h`, plain C; a wire format: new fields go into `reserved2` only):

  | Offset | Field | Value |
  |---|---|---|
  | 0 | `magic u32` | `0x46524144` (`FRAD`) |
  | 4 | `version u8` | 1 |
  | 5 | `proto_major u8`, `proto_minor u8`, `reserved u8` | the wire protocol version |
  | 8 | `catalog_hash u32` | the generated `fr::cap::kCatalogHash` ([07 §7.6](07-capabilities-sdk.md)) |
  | 12 | `board char[32]` | `CONFIG_FR_BOARD` |
  | 44 | `profile char[32]` | `CONFIG_FR_PROFILE` |
  | 76 | `part_profile char[16]` | `CONFIG_FR_PART_PROFILE` |
  | 92 | `fault u8` | 0 none, 1 health (`CONFIG_FR_TEST_FAULT_HEALTH`) |
  | 93 | `reserved2[19]` | zero; the struct is 112 B, so 288 + 112 = the 400 B a node's CHECK reads (§6.6) |
- **`fr_app_desc` definition rules.** It is defined once with C linkage, in `fr_core` (`src/app_desc.cpp`, `extern "C"`, so `catalog_hash` can come from the generated C++ constant), as `const fr_app_desc_t fr_app_desc __attribute__((used, section(".rodata_custom_desc"))) = {…};`, with a leading magic word, `_Static_assert` on its size and field offsets, and `target_link_libraries(${COMPONENT_LIB} INTERFACE "-u fr_app_desc")`. A namespace-scope C++ `const` has internal linkage and would be dropped. IDF v6.1 places `.rodata_custom_desc` right after `.rodata_desc` in `.flash.appdesc` on every target, which puts it at offset 288 (checked on all five C4 builds).
- **Ingest check.** Ingest parses `fr_app_desc` into the manifest's `app_desc` (`fault` as the raw byte) and fails the build with `BUILD_FAILED` (stage `ingest`) if the magic is missing at 288, the version is not one it reads, or `board`, `profile`, `part_profile`, `catalog_hash` or `fault` differ from the build it asked for; the error lists each field. A `fault` mismatch means the fault layer did not take effect.

## 6.9 Security levels

| Level | What | Default |
|---|---|---|
| L0 | HTTP on the LAN, with `fw_id` pinned in the OFFER (which arrives over the hub's TCP link, or USB). No TLS | **PoC** |
| L1 | Signed apps without secure boot (`CONFIG_SECURE_SIGNED_APPS_NO_SECURE_BOOT` + `CONFIG_SECURE_SIGNED_ON_UPDATE_NO_SECURE_BOOT`). The running app verifies new images; no eFuses are burned. Its trust anchor is the running app's signature block, so the first signed image must be installed over L0 or serial, and after that the device refuses unsigned OTA, including a return to L0. For L1 images, `fw_id` comes from the image (a segment walk to `image_len − 32`), not from the file's last 32 bytes, and the slot check uses `ALIGN_UP(image_len, 4 KB) + 4 KB`. Combine with M3 envelope security for an authenticated OFFER | opt-in |
| L2 | Secure boot v2 + flash encryption | **never on lab devices** |

## 6.10 esptool integration (hub `pytools`)

- **Environment.** `tools/pytools` is a uv project: Python 3.12, `esptool==5.6.0` (stub v1.4.1; fallback pin 5.5.0, qualified in S1), `esp-idf-nvs-partition-gen` and `esp-idf-panic-decoder`.
- **Process model.** The hub spawns `~/.fractonica/pytools/bin/python -I -m fractonica_pytools`, one process per job, speaking JSON lines over stdio. esptool's logger is global, and a process per job also gives clean cancellation.
- **API.**
  - `esptool.cmds`: `detect_chip` / `connect_esp`, `detect_flash_size` (returns a string), `write_flash` (multiple offset/file pairs, compressed, verify), `erase_region`, `reset_chip`.
  - `ESPLoader` methods: `esp.get_chip_description()`, `esp.get_chip_features()`, `esp.read_mac('BASE_MAC')`, `esp.get_security_info()` (a dict).
  - The `cmds` functions `read_mac`, `get_security_info` and `flash_id` **only log**, so they are not used.
  - All calls live in one adapter module with per-chip contract tests. A custom logger turns progress into JSON events.
- **Reset modes:**
  - `--before default-reset` (auto USJ reset), `--after no-reset`; the hub then hard-resets through its own open port (§6.4 step 8).
  - `device_reset {mode: hard}` is done by the hub on its open port (RTS pulse, DTR deasserted), so the boot log is kept. esptool's hard reset is only the fallback when the hub cannot open the port.
  - `device_reset {mode: bootloader}` = connect with `default-reset`, then `reset_chip(esp, 'no-reset')`.
  - A stuck download-mode node is recovered with `watchdog-reset` on C3/S3, or RST on C6.
- **Fallback:** the pinned esptool CLI with `NO_COLOR=1`, parsing only exit codes and coarse progress.
