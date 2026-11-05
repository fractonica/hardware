# Fractonica Claude Code plugin

The Claude Code plugin of [09 §9.8](../docs/spec/09-agent-api.md):

- `.claude-plugin/plugin.json`: one MCP server, `fractonica`, run as `${HOME}/.local/bin/fr mcp` (the shim `fr doctor --fix` writes). `fr mcp` serves every hub op as a tool; when no hub runs, the first tool call starts one (launching the server, which Claude Code does in every session, starts nothing).
- `skills/`: `fleet-ops`, `build-deploy`, `e2e-verify`, `hil-rig` (the HIL fixture, design m2-c1-hil), `audio` (record, play, levels and counters, T-AUDIO; design audio-a1), `camera` (photos, streams, the card, settings, the ESP32-CAM's bridge port, T-CAMERA; design camera-c1), `scale` (weight, tare and calibration, an 80 Hz recording, the round display, web/scale, T-SCALE; design scale-round-c1) and `wiring` (wiring guides, the parts catalogue, /apps/bench/; design wiring-w1), in the cross-vendor Agent Skills subset (`name` and `description` only).
- `hooks/hooks.json`: SessionStart prints one line of hub status (`hooks/session-start.sh`), or how to fix a missing shim; it never fails the session.
- `AGENTS.md`: the same guidance for other agents, with CLI equivalents.

Use it for one session with `claude --plugin-dir <checkout>/plugin`, or install it from this checkout's marketplace (`.claude-plugin/marketplace.json` at the repo root): `/plugin marketplace add <checkout>`, then `/plugin install fractonica@fractonica`. Start the hub from Terminal first (`fr hub start`), so macOS grants Local Network access to Terminal rather than to Claude Code.

Checked by `packages/cli/test/parity.test.ts`, which also runs `claude plugin validate plugin --strict` when `claude` is on PATH.
