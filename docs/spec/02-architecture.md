# 02 — System architecture

## 2.1 What we are building

A framework for prototyping networks of ESP32 devices. It has five parts:

1. **Node firmware** (ESP-IDF, C++). This is a generic runtime that hosts **capabilities**: typed interfaces such as `fr.button` or `fr.led`. Each capability is backed by a swappable **driver** from a hardware library. Nodes talk to each other over ESP-NOW and to the hub over Wi-Fi, or later through a USB gateway.
2. **Hub** (TypeScript on Node, runs on the Mac). It is the single owner of USB ports, the device registry, builds, flashing and OTA. It also routes messages between nodes and apps, and serves the dashboard and APIs.
3. **Dashboard** (web). A realtime view of devices, events and logs. It also handles flashing, provisioning and OTA.
4. **Agent interface**: one operation registry exposed as REST, WebSocket, a `fr` CLI with `--json`, and MCP. A Claude Code plugin ships the skills.
5. **Client SDK** (TS). A typed library, generated per project, that includes your device ids and aliases. Games and apps use it to receive input events and send commands.

```
         Games / web apps                       AI agents (Claude Code, MCP clients, scripts)
       @fractonica/sdk + generated                fr CLI (--json)   · MCP (stdio) · REST/WS
       devices.ts (ids, aliases, types)                         │
                │ WebSocket (fr-app/1)                           │
 ┌──────────────┴───────────────────────── HUB (Mac) ───────────┴──────────────────────────────┐
 │ registry (SQLite) · event bus · router/dedupe · job runner (build/flash/OTA) · OTA server    │
 │ serial port manager (sole owner of /dev/cu.*) · pytools sidecar (esptool API) · dashboard    │
 └───────┬─────────────────────────┬─────────────────────────────────────┬─────────────────────┘
         │ USB (flash, logs,       │ Wi-Fi LAN (router mode, M1)          │ USB gateway (gateway mode, M2)
         │  serial @fr1 link)      │  node→hub TCP + UDP, HTTP (OTA)      │  line-framed envelopes
         │                         │                                      │
      ┌──┴───┐   ESP-NOW (same channel as the router)                  ┌──┴──────┐
      │ node │◄────────────────────────────────────────────────────────►│ gateway │
      └──┬───┘◄───────► node ◄───────► node ◄───────► node ◄────────────►└─────────┘
         └─ unicast, broadcast, managed flood (hub broadcasts re-flooded by nodes)
```

## 2.2 Principles

| # | Principle | Consequence |
|---|---|---|
| P1 | **High-level logic never touches hardware.** | Apps, games, the dashboard, agents and on-node logic only see capabilities. Pins, buses and IDF peripheral APIs exist only in driver components and board manifests. |
| P2 | **One source of truth per concern, everything else generated.** | See §2.3. CI fails when anything generated is stale (`fr gen --check`). |
| P3 | **One envelope on every link.** | The same bytes travel over ESP-NOW, UDP/TCP and USB. The hub and SDK handle only one format ([05-network §5.6](05-network.md)). |
| P4 | **The hub owns hardware access on the host.** | Only the hub opens serial ports. Everything else (CLI, MCP, dashboard, `idf.py monitor`) goes through the hub, or borrows a port through an explicit lease. |
| P5 | **Agent-first.** | Every operation is deterministic, schema-validated and available as `--json` CLI, REST and MCP. Long work returns job ids. Every mutation returns a cursor so callers can wait for its effect without races ([09-agent-api](09-agent-api.md)). |
| P6 | **Latency first on the input path.** | No heap allocation and no blocking I/O between a GPIO edge and the app callback. Wi-Fi power save is off on mains-powered nodes. Every hop is measured ([05-network §5.14](05-network.md)). |
| P7 | **Freeze what cannot change in the field.** | The bootloader, partition table and rollback setting are fixed at first serial flash ([06-identity-ota §6.2](06-identity-ota.md)). |
| P8 | **Prototyping-grade security by default, a path to more.** | LAN-only and unencrypted in the PoC. The envelope reserves authenticated encryption, which is milestone M3 ([05-network §5.13](05-network.md)). |

## 2.3 Sources of truth

| Concern | Source of truth | Generated / derived outputs |
|---|---|---|
| Device wire protocol (envelope, classes, system payloads) | `schema/protocol.yaml` | C header and codec (`fr_proto`), TS codec (`@fractonica/protocol`), golden test vectors |
| Capabilities (button, led, display, …) | `schema/capabilities/*.cap.yaml` | C++ interfaces and dispatch, C++ and TS codecs, TS typed clients, JSON Schemas (MCP/REST), `catalog.json`, `.proto` (documentation and interop only) |
| Hardware facts | `hardware/boards/*.board.yaml` | per-board sdkconfig fragment, pin reservations, detection rules |
| Driver implementations | `hardware/drivers/<driver>/` (IDF component plus `driver.yaml`) | driver catalog for the dashboard and agents |
| Device configuration (which drivers back which capabilities on a board) | `firmware/profiles/*.profile.yaml` | generated composition root (`fr_board`), slot lock file, build manifest |
| Hub control-plane API | operation registry (Zod 4) in `packages/protocol` | REST + OpenAPI, WS event messages, CLI commands, MCP tools |
| Device identities and aliases | hub registry (SQLite) | identity NVS image written at flash time; the generated `devices.ts` for SDK projects |

The codegen tool is `fr gen`, in `packages/codegen`. It is TypeScript and needs no Python, buf or protoc ([07-capabilities-sdk §7.6](07-capabilities-sdk.md)).

## 2.4 Repository layout (monorepo, pnpm workspace + ESP-IDF tree)

```
fractonica/                       # this folder; unrelated experiments move to experiments/ (your call)
├─ docs/spec/ docs/research/       # this spec and the research it is built on
├─ schema/
│  ├─ protocol.yaml                # envelope, classes, system payloads
│  ├─ registry.yaml                # capability id allocations
│  ├─ capabilities/*.cap.yaml      # fr.node, fr.ota, fr.diag, fr.button, fr.led, … (single source of truth)
│  └─ vectors/                     # golden test vectors (envelope, payloads, serial lines)
├─ hardware/
│  ├─ boards/*.board.yaml          # verified pin facts per board (source-cited)
│  └─ drivers/<driver>/            # IDF component + driver.yaml (button_gpio, led_gpio, led_ws2812, …)
├─ firmware/
│  ├─ idf-version.lock             # pinned ESP-IDF tag + commit
│  ├─ components/                  # fr_core fr_id fr_serial fr_net fr_ota fr_diag fr_proto(gen) fr_caps(gen)
│  ├─ apps/node/  apps/gateway/    # thin IDF projects
│  ├─ profiles/*.profile.yaml      # board + capability→driver bindings (+ .slots.lock)
│  ├─ partitions/fr-{4,8,16}mb-v1.csv
│  └─ config/                      # sdkconfig.framework[.<target>], sdkconfig.build.{debug,release}, sdkconfig.local (git-ignored)
├─ packages/                       # TypeScript (pnpm workspace)
│  ├─ protocol/                    # Zod control-plane schemas + generated device codecs
│  ├─ host/                        # host toolchain shared by hub and CLI: paths, IDF env, pytools, `fr doctor`
│  ├─ codegen/                     # `fr gen`
│  ├─ hub/                         # hub server
│  ├─ dashboard/                   # React SPA, served by the hub
│  ├─ sdk/                         # @fractonica/sdk runtime (browser + Node)
│  └─ cli/                         # `fr` (incl. `fr mcp` stdio adapter)
├─ web/<name>/                     # hosted apps served at /apps/<name> (M1: web/demo)
├─ tools/pytools/                  # uv project: esptool 5.6 API sidecar, NVS image gen, panic decode
├─ plugin/                         # Claude Code plugin: skills, plugin.json (mcpServers), hooks, AGENTS.md
└─ tests/                          # e2e (hub-driven), HIL scenarios, virtual-fleet sim
```

## 2.5 Naming

| Thing | Name |
|---|---|
| Project | Fractonica (to be confirmed) |
| CLI | `fr` |
| Firmware component and C prefix | `fr_`; C++ namespace `fr` |
| npm scope | `@fractonica/*` |
| Capability names | `fr.<name>` (`fr.button`, `fr.led`) |
| Device id | 12 lowercase hex digits of the factory MAC (`1cdbd416ba34`) |
| Alias | RFC 1123 label `^[a-z]([a-z0-9-]{0,29}[a-z0-9])?$` (`pad-red-1`). `broadcast`, `all`, `online` and `offline` are reserved |
| Hub ports | 7420/tcp on loopback (API, WS, dashboard, SDK `/app`); 7421/tcp + udp on the LAN (node links); 7422/tcp on the LAN (node HTTP: OTA images, core dumps) |

## 2.6 Key flows

### Flow A — button press → game callback (router mode, M1)

1. The BOOT pin falls. The GPIO ISR writes the pin's input slot (level, timestamp) and notifies `fr_core` ([03 §3.4](03-firmware.md)).
2. `ButtonService` emits `boot.down` at once (leading-edge debounce, [07 §7.8](07-capabilities-sdk.md)).
3. If a binding exists for this event, the node first sends the bound command directly to its target over ESP-NOW ([07 §7.11](07-capabilities-sdk.md)).
4. Dispatch encodes `EVENT(port=1, kind=down)` into an envelope (URGENT) and sends it over UDP to the hub ([05 §5.10](05-network.md)).
5. The hub receives on its UDP socket, filters duplicates per [05 §5.8](05-network.md), decodes with the generated codec, and publishes `device/<id>/event/boot/down` on its bus in the same tick.
6. The `/app` WebSocket queue sends it to the subscribed SDK client. The SDK fires `device.on('boot.down')`.

Target: p50 ≤ 10 ms in router mode and ≤ 5 ms in gateway mode, measured, not assumed ([05 §5.14](05-network.md)).

### Flow B — hub broadcast with re-flood

1. The dashboard button calls `POST /api/v1/messages {to:"broadcast", topic:"start"}`.
2. The hub builds one MSG envelope (`src=0x0000`, `dst=0xFFFF`, `ttl=2`, `seq` from the hub BCAST space) and fans it out over every connected node link (TCP).
3. Each node that received it over TCP delivers it once and **seeds** an ESP-NOW broadcast after a random 1–16 ms delay. It cancels the seed if it has already heard 2 copies; the TCP copy counts as one.
4. Nodes whose IP link is slow or down get the ESP-NOW copy. The BCAST duplicate window makes delivery exactly once ([05 §5.9](05-network.md)).
5. Nodes react through bindings (for example `msg:start → status.blink`); apps see it as `msg`.

### Flow C — agent edit → build → OTA → verify

`fr deploy tag:poc --expect-event node.boot --json`, or the MCP `deploy` tool with `source_dir` = the agent's checkout:

1. Build from that checkout, once per distinct registry profile among the selected devices, as `debug` unless `--build-type release`. An unchanged tree is a near no-op, and devices already running the `fw_id` report `already_current`.
2. For each device, pick serial flashing if it is attached and idle, otherwise HTTP OTA (`--via` overrides this).
3. Wait until each device reports the new `fw_id`.
4. Assert the expected log line or event since the cursor taken before the deploy.

It returns one JSON result per device ([09-agent-api](09-agent-api.md)).

### Flow D — first flash (provisioning)

1. Plug in a board. The hub sees VID 0x303A / PID 0x1001 and reads the MAC from the USB serial number without opening the port.
2. The hub probes the chip with esptool (chip, flash size, PSRAM), picks a board, and allocates `addr` and `alias`.
3. It renders an identity NVS image from the registry plus the stored Wi-Fi network (set once with `fr net set`) and writes bootloader, partition table, otadata, app and identity in one `write_flash`.
4. The node boots, joins Wi-Fi, connects to the hub over TCP and says HELLO. The hub answers WELCOME + DIRECTORY and marks it online and provisioned ([06 §6.4](06-identity-ota.md)).
