# MCP and agentic control of physical hardware, focused on the Arduino UNO Q (state as of 8 November 2026)

Method note: GitHub star counts and last-push dates come from the GitHub REST API, retrieved 2026-11-08. Arduino's own MCP implementation was read in source (arduino/arduino-app-lab, arduino/app-bricks-py, arduino/docs-content). Where a claim rests on a search-engine summary rather than a page I read in full, I flag it.

---

## 1. Arduino-specific: official MCP, agent, and LLM features for UNO Q / App Lab, and community MCP servers

### Takeaway
Arduino has shipped official MCP pieces, but none of them is a runtime MCP server that an external agent can use to drive the UNO Q's pins:
- **App Lab "Agent Mode"** (added in 0.10, August 2026; docs current for 0.12, November 2026) runs Claude Code or OpenCode on the host computer. They talk to an in-process `arduino-board` MCP server, which is a development-time tool for apps, bricks, models, Wi-Fi and a gated shell. It is bound to localhost with a per-run token.
- **The "MCP Client" Brick** lets App Lab apps *consume* MCP servers from LLM bricks.

So an MCP server that exposes the UNO Q's GPIO, sensors and actuators has to come from the community or be built yourself. The community options are tiny projects (0–24 stars):
- one OAuth-gated UNO Q LED/matrix example (Volt23)
- one unauthenticated generic ARM-board server (Orbit OS)
- several arduino-cli wrappers that target classic USB boards, not the UNO Q's Linux+MCU split

### Cited Findings

**Official Arduino: App Lab Agent Mode (development-time agent)**
- Announcement: App Lab 0.10 (blog dated 12 Aug 2026) introduced "Agentic Mode", described as "Powered by MCP and integrated with App CLI". It uses Bring-Your-Own-Key, and "Claude is supported at first". — [Arduino blog: App Lab 0.10](https://blog.arduino.cc/2026/08/12/arduino-app-lab-0-10-meet-agentic-mode/)
- Release tags: `al-0.10.0` was published 2026-08-18 and `0.11.0` on 2026-10-23. The docs were updated "for App Lab 0.12" on 2026-11-05. — [arduino/arduino-app-lab releases](https://github.com/arduino/arduino-app-lab/releases); [docs-content commit history](https://github.com/arduino/docs-content/blob/main/content/software/app-lab/8.integrations/4.agent-mode/agent-mode.md)
- Current docs:
  - Agent Mode supports "Claude Code (by Anthropic) and OpenCode as a Preview. Support for Codex is coming soon."
  - "The agent runs where App Lab runs (normally your computer) … Arduino does not host the model."
  - In Connected Mode, "nothing is installed on the board."
  - Source: [App Lab Agent Mode docs](https://docs.arduino.cc/software/app-lab/integrations/agent-mode/) (source: [agent-mode.md](https://github.com/arduino/docs-content/blob/main/content/software/app-lab/8.integrations/4.agent-mode/agent-mode.md))
- What the agent can do:
  - Read and edit App files (a local mirror synced to the board at the end of each turn).
  - Manage Apps, Bricks, models and libraries.
  - Read board status, resources and Wi-Fi.
  - Run shell commands on the board "as a last resort".
  - It "cannot export or import Apps, see your passwords, or read the values of secret Brick variables."
  - Source: [Agent Mode docs](https://docs.arduino.cc/software/app-lab/integrations/agent-mode/)
- Approval model:
  - Read-only actions run without asking. Mutating actions show a card with "Allow once / Always allow / Reject".
  - Shell commands "always ask for approval, show the exact command and the agent's reason, and cannot be set to Always allow."
  - Actions on another App show an "Outside this app" badge, and earlier "Always allow" grants don't apply to them.
  - Claude Code's modes (Default / Accept Edits / Plan / Don't Ask / Bypass Permissions) are exposed.
  - Source: [Agent Mode docs](https://docs.arduino.cc/software/app-lab/integrations/agent-mode/)
- Architecture, from source code:
  - `boardmcp` is "the in-process HTTP MCP server exposing board tools to the agent".
  - It is built on the official Go SDK (`mcp.NewServer(&mcp.Implementation{Name: "arduino-board", Version: "0.1.0"})`).
  - It is served with `NewStreamableHTTPHandler(..., &mcp.StreamableHTTPOptions{Stateless: true})` on `127.0.0.1:0` (random port), behind a per-run 32-byte bearer token compared in constant time.
  - Source: [server.go](https://github.com/arduino/arduino-app-lab/blob/main/standalone-apps/app-lab-desktop/internal/boardmcp/server.go)
- Tool inventory (server.go):
  - **17 read-only tools**, auto-approved: `apps_list, apps_get, apps_checkout, apps_logs, apps_wait_running, board_status, boards_list, wifi_status, wifi_list, bricks_list, bricks_get, app_bricks_list, models_list, models_wait_installed, sketch_libraries_list, system_resources, system_name`.
  - **17 mutating tools**, which need permission: `apps_create/start/stop/delete/edit/clone, app_bricks_add/update/remove, models_delete/install/import_custom, sketch_libraries_add/remove, wifi_connect/disconnect, board_exec`.
  - Read-only tools carry `mcp.ToolAnnotations{ReadOnlyHint: true}`.
  - **No tool reads sensors or writes GPIO or actuators directly.**
  - Source: [server.go](https://github.com/arduino/arduino-app-lab/blob/main/standalone-apps/app-lab-desktop/internal/boardmcp/server.go); [tools_apps.go](https://github.com/arduino/arduino-app-lab/blob/main/standalone-apps/app-lab-desktop/internal/boardmcp/tools_apps.go)
- How tools reach the board: through a `BoardAccess` interface. It calls the board orchestrator base URL ("e.g. http://localhost:8800") and runs `Exec` "on the board over App Lab's existing connection (never the host)". — [access.go](https://github.com/arduino/arduino-app-lab/blob/main/standalone-apps/app-lab-desktop/internal/boardmcp/access.go)
- Security patterns in the code, worth copying:
  - `RequestWiFiConnect` makes the UI open a dialog "so the USER types the password there: it must never reach the agent".
  - `DisconnectWiFi` is "refused when App Lab reaches the board over the network, which would sever the very link the agent works through".
  - Edge Impulse keys stay hidden from the agent ("the agent must never see").
  - Source: [access.go](https://github.com/arduino/arduino-app-lab/blob/main/standalone-apps/app-lab-desktop/internal/boardmcp/access.go)
- The `board_exec` tool:
  - It requires a `reason` argument "shown to the user for approval".
  - Its description steers the model: "LAST RESORT. Prefer the dedicated arduino-board tools".
  - It runs "as the board user (sudo available)".
  - Source: [tools_board_exec.go](https://github.com/arduino/arduino-app-lab/blob/main/standalone-apps/app-lab-desktop/internal/boardmcp/tools_board_exec.go)
  - Policy code: `neverAutoApprovable = {"board_exec": true}`, because "a persistent grant is keyed on the tool name alone, and App Lab can neither list nor revoke it". The native Claude `Bash` and `NotebookEdit` tools are disallowed through session `_meta`. — [toolpolicy.go](https://github.com/arduino/arduino-app-lab/blob/main/standalone-apps/app-lab-desktop/internal/agent/toolpolicy.go)
- Agent hosting:
  - App Lab spawns the agent CLI as an ACP (Agent Client Protocol) subprocess (`claude-agent-acp` adapter, `coder/acp-go-sdk`).
  - The adapter gets an allow-listed environment so "unrelated ambient secrets never reach the agent".
  - "Unanswered permissions deny".
  - The authors call the gating "best-effort, not a hard sandbox".
  - Source: [agent/README.md](https://github.com/arduino/arduino-app-lab/blob/main/standalone-apps/app-lab-desktop/internal/agent/README.md)
  - Minor discrepancy: the README says Edit/Write are disallowed, while toolpolicy.go says they are "allowed but permission-gated" on the app mirror. Treat the code as authoritative.
- Repo maturity: `arduino/arduino-app-lab` has 65 stars, GPL-3.0, last push 2026-11-05. — [GitHub](https://github.com/arduino/arduino-app-lab)

**Official Arduino: the MCP Client Brick (apps consume MCP)**
- "This Brick acts as an MCP **client**". It discovers tools from HTTP `/mcp` endpoints and returns LangChain tools that can be passed to `CloudLLM(tools=...)` or the on-device `LargeLanguageModel(tools=...)`. — [mcp_client README](https://github.com/arduino/app-bricks-py/blob/main/src/arduino/app_bricks/mcp_client/README.md)
- Implementation:
  - Built on `langchain_mcp_adapters.MultiServerMCPClient`, with transport `streamable_http`.
  - Auth is a static bearer `token=`, custom `headers=`, or any `httpx.Auth` (e.g. OAuth).
  - Tool names are prefixed with the endpoint name to avoid clashes.
  - Source: [mcp_client/__init__.py](https://github.com/arduino/app-bricks-py/blob/main/src/arduino/app_bricks/mcp_client/__init__.py)
- An app can bundle its own MCP server as a Docker-backed custom brick (`brick_compose.yaml`) that App Lab deploys alongside the app. Example 02 runs the Docker MCP Gateway. — [mcp_client README](https://github.com/arduino/app-bricks-py/blob/main/src/arduino/app_bricks/mcp_client/README.md)
- Example 03 uses the official Python SDK's FastMCP: `FastMCP("Clock", host="0.0.0.0", port=8080)` with `transport="streamable-http"`, and the client is `CloudLLM(model=CloudModel.GOOGLE_GEMINI, tools=mcp.get_tools())`. The example server has no auth. — [03_with_custom_brick_and_llm](https://github.com/arduino/app-bricks-examples/tree/main/bricks/arduino/mcp_client/03_with_custom_brick_and_llm)

**Official Arduino: running agents directly on the board**
- The "Agentic AI Development on UNO Q" tutorial covers installing OpenCode, Claude Code (`curl -fsSL https://claude.ai/install.sh | bash`) or Codex CLI on the board's Debian.
- It recommends giving the agent `arduino-app-cli` context through `AGENTS.md`.
- For remote access it lists `claude remote-control` / `claude --remote-control`, the OpenCode web UI (HTTP; "use it only on a trusted local network") and `codex remote-control` (experimental).
- Source: [UNO Q AI coding agents tutorial](https://docs.arduino.cc/tutorials/uno-q/ai-coding-agents) (source: [ai-coding-agents.md](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/tutorials/use-cases/ai-coding-agents/ai-coding-agents.md))
- Its security guidance:
  - "The agent has the same permissions as the `arduino` user."
  - The workspace directory "is an organizational boundary, not a security sandbox".
  - Provider credentials sit on the board, so revoke them before transferring it.
  - "ADB is enabled over USB by default, so secure physical access."
  - Tested on: UNO Q 4 GB, Debian 13 trixie, OpenCode 1.17.15, Claude Code 2.1.216, Codex CLI 0.144.6, Arduino App CLI 0.11.1.
  - Source: [ai-coding-agents.md](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/tutorials/use-cases/ai-coding-agents/ai-coding-agents.md)
- Conflict: this tutorial (last commit 2026-10-08) says Agent Mode is "currently only Claude Code". The newer Agent Mode doc (2026-11-06) lists OpenCode Preview as well. The tutorial note is stale. — [ai-coding-agents.md](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/tutorials/use-cases/ai-coding-agents/ai-coding-agents.md) vs [agent-mode.md](https://github.com/arduino/docs-content/blob/main/content/software/app-lab/8.integrations/4.agent-mode/agent-mode.md)
- Arduino blog series on local agents (June 2026): OpenClaw orchestrates and Ollama hosts a local model, turning the "UNO Q [into an] autonomous AI node". MCP is not mentioned. Recommended mitigation: an isolated "hardware sandbox" device. — [Arduino blog: Local AI agents on UNO Q (9 Jun 2026)](https://blog.arduino.cc/2026/06/09/local-ai-agents-on-arduino-uno-q/); [Beyond Edge AI (5 Jun 2026)](https://blog.arduino.cc/2026/06/05/beyond-edge-ai-bringing-local-intelligence-to-arduino-uno-q/)
- Code search: `arduino/arduino-app-cli` (36 stars, last push 2026-11-06) contains no MCP server. A search for "mcp" returned only unrelated files such as system-resources handlers. — [arduino/arduino-app-cli](https://github.com/arduino/arduino-app-cli)

**Community MCP servers specific to the UNO Q**
- **Volt23/uno-q-mcp-blink-ai** (1 star, created and last pushed 2026-04-20) — [GitHub](https://github.com/Volt23/uno-q-mcp-blink-ai)
  - An "OAuth-gated remote MCP server on an Arduino UNO Q", deployed as an App Lab app through `arduino-app-cli`: FastAPI plus FastMCP, with a built-in OAuth 2.1 server (PKCE, a DCR shim, RS256 JWTs with 1-hour expiry).
  - It is exposed through Tailscale Funnel or Cloudflare Tunnel and talks msgpack-RPC over the Router Bridge to an STM32 sketch.
  - Tools: `leds_read, led_set, leds_all, leds_off, matrix_draw, matrix_clear, matrix_marquee, matrix_stop, board_info`.
  - Its rationale: "Real MCP clients only speak OAuth 2.1 with PKCE + DCR. A raw bearer won't even register."
  - "Tested with: Claude.ai, VS Code Copilot, Cursor, Zed, MCP Inspector."
- **OrbitOS-org/orbit-os-app-mcp-server** (0 stars, created 2026-10-02, last push 2026-10-03) — [GitHub](https://github.com/OrbitOS-org/orbit-os-app-mcp-server); [mcp.so submission #5077](https://github.com/chatmcp/mcpso/issues/5077)
  - A Go app with 84 tools over Streamable HTTP (`http://<DEVICE_IP>:9999/mcp`). It requires the Orbit OS distribution, not stock Arduino Debian.
  - Coverage: GPIO, I²C scan/transfer, SPI transfer, UART, PWM, Wi-Fi, Ethernet, Bluetooth, packages, and power/updates (reboot, shutdown, OTA, factory reset).
  - It warns: "The MCP endpoint has **no authentication**: anyone on the same network can call every tool, including reboot, shutdown, OTA install and factory reset."
- **general-rishkin/arduino-uno-q-mcp-mpu-with-cpp** (1 star, 2026-09-14): despite the name, the README describes only a basic CMake C++ project, with no MCP content. — [GitHub](https://github.com/general-rishkin/arduino-uno-q-mcp-mpu-with-cpp)

**Community Arduino MCP servers (classic boards; mostly arduino-cli wrappers)**

| Repo | Stars / last push | Tools (what it exposes) | Source |
|---|---|---|---|
| hardware-mcp/arduino-mcp-server (npm `arduino-mcp-server`) | 24 / 2026-08-22 | 21 tools: compile/upload, `upload_and_wait_ready`, stateful serial sessions (`serial_open_session`, `serial_expect`, …), `safety_preflight` electrical checks (blocking `BATTERY_CRATE_UNSAFE` above 1C, `BATTERY_POLARITY_UNCONFIRMED`), board-reference resources | [GitHub](https://github.com/hardware-mcp/arduino-mcp-server) |
| Oliver0804/arduino-cli-mcp | 13 / 2026-05-16 | 15 tools (compile, upload, libraries, `diagnose_error`, `monitor`), `autoApprove` config list | [GitHub](https://github.com/oliver0804/arduino-cli-mcp) |
| AimanMadan/Arduino_MCP_Server | 13 / 2025-06-17 (stale) | — | [GitHub](https://github.com/AimanMadan/Arduino_MCP_Server) |
| amahpour/arduino-mcp-server-simple | 6 / 2026-03-25 | — | [GitHub search result](https://github.com/amahpour/arduino-mcp-server-simple) |
| BufrAI/arduino-mcp | 0 / 2026-11-04 (created 2026-09-01) | stdio; `board_list, core_install, lib_install, compile, upload, serial_open/read/write/close/status`; warns "treat it as a privileged local tool" | [GitHub](https://github.com/BufrAI/arduino-mcp) |
| biyusku/arduino-mcp (npm `arduino-mcp`) | 0 / 2026-10-12 | 42 tools (AVR/ESP32/RP2040); "no shell, no sudo/chmod … destructive tools are annotated"; `erase_flash`, `wifi_upload` OTA | [GitHub](https://github.com/biyusku/arduino-mcp) |
| abhishekmallav/Arduino-MCP | 1 / 2026-01-11 | Python agent plus non-blocking firmware with "intent-based control" | [GitHub](https://github.com/abhishekmallav/Arduino-MCP) |
| dido18/arduino-mcp-server (Go) | 2 / 2025-04-10 (stale) | — | [GitHub search](https://github.com/dido18/arduino-mcp-server) |

- Serial-port MCP servers:
  - JustFady/mcp-serial (0 stars, 2026-10-16): flashing "is gated behind an explicit `confirm=true` and an allow-listed firmware directory". Tools run "with argument lists, never through a shell". — [GitHub](https://github.com/JustFady/mcp-serial)
  - HumbertoBernal/mcp-serial (1 star, 2026-08-30). — [GitHub](https://github.com/HumbertoBernal/mcp-serial)
  - umair-as/mcp-serial-rs (1 star, 2026-10-27; Rust, stdio). — [GitHub search](https://github.com/umair-as/mcp-serial-rs)
- Arduino Cloud: a forum thread "Talk to your Arduino Cloud with Claude" announces `mcp-server-arduino-cloud` (npm). I could not open it (HTTP 403), so authorship and tools are unverified. — [Arduino Forum](https://forum.arduino.cc/t/talk-to-your-arduino-cloud-with-claude/1385826)
- A GitHub search for "firmata mcp" returned no repositories. — GitHub search, 2026-11-08 (no result to link)

### Inferences
- Arduino's official MCP investment so far is about **AI-assisted building of App Lab apps** (Agent Mode) and **apps calling MCP tools** (MCP Client Brick). An MCP-first *runtime* control architecture for the UNO Q, where an external agent reads sensors and drives actuators, is still a do-it-yourself space. The most useful templates are:
  - Volt23 (FastMCP + OAuth + Bridge RPC + tunnel)
  - Arduino's own `boardmcp` (Go SDK, stateless Streamable HTTP, a read-only/mutating split, a never-auto-approve shell, secrets kept out of model context)
- Arduino-cli wrappers assume a USB-attached MCU flashed from the host. On the UNO Q, the board-native path is `arduino-app-cli` plus the Bridge, so those wrappers transfer poorly without changes.
- The MCP Client Brick together with the local `LargeLanguageModel` brick means a fully on-board loop (local LLM → MCP tools → Bridge → STM32) is possible with official parts. With the default Qwen 3.5 0.8B the loop is slow (see section 6).

### Gaps
- I found no Qualcomm-published MCP server or agent integration for the UNO Q or its QRB2210 SoC. A Qualcomm developer blog search turned up nothing MCP-specific.
- App Lab 0.11 and 0.12 release notes were not read in full. The docs commit says the docs were updated for 0.12, but GitHub release tags show 0.11.0 as the latest, so whether 0.12 has shipped is unconfirmed.
- No Hackster.io project specifically pairing the UNO Q with MCP was found.
- I did not find whether Arduino plans to expose `arduino-board` MCP to external clients.

---

## 2. General hardware MCP servers (GPIO/serial/I²C, Raspberry Pi, ESP32, ROS, Home Assistant, PLC/Modbus): projects and patterns

### Takeaway
- **Mature:** ROS (ros-mcp-server, about 1.5k stars) and Home Assistant (a built-in core integration).
- **Official Espressif tooling:**
  - host-side ESP-IDF, docs and RainMaker MCP servers
  - an on-chip `espressif/mcp-c-sdk` component that speaks Streamable HTTP
- **Huge on ESP32:** xiaozhi-esp32 (about 33k stars, "MCP-based chatbot").
- **Thin or immature:** generic GPIO/I²C, PLC/Modbus and Raspberry Pi MCP servers (0–5 stars).

Recurring patterns:
- discovery-first tools (list topics, entities or pins, then act)
- capability scoping through an "exposed entities" set or read-only mode
- stateful sessions or handles for serial or streams
- explicit `confirm` arguments for destructive operations
- intent-level tools, not raw registers
- MQTT as an alternative transport for flaky device networks

### Cited Findings

**ROS / robotics**
- **robotmcp/ros-mcp-server** (1,518 stars; last push 2026-11-08; release v3.1.2 on 2026-09-23; Apache-2.0)
  - It works by adding "the `rosbridge` node to your existing ROS setup", with "no changes to existing robot source code", across ROS 2 (Jazzy, Humble) and ROS 1.
  - Capabilities: topic publish/subscribe, services, actions, parameters, and discovery of topic/service types, including custom ones.
  - Clients: Claude Code/Desktop, Codex, Gemini CLI, ChatGPT, Cursor.
  - Demos: an industrial-robot diagnosis, Gemini driving "Wilson" (Nav2 + MoveIt), and Claude driving a simulated Unitree Go2 in Isaac Sim.
  - No safety features are described.
  - Source: [GitHub](https://github.com/robotmcp/ros-mcp-server)
  - Tool modules in the repo: `ros_mcp/tools/{topics,services,actions,parameters,nodes,images,connection,robot_config}.py`. — [GitHub code](https://github.com/robotmcp/ros-mcp-server/tree/main/ros_mcp/tools)
- Yutarop/ros-mcp: 36 stars, last push 2025-08-19 (stale). — [GitHub](https://github.com/Yutarop/ros-mcp)

**Home Assistant**
- The Home Assistant core MCP Server integration (since 2025.2) exposes `/api/mcp` with OAuth 2.0 + PKCE and Client ID Metadata Documents.
- **Capability scoping:** the "Device control" tool set reaches only entities exposed to voice assistants. The "Home Assistant" tool set needs an admin account. Options include a "read-only mode".
- Resources: a read-only `homeassistant://assist/context-snapshot` via `GetLiveContext`.
- "Sampling and notifications are not supported."
- Cloud agents need the instance internet-reachable.
- Source: [Home Assistant MCP Server docs](https://www.home-assistant.io/integrations/mcp_server/)
- Community: Coolver/home-assistant-vibecode-agent (654 stars, 2026-10-21) and robbrad/homeassistant-mcp (106 stars, 2026-05-05). — [GitHub](https://github.com/Coolver/home-assistant-vibecode-agent); [GitHub](https://github.com/robbrad/homeassistant-mcp)

**ESP32 / Espressif**
- Official host-side servers:
  - the ESP-IDF Tools local MCP server (stdio, built into `idf.py`, part of ESP-IDF 6.0)
  - the Espressif Documentation MCP server (remote)
  - the ESP RainMaker MCP server (stdio, bridges to the RainMaker cloud)
  - Source: [Espressif: ESP-IDF Tools MCP server (Apr 2026)](https://developer.espressif.com/blog/2026/04/esp-idf-tools-mcp-server/); [Espressif docs MCP](https://developer.espressif.com/blog/2026/04/doc-mcp-server/); [RainMaker MCP (Jul 2025)](https://developer.espressif.com/blog/2025/07/esp-rainmaker-mcp-server/); [Hackster on ESP-IDF 6.0](https://www.hackster.io/news/espressif-s-esp-idf-6-0-brings-a-new-installation-manager-mcp-server-and-a-new-standard-c-library-b4258de71662)
- On-chip MCP: the `espressif/mcp-c-sdk` component. v2.0.0 is listed with Streamable HTTP, tools, resources, prompts, completions and tasks. This comes from a search summary of the registry page and was not read in full. — [ESP Component Registry mcp-c-sdk v2.0.0](https://components.espressif.com/components/espressif/mcp-c-sdk/versions/2.0.0/readme); [ESP-IoT-Solution MCP docs](https://docs.espressif.com/projects/esp-iot-solution/en/latest/ai/mcp.html)
- **78/xiaozhi-esp32**: 32,895 stars, last push 2026-11-07, describes itself as "An MCP-based chatbot". From memory, not verified this session: devices expose local tools (volume, LEDs, servos) through MCP to a cloud voice backend. — [GitHub](https://github.com/78/xiaozhi-esp32)
- **MCP over MQTT (EMQX)**
  - EMQX proposes MCP over MQTT, using an external proxy, an internal EMQX proxy, or native device MCP servers. EMQX claims better reliability on weak networks (a vendor claim).
  - The EMQX MCP Bridge lets plain-MQTT devices have their MCP tools implemented in the broker plugin.
  - There is an ESP-IDF MCP-over-MQTT component.
  - Source: [EMQX blog: MCP over MQTT](https://www.emqx.com/en/blog/mcp-over-mqtt); [EMQX MCP Bridge docs](https://docs.emqx.com/en/emqx/latest/emqx-ai/mcp-bridge/overview.html); [esp-mcp-over-mqtt component](https://components.espressif.com/components/mqtt-ai/esp-mcp-over-mqtt/versions/0.0.1); [emqx/esp32-mcp-mqtt-tutorial (27 stars, 2025-08-25)](https://github.com/emqx/esp32-mcp-mqtt-tutorial)
- Smaller ESP-IDF agent loops: cmd0s/esp32-ai-loop-mcp-server (9 stars, an "Autonomous compile-flash-observe loop") and Maty403/esp-idf-mcp (1 star, 2026-11-05). — [GitHub](https://github.com/cmd0s/esp32-ai-loop-mcp-server); [GitHub](https://github.com/Maty403/esp-idf-mcp)

**Generic GPIO/I²C/Raspberry Pi**
- GitHub searches for "mcp gpio", "raspberry pi mcp gpio" and "mcp i2c" (for MCP servers, not MCP23017 chips) returned no notable repositories. The most complete GPIO/I²C/SPI/UART/PWM server found is the Orbit OS one above, which has no auth. — GitHub search 2026-11-08; [Orbit OS MCP server](https://github.com/OrbitOS-org/orbit-os-app-mcp-server)

**PLC / Modbus / industrial**
- Candidates found:
  - fieldworks-build/fieldworks-adapters (0 stars, 2026-08-06): a Rust workspace with `mqtt-mcp, opcua-mcp, modbus-mcp, dnp…`
  - kamalsingh-engg/mcp-plc-bridge (5 stars, 2026-09-19)
  - Maxkrempl/mcp-plc-core (0 stars)
- All are immature. — [GitHub search](https://github.com/fieldworks-build/fieldworks-adapters); [GitHub](https://github.com/kamalsingh-engg/mcp-plc-bridge)

**C/C++ MCP libraries (relevant to MCU or native daemons)**
- There is no official C/C++ SDK (see section 3). Community libraries: hkr04/cpp-mcp (343 stars, 2026-10-21), GopherSecurity/gopher-mcp (154 stars), Qihoo360/TinyMCP (106 stars, 2026-11-06). — [GitHub](https://github.com/hkr04/cpp-mcp); [GitHub](https://github.com/GopherSecurity/gopher-mcp); [GitHub](https://github.com/Qihoo360/TinyMCP)

**Observed design patterns (from the servers above)**
- **Discover, then act:** ROS topic/type discovery ([ros-mcp-server](https://github.com/robotmcp/ros-mcp-server)); HA exposes only voice-assistant entities ([HA](https://www.home-assistant.io/integrations/mcp_server/)); board pin-reference resources ([hardware-mcp](https://github.com/hardware-mcp/arduino-mcp-server)).
- **Stateful session handles for streams:**
  - `serial_open_session` / `serial_expect` ([hardware-mcp](https://github.com/hardware-mcp/arduino-mcp-server))
  - `read_lines(port, max_lines, after_seq, grep, wait_seconds)`: sequence-numbered paging of a background capture buffer, the practical "streaming" pattern ([JustFady/mcp-serial](https://github.com/JustFady/mcp-serial))
- **Explicit-intent arguments:** `confirm=true` ([JustFady](https://github.com/JustFady/mcp-serial)); a required `reason` on the shell tool ([App Lab board_exec](https://github.com/arduino/arduino-app-lab/blob/main/standalone-apps/app-lab-desktop/internal/boardmcp/tools_board_exec.go)).
- **Last-commanded-state read tools:** `leds_read` returns "Last-commanded state" ([Volt23](https://github.com/Volt23/uno-q-mcp-blink-ai)).
- **Snapshot resources for state:** `homeassistant://assist/context-snapshot` ([HA](https://www.home-assistant.io/integrations/mcp_server/)).

### Inferences
- For sensor streaming, real projects avoid long-lived server-push. They use pull-based "read since sequence N" tools, or snapshot resources. This fits the 2026-07-28 spec, which removed SSE resumability and moved subscriptions to `subscriptions/listen` (section 3).
- ROS-style "generic pass-through" servers (publish any topic) maximize flexibility but give the agent raw actuator access. HA-style curated, scoped tool sets are the safer template for a UNO Q.

### Gaps
- No independent benchmark of ESP32 on-chip MCP (RAM/flash footprint of `mcp-c-sdk`) was found.
- I did not verify xiaozhi-esp32's exact MCP transport or architecture this session.
- No Modbus/PLC MCP server with meaningful adoption was found. This may reflect search limits or real immaturity.

---

## 3. MCP spec state as of late 2026, features relevant to hardware, SDKs, and lightweight frameworks

### Takeaway
The current specification is **2026-07-28**. It finalized on schedule after a release candidate on 21 May 2026, and it is a major revision:
- **stateless:** no initialize handshake and no `Mcp-Session-Id`
- `server/discover`
- **Multi Round-Trip Requests** (MRTR) replace server-initiated elicitation, sampling and roots
- **Tasks** moved to an official extension with polling
- `subscriptions/listen` replaces `resources/subscribe`
- SSE resumability removed
- **Roots, Sampling and Logging deprecated**; HTTP+SSE deprecated; Dynamic Client Registration deprecated in favour of Client ID Metadata Documents

Tier 1 SDKs: TypeScript, Python, C#, Go, Rust and Ruby. There is no official C/C++ SDK. For a small ARM Linux box, Go (the SDK Arduino itself uses) and Rust give single static binaries. Python (official SDK including FastMCP) has the best ecosystem fit with App Lab's Python bricks.

### Cited Findings
- Release: the 2026-07-28 specification is final, after a release candidate. — [MCP blog: The 2026-07-28 Specification](https://blog.modelcontextprotocol.io/posts/2026-07-28/); [RC post](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/)
- Major changes, from the official changelog:
  - Sessions removed (SEP-2567). "Cross-call state uses server-minted handles passed as tool arguments."
  - Initialize handshake removed. Each request carries protocol version and capabilities in `_meta` (SEP-2575).
  - `server/discover` MUST be implemented.
  - `subscriptions/listen` replaces the HTTP GET endpoint and `resources/subscribe`/`unsubscribe`.
  - `ping` and `logging/setLevel` removed.
  - Tasks moved to the `io.modelcontextprotocol/tasks` extension (SEP-2663), with polling `tasks/get` and a new `tasks/update`.
  - MRTR (SEP-2322): servers return `InputRequiredResult`, and clients retry with `inputResponses`.
  - `resultType` is required.
  - No SSE resumability: "A broken stream loses the in-flight request".
  - Source: [2026-07-28 changelog](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/changelog.mdx)
- Minor changes:
  - An `extensions` capability field.
  - OpenTelemetry trace context in `_meta` (SEP-414).
  - Deterministic `tools/list` order.
  - Streamable HTTP POST requires `Mcp-Method` and `Mcp-Name` headers, and `x-mcp-header` maps parameters to headers (SEP-2243).
  - `ttlMs`/`cacheScope` on list results.
  - RFC 9207 `iss` validation.
  - Credentials bound to their issuing authorization server.
  - JSON Schema 2020-12 for input/output schemas, and `structuredContent` can be any JSON value.
  - Source: [changelog](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/changelog.mdx)
- Deprecations:
  - Roots, Sampling and Logging (SEP-2577). Suggested replacements: tool parameters, direct LLM provider APIs, stderr/OpenTelemetry.
  - HTTP+SSE transport (SEP-2596).
  - OAuth Dynamic Client Registration, in favour of Client ID Metadata Documents.
  - A 12-month minimum deprecation window.
  - Source: [changelog](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/changelog.mdx)
- The Tools page (2026-07-28):
  - "there **SHOULD** always be a human in the loop with the ability to deny tool invocations"
  - Applications SHOULD "Present confirmation prompts to the user for operations"
  - "clients **MUST** consider tool annotations to be untrusted unless they come from trusted servers"
  - Servers MUST "Validate all tool inputs; Implement proper access controls; Rate limit tool invocations; Sanitize tool outputs"
  - Clients SHOULD prompt for confirmation on sensitive operations, "Implement timeouts for tool calls" and "Log tool usage for audit purposes"
  - A tool may answer `tools/call` with `resultType: "input_required"` carrying an `elicitation/create` form request, which is how server-driven confirmation works under MRTR.
  - The non-normative "Stateful Tools" section recommends opaque, high-entropy, bounded-lifetime handles, with authorization re-validated on every call.
  - `outputSchema` plus `structuredContent` (servers MUST conform; clients SHOULD validate).
  - `isError: true` for tool execution errors, so the model can self-correct.
  - Source: [MCP spec 2026-07-28: Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
- Tool annotation fields in practice: Arduino's server uses `mcp.ToolAnnotations{ReadOnlyHint: true}` (Go SDK). — [App Lab boardmcp](https://github.com/arduino/arduino-app-lab/blob/main/standalone-apps/app-lab-desktop/internal/boardmcp/tools_board.go). Biyusku's server marks destructive tools as "annotated". — [biyusku/arduino-mcp](https://github.com/biyusku/arduino-mcp)
- Official SDK tiers (2026-07-28 docs):
  - Tier 1: TypeScript, Python, C#, Go, Rust, Ruby
  - Tier 2: Java
  - Tier 3: Swift, PHP, Kotlin
  - Source: [MCP SDKs page](https://modelcontextprotocol.io/docs/2026-07-28/sdk.md)
  - No C or C++ SDK is listed. — [MCP SDKs page](https://modelcontextprotocol.io/docs/2026-07-28/sdk.md)
  - Third-party reporting says Rust moved to Tier 1 on 21 Aug 2026, and that Go's 2026-07-28 support was in pre-release (v1.7.0-pre.1) at launch. Not verified against SDK changelogs. — [digitalapplied.com](https://www.digitalapplied.com/blog/mcp-sdk-conformance-tiers-what-tier-1-means); [MCP blog: SDK betas](https://blog.modelcontextprotocol.io/posts/sdk-betas-2026-07-28/)
- FastMCP on the board: Arduino's own example uses `from mcp.server.fastmcp import FastMCP`, the FastMCP bundled in the official Python SDK, with `transport="streamable-http"`. — [app-bricks-examples server.py](https://github.com/arduino/app-bricks-examples/tree/main/bricks/arduino/mcp_client/03_with_custom_brick_and_llm). Volt23's UNO Q server also uses FastMCP inside FastAPI. — [Volt23](https://github.com/Volt23/uno-q-mcp-blink-ai)
- Arduino's Go server runs `StreamableHTTPOptions{Stateless: true}`, already aligned with the stateless direction of 2026-07-28. — [server.go](https://github.com/arduino/arduino-app-lab/blob/main/standalone-apps/app-lab-desktop/internal/boardmcp/server.go)

### Inferences
- Hardware implications of 2026-07-28:
  - **Long actuator operations:** don't rely on a held-open stream (no resumability). Use the Tasks extension (return a task handle, the client polls `tasks/get`) or a hand-rolled "start job, return job_id, poll" tool.
  - **Exclusive control of an actuator or MCU:** model it as an explicit handle or lease returned by a tool. The protocol no longer has sessions.
  - **Server-enforced confirmation:** MRTR plus a form elicitation lets the *server* (on the UNO Q) demand confirmation for dangerous calls, independent of the client's own permission UI. Support varies by client, so keep a fallback such as a `confirm` argument or a physical button.
  - **Sensor change notifications:** these go through `subscriptions/listen`. Polling tools remain the most portable choice, because client support for subscriptions varies.
  - **Sampling is deprecated**, so an on-board server should not depend on borrowing the client's LLM. Call a provider API directly, or use the on-board LLM brick.
  - **`Mcp-Name` headers** let a reverse proxy or WAF in front of the board filter or rate-limit by tool name without parsing JSON bodies.
- SDK choice for the UNO Q's Linux side:
  - Go: Tier 1, what Arduino uses, a single static binary, an easy cross-compile to arm64.
  - Python: Tier 1, matches App Lab bricks and the `arduino.app_utils` Bridge API.
  - Rust (`rmcp`): Tier 1, smallest footprint.
  - TypeScript: needs Node, which App Lab already installs on the host for agents, but this is heavier on a 2 GB board.

### Gaps
- No measured memory footprints for the Python SDK/FastMCP, Go SDK, Rust `rmcp` or TypeScript servers on an arm64 SBC were found. Benchmark on the device.
- I did not fetch the full 2026-07-28 schema to re-confirm the annotation field names `destructiveHint`, `idempotentHint` and `openWorldHint`. They exist in earlier revisions (from 2025-03-26), and the Tools page still defines `annotations`.
- How much MRTR elicitation and the Tasks extension are supported in Claude Desktop/Code, ChatGPT and Cursor as of November 2026 was not verified.

---

## 4. Deployment topologies for the UNO Q, remote access, auth, and security implications

### Takeaway
Four topologies exist, all with real examples:

| | Topology | Example |
|---|---|---|
| A | MCP server on the UNO Q's Linux side, agent remote | Volt23, Orbit OS |
| B | Agent on the board | Claude Code / OpenCode / OpenClaw on Debian; App Lab LLM brick with local Qwen; MCP Client Brick + Cloud LLM |
| C | Development-time agent on the host, reaching the board through App Lab's own channel | App Lab Agent Mode |
| D | MCU exposing MCP directly | ESP32 `mcp-c-sdk`; the UNO Q's STM32 has no network of its own, so this is not directly applicable |

The key constraint for topology A: claude.ai, Desktop, Cowork and mobile custom connectors call the server **from Anthropic's cloud**. The server therefore needs a public HTTPS endpoint (a tunnel) and, in practice, OAuth 2.1. Claude Code and Desktop local configs can reach a server on the LAN.

### Cited Findings
- Cloud-originated connectors: "Claude connects to your remote MCP server from Anthropic's cloud infrastructure, rather than from your local device … your MCP server must be reachable over the public internet from Anthropic's IP ranges."
  - For private networks: "allowlist Anthropic's IP addresses".
  - Local servers in `claude_desktop_config.json` "do use your local network, but those aren't available in Cowork or claude.ai."
  - "Free users are limited to one custom connector."
  - Source: [Claude Help Center: connectors](https://support.claude.com/en/articles/11175166-getting-started-with-connectors-on-claude-ai)
- Topology A with a public tunnel: Volt23 uses Tailscale Funnel or Cloudflare Tunnel to `localhost:7000`, with OAuth 2.1 + PKCE + DCR implemented in-app ("~260 lines of Python"), RS256 JWTs with `aud` bound to the resource URL and 1-hour expiry. It worked with Claude.ai. — [Volt23/uno-q-mcp-blink-ai](https://github.com/Volt23/uno-q-mcp-blink-ai)
- Topology A on the LAN with no auth: the Orbit OS server is configured as `claude mcp add --transport http orbit-os http://<DEVICE_IP>:9999/mcp`, and "anyone on the same network can call every tool". — [Orbit OS MCP server](https://github.com/OrbitOS-org/orbit-os-app-mcp-server)
- Topology B, agent on the board:
  - Claude Code can be installed on the UNO Q and driven with `claude remote-control`, continuing from claude.ai/code or the mobile app. "Claude Code and Codex use account-linked remote-control services", whereas OpenCode's web UI is direct HTTP.
  - Credentials then live on the board.
  - Source: [UNO Q AI coding agents tutorial](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/tutorials/use-cases/ai-coding-agents/ai-coding-agents.md)
- The same tutorial offers a host-side alternative: the agent runs on the PC and routes commands over ADB or SSH, "to save memory, keep your API keys strictly on your computer". — [tutorial](https://github.com/arduino/docs-content/blob/main/content/hardware/uno/boards/uno-q/tutorials/use-cases/ai-coding-agents/ai-coding-agents.md)
- Topology B with a local model: App Lab's LLM brick talks to a llama.cpp server on the board (port 9999, OpenAI-compatible). The default model is `Qwen3.5-0.8B-Q4_0` and "needs close to a gigabyte"; the test used a 4 GB UNO Q. — [Mischianti, UNO Q local AI agent (4 Nov 2026)](https://mischianti.org/?p=36049)
- Topology B with MCP inside an app: MCP Client Brick + CloudLLM/LargeLanguageModel, with an MCP server bundled as a Docker brick on the app's compose network (`http://mcp-server:8080/mcp`). — [mcp_client README](https://github.com/arduino/app-bricks-py/blob/main/src/arduino/app_bricks/mcp_client/README.md)
- Topology C: App Lab's MCP server listens on `127.0.0.1` (host) with a per-run bearer token. Tools reach the board via the orchestrator and App Lab's connection. — [server.go](https://github.com/arduino/arduino-app-lab/blob/main/standalone-apps/app-lab-desktop/internal/boardmcp/server.go); [access.go](https://github.com/arduino/arduino-app-lab/blob/main/standalone-apps/app-lab-desktop/internal/boardmcp/access.go)
- Topology D (MCU-native MCP): Espressif's `mcp-c-sdk` runs an MCP server on ESP32 over Streamable HTTP (registry listing, search summary). EMQX's MCP over MQTT targets constrained or flaky device networks. — [mcp-c-sdk](https://components.espressif.com/components/espressif/mcp-c-sdk/versions/2.0.0/readme); [EMQX](https://www.emqx.com/en/blog/mcp-over-mqtt)
- How MCU tools are reached on the UNO Q (Volt23): "`arduino-app-cli` handles the sketch build + MCU flash + Router Bridge socket we talk msgpack-RPC to from Python". — [Volt23](https://github.com/Volt23/uno-q-mcp-blink-ai)
- Home Assistant mirrors the cloud-reachability issue: "Cloud-hosted agents need your instance reachable from the internet". — [HA MCP Server](https://www.home-assistant.io/integrations/mcp_server/)
- Arduino's guidance for on-board agents is a dedicated "hardware sandbox" device with limited permissions, not a personal laptop. — [Arduino blog, 9 Jun 2026](https://blog.arduino.cc/2026/06/09/local-ai-agents-on-arduino-uno-q/)

### Inferences
- Suggested default for an MCP-first UNO Q design:
  - Topology A: an MCP server on the Linux side, written in Go or Python, that reaches the STM32 only through the Bridge.
  - Bind to localhost or the LAN, plus Tailscale (tailnet-only) for Claude Code/Desktop.
  - Use Tailscale Funnel or Cloudflare Tunnel plus OAuth 2.1 only when claude.ai/mobile connectors are needed.
- Exposing actuators through a public tunnel makes the board reachable from Anthropic's IP ranges and, if auth is misconfigured, from the internet. Orbit OS's no-auth design is acceptable only on an isolated bench network.
- Topology D is not native to the UNO Q: the STM32 is not network-attached (MCU/bridge internals are covered by another researcher). MCU-side enforcement still matters as a safety layer below MCP (section 5).
- Topology B with a 0.8B local model is viable for slow, simple decisions (thermostat-style), not for interactive, multi-step control (section 6).

### Gaps
- I did not find Anthropic's official IP-range page contents. A third-party blog cites 160.79.104.0/21, unverified.
- No benchmark compares round-trip latency of Claude Code over LAN with claude.ai over a tunnel to a UNO Q MCP server.
- I found no documentation of mTLS or tailnet-identity patterns specifically for MCP on SBCs.

---

## 5. Safety and reliability patterns for agentic physical control

### Takeaway
The spec states the baseline: human-in-the-loop, annotations are untrusted hints, and servers MUST validate, rate-limit and access-control. Practitioners converge on a layered model: **"The model proposes, the code limits, the MCU has the last word."** In practice:
- curated, intent-level tools (never "write any pin")
- server-side validation and rate limits
- a read-only/mutating split with gated confirmation; shells and flashing never auto-approved
- secrets kept out of model context
- MCU-level interlocks and watchdogs that hold without Linux

Research in 2026 shows prompt injection via user input, perception and tool chains reaching unsafe actuation. The core architectural gap identified is "the absence of independent semantic validation between user input and actuator dispatch".

### Cited Findings
- Spec rules (human-in-the-loop, untrusted annotations, server MUST validate/rate-limit/access-control/sanitize, client SHOULD confirm, timeouts, audit logs): see section 3. — [MCP Tools spec 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
- Layered UNO Q pattern from a working tutorial (LLM brick + Bridge):
  - "The model proposes, the code limits, the STM32 has the last word."
  - Python tools validate before `Bridge.call`, including a rate limit `MIN_SWITCH_S = 60`.
  - STM32 reflex: above 45 °C the fan runs regardless of Linux.
  - Watchdog: "If the heartbeat stops for 2 s, the sketch becomes a 35 °C thermostat."
  - Refusals are returned as text so the model can explain them.
  - "Never give the model a tool that writes a pin directly."
  - Safe state is actuator-specific ("safe means on" for a fan).
  - Keep slow model work out of the heartbeat loop.
  - Source: [Mischianti, UNO Q local AI agent (Nov 2026)](https://mischianti.org/?p=36049)
- Arduino App Lab's production patterns:
  - read-only tools auto-approved, mutating ones need permission
  - `board_exec` can never be "Always allow" and requires a `reason`
  - Wi-Fi passwords and Edge Impulse keys never reach the agent
  - grants are scoped per App ("Outside this app" resets them)
  - unanswered permission requests deny
  - an environment allow-list for the agent process
  - Source: [Agent Mode docs](https://docs.arduino.cc/software/app-lab/integrations/agent-mode/); [toolpolicy.go](https://github.com/arduino/arduino-app-lab/blob/main/standalone-apps/app-lab-desktop/internal/agent/toolpolicy.go); [access.go](https://github.com/arduino/arduino-app-lab/blob/main/standalone-apps/app-lab-desktop/internal/boardmcp/access.go); [agent README](https://github.com/arduino/arduino-app-lab/blob/main/standalone-apps/app-lab-desktop/internal/agent/README.md)
- Capability scoping: Home Assistant's MCP limits device control to exposed entities, offers read-only mode, and requires admin for full access. — [HA](https://www.home-assistant.io/integrations/mcp_server/)
- Explicit intent gates: `confirm=true` plus an allow-listed firmware directory, with tools run without a shell. — [JustFady/mcp-serial](https://github.com/JustFady/mcp-serial)
- Electrical preflight as a tool: hardware-mcp's `safety_preflight` (hard-blocking `BATTERY_CRATE_UNSAFE`, `BATTERY_POLARITY_UNCONFIRMED`) is also passed as `safetyContext` to upload and serial_write. — [hardware-mcp/arduino-mcp-server](https://github.com/hardware-mcp/arduino-mcp-server)
- Anti-pattern: a no-auth endpoint exposing reboot, OTA and factory reset. — [Orbit OS](https://github.com/OrbitOS-org/orbit-os-app-mcp-server)
- Threat modelling (arXiv 2604.27267, PST2026; Nagaraja, Bahsi, da Cunha):
  - STRIDE analysis of an edge-cloud LLM robot, with three attack chains to unsafe actuation.
  - Weaknesses identified: "the absence of independent semantic validation between user input and actuator dispatch", unguarded perception-to-instruction translation, and provider-side tool use crossing trust boundaries without mediation.
  - Source: [arXiv:2604.27267](https://arxiv.org/abs/2604.27267)
- Injection via perception and multi-agent systems: "When Prompts Control Robots" (arXiv 2608.00747, Aug 2026) reports direct and perception-based indirect injection inducing adversarial actions. Physical prompt injection: "Hijacking Robots with a Piece of Paper" (arXiv 2608.05715). Sensor-vector injection on ROS 2: "RIPA" (arXiv 2606.28649). Only titles and abstracts or search summaries were seen for the last two. — [arXiv:2608.00747](https://arxiv.org/abs/2608.00747); [arXiv:2608.05715](https://arxiv.org/pdf/2608.05715); [arXiv:2606.28649](https://arxiv.org/pdf/2606.28649)
- A survey of embodied-agent security (arXiv 2608.16843) catalogs attacks and defenses. — [arXiv:2608.16843](https://arxiv.org/pdf/2608.16843)
- **RoboGuard** ("Safety Guardrails for LLM-Enabled Robots", arXiv 2503.07885; IEEE RA-L 2026):
  - A root-of-trust LLM grounds predefined safety rules in context.
  - Temporal-logic control synthesis then resolves conflicts with a possibly unsafe LLM plan.
  - Evaluated on a Clearpath Jackal with a GPT-4o planner under jailbreak attacks.
  - Source: [arXiv:2503.07885](https://arxiv.org/abs/2503.07885)
- **OWASP MCP Top 10** (draft/beta): MCP03:2025 Tool Poisoning lists signed schemas and manifest integrity as a control, and cites trust-on-first-use pinning of tool descriptions. — [OWASP MCP03:2025 Tool Poisoning](https://owasp.org/www-project-mcp-top-10/2025/MCP03-2025%E2%80%93Tool-Poisoning); [OWASP MCP Top 10](https://owasp.org/www-project-mcp-top-10/)
- Arduino recommends isolated "hardware sandbox" devices for agents. — [Arduino blog](https://blog.arduino.cc/2026/06/09/local-ai-agents-on-arduino-uno-q/)

### Inferences
- A defensible UNO Q control stack, top to bottom:
  1. Client permission UI, with mutating tools never on auto-approve.
  2. MCP server tool design: a few intent-level tools, typed and bounded `inputSchema` (min/max), `outputSchema`, annotations set honestly, `confirm`/MRTR-elicitation for destructive actions, and a dry-run/simulate flag that returns the planned MCU command without sending it.
  3. A server-side policy layer: rate limits, per-actuator leases, an allow-list of Bridge methods, and an append-only audit log of every call with arguments and results.
  4. MCU firmware interlocks: hard limits, slew-rate caps, a heartbeat watchdog to a safe state, and a physical E-stop. This layer holds even if Linux, the agent or the network are compromised.
- Treat sensor-derived text (camera OCR, serial strings, MQTT payloads) as untrusted model input. Return numeric, structured values (`structuredContent`) rather than free text where possible, to reduce the injection surface highlighted by the perception-injection papers.
- Annotations (`readOnlyHint`/`destructiveHint`) help clients present UI, but per the spec they are not security. Enforcement must live in the server and the MCU.

### Gaps
- I found no published MCP-specific standard or vendor guidance (Anthropic, OpenAI, Google) dedicated to physical-actuator safety. Guidance is general (spec security sections, OWASP) plus robotics papers.
- I did not read in full the MCP "Security Best Practices" page or the Authorization spec for 2026-07-28.
- No empirical study measured how well human-in-the-loop confirmation prevents unsafe actuation in practice ("approval fatigue").

---

## 6. Notable demos and projects of LLM agents controlling Arduino or similar boards, and lessons learned

### Takeaway
There are working demos, but almost no measured lessons specific to MCP on Arduino:
- Claude via MCP driving UNO Q LEDs and the matrix (Volt23)
- Cursor via MCP driving Raspberry Pi relays and an I²C sensor (Orbit OS video)
- OpenClaw + Claude Sonnet 4.6 on a 4 GB UNO Q driving the LED matrix
- ROS MCP demos (Go2 in Isaac Sim, Nav2/MoveIt robot)
- a fully local Qwen 0.8B thermostat agent on the UNO Q

The best quantitative data: about 12–83 s responses for an on-board 0.8B model with tools, and a 2026 IoT benchmark finding that a mid-granularity (about 4-tool) interface beats both fine-grained primitives and a single monolithic tool. Tool granularity mattered more than model size.

### Cited Findings
- **OpenClaw on the UNO Q** (Arduino blog, 5 Mar 2026; David Groom):
  - Runs on a standalone 4 GB UNO Q using Claude Sonnet 4.6 via API.
  - Drove the MCU LED and the 8×13 matrix from plain-language prompts.
  - Hit setup failures: HTTP 401 errors, CLI web tokens not usable as an API key.
  - No MCP or Bridge details are given.
  - Source: [Arduino blog](https://blog.arduino.cc/2026/03/05/radical-accessibility-on-the-arduino-uno-q-board-with-openclaw/)
- **Local agent thermostat on the UNO Q** (Mischianti, published 4 Nov 2026), Qwen3.5-0.8B-Q4_0 on llama.cpp:
  - Time to first token: 9.20 s on the first run, 0.85 s on later runs, at about 4.4–4.5 tokens/s.
  - Chat with tools: 54.55 s first answer, 29.34 s second.
  - A monitor decision with two tool calls took 83.33 s.
  - Gemma 3 1B "cannot use tools" (its chat template drops them).
  - `temperature=0.2` is recommended for decisions.
  - Tools are Python `@tool` functions whose docstrings are written "as an instruction".
  - Failure observed: "For about two minutes the room had no fan" during the monitor's first check.
  - Source: [Mischianti](https://mischianti.org/?p=36049)
- **Volt23 MCP server on the UNO Q:** first build takes 2–5 minutes (STM32 sketch compile), with later boots in seconds. Tested with Claude.ai, VS Code Copilot, Cursor, Zed. — [Volt23](https://github.com/Volt23/uno-q-mcp-blink-ai)
- **Orbit OS demo video:** Cursor controlling relays and reading an I²C sensor on a Raspberry Pi via MCP, "no SSH, no scripts" (recorded with an earlier version). — [Orbit OS README / YouTube](https://github.com/OrbitOS-org/orbit-os-app-mcp-server)
- **ROS MCP demos:** Claude diagnosing an industrial robot by discovering custom types; Gemini driving "Wilson" (Nav2 + MoveIt); Claude driving a Unitree Go2 in Isaac Sim. — [ros-mcp-server](https://github.com/robotmcp/ros-mcp-server)
- **Arduino blog local-agent series:** agents blink LEDs, change matrix animations, and generate, upload and refine firmware (QClaw). No benchmarks given. — [Arduino blog 9 Jun 2026](https://blog.arduino.cc/2026/06/09/local-ai-agents-on-arduino-uno-q/)
- **MCP-GRANITE** (arXiv 2609.24161, MASCOTS 2026; Paschalides et al.):
  - Setup: 81 scenarios, 9 domains, 9 local models (268M–20.9B), 8,748 trials, framed around edge and IoT.
  - A 4-tool interface was "the best trade-off", improving task completion 16.4% over fine-grained primitives and 33.6% over a monolithic tool, and roughly doubling argument accuracy.
  - Model size correlated weakly with completion and strongly with latency.
  - "A 3.2B-parameter model at the optimal granularity outperformed a 20.9B model at a mismatched one."
  - Source: [arXiv:2609.24161](https://arxiv.org/abs/2609.24161)
- **Practitioner advice** (single-author posts, not studies): hardware MCP servers should expose intent-level units ("degrees and seconds") rather than raw registers, with firmware enforcing electrical and thermal limits. Long operations should return a job ID plus a `poll_job` tool. — [dev.to: What makes a motor AI-friendly](https://dev.to/gearotons/what-makes-a-motor-ai-friendly-2hh6); [alphasignal: five patterns](https://alphasignalai.substack.com/p/why-your-mcp-server-picks-the-wrong)

### Inferences
- Lessons for a UNO Q MCP design:
  1. Expose a small number (about 4–10) of intent-level tools, e.g. `set_fan(on, reason)`, `move_servo(deg, duration_s)` or `read_environment()`, not `digital_write(pin, value)`.
  2. Expect actuation latency to be dominated by LLM think time, not MCP, Bridge or transport overhead. That is seconds with a cloud model and tens of seconds with an on-board 0.8B model. Anything time-critical belongs on the STM32.
  3. Return last-commanded *and* measured state, so the agent can detect divergence.
  4. Make first-run costs (sketch compile, model load) visible as long-running jobs, not blocking calls.
- Cloud frontier models (Claude via Claude Code/Desktop, or a connector) are the practical choice for multi-step agentic control today. On-board small models suit narrow, slow, supervisory loops.

### Gaps
- No Hackster.io or YouTube project with measured MCP round-trip latency on a UNO Q was found.
- No systematic failure-mode report (e.g. wrong-pin, retry storms, hallucinated tools) for MCP hardware servers was found. The evidence is anecdotal.
- The error-rate results of the Mischianti benchmark (missed versus unwanted moves) were beyond the portion of the page read.
