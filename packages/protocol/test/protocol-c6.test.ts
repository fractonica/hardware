// The C6 protocol foundation (design c6 §3.2, D3, D4, D6, D11, D14, D17-D20, §6.7): op tiers and MCP
// metadata, the new ops' inputs and CLI paths, the output schemas, error codes, job kinds and origins,
// the hub event types, the fr-ws/1 frames, the browser entry and REGISTRY_HASH.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  aliasProblem,
  ArtifactManifestSchema,
  CLIENT_HEADER,
  decodeWsFrame,
  ERROR_CODES,
  exitCodeFor,
  findOp,
  FrError,
  HUB_EVENT_FIELDS,
  HUB_EVENT_TYPES,
  HubEventSchema,
  JOB_KINDS,
  JOB_ORIGINS,
  ManifestCapSchema,
  OP_NAMES,
  OPS,
  PortInfoSchema,
  REGISTRY_HASH,
  RESERVED_ALIASES,
  WsClientFrameSchema,
  WsHubFrameSchema,
  type OpDef,
} from '@fractonica/protocol';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The ops C6 adds (design c6 §3.2), with their kind, CLI path and positionals (09 §9.5). */
const C6_OPS: Record<string, { kind: string; path: string[]; positional?: string[] }> = {
  hub_doctor: { kind: 'query', path: ['hub', 'doctor'] },
  board_list: { kind: 'query', path: ['boards', 'ls'] },
  profile_list: { kind: 'query', path: ['profiles', 'ls'] },
  capability_list: { kind: 'query', path: ['caps', 'ls'] },
  latency_probe: { kind: 'job', path: ['latency', 'probe'], positional: ['from', 'to'] },
  serial_lease: { kind: 'command', path: ['serial', 'lease'], positional: ['device'] },
  serial_lease_renew: { kind: 'command', path: ['serial', 'renew'], positional: ['lease_id'] },
  serial_release: { kind: 'command', path: ['serial', 'release'], positional: ['lease_id'] },
  logs_assert: { kind: 'wait', path: ['assert', 'logs'], positional: ['selector'] },
  client_generate: { kind: 'query', path: ['codegen', 'client'] },
  test_run: { kind: 'job', path: ['test', 'run'], positional: ['suite'] },
};

const input = (name: string) => findOp(name)!.input;
const ok = (name: string, v: unknown) => input(name).safeParse(v).success;

describe('op metadata (D17)', () => {
  it('gives every op a tier: commands, jobs, diag_exec, job_cancel and network_set mutate, the rest read', () => {
    const mutating = new Set(['diag_exec', 'job_cancel', 'network_set']);
    for (const o of OPS) {
      const want = o.kind === 'command' || o.kind === 'job' || mutating.has(o.name) ? 'mutate' : 'read';
      expect(o.tier, o.name).toBe(want);
    }
  });

  it('marks hub_status and device_list alwaysLoad for MCP, and nothing else', () => {
    expect(OPS.filter((o: OpDef) => o.mcp?.alwaysLoad).map((o) => o.name)).toEqual(['hub_status', 'device_list']);
  });

  it('keeps literal op names, so OP_NAMES lists the registry', () => {
    expect(OP_NAMES).toEqual(OPS.map((o) => o.name));
    // @ts-expect-error: OpName is the union of names, not string
    const bad: (typeof OP_NAMES)[number] = 'no_such_op';
    expect(OP_NAMES).not.toContain(bad);
  });

  it('declares outputs for the ops the dashboard renders and every new op that answers at once, all JSON Schema ready', () => {
    for (const name of ['hub_status', 'port_list', 'device_list', 'device_get', 'job_get', 'job_wait', 'job_list', 'latency_stats', ...Object.keys(C6_OPS)]) {
      expect(findOp(name)!.output, name).toBeDefined();
    }
    for (const o of OPS as readonly OpDef[]) {
      // OpenAPI 3.1 (S2) is built from these; the MCP inputSchema uses io: 'input' (no root anyOf, 09 §9.4).
      const js = z.toJSONSchema(o.input, { io: 'input' }) as Record<string, unknown>;
      expect(js.anyOf ?? js.oneOf, o.name).toBeUndefined();
      if (o.output) {
        expect(() => z.toJSONSchema(o.output!, { io: 'output' }), o.name).not.toThrow();
      }
    }
  });
});

describe('the C6 ops (design c6 §3.2)', () => {
  it('are in the registry with their kind and the 09 §9.5 CLI path', () => {
    for (const [name, want] of Object.entries(C6_OPS)) {
      const o = findOp(name);
      expect(o, name).toBeDefined();
      expect(o!.kind, name).toBe(want.kind);
      expect(o!.cli, name).toEqual({ path: want.path, ...(want.positional ? { positional: want.positional } : {}) });
    }
  });

  it('serial_lease, serial_lease_renew and serial_release take the D4 inputs', () => {
    expect(input('serial_lease').parse({ device: 'pad-c3b' })).toEqual({ device: 'pad-c3b', ttl_s: 120 });
    expect(ok('serial_lease', { device: 'pad-c3b', ttl_s: 1800, holder_pid: 4242 })).toBe(true);
    for (const bad of [{ ttl_s: 0 }, { ttl_s: 1801 }, { holder_pid: 0 }, { device: '' }]) {
      expect(ok('serial_lease', { device: 'pad-c3b', ...bad }), JSON.stringify(bad)).toBe(false);
    }
    expect(input('serial_lease_renew').parse({ lease_id: 'l_0123456789ab' })).toEqual({ lease_id: 'l_0123456789ab' });
    expect(ok('serial_lease_renew', { lease_id: 'l_0123456789ab', ttl_s: 60 })).toBe(true);
    for (const id of ['l_0123', 'x_0123456789ab', 'l_0123456789AB']) {
      expect(ok('serial_release', { lease_id: id }), id).toBe(false);
    }
  });

  it('wait_for_event takes prompt_human, 1..120 characters (D3)', () => {
    const base = { types: 'boot.down', since: 'c:1.2' };
    expect(input('wait_for_event').parse({ ...base, prompt_human: 'Press BOOT on pad-c6' })).toMatchObject({ prompt_human: 'Press BOOT on pad-c6' });
    expect(ok('wait_for_event', { ...base, prompt_human: 'x'.repeat(120) })).toBe(true);
    expect(ok('wait_for_event', { ...base, prompt_human: 'x'.repeat(121) })).toBe(false);
    expect(ok('wait_for_event', { ...base, prompt_human: '' })).toBe(false);
    expect(input('wait_for_event').parse(base)).not.toHaveProperty('prompt_human');
  });

  it('latency_probe takes the §6.7 input with its defaults and bounds', () => {
    expect(input('latency_probe').parse({ from: 'pad-c6', to: 'pad-c3b' })).toEqual({
      from: 'pad-c6',
      to: 'pad-c3b',
      input: 'boot',
      mode: 'both',
      count: 10_000,
      rate_hz: 10,
      pulse_us: 2000,
      lead_ms: 250,
      match_timeout_ms: 1000,
      ping: true,
      hub_link: 'wifi',
    });
    expect(ok('latency_probe', { from: 'a', to: 'b', mode: 'exec_at', count: 20_000, rate_hz: 0.5, pulse_us: 10, lead_ms: 1500, match_timeout_ms: 100, hub_link: 'wired', label: 'wired-c6-c3b', wait_s: 110 })).toBe(true);
    for (const bad of [{ count: 0 }, { count: 20_001 }, { rate_hz: 0.4 }, { rate_hz: 21 }, { pulse_us: 9 }, { pulse_us: 100_001 }, { lead_ms: 49 }, { lead_ms: 1501 }, { lead_ms: 2000 }, { match_timeout_ms: 99 }, { match_timeout_ms: 5001 }, { mode: 'later' }, { hub_link: 'usb' }]) {
      expect(ok('latency_probe', { from: 'a', to: 'b', ...bad }), JSON.stringify(bad)).toBe(false);
    }
  });

  it('test_run takes source_dir, a tier, an optional suite and allow_human (D20)', () => {
    expect(input('test_run').parse({ source_dir: '/x', tier: 'target', suite: 't-lat' })).toEqual({ source_dir: '/x', tier: 'target', suite: 't-lat', allow_human: false });
    expect(ok('test_run', { source_dir: '/x', tier: 'bench' })).toBe(false);
    expect(ok('test_run', { source_dir: '/x' })).toBe(false);
  });

  it('logs_assert takes ordered expect patterns and a forbid list', () => {
    expect(input('logs_assert').parse({ selector: 'pad-c3', since: 'c:7.120', expect: ['fr: ready'] })).toEqual({
      selector: 'pad-c3',
      since: 'c:7.120',
      expect: ['fr: ready'],
      regex: false,
      timeout_s: 30,
    });
    expect(ok('logs_assert', { selector: 'pad-c3', since: 'c:7.120', expect: [] })).toBe(false);
    expect(ok('logs_assert', { selector: 'pad-c3', expect: ['x'] })).toBe(false); // since is required
    expect(ok('logs_assert', { selector: 'pad-c3', since: 'c:7.120', expect: ['x'], forbid: ['Guru Meditation'], timeout_s: 111 })).toBe(false);
  });

  it('client_generate, capability_list and the inventory ops take the D14 inputs', () => {
    expect(input('client_generate').parse({})).toEqual({ token: true });
    expect(input('capability_list').parse({ device: 'pad-c6' })).toEqual({ device: 'pad-c6' });
    for (const name of ['board_list', 'profile_list', 'hub_doctor']) {
      expect(input(name).parse({}), name).toEqual({});
    }
  });

  it('describe their results: a lease, a secret token.ts, a profile, a capability instance', () => {
    expect(findOp('serial_lease')!.output!.safeParse({ lease_id: 'l_0123456789ab', port: '1cdbd416ba34', path: '/dev/cu.usbmodem2101', ttl_s: 120, expires_at: '2026-10-22T12:00:00.000Z' }).success).toBe(true);
    const gen = findOp('client_generate')!.output!;
    const files = [{ path: 'devices.ts', content: 'export const devices = {};' }, { path: 'token.ts', content: "export const token = 'x';", secret: true }, { path: '.gitignore', content: 'token.ts\n' }];
    expect(gen.safeParse({ files, registry_rev: '0a1b2c3d', catalog_hash: 0xdc34c43b, devices: 2, warnings: [] }).success).toBe(true);
    expect(gen.safeParse({ files, registry_rev: 7, catalog_hash: 0xdc34c43b, devices: 2, warnings: [] }).success).toBe(false);
    const profiles = findOp('profile_list')!.output!;
    expect(profiles.safeParse({ profiles: [{ profile: 'c6-pad', board: 'esp32c6-supermini', chip: 'esp32c6', app: 'node', instances: { boot: { cap: 'fr.button', driver: 'button_gpio' } } }] }).success).toBe(true);
    const caps = findOp('capability_list')!.output!;
    const instance = { name: 'status', port: 2, cap: 'fr.led', cap_id: 2, v: '1.0', traits: null };
    expect(caps.safeParse({ catalog_hash: 1, caps: [], device: { instances: [instance] } }).success).toBe(true);
    expect(caps.safeParse({ catalog_hash: 1, caps: [], device: { instances: [{ ...instance, traits: undefined }] } }).success).toBe(false);
  });

  it('job_list filters by origin (D18)', () => {
    expect(input('job_list').parse({ origin: 'mcp' })).toEqual({ limit: 20, origin: 'mcp' });
    expect(ok('job_list', { origin: 'browser' })).toBe(false);
    expect(JOB_ORIGINS).toEqual(['cli', 'mcp', 'dashboard', 'app']);
    expect(CLIENT_HEADER).toBe('x-fr-client');
  });
});

describe('codes, kinds and events (D19)', () => {
  it('adds LNP_DENIED and ASSERTION_FAILED (exit 6, not retryable); the foundation\'s NOT_IMPLEMENTED is gone', () => {
    for (const code of ['LNP_DENIED', 'ASSERTION_FAILED'] as const) {
      expect(ERROR_CODES).toContain(code);
      expect(new FrError(code, 'x').toToolError().retryable, code).toBe(false);
    }
    expect(exitCodeFor('ASSERTION_FAILED')).toBe(6);
    expect(exitCodeFor('LNP_DENIED')).toBe(1);
    expect(ERROR_CODES as readonly string[]).not.toContain('NOT_IMPLEMENTED');
  });

  it('adds the job kinds test and latency', () => {
    expect(JOB_KINDS).toEqual(expect.arrayContaining(['test', 'latency']));
  });

  it('names the new hub event types, with fields schemas', () => {
    const added = ['port.attached', 'port.detached', 'port.state', 'port.leased', 'port.released', 'job.state', 'hub.prompt', 'hub.prompt_done'];
    expect(HUB_EVENT_TYPES).toEqual(expect.arrayContaining(added));
    // 17 through M1; M2-C1 adds op.called, hil.edge and hil.frame (design m2-c1-hil D9).
    expect(HUB_EVENT_TYPES).toHaveLength(20);
    expect(Object.keys(HUB_EVENT_FIELDS)).toEqual(expect.arrayContaining(added));
    const fields = (type: keyof typeof HUB_EVENT_FIELDS, f: unknown) => HUB_EVENT_FIELDS[type].safeParse(f).success;
    expect(fields('hub.prompt', { prompt_id: 'p_0a1b2c3d', text: 'Press BOOT on pad-c6', types: ['boot.down'], expires_at: '2026-10-22T12:00:30.000Z' })).toBe(true);
    expect(fields('hub.prompt', { prompt_id: 'p_7', text: 'x', types: [], expires_at: 't' })).toBe(false);
    expect(fields('hub.prompt_done', { prompt_id: 'p_0a1b2c3d', outcome: 'cancelled' })).toBe(true);
    expect(fields('hub.prompt_done', { prompt_id: 'p_0a1b2c3d', outcome: 'gone' })).toBe(false);
    expect(fields('port.released', { port: '1cdbd416ba34', path: '/dev/cu.usbmodem2101', lease_id: 'l_0123456789ab', reason: 'holder_gone', held_ms: 5120 })).toBe(true);
    expect(fields('port.released', { port: '1cdbd416ba34', path: '/dev/cu.usbmodem2101', lease_id: 'l_0123456789ab', reason: 'stolen', held_ms: 1 })).toBe(false);
    expect(fields('job.state', { job_id: 'j_1', kind: 'latency', status: 'working', stage: 'probe', targets: ['a', 'b'], origin: 'mcp' })).toBe(true);
    expect(PortInfoSchema.safeParse({ path: '/dev/cu.x', state: 'leased', lines: 0, lease: { lease_id: 'l_0123456789ab', holder_pid: 4242, expires_at: 't' }, external: [{ app: 'Google Chrome', pid: 715 }] }).success).toBe(true);
  });

  it('types the manifest traits per instance and the board test_pin (D13, D24)', () => {
    const cap = { name: 'status', port: 3, cap: 'fr.led', cap_id: 2, version: '1.1', driver: 'led_ws2812', config: { brightness: 40 } };
    expect(ManifestCapSchema.parse({ ...cap, traits: { color: 'rgb', dimmable: true, phases: 4 } }).traits).toEqual({ color: 'rgb', dimmable: true, phases: 4 });
    expect(ManifestCapSchema.parse({ ...cap, traits: null }).traits).toBeNull();
    expect(ManifestCapSchema.parse(cap).traits).toBeUndefined(); // a pre-C6 build
    expect(ManifestCapSchema.safeParse({ ...cap, traits: { color: ['rgb'] } }).success).toBe(false);
    const testPin = ArtifactManifestSchema.shape.test_pin;
    expect([20, null, undefined].map((v) => testPin.safeParse(v).success)).toEqual([true, true, true]);
    expect([-1, 49, 1.5].map((v) => testPin.safeParse(v).success)).toEqual([false, false, false]);
  });

  it('carries part and member on capability events', () => {
    const e = { cursor: 'c:1.5', seq: 5, type: 'boot.down', device: 'a0b1c2d3e4f5', t_hub_us: 1, part: 'event', member: 'down' };
    expect(HubEventSchema.parse(e)).toEqual(e);
    expect(HubEventSchema.safeParse({ ...e, part: 'result' }).success).toBe(false);
  });
});

describe('fr-ws/1 frames (D6)', () => {
  const client = (f: unknown) => decodeWsFrame(WsClientFrameSchema, JSON.stringify(f));
  const hub = (f: unknown) => decodeWsFrame(WsHubFrameSchema, JSON.stringify(f));
  const ev = { cursor: 'c:3.41', seq: 41, type: 'status.on', device: 'a0b1c2d3e4f5', t_hub_us: 1.8e15, fields: { value: true }, part: 'state', member: 'on' };

  it('parses the client frames', () => {
    const sub = { op: 'sub', id: 'live', events: { types: 'boot.*,device.*', selector: 'tag:poc', since: 'c:3.40' }, logs: { selector: 'pad-c3', level: 'W' }, jobs: true, ports: true };
    expect(client(sub)).toEqual({ ok: true, frame: sub });
    expect(client({ op: 'unsub', id: 'live' }).ok).toBe(true);
    expect(client({ op: 'ping', n: 3 }).ok).toBe(true);
    for (const bad of [{ op: 'subscribe', id: 'x' }, { op: 'sub', id: '' }, { op: 'sub', id: 'x', events: { since: '42' } }, { op: 'sub', id: 'x', logs: { level: 'X' } }, { op: 'sub', id: 'x', jobs: false }, { op: 'ping' }]) {
      expect(client(bad).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(decodeWsFrame(WsClientFrameSchema, '{nope')).toEqual({ ok: false, error: 'frame is not JSON' });
    // Type globs are bounded (the hub matches each against every event and property).
    expect(client({ op: 'sub', id: 'x', events: { types: `${'a,'.repeat(511)}b` } }).ok).toBe(true);
    expect(client({ op: 'sub', id: 'x', events: { types: 'a'.repeat(1025) } }).ok).toBe(false);
  });

  it('parses the hub frames', () => {
    const frames = [
      { t: 'hello', v: 1, run: 3, head: 'c:3.40', version: '0.1.0', registry_hash: REGISTRY_HASH },
      { t: 'ev', e: ev },
      { t: 'ev', e: ev, snapshot: true },
      { t: 'log', l: [{ cursor: 'c:3.42', ts: 't', device: 'a0b1c2d3e4f5', port: '/dev/cu.x', level: 'I', tag: 'fr', kind: 'esp_log', text: 'I (1) fr: ready' }] },
      { t: 'job', job_id: 'j_1', kind: 'flash', status: 'working', stage: 'write', progress: { pct: 40 } },
      { t: 'gap', after: 'c:3.40' },
      { t: 'err', id: 'live', code: 'HUB_RESTARTED', message: 'cursor from an earlier run', details: { resume_cursor: 'c:4.1' } },
      { t: 'pong', n: 3 },
      // The hub's now (§7.3): C6 hubs send it in hello and pong, so a client ages events by the hub's clock.
      { t: 'hello', v: 1, run: 3, head: 'c:3.40', version: '0.1.0', registry_hash: REGISTRY_HASH, t_hub_us: 1_800_000_000_123_456 },
      { t: 'pong', n: 4, t_hub_us: 1_800_000_000_223_456 },
    ];
    for (const f of frames) {
      expect(hub(f), f.t).toEqual({ ok: true, frame: f });
    }
    expect(hub({ t: 'pong', n: 4, t_hub_us: 'now' }).ok).toBe(false);
    for (const bad of [{ t: 'hello', v: 2, run: 3, head: 'c:3.40', version: 'x', registry_hash: 'y' }, { t: 'ev', e: { ...ev, cursor: undefined } }, { t: 'err', code: 'NOPE', message: 'm' }, { t: 'event', e: ev }]) {
      expect(hub(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('the browser entry (@fractonica/protocol/browser)', () => {
  /** The builtins a fresh Node process resolves while importing `entry` (type-only imports are erased). */
  function builtinsLoadedBy(entry: string): string[] {
    const script = `
      import { isBuiltin, registerHooks } from 'node:module';
      const seen = new Set();
      registerHooks({ resolve(s, c, next) { if (isBuiltin(s)) seen.add(s); return next(s, c); } });
      await import(${JSON.stringify(entry)});
      console.log(JSON.stringify([...seen]));`;
    const r = spawnSync(process.execPath, ['--conditions=@fractonica/source', '--input-type=module', '-e', script], { cwd: REPO, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as string[];
  }

  it('loads no Node builtin, where the root entry loads node:crypto', () => {
    expect(builtinsLoadedBy('@fractonica/protocol/browser')).toEqual([]);
    expect(builtinsLoadedBy('@fractonica/protocol')).toContain('node:crypto');
  }, 30_000);

  it('exports the ops, error codes, ws frames and alias rules, and not REGISTRY_HASH', async () => {
    const browser = await import('@fractonica/protocol/browser');
    for (const name of ['OPS', 'OP_NAMES', 'findOp', 'ERROR_CODES', 'FrError', 'WsClientFrameSchema', 'WsHubFrameSchema', 'HubEventSchema', 'aliasProblem', 'RESERVED_ALIASES', 'JOB_KINDS', 'parseCursor']) {
      expect(browser, name).toHaveProperty(name);
    }
    expect(browser).not.toHaveProperty('REGISTRY_HASH');
    expect(browser.OPS).toBe(OPS);
    expect(browser.aliasProblem).toBe(aliasProblem);
  });

  it('keeps the alias rules the hub had (moved from hub registry/names.ts)', () => {
    expect(aliasProblem('pad-red-1')).toBeNull();
    expect(aliasProblem('1cdbd416ba34')).toMatch(/device id/);
    expect(aliasProblem('broadcast')).toMatch(/reserved/);
    expect(RESERVED_ALIASES.has('all') && RESERVED_ALIASES.has('offline')).toBe(true);
  });
});

describe('REGISTRY_HASH', () => {
  const hashOf = (ops: readonly OpDef[]) =>
    createHash('sha256')
      .update(JSON.stringify(ops.map((o) => [o.name, z.toJSONSchema(o.input)])))
      .digest('hex')
      .slice(0, 12);

  it('covers every op, the C6 ones and wait_for_event.prompt_human included', () => {
    expect(hashOf(OPS)).toBe(REGISTRY_HASH);
    for (const name of Object.keys(C6_OPS)) {
      expect(hashOf(OPS.filter((o) => o.name !== name)), name).not.toBe(REGISTRY_HASH);
    }
    const withoutPrompt = OPS.map((o: OpDef) => (o.name === 'wait_for_event' ? { ...o, input: o.input.omit({ prompt_human: true }) } : o));
    expect(hashOf(withoutPrompt)).not.toBe(REGISTRY_HASH);
  });

  it('ignores tier, mcp and output', () => {
    expect(hashOf(OPS.map((o: OpDef) => ({ ...o, tier: 'read' as const, mcp: undefined, output: undefined })))).toBe(REGISTRY_HASH);
  });
});
