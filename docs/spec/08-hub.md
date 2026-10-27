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
 │   ├─ Leases             hand-off to pytools jobs or external tools (`serial_lease`: TTL, holder pid, swept every 1 s; visible in UI)
 │   └─ PortHolders        lsof probe naming co-holders such as Chrome (§8.3)
 ├─ NodeLinks              TCP :7421 (node-initiated), UDP :7421 (inbound), serial ENV frames, gateway (M2)
 ├─ Router                 windows per 05 §5.8, hub sequence spaces, WELCOME/DIRECTORY/TIME, get_state, presence, commands, fan-out
 ├─ Codec                  generated TS envelope + capability codecs
 ├─ Bus + Events           publish synchronously in the receive tick (/app first, /ws second); events stored in the `events` ring (§8.7)
 ├─ Registry + Db          SQLite (WAL); writes queued to a worker_thread; main thread never blocks on disk
 ├─ JobRunner              build / flash / provision / ota / deploy / test / latency jobs; locks; spawns children
 ├─ OtaOrchestrator        per-device OTA jobs (06 §6.7) and the node HTTP listener :7422 (§8.10)
 ├─ AppServer · WsServer   /app (fr-app/1, 07 §7.9) and /ws (fr-ws/1, §8.7); the port, job and loop-delay feeds (since C6)
 ├─ StaticSite             dashboard at /, hosted apps at /apps/<name>/, OpenAPI, staleness check (§8.10, since C6)
 ├─ Lnp · Advert           Local Network self-test every 30 s; the `_fractonica._tcp` advert (§8.10–8.11, since C6)
 ├─ Prompts · LatencyProbe pending `prompt_human` requests (09 §9.4); `latency_probe` (05 §5.18) (since C6)
 ├─ Listeners              :7420 API (127.0.0.1 and ::1) · :7421 node links · :7422 node HTTP (OTA; core dumps later)
 └─ SleepGuard             child `caffeinate -i -w <hub pid>` while any node session is up or any OTA child is unfinished (05 §5.11)
 children: pytools (flash/probe/nvs/panic) · idf.py builds (sanitized env) · caffeinate · dns-sd (advert, under an sh watchdog) · test_run children (own process group)
 separate process: `fr mcp` (stdio MCP adapter → hub REST)
```

Rules:

1. **Only the hub opens serial ports.**
   - Flashing leases the port to a pytools child: the hub closes its handle, the child runs, and the hub reopens with backoff.
   - External tools (`idf.py monitor`, pytest-embedded, gdb) take an explicit lease (`fr serial lease <dev> -- <cmd…>` since C6, [09 §9.2](09-agent-api.md)). While the lease is held, the hub has no access to the port.
2. **Nothing on the input path awaits I/O.** Receive → decode → dedupe → publish → WS send runs synchronously in one tick. Persistence is enqueued.
3. **CPU-heavy work runs in child processes:** builds, hashing images over 1 MB, panic decoding.
4. **Event-loop delay** is monitored by the router's `LoopMonitor`: how late a 20 ms timer fires, summarised each second (p50, p99, max). Not `perf_hooks.monitorEventLoopDelay`, which counts its own resolution in every sample, so an idle loop would read about 10 ms. A 60 s p99 above 5 ms is a warning (§8.11). Since M2-C2 it also keeps a cumulative histogram of every probe's lateness since the router started (`hub_status.router.scale.loop`, §8.11): a per-second p99 of about 50 probes is that second's maximum, so only the histogram gives a p99 over a whole run, which the T2 gates read ([10 §10.5](10-testing.md) "T2 gates").

**Lifecycle**

- **Single instance.** The hub binds its loopback API address (`127.0.0.1:7420`) *before* opening `hub.db` or any port; the bound address is the mutex, and the kernel frees it when the process dies. Serial ports open only after the API listens. A second instance exits 0 with `already_running`; if anything that is not a hub holds the address, the start fails with exit 1.
- **Pidfile.** `~/.fractonica/hub.lock` holds the hub's pid for discovery only. It is written by tmp + rename and removed on exit. A pid read from it counts only while `ps` shows it running the hub's `packages/hub/src/main.ts`, so a pid reused after a crash never blocks a start and is never signalled.
- **Detached.** `fr hub start` detaches by default (`--foreground` keeps it in the terminal); the daemon uses `setsid`, logs to `~/.fractonica/hub.log`, and runs on the absolute Node path recorded by `fr doctor --fix`. It refuses Node < 24.12.
- **`fr mcp` auto-start** (on first use since C6). Launching `fr mcp` only checks the hub's health and notes it on stderr. The first tool call that finds nothing answering on `127.0.0.1:7420` runs `fr hub start` (detached) and waits up to 10 s, at most once per 30 s; concurrent calls share one start, and none happens when `FR_HUB` names another hub. Claude Code launches the plugin's server in every session, so an eager start would take every board's port and the Local Network attribution in sessions that never use Fractonica, and undo a deliberate `fr hub stop`. The hub is **never** a child of an MCP or agent process, so ending a Claude session never kills in-flight flash or OTA jobs.
- **Version check.** `hub_status` reports the version, `registry_hash`, Node path and version, `launched_by` (the app responsible for the process), and `lnp: allowed|denied|unknown`. The CLI and `fr mcp` refuse a hub whose REGISTRY_HASH differs from their source's with `HUB_VERSION_MISMATCH` (every op but `hub_status`; remediation `fr hub restart`, and for `fr mcp` a reconnect).
- **Start order** (since C6). API listen, the `[::1]` listener (§8.10), serial, events, the `/app` server (the bus's first listener), the `/ws` server (the second; it starts the port, job and loop-delay feeds), ring retention, router, bindings, OTA, then prompts, leases, the LNP self-test, the advert (of :7421, so after the router), the latency probe and the static site's staleness check.
- **Listening line.** Once up, the hub prints one JSON line `{event: 'listening', version, registry_hash, port, dashboard, node_port, node_udp_port, node_http_port, node_http_error?, serial: false?, v6_error?, run, hub_epoch, pid}`: the bound ports (a test hub may ask for 0), the dashboard's URL, and why the node HTTP or `[::1]` listener failed. `fr hub start` and `restart` report `dashboard`, for a hub they started or one already running.
- **Stop guard.** `fr hub stop|restart` refuses with `LOCKED` (retryable; `details.holder_job`, remediation `fr jobs wait <id>`) while any job is `queued` or `working`, unless `--force`. A hub whose pid is alive but does not answer `/health` is stopped only with `--force` (`HUB_UNREACHABLE` otherwise).
- **Stop.** `fr hub stop` sends SIGTERM and waits up to 10 s for the process to exit, not only for `/health` to go away, so `restart` never races the old hub for the ports. On SIGTERM the hub cancels its remaining jobs (killing build process groups and sidecars); stops the C6 parts (`/app` and `/ws` sockets close 1001, leases end `hub_stop`, the advert's dns-sd is killed, pending prompts are cancelled while the bus still runs); closes the API, dropping open connections including long-polls; sends a hub BYE on every serial node session and closes the node TCP connections ([05 §5.11](05-network.md)); and exits within 5 s.

## 8.3 Serial subsystem

- **Discovery.** Poll `SerialPort.list()` every 500 ms and diff by serial number. The key is the **USB serial number (= MAC)** for USJ boards; the path is just an attribute. A port missing from the list for 1.5 s is gone.
- **Brief absences.** An op that acts on a port (`flash`, `devices reset`, a lease) waits up to 5 s for a port that disappeared in the last 60 s before answering `NOT_FOUND`, because a chip reset can re-enumerate USB. An unknown selector fails at once.
- **Identification.** Passive first ([04 §4.5](04-boards.md)). An active esptool probe runs only on first contact, on explicit request, or during provisioning.
- **Line control.** Open with `hupcl` off, then set DTR and RTS false at once. Resets happen only through explicit actions. S1 checks whether node-serialport toggles them during `open()` on macOS; if it does, use the plan-B transport.
- **Busy ports and co-holders** (since C6). A holder probe runs `lsof -F pcn -- <the cu.* and tty.* names>` (3 s timeout) and drops the hub's own pid and its descendants (`ps`, 2 s); a probe that fails knows of no holder. It runs in `serial_lease`, before provision, flash and reset jobs (so a held port refuses them before any job, [09 §9.4](09-agent-api.md)), on a pytools busy error, and in `port_list` (cached 2 s), which names co-holders (`external: [{app, pid}]`) for `hub_status` and the Ports page too. The error is `PORT_BUSY_EXTERNAL` with `details.holders` and a remediation per holder: `/dev/cu.usbmodem2101 (pad-c3b) is held by Google Chrome (pid 715)`.
  - macOS lets a second open through while the hub holds a port (the hub sets no TIOCEXCL), so a Web Serial page opened after the hub shows as `external` on an `open` port. Chrome's own open sets TIOCEXCL, so Chrome cannot open a port the hub holds: lend it with `fr serial lease` first.
- **Logs.**
  - Each line is stored with a global **cursor**, timestamp, level and tag (parsed from the `ESP_LOGx` prefix), and a `kind`: `esp_log`, `boot` (ROM and bootloader lines), `frame` (a decoded `@fr1:` line), `diag` (a `#<id> {…}` response of the serial command channel) or `raw`.
  - **Frames are stored readable.** An `@fr1:` line is decoded with the generated TS serial codec and stored as `kind: frame`, for example `@fr1 EVENT boot.click {"count":1} (src=fffe seq=12 epoch=3 port=1)`; RESULT and ACK add `status=<name> req_seq=<n>`. Names come from the `fr_manifest` caps of the artifact whose `fw_id` starts with the boot banner's `fw=` (the device's prefix is kept in kv as `device_fw:<device>`, so names survive a hub restart). The system ports are named from the protocol constants, with or without a manifest, and a manifest entry cannot rename them (0 `node`, 240 `ota`, 241 `diag`: `@fr1 EVENT diag.mark {"token":"step1"} (…)`). An unknown port or member prints as `port=<p> kind=<k>` with hex fields; system classes print as `@fr1 <CLS> kind=<k> <hex>`, other serial types as `@fr1 <TYPE> <hex>`. A line that fails to decode is stored as `kind: raw` with `(decode error: <what> <code>)`.
  - **Repeats collapse.** Consecutive identical lines from one port are stored once, then as `(previous line repeated N more times)` at most once a second or when the text changes. A blank board's ROM loop prints ~400 identical lines a second; `ESP_LOG` lines carry a timestamp and never collapse. `@fr1:` lines never collapse either: identical lines are distinct envelopes.
  - **ENV frames to the Router.** After a line is stored, its decoded ENV envelope also goes to the Router as a frame of that port's serial link (§8.4).
  - **ROM banner split.** A reset cuts the line being printed, so `ESP-ROM:` can arrive glued to its tail. The hub stores the banner as its own line, so it still classifies as `boot`.
  - **Frame split** (since M1 step 7). A line with `@fr1:` after its start is split there: the text before it is stored as a log line, and the rest is stored and routed as a frame line. Without the split, a frame written onto an open log line never reaches the Router. Example from the dual-core S3: `I (437) wifi:wifi certification version: v7.0@fr1:AaEA…`. The node's writer now ends an open log line before a frame ([03 §3.4](03-firmware.md)); the split covers older firmware and any other writer. Test: `packages/hub/test/runtime.test.ts`.
  - Panic blocks are decoded against the ELF of the running `fw_id` (`crash.detected`).
  - **Lines over TCP** (since M2-C2, [design m2-c2](../design/m2-c2-t2-fleet.md) D21). The router decodes a LOG frame's `LOG.LINE` after its window check (a failure counts `log_bad`) and hands it to the log ingest (`logs/ingest.ts`): a bucket of 50 lines/s per device (*proposed*; the node caps itself at 20, excess counted `log_dropped`), then the store as port `tcp`, source `net`. Such a line is classified `esp_log` when it has the `ESP_LOGx` shape and is stored `raw` otherwise, never as `frame`, `boot` or `diag`, so TCP text such as `@fr1:…` or `#12 {…}` never reaches the serial link or a diag wait. It still teaches the store the banner's `fw=`, and repeats never collapse.
  - **One copy of each line across sources** (since M2-C2). A USB node with TCP sends each line both ways. Per device the store keeps, for each source (serial, net), a multiset of the recent `esp_log` texts not yet matched by the other source's copy (60 s, at most 8,192 unmatched; *proposed*). A copy is dropped (`logs_dup`) only by consuming an unmatched entry of the other source; a repeat from the same source is always stored. Both copies come from one `vprintf` buffer with one ms stamp, so exact text pairs them, the serial copy sanitized to UTF-8 as the node does. The age is the bound that matters: a TCP copy comes at most 30 s after its serial one ([05 §5.7](05-network.md)). Bootloader lines repeat byte for byte on every boot but never reach the net ring, so they never find a net entry to consume.
  - **`t_log_us`** (since M2-C2). A `tcp` line also stores its own time on the hub clock (`LogLine.t_log_us`, the clock of events' `t_hub_us`; null while the node's clock is unsynced): its esp_log ms, unwrapped against the node's clock at arrival (a u32 that wraps after 49.7 days), mapped through the session's TIME sync, less how far that boot's esp_log runs ahead of esp_timer (learnt per boot epoch as the most any line's mapped stamp lay past its arrival, at most 1 s), and never later than its arrival. `ts` stays the arrival. Waits use it (§8.7).
  - Logs live in a SQLite ring (7 days by default).
- **Download-mode detection.** "USB present and no HELLO or log for 5 s after a reset" sets `maybe_download_mode`, with a recovery hint.
- **Lease end.** When a lease ends (released, expired, holder gone, port gone or hub stop; [09 §9.2](09-agent-api.md)), the port is reopened with DTR and RTS deasserted. A granted lease first sends BYE and ends the port's serial session.
- **System resume.** A poll tick more than 10 s late means the Mac slept. The hub then closes and reopens every open port and logs `(hub: system resumed after <n> s; port reopened)`. At C2 a C6 stayed silent after a night's sleep on a handle that still looked open, and a hub-side reset recovered it ([04 §4.4](04-boards.md)).
- **Writing lines** (`diag_exec`, [09 §9.4](09-agent-api.md), and the Router's ENV frames). `writeLine` sends one line, LF appended, through the hub's open handle and refuses CR or LF inside it. It never drains: `tcdrain` would hold a libuv pool thread while the firmware does not read. A line is sent once its write callback fires, and concurrent lines on one handle queue in order. Only a handle whose write has been pending for more than 2 s refuses new lines, with `DEVICE_BUSY`, until that write completes (`TIMEOUT` for the stuck write itself).

## 8.4 Node links and routing

| Link | Direction | Notes |
|---|---|---|
| TCP :7421 | node connects | `len u16` + envelope, `TCP_NODELAY`, `SO_KEEPALIVE`; a length of 0 or over 2,048 closes the connection. One per node: a new HELLO closes the device's older connection, and one that sends no HELLO within 30 s is closed. Carries hub → node traffic for a node with a TCP session |
| UDP :7421 | node → hub only | inputs, presence, ACK/RESULT ([05 §5.10](05-network.md)); receive only, the hub never sends UDP |
| Serial `@fr1` ENV | both | USB-attached nodes are full links: incoming ENV lines are taken from the log store's frame decoder after the line is stored (§8.3), outgoing ones go through `writeLine`, one line at a time per port. A port that disappears ends its session at once (`device.link {link: serial, up: false, reason: 'usb port gone'}`) |
| Gateway (M2) | both | `@fr1` GW_* frames; several gateways allowed |

Unknown sources are accepted until their HELLO identifies them. A second hub for tests takes `--node-port`, `--node-host 127.0.0.1`, `--node-http-port` and `--no-serial` (it must not touch the USB ports the real hub holds); port 0 binds a free one, reported in the listening line (§8.2). Its advert is off (node port ≠ 7421 or node host ≠ 0.0.0.0; `--no-advert` turns it off for any hub, §8.10).

The **Router** does the following ([05 §5.8–5.12](05-network.md)):
- **Duplicate filtering** per [05 §5.8](05-network.md): replay windows on `(device, epoch, seq)` for ordinary frames (256 bits, keyed by device so unprovisioned nodes work), `last_seq` per `(device, port, kind)` for LATEST frames, and sessions reset on HELLO.
- **Hub-originated frames.** These get `src=0x0000`, the hub epoch (kv `hub_epoch`, incremented and fsynced at every start, skipping 0), `dst` = the node's HELLO `src`, `net` = its HELLO `net`, ttl 0x11, and a seq from the right space: one dense UNICAST counter per device, the BCAST counter, or LATEST, all from 1 each run.
- **Handshake.** On HELLO it upserts the registry (a first HELLO creates a `provisioned: false` row, [06 §6.3](06-identity-ota.md)) and answers WELCOME (`ucast_floor` = the WELCOME's own seq), then DIRECTORY (all provisioned devices, pages from 0), then a TIME burst (8 SYNC_REQ, min-RTT offset; again every 60 s), then `fr.node.describe` (BULK) when no artifact manifest names the HELLO's `fw_id_prefix` (cached per `descriptor_hash`; since M2-C2 asked once per hash however many HELLOs of that firmware handshake at once, the others waiting for it; when it ends on a live session with no descriptor, each waiter asks on its own session, [design m2-c2](../design/m2-c2-t2-fleet.md) D16), then `get_state`. Only then does it publish `device.online` (the node's first session) and `device.link {link, up: true}` (every session). It pushes `set_alias` when the HELLO's alias or rev differs from the registry's, and, once the handshake is done, brings the node's bindings back to the registry's rows ([07 §7.11](07-capabilities-sdk.md)). HELLOs from another net are dropped (`foreign_net`) once a network record exists; the router reads `net_id` again on each HELLO until one does, so `fr net set` on a fresh `hub.db` needs no restart.
- **Liveness.** It echoes every UDP-received HEARTBEAT, DUP copies included, with an ACK over TCP; this is the `udp_ok` probe. On every session (TCP and serial) on which nothing went out for one heartbeat interval, it sends a hub PRESENCE/HEARTBEAT, so the node always has a keepalive. It raises `udp_blocked` when a TCP session sees no UDP for 10 s (`hub.warning` and `hub_status`; never for an UNASSIGNED node, nor while TCP is silent too) and clears it when UDP returns. Each session keeps its `lastRx` (the node's UDP counts for its TCP session).
- **Presence** ([05 §5.11](05-network.md)). Suspect at 2.5 × the interval, with PINGs at 2.5 × and 3.0 ×; offline at 3.5 × (≥ 750 ms), which sends a hub BYE on a serial session and closes the TCP connection; offline `link_lost` when the last session closes. A node's BYE is offline at once with its reason; commands waiting on the device keep waiting, and a RESULT from it is still taken, for 250 ms (`byeGraceMs`; over UDP, its TCP connection kept open that long, or its USB line), since a RESULT sent before the BYE on one link can arrive after it on another. A HELLO with another epoch is offline `restarted` (or `epoch_regressed`, logged), then a new handshake.
- **Which session.** The hub sends to a device (commands, OTA frames, PINGs, ACKs, `get_state` and TIME resyncs) over its TCP session, else its serial session, and over the serial session while nothing came over TCP or UDP from a device that has both for more than 2 heartbeat intervals (`wifiSilentX10` 20); back to TCP as soon as Wi-Fi carries ([05 §5.10](05-network.md)). Hub broadcasts, their repairs and DIRECTORY sets go on every session instead (Routing, below). Presence counts frames from any link, and the node sends its heartbeats on every session, so a USB node whose Wi-Fi stalls stays online. `device_get`'s `router.links` lists the links best first.
- **Commands.** One unicast CMD per device ([05 §5.8](05-network.md)). ACK_REQ whenever the RESULT is awaited; `expire_at_us` (hub now + 1000 ms, in node time) once the node is synced; RESULTs match on `(device, req_seq)` with `req_epoch` = the hub epoch, from any link. Q1 frames from nodes get an ACK (EVENT, MSG; again on a DUP) or are answered (PING → PONG).
- **OTA frames** ([05 §5.7](05-network.md)). Those over UDP or off port 240 are dropped (`ota_dropped`); those with ACK_REQ are ACKed, duplicates too, and handed to the OTA orchestrator (`sendOta` sends the hub's). HELLO `ota_state` is kept per device (`device_get` `router.ota_state`, `device.online`, `wait_for_device {ota_state}`); a RESULT success for the running image's prefix sets it `valid`, since the node HELLOs only on a new session.
- **Publication.** Capability EVENTs and STATEs become events (§8.7, with the `late` and stale rules there); STATE also updates a per-device property mirror, which `device_get` shows. A HEARTBEAT whose `state_seq` is ahead of the mirror triggers a `get_state` resync ([05 §5.8](05-network.md)); `hub_status.router.counters` counts `late`, `resync` and `resync_failed` (since C6).
- **Routing** (since C5, [05 §5.9–5.10](05-network.md)). It keeps `addr → {links[], best}`.
  - **Hub broadcasts** (`message_send {to: "broadcast"}` and later ones): one BCAST seq each, `ttl` 2/2, `valid_ms` 2000, the same bytes to every welcomed session of each node, TCP and serial, a standby serial session included. The flood rate (10/s, burst 8) sends the excess over the hub links only with `ttl` 2/1 (`bcast_tcp_only`). `BroadcastSent.sessions` counts nodes.
  - **Watermark repair** on every HEARTBEAT: unexpired broadcasts above `max(bcast_watermark, bcast_base)` older than 250 ms go again with `ttl_remaining` 1 over every session of that node, at most twice per device, half a heartbeat apart.
  - **Node broadcasts** become events (`msg` for a MSG) and, when `ttl_remaining > 1`, are fanned out to every other node with `ttl_remaining` 1. Since M2-C2 (D18) the copy goes on every welcomed session of that node, TCP and serial, as hub broadcasts do (before: its best session only); a non-best serial session only while its queue holds fewer than 16 of 32 envelopes (*proposed*, `fanout_skipped_full`), and never to the fixture. `fanned_out` counts nodes.
  - **Framed once** (since M2-C2): a broadcast's or fan-out's bytes are framed once and the same Buffer is written to every endpoint.
  - **Forwarding.** Node → node frames that reach the hub are window-checked and forwarded unchanged over the target's session with `ttl_remaining − 1` (`forward_ttl`, `forward_no_route`; a DUP again, except within 20 ms); the hub never ACKs or answers them. The router does this itself; `RouterHooks.forward` and `nodeBroadcast` observe it afterwards.
  - **DIRECTORY** sets (every provisioned device, sorted by addr) to every welcomed session whenever they differ from the last ones sent: on `device.provisioned`, on a HELLO that moved an addr (the device's addr changed, or another device held it; before M2-C2 on every HELLO, O(N) each) and from a 1 s check. A new session still gets its own pages at its handshake. RESOLVE is answered for a provisioned addr only.
  - **LOG frames** (since M2-C2) go to the log ingest (§8.3); before, the router dropped them.
  - **Unicast MSG** (`message_send {to: <selector>}`): MSG on port 0 with ACK_REQ over the device's best session, answered by the node's ACK frame (2 s). A node's MSG to the hub with ACK_REQ is ACKed and published as a `msg` event.
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

- **Filters.** `/ws`, waits and the read ops filter with the `events_read`/`logs_read` grammar: a selector and comma-separated type globs ([09 §9.2](09-agent-api.md)), matched in linear time; `/app` subscribes by device and type glob ([07 §7.9](07-capabilities-sdk.md)). The MQTT-style topic tree of earlier drafts is not built.
- **Cursors** are `c:<hub_run>.<seq>`.
  - `hub_run` increments and is fsynced at every hub start.
  - **One cursor space.** Log lines and events take their `seq` from one counter (`Seq`), so a cursor orders both and a wait since it sees either kind. `seq` is monotonic across runs: it starts after the largest seq either table holds.
  - **Minted cursors.** Every cursor an op hands out (the result envelope's `cursor`, `next_cursor`, `head`, `resume_cursor`) is minted: the hub records when it first handed each one out, for the newest 1,024 seqs. An older cursor is dated by the newest log line or event at or before it. Waits use that time to reject stale matches ([09 §9.2](09-agent-api.md)). Since M2-C2 a log line that came over TCP can be up to 30 s older than its cursor (a backlog after a reconnect), so `wait_for_log` and `logs_assert` skip a `tcp` line whose `t_log_us` (§8.3) is more than 1 s before the time of their `since`. Until a live line of a boot has taught the ingest its esp_log lead, a backlog line's `t_log_us` reads late by that lead (0.15–0.57 s on the lab boards, 0 on host nodes), so the slack is then 1 s plus the lead.
  - A `since` from an earlier run returns `HUB_RESTARTED` with `details.resume_cursor`; it is never silently re-based.
  - Every event carries `t_hub_us` and `replayed: bool`, which marks frames that were buffered during an outage (the node is synced and its device time is more than 2 s before arrival). `t_hub_us` is device time converted through the TIME offset, or the hub's receive time when it has no offset yet for the sender's current epoch.
- **Hub µs** (`ring.ts nowUs`, the clock of every `t_hub_us`) are the wall clock at process start carried on by the monotonic clock. They drift from the wall clock by the crystal's error (about 20 ppm on the lab Mac, 1.7 s a day), so two processes started apart disagree. Clients therefore age `t_hub_us` by the hub's clock: the `/ws` hello and pong carry `t_hub_us`, as `/app`'s welcome and pong do. Timing across processes uses the monotonic clock (`latency_probe`'s `hub.mono_offset_us`, [05 §5.18](05-network.md)).
- **Event types** ([09 §9.2](09-agent-api.md); hub event types in `HUB_EVENT_TYPES`: 17 since C6, 20 since M2-C1):
  - capability EVENTs and STATEs as `<inst>.<member>` with decoded fields (`part: event|state`, `member`), or `port<p>.event<k>` / `port<p>.state<k>` with `{raw}` when nothing names the port; `node.boot` and `diag.mark` likewise. `late` flags an EVENT older than the last of its instance (router counter `late`). A STATE older than the mirror's value of its property is neither applied nor published (`stale`). Both compare within one epoch, and the u32 device times by RFC 1982, which flips 35.8 min apart, so an earlier time counts as older only while that previous frame reached the hub less than 30 min before (`ORDER_WINDOW_US`; [05 §5.8](05-network.md)). Before the C6 bench fix, a press after 45 quiet minutes came out `late`, and a new STATE could have frozen the mirror;
  - `device.online {link, addr, fw_id_prefix, provisioned, ota_state}` (or `{link, recovered}` when a suspect device comes back), `device.suspect {silent_ms}`, `device.offline {reason}`, `device.link {link, up, remote | reason}`, `device.provisioned`;
  - `ota.job.state {job, parent, state, via, attempt, bytes, size, code?, message?, reason?, needs_serial_recovery?}` on every OTA child transition, DOWNLOADING also every 10 % ([06 §6.7](06-identity-ota.md)); `message` comes with `code` on FAILED and QUEUED, and `deploy` shows it as the device's error;
  - `hub.warning {code: udp_blocked, hint}`, `{code: binding_unresolved}` (a stored binding that no longer resolves, once per row, [07 §7.11](07-capabilities-sdk.md)), `{code: lnp_denied, hint, launched_by, detail}` and `{code: loop_delay, p99_ms, hint}` (§8.11), and `registry.drift`;
  - `msg {topic, data, dst}` for every MSG a node sends to the hub or broadcasts, `data` parsed as UTF-8 JSON, else hex; `node.binding_fired` like any capability event;
  - (since C6) `port.attached {path, usb_serial, device_id?}`, `port.detached` and `port.state {path, state, holder?}`, from comparing `port_list` after each serial poll (so up to 500 ms late; the first poll publishes `port.attached` for every port; `device` and `alias` when the USB serial is a device id; a holder change alone publishes nothing), and `port.leased`, `port.released {…, reason, held_ms}` ([09 §9.2](09-agent-api.md));
  - (since C6) `job.state {job_id, kind, status, stage?, targets, origin?}` on a status or stage change (the terminal one too), never on progress;
  - (since C6) `hub.prompt {prompt_id, text, selector?, types[], expires_at}` and `hub.prompt_done {prompt_id, outcome: matched|timeout|cancelled}` (`prompt_human`, [09 §9.4](09-agent-api.md));
  - (since M2-C1) `op.called {op, client, instance?, command?, gesture?, layer?}`, one per device on every `command_send`, `input_simulate` and `binding_set`, published on that device; `client` is the call's `X-Fr-Client`, null without one;
  - (since M2-C1) `hil.edge {line, level, t_fix_us, t_hub_us, t_dut_us | null, sync, u_us | null, corrected?}` and `hil.frame {line, grb, lit, bits, t_fix_us, t_hub_us, t_dut_us, sync, u_us}`, the HIL fixture's readings, published on the DUT (`OpCalledFields`, `HilEdgeFields`, `HilFrameFields` in `packages/protocol/src/events.ts`; the rules in [09 §9.2](09-agent-api.md));
  - (since M2-C1) a property STATE that a `get_state` resync brought carries `resync: true` (`HubEventSchema`), since its time is the resync's, not the change's ([09 §9.2](09-agent-api.md)).
- **Storage.** `publish` runs in the receive tick: it takes the cursor, notifies subscribers synchronously and queues the row; rows are written to the `events` table in one transaction every 50 ms.
- **Send order** (since C6). The `/app` bridge is the bus's first listener and writes inside `publish()`; `/ws` is the second, in the same tick. Only logs and job progress are batched. Measured on a real hub: `/ws` delivers each event about 0.06 ms after `/app`, never before.
- **Delivery classes** (as `/ws` delivers them, below).
  - `event`: never dropped. Each client has its own queue. Past 4 MB buffered or 10,000 queued, the hub drops that client's queue and, once the socket has drained below 1 MB, sends one `gap {after}`; the client re-reads `events_read` since `after`.
  - `state`: a sub whose types match properties first gets the newest stored value of each property of each online or suspect device, as `ev` with `snapshot: true` (outside the seq order).
  - `stream` (logs): one `log` frame per client per 50 ms, held while the client catches up or is overflowed (never ahead of events), dropped while 1 MB is buffered; it never delays `event`. Job progress: at most 4 `job` frames per job and second, status and stage at once.
- **Serialize once:** each event is serialized once per protocol, and the same bytes go to every subscriber.
- **QoS isolation:** the SDK's `/app` sockets have their own send queue, separate from dashboard and agent sockets, so a log flood cannot add latency to game input. Per socket: written directly up to 256 KiB buffered, then queued, with `state` frames coalescing per property, 10,000 at most (else close 4429). The bridge maps hub events to frames by `part`/`member`; it sends `device.added` on provisioning or changed instances and `registry.drift` on a rename ([07 §7.9](07-capabilities-sdk.md)).

**`/ws` (`fr-ws/1`, since C6)** is the event socket of the dashboard and agents; commands go over REST, apps use `/app`. Frames: `packages/protocol/src/ws.ts`. `fr-ws/1` is a name, not a WebSocket subprotocol: `/` is not an RFC 7230 token, so `new WebSocket(url, 'fr-ws/1')` throws. Clients request none; the path and `hello.v` identify it. JSON text frames of at most 16 KiB, no permessage-deflate.

| Direction | Frame |
|---|---|
| hub → client | `{t: 'hello', v: 1, run, head, version, registry_hash, t_hub_us}` on open (`registry_hash` is the op registry's REGISTRY_HASH, unrelated to `/app`'s `registry_rev`) |
| client → hub | `{op: 'sub', id, events?: {types?, selector?, since?}, logs?: {selector?, level?, since?}, jobs?: true, ports?: true}`: a sub with an existing id replaces it; `{op: 'unsub', id}` |
| hub → client | `{t: 'ev', e, snapshot?}`: one event as `events_read` returns it |
| hub → client | `{t: 'log', l: [line…]}`: one 50 ms batch, oldest first |
| hub → client | `{t: 'job', job_id, kind, status, stage?, progress?}` |
| hub → client | `{t: 'gap', after}`; `{t: 'err', id?, code, message, details?}` |
| both | `{op: 'ping', n}` → `{t: 'pong', n, t_hub_us}` |

- **Delivery.** A client gets each event once (for the union of its subs), in seq order; frames carry no sub id. A `since` sub first gets the stored events after its cursor, a page per tick, while live ones wait in its queue and follow in order; since-subs share one catch-up. A `since` older than an event the client already got cannot be filled in order: `gap`. `logs` with `since` likewise. A `jobs` sub first gets the jobs still running; `ports: true` gets the `port.*` events.
- **Limits.** At most 16 subs per socket; `events.types` ≤ 1,024 characters. A selector that matches no device yet is accepted and re-resolved after `device.*` and `registry.*` events. `err` codes: `INVALID_ARGS`, `NOT_FOUND`, `HUB_RESTARTED` (a `since` from an earlier run, with `details.resume_cursor`). Close 1001 at hub stop.
- **Backpressure on replies.** `pong` and `err` (the binary-frame `err` too) are dropped, not sent, while more than 4 MB is buffered for the client, so a client that writes and never reads cannot grow the hub's memory; its own pong timeout then reconnects it. Open: the snapshot `ev` frames and active-job frames a `sub` triggers skip that check, so repeated subs with one id from a backed-up client are not bounded.
- **Hub clock.** `hello` and `pong` carry `t_hub_us` (`nowUs` at send; optional in the schema for older hubs, always sent), from which a client estimates hub time (the dashboard's, §8.9).
- **Browser clients** check frames by shape, not with Zod: the CSP has no `'unsafe-eval'` (§8.10), and Zod 4 probes `new Function`.

## 8.8 Persistence (`~/.fractonica/`)

| Item | Holds |
|---|---|
| `hub.db` → `devices` | device_id (PK = MAC), addr (NULL until provisioned; never reused for another device, kv `registry.addr_hwm`), alias (stored lower case, unique ignoring case) + alias_rev, net, board, profile, chip, tags, role, fw_id, provisioned, last_seen, last_epoch, created_at, provision record (what the last `fr_ident` write held; never the password) |
| `hub.db` → `networks` | `net_id` (random u16 in 1..65535, created with the record and kept), mode, ssid, bssid pin (optional), country, observed channel and BSSIDs (from HELLO), `hub_host` (= `scutil --get LocalHostName` + `.local`), hub id (6 random bytes, for M3 nonces), (M3) key references |
| `hub.db` → `bindings` | one row per source device and slot: `device_id, slot, from_spec, to_spec, target_id, args` (the JSON text given), `binding` (the encoded hex) and `pushed_at` (NULL while pending); index on `target_id`. Re-resolved and re-pushed on change ([07 §7.11](07-capabilities-sdk.md)). `latency_stats` samples are not stored (a restart forgets them) |
| `hub.db` → `ports_seen`, `builds`, `artifacts` | USB serial ↔ last path; manifests and blob references; `artifacts.fault` (the fault kind, NULL for a normal build) keeps fault builds out of implicit picks |
| `hub.db` → `ota_jobs` | one row per OTA child: `job_id`, `parent`, `device`, `state`, times, and the record `ota_status` answers (`json`). A hub start marks rows a stopped hub left unfinished `FAILED hub_restarted` |
| `hub.db` → `jobs` | durable, retained ≥ 24 h, with `origin` (`cli\|mcp\|dashboard\|app`, from the `X-Fr-Client` header; since C6, [09 §9.1](09-agent-api.md)). On hub restart, `working` jobs become `failed: HUB_RESTARTED` |
| `hub.db` → `events`, `logs` | cursor-indexed rings in one cursor space (§8.7); retention configurable (7 days / 1M rows; kv `<table>.retention_days` and `<table>.retention_rows`). Retention counts cursors: each table keeps at most `rows` rows, and both together at most `rows`. Since M2-C2 a `logs` row also has `t_log_us` (a `tcp` line's own time, §8.3; NULL otherwise), a column the log store adds in place to an older `hub.db` |
| `hub.db` → `kv` | settings, `hub_run`, `hub_epoch` (u16, +1 and fsynced at every start, skipping 0), `registry.addr_hwm`, `device_fw:<device>` (the `fw=` prefix from a device's boot banner, for frame names, §8.3) |
| `secrets.json` (0600) | Wi-Fi passwords, `app_token` (since C6), and later the `api_token`. **Never in SQLite, never in results or logs**; only `app_token` may reach the pages and the file named under Tokens, below |
| `latency/<job_id>.ndjson` | the raw samples of each `latency_probe` run (since C6, [05 §5.18](05-network.md)) |
| `tmp/ident/` (0700) | one directory per `fr_ident` render, removed after its flash; a hub start removes what a killed hub left ([06 §6.3](06-identity-ota.md)) |

**Tokens** (since C6). Two secrets with different reach:
- **`app_token`** opens `/app` only ([07 §7.9](07-capabilities-sdk.md)). 32 random bytes, base64url. The hub's `/app` server creates it at start when absent (a 0600 temp file renamed over `secrets.json`, other keys kept) and compares it in constant time; static serving only reads it (`token: null` while absent). It may appear in hub-served app pages (`window.__FRACTONICA__`, sent `no-store`, §8.10) and in `client_generate`'s `token.ts`. The CLI writes that file 0600 (narrowing an existing one first) and never prints it; `fr mcp` replaces a secret file's content with a note to run `fr codegen client` in a terminal.
- **`api_token`** (with `--listen-api`, deferred): the bearer token of the control API. It never appears in results, logs or pages.

## 8.9 Dashboard

Built in C6 (`packages/dashboard`, served at `/`, §8.10). TanStack Router with hash history.

| Page (route) | Shows |
|---|---|
| Devices `#/` | An online/offline grid by alias, with board, firmware, RSSI, uptime and last event. A tile flashes on input. Actions: identify (`node.identify {ms: 3000}`), rename (the alias checked as typed), tags |
| Device `#/device/<alias>` | Capabilities rendered from `catalog.json` with trait gating (traits `null` shows every member, [07 §7.4](07-capabilities-sdk.md)) and `inject` only when HELLO caps say `inject_enabled`; live properties, events, bindings, logs (xterm.js), `diag_exec info`/`stats`, OTA history; crashes show "not built" |
| Live `#/live` | Event stream (a virtual list) with type globs and a selector, pause, jump to a cursor |
| Ports `#/ports` | USB ports and who holds each one (the hub, a lease with its pid, or an external app such as Chrome); the provision wizard |
| Builds `#/builds` | Profiles, `build_start` from `hub_status.source_dir`, artifacts, `ota_deploy` previewed with `dry_run`, OTA state, jobs |
| Network `#/network` | Wi-Fi settings, the hub broadcast button (`message_send`, topic `ping`), LNP, advert, `udp_blocked`, flood counters, the `latency_stats` panel |
| Agents `#/agents` | Pending `prompt_human` requests ("press BOOT on pad-red-1"), active leases, jobs with origin `mcp`; (M2) pending destructive confirmations |

- **Data.** REST with `X-Fr-Client: dashboard`. The live store is seeded with the newest 200 events over REST, then one `/ws` sub `{events: {}, jobs: true}` after that cursor; pages filter client-side with the [09 §9.2](09-agent-api.md) glob grammar (the linear matcher of `@fractonica/protocol`). Events reach the store in 50 ms batches and invalidate their ops' queries every 300 ms. Logs go straight into xterm (only colour sequences pass), never into React state. `hub_status` is polled every 5 s; Devices refetch every 10 s and on `device.*`, `registry.*` and `port.*`. Since M2-C2 each tile renders from its `device_list` row alone: the row's `live {links, udp_blocked, rssi_ap, uptime_s, fw_id_prefix}` (this hub run's view, null before the device's first HELLO) replaces the `device_get` each tile ran every 10 s, so 30 tiles cost one `device_list` (the device page keeps `device_get`; [design m2-c2](../design/m2-c2-t2-fleet.md) D16); Ports every 2 s while open (an lsof holder change has no event).
- **`/ws` client** (`api/ws.ts`, DOM-free). Backoff 0.5, 1, 2, 4, 8 s. Within one hub run each sub is re-sent with `since` = the last delivered cursor; a new run's hello drops the cursors and refetches everything. A `gap` is backfilled with `events_read` for the union of its subs, delivered in order before the live events (over 5,000 → refetch everything). Duplicates by seq are dropped. A ping every 20 s; no pong within 10 s, or no hello within 5 s, closes the socket.
- **Live rules** (`state/live.ts`). A ring of 2,000 events; the mirror from `part: 'state'` events, snapshots included. A tile carries `data-flash` for 900 ms after a new capability EVENT at most 2 s old (not a snapshot or backfill). One toast per job end at most 10 s old, once per job (200 jobs kept). A prompt toast lasts until `hub.prompt_done` or expiry; an event wins over a `hub_status` answer for 8 s, and the Agents list is reconciled with `hub_status.prompts` every 5 s.
- **Hub clock** (`state/clock.ts`). The dashboard ages events by the hub's clock, not the browser's (hub µs drift about 20 ppm, §8.7). `HubClock` keeps the offset of hub µs to the browser's monotonic clock, from the smallest round trip of the last 16 hello/pong samples; it resets on a step over 25 ms or a new hub run, and uses `Date.now()` before any sample or with a hub that sends no `t_hub_us`. Selectors and actions take `Now {hub, wall}`:
  - `hub` ages every `t_hub_us` (tile flashes, job-end toasts, "last … ago") and drives the live store's own timers;
  - `wall` (the browser's `Date.now()`, the same clock as the hub's ISO times on a loopback hub) serves every ISO time: prompt and lease expiry and countdowns, `created_at`, `built_at`, `last_seen`.
  - Open: a dashboard on another machine (an SSH tunnel keeps Host `127.0.0.1:7420`) compares the hub's ISO times with that machine's wall clock; covering it needs the hub's wall clock in the hello and pong too (say `t_wall_ms`).
- **Provision wizard** (`state/wizard.ts`). Detect → network (`network_get`; on NOT_FOUND it asks once and calls `network_set`, the password write-only) → profile (`profile_list` plus "auto") and alias (checked as typed) → `device_provision {port, profile?, alias?, wait_s: 0}`, followed through `job` frames (stages `lease, probe, select, registry, render, flash, reset, hello, join`) with `job_get` every 1.5 s as fallback → join (`device.online` or `device_get`). `INVALID_ARGS` with candidate profiles offers them.
- **Banners.** The hub not answering; `/ws` reconnecting; a dashboard built against another REGISTRY_HASH (baked in at build, compared with `hello.registry_hash`); a stale build (§8.10); the lid warning; the hub's warnings. An op the hub lacks (`NOT_FOUND` "unknown op") shows "not available on this hub yet".
- **Headless hooks** for agents and gates: tile `[data-device="<alias>"][data-device-id]` and `[data-flash]`; Live rows `[data-type][data-device]`; the device page `[data-device-page]`.
- **Build.** Vite. The build fails on any Node builtin import (`fractonica:no-node-builtins`, also after bundling); the dashboard imports `@fractonica/protocol/browser` ([07 §7.9](07-capabilities-sdk.md)). About 580 kB of main JS plus a 331 kB xterm chunk.

The dashboard uses the same WS and REST API as agents and never uses Web Serial.

## 8.10 Listeners and discovery

| Port | Bind | Serves |
|---|---|---|
| 7420/tcp | `127.0.0.1`, and `::1` on the same port (since C6; `v6_error` in the listening line when it fails, and the hub stays on 127.0.0.1; the single-instance mutex is the 127.0.0.1 address) | REST, `GET /api/v1/openapi.json`, `/ws`, the dashboard at `/`, `/app` (SDK), `/apps/<name>/` (hosted games) |
| 7421/tcp+udp | `0.0.0.0` | node envelope links |
| 7422/tcp | `0.0.0.0` (`--node-host`, `--node-http-port`) | **node HTTP only** (plain `node:http`): `GET` and `HEAD /ota/<fw_id>.bin`, and `POST /node/v1/coredump/<device_id>` (501 until crash reports land). No control, dashboard or SDK routes |

- **7422 gate.** `/ota/<fw_id>.bin` answers 404 unless a Wi-Fi OTA child is OFFERED or DOWNLOADING that `fw_id` to the device whose live TCP session (`router.tcpAddress`) comes from the request's source IP: no credentials, and nothing for a host without a node link. Every other path is 404.
- **7422 ranges.** One range (`bytes=a-`, `a-b`, `-n`) answers 206 with Content-Range; a range outside the image, several ranges or another unit answer 416, so a node that asked for a tail never writes the head over its partial image. The app blob streams from the artifact store. Bytes served count as download progress when exactly one child matches ([06 §6.7](06-identity-ota.md)).
- **7422 failure.** A failed bind does not stop the hub: the `listening` log line carries `node_http_error`, `hub_status` warns (`ota.listen_error`), and Wi-Fi OTA children fail `no_http_listener` (not retried). Tests use port 0.

**Web guard on 7420** (since C6, `packages/hub/src/web/guard.ts`). The hub listens on loopback only, but a browser on the same Mac sends requests from whatever page it shows. Every request passes these checks before a route sees it; refusals are Result envelopes, and a refused WebSocket upgrade also gets `connection: close`. The CLI, MCP and agents send no Origin and a loopback Host, so they pass.

| Check | Rule | Else |
|---|---|---|
| Host | `127.0.0.1`, `localhost` or `[::1]` with the configured or bound port (a DNS-rebinding page arrives under a host name of its own) | 421 |
| Origin, when sent: `/api`, `/ws`, the dashboard | the hub's own origins (`http://` + an allowed Host) | 403 |
| Origin, when sent: `/app` | any loopback origin: 127.0.0.0/8, `localhost`, `*.localhost` or `[::1]`, any port, http or https; `/app` then checks `app_token` itself (§8.8) | 403 |
| Method on `/apps/*` | GET or HEAD only | 405 |
| Mutations | `Content-Type: application/json` (the `text/plain` parser is removed, so a cross-site form or a no-cors fetch cannot send one without a CORS preflight, which fails) | 415 |

- **HTML replies** get `X-Frame-Options: DENY` and a CSP, unless the route sets its own: `default-src 'self'`; `script-src 'self'` plus the sha256 of an app page's injected script; `connect-src 'self' ws://127.0.0.1:<port> ws://localhost:<port>` (CSP host-sources take no IPv6 literal, so a page served from `[::1]` reaches the hub through `'self'`); `style-src 'self' 'unsafe-inline'` (xterm sets inline styles); `img-src 'self' data:`; `object-src 'none'`; `base-uri 'none'`; `frame-ancestors 'none'`. There is no `'unsafe-eval'`.
- **WebSockets** (`/ws`, `/app`): frames of at most 16 KiB, no permessage-deflate.

**Static serving** (since C6, `web/static.ts` on `@fastify/static`, from the checkout the hub runs from):
- **`/`** serves `packages/dashboard/dist`: `index.html` with `no-cache`, Vite's hashed `/assets/*` immutable, single-level root files as they are, no dotfiles, and no SPA fallback (the dashboard routes by hash, so an unknown path is 404).
- **`/apps/<name>/`** serves `web/<name>/dist` (`web/demo` is the M1 demo page). Its `index.html` gets `<script>window.__FRACTONICA__={token:"…"}</script>` as the first tag in `<head>` (the `app_token`, §8.8), `no-store`, and a CSP allowing that script by its sha256. `/apps/<name>` redirects (302) to `/apps/<name>/`; names must match `[a-z0-9][a-z0-9_-]{0,63}`; a package without a `dist` answers 503 "not built".
- **Apps are built with Vite**, which resolves `@fractonica/sdk` through the `@fractonica/source` condition (§8.12).
- **Staleness.** `hub_status.dashboard {url, built, stale}`: `stale` compares `dist/.source-hash` with a hash of the package and the workspace packages it bundles, recomputed every 30 s off the request path. A dashboard that is not built or stale adds a `hub_status` warning and a dashboard banner. `fr doctor --fix` builds a missing or stale dashboard and every `web/*` (the package's Vite under the pinned Node, then `.source-hash`).

- **Opening up 7420** (deferred; not built in C6). `--listen-app 0.0.0.0` would let games on other devices reach `/app` (the `app_token` is required). `--listen-api 0.0.0.0` would expose the control API on the LAN and require the bearer `api_token` (§8.8).
- **Hub address for nodes.** Nodes get `hub_host = <LocalHostName>.local` (here `dimas-3.local`) at provisioning. They resolve it by mDNS on every reconnect; macOS's own mDNSResponder answers it.
- **Service advert** (since C6, `lan/advert.ts`). The hub runs `dns-sd -R "Fractonica <host>" _fractonica._tcp local 7421 http=7422 api=7420` (SRV port 7421, TXT `http=7422 api=7420`), which holds the registration while it runs.
  - **Watchdog.** dns-sd runs under an `sh` watchdog in its own process group that ends it once the hub's pid is gone, so a SIGKILLed hub leaves no advert of a dead hub; hub stop kills the group.
  - **States** (`hub_status.advert {state, name?, error?}`): "Name now registered and active" is `registered`; an exit, or no registration within 30 s, is `retrying`, with the next attempt 30 s later (Local Network Privacy may deny it); `off` with `--no-advert` or for a test hub (node port ≠ 7421 or node host ≠ 0.0.0.0).
  - Nodes query it last, after `hub_host`, the address they last resolved and `fr_ident` hub_ip ([05 §5.12.5](05-network.md)).

## 8.11 macOS constraints (must handle)

| Constraint | Handling |
|---|---|
| **Local Network Privacy** (macOS 15+). Gated, and attributed to the app that launched the hub: outgoing TCP, any UDP send or connect, receiving UDP multicast/broadcast, every Bonjour register/browse/resolve, and `.local` lookups by the hub. **Not gated:** accepting TCP, receiving unicast UDP. Only tools run from Terminal or SSH are exempt. The first attempt can be denied while the prompt is still on screen | Every node link is node-initiated; the hub never needs to originate LAN traffic. The hub's self-test (below) reports a denial as `LNP_DENIED`, and the advert retries every 30 s (§8.10). To fix it, approve the "Claude would like to find devices on your local network" prompt once (or start the hub from Terminal.app) |
| **Application Firewall** (per app, not per port) | `fr doctor` checks `socketfilterfw` and tells you to allow the hub's `node` binary for inbound. Router-mode nodes surface it as `udp_blocked` ([05 §5.10](05-network.md)) |
| **VPN** (your default route currently goes through `utun4`) | `fr doctor` checks that the LAN subnet is routed via the Wi-Fi or Ethernet interface, not the tunnel. Full-tunnel VPNs that block LAN access break router mode |
| **Wi-Fi hub** (MacBook Pro, no Ethernet port) | Latency panel and T-LAT measure it (C6, hub on Wi-Fi: primary p50 3.7–4.6 ms, p99 53–62 ms, published, not gated; [05 §5.18](05-network.md)); the M0 go/no-go decides on Ethernet (USB-C adapter), a lab AP, or gateway mode ([11 §11.2](11-roadmap.md)) |
| **Host load** (iOS simulators, builds). The hub's event loop stalls: on the C6 bench its p99 reached 93 ms to 1.1 s under load, against 15–36 ms on a quiet Mac, and stalls longer than T-LAT's 1 s match window failed a run | The loop-delay warning (below); `latency_probe` reports the loop delay of its run ([05 §5.18](05-network.md)). Run the latency gates on a quiet Mac. Since M2-C2 the T2 gates guard themselves: a preflight waits for a quiet Mac, and a run whose loop, fleet or runner lag is too high is inconclusive, not failed ([10 §10.5](10-testing.md) "T2 gates") |
| Sleep (lid close) | A child `caffeinate -i -w <hub pid>` (the `PreventUserIdleSystemSleep` assertion) while a node session is up; it exits by itself if the hub dies. The dashboard warns that closing the lid still sleeps the Mac. After a detected resume the hub reopens every open serial port (§8.3) |
| Docker has no USB | The hub runs natively; Docker is for builds only |
| `/dev/cu.*` paths change with the socket | Devices are keyed by MAC |
| Several Node installs (nvm 24.11, Homebrew 25.2 which is end-of-life, /usr/local 22.19) | `fr doctor --fix` pins an absolute Node ≥ 24.12 path into the `fr` shim (§8.12) |
| **Browser games** on public `https://` origins cannot open `ws://` (mixed content) and trigger Local Network Access prompts | Serve apps from the hub (`/apps/<name>`) or from localhost (`/app` takes any loopback origin, §8.10); a `wss` option with a local CA comes later. The token goes in the `hello` message, never in the URL |
| **Localhost CSRF**: any web page can reach `127.0.0.1` | The web guard (§8.10): Host allowlist (421), Origin per route (403), `application/json` for mutations (415), a CSP and `X-Frame-Options: DENY` on HTML. `/app` also needs the `app_token` (§8.8) |

**LNP self-test** (since C6, `lan/lnp.ts`). Every 30 s the hub `connect()`s a UDP socket (nothing is sent; `connect()` only asks the kernel for a route, which the Local Network policy answers) to the gateway slot of the first `en*` IPv4 subnet, as `fr doctor`'s LAN route check picks it, so a VPN's default route does not mislead it.
- `EHOSTUNREACH` or `EPERM` is `denied`; success is `allowed`; no `en*` address, `ENETUNREACH` or any other error is `unknown`.
- It fills `hub_status.lnp`, `lnp_checked_at` and `launched_by` (`__CFBundleIdentifier`, else `TERM_PROGRAM`), adds an `LNP_DENIED` line to `hub_status.warnings`, and publishes one `hub.warning {code: lnp_denied, hint, launched_by, detail}` per transition to denied.
- **`fr doctor`** reads the running hub's `hub_status` (3 s budget) for its LNP and advert checks and never probes from its own process, which macOS would attribute to another app; with no hub it adds an ok line "no hub answers". **`hub_doctor`** runs the same checks inside the hub (without `--fix`), plus LNP, advert and loop delay.

**Loop-delay warning** (since C6). The `LoopMonitor` (§8.2 rule 4) feeds a check every 5 s of the event loop's 60 s p99: each transition above 5 ms publishes `hub.warning {code: loop_delay, p99_ms, hint}`, and `hub_status` carries a warning while it stays above. Node frames wait that long before the hub handles them.

**Scale figures** (since M2-C2, [design m2-c2](../design/m2-c2-t2-fleet.md) D15–D16; `router/scale.ts`). Outputs only, so no REGISTRY_HASH change. Every counter and histogram belongs to one hub process and starts at zero there, so a reader takes differences between two reads of one process (the T2 runner sums them per process across hub restarts).
- **`hub_status.router.scale`**, beside `counters`:
  - counts: `hellos`, `handshakes_started`, `handshakes_completed`, `handshakes_restarted`, `handshakes_superseded`, `describe_sent`, `time_samples_lost`, `get_state_timeouts`, `directory_frames`, `directory_bytes`, `fanout_bytes`, `fanout_skipped_full`, `bcast_session_writes`, `repair_rounds`, `set_alias_pushes`, and the LOG ones (§8.3): `log_frames`, `log_bad`, `log_dropped`, `logs_dup`;
  - 1 s windows, each `{unit, last, peak, all}` (p50, p99 and max of the newest window with samples, the worst p99 of the last minute, and a cumulative histogram): `handshake_ms` (HELLO to `device.online`), `fanout_us`, `fanout_skew_us` and `bcast_skew_us` (first to last copy written, C9's multicast input), `receive_us`, `events_flush_ms`, `logs_flush_ms`;
  - `loop`: the LoopMonitor's cumulative histogram of every 20 ms probe's lateness (§8.2 rule 4): count, sum, max and log buckets from 0.25 ms to 8 s (`bounds`);
  - `max_unsent_bytes {tcp, serial}`.
- **`hub_status.ws`** (`/ws` `clients`, `frames`, `bytes`, `gaps`, `overflows`, `resolves`), **`rest`** (per op: `count`, `p99_ms`, `max_ms`) and **`process`** (`rss`, `cpu_ms`, `fds`).

## 8.12 Packaging

| Stage | How |
|---|---|
| **Now** | Run from the repo. `fr doctor --fix` writes `~/.local/bin/fr`, a shell shim (`exec <absolute Node ≥ 24.12> <repo>/packages/cli/src/main.ts "$@"`), checks that `~/.local/bin` is on PATH, and builds a missing or stale dashboard and `web/*` (§8.10). `@fractonica/sdk` is built with `tsc -p tsconfig.build.json` for now: its JS loads in plain Node, but TypeScript 7 keeps `.ts` specifiers in the emitted `.d.ts`, so the planned tsdown build must replace it before `file:` consumers rely on the types ([07 §7.9](07-capabilities-sdk.md)) |
| Later | `npx fractonica hub`. **Published packages** (`fractonica`, `@fractonica/sdk`, `@fractonica/protocol`) ship JS + `.d.ts` built with tsdown, and `exports` point only at `dist/`. Node refuses to type-strip files under `node_modules` |
| Later | Homebrew tap. Raspberry Pi needs a 64-bit OS (Node 24/26 has no armv7 builds, and `better-sqlite3` has no armv7 prebuild) |
| Deferred | Node single-executable build |

**Inside the repo,** sources are reached through a private export condition, `"@fractonica/source": "./src/index.ts"`. It is enabled with `node --conditions=@fractonica/source` in the repo scripts, `customConditions` in tsconfig, and `resolve.conditions` in the dashboard's Vite config. Never use the generic `development` condition: Vite and webpack turn it on by default in dev builds, which would break consumers of the published packages.
