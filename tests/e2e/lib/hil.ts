// The HIL bench for gate scenarios (design m2-c1-hil §2.1, §5.2, D7–D11; spec 10 §10.5 T-HIL): the bench
// client over the hub's API (bench_get, input_simulate {layer: gpio}, the hil.edge/hil.frame readings), the
// gesture expectations of §2.1 with each DUT's own fr.button config from its profile, the LED matcher of
// §5.2 phase 3, the loss accounting of phase 2 (with the DUT commands that expired or went unanswered), and
// the wiring check's diagnosis of phase 0b (which channel reached which DUT, swaps, the bench-file edit that
// would match the wiring). T-HIL (tests/e2e/t-hil.ts), T-INPUT --press-by fixture,
// T-LED --verify fixture and run.ts's --tier hil preflight read the bench through it; the verdicts are pure
// functions of what the hub recorded, so packages/hub/test/e2e-gates-e.test.ts checks them on recorded
// figures without a board.
//
// Clocks (D10): the fixture F, the DUT D and the hub H. A fixture reading carries t_fix_us (F), t_hub_us
// and t_dut_us, the DUT time of the reading on the press-based wired fit (`sync: wired`), through the hub's
// two TIME offsets (`hub`, a few ms) or none. DUT events carry t_dev_us. Device times are u32 µs compared
// with cmp32 (RFC 1982), so a wrap or an unwrapped value compares alike.
//
// Readings are the hub's hil.edge and hil.frame only, never the fixture's own `edges` events: hil.edge is the
// de-glitched stream (packages/hub/src/fixture/timeline.ts LevelFilter: repeated readings and phases under
// GLITCH_US dropped, corrections from the line's `level` STATE marked `corrected`). Edges are still taken as
// level transitions here (pressHolds, pulseWidths, the LED matcher's re-sends), never by ordinal.
//
// Nothing here arms anything: the gates press, set LEDs and park bindings inside their own try/finally.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { BenchStatus, HubEvent } from '@fractonica/protocol';
import { CATALOG } from '@fractonica/protocol/gen';

import { type Hub, HubError } from './hub.ts';
import type { PreflightReport } from './report.ts';

type Row = Record<string, any>;

/** RFC 1982 order of two u32 device times: negative when a is before b. */
export function cmp32(a: number, b: number): number {
  return (a - b) | 0;
}

/** The seq of a cursor `c:<run>.<seq>` (NaN for anything else). */
export function seqOf(cursor: string | undefined): number {
  const m = /^c:\d+\.(\d+)$/.exec(cursor ?? '');
  return m ? Number(m[1]) : Number.NaN;
}

/** Nearest-rank quantile (null for none). */
export function quantile(xs: readonly number[], q: number): number | null {
  if (!xs.length) {
    return null;
  }
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
}

/** n, p50, p99 and max of µs values, as integers. */
export function usSummary(xs: readonly number[]): { n: number; p50: number | null; p99: number | null; max: number | null } {
  const r = (v: number | null) => (v === null ? null : Math.round(v));
  return { n: xs.length, p50: r(quantile(xs, 0.5)), p99: r(quantile(xs, 0.99)), max: xs.length ? Math.round(Math.max(...xs)) : null };
}

/** The member of a `<instance>.<member>` event (`boot.down` -> down). */
export function memberOf(e: Pick<HubEvent, 'type' | 'member'>): string {
  return e.member ?? e.type.slice(e.type.lastIndexOf('.') + 1);
}

const f = (e: HubEvent): Row => (e.fields ?? {}) as Row;

// ---- the bench, as bench_get reports it ----

/** One bench line of a DUT: the bench file's wiring and the fixture's live reading of it. */
export interface HilLine {
  /** The bench line's name: boot, status, test_pin, analog, en. */
  name: string;
  role: string;
  channel: string;
  fixture_gpio: number;
  /** false: reserved (its pin and channel), never driven or judged. */
  wired: boolean;
  /** The fixture's reading at bench_get; null with the line not wired or the fixture away. */
  level: boolean | null;
  problem: string | null;
  via?: 'direct' | 'nfet';
  decode: 'level' | 'ws2812';
  active_level?: 'low' | 'high';
  dut_gpio?: number;
}

/** One device under test on the bench. */
export interface HilDut {
  device: string;
  /** Its alias (the device id when it has none). */
  alias: string;
  /** The profile the bench says it runs, and the one it runs now (registry). */
  profile: string;
  running_profile: string | null;
  presence: string;
  /** bench_get's code for it: profile_mismatch, download_mode, offline, ... (null: none). */
  problem: string | null;
  /** Accounted RF losses warn instead of failing (pad-c3, §5.2). */
  rf_weak: boolean;
  lines: Record<string, HilLine>;
  fit: BenchStatus['duts'][number]['fit'];
}

/** The DUTs of a bench_get answer, each with its lines (file and live reading together), in bench order. */
export function benchDuts(st: BenchStatus): HilDut[] {
  return st.duts.map((d) => {
    const file = st.bench.duts[d.device];
    const lines: Record<string, HilLine> = {};
    for (const [name, l] of Object.entries(file?.lines ?? {})) {
      const live = st.lines.find((x) => x.dut === d.device && x.line === name);
      lines[name] = {
        name,
        role: l.role,
        channel: l.channel,
        fixture_gpio: l.fixture_gpio,
        wired: l.wired !== false,
        level: live?.level ?? null,
        problem: live?.problem ?? null,
        ...(l.via ? { via: l.via } : {}),
        decode: l.decode ?? 'level',
        ...(l.active_level ? { active_level: l.active_level } : {}),
        ...(l.dut_gpio !== undefined ? { dut_gpio: l.dut_gpio } : {}),
      };
    }
    return {
      device: d.device,
      alias: d.alias ?? d.device,
      profile: d.profile,
      running_profile: d.running_profile ?? null,
      presence: d.presence,
      problem: d.problem ?? null,
      rf_weak: file?.rf_weak === true,
      lines,
      fit: d.fit ?? null,
    };
  });
}

/** The fixture as people name it: its alias (fix-s3), else its device id. */
export function fixtureName(st: BenchStatus): string {
  return st.fixture.alias ?? st.fixture.device;
}

/** The line level that means pressed: low on a direct (open-drain) BOOT line, a driven gate (high) on an nfet one. */
export function pressedLevel(line: Pick<HilLine, 'via'>): boolean {
  return line.via === 'nfet';
}

/** A wired button line the fixture reads as pressed while nothing presses it (D11: a DUT reset then latches download mode). */
export function pressedAtIdle(line: HilLine): boolean {
  return line.role === 'button' && line.wired && line.level !== null && line.level === pressedLevel(line);
}

/** A line that reads idle: a button released, a test_pin high (its pull-up), anything else as it is. */
export function lineIdle(line: HilLine): boolean {
  if (!line.wired) {
    return true;
  }
  if (line.role === 'button') {
    return line.level !== null && line.level !== pressedLevel(line) && !line.problem;
  }
  if (line.role === 'test_pin') {
    return line.level === true && !line.problem;
  }
  return !line.problem;
}

/** bench_get; a failed answer throws HubError. */
export async function benchGet(hub: Hub, signal?: AbortSignal): Promise<BenchStatus> {
  return hub.ok<BenchStatus>('bench_get', {}, 15_000, signal);
}

/**
 * run.ts --tier hil's preflight (D13) on a bench_get answer: what stops every hil gate before it presses
 * anything, and what the gates judge themselves. Fatal: the fixture not on its serial session; a DUT on
 * USB with no HELLO (likely download mode); a wired BOOT line that reads pressed at idle on a DUT that is
 * not offline ("pad-c3b boot: fix-s3 ch1 reads low at idle"). Notes: the rest of bench_get's problems (a
 * DUT on another profile, a test_pin line low, another fixture build than the pinned one, no clock yet),
 * which T-HIL's phase 0 judges per DUT, and a bench that pins no fixture fw_id, which T-HIL refuses without
 * --any-fixture-fw (this preflight does not see a suite's flags).
 */
export function preflightVerdict(st: BenchStatus): PreflightReport {
  const fatal: string[] = [];
  const notes: string[] = [];
  const fx = fixtureName(st);
  if (st.fixture.presence !== 'online') {
    fatal.push(`${fx} (the fixture, ${st.fixture.device}) is ${st.fixture.presence}: it must be on its USB serial session; after any fixture power loss, run fr bench before touching a DUT`);
  }
  if (!st.fixture.fw_ok && st.bench.fixture.fw_id !== null) {
    notes.push(`${fx} runs ${st.fixture.fw_id ?? 'an unknown build'}, not the bench's pinned ${st.bench.fixture.fw_id}`);
  }
  // bench_get's fw_ok is false while nothing is pinned (fw_pinned false): T-HIL's phase 0 refuses that
  // (§5.2: "on serial with its pinned fw_id") unless --any-fixture-fw.
  if (st.bench.fixture.fw_id === null) {
    notes.push(`the bench ${st.bench.id} pins no fixture fw_id (${fx} runs ${st.fixture.fw_id ?? 'an unknown build'}): T-HIL runs only with --any-fixture-fw until fixture.fw_id is pinned in ${st.file} (§5.3 step 2)`);
  }
  if (!st.clock) {
    notes.push(`no fixture <-> hub clock yet (no TIME burst kept on ${fx}'s serial session)`);
  }
  for (const d of benchDuts(st)) {
    if (d.problem === 'download_mode') {
      fatal.push(`${d.alias}: on USB with no HELLO, likely download mode: power-cycle it (C3/S3 on USB: esptool --after watchdog-reset)`);
    }
    for (const l of Object.values(d.lines)) {
      if (d.presence !== 'offline' && pressedAtIdle(l)) {
        fatal.push(`${d.alias} ${l.name}: ${fx} ${l.channel} ${l.via === 'nfet' ? 'drives its gate' : 'reads low'} at idle`);
      }
    }
  }
  for (const p of st.problems) {
    if (!fatal.includes(p) && !notes.includes(p)) {
      notes.push(p);
    }
  }
  return {
    ok: fatal.length === 0,
    fatal,
    notes,
    bench: st.file,
    fixture: { device: st.fixture.device, alias: st.fixture.alias, presence: st.fixture.presence, fw_ok: st.fixture.fw_ok },
  };
}

/** The preflight against a hub: bench_get failing (an older hub answers NOT_FOUND) is itself fatal. */
export async function hilPreflight(hub: Hub, signal?: AbortSignal): Promise<PreflightReport> {
  const r = await hub.call<BenchStatus>('bench_get', {}, 15_000, signal);
  if (!r.ok || !r.data) {
    return { ok: false, fatal: [`bench_get: ${r.error?.code ?? 'INTERNAL'} ${r.error?.message ?? 'no answer'}`], notes: [] };
  }
  return preflightVerdict(r.data);
}

// ---- a DUT's profile: its fr.button and fr.led config ----

type Flow = string | number | boolean | null | Flow[] | { [k: string]: Flow };

/** One YAML flow value (`{ cap: fr.led, config: { max_brightness: 64 } }`), as the profiles write their instances. */
export function parseFlow(src: string): Flow {
  let i = 0;
  const ws = () => {
    while (i < src.length && /\s/.test(src[i])) {
      i++;
    }
  };
  const scalar = (text: string): Flow => {
    const t = text.trim();
    if (/^(['"]).*\1$/.test(t)) {
      return t.slice(1, -1);
    }
    if (t === 'true' || t === 'false') {
      return t === 'true';
    }
    if (t === 'null' || t === '~' || t === '') {
      return null;
    }
    const n = Number(t);
    return Number.isFinite(n) && /^[-+0-9.xXa-fA-F]+$/.test(t) ? n : t;
  };
  const text = (stops: string): string => {
    ws();
    if (src[i] === '"' || src[i] === "'") {
      const q = src[i];
      const end = src.indexOf(q, i + 1);
      const s = src.slice(i, end + 1);
      i = end + 1;
      return s;
    }
    const start = i;
    while (i < src.length && !stops.includes(src[i]) && !(src[i] === ':' && stops.includes(':') && /\s/.test(src[i + 1] ?? ' '))) {
      i++;
    }
    return src.slice(start, i);
  };
  const value = (): Flow => {
    ws();
    if (src[i] === '{') {
      i++;
      const o: Record<string, Flow> = {};
      for (;;) {
        ws();
        if (src[i] === '}') {
          i++;
          return o;
        }
        const key = String(scalar(text(':,}')));
        ws();
        if (src[i] !== ':') {
          throw new Error(`flow map: expected ':' after ${key} in ${src}`);
        }
        i++;
        o[key] = value();
        ws();
        if (src[i] === ',') {
          i++;
        }
      }
    }
    if (src[i] === '[') {
      i++;
      const a: Flow[] = [];
      for (;;) {
        ws();
        if (src[i] === ']') {
          i++;
          return a;
        }
        a.push(value());
        ws();
        if (src[i] === ',') {
          i++;
        }
      }
    }
    return scalar(text(',}]'));
  };
  return value();
}

/** A profile instance (`caps:` entry) as the harness reads it: capability, driver and its config. */
export interface ProfileInstance {
  cap?: string;
  driver?: string;
  config: Record<string, Flow>;
}

/**
 * The `caps:` instances of a profile file's text. The profiles write each one as a flow map on one line
 * (firmware/profiles/*.profile.yaml); a comment after it is ignored.
 */
export function profileInstances(text: string): Record<string, ProfileInstance> {
  const out: Record<string, ProfileInstance> = {};
  let inCaps = false;
  for (const line of text.split('\n')) {
    if (/^caps:\s*(#.*)?$/.test(line)) {
      inCaps = true;
      continue;
    }
    if (inCaps && /^\S/.test(line)) {
      inCaps = false;
    }
    const m = inCaps ? /^ {2}([A-Za-z_][\w-]*):\s*(\{.*)$/.exec(line) : null;
    if (!m) {
      continue;
    }
    // The flow map ends at its matching brace; what follows is a comment.
    let depth = 0;
    let end = -1;
    for (let k = 0; k < m[2].length; k++) {
      depth += m[2][k] === '{' ? 1 : m[2][k] === '}' ? -1 : 0;
      if (depth === 0) {
        end = k;
        break;
      }
    }
    try {
      const v = parseFlow(m[2].slice(0, end + 1)) as Record<string, Flow>;
      out[m[1]] = {
        ...(typeof v.cap === 'string' ? { cap: v.cap } : {}),
        ...(typeof v.driver === 'string' ? { driver: v.driver } : {}),
        config: v.config && typeof v.config === 'object' && !Array.isArray(v.config) ? (v.config as Record<string, Flow>) : {},
      };
    } catch {
      // not a line this reader understands: its defaults apply
    }
  }
  return out;
}

/** A bench line as the bench file writes it, read without the schema (benchFileLines). */
export interface BenchFileLine {
  role?: string;
  channel?: string;
  dut_gpio?: number;
  wired: boolean;
}

/**
 * The DUT lines of a bench file's text (hardware/bench/<name>.bench.yaml, §2.3), by device id and line name,
 * read leniently: each DUT a 12-hex key under `duts:`, each line a flow map on one line under its `lines:`
 * (a comment after it ignored). It reads a file the hub's validator refused too, since the rig is wired as
 * the file says whether or not it validates (T-LAT's skip, design m2-c1-hil D14).
 */
export function benchFileLines(text: string): Record<string, Record<string, BenchFileLine>> {
  const out: Record<string, Record<string, BenchFileLine>> = {};
  let inDuts = false;
  let dut: string | null = null;
  for (const line of text.split('\n')) {
    if (/^duts:\s*(#.*)?$/.test(line)) {
      inDuts = true;
      continue;
    }
    if (/^\S/.test(line)) {
      inDuts = false;
      dut = null;
    }
    if (!inDuts) {
      continue;
    }
    const d = /^ {2}([0-9a-fA-F]{12}):\s*(#.*)?$/.exec(line);
    if (d) {
      dut = d[1].toLowerCase();
      out[dut] ??= {};
      continue;
    }
    const l = dut ? /^ {6}([A-Za-z_][\w-]*):\s*(\{.*)$/.exec(line) : null;
    if (!l) {
      continue;
    }
    try {
      const v = parseFlow(flowMapAt(l[2])) as Record<string, Flow>;
      out[dut!][l[1]] = {
        ...(typeof v.role === 'string' ? { role: v.role } : {}),
        ...(typeof v.channel === 'string' ? { channel: v.channel } : {}),
        ...(typeof v.dut_gpio === 'number' ? { dut_gpio: v.dut_gpio } : {}),
        wired: v.wired !== false,
      };
    } catch {
      // not a line this reader understands
    }
  }
  return out;
}

/** The flow map at the start of `s`, up to its matching brace (what follows is a comment). */
function flowMapAt(s: string): string {
  let depth = 0;
  for (let k = 0; k < s.length; k++) {
    depth += s[k] === '{' ? 1 : s[k] === '}' ? -1 : 0;
    if (depth === 0) {
      return s.slice(0, k + 1);
    }
  }
  return s;
}

/** A profile's instances from the checkout (firmware/profiles/<profile>.profile.yaml); none when it cannot be read. */
export function readProfile(sourceDir: string, profile: string): Record<string, ProfileInstance> {
  try {
    return profileInstances(readFileSync(join(sourceDir, 'firmware', 'profiles', `${profile}.profile.yaml`), 'utf8'));
  } catch {
    return {};
  }
}

/** A capability's config defaults from the catalog (schema/capabilities/<cap>.cap.yaml). */
export function capDefaults(cap: string): Record<string, number> {
  const c = CATALOG.capabilities.find((x) => x.name === cap);
  return Object.fromEntries((c?.config ?? []).filter((x) => typeof x.default === 'number').map((x) => [x.name, x.default as number]));
}

/** fr.button's config as ButtonService runs it (button.cap.yaml defaults: debounce 20, long_press 600, gap 250, max 2). */
export interface ButtonCfg {
  debounce_ms: number;
  long_press_ms: number;
  multi_press_gap_ms: number;
  multi_press_max: number;
}

const num = (v: Flow | undefined, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** A DUT's button config: its profile instance's `config` over the cap defaults (§2.1: long_press_ms per DUT). */
export function buttonConfig(instances: Record<string, ProfileInstance>, instance = 'boot'): ButtonCfg {
  const d = capDefaults('fr.button');
  const c = instances[instance]?.config ?? {};
  return {
    debounce_ms: num(c.debounce_ms, d.debounce_ms ?? 20),
    long_press_ms: num(c.long_press_ms, d.long_press_ms ?? 600),
    multi_press_gap_ms: num(c.multi_press_gap_ms, d.multi_press_gap_ms ?? 250),
    multi_press_max: Math.min(5, Math.max(1, num(c.multi_press_max, d.multi_press_max ?? 2))),
  };
}

/** A DUT's LED config: max_brightness (the hard cap the WS2812 frames are scaled by) and the driver. */
export function ledConfig(instances: Record<string, ProfileInstance>, instance = 'status'): { max_brightness: number; driver: string | null } {
  const d = capDefaults('fr.led');
  const i = instances[instance];
  return { max_brightness: num(i?.config.max_brightness, d.max_brightness ?? 255), driver: i?.driver ?? null };
}

// ---- gestures on the gpio layer (§2.1) ----

/** The gestures T-HIL presses; `press` is a hold ended by `release`, `bounce` a click with contact bounce. */
export const HIL_GESTURES = ['click', 'double_click', 'long_press', 'press', 'bounce'] as const;
export type HilGesture = (typeof HIL_GESTURES)[number];

/** The hold the fixture uses for long_press when the DUT's long_press_ms is 0 (disabled): the cap default. */
const LONG_PRESS_FALLBACK_MS = 600;

/**
 * The fixture's segments for a gesture (§2.1; µs, press first): click 80 ms; double_click 80/100/80;
 * long_press long_press_ms + 200 ms; press held `holdMs` (until release); bounce 0.6/0.4/0.6/0.4/80 ms.
 */
export function segmentsFor(g: HilGesture, cfg: ButtonCfg, holdMs = 2000): number[] {
  switch (g) {
    case 'click':
      return [80_000];
    case 'double_click':
      return [80_000, 100_000, 80_000];
    case 'long_press':
      return [(cfg.long_press_ms > 0 ? cfg.long_press_ms : LONG_PRESS_FALLBACK_MS) * 1000 + 200_000];
    case 'press':
      return [holdMs * 1000];
    case 'bounce':
      return [600, 400, 600, 400, 80_000];
  }
}

/** One event ButtonService emits, at its time from the first press edge. */
export interface ExpectedEvent {
  evt: 'down' | 'up' | 'click' | 'long_press';
  at_us: number;
  count?: number;
  held_ms?: number;
}

/**
 * What ButtonService (button_service.cpp) emits for the line the segments make: the debounce lockout
 * (edges inside it ignored, the level re-sampled at its end), down/up on accepted edges, long_press at
 * long_press_ms into a press (then no click), clicks counted until multi_press_gap_ms passes or
 * multi_press_max is reached. Edges are ideal: the bounce gesture's short pulses fall inside the lockout.
 */
export function simulateButton(segments: readonly number[], cfg: ButtonCfg): ExpectedEvent[] {
  const edges: { t: number; pressed: boolean }[] = [];
  let t = 0;
  segments.forEach((d, k) => {
    edges.push({ t, pressed: k % 2 === 0 });
    t += d;
  });
  if (segments.length % 2 === 1) {
    edges.push({ t, pressed: false });
  }
  const levelAt = (x: number) => edges.filter((e) => e.t <= x).at(-1)?.pressed ?? false;
  const out: ExpectedEvent[] = [];
  const debounceUs = cfg.debounce_ms * 1000;
  const longOn = cfg.long_press_ms > 0;
  const max = Math.min(5, Math.max(1, cfg.multi_press_max));
  let stable = false;
  let pressed = false;
  let pressAt = 0;
  let noClick = false;
  let count = 0;
  let lockoutEnd = Number.NEGATIVE_INFINITY;
  let lockoutCheck: number | null = null;
  let longAt: number | null = null;
  let gapAt: number | null = null;
  const flush = (x: number) => {
    gapAt = null;
    if (count > 0) {
      out.push({ evt: 'click', at_us: x, count });
      count = 0;
    }
  };
  const press = (x: number) => {
    if (pressed) {
      return;
    }
    pressed = true;
    pressAt = x;
    noClick = false;
    gapAt = null;
    out.push({ evt: 'down', at_us: x });
    if (longOn) {
      longAt = x + cfg.long_press_ms * 1000;
    }
  };
  const release = (x: number) => {
    if (!pressed) {
      return;
    }
    pressed = false;
    longAt = null;
    out.push({ evt: 'up', at_us: x, held_ms: Math.floor((x - pressAt) / 1000) });
    if (noClick) {
      count = 0;
      return;
    }
    count++;
    if (count >= max) {
      flush(x);
    } else {
      gapAt = x + cfg.multi_press_gap_ms * 1000;
    }
  };
  const accept = (level: boolean, x: number) => {
    stable = level;
    lockoutEnd = x + debounceUs;
    lockoutCheck = lockoutEnd;
    if (level) {
      press(x);
    } else {
      release(x);
    }
  };
  let ei = 0;
  for (let guard = 0; guard < 10_000; guard++) {
    const next = Math.min(ei < edges.length ? edges[ei].t : Infinity, lockoutCheck ?? Infinity, longAt ?? Infinity, gapAt ?? Infinity);
    if (next === Infinity) {
      break;
    }
    if (ei < edges.length && edges[ei].t === next) {
      ei++;
      // on_button_edge: ignored while the lockout runs; otherwise the opposite of the stable state.
      if (next >= lockoutEnd) {
        accept(!stable, next);
      }
    } else if (lockoutCheck === next) {
      lockoutCheck = null;
      const lv = levelAt(next);
      if (lv !== stable) {
        accept(lv, next);
      }
    } else if (longAt === next) {
      longAt = null;
      if (pressed && !noClick) {
        noClick = true;
        flush(next);
        out.push({ evt: 'long_press', at_us: next, held_ms: Math.floor((next - pressAt) / 1000) });
      }
    } else if (gapAt === next) {
      flush(next);
    }
  }
  return out;
}

/** How a gesture's expected events read: `click{2}` for a click with its count. */
export function eventName(e: { evt: string; count?: number }): string {
  return e.evt === 'click' ? `click{${e.count ?? 1}}` : e.evt;
}

// ---- judging one gesture (§5.2 phase 2) ----

/** The DUT's button events a trial is judged on (STATEs and other members are not gestures). */
export const BUTTON_EVENTS = ['down', 'up', 'click', 'long_press'];

/** One gesture the fixture made and what it produced. */
export interface Trial {
  gesture: HilGesture;
  /** The fixture's segments (from input_simulate's `press`, else segmentsFor). */
  segments_us: number[];
  /** The fixture's edges on the button line in this trial (hil.edge). */
  edges: HubEvent[];
  /** The DUT's button events attributed to this trial. */
  events: HubEvent[];
  /** The hub refused the press (DEVICE_BUSY, LOCKED, ...). */
  error?: string;
  /**
   * A hub release cut the gesture short (D8: status interrupted; a DUT event, the fixture's WELCOME, a power
   * cut, hub stop): it did not make its segments, so its events are not judged and none count as missing.
   */
  interrupted?: { reason: string; after_us: number };
}

export interface TrialVerdict {
  gesture: HilGesture;
  /** No extra event, every down on time, every hold right, no refusal. Missing events go to the loss accounting. */
  ok: boolean;
  expected: string[];
  /** In DUT-time order. */
  got: string[];
  missing: string[];
  extra: string[];
  /** Each down's time after the fixture's press edge on the fit (µs); bounce: none (judged on counts). */
  down_latency_us: number[];
  /** Arrivals out of DUT-time order, and late flags: published, not judged (until M2-C3's reorder buffer). */
  out_of_order: number;
  late: number;
  problems: string[];
}

export interface TrialOptions {
  /** The line level that means pressed (pressedLevel). */
  pressedLevel: boolean;
  /** A down at most this long after the fixture's edge (µs, §5.2: 2 ms). */
  downMaxUs: number;
  /** How far before the edge a down may read, for the fit's error (µs; the fit's residual bound). */
  slackUs: number;
  /**
   * An event pairs with an expected one of its kind only within this of the expected one's DUT time (µs),
   * when the trial's press edges are timed: under half the 180 ms between a double_click's two downs (and
   * its two ups), so a lost first down never takes the second one, and far above any DUT's own lateness
   * (its core task, a loopback pad's poll()), which the 2 ms rule judges once paired.
   */
  pairUs: number;
}

export const TRIAL: TrialOptions = { pressedLevel: false, downMaxUs: 2000, slackUs: 500, pairUs: 80_000 };

/** At one DUT time ButtonService emits up before the click it flushes, and a click before the long_press that flushes it. */
const RANK: Record<string, number> = { down: 0, up: 1, click: 2, long_press: 3 };
const byDut = (a: HubEvent, b: HubEvent) =>
  (a.t_dev_us !== undefined && b.t_dev_us !== undefined ? cmp32(a.t_dev_us, b.t_dev_us) : 0) || (RANK[memberOf(a)] ?? 9) - (RANK[memberOf(b)] ?? 9) || a.seq - b.seq;
const byFix = (a: HubEvent, b: HubEvent) => cmp32(Number(f(a).t_fix_us ?? 0), Number(f(b).t_fix_us ?? 0)) || a.seq - b.seq;

/** How a DUT button event reads against eventName: `click{2}` for a click with its count. */
function gotName(e: HubEvent): string {
  const m = memberOf(e);
  return m === 'click' ? `click{${Number(f(e).count ?? 1)}}` : m;
}

/**
 * Pairs a gesture's expected events with the DUT's (both in time order) by an order-preserving alignment,
 * so a gap never takes a later event: the most pairs of the same kind (a click with another count is
 * another kind), then the least total distance between each event's DUT time and its expected one, `ref +
 * at_us` (`ref`: the DUT time of the trial's first press edge). With `ref`, an event pairs only within
 * `pairUs` of its expected time; without it (no timed edge), by order and kind alone. Returns, per expected
 * event, the index of its event in `got`, or -1: so one lost event is exactly one missing, and the rest pair
 * with their own.
 */
export function alignEvents(expected: readonly ExpectedEvent[], got: readonly HubEvent[], ref: number | null, pairUs: number = TRIAL.pairUs): number[] {
  const n = expected.length;
  const m = got.length;
  const cost = (i: number, j: number): number | null => {
    if (gotName(got[j]) !== eventName(expected[i])) {
      return null;
    }
    if (ref === null || got[j].t_dev_us === undefined) {
      return 0;
    }
    const d = Math.abs(cmp32(got[j].t_dev_us!, (ref + expected[i].at_us) >>> 0));
    return d <= pairUs ? d : null;
  };
  type Cell = { pairs: number; err: number };
  const better = (a: Cell, b: Cell) => a.pairs > b.pairs || (a.pairs === b.pairs && a.err < b.err);
  // best[i][j]: the best alignment of expected[i..] with got[j..].
  const best: Cell[][] = Array.from({ length: n + 1 }, () => Array.from({ length: m + 1 }, () => ({ pairs: 0, err: 0 })));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      let b = best[i + 1][j]; // expected i missing
      if (better(best[i][j + 1], b)) {
        b = best[i][j + 1]; // got j extra
      }
      const c = cost(i, j);
      if (c !== null) {
        const pair = { pairs: best[i + 1][j + 1].pairs + 1, err: best[i + 1][j + 1].err + c };
        if (better(pair, b)) {
          b = pair;
        }
      }
      best[i][j] = b;
    }
  }
  const out = new Array<number>(n).fill(-1);
  const same = (a: Cell, b: Cell) => a.pairs === b.pairs && a.err === b.err;
  for (let i = 0, j = 0; i < n && j < m; ) {
    const c = cost(i, j);
    if (c !== null && same(best[i][j], { pairs: best[i + 1][j + 1].pairs + 1, err: best[i + 1][j + 1].err + c })) {
      out[i++] = j++;
    } else if (same(best[i][j], best[i + 1][j])) {
      i++;
    } else {
      j++;
    }
  }
  return out;
}

/**
 * A line's presses as level transitions, in fixture-time order: a press is an edge to the pressed level from
 * another (or no known) level, its release the next edge away from it. An edge at the level the line already
 * has (a repeated reading: the hub's glitch filter drops them, timeline.ts) is no transition, so it can never
 * shift which release goes with which press; a release with no press before it in the trial is left out.
 */
export function pressHolds(edges: readonly HubEvent[], pressed: boolean): { press: HubEvent; release: HubEvent | null }[] {
  const out: { press: HubEvent; release: HubEvent | null }[] = [];
  let level: boolean | null = null;
  for (const e of [...edges].sort(byFix)) {
    const lv = f(e).level === true;
    if (lv === level) {
      continue;
    }
    level = lv;
    if (lv === pressed) {
      out.push({ press: e, release: null });
    } else if (out.length && out[out.length - 1].release === null) {
      out[out.length - 1].release = e;
    }
  }
  return out;
}

/**
 * One gesture's verdict (§5.2 phase 2): the expected events (simulateButton on the segments with the DUT's
 * config) against those it produced in DUT-time order, paired by alignEvents (by kind and by DUT time on the
 * trial's first press edge, so one lost event costs exactly one missing one); unpaired ones are missing or
 * extra. The fixture's edges are the hub's de-glitched hil.edge stream, taken as press/release transitions
 * (pressHolds). The n-th expected down (not bounce's) is timed against the n-th press and must fall within 2 ms
 * after its DUT time on the wired fit; the n-th up's held_ms is the n-th press's hold (its release less its
 * press) ± (debounce_ms + 2 ms). bounce is judged on counts only.
 */
export function judgeTrial(t: Trial, cfg: ButtonCfg, o: TrialOptions = TRIAL): TrialVerdict {
  const evs = t.events.filter((e) => BUTTON_EVENTS.includes(memberOf(e)));
  const got = [...evs].sort(byDut);
  if (t.interrupted) {
    // Not the DUT's to answer for event by event (nor the loss accounting's): the trial fails on the cut alone,
    // since every cause (the DUT went offline or rebooted, the fixture's session restarted, hub stop) is one
    // the gate run must not pass over.
    return {
      gesture: t.gesture,
      ok: false,
      expected: [],
      got: got.map(gotName),
      missing: [],
      extra: [],
      down_latency_us: [],
      out_of_order: 0,
      late: evs.filter((e) => e.late).length,
      problems: [`cut short ${Math.round(t.interrupted.after_us / 1000)} ms in by a hub release (${t.interrupted.reason}): not judged`],
    };
  }
  const expected = simulateButton(t.segments_us, cfg);
  // Press and release by transition, never by ordinal among same-level edges: a repeated release reading would
  // pair every later press with the release before its own (pad-c6's double_click, first bench run).
  const holds = pressHolds(t.edges, o.pressedLevel);
  const pressEdges = holds.map((h) => h.press);
  // The expected times start at the first press edge: only when every press segment has its edge (a lost
  // edge would shift them all) and that edge has a DUT time.
  const first = pressEdges.length === Math.ceil(t.segments_us.length / 2) ? pressEdges[0] : undefined;
  const ref = first && typeof f(first).t_dut_us === 'number' && f(first).sync !== 'none' ? (f(first).t_dut_us as number) : null;
  const pair = alignEvents(expected, got, ref, o.pairUs ?? TRIAL.pairUs);
  const used = new Set(pair.filter((j) => j >= 0));
  const missing = expected.filter((_, i) => pair[i] < 0).map(eventName);
  const extra = got.filter((_, idx) => !used.has(idx)).map(gotName);
  const problems: string[] = [];
  if (t.error) {
    problems.push(`the hub refused the ${t.gesture}: ${t.error}`);
  }
  if (extra.length) {
    problems.push(`extra ${extra.join(', ')}`);
  }
  const latency: number[] = [];
  if (t.gesture !== 'bounce') {
    // By ordinal among the expected ones: the n-th down belongs to the n-th press edge, whichever were lost.
    const ordinal = (evt: ExpectedEvent['evt']) => expected.flatMap((e, i) => (e.evt === evt ? [i] : []));
    ordinal('down').forEach((i, k) => {
      const ev = pair[i] >= 0 ? got[pair[i]] : undefined;
      if (!ev) {
        return; // missing: the loss accounting's
      }
      const edge = pressEdges[k];
      const tDut = edge ? f(edge).t_dut_us : null;
      if (!edge || typeof tDut !== 'number' || f(edge).sync !== 'wired' || ev.t_dev_us === undefined) {
        problems.push(`down ${k + 1} untimed: ${edge ? 'no wired fit for its press edge' : 'no fixture press edge'}`);
        return;
      }
      const d = cmp32(ev.t_dev_us, tDut);
      latency.push(d);
      if (d > o.downMaxUs || d < -o.slackUs) {
        problems.push(`down ${k + 1} ${d} µs after the fixture's edge (want ${-o.slackUs}..${o.downMaxUs})`);
      }
    });
    ordinal('up').forEach((i, k) => {
      const ev = pair[i] >= 0 ? got[pair[i]] : undefined;
      if (!ev) {
        return;
      }
      const p = holds[k]?.press;
      const r = holds[k]?.release;
      const holdMs = p && r ? cmp32(Number(f(r).t_fix_us), Number(f(p).t_fix_us)) / 1000 : (t.segments_us[2 * k] ?? 0) / 1000;
      const heldMs = Number(f(ev).held_ms);
      const tol = cfg.debounce_ms + 2;
      if (!Number.isFinite(heldMs) || Math.abs(heldMs - holdMs) > tol) {
        problems.push(`up ${k + 1} held_ms ${f(ev).held_ms} for a ${Math.round(holdMs * 10) / 10} ms hold (± ${tol})`);
      }
    });
  }
  // Arrival (seq) against DUT-time order, and late flags: published only.
  const arrival = [...evs].sort((a, b) => a.seq - b.seq);
  let outOfOrder = 0;
  for (let k = 1; k < arrival.length; k++) {
    if (arrival[k].t_dev_us !== undefined && arrival[k - 1].t_dev_us !== undefined && cmp32(arrival[k].t_dev_us!, arrival[k - 1].t_dev_us!) < 0) {
      outOfOrder++;
    }
  }
  return {
    gesture: t.gesture,
    ok: problems.length === 0,
    expected: expected.map(eventName),
    got: got.map(gotName),
    missing,
    extra,
    down_latency_us: latency,
    out_of_order: outOfOrder,
    late: evs.filter((e) => e.late).length,
    problems,
  };
}

/**
 * Splits a run of trials' readings and events by trial. `marks` are the seqs of the cursors input_simulate
 * returned (taken before each press): a trial's fixture edges are those after its mark and up to the next.
 * Its DUT events are those whose t_dev_us falls in its window on the fit, from 5 ms before its first edge to
 * `tailUs` after its last (the click comes multi_press_gap_ms after the release), the latest trial's where
 * two windows overlap; so an event that arrives late (after the next press) still counts for its own
 * gesture. With no wired times at all they go by seq like the edges. An event in no window is unattributed
 * (an extra).
 */
export function attribute(marks: readonly number[], edges: readonly HubEvent[], events: readonly HubEvent[], tailUs: number): { edges: HubEvent[][]; events: HubEvent[][]; unattributed: HubEvent[] } {
  const inSeq = (e: HubEvent, i: number) => e.seq > marks[i] && (i + 1 >= marks.length || e.seq <= marks[i + 1]);
  const trialEdges = marks.map((_, i) => edges.filter((e) => inSeq(e, i)));
  const timedOf = (es: readonly HubEvent[]) => es.filter((e) => typeof f(e).t_dut_us === 'number' && f(e).sync !== 'none').map((e) => f(e).t_dut_us as number);
  const ref = timedOf(edges)[0] ?? 0;
  const rel = (v: number) => cmp32(v, ref);
  const windows = trialEdges.map((es) => {
    const ts = timedOf(es).map(rel);
    return ts.length ? { from: Math.min(...ts) - 5000, to: Math.max(...ts) + tailUs } : null;
  });
  const out = marks.map(() => [] as HubEvent[]);
  const unattributed: HubEvent[] = [];
  const anyWindow = windows.some(Boolean);
  for (const e of events) {
    if (anyWindow && e.t_dev_us !== undefined) {
      const x = rel(e.t_dev_us);
      // Windows overlap by the tail: the event is the latest trial's that had begun by then.
      let i = -1;
      windows.forEach((w, k) => {
        if (w && x >= w.from && x <= w.to && (i < 0 || w.from >= windows[i]!.from)) {
          i = k;
        }
      });
      if (i >= 0) {
        out[i].push(e);
      } else {
        unattributed.push(e);
      }
      continue;
    }
    const i = marks.findIndex((_, k) => inSeq(e, k));
    if (i >= 0) {
      out[i].push(e);
    } else {
      unattributed.push(e);
    }
  }
  return { edges: trialEdges, events: out, unattributed };
}

/** One DUT's button phase in figures: per gesture, the totals, the down latency and the first problems. */
export function summarizeTrials(v: readonly TrialVerdict[]) {
  const byGesture: Record<string, { n: number; ok: number; missing: number; extra: number }> = {};
  for (const t of v) {
    const g = (byGesture[t.gesture] ??= { n: 0, ok: 0, missing: 0, extra: 0 });
    g.n++;
    g.ok += t.ok ? 1 : 0;
    g.missing += t.missing.length;
    g.extra += t.extra.length;
  }
  return {
    trials: v.length,
    ok: v.filter((t) => t.ok).length,
    expected: v.reduce((n, t) => n + t.expected.length, 0),
    missing: v.reduce((n, t) => n + t.missing.length, 0),
    extra: v.reduce((n, t) => n + t.extra.length, 0),
    by_gesture: byGesture,
    down_latency_us: usSummary(v.flatMap((t) => t.down_latency_us)),
    arrival: { out_of_order: v.reduce((n, t) => n + t.out_of_order, 0), late: v.reduce((n, t) => n + t.late, 0) },
    problems: v.flatMap((t, k) => t.problems.map((p) => `#${k + 1} ${t.gesture}: ${p}`)).slice(0, 10),
  };
}

// ---- loss accounting (§5.2 phase 2) ----

/** The DUT's delivery counters (diag stats: events_dropped, delivery_failed). */
export interface LossCounters {
  events_dropped: number;
  delivery_failed: number;
}

export function lossCounters(stats: Row | null | undefined): LossCounters | null {
  return stats && typeof stats.events_dropped === 'number' && typeof stats.delivery_failed === 'number' ? { events_dropped: stats.events_dropped, delivery_failed: stats.delivery_failed } : null;
}

export interface LossVerdict {
  /** pass; warn (an rf_weak DUT's accounted loss above the limit); fail. */
  verdict: 'pass' | 'warn' | 'fail';
  expected: number;
  missing: number;
  /** The counters' delta over the phase (events_dropped + delivery_failed). */
  delta: number | null;
  /** Losses in the RF figure: the missing events the counters show, plus `uncounted`. */
  accounted: number;
  /** Losses no counter covers but other evidence shows (phase 3: a STATE lost while the fixture saw its change). */
  uncounted: number;
  unaccounted: number;
  /** The RF loss figure: accounted missing events per expected event, in %. */
  loss_pct: number;
  rf_weak: boolean;
  /** The DUT commands the phase sent (first sends, not re-sends) and those that expired or went unanswered (each a lost or late delivery). */
  commands_sent: number;
  commands_lost: number;
  problems: string[];
}

/**
 * §5.2's loss rule: a missing event must be accounted for by the DUT's events_dropped + delivery_failed
 * delta over the phase; an unaccounted one fails, whatever the DUT. The accounted loss, with `uncounted`
 * losses (which no counter covers but other evidence shows), is the RF loss figure: above `maxPct` (1 %,
 * proposed) it fails, or warns on an rf_weak DUT (pad-c3), naming it. `allow` losses never fail on their own
 * (phase 3 expects only about 45-70 reports, where 1 % would be zero tolerance).
 *
 * `commands`: the DUT commands the phase sent and how many of their sends were lost on the way (an `expired`
 * answer: the CMD reached the node after its expire_at, hub time + 1 s; or no answer at all). They join the
 * figure as deliveries: `sent` in the expected count, `lost` among the losses no counter covers (the hub's
 * answer is the evidence), so a re-sent command that then ran still counts once.
 */
export function accountLosses(i: {
  alias?: string;
  expected: number;
  missing: number;
  uncounted?: number;
  commands?: { sent: number; lost: number };
  before: LossCounters | null;
  after: LossCounters | null;
  rfWeak: boolean;
  maxPct?: number;
  allow?: number;
}): LossVerdict {
  const maxPct = i.maxPct ?? 1;
  const problems: string[] = [];
  let delta: number | null = null;
  if (i.before && i.after) {
    const d = (a: number, b: number) => (a >= b ? a - b : a); // a counter that went back was reset (a reboot)
    delta = d(i.after.events_dropped, i.before.events_dropped) + d(i.after.delivery_failed, i.before.delivery_failed);
  }
  const cmdSent = i.commands?.sent ?? 0;
  const cmdLost = i.commands?.lost ?? 0;
  const expected = i.expected + cmdSent;
  const counted = Math.min(i.missing, delta ?? 0);
  const states = i.uncounted ?? 0;
  const uncounted = states + cmdLost;
  const accounted = counted + uncounted;
  const unaccounted = i.missing - counted;
  const pct = expected > 0 ? Math.round((10_000 * accounted) / expected) / 100 : 0;
  const who = i.alias ? `${i.alias}: ` : '';
  let verdict: LossVerdict['verdict'] = 'pass';
  if (unaccounted > 0) {
    verdict = 'fail';
    problems.push(`${who}${unaccounted} missing event(s) not accounted for by events_dropped + delivery_failed (+${delta ?? 'unknown'})`);
  }
  if (pct > maxPct && accounted > (i.allow ?? 0)) {
    if (i.rfWeak && verdict !== 'fail') {
      verdict = 'warn';
    } else {
      verdict = 'fail';
    }
    const notes = [states ? `${states} of them lost STATEs no counter covers` : '', cmdLost ? `${cmdLost} of them sends of a DUT command that expired or went unanswered (of ${cmdSent} commands)` : ''].filter(Boolean);
    problems.push(`${who}RF loss ${pct} % (${accounted} of ${expected} ${cmdSent ? 'events and commands' : 'events'}${notes.length ? `, ${notes.join(', ')}` : ''}) above ${maxPct} %${i.rfWeak ? ' (rf_weak: a warning)' : ''}`);
  }
  return { verdict, expected, missing: i.missing, delta, accounted, uncounted, unaccounted, loss_pct: pct, rf_weak: i.rfWeak, commands_sent: cmdSent, commands_lost: cmdLost, problems };
}

// ---- the LED matcher (§5.2 phase 3) ----

/** The steady LED state LedService shows (status.on, .color, .brightness; defaults: off, white, max_brightness). */
export interface LedState {
  on: boolean;
  color: number;
  brightness: number;
}

/** How the fixture reads a DUT's LED line. */
export interface LedLineCfg {
  decode: 'level' | 'ws2812';
  /** led_gpio: the pin level when lit (bench active_level). */
  active_level: 'low' | 'high';
  /** The profile's max_brightness (WS2812 boards: 64). */
  max_brightness: number;
}

/** led_ws2812.cpp scale(): one colour component at a brightness, rounded. */
export function scale(c: number, b: number): number {
  return Math.floor((c * b + 127) / 255);
}

/** The GRB word one WS2812 refresh sends for a state: each component scaled by the clamped brightness, 0 when off. */
export function wsGrb(s: LedState, maxBrightness: number): number {
  const b = s.on ? Math.min(s.brightness, maxBrightness) : 0;
  const r = (s.color >> 16) & 0xff;
  const g = (s.color >> 8) & 0xff;
  const bl = s.color & 0xff;
  return ((scale(g, b) << 16) | (scale(r, b) << 8) | scale(bl, b)) >>> 0;
}

/** A command the harness sent to the LED, by the seq of its cursor; `on` is the level it leaves (set), when known. */
export interface LedCommand {
  seq: number;
  command: string;
  on?: boolean;
  blink?: { count: number; on_ms: number; off_ms: number; color?: number };
}

export interface LedInput {
  /** The steady state before the first command (the hub's mirror). */
  initial: LedState;
  /** status.on / status.color / status.brightness STATEs (any order). */
  states: readonly HubEvent[];
  /** hil.edge or hil.frame on the LED line (any order). */
  readings: readonly HubEvent[];
  /** status.effect_done events. */
  effects: readonly HubEvent[];
  /** What the harness sent, in order. */
  commands: readonly LedCommand[];
}

export interface LedOptions {
  /** A change and its STATE within this (µs, §5.2: 5 ms), on the wired fit. */
  tolUs: number;
  /** Without a wired DUT time: hub times, with the reading's u_us added (or this when it has none). */
  hubSlackUs: number;
  /**
   * Blink on-phase widths: p99 (and the narrowest) within on_ms ± this (ms): 5, the spec's "LED level within
   * 5 ms" (10 §10.5, T-HIL row). The first proposal, 2, failed pad-s3 (-75 dBm) on one 102.03 ms on-phase: a
   * core-task delay on the DUT under Wi-Fi load, not an LED fault.
   */
  blinkTolMs: number;
  /** STATEs a get_state resync brought: at most this share (%). */
  maxResyncPct: number;
}

export const LED: LedOptions = { tolUs: 5000, hubSlackUs: 10_000, blinkTolMs: 5, maxResyncPct: 5 };

export interface BlinkVerdict {
  pass: boolean;
  seq: number;
  pulses: number;
  widths_ms: number[];
  /** effect_done after the last edge on the data line (ms); null without effect_done. */
  done_after_last_ms: number | null;
  problems: string[];
}

export interface LedVerdict {
  pass: boolean;
  /** LED changes the fixture saw (identical WS2812 re-sends left out). */
  changes: number;
  resends: number;
  explained: { state: number; blink: number; resync: number };
  /** Changes with no STATE that one of the harness's commands made: the STATE was lost (to account). */
  state_lost: number;
  unexplained: { cursor: string; lit: boolean; grb: number | null }[];
  /**
   * Timed status.on changes with no fixture change of the same level within the tolerance; `bad_frame`: a
   * bad frame came instead, within it.
   */
  missing_changes: { cursor: string; on: boolean; bad_frame?: string }[];
  wrong_value: { cursor: string; want: string; got: string }[];
  /**
   * Commands with a known level (set, toggle) that the fixture does not show by the next command: the level
   * of the last reading in the command's window, else the one it found, against `on`. A command the DUT
   * answered ok but that changed nothing (no STATE, no reading) shows here.
   */
  not_applied: { seq: number; command: string; want: boolean; got: boolean }[];
  /**
   * WS2812 frames that were not exactly 24 bits (D4's bad_frames: a glitch, a frame lost to a full RX queue
   * as 0 bits, a wrong length): no LED reading, so left out of every rule above and listed.
   */
  bad_frames: { n: number; cursors: string[]; bits: number[] };
  /**
   * What a STATE and its reading were judged within (µs): tolUs on the wired fit; on hub time (no fresh fit,
   * `sync: hub`), tolUs + the reading's u_us, the largest of those used here (null: none).
   */
  tolerance_us: { wired: number; hub_max: number | null };
  /** status.on STATE time less its change's time (µs). */
  state_to_change_us: ReturnType<typeof usSummary>;
  timed_states: number;
  resync: { n: number; pct: number; states: { cursor: string; type: string; value: unknown }[] };
  blinks: BlinkVerdict[];
  /** blinks: n, all pass, widths (ms) p50/p99. */
  blink: { n: number; pass: boolean; width_p50_ms: number | null; width_p99_ms: number | null };
  /** Readings by sync (wired, hub, none). */
  sync: Record<string, number>;
  problems: string[];
}

const PROPS = ['on', 'color', 'brightness'];
const propOf = (e: HubEvent) => memberOf(e);
const valueOf = (e: HubEvent) => f(e)[propOf(e)];

function apply(s: LedState, e: HubEvent): LedState {
  const v = valueOf(e);
  switch (propOf(e)) {
    case 'on':
      return { ...s, on: v === true };
    case 'color':
      return typeof v === 'number' ? { ...s, color: v } : s;
    case 'brightness':
      return typeof v === 'number' ? { ...s, brightness: v } : s;
  }
  return s;
}

const hex = (v: number | null) => (v === null ? 'none' : `0x${v.toString(16).padStart(6, '0')}`);

/**
 * A hil.frame that is not one WS2812 pixel (D4: exactly 24 bits): FixtureService sends every decoded frame,
 * with grb 0 for a bad one (a glitch, a wrong length, a frame lost to a full RX queue as 0 bits), so it would
 * read as a dark frame. It is no LED reading.
 */
export function isBadFrame(r: HubEvent): boolean {
  return r.type === 'hil.frame' && typeof f(r).bits === 'number' && f(r).bits !== 24;
}

/** Whether a reading on an LED line shows it lit: a frame's `lit` (else grb ≠ 0), an edge at the active level. Null for a bad frame. */
export function readingLit(r: HubEvent, line: Pick<LedLineCfg, 'active_level'>): boolean | null {
  if (isBadFrame(r)) {
    return null;
  }
  if (r.type === 'hil.frame') {
    return typeof f(r).lit === 'boolean' ? (f(r).lit as boolean) : (Number(f(r).grb) >>> 0) !== 0;
  }
  return f(r).level === (line.active_level === 'high');
}

/** Readings in fixture-time order (and seq at equal times). */
export function byFixtureTime(a: HubEvent, b: HubEvent): number {
  return byFix(a, b);
}

/**
 * §5.2 phase 3 on one DUT's LED line:
 * - every timed status.on change has a fixture change of the same level (a led_gpio edge at the bench's
 *   active level, or a WS2812 frame) within 5 ms on the fit;
 * - every fixture change, and every frame whose GRB differs from the previous one, is explained by a STATE
 *   (on, color, brightness) within 5 ms, or lies in a blink's window; an identical frame (a set that changes
 *   nothing, a selftest, the boot "start dark" refresh) is a re-send, ignored;
 * - a frame shows the state: lit ⇔ on, GRB = each component scaled by min(brightness, max_brightness) as
 *   (c·b+127)/255; a blink's on-phase shows the blink colour (the steady one) at the steady brightness;
 * - a change one of the harness's commands made with no STATE at all is a lost STATE (`state_lost`, which
 *   the caller accounts for by the DUT's counters); one a resync STATE (resync: true) caught up with is
 *   explained by it; resync STATEs are untimed, at most 5 % of them, each listed;
 * - each blink: `count` pulses of on_ms ± 5 ms (p99; widths p50/p99 published), effect_done within 5 ms of the last edge on the line
 *   (a WS2812 line's identical restore frame; on a led_gpio line, which the restore to off leaves flat, the
 *   last off edge + off_ms);
 * - every set or toggle took effect: the fixture shows its level by the next command (`not_applied`);
 * - a hil.frame of other than 24 bits is a bad frame (D4), not a reading: listed in `bad_frames`, never a
 *   change. Alone it fails nothing; a bad frame in place of the real one leaves its STATE without a change.
 */
export function matchLed(input: LedInput, line: LedLineCfg, o: LedOptions = LED): LedVerdict {
  const problems: string[] = [];
  const litOfEdge = (e: HubEvent) => f(e).level === (line.active_level === 'high');
  const sorted = [...input.readings].sort(byFix);
  const bad = sorted.filter(isBadFrame);
  const readings = sorted.filter((r) => !isBadFrame(r));
  const sync: Record<string, number> = {};
  type Change = { e: HubEvent; lit: boolean; grb: number | null; resend: boolean; how?: 'state' | 'blink' | 'resync' | 'state_lost' | 'unexplained' };
  const all: Change[] = [];
  let prevLit = input.initial.on;
  let prevGrb: number | null = line.decode === 'ws2812' ? wsGrb(input.initial, line.max_brightness) : null;
  for (const r of readings) {
    sync[String(f(r).sync ?? 'none')] = (sync[String(f(r).sync ?? 'none')] ?? 0) + 1;
    if (r.type === 'hil.frame') {
      const grb = Number(f(r).grb) >>> 0;
      const lit = typeof f(r).lit === 'boolean' ? (f(r).lit as boolean) : grb !== 0;
      all.push({ e: r, lit, grb, resend: grb === prevGrb });
      prevGrb = grb;
      prevLit = lit;
    } else {
      const lit = litOfEdge(r);
      all.push({ e: r, lit, grb: null, resend: lit === prevLit });
      prevLit = lit;
    }
  }
  const changes = all.filter((c) => !c.resend);
  const states = [...input.states].filter((s) => PROPS.includes(propOf(s))).sort(byDut);
  const timed = states.filter((s) => !s.resync);
  const resyncs = states.filter((s) => s.resync);
  /** A STATE's time less a reading's, and the tolerance for that pair. */
  const gap = (s: HubEvent, r: HubEvent): { d: number; tol: number } => {
    const tDut = f(r).t_dut_us;
    if (typeof tDut === 'number' && s.t_dev_us !== undefined && f(r).sync !== 'none') {
      return { d: cmp32(s.t_dev_us, tDut), tol: o.tolUs + (f(r).sync === 'wired' ? 0 : Number(f(r).u_us ?? 0)) };
    }
    return { d: s.t_hub_us - Number(f(r).t_hub_us ?? r.t_hub_us), tol: o.tolUs + (typeof f(r).u_us === 'number' ? (f(r).u_us as number) : o.hubSlackUs) };
  };
  // The widest tolerance a reading off the wired fit was judged with (published: T-LED presses nothing, so
  // its readings are usually on hub time, judged within 5 ms + u_us rather than 5 ms).
  const hubTols = readings.filter((r) => f(r).sync !== 'wired').map((r) => (typeof f(r).t_dut_us === 'number' && f(r).sync !== 'none' ? o.tolUs + Number(f(r).u_us ?? 0) : o.tolUs + (typeof f(r).u_us === 'number' ? (f(r).u_us as number) : o.hubSlackUs)));
  const near = (s: HubEvent, r: HubEvent) => {
    const g = gap(s, r);
    return Math.abs(g.d) <= g.tol;
  };
  // The steady state a reading should show: the STATEs before it, and those that report it (within the
  // tolerance after it, but before the next change: two commands a few ms apart each have their own).
  const nextOf = new Map(changes.map((c, k) => [c.e, changes[k + 1]?.e]));
  const stateAt = (r: HubEvent): LedState => {
    let s = input.initial;
    const next = nextOf.get(r);
    for (const st of timed) {
      const g = gap(st, r);
      if (g.d <= 0 || (g.d <= g.tol && (!next || gap(st, next).d < 0))) {
        s = apply(s, st);
      }
    }
    return s;
  };
  // Command windows by seq: a reading belongs to the last command sent before it.
  const cmds = [...input.commands].sort((a, b) => a.seq - b.seq);
  const cmdOf = (r: HubEvent) => {
    let c: LedCommand | undefined;
    for (const x of cmds) {
      if (x.seq < r.seq) {
        c = x;
      }
    }
    return c;
  };
  const usedResync = new Set<HubEvent>();
  const wrong: LedVerdict['wrong_value'] = [];
  for (const c of changes) {
    const cmd = cmdOf(c.e);
    if (timed.some((s) => near(s, c.e))) {
      c.how = 'state';
      let want = stateAt(c.e);
      // A set that changed `on` and the colour: its colour STATE came, its `on` STATE was lost. The level
      // is the command's (a lost STATE, for the accounting); the rest is judged on the STATEs that came.
      if (want.on !== c.lit && cmd?.on === c.lit && !timed.some((s) => propOf(s) === 'on' && near(s, c.e))) {
        c.how = 'state_lost';
        want = { ...want, on: c.lit };
      }
      if (line.decode === 'ws2812') {
        const grb = wsGrb(want, line.max_brightness);
        if (c.grb !== grb || c.lit !== want.on) {
          wrong.push({ cursor: c.e.cursor, want: `${want.on ? 'lit' : 'dark'} ${hex(grb)}`, got: `${c.lit ? 'lit' : 'dark'} ${hex(c.grb)}` });
        }
      } else if (c.lit !== want.on) {
        wrong.push({ cursor: c.e.cursor, want: want.on ? 'lit' : 'dark', got: c.lit ? 'lit' : 'dark' });
      }
      continue;
    }
    if (cmd?.blink) {
      c.how = 'blink';
      if (line.decode === 'ws2812') {
        const steady = stateAt(c.e);
        const grb = c.lit ? wsGrb({ on: true, color: cmd.blink.color ?? steady.color, brightness: steady.brightness }, line.max_brightness) : 0;
        if (c.grb !== grb) {
          wrong.push({ cursor: c.e.cursor, want: `blink ${hex(grb)}`, got: hex(c.grb) });
        }
      }
      continue;
    }
    const caught = resyncs.find((s) => !usedResync.has(s) && s.seq > c.e.seq && propOf(s) === 'on' && valueOf(s) === c.lit);
    if (caught) {
      usedResync.add(caught);
      c.how = 'resync';
      continue;
    }
    if (cmd && (cmd.on === undefined || cmd.on === c.lit)) {
      c.how = 'state_lost';
      continue;
    }
    c.how = 'unexplained';
  }
  // Every timed status.on STATE has its fixture change (LedService reports `on` only when it changes).
  const missing: LedVerdict['missing_changes'] = [];
  const toChange: number[] = [];
  for (const s of timed) {
    if (propOf(s) !== 'on') {
      continue;
    }
    const v = valueOf(s) === true;
    const hit = changes.find((c) => c.lit === v && near(s, c.e));
    if (hit) {
      toChange.push(gap(s, hit.e).d);
    } else {
      const instead = bad.find((r) => near(s, r));
      missing.push({ cursor: s.cursor, on: v, ...(instead ? { bad_frame: instead.cursor } : {}) });
    }
  }
  // Every set and toggle took effect: by the next command the fixture shows the level it leaves.
  const notApplied: LedVerdict['not_applied'] = [];
  cmds.forEach((cmd, k) => {
    if (cmd.on === undefined) {
      return;
    }
    const until = cmds[k + 1]?.seq ?? Infinity;
    const shown = all.filter((c) => c.e.seq > cmd.seq && c.e.seq <= until).at(-1) ?? all.filter((c) => c.e.seq <= cmd.seq).at(-1);
    const level = shown ? shown.lit : input.initial.on;
    if (level !== cmd.on) {
      notApplied.push({ seq: cmd.seq, command: cmd.command, want: cmd.on, got: level });
    }
  });
  // Blinks.
  const blinks: BlinkVerdict[] = [];
  cmds.forEach((cmd, k) => {
    if (!cmd.blink) {
      return;
    }
    const until = cmds[k + 1]?.seq ?? Infinity;
    const inWin = all.filter((c) => c.e.seq > cmd.seq && c.e.seq <= until);
    const done = input.effects.find((e) => e.seq > cmd.seq && e.seq <= until && String(f(e).effect ?? 'blink') === 'blink') ?? null;
    const bp: string[] = [];
    const widths: number[] = [];
    let pulses = 0;
    let lastOff: Change | undefined;
    let onAt: Change | undefined;
    for (const c of inWin.filter((x) => !x.resend)) {
      if (c.lit) {
        pulses++;
        onAt = c;
      } else if (onAt) {
        widths.push(cmp32(Number(f(c.e).t_fix_us), Number(f(onAt.e).t_fix_us)) / 1000);
        onAt = undefined;
        lastOff = c;
      }
    }
    if (pulses !== cmd.blink.count) {
      bp.push(`${pulses} pulses, not ${cmd.blink.count}`);
    }
    const p99 = quantile(widths, 0.99);
    const min = widths.length ? Math.min(...widths) : null;
    if (p99 !== null && (p99 > cmd.blink.on_ms + o.blinkTolMs || (min ?? 0) < cmd.blink.on_ms - o.blinkTolMs)) {
      bp.push(`on-phase widths ${Math.round((min ?? 0) * 100) / 100}..${Math.round(p99 * 100) / 100} ms (p99), want ${cmd.blink.on_ms} ± ${o.blinkTolMs}`);
    }
    // The last edge on the line: the identical restore frame after the last off phase, else last off + off_ms.
    const restore = inWin.filter((c) => c.resend && lastOff && c.e.seq > lastOff.e.seq).at(-1);
    let after: number | null = null;
    if (!done) {
      bp.push('no status.effect_done');
    } else if (lastOff) {
      const ref = restore?.e ?? lastOff.e;
      const g = gap(done, ref);
      after = (g.d - (restore ? 0 : cmd.blink.off_ms * 1000)) / 1000;
      if (Math.abs(after * 1000) > g.tol) {
        bp.push(`effect_done ${Math.round(after * 100) / 100} ms from the last edge (± ${g.tol / 1000})`);
      }
    }
    blinks.push({ pass: bp.length === 0, seq: cmd.seq, pulses, widths_ms: widths.map((w) => Math.round(w * 100) / 100), done_after_last_ms: after === null ? null : Math.round(after * 100) / 100, problems: bp });
  });
  const resyncPct = states.length ? Math.round((10_000 * resyncs.length) / states.length) / 100 : 0;
  const unexplained = changes.filter((c) => c.how === 'unexplained').map((c) => ({ cursor: c.e.cursor, lit: c.lit, grb: c.grb }));
  if (unexplained.length) {
    problems.push(`${unexplained.length} LED change(s) no STATE or blink explains (first ${unexplained[0].cursor})`);
  }
  if (missing.length) {
    const metByBad = missing.filter((x) => x.bad_frame).length;
    problems.push(`${missing.length} status.on change(s) with no fixture change within ${o.tolUs / 1000} ms (first ${missing[0].cursor})${metByBad ? `; ${metByBad} met by a bad frame instead (bits ${bad.map((r) => Number(f(r).bits)).slice(0, 3).join(', ')})` : ''}`);
  }
  if (wrong.length) {
    problems.push(`${wrong.length} change(s) showing the wrong value (first ${wrong[0].cursor}: want ${wrong[0].want}, got ${wrong[0].got})`);
  }
  if (notApplied.length) {
    const lit = (b: boolean) => (b ? 'lit' : 'dark');
    problems.push(`${notApplied.length} command(s) the fixture shows had no effect by the next command (first status.${notApplied[0].command} at seq ${notApplied[0].seq}: want ${lit(notApplied[0].want)}, reads ${lit(notApplied[0].got)})`);
  }
  if (resyncPct > o.maxResyncPct) {
    problems.push(`${resyncs.length} resync STATEs (${resyncPct} %) above ${o.maxResyncPct} %`);
  }
  for (const b of blinks.filter((x) => !x.pass)) {
    problems.push(`blink at seq ${b.seq}: ${b.problems.join('; ')}`);
  }
  const allWidths = blinks.flatMap((b) => b.widths_ms);
  const count = (how: Change['how']) => changes.filter((c) => c.how === how).length;
  return {
    pass: problems.length === 0,
    changes: changes.length,
    resends: all.length - changes.length,
    explained: { state: count('state'), blink: count('blink'), resync: count('resync') },
    state_lost: count('state_lost'),
    unexplained: unexplained.slice(0, 10),
    missing_changes: missing.slice(0, 10),
    wrong_value: wrong.slice(0, 10),
    not_applied: notApplied.slice(0, 10),
    bad_frames: { n: bad.length, cursors: bad.slice(0, 10).map((r) => r.cursor), bits: bad.slice(0, 10).map((r) => Number(f(r).bits)) },
    tolerance_us: { wired: o.tolUs, hub_max: hubTols.length ? Math.max(...hubTols) : null },
    state_to_change_us: usSummary(toChange),
    timed_states: timed.length,
    resync: { n: resyncs.length, pct: resyncPct, states: resyncs.map((s) => ({ cursor: s.cursor, type: s.type, value: valueOf(s) })) },
    blinks,
    blink: { n: blinks.length, pass: blinks.every((b) => b.pass), width_p50_ms: quantile(allWidths, 0.5), width_p99_ms: quantile(allWidths, 0.99) },
    sync,
    problems,
  };
}

// ---- the fit (§5.2 phase 1) and test_pin pulses (phase 4) ----

export interface FitVerdict {
  pass: boolean;
  samples: number | null;
  rejected: number | null;
  /** Samples rejected more than 1 ms off: late stamps (a flash-cache stall). */
  late_stamps: number | null;
  offset_us: number | null;
  skew_ppm: number | null;
  residual_p99_us: number | null;
  age_ms: number | null;
  valid: boolean;
  /** The DUT's ISR-to-stamp latency from its own test_pin line (debug DUTs, D10), when the hub has it. */
  isr_latency_us: number | null;
  problems: string[];
}

/** The press-based fit's verdict (§5.2 phase 1): valid, residual p99 ≤ 500 µs, ≤ 10 % of the samples rejected (proposed). */
export function judgeFit(fit: Row | null | undefined, o = { maxResidualP99Us: 500, maxRejectedPct: 10 }): FitVerdict {
  const problems: string[] = [];
  if (!fit) {
    return { pass: false, samples: null, rejected: null, late_stamps: null, offset_us: null, skew_ppm: null, residual_p99_us: null, age_ms: null, valid: false, isr_latency_us: null, problems: ['no fit (no accepted press sample)'] };
  }
  const samples = Number(fit.samples ?? 0);
  const rejected = Number(fit.rejected ?? 0);
  const pct = samples + rejected > 0 ? (100 * rejected) / (samples + rejected) : 0;
  if (fit.valid !== true) {
    problems.push(`the fit is not valid (${samples} accepted, newest ${fit.age_ms} ms old)`);
  }
  if (typeof fit.residual_p99_us !== 'number' || fit.residual_p99_us > o.maxResidualP99Us) {
    problems.push(`residual p99 ${fit.residual_p99_us} µs (≤ ${o.maxResidualP99Us})`);
  }
  if (pct > o.maxRejectedPct) {
    problems.push(`${rejected} of ${samples + rejected} samples rejected (${Math.round(pct)} % > ${o.maxRejectedPct} %)`);
  }
  const n = (v: unknown) => (typeof v === 'number' ? v : null);
  return {
    pass: problems.length === 0,
    samples,
    rejected,
    late_stamps: n(fit.late_stamps) ?? rejected,
    offset_us: n(fit.offset_us),
    skew_ppm: n(fit.skew_ppm),
    residual_p99_us: n(fit.residual_p99_us),
    age_ms: n(fit.age_ms),
    valid: fit.valid === true,
    isr_latency_us: n(fit.isr_latency_us),
    problems,
  };
}

/**
 * The wired fit against the hub path (D10's cross-check, published): per click, the down's latency after
 * its press edge on the fit less the same through the hub's two TIME offsets (µs).
 */
export function wiredMinusHub(trials: readonly { edges: HubEvent[]; events: HubEvent[] }[], pressed = false): number[] {
  const out: number[] = [];
  for (const t of trials) {
    const edge = [...t.edges].sort(byFix).find((e) => f(e).level === pressed && typeof f(e).t_dut_us === 'number' && f(e).sync === 'wired');
    const down = [...t.events].sort(byDut).find((e) => memberOf(e) === 'down' && e.t_dev_us !== undefined);
    if (edge && down) {
      const wired = cmp32(down.t_dev_us!, f(edge).t_dut_us as number);
      const hub = down.t_hub_us - Number(f(edge).t_hub_us ?? edge.t_hub_us);
      out.push(wired - hub);
    }
  }
  return out;
}

/**
 * test_pin pulses on a line (hil.edge): each low-to-high width in fixture µs, by level transition (an edge at
 * the level the line already has is none), and transitions that pair with none.
 */
export function pulseWidths(edges: readonly HubEvent[]): { widths_us: number[]; unpaired: number } {
  const widths: number[] = [];
  let low: HubEvent | undefined;
  let unpaired = 0;
  let level: boolean | null = null;
  for (const e of [...edges].sort(byFix)) {
    const lv = f(e).level === true;
    if (lv === level) {
      continue;
    }
    level = lv;
    if (!lv) {
      low = e;
    } else if (low) {
      widths.push(cmp32(Number(f(e).t_fix_us), Number(f(low).t_fix_us)));
      low = undefined;
    } else {
      unpaired++;
    }
  }
  return { widths_us: widths, unpaired: unpaired + (low ? 1 : 0) };
}

/** §5.2 phase 4: `count` pulses, width p90 within 1,000 ± 500 µs (proposed), and no low outside a pulse across the reboot. */
export function judgePulses(i: { widths_us: number[]; unpaired: number; count: number; lowsAcrossReboot: number; wantUs?: number; tolUs?: number }) {
  const want = i.wantUs ?? 1000;
  const tol = i.tolUs ?? 500;
  const problems: string[] = [];
  const p90 = quantile(i.widths_us, 0.9);
  if (i.widths_us.length !== i.count) {
    problems.push(`${i.widths_us.length} pulses seen, not ${i.count}${i.unpaired ? ` (${i.unpaired} unpaired edges)` : ''}`);
  }
  if (p90 === null || Math.abs(p90 - want) > tol) {
    problems.push(`width p90 ${p90} µs, want ${want} ± ${tol}`);
  }
  if (i.lowsAcrossReboot > 0) {
    problems.push(`the line went low ${i.lowsAcrossReboot} time(s) across the reboot (outside a pulse)`);
  }
  return { pass: problems.length === 0, pulses: i.widths_us.length, width_us: { ...usSummary(i.widths_us), p90: p90 === null ? null : Math.round(p90) }, lows_across_reboot: i.lowsAcrossReboot, problems };
}

// ---- the wiring check (§5.2 phase 0b) ----

/** The bench lines the wiring check probes: BOOT by a gpio click, the LED by status.set on then off, test_pin by one pin_pulse. */
export const WIRING_LINES = ['boot', 'status', 'test_pin'] as const;
export type WiringLine = (typeof WIRING_LINES)[number];

/** One probe of one DUT's bench line, and where it showed. */
export interface WiringProbe {
  alias: string;
  line: WiringLine;
  /** The DUT's bench channel for the line (bench_get). */
  channel: string;
  /**
   * The bench DUTs where the probe showed: for boot, those whose boot events came (down, up, click,
   * long_press); for status and test_pin, those whose own bench line of that name read a change.
   */
  reached: string[];
  /** What showed, per DUT that showed it (boot: its events; status: lit/dark readings; test_pin: low/high edges). */
  seen: Record<string, string[]>;
  /** boot: the fixture's own readings of the clicked channel (none: it did not drive the line). */
  fixture_edges?: number;
  /** How long the probe waited for an answer (ms), for the report. */
  waited_ms: number;
  /** The probe could not run: the hub refused the click, a command failed twice. */
  error?: string;
}

/** One bench line moved to the channel its probe reached (the bench-file edit that would match the wiring). */
export interface WiringMove {
  device: string;
  alias: string;
  line: WiringLine;
  from: { channel: string; fixture_gpio: number };
  to: { channel: string; fixture_gpio: number };
}

export interface WiringLineVerdict {
  ok: boolean;
  channel: string;
  reached: string[];
  seen: Record<string, string[]>;
  problem?: string;
}

export interface WiringVerdict {
  pass: boolean;
  duts: Record<string, { pass: boolean; lines: Partial<Record<WiringLine, WiringLineVerdict>> }>;
  /** `swapped: pad-X <-> pad-Y (boot, status, test_pin)`: two DUTs whose probed lines each reached the other only. */
  swapped: string[];
  /**
   * Each line whose probe reached exactly one other DUT, moved to that DUT's channel for the line, when the
   * moves of that line close into whole cycles among the probed DUTs (a swap is a cycle of two): then the
   * bench file edited so would match the wiring found. Lines reaching nothing, or more than one DUT, get none.
   */
  moves: WiringMove[];
  problems: string[];
}

/**
 * The wiring check's verdict (§5.2 phase 0b) from its probes, one DUT after another: each probed line must
 * show on its own DUT and on no other bench DUT. A mismatch says which channel reached which DUT; two DUTs
 * whose lines each reached the other only are `swapped`, and the bench-file moves that would match the
 * wiring are listed (benchEdit turns them into the exact edit). `duts`: every bench DUT (bench_get order),
 * for its channels and aliases; `fx`: the fixture's name.
 */
export function diagnoseWiring(probes: readonly WiringProbe[], duts: readonly HilDut[], fx = 'the fixture'): WiringVerdict {
  const dut = (alias: string) => duts.find((d) => d.alias === alias);
  const chOf = (alias: string, line: WiringLine) => dut(alias)?.lines[line]?.channel ?? '?';
  const out: WiringVerdict['duts'] = {};
  const problems: string[] = [];
  const at = (alias: string, line: WiringLine) => probes.find((p) => p.alias === alias && p.line === line);
  for (const p of probes) {
    const self = p.reached.includes(p.alias);
    const others = p.reached.filter((a) => a !== p.alias);
    const ok = !p.error && self && others.length === 0;
    let problem: string | undefined;
    const own = `${fx} ${p.channel} (${p.alias}'s bench ${p.line} line)`;
    if (p.error) {
      problem = `${p.alias} ${p.line}: could not probe it: ${p.error}`;
    } else if (!p.reached.length) {
      problem =
        p.line === 'boot'
          ? `${p.alias} boot: a click on ${own} reached no DUT: no boot event from any bench DUT within ${p.waited_ms} ms${p.fixture_edges === 0 ? `, and ${fx} read no edge on ${p.channel}` : ''}`
          : p.line === 'status'
            ? `${p.alias} status: status.set on, then off, on ${p.alias} showed on no ${fx} channel: its bench status line ${p.channel} read nothing within ${p.waited_ms} ms`
            : `${p.alias} test_pin: pin_pulse on ${p.alias} showed on no ${fx} channel: its bench test_pin line ${p.channel} read no edge within ${p.waited_ms} ms`;
    } else if (others.length) {
      const where = others.map((o) => `${fx} ${chOf(o, p.line)} (${o}'s bench ${p.line} line)`).join(' and ');
      problem =
        p.line === 'boot'
          ? `${p.alias} boot: a click on ${own} pressed ${others.join(' and ')}${self ? ` as well as ${p.alias}` : `, not ${p.alias}`} (${others.map((o) => `${p.seen[o]?.join(', ') ?? 'events'} from ${o}`).join('; ')})`
          : `${p.alias} ${p.line}: ${p.line === 'status' ? 'status.set' : 'pin_pulse'} on ${p.alias} showed on ${where}${self ? ` as well as on ${p.channel}` : `, not on ${p.channel}`}`;
    }
    if (problem) {
      problems.push(problem);
    }
    const d = (out[p.alias] ??= { pass: true, lines: {} });
    d.lines[p.line] = { ok, channel: p.channel, reached: [...p.reached], seen: p.seen, ...(problem ? { problem } : {}) };
    d.pass &&= ok;
  }
  // Swaps: two DUTs whose probed lines each reached the other, and only the other.
  const aliases = [...new Set(probes.map((p) => p.alias))];
  const only = (p: WiringProbe | undefined, a: string) => !!p && !p.error && p.reached.length === 1 && p.reached[0] === a;
  const swapped: string[] = [];
  aliases.forEach((x, i) => {
    for (const y of aliases.slice(i + 1)) {
      const lines = WIRING_LINES.filter((l) => only(at(x, l), y) && only(at(y, l), x));
      if (lines.length) {
        swapped.push(`swapped: ${x} <-> ${y} (${lines.join(', ')})`);
      }
    }
  });
  // Moves: per line, each probe that reached exactly one other DUT takes that DUT's channel; only whole cycles.
  const moves: WiringMove[] = [];
  for (const line of WIRING_LINES) {
    const to = new Map<string, string>();
    for (const p of probes.filter((x) => x.line === line && !x.error && x.reached.length === 1 && x.reached[0] !== x.alias)) {
      to.set(p.alias, p.reached[0]);
    }
    for (const start of to.keys()) {
      const cycle: string[] = [];
      let a: string | undefined = start;
      while (a !== undefined && !cycle.includes(a)) {
        cycle.push(a);
        a = to.get(a);
      }
      if (a !== start) {
        continue; // a chain that ends on a DUT whose line stays (or was not probed): no edit for it
      }
      const x = dut(start)?.lines[line];
      const y = dut(to.get(start)!)?.lines[line];
      const xd = dut(start);
      if (x && y && xd) {
        moves.push({ device: xd.device, alias: start, line, from: { channel: x.channel, fixture_gpio: x.fixture_gpio }, to: { channel: y.channel, fixture_gpio: y.fixture_gpio } });
      }
    }
  }
  const order = (m: WiringMove) => duts.findIndex((d) => d.device === m.device) * 10 + WIRING_LINES.indexOf(m.line);
  moves.sort((a, b) => order(a) - order(b));
  return { pass: problems.length === 0, duts: out, swapped, moves, problems };
}

/** One bench-file line as it reads now, and as it would read once moved. */
export interface BenchEditLine {
  device: string;
  alias: string;
  line: string;
  old: string;
  new: string;
}

/**
 * The exact edit of a bench file's text (hardware/bench/<name>.bench.yaml, §2.3, read as benchFileLines
 * does) that applies `moves`: each DUT line's `channel` and `fixture_gpio` values replaced in place, the
 * rest of the line (its alignment, its comment) kept. A move whose line the text does not have with the
 * channel and fixture_gpio bench_get reported (the file changed since the hub loaded it) is `unmatched`.
 */
export function benchEdit(text: string, moves: readonly WiringMove[]): { lines: BenchEditLine[]; unmatched: WiringMove[] } {
  const rows = text.split('\n');
  const index = new Map<string, number>();
  let inDuts = false;
  let device: string | null = null;
  rows.forEach((row, k) => {
    if (/^duts:\s*(#.*)?$/.test(row)) {
      inDuts = true;
      return;
    }
    if (/^\S/.test(row)) {
      inDuts = false;
      device = null;
    }
    if (!inDuts) {
      return;
    }
    const d = /^ {2}([0-9a-fA-F]{12}):\s*(#.*)?$/.exec(row);
    if (d) {
      device = d[1].toLowerCase();
      return;
    }
    const l = device ? /^ {6}([A-Za-z_][\w-]*):\s*\{/.exec(row) : null;
    if (l) {
      index.set(`${device}/${l[1]}`, k);
    }
  });
  const lines: BenchEditLine[] = [];
  const unmatched: WiringMove[] = [];
  for (const m of moves) {
    const k = index.get(`${m.device.toLowerCase()}/${m.line}`);
    const old = k === undefined ? undefined : rows[k];
    const ch = new RegExp(`(\\bchannel:\\s*)${m.from.channel}\\b`);
    const gpio = new RegExp(`(\\bfixture_gpio:\\s*)${m.from.fixture_gpio}\\b`);
    if (old === undefined || !ch.test(old) || !gpio.test(old)) {
      unmatched.push(m);
      continue;
    }
    lines.push({ device: m.device, alias: m.alias, line: m.line, old, new: old.replace(ch, `$1${m.to.channel}`).replace(gpio, `$1${m.to.fixture_gpio}`) });
  }
  return { lines, unmatched };
}

/**
 * The bench-file edit as people read it, diff-style: per DUT its key line as context, then `-` each line as
 * it reads and `+` as it would read (the lines exact, indentation included).
 */
export function benchEditText(file: string, edit: { lines: readonly BenchEditLine[]; unmatched: readonly WiringMove[] }): string {
  const out = [`to match the wiring found, edit ${file} (- as it reads, + as it would read):`];
  let last = '';
  for (const l of edit.lines) {
    if (l.device !== last) {
      out.push(`   ${l.device}:   # ${l.alias}`);
      last = l.device;
    }
    out.push(`-${l.old}`, `+${l.new}`);
  }
  for (const m of edit.unmatched) {
    out.push(`  ${m.device} (${m.alias}) ${m.line}: channel ${m.from.channel} -> ${m.to.channel}, fixture_gpio ${m.from.fixture_gpio} -> ${m.to.fixture_gpio} (the file's line does not read as bench_get reports it)`);
  }
  return out.join('\n');
}

// ---- the hub: presses, events, bindings ----

/** The fixture's press as input_simulate {layer: gpio} reports it (D8). */
export interface GpioPress {
  ok: boolean;
  /** The per-device status (ok, busy, ...), or `refused` when the hub refused the op. */
  status: string;
  code?: string;
  error?: string;
  /** The cursor taken before the press, and its seq. */
  cursor: string;
  seq: number;
  channel?: string;
  press?: { t_fix_us?: number; t_hub_us?: number; segments_us?: number[]; total_us?: number };
  /** status `interrupted`: a hub release cut the gesture short (D8), `after_us` from its first press edge. */
  interrupted?: { reason: string; after_us: number };
}

/** Refusals that end a run: the hub cannot press at all (no fixture module, a line not wired, bad args). */
const FATAL_GPIO = new Set(['NOT_FOUND', 'INVALID_ARGS', 'HUB_UNREACHABLE', 'POLICY_DENIED', 'INTERNAL', 'HUB_VERSION_MISMATCH']);

/**
 * One gesture by the fixture: input_simulate {selector, instance, gesture, layer: gpio}. It returns after the
 * gesture (a press: after its press edge). DEVICE_BUSY, LOCKED, DEVICE_OFFLINE and TIMEOUT come back as a
 * refused press for the verdict; anything that means the hub cannot press throws HubError.
 */
export async function gpio(hub: Hub, alias: string, gesture: string, o: { instance?: string; timeout_s?: number; signal?: AbortSignal } = {}): Promise<GpioPress> {
  const r = await hub.call<Row>('input_simulate', { selector: alias, instance: o.instance ?? 'boot', gesture, layer: 'gpio', timeout_s: o.timeout_s ?? 5 }, undefined, o.signal);
  if (!r.ok) {
    if (FATAL_GPIO.has(r.error?.code ?? 'INTERNAL')) {
      throw new HubError('input_simulate', r);
    }
    return { ok: false, status: 'refused', code: r.error?.code, error: `${r.error?.code} ${r.error?.message}`, cursor: r.cursor, seq: seqOf(r.cursor) };
  }
  const row = (Array.isArray(r.data?.results) ? r.data.results[0] : r.data) ?? {};
  const status = String(row.status ?? 'ok');
  const press = (row.press ?? r.data?.press) as GpioPress['press'] | undefined;
  const cut = (row.interrupted ?? r.data?.interrupted) as { reason?: unknown; after_us?: unknown } | undefined;
  return {
    ok: status === 'ok',
    status,
    ...(row.error ? { error: String(row.error) } : {}),
    ...(status === 'interrupted' && cut ? { interrupted: { reason: String(cut.reason ?? 'release'), after_us: Number(cut.after_us ?? 0) } } : {}),
    cursor: r.cursor,
    seq: seqOf(r.cursor),
    ...((row.channel ?? r.data?.channel) ? { channel: String(row.channel ?? r.data?.channel) } : {}),
    ...(press ? { press } : {}),
  };
}

/** Every event of `types` (and `selector`) after `since`, oldest first, paged (at most 50 pages of 1000). */
export async function readEvents(hub: Hub, input: { since: string; types: string; selector?: string }, signal?: AbortSignal): Promise<HubEvent[]> {
  const out: HubEvent[] = [];
  let since = input.since;
  for (let page = 0; page < 50; page++) {
    const r = await hub.ok<{ events: HubEvent[]; next_cursor: string; truncated: boolean }>('events_read', { ...input, since, max_events: 1000 }, undefined, signal);
    out.push(...r.events);
    if (!r.truncated || !r.events.length) {
      break;
    }
    since = r.next_cursor;
  }
  return out;
}

/** The hil readings of one bench line among a DUT's events. */
export function onLine(events: readonly HubEvent[], line: string, types: readonly string[] = ['hil.edge', 'hil.frame']): HubEvent[] {
  return events.filter((e) => types.includes(e.type) && f(e).line === line);
}

/** A binding row as binding_list shows it. */
export interface BindingRow {
  slot: number;
  from: string;
  to: string;
  args: unknown;
}

type Bench = { hub: Hub; log(message: string): void; measure(name: string, value: unknown): void };

/**
 * Parks a DUT's bindings triggered by `<alias>.<input>.*` (they fire on every press; the T-LAT pattern, c6
 * D25/D38): each is added to `parked` once it is gone, so a failure half-way restores exactly what was
 * removed. A binding_clear that failed on the way back may have cleared the row: binding_list says.
 */
export async function parkBindings(b: Bench, alias: string, input: string, parked: BindingRow[], signal?: AbortSignal): Promise<void> {
  const listed = await b.hub.ok<{ bindings: BindingRow[] }>('binding_list', { selector: alias }, undefined, signal);
  const prefix = `${alias}.${input}.`.toLowerCase();
  for (const row of listed.bindings.filter((x) => x.from.toLowerCase().startsWith(prefix))) {
    try {
      await b.hub.ok('binding_clear', { device: alias, slot: row.slot });
    } catch (e) {
      const now = await b.hub.ok<{ bindings: BindingRow[] }>('binding_list', { selector: alias }).catch(() => null);
      if (now && !now.bindings.some((x) => x.slot === row.slot && x.from === row.from && x.to === row.to)) {
        parked.push(row);
      }
      throw e;
    }
    parked.push(row);
    b.log(`removed ${alias} binding slot ${row.slot} (${row.from} -> ${row.to}) for the run`);
  }
}

/**
 * Puts parked bindings back in slot order, trying every one (no signal: it runs after a cancel); each
 * failure is logged with its `fr bind` and kept as `bindings_not_restored.<alias>`. The failures.
 */
export async function restoreBindings(b: Bench, alias: string, parked: readonly BindingRow[]): Promise<string[]> {
  const failed: string[] = [];
  for (const row of parked) {
    const args = row.args === null || row.args === undefined ? {} : { args: typeof row.args === 'object' && !Array.isArray(row.args) ? row.args : JSON.stringify(row.args) };
    const r = await b.hub.call('binding_set', { from: row.from, to: row.to, ...args }, 10_000);
    if (r.ok) {
      b.log(`restored ${alias} binding ${row.from} -> ${row.to}`);
      continue;
    }
    const text = args.args === undefined ? '' : ` '${typeof args.args === 'string' ? args.args : JSON.stringify(args.args)}'`;
    failed.push(`${row.from} -> ${row.to}: ${r.error?.code} ${r.error?.message}`);
    b.log(`could not restore ${alias} binding ${row.from} -> ${row.to} (${r.error?.code}); restore it by hand: fr bind ${row.from} ${row.to}${text}`);
  }
  if (failed.length) {
    b.measure(`bindings_not_restored.${alias}`, failed);
  }
  return failed;
}
