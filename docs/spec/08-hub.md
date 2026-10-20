# 08 — Hub (host software)

## 8.1 Stack

| Concern | Choice | Why |
|---|---|---|
| Runtime | **Node.js** ≥ 24.12 now; Node 26 once Active LTS (2026-10-28). In the repo, TS runs directly via type stripping (`erasableSyntaxOnly`, no enums or namespaces). Published packages ship JS (§8.12) | Shares types with the dashboard, SDK and MCP; no build step in development |
| HTTP + WS | Fastify 5 + `@fastify/websocket` (ws 8) + `@fastify/static` | Mature; OpenAPI from Zod; Range support for OTA |
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
 │   ├─ LinePipeline       splits `@fr1:` frames (→ Router) from log lines (→ LogStore + bus)
 │   └─ Leases             hand-off to pytools jobs or external tools (TTL, holder pid, visible in UI)
 ├─ NodeLinks              TCP :7421 (node-initiated), UDP :7421 (inbound), serial ENV frames, gateway (M2)
 ├─ Router                 windows per 05 §5.8, hub sequence spaces, WELCOME/DIRECTORY/TIME, get_state, fan-out
 ├─ Codec                  generated TS envelope + capability codecs
 ├─ Bus                    in-process topic trie; publish synchronously in the receive tick
 ├─ Registry + Db          SQLite (WAL); writes queued to a worker_thread; main thread never blocks on disk
 ├─ JobRunner              build / flash / provision / ota / test jobs; locks; spawns children
 ├─ Listeners              :7420 API (loopback) · :7421 node links · :7422 node HTTP (OTA, coredumps)
 └─ SleepGuard             PreventUserIdleSystemSleep assertion while any node link is up (05 §5.11)
 children: pytools (flash/probe/nvs/panic) · idf.py builds (sanitized env)
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
- **Stop.** `fr hub stop` sends SIGTERM and waits up to 10 s for the process to exit, not only for `/health` to go away, so `restart` never races the old hub for the ports. On SIGTERM the hub cancels its remaining jobs (killing build process groups and sidecars), drops open connections including long-polls, and exits within 5 s.

## 8.3 Serial subsystem

- **Discovery.** Poll `SerialPort.list()` every 500 ms and diff by serial number. The key is the **USB serial number (= MAC)** for USJ boards; the path is just an attribute. Appear and disappear events are debounced, with timing tuned in spike S1.
- **Identification.** Passive first ([04 §4.5](04-boards.md)). An active esptool probe runs only on first contact, on explicit request, or during provisioning.
- **Line control.** Open with `hupcl` off, then set DTR and RTS false at once. Resets happen only through explicit actions. S1 checks whether node-serialport toggles them during `open()` on macOS; if it does, use the plan-B transport.
- **Busy ports.** On `EBUSY`, `lsof` finds the holder, and the error is `PORT_BUSY_EXTERNAL` with app name and PID (today: Chrome, PID 715).
- **Logs.**
  - Each line is stored with a global **cursor**, timestamp, level and tag (parsed from the `ESP_LOGx` prefix).
  - Panic blocks are decoded against the ELF of the running `fw_id` (`crash.detected`).
  - Logs live in a SQLite ring (7 days by default).
- **Download-mode detection.** "USB present and no HELLO or log for 5 s after a reset" sets `maybe_download_mode`, with a recovery hint.
- **Lease end.** When a lease ends, the port is reopened with DTR and RTS deasserted.

## 8.4 Node links and routing

| Link | Direction | Notes |
|---|---|---|
| TCP :7421 | node connects | `len u16` + envelope, `TCP_NODELAY`, `SO_KEEPALIVE`; one per node; carries all hub → node traffic |
| UDP :7421 | node → hub only | inputs, presence, ACK/RESULT ([05 §5.10](05-network.md)); the hub never sends UDP |
| Serial `@fr1` ENV | both | USB-attached nodes are full links |
| Gateway (M2) | both | `@fr1` GW_* frames; several gateways allowed |

The **Router** does the following:
- **Duplicate filtering** per [05 §5.8](05-network.md): replay windows on `(src, epoch, seq)` for ordinary frames, `last_seq` per `(src, port, kind)` for LATEST frames, and sessions reset on HELLO.
- **Hub-originated frames.** These get `src=0x0000`, the hub epoch (incremented and persisted at every start), and a seq from the right space: a per-destination UNICAST counter, the BCAST counter, or LATEST.
- **Handshake.** On HELLO it answers WELCOME, then DIRECTORY, then a TIME burst, then `get_state`. Only then does it publish `device.online`.
- **Liveness.** It echoes every UDP-received HEARTBEAT, DUP copies included, with an ACK over TCP; this is the `udp_ok` probe. If no echo went to a node within one heartbeat interval (for example, because UDP is blocked), it sends a hub PRESENCE/HEARTBEAT over TCP, so the node always has a keepalive. It tracks presence ([05 §5.11](05-network.md)).
- **Routing.** It keeps `addr → {links[], best}`. It fans broadcasts out over every link, forwards node → node frames when a node has no direct path, and repairs broadcasts for nodes whose watermark lags.
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
  - `nvs_gen {csv, size}` → bin.
  - `panic_decode {elf, text}`.
- **Plans** come from the artifact manifest ([06 §6.4](06-identity-ota.md)): `full`, `app` (always including otadata), `identity`, `recover`. Never `idf.py flash`, and never merged images padded to full flash size (they would wipe `fr_ident`).
- **Speed.** `write_flash --diff-with` (esptool ≥ 5.2) rewrites only changed sectors in the dev loop.

## 8.6 Builds

`BuildRunner` runs the contract in [03 §3.8](03-firmware.md):

- **Source.** Every build names an absolute `source_dir` (the agent's checkout or worktree). The hub never builds an implicit "own" tree.
- **Environment.** Native IDF, with the environment from `export.sh` cached per IDF commit. Docker is optional, for reproducibility checks.
- **No tree-hash cache.** `idf.py`, ninja and ccache always run, and an unchanged tree is a near no-op. `cache_hit` means the resulting `fw_id` matches the last one for `(source_dir, profile, build_type)`. `deploy` then reports `already_current` per device.
- **Diagnostics.** GCC output is parsed into `diagnostics[]`.
- **Locks.** `build:<sha1(source_dir)>:<app>` during dependency resolution, then `build:<sha1(source_dir)>:<app>:<profile>:<build_type>`. A global limit of ⌈cores/4⌉ builds.

## 8.7 Event bus and cursors

- **Topics** (MQTT-style, `+`/`#` wildcards):
  - `device/<id>/{presence,event/<inst>/<evt>,state/<inst>/<prop>,result,msg,log,ota}`
  - `port/<serial>/{attached,detached,log}`
  - `job/<id>/{state,progress,log}`
  - `hub/{status,warning}`
- **Cursors** are `c:<hub_run>.<seq>`.
  - `hub_run` increments and is fsynced at every hub start.
  - A `since` from an earlier run returns `HUB_RESTARTED` with `details.resume_cursor`; it is never silently re-based.
  - Every event carries `t_hub_us` and `replayed: bool`, which marks frames that were buffered during an outage. `t_hub_us` is device time converted through the TIME offset, or the hub's receive time when it has no offset yet for the sender's current epoch.
- **Delivery classes.**
  - `event`: never dropped. Per-client queue with backpressure; on overflow, send a `gap` notice and the client re-reads over REST.
  - `state`: last value cached, sent on subscribe.
  - `stream` (logs): may be coalesced or dropped under pressure, and never delays `event`.
- **Serialize once:** each message is serialized once and the same bytes go to every subscriber.
- **QoS isolation:** the SDK's `/app` sockets have their own send queue, separate from dashboard and agent sockets. A log flood cannot add latency to game input.

## 8.8 Persistence (`~/.fractonica/`)

| Item | Holds |
|---|---|
| `hub.db` → `devices` | device_id (PK = MAC), addr, alias + alias_rev, net, board, profile, tags, role, fw, last_seen, last_epoch, provision record |
| `hub.db` → `networks` | net id, mode, ssid, bssid pin (optional), country, observed channel and BSSIDs (from HELLO), `hub_host` (= `scutil --get LocalHostName` + `.local`), hub id (6 random bytes, for M3 nonces), (M3) key references |
| `hub.db` → `bindings` | resolved bindings per source device (re-pushed on change) |
| `hub.db` → `ports_seen`, `builds`, `artifacts` | USB serial ↔ last path; manifests and blob references |
| `hub.db` → `jobs` | durable, retained ≥ 24 h. On hub restart, `working` jobs become `failed: HUB_RESTARTED` |
| `hub.db` → `events`, `logs` | cursor-indexed rings; retention configurable (7 days / 1M rows) |
| `hub.db` → `kv` | settings, `hub_run`, hub epoch |
| `secrets.json` (0600) | Wi-Fi passwords, API token. **Never in SQLite, never in results or logs** |

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
| 7422/tcp | `0.0.0.0` | **node HTTP only**: `GET /ota/<fw_id>.bin` (Range; only for an `fw_id` with an outstanding OFFER to that node) and `POST /node/v1/coredump/<device_id>`. Requests are accepted only from source IPs currently bound to a registered node's 7421 link. No control, dashboard or SDK routes |

- **Opening up 7420.** `--listen-app 0.0.0.0` lets games on other devices reach `/app` (the SDK token is required). `--listen-api 0.0.0.0` exposes the control API on the LAN and requires the bearer token.
- **Hub address for nodes.** Nodes get `hub_host = <LocalHostName>.local` (here `dimas-3.local`) at provisioning. They resolve it by mDNS on every reconnect; macOS's own mDNSResponder answers it.
- **Service advert.** `_fractonica._tcp` is advertised with SRV port 7421 and TXT `http=7422 api=7420`. The advert is retried every 30 s, since Local Network Privacy may deny it.
- **Hosted apps (M1).**
  - `/apps/<name>/` serves the static files in `<repo>/web/<name>/dist/`, where `<repo>` is the checkout the `fr` shim runs from. `web/demo` is the M1 demo page.
  - Apps are built with Vite, which resolves `@fractonica/sdk` through the `@fractonica/source` condition (§8.12).
  - The hub injects `<script>window.__FRACTONICA__={token:"…"}</script>` into each served `index.html`.

## 8.11 macOS constraints (must handle)

| Constraint | Handling |
|---|---|
| **Local Network Privacy** (macOS 15+). Gated, and attributed to the app that launched the hub: outgoing TCP, any UDP send or connect, receiving UDP multicast/broadcast, every Bonjour register/browse/resolve, and `.local` lookups by the hub. **Not gated:** accepting TCP, receiving unicast UDP. Only tools run from Terminal or SSH are exempt. The first attempt can be denied while the prompt is still on screen | Every node link is node-initiated; the hub never needs to originate LAN traffic. Every 30 s the hub self-tests by connecting a UDP socket to the LAN gateway (no traffic sent) and reports `LNP_DENIED` in `hub_status.warnings`. `fr doctor` reports the hub's self-test and does not probe from its own process. To fix it, approve the "Claude would like to find devices on your local network" prompt once (or start the hub from Terminal.app) |
| **Application Firewall** (per app, not per port) | `fr doctor` checks `socketfilterfw` and tells you to allow the hub's `node` binary for inbound. Router-mode nodes surface it as `udp_blocked` ([05 §5.10](05-network.md)) |
| **VPN** (your default route currently goes through `utun4`) | `fr doctor` checks that the LAN subnet is routed via the Wi-Fi or Ethernet interface, not the tunnel. Full-tunnel VPNs that block LAN access break router mode |
| **Wi-Fi hub** (MacBook Pro, no Ethernet port) | Latency panel and T-LAT measure it; the M0 go/no-go decides on Ethernet (USB-C adapter), a lab AP, or gateway mode ([11 §11.2](11-roadmap.md)) |
| Sleep (lid close) | A `PreventUserIdleSystemSleep` assertion while nodes are linked; the dashboard warns that closing the lid still sleeps the Mac |
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
