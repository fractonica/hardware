# C3 hub link: implementation design

> **Folded into the spec on 2026-10-21:** the §9 decisions and the notes added during implementation now live in [docs/spec](../spec/README.md) (mainly 05, 06, 08 and 09; also 03, 04, 07, 10 and 11), and C3's open items for later checkpoints are listed in [11 §11.4](../spec/11-roadmap.md). This note is kept as the implementation record.

Checkpoint C3 ([11 §11.4](../spec/11-roadmap.md)): registry + provisioning; TCP/UDP HELLO/WELCOME/HEARTBEAT/BYE, presence, `command_send`, `wait_for_event`; the hub side of serial ENV CMDs and `fr.diag.exec`; plus the items carried from C2. Gates: **T-PRES**, **T-LED** ([10 §10.5](../spec/10-testing.md)).

The spec is the source of truth (05 §5.5–5.12 and §5.16–5.17, 06 §6.3–6.4, 07 §7.2–7.4, 08 §8.2–8.8 and §8.10–8.11, 09 §9.2–9.4 and §9.7). This note fixes what the parallel work streams share and decides what the spec leaves open; §9 lists the decisions to fold back.

## 1. Scope

In:
- **Node:** `fr_net` core (host-testable: sessions, windows, sequence spaces, response cache, Q1 retries on UDP, `udp_ok` probe, presence and heartbeats, event max age, BYE); link drivers `wifi_tcp_udp` and `serial_line`; Wi-Fi STA per 05 §5.3–5.4 (no ESP-NOW yet); mDNS resolution of `hub_host`; TIME sync answers; `fr.node` commands `identify`, `describe`, `reboot`, `set_alias`, `net_set`, `get_state`; `fr.diag.exec` over any link; `diag net drop_hub_link <s>` and `diag net udp_block <s>` (debug); identity from `fr_ident` (`fr_id` and `fr_net` namespaces), `fr_ovr` alias override, `fr_link` channel/BSSID.
- **Hub:** registry (`devices`), selectors (09 §9.2), `device_list|get|update|provision`, flash plans `full` (with `fr_ident` for registered devices), `identity`, `recover`; NodeLinks (TCP :7421, UDP :7421, serial ENV); Router (windows, hub sequence spaces, hub epoch, handshake WELCOME → DIRECTORY → TIME burst → `get_state` → online, heartbeat echo, hub keepalive, presence with PING, clock offsets); events store and bus; `events_read`, `wait_for_event`, `wait_for_device`, `command_send`, `input_simulate`; `diag_exec` over `fr.diag.exec` when the device has no open serial port; `udp_blocked` warning; SleepGuard.
- **Carried from C2:** `fr.node.describe` with the descriptor type; `Reply` capacity for bulk results; cJSON for the host suite on a fresh checkout.

Out: ESP-NOW, flooding, directory use on nodes, bindings (C5); OTA, health gate, HTTP :7422 (C4); WebSocket `/ws`, dashboard, SDK, `fr mcp` (C6); LOG-class frames (serial logs are enough in C3); the `_fractonica._tcp` advert and the LNP self-test (C6; nodes use `hub_host`).

## 2. Wire additions (foundation)

- **EXT TLVs** (05 §5.6) become supported in both runtimes: the header gains `ext: {type, value}[]` (TS, present exactly when the `EXT` flag is) / an `ExtView` (C++); unknown non-critical types are kept in wire order (decode then pack is byte-exact), an unknown critical type (≥ 0x80) is a decode error `unsupported_ext`, a known type with the wrong length is `bad_ext` (both appended to the error lists, so existing codes keep their values); a repeated type: the last wins. Known: `0x02 trace_id u32`, `0x03 valid_ms u16`, `0x04 expire_at_us u32`, `0x81 exec_at_us u32`. FRAG and SEC stay rejected. Golden vectors cover EXT (known, unknown non-critical, unknown critical).
- **Descriptor** (07 §7.4) as a protocol type: `Descriptor {frame_version u8 (1), fw_id_prefix bytes≤8, catalog_hash u32, profile string≤31, board string≤31, caps array<DescriptorCap>≤16}`, `DescriptorCap {port u8, cap_id u16, version u16 (major<<8|minor), name string≤31, traits bytes≤16}`. `fr.node.describe` gets `result: {descriptor: {id: 1, type: bytes, max: 1200}}` holding the encoded `Descriptor`. `descriptor_hash` (HELLO) = FNV-1a 32 over those bytes; `board_hash` = FNV-1a 32 over the board id.
- **`fr.diag.exec` result** stays `{json string≤1400}`; it is a BULK reply (TCP or serial only).
- **`Reply` capacity.** `fr::cap::Reply` takes a caller-provided buffer: 200 B for realtime dispatch, 1445 B (the 1470 B bulk MTU less the 18 B header and the 7 B RESULT prefix) when the request arrived on TCP or serial. A result that does not fit answers `FAILED` with no fields.

## 3. Node: `fr_net`

Component `firmware/components/fr_net`. `src/core/` has **no IDF includes** (host-built in `firmware/test/host`); `src/esp/` holds the links.

```cpp
namespace fr::net {
enum class LinkKind : uint8_t { serial = 0, tcp = 1, udp = 2 };   // espnow = 3 in C5
class Link {                                    // spec 10 §10.3, envelope-level
 public:
  virtual LinkKind kind() const = 0;
  virtual bool up() const = 0;                  // transport connected (TCP socket, USB host present, UDP socket bound)
  virtual Status send(std::span<const uint8_t> envelope) = 0;   // link adds framing; never blocks the core task
  virtual void drop(DropReason) {}              // Net lost the session (hub_silent | hub_bye | hub_restarted, for the log line): TCP closes and reconnects; others ignore it
  virtual void hold(bool) {}                    // drop_hub_link: while held a closed connection stays closed (an open one stays open); released, it reconnects at once
 protected: ~Link() = default;
};
struct HelloInfo { /* every PRESENCE.HELLO field except alias/alias_rev/channel/bssid, which Net reads live */ };
class Host {                                    // implemented by fr_core: what Net needs from the node
 public:
  virtual Status dispatch(uint8_t port, uint8_t cmd, std::span<const uint8_t> args, cap::Reply&) = 0;
  virtual void report_all() = 0;                // get_state (Net itself dispatches get_state as a port-0 CMD)
  virtual HelloInfo hello_info() = 0;
  virtual Identity identity() = 0;              // addr, net, alias, alias_rev, epoch
  virtual LinkInfo link_info() = 0;             // wifi_up, channel, bssid, rssi
  virtual Vitals vitals() = 0;                  // free_heap_kb, vbat_mv, ota_busy, low_batt (HEARTBEAT)
 protected: ~Host() = default;
};
class Net final : public cap::Sink {            // lives on the core task
 public:
  Net(Core& core, Host& host, const Config& cfg);
  void attach(Link& link);                      // up to one link per kind; the first takes Net's one timer
  void link_changed(LinkKind);                  // a link went up or down (core task)
  void receive(LinkKind from, std::span<const uint8_t> envelope);   // core task; copies already made
  void bye(uint8_t reason);                     // BYE on every session, best effort (reboot, ota); inside a request after its RESULT, on that request's link
  State state() const;                          // per link: session, udp_ok, time_synced, counters
  void reset_stats();                           // diag `stats reset`
  void drop_hub_link(uint32_t s);               // debug hooks (FR_TEST_HOOKS), effective after the current RESULT
  void udp_block(uint32_t s);
  // cap::Sink: event()/property() from capabilities
};
}
```

- **Sessions.** One per link kind that the hub can answer on: `serial` and `tcp` (UDP rides the TCP session). On link up the node sends HELLO on that link (Q1, `hb_interval_ms` = the cadence Net keeps), every 1 s until WELCOME. WELCOME resets the node's windows for hub frames (`ucast_floor`, `bcast_base`), sets `hub_link`, and starts heartbeats (one follows every WELCOME at once, which probes UDP); a WELCOME with a new hub epoch ends the other link's session from the old run. After the first WELCOME of a boot Net itself sends `fr.node.boot`. A session is lost after 3.5 heartbeat intervals with nothing from the hub on that link (05 §5.11), or on a hub BYE, which ends every session of that hub run (the hub sends it over USB when it times the node out or stops, and closes TCP, whose close may never reach the node); Net calls `Link::drop(reason)` (TCP: closed and reconnected with backoff 0.25 → 5 s) and HELLOs again. A standby serial session (TCP has one) is never timed out: the hub owes it nothing, and its keepalive clock starts when the TCP session ends.
- **Path to the hub** (05 §5.10, router mode). With a TCP session: HEARTBEAT, PONG, ACK, RESULT, URGENT EVENT and LATEST STATE go over UDP once `udp_ok`; before that, HEARTBEAT, URGENT and Q1 frames go over UDP **and** TCP (same bytes) and LATEST over TCP. Everything else goes over TCP, and so does anything larger than 250 B. An UNASSIGNED node (0xFFFE) never uses UDP (05 §5.5); a UDP send the socket refuses falls back to TCP. A STATE sent over UDP gets its second copy 20 ms later (double send). Without a TCP session but with a serial session, everything goes over serial. With neither, events are dropped and counted (LATEST properties are resent by `get_state` on the next WELCOME; `state_seq` still advances, so the hub resyncs).
- **Q1** (05 §5.8): CMD `reliable`, EVENT `realtime`/`normal` and unicast MSG carry ACK_REQ. Q1 frames sent over UDP are retried (20 ms ×2 backoff ±25 %, 4 attempts, same seq) until the hub's ACK (or, for RESULT, nothing: RESULT is the response); over TCP or serial they are not retried and count as failed after `FR_TCP_DELIVERY_MS` or on connection loss. A full outbox (8) evicts its oldest entry. Q1 EVENTs older than `FR_EVENT_MAX_AGE_MS` at send time are dropped and counted (`node.boot` exempt). The node answers a CMD with a RESULT only when it is unicast with ACK_REQ (a fast CMD gets none); broadcasts are dispatched on port 0 only and never answered.
- **`udp_ok`.** True when a hub ACK echoing a UDP-sent HEARTBEAT arrived within 3 × the interval. Cleared early by a hub PING (the hub has not heard the node for 2.5 intervals, so the PONG takes TCP) and by two hub HEARTBEATs on TCP with no echo between them (only TCP's count: a standby serial session gets a keepalive every interval whatever UDP does). Whenever it is cleared (lapse, PING, hub keepalives, UDP or TCP down), a heartbeat goes at once over TCP and UDP, and every waiting Q1 frame that went over UDP alone and is not stale gets a TCP copy of the same bytes (TCP delivery deadline from now; its UDP retries go on).
- **Hub frames.** Node windows per (`0x0000`, UNICAST) and (`0x0000`, BCAST), 128 bits; LATEST `last_seq` per (port, kind). Frames from another hub epoch, before a session, over UDP or from a source other than 0x0000 are dropped, and a provisioned node also drops other nets. DUP of a request → the cached response from the **response cache** (RESULTs only: 8 entries of ≤ 250 B keyed `(src, epoch, req_seq)`, byte-identical, plus one shared bulk slot; a DUP of an evicted request is dropped, never run twice; DUP PING and SYNC_REQ are dropped); a DUP Q1 EVENT/MSG gets a fresh ACK; OLD → dropped. CMDs to a port go to `Host::dispatch`; port-0 and port-241 dispatch to the system capabilities. `expire_at_us` is honoured once `time_synced` (else ignored); `exec_at_us` → RESULT `LATE`/scheduled per 05 §5.6 (C3 answers `UNSUPPORTED` for `exec_at`; it is used from T-LAT on).
- **TIME** (05 §5.12.4). `SYNC_REQ {t1}` → `SYNC_RES {t1, t2, t3}` (t2 when `Net::receive` ran on the core task, t3 send, node `esp_timer` µs) on the link the request came on, since the hub measures that link; the first answered request on a session sets that link's `time_synced`, and a new WELCOME clears it.
- **HEARTBEAT** every interval ±10 % with the 05 §5.7 fields; `state_seq` = last STATE seq sent to the hub.
- **Debug hooks** (`FR_TEST_HOOKS`): `net drop_hub_link <s>` (after its RESULT, drop all envelopes on TCP, UDP and serial ENV both ways for s seconds; logs and diag continue; no reconnect: `Link::hold`, so a connection the hub closes meanwhile stays closed, with no resolve or connect, and reconnects at once when the hook ends) and `net udp_block <s>` (send nothing over UDP for s seconds; T-PRES).

**Links (`src/esp/`).**
- **Wi-Fi** (05 §5.3–5.4): STA, `WIFI_PS_NONE`, country from `fr_ident` if set; first connect by SSID (or `fr_ident` BSSID), then persist channel + BSSID in `nvs:fr_link` and reconnect with the pinned BSSID after a channel-C scan; a pin whose BSSID differs from the one `fr_ident` names (left from before a reprovision) is not used. An all-channel sweep after an abandoned pin sets HEARTBEAT `swept` until a HEARTBEAT carrying it has gone out (once per sweep). Credentials: `fr_ident` `fr_net` namespace; `net_set` writes an override to `nvs:fr_net2`, applied 300 ms after its RESULT and reverted after 60 s if it fails to connect (once it joins it stays; a reprovision, i.e. a new `prov_ts`, drops it); an UNASSIGNED node uses `CONFIG_FR_DEV_WIFI_SSID/PASS` (empty by default; set in the git-ignored `sdkconfig.local`).
- **Hub address:** `hub_host` resolved through `espressif/mdns` (pinned exactly) on every connect attempt for `.local` names, else DNS or an IPv4 literal; then the last address that worked, then `hub_ip` from `fr_ident`.
- **TCP:** non-blocking socket to `hub_host:7421`, `TCP_NODELAY`, `SO_KEEPALIVE` (idle 5 s, interval 1 s, count 3), framing `len u16 LE | envelope`, a bounded TX ring (8 KB, a power of two so ring positions stay continuous across the 32-bit byte counters' wrap; drop + count). Every close of an established connection logs one WARN line, `hub: TCP closed after <ms> ms: <reason>` (the hub closed it; keepalive or retransmit timeout; socket error; bad frame length; session lost, with the `DropReason`; Wi-Fi lost, with the disconnect reason), and counts it in diag `stats` (09 §9.7). **UDP:** one datagram per envelope to `hub_host:7421`.
- **Serial:** ENV frames through `fr_serial` (as in C2), now a session-bearing link.

**Identity (`fr_id`).** Reads `fr_ident` (`fr_id` + `fr_net` namespaces, 06 §6.3), `fr_ovr` (alias + rev; highest `alias_rev` wins), `fr_link`. `set_alias {alias, rev}` writes `fr_ovr`. The boot epoch rule stays.

**`fr.node` commands:** `identify {ms}` blinks the first `fr.led` instance (or logs if none); `describe` returns the descriptor; `reboot {bootloader}` answers, then sends BYE `reboot` (`maintenance` for the bootloader), then restarts: Net sends a BYE asked for inside a request after that request's RESULT and on the same link (TCP or serial, never UDP or the other session, where the BYE could overtake it), because the hub takes a node offline at its BYE and fails what it still waits for; a BYE outside a request, or one whose request gets no RESULT, goes on every session; `set_alias`; `net_set` (override, 60 s revert); `get_state` → `report_all`. `bind_*`/`set_groups` answer `UNSUPPORTED` (C5/M2).

## 4. Hub

Module layout (new files, so streams do not collide): `packages/hub/src/registry/*` (stream H1), `packages/hub/src/links/*`, `packages/hub/src/router/*`, `packages/hub/src/events/*` (stream H2). Op definitions: `packages/protocol/src/ops/registry.ts` (H1) and `packages/protocol/src/ops/links.ts` (H2), spread into `OPS`; handlers `packages/hub/src/registry/ops.ts` and `packages/hub/src/router/ops.ts`, spread into `HANDLERS`. The foundation creates these files empty and wires them in.

**Shared interfaces** (`packages/hub/src/context.ts`, foundation; `HubContext` gains `registry`, `router`, `events`, `seq`):

```ts
interface Seq { next(): number; head(): number }        // one cursor space for logs and events
interface Device { device_id: string; addr: number | null; alias: string; alias_rev: number; net: number | null;
  board: string | null; profile: string | null; chip: string | null; tags: string[]; role: 'node' | 'gateway';
  fw_id: string | null; provisioned: boolean; last_seen: string | null; last_epoch: number | null; created_at: string }
interface Registry {
  get(deviceId: string): Device | null; byAddr(addr: number): Device | null; byAlias(alias: string): Device | null;
  list(): Device[]; resolve(selector: string, presence: (id: string) => Presence): Device[];   // 09 §9.2 grammar
  touchHello(deviceId: string, hello: HelloSeen): Device;   // creates an unprovisioned row on first contact
  update(deviceId: string, patch: Partial<Pick<Device, 'alias' | 'tags'>>): Device;   // alias change bumps alias_rev
}
type Presence = 'online' | 'suspect' | 'offline' | 'unknown';
interface HubEvent { cursor: string; seq: number; type: string; device?: string; alias?: string; t_hub_us: number;
  t_dev_us?: number; epoch?: number; fields?: Record<string, unknown>; late?: boolean; replayed?: boolean }
interface Events {
  publish(e: Omit<HubEvent, 'cursor' | 'seq'>): HubEvent;   // synchronous: allocates the cursor, notifies, enqueues persistence
  subscribe(fn: (e: HubEvent) => void): () => void;
  query(q: { afterSeq?: number; types?: string[]; devices?: string[] | null; limit: number }): HubEvent[];
}
interface Router {
  presence(deviceId: string): Presence;
  online(): string[];
  sendCommand(deviceId: string, port: number, cmdId: number, args: Uint8Array,
              opts: { ack: 'none' | 'result'; timeoutMs: number; duplicate?: boolean; bulk?: boolean }):
              Promise<{ status: number; fields: Uint8Array; rtt_ms: number; link: string }>;
  pushAlias(deviceId: string): void;                       // set_alias if online (rename)
}
```

- **Tables** (foundation adds the DDL): `devices` (columns as `Device`, `tags` JSON, `provision` JSON), `events (seq PK, run, ts_us, t_hub_us, type, device, json)` with the same retention as logs. `networks` gains `net_id` (random u16 ≠ 0, created with the record) and `hub_host` (`scutil --get LocalHostName` + `.local`). kv `hub_epoch` (u16, +1 at every start).
- **Registry (H1).** `addr` allocated from 0x0001, never reused for another device (kv `registry.addr_hwm`, raised by provisioning and by a HELLO on this hub's net, so the addr of a HELLO-only row is never handed out again); `alias` default `<profile>-<last 6 hex>` (for example `c6-pad-d55e64`), RFC 1123, ≤ 31, stored lower case, unique ignoring case, not a reserved name (03 §3.6, plus `all`, `offline` and anything shaped like a 12-hex device id); renames bump `alias_rev`. A device seen only through HELLO is `provisioned: false` with `addr: null`, aliased by its HELLO alias when valid and free, else `<chip>-<last 6 hex>` (provisioning replaces that made-up alias, and the firmware's UNASSIGNED placeholder `new-<last 6 hex>` while its `alias_rev` is 0, never one a person chose). Selectors (09 §9.2): positive terms of one kind are alternatives, different kinds narrow each other, `!` terms are removed last; a name that matches nothing is `NOT_FOUND`.
- **Provisioning (H1)** per 06 §6.4: `device_provision {port, profile?, build?, alias?, wait_s}` (job of kind `provision`; CLI `fr devices provision --port <p> [--profile] [--alias]`): lease → `probe` (refuse secure boot / flash encryption) → artifact (`--build`, `--profile`, the registry's profile, or the only profile built for the probed chip; the probe's chip and flash size must match) → registry upsert (`epoch_floor = last_epoch + 1`, after the artifact so a missing one costs no address) → network record required (`ENV_MISSING`, hint `fr net set`) → render `fr_ident.bin` (a fresh `prov_ts` every time) with pytools `nvs_gen` in its own 0700 dir under `FR_HOME/tmp/ident` (the CSV deleted as soon as `nvs_gen` returns, the dir after the flash or by an exit hook; a hub start, holding `hub.lock`, removes what a killed hub left there and this user's `fr-ident-*` dirs older than 10 min in the system temp dir, where older hubs rendered) → one `write_flash` (full plan + `fr_ident`) → `device.provisioned` → hub reset → wait for the serial HELLO (≤ 10 s; the router's `device.online` or `device.link {up}` with `link: serial`, or the HELLO frame in the log store; none is `TIMEOUT` with `details.flashed: true`) → wait for the TCP join (≤ 30 s; the same events with `link: tcp`, since a node already online over USB gets `device.link`, not a second `device.online`; reported, not fatal: `wifi: "not_joined"`). The password never appears in logs, job logs or results.
- **Flash plans (H1)**: `full` writes `fr_ident` from the registry for a provisioned device and erases it for an unknown one (C1 behaviour); `identity` writes only `fr_ident`; `recover` = `full` for a provisioned device that lost its flash. The job decides again once it holds the port and device locks (a provision queued ahead of it may have registered the device meanwhile); the request-time decision only serves dry runs and early validation. `flash_start` accepts `device` (selector, one device) or `port`.
- **NodeLinks (H2).** TCP server `0.0.0.0:7421` (`TCP_NODELAY`, keepalive, `len u16 LE` framing, a length of 0 or over 2048 closes the connection, 1 connection per device: a new HELLO closes the older one, a connection without HELLO is closed after 30 s), UDP `0.0.0.0:7421` (receive only), serial ENV (incoming `@fr1:` ENV lines tapped from the log store's frame decoder after the line is stored, outgoing via `writeLine`, one line at a time per port). `@fr1:` lines are never collapsed by the serial repeat filter: identical lines are distinct envelopes. Unknown sources are accepted until their HELLO. A second hub for tests takes `--node-port`, `--node-host 127.0.0.1` and `--no-serial` (it must not touch the USB ports the real hub holds).
- **Router (H2)** per 08 §8.4: windows per `(device, epoch)` (256 bits, so unprovisioned devices work) and LATEST `last_seq`; hub frames `src = 0x0000`, `epoch = hub_epoch`, `dst` = the node's HELLO src (0xFFFE while unprovisioned), `net` = its HELLO net, ttl 0x11, one dense UNICAST counter per device, BCAST counter, LATEST counter, all starting at 1 each run; handshake on HELLO: WELCOME (`hub_epoch, ucast_floor` = the WELCOME's own seq, `bcast_base, hub_time_us, net_mode 0, channel`), DIRECTORY (all provisioned devices, pages from 0, always at least one), TIME burst (8 × SYNC_REQ, min-RTT offset; again every 60 s), `fr.node.describe` (bulk) when no manifest matches the HELLO fw prefix (cached per `descriptor_hash`), `get_state`, then `device.online` (first session) and `device.link {link, up: true}` (every session). UDP HEARTBEAT → ACK over TCP echoing its seq (DUP copies too); an UNASSIGNED node sends no UDP (§3, decision 4), so a datagram claiming 0xFFFE is dropped (`udp_unknown`) and `udp_blocked` is never raised for such a node. HELLOs from another net are dropped (`foreign_net`) once a network record exists (the router reads `net_id` again on each HELLO until one does, so `fr net set` on a fresh hub.db needs no restart). Hub keepalive: a HEARTBEAT on every session (TCP and serial) on which nothing went out for one interval; suspect at 2.5 × interval with PINGs at 2.5 × and 3.0 ×, offline at 3.5 × (≥ 750 ms), which sends a PRESENCE BYE on a serial session (the node HELLOs there at once; the hub's stop does the same) and closes the TCP connection; offline (`link_lost`) when the last session closes, and a USB port that disappears ends its serial session at once (`device.link {link: serial, up: false, reason: 'usb port gone'}`); BYE → offline at once with the reason, while commands waiting on the device keep waiting, and a RESULT from it is still taken, for `byeGraceMs` (250 ms; over UDP, on its TCP connection kept open that long, or its USB line), since a RESULT sent before the BYE on one link can arrive after it on another; a HELLO with another epoch → offline (`restarted`, or `epoch_regressed`, logged) and a new handshake; `udp_blocked` warning (event `hub.warning` and hub_status) when a TCP session sees no UDP for 10 s, cleared when UDP returns. Q1 frames from nodes get an ACK (EVENT, MSG; again on a DUP) or are answered (PING → PONG). Hub CMDs carry ACK_REQ whenever the RESULT is awaited, and `expire_at_us` (hub now + 1000 ms in node time) once the node is synced; RESULTs match on (device, `req_seq`) and `req_epoch` = hub epoch, from any link. Event `t_hub_us` = device time through the offset, else receive time; a capability EVENT/STATE is published as `<inst>.<member>` with decoded fields (`port<p>.event<k>` / `port<p>.state<k>` with `{raw}` when nothing names the port), STATE also updates a per-device property mirror (an older STATE is neither applied nor published); `late` flags an event older than the last of its instance, `replayed` one whose device time is > 2 s before arrival; `node.boot`, `diag.mark` likewise. The `Router` interface stays as above; `HubRouter` adds `start/stop`, `tick`, `info`, `instances` and `status`, reached from ops through `routerInfo`, `routerInstances` and `routerStatus`.
- **Ops (H2)**: `events_read {selector?, types?, since?, max_events}`, `wait_for_event {types, selector?, where?, since, count, per_device, timeout_s, include_replayed}` (an event stamped more than 100 ms before the cursor was handed out counts as stale: the hub records when it hands each cursor out, through every op's envelope and the cursors ops return, for the newest 1024 seqs; an older one is dated by the newest row at or before it), `wait_for_device {selector, state: online|offline, fw_id?, since?, timeout_s}`, `command_send {selector, instance?, command (or <inst>.<cmd>), args?, ack: none|result (default result), timeout_s, duplicate (debug)}` → `{results: [{device, alias, status, fields, rtt_ms, link}]}` (one unicast per device; per-device statuses are the RESULT names plus `sent`, `offline`, `timeout`, `not_found` (no such instance or command) and `injection_disabled` (a test-only command to a release build, refused without sending); invalid args fail the whole op with `INVALID_ARGS`, and the op fails with `DEVICE_OFFLINE` or `INJECTION_DISABLED` only when every selected device was refused for that reason), `input_simulate {selector, instance, gesture, timeout_s}` (the instance's `inject`), `device_get` adds `router` (presence, links, clock offset, heartbeat, the property mirror) and the last `provision` record. `diag_exec` keeps the serial path and falls back to `fr.diag.exec` over the session when the port is not open (`via` says which).
- **SleepGuard (H2).** While at least one node session is up: a child `caffeinate -i -w <hub pid>`; killed when the last session ends.
- **Selectors** (H1, used by H2): the 09 §9.2 grammar; `online`/`offline` through `Router.presence`.

## 5. Tests

- **Host C++ (T0):** `fr_net` core with `FakeLink` + `FakeCore`: HELLO repeat until WELCOME, window reset at WELCOME, DUP → cached response byte-identical, OLD dropped, UDP Q1 retry/backoff and give-up, dual path before `udp_ok`, `udp_ok` from the echo, session loss after 3.5 intervals, heartbeat cadence and fields, event max age, BYE, TIME answers, `expire_at`.
- **TS:** registry and selectors; alias rules; provisioning job with a fake sidecar; `nvs_gen` CSV rendering (no secrets in output); Router against a **FakeNode** (a TS node speaking the generated codecs over real loopback TCP/UDP): handshake order, echo, presence timings with a fake clock, BYE, `udp_blocked`, duplicate CMD → one execution, `command_send` fan-out, waits, `expire_at`.
- **Interop (C++ node ↔ TS router):** `fr_net_node` (firmware/test/host/tools, built by `pnpm test:host`) runs the real `fr_net` core, button and LED services and descriptor builder over POSIX TCP/UDP; `packages/hub/test/interop.test.ts` runs it against the router on loopback (handshake with describe, udp_ok, commands through the response cache, reboot → RESULT then BYE (also with a serial session and slow UDP, with and without the hub's BYE grace), silence → suspect/offline, `udp_block` → `udp_blocked` without a false offline, `drop_hub_link` (no reconnect until it ends), a hub restart, a USB node whose Wi-Fi goes silent (the hub's BYE over USB ends both sessions), an unprovisioned node without `udp_blocked`). The suite skips when the binary is absent.
- **On target (lead):** provision C3 #2 and the C6 from blank; both online over Wi-Fi; T-LED (`blink {count:3}` RESULT ok + `effect_done`; `set` fast; `toggle` with `duplicate: true` applied once); T-PRES (unplug → offline 2.4–3.5 s; `reboot` → BYE offline at once; `diag net udp_block 30` → `udp_blocked` with no false offline); rename propagates (`alias_rev`); `diag_exec` over the link with the board on a charger.

## 6. Kconfig / constants

`FR_HEARTBEAT_MS` 1000, `FR_SUSPECT_X10` 25, `FR_OFFLINE_X10` 35, `FR_OFFLINE_MIN_MS` 750, `FR_ACK_BASE_MS` 20, `FR_MAX_ATTEMPTS` 4, `FR_EVENT_MAX_AGE_MS` 1000, `FR_CMD_EXPIRE_MS` 1000, `FR_TCP_DELIVERY_MS` 2000, `FR_HUB_PORT` 7421, `FR_DEV_WIFI_SSID`/`FR_DEV_WIFI_PASS` (empty), `FR_TTL_DEFAULT` 2 (05 §5.17); added in C3: `FR_HELLO_RETRY_MS` 1000 and `FR_DEV_HUB_HOST` (empty: an UNASSIGNED node on dev Wi-Fi needs it to find the hub). `FR_SUSPECT_X10` and `FR_CMD_EXPIRE_MS` are hub rules; the node does not use them.

## 7. Streams

| Stream | Owns |
|---|---|
| Foundation | §2 (schema, codegen, both runtimes, vectors), `fr_net` skeleton with the §3 headers, hub `context.ts` + DDL + `Seq` + empty op/handler modules wired in, pytools `nvs_gen`, cJSON for the host suite (vendor or hash-pinned fetch) |
| N1 `fr_net` core | `firmware/components/fr_net/src/core/**`, `include/**` (beyond the skeleton), host tests `firmware/test/host/tests/net_*.cpp` |
| N2 node integration | `fr_net/src/esp/**`, `fr_core` (Host impl, boot, Net instead of `EnvelopeLink`, system capabilities), `fr_id`, `fr_diag` (`net` commands, `info` link states), `fr_serial` (session link), `apps/node`, sdkconfig layers, Kconfig |
| H1 registry + provisioning | `packages/hub/src/registry/**`, `packages/protocol/src/ops/registry.ts`, flash plans in `packages/hub/src/flash.ts`, the flash handler, pytools `nvs_gen` use, tests `packages/hub/test/registry*.test.ts` |
| H2 links + router + events | `packages/hub/src/{links,router,events}/**`, `packages/protocol/src/ops/links.ts`, the `diag_exec` link fallback, SleepGuard, `hub_status` additions, tests `packages/hub/test/{router,links,events}*.test.ts` + the FakeNode helper |

## 8. Out-of-band notes

- Both boards stay USB-powered from the Mac during tests, so "unplug" means pulling the USB cable (power and serial).
- The Wi-Fi password is rendered only into `fr_ident.bin` (and the CSV `nvs_gen` reads, deleted at once) in a 0700 dir under `FR_HOME/tmp/ident`; it never enters SQLite, logs, job logs, results or the repo.

## 9. Decisions to fold into the spec

1. EXT TLV support with the `unsupported_ext` and `bad_ext` errors (appended); TLVs exactly when the `EXT` flag is set, unknown non-critical ones kept, a repeated type: last wins; FRAG/SEC still rejected. (The C2 design note still calls EXT unsupported.)
2. The `Descriptor` type; `describe` returns it as bytes; `descriptor_hash` and `board_hash` definitions.
3. `Reply` buffer sizes: 200 B realtime, 1445 B bulk on TCP/serial (the RESULT envelope fits the 1470 B MTU).
4. Node path selection when both serial and TCP sessions exist (TCP/UDP first, serial otherwise); a standby serial session is not timed out; no UDP for an UNASSIGNED node; a refused UDP send falls back to TCP; STATE double send on UDP only.
5. HELLO-only devices are registry rows with `provisioned: false`, `addr: null` (alias `<chip>-<last 6 hex>` unless their own is valid and free; provisioning replaces a made-up alias and the firmware's `new-<last 6 hex>` at rev 0), and get WELCOMEd.
6. Default alias `<profile>-<last 6 hex>`; `addr` never reused (`registry.addr_hwm`, also raised by a HELLO on this hub's net); extra reserved aliases `all`, `offline`, 12-hex ids; aliases stored lower case.
7. `networks.net_id` random u16 (1..65535) and `hub_host`; `hub_epoch` in kv, skipping 0 on wrap.
8. `full` writes `fr_ident` from the registry for provisioned devices (decided when the job runs, not when it is queued); `flash_start` takes `device` or `port` (exactly one), `profile` defaults to the registry's; dry runs show `ident` and `identity`, never the image.
9. `exec_at_us` answers `UNSUPPORTED` until T-LAT.
10. `net udp_block <s>` and `net drop_hub_link <s>` debug hooks (implemented in C3; they take effect after the RESULT of the command that set them).
11. Provisioning waits for the serial HELLO (none: `TIMEOUT`, `details.flashed: true`), then reports the Wi-Fi join separately (`wifi: not_joined` is not a failure); jobs of kind `provision`; profile detection from the probed chip.
12. SleepGuard via `caffeinate -i -w <pid>`.
13. RESULT only for a unicast CMD with ACK_REQ; the hub sets ACK_REQ on every CMD whose RESULT it awaits and matches RESULTs on `(device, req_seq, req_epoch)` from any link.
14. Response cache: RESULTs only, 8 × ≤ 250 B plus one bulk slot; a DUP of an evicted request is dropped, never re-run; DUP PING/SYNC_REQ dropped; a DUP Q1 EVENT/MSG gets a fresh ACK.
15. `udp_ok` heuristics beyond the echo: cleared by a hub PING and by two TCP hub HEARTBEATs without an echo between them (serial keepalives do not count); an immediate heartbeat whenever it is cleared (lapse, PING, hub keepalives, UDP or TCP down) and after every WELCOME; clearing it gives every pending UDP-only Q1 frame a TCP copy.
16. TIME: `SYNC_RES` on the request's link; `time_synced` per link, cleared by a new WELCOME; t2 is when `Net::receive` ran.
17. BYE: a BYE asked for inside a request follows that request's RESULT on the request's link (`fr.node.reboot` answers ok, then BYE `reboot`, or `maintenance` for the bootloader); a BYE outside a request, or one whose request gets no RESULT, goes on every session; after a device's BYE the hub still takes a RESULT from it, and keeps its commands waiting, for 250 ms; a hub BYE ends every session of that hub run at once.
18. `state_seq` counts STATEs meant for the hub even when they found no path, so a lost STATE triggers `get_state`; a full outbox evicts its oldest entry (`delivery_failed`).
19. Hub framing: `ucast_floor` = the WELCOME's own seq; DIRECTORY pages from 0; ttl 0x11; `describe` before `get_state` when no manifest names the firmware.
20. Hub presence: keepalive HEARTBEAT on every session when nothing went out for an interval; PINGs at 2.5 × and 3.0 ×; a timeout offline (and the hub's stop) sends a hub BYE on a serial session and closes the TCP connection; a USB port that disappears ends its serial session at once (`usb port gone`); offline `link_lost` when the last session closes; a new epoch is offline `restarted` / `epoch_regressed`.
21. Events: `device.link {link, up, remote|reason}`, `device.suspect {silent_ms}`, `device.online {link, addr, fw_id_prefix, provisioned}` or `{link, recovered}`, `hub.warning {code: udp_blocked, hint}`, `msg {topic, data, dst}`, `registry.drift`, `device.provisioned`, and `port<p>.event<k>` / `port<p>.state<k>` for unnamed ports; a stale STATE is not forwarded; `replayed` = synced and device time > 2 s before arrival; waits treat events stamped more than 100 ms before the cursor was handed out (its recorded mint time) as stale.
22. Ops: `command_send` per-device statuses (RESULT names plus `sent`, `offline`, `timeout`, `not_found`, `injection_disabled`); the op fails only when every device was refused for one hub-side reason (`DEVICE_OFFLINE`, `INJECTION_DISABLED`); `device_update --tag +t,-t`; selector combination rules (alternatives within a kind, narrowing across kinds, `!` last); `diag_exec` `via`; `device_get` `router` and `provision`.
23. Error codes: `DELIVERY_FAILED`, `EXPIRED` (retryable), `CAPABILITY_UNSUPPORTED`, `INJECTION_DISABLED` join the code list (09 §9.3).
24. Retention counts cursors (logs and events share one Seq): each table keeps at most `rows` rows and both together at most `rows`; `events.retention_days|rows` in kv.
25. Node storage: `fr_link` gains `ssid_h`; `fr_net2` stores `base` (the `prov_ts` it was pushed under) and `ok`; a reprovision drops an override; Kconfig `FR_HELLO_RETRY_MS`, `FR_DEV_HUB_HOST`; EspCore's `post_net` queue (32), 28-timer pool and 8 KB core stack; the serial link is up only while a USB host is attached; `fr_core` no longer has `EnvelopeLink` (03 §3.3: Net is the Sink).
26. Serial: `@fr1:` lines are never collapsed by the hub's repeat filter.
27. `Link` gains `drop(DropReason)` (`hub_silent`, `hub_bye`, `hub_restarted`) and `hold(bool)` (`drop_hub_link`: no reconnect while held, at once when released); TCP TX ring 8 KB (a power of two); one WARN line per TCP close with its reason, and diag `stats` gains `sessions_timed_out`, `wifi_last_reason`, `tcp_close_peer|keepalive|error|session|wifi` (with `tcp_rx_bad` they add up to `tcp_closes`) and `tcp_last_errno` (worst-case `stats` JSON about 1.2 KB, under the 1400 B `fr.diag.exec` limit); a stale `fr_link` pin yields to `fr_ident`'s BSSID; HEARTBEAT `swept` once per sweep.
