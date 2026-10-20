> Research report generated 2026-10-20 by a research agent, followed by an adversarial fact-check (the VERIFY section). Where the two disagree, the fact-check wins, and docs/spec/ has the reconciled decisions. Kept here for traceability and sources.

# agent-api-testing

## SUMMARY
Define each hub capability once, in a typed operation registry in the Node 24/TypeScript hub, and generate five surfaces from it: MCP tools, REST (OpenAPI 3.1), WebSocket/SSE events (AsyncAPI 3.1), a `prop` CLI with `--json`/`--ndjson` output, and a TS client SDK. A parity test then makes it impossible for MCP and non-MCP agents to drift apart.

MCP changed a lot this summer. The current spec, 2026-07-28, is stateless: no initialize handshake and no sessions. Resource subscriptions moved to `subscriptions/listen`, Tasks became an optional extension, and Logging, Sampling and Roots are deprecated. The official TS SDK v2 (`@modelcontextprotocol/server` 2.3.1) implements it and still serves 2025-era clients, so the hub can expose Streamable HTTP at `/mcp` plus a stdio adapter (`prop mcp`) for plugin use.

No host in the extension matrix shows Tasks support, Claude Code included. Long operations (build, flash, OTA, tests) therefore use server-minted job handles, following the spec's own "stateful tools" guidance. Every start tool takes an optional `wait_s`, and there are `job_wait`, `job_logs` and `job_cancel` tools, all bounded to fit Claude Code's limits: a 5-minute idle timeout over HTTP (30 minutes over stdio) that progress notifications reset, auto-backgrounding after 2 minutes, and a 25k-token output cap. Every mutating tool returns a cursor taken before the side-effect, so `wait_for_event`, `wait_for_log` and `logs_assert` can be used without races.

Errors are structured (code, retryable, hint, a machine-actionable remediation, then `isError`). Mutating tools support dry-run and idempotency keys. Locks are per device and per port, and external tools get exclusive serial leases. A lease is required because esptool cannot use USB-Serial/JTAG over RFC2217, and all three of your boards use USB-Serial/JTAG. Destructive operations need a confirm token plus Claude Code's `anthropic/requiresUserInteraction` flag, and eFuse operations are never exposed.

Testing has five tiers: host (vitest, plus Unity on IDF's linux preview target), on-target Unity through pytest-embedded 2.9.3, simulation, hardware-in-the-loop on real boards, and soak tests.

Simulation should use Espressif's new esp-emulator (Beta, v0.50.0, released 2026-10-20). It runs C3, C6 and S3 firmware with WiFi STA, and its gateway 192.168.4.1 maps to the host's 127.0.0.1, so emulated nodes can reach the real hub. It also supports OTA and reset/erase over a control port. QEMU only covers esp32, C3 and S3, with no WiFi and no C6. Wokwi is optional, for GPIO-level button and LED checks, and has a CI-minute quota. Neither simulator documents ESP-NOW, so mesh behaviour needs real hardware.

An agent cannot press BOOT, so input is verified in four ways: a Kconfig-gated `input.inject` at the driver boundary, Wokwi `set-control`, an optional second-ESP32 'fixture' rig that drives GPIO9 (C3/C6) or GPIO0 (S3), and a human-assisted wait. Machine-parseable `PROP|...` log lines feed both events and golden-log assertions.

For distribution, ship a Claude Code plugin with portable Agent Skills (SKILL.md), the bundled MCP server, a `bin/prop` CLI, a SessionStart status hook, a PreToolUse safety hook and an experimental event monitor, plus AGENTS.md for non-Claude agents. ESP-IDF ≥6.0 now has its own `idf.py mcp-server`, but it only does build, set_target, flash, clean and create, with no monitor, OTA or fleet support. Treat it as complementary, not as a dependency.

## RECOMMENDATION
1. Hub is the single owner of state, serial ports and jobs (TypeScript, Node 24). Define every capability once in an `ops` registry: zod v4 input and output schemas, kind (query, command, job or wait), locks, safety tier, REST route and CLI path. Generate MCP tools, REST/OpenAPI 3.1, WS/SSE events (AsyncAPI 3.1), the `prop` CLI and the `@propriocept/client` SDK from it. CI fails if any op is missing from any surface.
2. MCP: `@modelcontextprotocol/server` 2.x (2.3.1) targeting spec 2026-07-28 with legacy (2025-11-25) serving left on. Use Streamable HTTP at `http://127.0.0.1:7420/mcp` with Host/Origin validation, plus a stdio adapter `prop mcp` that the Claude Code plugin spawns; it auto-starts the hub and calls REST. Do not depend on the Tasks extension, Logging, Sampling or Roots. Use explicit `job_id` handles, progress notifications, resources, and elicitation through MRTR only as an optional extra.
3. Tool design: about 40 tools, where three coarse tools (`deploy`, `test_run`, `device_list`) cover the normal path and fine primitives handle debugging. Common contracts:
   - an `{ok,data,error,cursor}` envelope;
   - one global monotonic cursor shared by events and log lines, with every mutating tool returning the cursor from before its side-effect;
   - waits capped at 240 s that emit progress every ≤10 s;
   - log reads capped by lines and bytes, with `next_cursor`;
   - an `idempotency_key` and `dry_run` on every mutating tool;
   - per-key FIFO locks (`port:`, `device:`, `build:`, `sim:`) that report who holds them;
   - a two-step `confirm_token` plus `anthropic/requiresUserInteraction` for destructive tools, and no eFuse tools at all.
4. Firmware `prop_diag` component: a console REPL over USB-Serial/JTAG and the same command set over the hub link (`info`, `caps`, `input.inject`, `cap.call`, `selftest`, `mark`, `ota.confirm`). Add a `PROP|seq|ms|lvl|tag|event|json` structured log line, and a boot event carrying the ELF sha256 and build_id. Gate injection behind Kconfig. OTA uses rollback (`BOOTLOADER_APP_ROLLBACK_ENABLE`), and the hub confirms the new image only after a handshake.
5. Testing tiers:
   - **T1 host:** vitest for the hub; Unity on the IDF linux target for protocol and codec C code.
   - **T2 on-target Unity:** through pytest-embedded with a hub-issued serial lease.
   - **T3 sim:** esp-emulator fleets of C3/C6/S3 connecting to the real hub through gateway 192.168.4.1, covering provisioning, commands, OTA and injected input. This is the default gate for agents.
   - **T3b optional:** Wokwi for GPIO-level checks.
   - **T4 HIL:** real boards, covering ESP-NOW, latency and RF, with an optional fixture ESP32 driving BOOT pins.
   - **T5 soak.**
   Skip QEMU.
6. Ship the `propriocept` Claude Code plugin containing:
   - 10 skills: fleet-ops, provision, build-deploy, debug-device, e2e-verify, test-authoring, write-capability, mesh-protocol, client-codegen, hil-rig;
   - a `hil-tester` subagent;
   - `.mcp.json` pointing at `prop mcp`;
   - `bin/prop`;
   - hooks: a SessionStart status brief and a PreToolUse policy guard;
   - an experimental monitor for device offline and crash events.
   Keep skill frontmatter within the Agent Skills spec subset so other agents can use it, and add AGENTS.md.
7. PoC scope (phase 0): about 18 tools:
   - hub_status, device_list, device_get, device_update, port_list;
   - build_start, flash_start, ota_deploy (single device and fleet 'all');
   - job_wait, job_get, job_logs;
   - logs_read, wait_for_log, wait_for_event, events_read;
   - command_send, input_simulate, serial_lease.
   Also the CLI equivalents and 3 skills: fleet-ops, build-deploy, e2e-verify.

## RATIONALE
Why one operation registry with generated surfaces: the user wants any agent to work, whether it is an MCP client, a script, or a non-MCP coding agent. Hand-maintaining MCP, REST and CLI separately guarantees drift. Generating them all from zod schemas also yields the TS client library the game use-case needs.

Why job handles instead of MCP Tasks:
- The 2026-07-28 spec moved Tasks into an optional extension.
- The official client matrix lists no host with Tasks support.
- The spec's own non-normative "Stateful Tools" section recommends explicit server-minted handles.
- Our job states match the Tasks vocabulary (working, input_required, completed, failed, cancelled), so adding Tasks later is a mapping, not a redesign.

Why the bounds:
- Claude Code aborts MCP calls idle for 5 minutes over HTTP (30 over stdio) unless progress is sent.
- It auto-backgrounds calls after 2 minutes.
- It persists outputs over 25k tokens or 50k characters to files.
- It truncates tool descriptions at 4,096 characters (upfront) or 16,384 (via tool search).
So waits are capped, progress is emitted, logs are cursor-paged, and descriptions stay short.

Why a cursor taken before the action: it removes the classic agent race where the action happens, the event fires, and only then does the wait start and miss it.

Why the hub owns ports and hands out leases: esptool documents that USB-Serial/JTAG cannot be used over rfc2217:// or socket://, and all target boards are native USB. Port paths re-enumerate on macOS after resets, so identity comes from the USB serial number (the MAC) and selectors are used instead of paths.

Why esp-emulator over QEMU: QEMU in IDF 5.5.1 and 6.1 supports only esp32, C3 and S3, has no WiFi, and has no C6. esp-emulator supports C3, C6 and S3 with WiFi STA, user-mode NAT that reaches the host's localhost, OTA image switching, and a reset/erase control port, so an agent can run a fleet locally without hardware. Wokwi adds real GPIO paths, such as button `set-control` and `expect-pin`, but is quota-limited and needs a paid private gateway to reach the hub.

ESP-NOW is undocumented in both simulators, so mesh tests stay in the hardware tier.

Why skills: they are now a cross-vendor format (agentskills.io) and Claude Code plugins can bundle skills, the MCP server, hooks, executables and monitors, so a single install gives an agent the whole capability.

## ALTERNATIVES
- **Use the MCP Tasks extension (io.modelcontextprotocol/tasks) for build, flash and OTA** — verdict: Defer to phase 2. Ship our own job_id handles with the same status vocabulary now, then advertise the extension as a thin mapping once Claude Code supports it.
- **Stdio-only MCP server, with each agent spawning its own process that opens serial ports** — verdict: Rejected as the primary design. Keep stdio only as a thin adapter (`prop mcp`) that talks to the long-running hub.
- **Only fine-grained primitives, or only coarse task tools** — verdict: Layered. Three coarse tools (deploy, test_run, device_list) cover the normal path, and primitives (job_*, wait_*, logs_*, flash/ota/command) are for diagnosis.
- **Simulator choice: QEMU vs esp-emulator vs Wokwi** — verdict: esp-emulator is the primary simulation tier. Wokwi is optional for GPIO-level tests. Skip QEMU.
- **Let pytest-embedded or idf.py monitor own serial ports directly, with RFC2217 for sharing** — verdict: The hub owns ports. `serial_lease` hands an exclusive port path to external tools for a bounded TTL, and pytest-propriocept fixtures talk to the hub over REST.
- **Python FastMCP (as used by `idf.py mcp-server`) instead of the TS SDK** — verdict: TS SDK v2 in the hub. Shell out to idf.py and esptool for Espressif operations. Treat the official idf.py mcp-server (IDF ≥6.0) as an optional companion.
- **Resource subscriptions (subscriptions/listen) as the way agents learn about device events** — verdict: Offer subscriptions for dashboard and MCP clients that use them. Agents rely on wait_for_event and events_read with cursors, plus an optional Claude Code plugin monitor.

## RISKS
- MCP churn. 2026-07-28 was a breaking rewrite, and Claude Code runs a dual v1/v2 runtime whose negotiation varies by session, so tools could behave differently across clients. → Use TS SDK v2 with legacy serving enabled. Avoid deprecated features (logging, sampling, roots) and the Tasks extension. Keep every tool a plain request/response with an optional wait. Run a CI matrix with MCP Inspector CLI (2.11.0) plus SDK v2 clients in both modes: legacy and pinned 2026-07-28. The CLI and REST surfaces are a fallback for any client.
- Agent context blow-up from logs, build output or fleet listings, or Claude Code persisting large results to files. → Defaults: max_lines 200, max_bytes 32 KB, summary fields first. Build errors are parsed into diagnostics[] instead of raw logs. List tools are paginated, timeout responses carry a tail of 20 lines, and anthropic/maxResultSizeChars is set only on job_logs and test_report.
- Race conditions: an event fires before the agent starts waiting. → A single global monotonic cursor. Every mutating tool returns the cursor captured before its side-effect, and wait_* tools require or default `since`.
- Port contention or loss. Several agents, the dashboard and external tools all want the port, and USB-Serial/JTAG re-enumerates after reset, so paths change. → The hub owns all ports and identifies boards by USB serial (the MAC), with selectors instead of paths. Leases are TTL-bound, auto-expire and appear on the dashboard. Locks are per device and per port, and a LOCKED error names the holder job and its ETA.
- Simulators diverge from silicon. esp-emulator is Beta; neither esp-emulator nor Wokwi documents ESP-NOW or GPIO injection. → Tier gates: sim for logic, protocol and OTA; HIL is mandatory before marking a mesh or RF feature done. Pin the esp-emulator version in propriocept.toml and keep sim-only quirks in golden-log normalizers. Re-check ESP-NOW support every release.
- An agent bricks or erases a device, or OTAs the whole fleet with a bad image. → No eFuse or secure-boot tools. Full erase needs a confirm_token plus requiresUserInteraction. OTA defaults to the canary strategy with halt on failure, and bootloader rollback plus a hub-confirmed boot handshake revert bad images. A policy file marks protected devices, and a PreToolUse hook enforces the policy in Claude Code.
- Prompt injection through device output: an agent might treat log or serial text from devices as instructions. → Return device text only inside data fields such as lines[].text. MCP server instructions and skills state that device output is untrusted data. Never echo raw logs into tool descriptions.
- Debug injection or console commands left enabled in field firmware. → Kconfig PROP_DIAG_INJECT defaults to y only in the debug profile. The release profile compiles it out, and the hub refuses input_simulate when a device reports inject:false. LAN mode requires a bearer token.
- Long waits in Claude Code get backgrounded (after 2 min) or killed by the idle timeout (5 min over HTTP). → Cap waits at 240 s, send progress every 10 s, and have skills teach the loop: start a job with wait_s ≤ 120, then job_wait again.
- Tool sprawl (about 40 tools) hurts tool selection. → Three coarse tools are documented as the default path. Descriptions are short and keyword-first. Mark hub_status and device_list with anthropic/alwaysLoad. Skills point agents to exact tool names, and tool order is deterministic.
- IDF version skew. The user has 5.5.1, while 6.1 and 5.5.6 are current. Build and test conventions and the official MCP server differ between 5.x and 6.x. → Pin idf_version per project in propriocept.toml. `prop hub doctor` checks that the pin matches the installed IDF. The hub shells out to idf.py, which works on both. Decide the upgrade separately in the toolchain dimension.

## OPEN QUESTIONS
- Should the hub's agent API stay localhost-only in v1, or must remote agents on the LAN or in the cloud drive it? This affects auth (bearer tokens or OAuth) and TLS.
- Are you OK adding one extra ESP32 as a hardware-in-the-loop 'fixture'? It would be wired to each DUT's BOOT pin (GPIO9 on C3/C6, GPIO0 on S3) and LED pin, so agents can test real button presses and LED output without you.
- Would you pay for a Wokwi plan? A private gateway is needed for simulated devices to reach the hub, and the free tier has 50 CI minutes per 30 days. Or should simulation stay local-only with esp-emulator?
- Should destructive operations (full chip erase, NVS wipe, forgetting a device) always require a human click, or may an agent complete them with a confirm token in a sandboxed bench?
- Besides Claude Code, which agents must be first-class (Codex, Cursor, Gemini CLI, custom SDK agents)? This decides how much goes into AGENTS.md, Skills-over-MCP and REST examples.
- Do you want to upgrade from ESP-IDF 5.5.1 to 6.1 now? That unlocks the official idf.py mcp-server, and 6.1 is the latest stable. Or would you rather stay on the 5.5.x LTS line (5.5.6)?
- How long should hub history be kept: events and logs for 7 days, test runs for 90 days? And should test reports be exportable (JUnit) to CI?

## VERIFY: holds=True
### Challenge
The interface core holds: one ops registry generating every surface, server-minted job handles instead of MCP Tasks, a pre-action cursor, hub-owned ports, and stdio as Claude Code's primary path. Each choice is backed by primary sources, and Tasks is not even implemented in the TS SDK v2 server.

Strongest case against, part 1 (scope). Phase 0 builds five surfaces, AsyncAPI, about 18 MCP tools, three skills, hooks and monitors before one LED blinks. The protocol it targets is two months old and had a breaking rewrite. Claude Code runs the legacy v1 runtime in most sessions, so 2026-07-28 features (MRTR elicitation, subscriptions/listen) would not reach the primary agent. A CLI-first phase 0 captures most of the agent value for Claude Code, Codex, Cursor and Gemini at far lower risk: `prop --json` plus REST plus WS events plus a generated stdio MCP adapter. Defer HTTP /mcp, AsyncAPI, SSE and long-poll, resources and subscriptions.

Strongest case against, part 2 (simulation tier). Making esp-emulator "the default gate for agents" is the weakest decision:
- It is a closed-source Beta binary with weekly releases.
- The released pytest-embedded espemu service excludes S3 and cannot reset.
- Every instance shares one default MAC, so sim device IDs collide.
- Its UART-TCP bridge does not carry the USB-Serial/JTAG diag console.
- Panic interception defeats rollback tests unless --no-panic-intercept is passed.
- Open bugs affect S3 OTA (#22) and C6 USB-JTAG (#11).
- It has no GPIO injection and no ESP-NOW.

The framework's core value is ESP-NOW flood/rebroadcast and input latency, which this gate cannot test at all.

A materially better default gate for protocol and mesh logic is a host-native fleet simulator. Compile the transport-agnostic protocol core (already required by the HAL separation) for the IDF linux target, or as a native/WASM module, against a virtual ESP-NOW medium with loss, latency and duplication injection. The hub can drive dozens of such nodes deterministically in CI. Keep esp-emu as an optional C3/C6 smoke tier for the WiFi-to-hub link and OTA, and make HIL on the three real boards mandatory for RF and latency.
### Refuted/uncertain
- [refuted] esp-emulator (Beta, Apache-2.0, v0.50.0 released 2026-10-20) runs C3/C5/C6/H2/P4/S3 firmware with a soft AP, --net user with gateway 192.168.4.1 mapped to host 127.0.0.1, hostfwd, --uart-tcp, --control-tcp, --inject/--inject-on, --elf old new for OTA, GDB and Perfetto.
  → The features, chips and v0.50.0 date are correct. 'Apache-2.0' is misleading: the repo holds only the installer, docs and tools, and the Rust emulator core ships as a closed prebuilt binary (issue #10 asks whether source will be published; issue #5 says 'closed core'). Five operational gotchas: (1) --uart-tcp bridges UART0 only, and esptool use needs --strap-mode 0x02 plus --before/--after no-reset. (2) With --elf the emulator halts at the first panic unless --no-panic-intercept is passed, which defeats rollback-on-panic tests. (3) Every instance defaults to MAC 24:0A:C4:00:00:01 unless given a per-instance --efuse from tools/make-efuse.py --mac. (4) Open bug #22: on S3, panic intercepts keep the first image's --elf after an OTA switch. (5) Open bug #11: C6 USB-Serial-JTAG SOF is asserted forever. Releases are roughly weekly. (gh api repos/espressif/esp-emulator (README, releases, issues 5/10/11/22, tools/make-efuse.py lines 149-170))
- [refuted] The OTA handshake: if no confirm arrives within verify.timeout_s, the bootloader rolls back.
  → The bootloader acts only on the next reset. On first boot the image moves from NEW to PENDING_VERIFY, and a second boot while still unconfirmed marks it ABORTED and rolls back. An app that keeps running unconfirmed is never rolled back unless the firmware arms its own timer and calls esp_ota_mark_app_invalid_rollback_and_reboot() or restarts. Also, a device still in PENDING_VERIFY rejects a new OTA with ESP_ERR_OTA_ROLLBACK_INVALID_STATE. (~/esp/v5.5.1/esp-idf/components/bootloader/Kconfig.app_rollback help text ; components/bootloader_support/include/esp_flash_partitions.h:68-69 ; components/app_update/include/esp_ota_ops.h:34)
### Missed
- Localhost security beyond /mcp. The REST endpoints and the WS game/RPC socket on 127.0.0.1 are reachable from any web page in the user's browser, through simple-request CSRF and cross-origin WebSockets. They need Origin allowlists, non-simple content-type requirements and a per-client token, not just Host/Origin checks on /mcp.
- In most sessions Claude Code uses the v1 MCP runtime, which speaks the legacy protocol. The SDK's default legacy:'stateless' HTTP serving has no sessions and no GET stream. Over HTTP that leaves no list_changed or resource push, and server-initiated elicitation is unlikely to work, so prompt_human elicitation effectively works only over the stdio adapter or on 2026-07-28 connections.
- 2026-07-28 Streamable HTTP removed stream resumability. A dropped connection during a 240 s wait loses the request, so every wait tool must be safe to re-issue. Job handles and since-cursors make that possible; the protocol does not.
- Sim fleet identity: every esp-emu instance defaults to MAC 24:0A:C4:00:00:01, so all sims become p-240ac4000001. sim_start must generate a per-instance eFuse with `tools/make-efuse.py --chip X --chip-rev N --mac ...` and pass --efuse. eFuse state is saved back on exit, so the files must not be shared.
- Sim console transport: prop_diag's REPL is on USB-Serial/JTAG, but esp-emu --uart-tcp and the pytest espemu service bridge only UART0. Either build a sim profile with the console on UART0, or have the hub read USB-JTAG output from emulator stdout (--console usb-jtag).
- Bootloader and partition settings (rollback enable, the ota_0/ota_1 layout, the identity NVS partition) can only change over serial, so they must be right at first provisioning. 'OTA from the ground up' cannot fix them later.
- OTA transport: esp_https_ota over plain http:// needs CONFIG_ESP_HTTPS_OTA_ALLOW_HTTP=y, which is marked testing-only. With secure boot a non-goal, images are unauthenticated, so the node should check the image sha256 against a value delivered over the authenticated hub link.
- Rollback semantics: firmware needs its own confirm-timeout reboot. If the hub is down after an OTA, every node rolls back, so confirmation should combine local self-test with the hub handshake.
- The S3 variant is unknown. If it uses a CP210x/CH34x UART bridge, port identity by USB serial number fails and RFC2217 works, so keep a fallback that identifies via esptool read_mac or diag `info`.
- The hub is Node but esptool is Python. A small Python sidecar using esptool's scripting API (connect_esp plus a TemplateLogger emitting NDJSON progress) is more robust than scraping CLI output, and it can hold the port lease atomically.
- Claude Code tool input-schema rules: property names must be 1–64 characters of [A-Za-z0-9_.-], schemas must validate against draft 2020-12, and the root must have no anyOf/oneOf. The spec's `device|port`, `job_id|job_ids[]` and `artifact|build_id` unions must be flat optional fields validated server-side.
- The installed Claude Code is 2.1.286, so tool descriptions and server instructions are cut at 2,048 characters, and server-level alwaysLoad:false needs 2.1.287. Pin a minimum Claude Code version in the docs and in `prop hub doctor`.
- Defaults of wait_s or timeout_s 240 trigger Claude Code's 2-minute auto-backgrounding in the main conversation. Default to about 110 s, and let only subagents (such as hil-tester) use longer waits.
- Skills-over-MCP is already implemented server-side in the TS SDK v2 (loadSkills) on both protocol eras, so non-Claude MCP hosts could get the skills in phase 0 or 1 at near-zero cost.
- Latency metrics (p50/p99 input-to-client) need hub–node clock-offset estimation. t_device_ms alone cannot be compared across serial and WiFi paths.
- QoS isolation: agent log and event floods and job traffic must not add latency to the game client's input-event path. Use separate WS channels or priorities, and drop log streams before input events under backpressure.
- Mesh HIL: ESP-NOW peers that are also WiFi STAs must share the AP's channel, which constrains HIL bench setup and any future multi-AP layout.
- The dashboard must not use Web Serial or esptool-js while the hub owns the ports. Chrome currently holds /dev/cu.usbmodem1101. Offer browser flashing only as a hub-absent fallback.
- Plugin distribution: a top-level bin/ blocks installation on claude.ai and Cowork, and bin/prop needs Node on PATH. Consider an npm-installed CLI or a single-file binary if those surfaces matter.
### Spec errors
- §7.12.1 bin/prop: `exec node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js"` fails when Claude runs `prop` through the Bash tool or as a monitor, because CLAUDE_PLUGIN_ROOT is not set in those environments. The wrapper must locate itself, e.g. `exec node "$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)/dist/cli.js" "$@"`.
- §7.12.1 monitors.json: the monitor cannot receive hub_url or hub_token. ${user_config.*} is rejected in monitor commands and CLAUDE_PLUGIN_OPTION_* is not exported to them. In LAN mode `prop events --follow` has no token unless prop reads its own config file.
- §7.12.1: the MCP server 'hub' is defined twice, in .mcp.json and inline in plugin.json mcpServers. The later inline one silently replaces the first, so keep a single definition.
- §7.3 and §7.4.7: 'Server instructions ≤ 4,096 characters (Claude Code truncation)' and the 4,096/16,384 description limits apply only from Claude Code 2.1.295/2.1.296. On the installed 2.1.286 the limit is 2,048 for instructions and all tool descriptions.
- §7.11.3 esp-emu invocation: `--elf` without `--no-panic-intercept` makes the emulator stop at the first panic, so 'OTA incl. rollback' on a panicking image cannot exercise the bootloader rollback. It also lacks a per-instance `--efuse` file with a unique MAC (the default 24:0A:C4:00:00:01 makes all sims share one device id). For OTA tests it must pass both ELFs.
- §7.11 T3 and §7.11.1: 'pytest-embedded espemu service for single-DUT' does not cover S3. pytest-embedded-espemu 2.9.3 SUPPORTED_TARGETS excludes esp32s3 and it cannot hard-reset, and `--uart-tcp`/espemu only bridge UART0 while prop_diag uses the USB-Serial/JTAG REPL.
- §7.9.3: 'If no confirm arrives within verify.timeout_s … the bootloader rolls back' is wrong. The bootloader rolls back only on the next reset while the image is PENDING_VERIFY, so the firmware must arm its own timer and call esp_ota_mark_app_invalid_rollback_and_reboot() or restart. The OTA HTTP endpoint also needs CONFIG_ESP_HTTPS_OTA_ALLOW_HTTP if esp_https_ota is used.
- §7.12.2 and §7.14 examples use wait_s:240, timeout_s:240 and `--wait 240`, which contradicts the 2-minute Claude Code auto-background (and the report's own '≤120' risk mitigation). Defaults should be ≤110 s for main-conversation MCP calls.
- §7.5.1 inputs `{device|port}`, `{job_id | job_ids[]}`, `{artifact? | build_id?}` and `{suite? | path? | k?}`: as zod unions these become root-level anyOf in inputSchema, which the Claude API rejects (Claude Code flattens them behind a feature flag or skips the tool). The spec only bans root combinators for output schemas; it must ban them for inputs too.
- §7.3 'createMcpFastifyApp or localhostHostValidation' names the wrong packages: they come from @modelcontextprotocol/fastify and @modelcontextprotocol/node respectively, not @modelcontextprotocol/server. createMcpHandler performs no Host/Origin validation itself.
- §7.4.2/§7.8: the ErrorCode table is missing codes the spec uses elsewhere: HUB_RESTARTED (§7.4.3), ASSERTION_FAILED (exit 6) and HUB_UNREACHABLE (exit 10).
- §7.8 and §7.12.1: the CLI's exit code 2 = usage/INVALID_ARGS collides with Claude Code hook semantics, where exit 2 = block the tool call. In `--hook` mode, `prop policy check` must not reuse the global exit-code map.
- §7.10 fixture wiring example: C6 Super Mini 'dut_pin 15 … led.status'. GPIO15 is a C6 strapping pin with no internal pull that must not float, and many C6 Super Mini variants have only the WS2812 on GPIO8 (also a strapping pin, which must be high for download mode). Sensing a WS2812 data line does not give LED on/off.
- Alternatives table: 'esp-emulator: … Apache-2.0, local and free' is inaccurate. Only the installer, docs and tools repo is Apache-2.0; the emulator core is a closed prebuilt binary (esp-emulator issue #10), installed with a curl|sh script.
- §7.13: Skills-over-MCP is deferred to phase 2 as if it needed custom work, but the TS SDK v2 already ships server support (loadSkills / skills.attach) on both protocol eras.
- §7.12.1 `AGENTS.md → ../../AGENTS.md`: a symlink that escapes the plugin root conflicts with the plugin containment rules and may not survive plugin cache installation (low confidence). Ship a real file instead.
