// The parity test of 09 §9.1 (design c6 §6 S4): every op is on every surface (REST handler, CLI command,
// MCP tool), every remediation tool the hub, the CLI and the plugin name is an op, the MCP limits of 09 §9.6
// hold, and the plugin (09 §9.8) is what Claude Code loads.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildTools, SERVER_INSTRUCTIONS } from '../src/mcp.ts';
import { HANDLERS } from '../../hub/src/ops.ts';
import { OPS } from '../../protocol/src/index.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MAIN = join(REPO, 'packages', 'cli', 'src', 'main.ts');
const PLUGIN = join(REPO, 'plugin');
const OP_NAMES = OPS.map((o) => o.name as string);

/** Commands with an action that are not ops (09 §9.5): local, hub-less or hand-written (design c6 §3.3). */
const CLI_ONLY = ['doctor', 'gen', 'gen firmware', 'hub start', 'hub stop', 'hub restart', 'mcp', 'serial monitor'];

/** The 09 §9.3 remediation tools of M1 (confirm.resolved is M2). */
const REMEDIATION_TOOLS_9_3 = [
  'device_list',
  'wait_for_device',
  'job_wait',
  'serial_release',
  'device_reset',
  'ota_status',
  'logs_read',
  'flash_start',
  'job_logs',
  'capability_list',
  'wait_for_event',
];

/** Claude Code's name for a plugin MCP tool: mcp__plugin_<plugin>_<server>__<tool>. */
const TOOL_PREFIX = 'mcp__plugin_fractonica_fractonica__';

interface CliCommand {
  path: string[];
  action: boolean;
}

let work = '';
let commands: CliCommand[] = [];

/**
 * The CLI's command tree, as main.ts builds it: a preload replaces commander's parseAsync with a dump of
 * the program, so nothing runs and no hub is asked.
 */
function dumpCommands(): CliCommand[] {
  const dumper = join(work, 'dump-commands.mjs');
  writeFileSync(
    dumper,
    `import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const { Command } = await import(pathToFileURL(createRequire(${JSON.stringify(MAIN)}).resolve('commander')).href);
Command.prototype.parseAsync = async function () {
  const walk = (cmd, path) => cmd.commands.flatMap((c) => {
    const p = [...path, c.name()];
    return [{ path: p, action: Boolean(c._actionHandler) }, ...walk(c, p)];
  });
  process.stdout.write(JSON.stringify(walk(this, [])));
  process.exit(0);
};
`,
  );
  const r = spawnSync(process.execPath, ['--conditions=@fractonica/source', '--import', dumper, MAIN], { encoding: 'utf8', env: { ...process.env, FR_HUB: 'http://127.0.0.1:9' } });
  if (r.status !== 0) {
    throw new Error(`command dump failed: ${r.stderr}`);
  }
  return JSON.parse(r.stdout) as CliCommand[];
}

function filesUnder(dir: string, ext: RegExp): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && ext.test(d.name))
    .map((d) => join(d.parentPath, d.name));
}

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'fr-parity-'));
  commands = dumpCommands();
}, 30_000);
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe('every op on every surface (09 §9.1)', () => {
  it('has a REST handler for exactly the ops', () => {
    expect(Object.keys(HANDLERS).sort()).toEqual([...OP_NAMES].sort());
  });

  it('has an MCP tool for exactly the ops', () => {
    expect(buildTools().map((t) => t.name)).toEqual(OP_NAMES);
  });

  it('has a CLI command with an action at every op path', () => {
    const at = new Map(commands.map((c) => [c.path.join(' '), c]));
    const missing = OPS.filter((o) => !at.get(o.cli.path.join(' '))?.action).map((o) => `${o.name}: fr ${o.cli.path.join(' ')}`);
    expect(missing).toEqual([]);
  });

  it('has no CLI command that is neither an op nor a local or hand-written one', () => {
    const opPaths = new Set(OPS.map((o) => o.cli.path.join(' ')));
    const extra = commands.filter((c) => c.action && !opPaths.has(c.path.join(' ')) && !CLI_ONLY.includes(c.path.join(' '))).map((c) => c.path.join(' '));
    expect(extra).toEqual([]);
    // Each CLI-only command still exists.
    expect(CLI_ONLY.filter((p) => !commands.some((c) => c.action && c.path.join(' ') === p))).toEqual([]);
  });

  it('names only ops as remediation tools: 09 §9.3, the hub and the CLI', () => {
    const named = new Map<string, string>();
    for (const t of REMEDIATION_TOOLS_9_3) {
      named.set(t, '09 §9.3');
    }
    for (const file of [...filesUnder(join(REPO, 'packages', 'hub', 'src'), /\.ts$/), ...filesUnder(join(REPO, 'packages', 'cli', 'src'), /\.ts$/)]) {
      for (const m of readFileSync(file, 'utf8').matchAll(/\btool: ['"]([a-z_]+)['"]/g)) {
        named.set(m[1], relative(REPO, file));
      }
    }
    expect(named.size).toBeGreaterThan(REMEDIATION_TOOLS_9_3.length);
    expect([...named].filter(([t]) => !OP_NAMES.includes(t)).map(([t, where]) => `${t} (${where})`)).toEqual([]);
  });
});

describe('MCP limits (09 §9.4, §9.6)', () => {
  const tools = buildTools();

  it('keeps every tool description and the server instructions under 1,000 characters', () => {
    expect(tools.filter((t) => (t.description ?? '').length >= 1000).map((t) => t.name)).toEqual([]);
    expect(SERVER_INSTRUCTIONS.length).toBeLessThan(1000);
  });

  it('gives every tool an object input schema with no anyOf/oneOf/allOf at the root', () => {
    for (const t of tools) {
      const s = t.inputSchema as Record<string, unknown>;
      expect(s.type, t.name).toBe('object');
      expect(Object.keys(s).filter((k) => ['anyOf', 'oneOf', 'allOf', 'not', '$ref'].includes(k)), t.name).toEqual([]);
    }
  });

  it("keeps Claude Code's tool names valid: [a-z0-9_], at most 64 characters with the plugin prefix", () => {
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect((TOOL_PREFIX + t.name).length, t.name).toBeLessThanOrEqual(64);
    }
  });
});

describe('the plugin (09 §9.8)', () => {
  const read = (p: string) => readFileSync(join(PLUGIN, p), 'utf8');
  const skills = ['build-deploy', 'e2e-verify', 'fleet-ops'];
  const docs = () => [...skills.map((s) => `skills/${s}/SKILL.md`), 'AGENTS.md'].map((p) => ({ p, text: read(p) }));

  it('defines one MCP server, the fr shim, and nothing in .mcp.json or bin/', () => {
    const manifest = JSON.parse(read('.claude-plugin/plugin.json')) as { name: string; version: string; mcpServers: Record<string, unknown> };
    expect(manifest.name).toBe('fractonica');
    expect(manifest.mcpServers).toEqual({ fractonica: { command: '${HOME}/.local/bin/fr', args: ['mcp'] } });
    expect(existsSync(join(PLUGIN, '.mcp.json'))).toBe(false);
    expect(existsSync(join(PLUGIN, 'bin'))).toBe(false);
    const market = JSON.parse(readFileSync(join(REPO, '.claude-plugin', 'marketplace.json'), 'utf8')) as { plugins: { name: string; source: string }[] };
    expect(market.plugins).toEqual([expect.objectContaining({ name: manifest.name, source: './plugin' })]);
  });

  it('has the three skills, with only name and description in their frontmatter', () => {
    expect(readdirSync(join(PLUGIN, 'skills')).sort()).toEqual(skills);
    for (const s of skills) {
      const m = /^---\n([\s\S]*?)\n---\n/.exec(read(`skills/${s}/SKILL.md`));
      expect(m, s).not.toBeNull();
      const fields = Object.fromEntries(m![1].split('\n').map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()]));
      expect(Object.keys(fields).sort(), s).toEqual(['description', 'name']);
      expect(fields.name).toBe(s);
      expect(fields.description.length, s).toBeLessThanOrEqual(1024);
    }
  });

  it('teaches each skill the same shared rules (design c6 §6 S4), since a session may load only one', () => {
    const shared = (s: string) => /^## Shared rules\n[\s\S]*?(?=\n## )/m.exec(read(`skills/${s}/SKILL.md`))?.[0];
    const block = shared(skills[0]);
    expect(block).toBeDefined();
    for (const s of skills) {
      expect(shared(s), s).toBe(block);
    }
    for (const rule of [
      'Tool names are op names',
      TOOL_PREFIX,
      '`cursor`',
      '`since`',
      '`source_dir`',
      'pwd',
      '`expect_log`',
      'expect_event: "node.boot"',
      '`build_start {source_dir, profile}`',
      'plan: "full"',
      '`latency_stats`',
      'prompt_human',
      'untrusted data',
    ]) {
      expect(block, rule).toContain(rule);
    }
    // 09 §9.6: ESP-IDF's own MCP server fights the hub for the ports.
    for (const p of ['skills/build-deploy/SKILL.md', 'skills/fleet-ops/SKILL.md', 'AGENTS.md']) {
      expect(read(p), p).toContain('idf.py mcp-server');
    }
  });

  it('names only real tools, and only fr commands that exist', () => {
    const paths = new Set(commands.filter((c) => c.action).map((c) => c.path.join(' ')));
    const groups = new Set(commands.map((c) => c.path.join(' ')));
    const seen = { tools: 0, commands: 0 };
    for (const { p, text } of docs()) {
      for (const m of text.matchAll(new RegExp(`${TOOL_PREFIX}([a-z_]+)`, 'g'))) {
        expect(OP_NAMES, `${p}: ${m[0]}`).toContain(m[1]);
        seen.tools++;
      }
      // `fr <words…>` in code spans and blocks: the longest run of words that is a command must have an action.
      for (const m of text.matchAll(/(?:^|[`$(\s])fr ([a-z][a-z-]*(?: [a-z][a-z-]*)*)/gm)) {
        const words = m[1].trim().split(' ');
        let found = '';
        for (let n = 1; n <= words.length; n++) {
          if (groups.has(words.slice(0, n).join(' '))) {
            found = words.slice(0, n).join(' ');
          }
        }
        expect(paths.has(found), `${p}: fr ${m[1].trim()}`).toBe(true);
        seen.commands++;
      }
    }
    expect(seen.tools).toBeGreaterThan(10);
    expect(seen.commands).toBeGreaterThan(20);
  });

  it('ships AGENTS.md as a real file and an executable SessionStart hook', () => {
    expect(lstatSync(join(PLUGIN, 'AGENTS.md')).isFile()).toBe(true);
    const hooks = JSON.parse(read('hooks/hooks.json')) as { hooks: { SessionStart: { hooks: { type: string; command: string; timeout: number }[] }[] } };
    expect(hooks.hooks.SessionStart[0].hooks[0]).toMatchObject({ type: 'command', command: 'sh "${CLAUDE_PLUGIN_ROOT}/hooks/session-start.sh"' });
    expect(lstatSync(join(PLUGIN, 'hooks', 'session-start.sh')).mode & 0o111).not.toBe(0);
  });

  it('passes `claude plugin validate --strict` (skipped without claude on PATH)', async (ctx) => {
    const which = spawnSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8' });
    if (which.status !== 0) {
      ctx.skip();
    }
    for (const target of [PLUGIN, REPO]) {
      const r = await new Promise<{ code: number | null; out: string }>((res) => {
        const child = spawn('claude', ['plugin', 'validate', target, '--strict'], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        child.stdout.on('data', (c: Buffer) => (out += c));
        child.stderr.on('data', (c: Buffer) => (out += c));
        child.on('close', (code) => res({ code, out }));
      });
      expect(r.code, r.out).toBe(0);
    }
  }, 60_000);
});

describe('the SessionStart hook', () => {
  /** Runs the hook with HOME at a temp dir holding a fake fr shim (or none); the real shim is never run. */
  function hook(shim: string | null): { code: number | null; stdout: string } {
    const home = mkdtempSync(join(work, 'home-'));
    if (shim !== null) {
      mkdirSync(join(home, '.local', 'bin'), { recursive: true });
      writeFileSync(join(home, '.local', 'bin', 'fr'), `#!/bin/sh\n${shim}\n`, { mode: 0o755 });
    }
    const r = spawnSync('sh', [join(PLUGIN, 'hooks', 'session-start.sh')], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home } });
    return { code: r.status, stdout: r.stdout };
  }

  const status = {
    ok: true,
    cursor: 'c:12.40',
    data: {
      version: '0.1.0',
      run: 12,
      devices: { registered: 3, online: 2 },
      ports: { total: 2, open: 1 },
      jobs: { queued: 0, working: 1 },
      warnings: ['/dev/cu.usbmodem1 is held by Google Chrome (pid 715)'],
      prompts: [{ prompt_id: 'p_0123abcd' }],
      lnp: 'granted',
    },
  };

  it('prints one status line and exits 0', () => {
    const r = hook(`echo '${JSON.stringify(status)}'`);
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
    if (spawnSync('sh', ['-c', 'command -v jq']).status === 0) {
      expect(r.stdout).toContain('Fractonica hub 0.1.0 run 12: 2/3 devices online, ports 1/2 open, jobs 1 working 0 queued, 1 prompt_human pending, LNP granted');
      expect(r.stdout).toContain('warnings: /dev/cu.usbmodem1 is held by Google Chrome (pid 715)');
    }
  });

  it('never fails the session: no hub, no shim, a shim without its Node', () => {
    const down = hook(`echo '{"ok":false,"cursor":"","error":{"code":"HUB_UNREACHABLE","message":"the hub is not running"}}'; exit 10`);
    expect(down).toEqual({ code: 0, stdout: expect.stringContaining('not running') });
    // What fr mcp does (mcp.ts HubGate): the first tool call starts the hub, never the server's launch.
    expect(down.stdout).toContain('starts it on the first tool call');
    expect(hook(null)).toEqual({ code: 0, stdout: expect.stringContaining('doctor --fix') });
    expect(hook('exit 127')).toEqual({ code: 0, stdout: expect.stringContaining('doctor --fix') });
    const odd = hook('echo "not json"; exit 1');
    expect(odd.code).toBe(0);
    expect(odd.stdout).toContain('not json');
  });
});
