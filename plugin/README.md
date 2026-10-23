# Fractonica Claude Code plugin

The Claude Code plugin of [09 §9.8](../docs/spec/09-agent-api.md):

- `.claude-plugin/plugin.json`: one MCP server, `fractonica`, run as `${HOME}/.local/bin/fr mcp` (the shim `fr doctor --fix` writes). `fr mcp` serves every hub op as a tool; when no hub runs, the first tool call starts one (launching the server, which Claude Code does in every session, starts nothing).
- `skills/`: `fleet-ops`, `build-deploy` and `e2e-verify`, in the cross-vendor Agent Skills subset (`name` and `description` only).
- `hooks/hooks.json`: SessionStart prints one line of hub status (`hooks/session-start.sh`), or how to fix a missing shim; it never fails the session.
- `AGENTS.md`: the same guidance for other agents, with CLI equivalents.

Use it for one session with `claude --plugin-dir <checkout>/plugin`, or install it from this checkout's marketplace (`.claude-plugin/marketplace.json` at the repo root): `/plugin marketplace add <checkout>`, then `/plugin install fractonica@fractonica`. Start the hub from Terminal first (`fr hub start`), so macOS grants Local Network access to Terminal rather than to Claude Code.

Checked by `packages/cli/test/parity.test.ts`, which also runs `claude plugin validate plugin --strict` when `claude` is on PATH.
