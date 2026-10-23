#!/bin/sh
# SessionStart hook of the Fractonica plugin (spec 09 §9.8): prints one line of hub status for the
# session's context, or how to fix a missing `fr` shim. It never fails the session: every path exits 0
# (Claude Code reads exit 2 as "block"). It never runs `node` itself, whose version on PATH may be too
# old: only the shim `fr doctor --fix` writes, which names its own Node.

FR="$HOME/.local/bin/fr"
FIX='from the Fractonica checkout, with Node >= 24.12: node --conditions=@fractonica/source packages/cli/src/main.ts doctor --fix'

if [ ! -x "$FR" ]; then
  echo "Fractonica: the fr shim is missing ($FR); $FIX"
  exit 0
fi

out=$("$FR" hub status --json 2>/dev/null)
code=$?

case "$code" in
  126 | 127)
    echo "Fractonica: $FR cannot run (its Node is missing or moved); $FIX"
    exit 0
    ;;
  10)
    echo "Fractonica hub: not running. The fractonica MCP server starts it on the first tool call; for Local Network access start it from Terminal instead: fr hub start"
    exit 0
    ;;
esac

line=''
if command -v jq >/dev/null 2>&1; then
  line=$(printf '%s' "$out" | jq -r '
    if .ok then .data as $d |
      "Fractonica hub \($d.version) run \($d.run): \($d.devices.online // 0)/\($d.devices.registered // 0) devices online, ports \($d.ports.open // 0)/\($d.ports.total // 0) open, jobs \($d.jobs.working // 0) working \($d.jobs.queued // 0) queued"
      + (if (($d.prompts // []) | length) > 0 then ", \($d.prompts | length) prompt_human pending" else "" end)
      + (if $d.lnp then ", LNP \($d.lnp)" else "" end)
      + (if (($d.warnings // []) | length) > 0 then "; warnings: " + (($d.warnings[0:3]) | join("; ")) + (if ($d.warnings | length) > 3 then "; …" else "" end) else "" end)
    else
      "Fractonica hub: \(.error.code) \(.error.message)"
      + (if .error.remediation then " (" + ([.error.remediation[] | (.cli // .human // .tool)] | join("; ")) + ")" else "" end)
    end | gsub("[\r\n]+"; " ")' 2>/dev/null)
fi
if [ -z "$line" ]; then
  # No jq, or not a JSON envelope: the first 200 characters of what fr printed.
  line="Fractonica hub status: $(printf '%s' "$out" | tr '\r\n' '  ' | cut -c1-200)"
fi
echo "$line"
exit 0
