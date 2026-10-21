# 08 — Hub (host software)

## 8.1 Stack

| Concern | Choice | Why |
|---|---|---|
| Runtime | **Node.js** ≥ 24.12 now; Node 26 once Active LTS (2026-10-28). In the repo, TS runs directly via type stripping (`erasableSyntaxOnly`, no enums or namespaces). Published packages ship JS (§8.12) | Shares types with the dashboard, SDK and MCP; no build step in development |
| HTTP + WS | Fastify 5 + `@fastify/websocket` (ws 8) + `@fastify/static`; the node HTTP listener (7422) is plain `node:http` (§8.10) | Mature; OpenAPI from Zod. 7422 only streams images with Range and binds the node-facing interface, so it shares nothing with the API server |
| Schemas | Zod 4 operation registry ([09 §9.1](09-agent-api.md)) + generated device codecs ([07 §7.6](07-capabilities-sdk.md)) | One source per concern |
| Serial | `serialport` 13 behind a `SerialTransport` interface | N-API prebuilds for darwin-arm64 and linux-arm64. Plan B: a napi-rs addon over `serialport-rs` |
| Flashing | `pytools` sidecar: uv-managed Python 3.12, **esptool 5.6.0 API**, one process per job, JSON lines ([06 §6.10](06-identity-ota.md)) | Espressif recommends the API over log scraping |
| Storage | `better-sqlite3` (WAL) behind a `Db` interface, **writes on a worker thread** | Fast; keeps the event loop free |
| Dashboard | React 19 + Vite + TanStack Query/Router/Virtual + Zustand + Tailwind + xterm.js (logs) | Good fit for agents writing the code; logs bypass React state |
| MCP | `@modelcontextprotocol/server` v2 (spec 2026-07-28, legacy serving on), stdio adapter first | [09 §9.6](09-agent-api.md) |
| Rejected | Bun (serialport panics, oven-sh/bun#18546); Python, Go or Rust hub (the consumer surfaces are TS); a Docker hub (no USB on macOS) | |

## 8.2 Process model and lifecycle

```
 fractonica hub (one Node process, detached daemon)
 ├─ SerialPortManager      main thread; owns every /dev/cu.* fd (serialport binds to libuv's default loop)
 │   ├─ LinePipeline       splits `@fr1:` frames (→ Router; also stored decoded, §8.3) from log lines (→ LogStore + bus)
 │   └─ Leases             hand-off to pytools jobs or external tools (TTL, holder pid, visible in UI)
 ├─ NodeLinks              TCP :7421 (node-initiated), UDP :7421 (inbound), serial ENV frames, gateway (M2)
 ├─ Router                 windows per 05 §5.8, hub sequence spaces, WELCOME/DIRECTORY/TIME, get_state, presence, commands, fan-out
 ├─ Codec                  generated TS envelope + capability codecs
 ├─ Bus + Events           publish synchronously in the receive tick; events stored in the `events` ring (§8.7)
 ├─ Registry + Db          SQLite (WAL); writes queued to a worker_thread; main thread never blocks on disk
 ├─ JobRunner              build / flash / provision / ota / deploy / test jobs; locks; spawns children
 ├─ OtaOrchestrator        per-device OTA jobs (06 §6.7) and the node HTTP listener :7422 (§8.10)
 ├─ Listeners              :7420 API (loopback) · :7421 node links · :7422 node HTTP (OTA; core dumps later)
 └─ SleepGuard             child `caffeinate -i -w <hub pid>` while any node session is up or any OTA child is unfinished (05 §5.11)
 children: pytools (flash/probe/nvs/panic) · idf.py builds (sanitized env) · caffeinate
 separate process: `fr mcp` (stdio MCP adapter → hub REST/WS)
```

Rules:

1. **Only the hub opens serial ports.**
   - Flashing leases the port to a pytools child: the hub closes its handle, the child runs, and the hub reopens with backoff.
   - External tools (`idf.py monitor`, pytest-embedded, gdb) take an explicit lease ([09 §9.2](09-agent-api.md)). While the lease is held, the hub has no access to the port.
2. **Nothing on the input path awaits I/O.** Receive → decode → dedupe → publish → WS send runs synchronously in one tick. Persistence is enqueued.
3. **CPU-heavy work runs in child processes:** builds, hashing images over 1 MB, panic decoding.
4. **Event-loop delay** is monitored (`perf_hooks.monitorEventLoopDelay`), with a warning above 5 ms p99.

**Lifecycle**

- **Single instance.** The hub binds its loopback API address (`127.0.0.1:7420`) *before* opening `hub.db` or any port; the bound address is the mutex, and the kernel frees it when the process dies. Serial ports open only after the API listens. A second instance exits 0 with `already_running`; if anything that is not a hub holds the address, the start fails with exit 1.
- **Pidfile.** `~/.fractonica/hub.lock` holds the hub's pid for discovery only. It is written by tmp + rename and removed on exit. A pid read from it counts only while `ps` shows it running the hub's `packages/hub/src/main.ts`, so a pid reused after a crash never blocks a start and is never signalled.
- **Detached.** `fr hub start` detaches by default (`--foreground` keeps it in the terminal); the daemon uses `setsid`, logs to `~/.fractonica/hub.log`, and runs on the absolute Node path recorded by `fr doctor --fix`. It refuses Node < 24.12.
- **`fr mcp` auto-start.** If nothing answers on `127.0.0.1:7420`, `fr mcp` runs `fr hub start` and waits up to 10 s. The hub is **never** a child of an MCP or agent process, so ending a Claude session never kills in-flight flash or OTA jobs.
- **Version check.** `hub_status` reports the version, `registry_hash`, Node path and version, `launched_by` (the app responsible for the process), and `lnp: allowed|denied|unknown`. `fr mcp` refuses with `HUB_VERSION_MISMATCH` (remediation: `fr hub restart`) when the hashes differ.
- **Stop guard.** `fr hub stop|restart` refuses with `LOCKED` (retryable; `details.holder_job`, remediation `fr jobs wait <id>`) while any job is `queued` or `working`, unless `--force`. A hub whose pid is alive but does not answer `/health` is stopped only with `--force` (`HUB_UNREACHABLE` otherwise).
- **Stop.** `fr hub stop` sends SIGTERM and waits up to 10 s for the process to exit, not only for `/health` to go away, so `restart` never races the old hub for the ports. On SIGTERM the hub cancels its remaining jobs (killing build process groups and sidecars), sends a hub BYE on every serial node session and closes the node TCP connections ([05 §5.11](05-network.md)), drops open connections including long-polls, and exits within 5 s.

## 8.3 Serial subsystem

- **Discovery.** Poll `SerialPort.list()` every 500 ms and diff by serial number. The key is the **USB serial number (= MAC)** for USJ boards; the path is just an attribute. A port missing from the list for 1.5 s is gone.
- **Brief absences.** An op that acts on a port (`flash`, `devices reset`, a lease) waits up to 5 s for a port that disappeared in the last 60 s before answering `NOT_FOUND`, because a chip reset can re-enumerate USB. An unknown selector fails at once.
- **Identification.** Passive first ([04 §4.5](04-boards.md)). An active esptool probe runs only on first contact, on explicit request, or during provisioning.
- **Line control.** Open with `hupcl` off, then set DTR and RTS false at once. Resets happen only through explicit actions. S1 checks whether node-serialport toggles them during `open()` on macOS; if it does, use the plan-B transport.
- **Busy ports.** On `EBUSY`, `lsof` finds the holder, and the error is `PORT_BUSY_EXTERNAL` with app name and PID (today: Chrome, PID 715).
- **Logs.**
  - Each line is stored with a global **cursor**, timestamp, level and tag (parsed from the `ESP_LOGx` prefix), and a `kind`: `esp_log`, `boot` (ROM and bootloader lines), `frame` (a decoded `@fr1:` line), `diag` (a `#<id> {…}` response of the serial command channel) or `raw`.
  - **Frames are stored readable.** An `@fr1:` line is decoded with the generated TS serial codec and stored as `kind: frame`, for example `@fr1 EVENT boot.click {"count":1} (src=fffe seq=12 epoch=3 port=1)`; RESULT and ACK add `status=<name> req_seq=<n>`. Names come from the `fr_manifest` caps of the artifact whose `fw_id` starts with the boot banner's `fw=` (the device's prefix is kept in kv as `device_fw:<device>`, so names survive a hub restart). The system ports are named from the protocol constants, with or without a manifest, and a manifest entry cannot rename them (0 `node`, 240 `ota`, 241 `diag`: `@fr1 EVENT diag.mark {"token":"step1"} (…)`). An unknown port or member prints as `port=<p> kind=<k>` with hex fields; system classes print as `@fr1 <CLS> kind=<k> <hex>`, other serial types as `@fr1 <TYPE> <hex>`. A line that fails to decode is stored as `kind: raw` with `(decode error: <what> <code>)`.
  - **Repeats collapse.** Consecutive identical lines from one port are stored once, then as `(previous line repeated N more times)` at most once a second or when the text changes. A blank board's ROM loop prints ~400 identical lines a second; `ESP_LOG` lines carry a timestamp and never collapse. `@fr1:` lines never collapse either: identical lines are distinct envelopes.
  - **ENV frames to the Router.** After a line is stored, its decoded ENV envelope also goes to the Router as a frame of that port's serial link (§8.4).
  - **ROM banner split.** A reset cuts the line being printed, so `ESP-ROM:` can arrive glued to its tail. The hub stores the banner as its own line, so it still classifies as `boot`.
  - Panic blocks are decoded against the ELF of the running `fw_id` (`crash.detected`).
  - Logs live in a SQLite ring (7 days by default).
- **Download-mode detection.** "USB present and no HELLO or log for 5 s after a reset" sets `maybe_download_mode`, with a recovery hint.
- **Lease end.** When a lease ends, the port is reopened with DTR and RTS deasserted.
- **System resume.** A poll tick more than 10 s late means the Mac slept. The hub then closes and reopens every open port and logs `(hub: system resumed after <n> s; port reopened)`. At C2 a C6 stayed silent after a night's sleep on a handle that still looked open, and a hub-side reset recovered it ([04 §4.4](04-boards.md)).
- **Writing lines** (`diag_exec`, [09 §9.4](09-agent-api.md), and the Router's ENV frames). `writeLine` sends one line, LF appended, through the hub's open handle and refuses CR or LF inside it. It never drains: `tcdrain` would hold a libuv pool thread while the firmware does not read. A line is sent once its write callback fires, and concurrent lines on one handle queue in order. Only a handle whose write has been pending for more than 2 s refuses new lines, with `DEVICE_BUSY`, until that write completes (`TIMEOUT` for the stuck write itself).

## 8.4 Node links and routing

| Link | Direction | Notes |
|---|---|---|
| TCP :7421 | node connects | `len u16` + envelope, `TCP_NODELAY`, `SO_KEEPALIVE`; a length of 0 or over 2,048 closes the connection. One per node: a new HELLO closes the device's older connection, and one that sends no HELLO within 30 s is closed. Carries hub → node traffic for a node with a TCP session |
| UDP :7421 | node → hub only | inputs, presence, ACK/RESULT ([05 §5.10](05-network.md)); receive only, the hub never sends UDP |
| Serial `@fr1` ENV | both | USB-attached nodes are full links: incoming ENV lines are taken from the log store's frame decoder after the line is stored (§8.3), outgoing ones go through `writeLine`, one line at a time per port. A port that disappears ends its session at once (`device.link {link: serial, up: false, reason: 'usb port gone'}`) |
| Gateway (M2) | both | `@fr1` GW_* frames; several gateways allowed |

Unknown sources are accepted until their HELLO identifies them. A second hub for tests takes `--node-port`, `--node-host 127.0.0.1` and `--no-serial` (it must not touch the USB ports the real hub holds).

The **Router** does the following ([05 §5.8–5.12](05-network.md)):
- **Duplicate filtering** per [05 §5.8](05-network.md): replay windows on `(device, epoch, seq)` for ordinary frames (256 bits, keyed by device so unprovisioned nodes work), `last_seq` per `(device, port, kind)` for LATEST frames, and sessions reset on HELLO.
- **Hub-originated frames.** These get `src=0x0000`, the hub epoch (kv `hub_epoch`, incremented and fsynced at every start, skipping 0), `dst` = the node's HELLO `src`, `net` = its HELLO `net`, ttl 0x11, and a seq from the right space: one dense UNICAST counter per device, the BCAST counter, or LATEST, all from 1 each run.
- **Handshake.** On HELLO it upserts the registry (a first HELLO creates a `provisioned: false` row, [06 §6.3](06-identity-ota.md)) and answers WELCOME (`ucast_floor` = the WELCOME's own seq), then DIRECTORY (all provisioned devices, pages from 0), then a TIME burst (8 SYNC_REQ, min-RTT offset; again every 60 s), then `fr.node.describe` (BULK) when no artifact manifest names the HELLO's `fw_id_prefix` (cached per `descriptor_hash`), then `get_state`. Only then does it publish `device.online` (the node's first session) and `device.link {link, up: true}` (every session). It pushes `set_alias` when the HELLO's alias or rev differs from the registry's. HELLOs from another net are dropped (`foreign_net`) once a network record exists; the router reads `net_id` again on each HELLO until one does, so `fr net set` on a fresh `hub.db` needs no restart.
- **Liveness.** It echoes every UDP-received HEARTBEAT, DUP copies included, with an ACK over TCP; this is the `udp_ok` probe. On every session (TCP and serial) on which nothing went out for one heartbeat interval, it sends a hub PRESENCE/HEARTBEAT, so the node always has a keepalive. It raises `udp_blocked` when a TCP session sees no UDP for 10 s (`hub.warning` and `hub_status`; never for an UNASSIGNED node, nor while TCP is silent too) and clears it when UDP returns. Each session keeps its `lastRx` (the node's UDP counts for its TCP session).
- **Presence** ([05 §5.11](05-network.md)). Suspect at 2.5 × the interval, with PINGs at 2.5 × and 3.0 ×; offline at 3.5 × (≥ 750 ms), which sends a hub BYE on a serial session and closes the TCP connection; offline `link_lost` when the last session closes. A node's BYE is offline at once with its reason; commands waiting on the device keep waiting, and a RESULT from it is still taken, for 250 ms (`byeGraceMs`; over UDP, its TCP connection kept open that long, or its USB line), since a RESULT sent before the BYE on one link can arrive after it on another. A HELLO with another epoch is offline `restarted` (or `epoch_regressed`, logged), then a new handshake.
- **Which session.** The hub sends to a device (commands, OTA frames, PINGs, ACKs, `get_state` and TIME resyncs) over its TCP session, else its serial session, and over the serial session while nothing came over TCP or UDP from a device that has both for more than 2 heartbeat intervals (`wifiSilentX10` 20); back to TCP as soon as Wi-Fi carries ([05 §5.10](05-network.md)). Presence counts frames from any link, and the node sends its heartbeats on every session, so a USB node whose Wi-Fi stalls stays online. `device_get`'s `router.links` lists the links best first.
- **Commands.** One unicast CMD per device ([05 §5.8](05-network.md)). ACK_REQ whenever the RESULT is awaited; `expire_at_us` (hub now + 1000 ms, in node time) once the node is synced; RESULTs match on `(device, req_seq)` with `req_epoch` = the hub epoch, from any link. Q1 frames from nodes get an ACK (EVENT, MSG; again on a DUP) or are answered (PING → PONG).
- **OTA frames** ([05 §5.7](05-network.md)). Those over UDP or off port 240 are dropped (`ota_dropped`); those with ACK_REQ are ACKed, duplicates too, and handed to the OTA orchestrator (`sendOta` sends the hub's). HELLO `ota_state` is kept per device (`device_get` `router.ota_state`, `device.online`, `wait_for_device {ota_state}`); a RESULT success for the running image's prefix sets it `valid`, since the node HELLOs only on a new session.
- **Publication.** Capability EVENTs and STATEs become events (§8.7); STATE also updates a per-device property mirror, which `device_get` shows.
- **Routing (C5).** It keeps `addr → {links[], best}`. It fans broadcasts out over every link, forwards node → node frames when a node has no direct path, and repairs broadcasts for nodes whose watermark lags.
- **Clocks.** It tracks the per-node clock offset and uncertainty ([05 §5.12.4](05-network.md)).

## 8.5 Flashing and pytools

- **Setup.** `fr doctor --fix` runs:

  ```
  UV_PROJECT_ENVIRONMENT=~/.fractonica/pytools uv sync --project <repo>/tools/pytools --frozen --no-dev --no-editable --reinstall-package fractonica-pytools --managed-python --python 3.12
  ```

  The project path is absolute. The install is non-editable, so the hub never runs live sources from a checkout that may move; `--reinstall-package` rebuilds it, because uv by itself only notices `pyproject.toml` changes. After a successful sync, `fr doctor --fix` writes `~/.fractonica/pytools/fractonica-source.json` (`{source_dir, hash}`, the hash covering `pyproject.toml`, `uv.lock` and `src/`). `fr doctor` and `hub_status.warnings` report a sidecar whose stamp does not match the checkout as stale; `--fix` re-syncs it. The hub spawns `~/.fractonica/pytools/bin/python -I -m fractonica_pytools` directly, never `uv run`. `fr doctor` checks `esptool.__version__ == '5.6.0'` inside that venv. The system Python 3.9 is too old.
- **Protocol.** One JSON request on stdin; JSON-line events (`progress`, `log`, `result`, `error`) on stdout. Cancellation is SIGTERM.
- **Commands.**
  - `probe {port}`: chip, revision, features, flash size, MAC, security info. Uses ESPLoader methods; the log-only `cmds` functions are not used.
  - `flash {port, files:[{offset, path}], compress, verify, diff_with?, before, after}`.
  - `erase {port, scope, offset?, size?}`.
  - `nvs_gen {csv_path, size, out_path}` → `{out_path, size, rows}`: renders `fr_ident` ([06 §6.3](06-identity-ota.md)); no event or error carries the CSV's content.
  - `panic_decode {elf, text}`.
- **Plans** come from the artifact manifest ([06 §6.4](06-identity-ota.md)): `full`, `app` (always including otadata), `identity`, `recover`. `full` (for a provisioned device), `identity` and `recover` add `fr_ident` rendered from the registry. Never `idf.py flash`, and never merged images padded to full flash size (they would wipe `fr_ident`).
- **Artifact choice.** `fr flash --profile <p>` takes the newest `debug` artifact of (`node`, `p`), never a fault build; a release or fault build only through `--build`. With none, the result is `NOT_FOUND` with `build_start` as remediation.
- **Speed.** `write_flash --diff-with` (esptool ≥ 5.2) rewrites only changed sectors in the dev loop.

## 8.6 Builds

`BuildRunner` runs the contract in [03 §3.8](03-firmware.md):

- **Source.** Every build names an absolute `source_dir` (the agent's checkout or worktree). The hub never builds an implicit "own" tree.
- **Stages:** `generate`, `idf_env`, `compile`, `ingest`.
- **Generator from the checkout.** `generate` runs the checkout's own `fr gen firmware` (03 §3.8 step 3); the hub never loads `@fractonica/codegen`.
  - Errors: `NOT_FOUND` (unknown profile) passes through; schema issues are `BUILD_FAILED` with `{stage, issues}`; a CLI that cannot start or prints no envelope is `BUILD_FAILED` with its stderr tail and a `pnpm install` hint; an envelope without `manifest` or `part_profile` comes from a CLI older than the hub.
  - A changed `.slots.lock` adds a "commit it" warning.
  - Generation comes first, so `--clean` deletes the build dir before it, a target change found afterwards empties the build dir except `fr_gen`, and `INCOMPATIBLE_PROFILE` removes a build dir this run created.
- **Environment.** Native IDF, with the environment from `export.sh` cached per IDF commit. Docker is optional, for reproducibility checks.
- **No tree-hash cache.** `idf.py`, ninja and ccache always run, and an unchanged tree is a near no-op. `cache_hit` means the resulting `fw_id` matches the last one for `(source_dir, profile, build_type)` (fault builds compare with the last fault build). `deploy` then reports `already_current` per device.
- **Fault builds** ([03 §3.8](03-firmware.md)). `build_start {fault: 'health'}`: debug only (`release` is `INVALID_ARGS`), into `<profile>-debug-fault`, build_id `node/<profile>/debug-fault/<fw12>`. A checkout whose CLI writes no `sdkconfig.fault` fails `generate` with `BUILD_FAILED`.
- **Ingest** checks `fr_app_desc` against the build and sets the version label ([06 §6.8](06-identity-ota.md)).
- **Artifact list.** `artifact_list` is newest first; `fr artifacts ls` prints a table (BUILD, BUILT, SOURCE) with fault builds after all normal ones, marked in a FAULT column with a footnote (they never pass their health check, roll back after an OTA, and are used only when named with `--build`). An empty store prints a `fr build` hint.
- **Diagnostics.** GCC output and CMake's `CMake Error at <file>:<line> (<cmd>):` blocks (with their indented message; stdout and stderr each have a parser) go into `diagnostics[]`.
- **Locks.** `build:<sha1(source_dir)>:<app>` during dependency resolution, then `build:<sha1(source_dir)>:<app>:<profile>:<variant>` (the build type, or `debug-fault`). A global limit of ⌈cores/4⌉ builds.

## 8.7 Event bus and cursors

- **Topics** (MQTT-style, `+`/`#` wildcards):
  - `device/<id>/{presence,event/<inst>/<evt>,state/<inst>/<prop>,result,msg,log,ota}`
  - `port/<serial>/{attached,detached,log}`
  - `job/<id>/{state,progress,log}`
  - `hub/{status,warning}`
- **Cursors** are `c:<hub_run>.<seq>`.
  - `hub_run` increments and is fsynced at every hub start.
  - **One cursor space.** Log lines and events take their `seq` from one counter (`Seq`), so a cursor orders both and a wait since it sees either kind. `seq` is monotonic across runs: it starts after the largest seq either table holds.
  - **Minted cursors.** Every cursor an op hands out (the result envelope's `cursor`, `next_cursor`, `head`, `resume_cursor`) is minted: the hub records when it first handed each one out, for the newest 1,024 seqs. An older cursor is dated by the newest log line or event at or before it. Waits use that time to reject stale matches ([09 §9.2](09-agent-api.md)).
  - A `since` from an earlier run returns `HUB_RESTARTED` with `details.resume_cursor`; it is never silently re-based.
  - Every event carries `t_hub_us` and `replayed: bool`, which marks frames that were buffered during an outage (the node is synced and its device time is more than 2 s before arrival). `t_hub_us` is device time converted through the TIME offset, or the hub's receive time when it has no offset yet for the sender's current epoch.
- **Event types** ([09 §9.2](09-agent-api.md)):
  - capability EVENTs and STATEs as `<inst>.<member>` with decoded fields, or `port<p>.event<k>` / `port<p>.state<k>` with `{raw}` when nothing names the port; `node.boot` and `diag.mark` likewise. `late` flags an event older than the last of its instance. A STATE older than the mirror's is neither applied nor published;
  - `device.online {link, addr, fw_id_prefix, provisioned, ota_state}` (or `{link, recovered}` when a suspect device comes back), `device.suspect {silent_ms}`, `device.offline {reason}`, `device.link {link, up, remote | reason}`, `device.provisioned`;
  - `ota.job.state {job, parent, state, via, attempt, bytes, size, code?, message?, reason?, needs_serial_recovery?}` on every OTA child transition, DOWNLOADING also every 10 % ([06 §6.7](06-identity-ota.md)); `message` comes with `code` on FAILED and QUEUED, and `deploy` shows it as the device's error;
  - `hub.warning {code: udp_blocked, hint}`, `msg {topic, data, dst}`, `registry.drift`.
- **Storage.** `publish` runs in the receive tick: it takes the cursor, notifies subscribers synchronously and queues the row; rows are written to the `events` table in one transaction every 50 ms.
- **Delivery classes.**
  - `event`: never dropped. Per-client queue with backpressure; on overflow, send a `gap` notice and the client re-reads over REST.
  - `state`: last value cached, sent on subscribe.
  - `stream` (logs): may be coalesced or dropped under pressure, and never delays `event`.
- **Serialize once:** each message is serialized once and the same bytes go to every subscriber.
- **QoS isolation:** the SDK's `/app` sockets have their own send queue, separate from dashboard and agent sockets. A log flood cannot add latency to game input.

## 8.8 Persistence (`~/.fractonica/`)

| Item | Holds |
|---|---|
| `hub.db` → `devices` | device_id (PK = MAC), addr (NULL until provisioned; never reused for another device, kv `registry.addr_hwm`), alias (stored lower case, unique ignoring case) + alias_rev, net, board, profile, chip, tags, role, fw_id, provisioned, last_seen, last_epoch, created_at, provision record (what the last `fr_ident` write held; never the password) |
| `hub.db` → `networks` | `net_id` (random u16 in 1..65535, created with the record and kept), mode, ssid, bssid pin (optional), country, observed channel and BSSIDs (from HELLO), `hub_host` (= `scutil --get LocalHostName` + `.local`), hub id (6 random bytes, for M3 nonces), (M3) key references |
| `hub.db` → `bindings` | resolved bindings per source device (re-pushed on change) |
| `hub.db` → `ports_seen`, `builds`, `artifacts` | USB serial ↔ last path; manifests and blob references; `artifacts.fault` (the fault kind, NULL for a normal build) keeps fault builds out of implicit picks |
| `hub.db` → `ota_jobs` | one row per OTA child: `job_id`, `parent`, `device`, `state`, times, and the record `ota_status` answers (`json`). A hub start marks rows a stopped hub left unfinished `FAILED hub_restarted` |
| `hub.db` → `jobs` | durable, retained ≥ 24 h. On hub restart, `working` jobs become `failed: HUB_RESTARTED` |
| `hub.db` → `events`, `logs` | cursor-indexed rings in one cursor space (§8.7); retention configurable (7 days / 1M rows; kv `<table>.retention_days` and `<table>.retention_rows`). Retention counts cursors: each table keeps at most `rows` rows, and both together at most `rows` |
| `hub.db` → `kv` | settings, `hub_run`, `hub_epoch` (u16, +1 and fsynced at every start, skipping 0), `registry.addr_hwm`, `device_fw:<device>` (the `fw=` prefix from a device's boot banner, for frame names, §8.3) |
| `secrets.json` (0600) | Wi-Fi passwords, API token. **Never in SQLite, never in results or logs** |
| `tmp/ident/` (0700) | one directory per `fr_ident` render, removed after its flash; a hub start removes what a killed hub left ([06 §6.3](06-identity-ota.md)) |

## 8.9 Dashboard

| Area | Shows |
|---|---|
| Devices | An online/offline grid by alias, with board, firmware, RSSI, uptime and last event. A tile flashes on input. Actions: identify, rename, tags |
| Live | Event stream with filters (selector, types), pause, jump to a cursor |
| Device page | Capabilities rendered from `catalog.json` (command buttons, live properties); bindings; logs (xterm.js); crashes; OTA history |
| Ports | USB ports and who holds each one (hub, a lease with its PID, or an external app such as Chrome); the provision wizard: detect → Wi-Fi network (first time) → profile + alias → flash → join |
| Builds and OTA | Profiles, build, artifact list, deploy to a selector, per-device job progress |
| Network | Mode, channel, Wi-Fi settings, hub broadcast button, flood stats, latency panel (PING p50/p99 per link, event-loop delay, `udp_blocked`/LNP warnings) |
| Agents | Active leases, jobs started by agents, pending `prompt_human` requests ("press BOOT on pad-red-1"), (M2) pending destructive confirmations |

The dashboard uses the same WS and REST API as agents and never uses Web Serial.

## 8.10 Listeners and discovery

| Port | Bind | Serves |
|---|---|---|
| 7420/tcp | `127.0.0.1` and `::1` | REST, `/ws`, dashboard, `/app` (SDK), `/apps/<name>` (hosted games) |
| 7421/tcp+udp | `0.0.0.0` | node envelope links |
| 7422/tcp | `0.0.0.0` (`--node-host`, `--node-http-port`) | **node HTTP only** (plain `node:http`): `GET` and `HEAD /ota/<fw_id>.bin`, and `POST /node/v1/coredump/<device_id>` (501 until crash reports land). No control, dashboard or SDK routes |

- **7422 gate.** `/ota/<fw_id>.bin` answers 404 unless a Wi-Fi OTA child is OFFERED or DOWNLOADING that `fw_id` to the device whose live TCP session (`router.tcpAddress`) comes from the request's source IP: no credentials, and nothing for a host without a node link. Every other path is 404.
- **7422 ranges.** One range (`bytes=a-`, `a-b`, `-n`) answers 206 with Content-Range; a range outside the image, several ranges or another unit answer 416, so a node that asked for a tail never writes the head over its partial image. The app blob streams from the artifact store. Bytes served count as download progress when exactly one child matches ([06 §6.7](06-identity-ota.md)).
- **7422 failure.** A failed bind does not stop the hub: the `listening` log line carries `node_http_error`, `hub_status` warns (`ota.listen_error`), and Wi-Fi OTA children fail `no_http_listener` (not retried). Tests use port 0.
- **Opening up 7420.** `--listen-app 0.0.0.0` lets games on other devices reach `/app` (the SDK token is required). `--listen-api 0.0.0.0` exposes the control API on the LAN and requires the bearer token.
- **Hub address for nodes.** Nodes get `hub_host = <LocalHostName>.local` (here `dimas-3.local`) at provisioning. They resolve it by mDNS on every reconnect; macOS's own mDNSResponder answers it.
- **Service advert (C6).** `_fractonica._tcp` is advertised with SRV port 7421 and TXT `http=7422 api=7420`. The advert is retried every 30 s, since Local Network Privacy may deny it. Until then nodes use `hub_host` ([05 §5.12.5](05-network.md)).
- **Hosted apps (M1).**
  - `/apps/<name>/` serves the static files in `<repo>/web/<name>/dist/`, where `<repo>` is the checkout the `fr` shim runs from. `web/demo` is the M1 demo page.
  - Apps are built with Vite, which resolves `@fractonica/sdk` through the `@fractonica/source` condition (§8.12).
  - The hub injects `<script>window.__FRACTONICA__={token:"…"}</script>` into each served `index.html`.

## 8.11 macOS constraints (must handle)

| Constraint | Handling |
|---|---|
| **Local Network Privacy** (macOS 15+). Gated, and attributed to the app that launched the hub: outgoing TCP, any UDP send or connect, receiving UDP multicast/broadcast, every Bonjour register/browse/resolve, and `.local` lookups by the hub. **Not gated:** accepting TCP, receiving unicast UDP. Only tools run from Terminal or SSH are exempt. The first attempt can be denied while the prompt is still on screen | Every node link is node-initiated; the hub never needs to originate LAN traffic. Every 30 s the hub self-tests by connecting a UDP socket to the LAN gateway (no traffic sent) and reports `LNP_DENIED` in `hub_status.warnings` (the self-test comes in C6). `fr doctor` reports the hub's self-test and does not probe from its own process. To fix it, approve the "Claude would like to find devices on your local network" prompt once (or start the hub from Terminal.app) |
| **Application Firewall** (per app, not per port) | `fr doctor` checks `socketfilterfw` and tells you to allow the hub's `node` binary for inbound. Router-mode nodes surface it as `udp_blocked` ([05 §5.10](05-network.md)) |
| **VPN** (your default route currently goes through `utun4`) | `fr doctor` checks that the LAN subnet is routed via the Wi-Fi or Ethernet interface, not the tunnel. Full-tunnel VPNs that block LAN access break router mode |
| **Wi-Fi hub** (MacBook Pro, no Ethernet port) | Latency panel and T-LAT measure it; the M0 go/no-go decides on Ethernet (USB-C adapter), a lab AP, or gateway mode ([11 §11.2](11-roadmap.md)) |
| Sleep (lid close) | A child `caffeinate -i -w <hub pid>` (the `PreventUserIdleSystemSleep` assertion) while a node session is up; it exits by itself if the hub dies. The dashboard warns that closing the lid still sleeps the Mac. After a detected resume the hub reopens every open serial port (§8.3) |
| Docker has no USB | The hub runs natively; Docker is for builds only |
| `/dev/cu.*` paths change with the socket | Devices are keyed by MAC |
| Several Node installs (nvm 24.11, Homebrew 25.2 which is end-of-life, /usr/local 22.19) | `fr doctor --fix` pins an absolute Node ≥ 24.12 path into the `fr` shim (§8.12) |
| **Browser games** on public `https://` origins cannot open `ws://` (mixed content) and trigger Local Network Access prompts | Serve apps from the hub (`/apps/<name>`) or localhost; a `wss` option with a local CA comes later. The token goes in the `hello` message, never in the URL |
| **Localhost CSRF**: any web page can reach `127.0.0.1` | API and WS check `Origin` against an allowlist and require `application/json` for mutations. Browsers other than the dashboard need the per-install token |

## 8.12 Packaging

| Stage | How |
|---|---|
| **Now** | Run from the repo. `fr doctor --fix` writes `~/.local/bin/fr`, a shell shim (`exec <absolute Node ≥ 24.12> <repo>/packages/cli/src/main.ts "$@"`), and checks that `~/.local/bin` is on PATH |
| Later | `npx fractonica hub`. **Published packages** (`fractonica`, `@fractonica/sdk`, `@fractonica/protocol`) ship JS + `.d.ts` built with tsdown, and `exports` point only at `dist/`. Node refuses to type-strip files under `node_modules` |
| Later | Homebrew tap. Raspberry Pi needs a 64-bit OS (Node 24/26 has no armv7 builds, and `better-sqlite3` has no armv7 prebuild) |
| Deferred | Node single-executable build |

**Inside the repo,** sources are reached through a private export condition, `"@fractonica/source": "./src/index.ts"`. It is enabled with `node --conditions=@fractonica/source` in the repo scripts, `customConditions` in tsconfig, and `resolve.conditions` in the dashboard's Vite config. Never use the generic `development` condition: Vite and webpack turn it on by default in dev builds, which would break consumers of the published packages.
