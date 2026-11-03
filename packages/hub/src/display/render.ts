// display_render's parts (design m2-c5-display D6, D10): a profile's panel as the checkout's generator resolves it, the script
// checked as the device path checks commands, and the desktop renderer (stream L: tools/display, built by
// `node tools/display-build.mjs` into build/host-display/fr_display_render), built when missing or stale.
//
// The renderer's command line (L's contract): fr_display_render --width W --height H --format rgb565|mono1
// --rotation 0..3 --ui 0|1 --script <file.jsonl> --out <file.png> [--round 1]; width and height after rotation (the panel's
// traits, as the generated kPanels table has them); it prints one JSON line {crc, width, height, format, bytes,
// png, events}.

import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { DISPLAY_FORMATS, type DisplayFormat, FrError, RENDER_COMMANDS, type RenderCommand, RENDERER_BIN, RENDERER_BUILD, RENDERER_SOURCES } from '@fractonica/protocol';

import { genFirmwareFromSource } from '../build.ts';
import { encodeArgs } from '../router/ops.ts';
import { checkArgsSize } from './layout.ts';

/**
 * The renderer binary, its build script and what it is built from (D6), relative to the hub's checkout: one list with
 * `fr display window` (@fractonica/protocol). A file newer than the binary makes it stale; the build itself is
 * incremental, so a change elsewhere in fr_core costs a quick rebuild.
 */
export { RENDERER_BIN, RENDERER_BUILD, RENDERER_SOURCES };
/** Directories a source scan skips (build output, fetched components). */
const SKIP_DIRS = new Set(['build', 'node_modules', 'managed_components', '.git']);
/** The most lines a script may have. */
export const SCRIPT_MAX_LINES = 1000;

/** A profile's fr.display instance as its renderer draws for it (the manifest's traits and config). */
export interface Panel {
  profile: string;
  name: string;
  port: number;
  /** Pixels after rotation. */
  width: number;
  height: number;
  format: DisplayFormat;
  /** Quarter turns, 0..3. */
  rotation: number;
  ui: boolean;
  touch: boolean;
  /** Trait round (design scale-round-c1 D5): the renderer greys the corners the glass does not show. */
  round: boolean;
}

/** What the panel needs of a manifest instance (codegen's ManifestCap). */
interface ManifestCapView {
  name: string;
  port: number;
  cap: string;
  config: Record<string, unknown>;
  traits: Record<string, unknown>;
}

/** Per checkout and profile: the manifest's instances, and the inputs' newest time they were generated from. */
const manifests = new Map<string, { stamp: number; board: string; caps: ManifestCapView[] }>();

/** The newest time of what a profile's manifest is generated from (its profile and lock, board, drivers, schema). */
function manifestStamp(sourceDir: string, profile: string, board: string | null): number {
  const inputs = [`firmware/profiles/${profile}.profile.yaml`, `firmware/profiles/${profile}.slots.lock`, 'hardware/drivers', 'schema', ...(board ? [`hardware/boards/${board}.board.yaml`] : [])];
  return Math.max(...inputs.map((p) => newestMtime(join(sourceDir, p))));
}

/**
 * A profile's capability instances as `fr build` resolves them: `fr gen firmware` run from the checkout itself
 * (build.ts genFirmwareFromSource; the hub loads no generator of its own, design c2 §7) into a temporary out dir,
 * its manifest kept until the profile, its board, a driver or the schema changes.
 */
async function manifestCaps(sourceDir: string, profile: string): Promise<ManifestCapView[]> {
  const key = `${sourceDir}\0${profile}`;
  const cached = manifests.get(key);
  if (cached && manifestStamp(sourceDir, profile, cached.board) <= cached.stamp) {
    return cached.caps;
  }
  const stamp = manifestStamp(sourceDir, profile, null);
  const out = mkdtempSync(join(tmpdir(), 'fr-display-gen-'));
  try {
    const gen = await genFirmwareFromSource(sourceDir, profile, out);
    const manifest = gen.manifest as unknown as { board: string; caps?: ManifestCapView[] };
    const caps = Array.isArray(manifest.caps) ? manifest.caps : [];
    manifests.set(key, { stamp: Math.max(stamp, manifestStamp(sourceDir, profile, manifest.board)), board: manifest.board, caps });
    return caps;
  } catch (e) {
    if (e instanceof FrError && e.code === 'NOT_FOUND') {
      throw new FrError('NOT_FOUND', e.message, { remediation: [{ tool: 'profile_list' }], details: e.details });
    }
    throw e;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/**
 * The panel `instance` of `profile` (its only fr.display instance when omitted), resolved by the checkout's own
 * generator exactly as `fr build` would (board entry, driver traits, the profile's rotation).
 */
export async function resolvePanel(sourceDir: string, profile: string, instance?: string): Promise<Panel> {
  const caps = await manifestCaps(sourceDir, profile);
  const panels = caps.filter((c) => c.cap === 'fr.display');
  const names = panels.map((p) => p.name).join(', ') || 'none';
  const p = instance === undefined ? (panels.length === 1 ? panels[0] : undefined) : panels.find((c) => c.name === instance);
  if (!p) {
    const why = instance === undefined ? (panels.length ? `has several fr.display instances (${names}): name one` : 'has no fr.display instance') : `has no fr.display instance ${instance} (${names})`;
    throw new FrError(panels.length ? 'INVALID_ARGS' : 'NOT_FOUND', `profile ${profile} ${why}`, { remediation: [{ tool: 'profile_list' }] });
  }
  const format = String(p.traits.color);
  if (!(DISPLAY_FORMATS as readonly string[]).includes(format)) {
    throw new FrError('INVALID_ARGS', `${profile} ${p.name}: trait color ${format} is not one of ${DISPLAY_FORMATS.join(', ')}`);
  }
  const rotation = ['r0', 'r90', 'r180', 'r270'].indexOf(String(p.config.rotation ?? 'r0'));
  return {
    profile,
    name: p.name,
    port: p.port,
    width: Number(p.traits.width),
    height: Number(p.traits.height),
    format: format as DisplayFormat,
    rotation: Math.max(0, rotation),
    ui: p.traits.ui === true,
    touch: p.traits.touch === true,
    round: p.traits.round === true,
  };
}

export interface ScriptLine {
  cmd: RenderCommand;
  args: Record<string, unknown>;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The items of `commands` ([{cmd, args}] or its JSON text) or the lines of `script` (JSON lines, or a .jsonl path). */
function rawLines(input: { commands?: unknown; script?: string }): { items: unknown[]; where: (i: number) => string } {
  if ((input.commands === undefined) === (input.script === undefined)) {
    throw new FrError('INVALID_ARGS', 'give exactly one of commands ([{cmd, args}]) or script (JSON lines, or a .jsonl path)', {
      remediation: [{ tool: 'display_render', args: { profile: 's3t-pad', commands: [{ cmd: 'clear', args: { color: 0 } }, { cmd: 'text', args: { x: 10, y: 10, text: 'hi', size: 2 } }] } }],
    });
  }
  if (input.commands !== undefined) {
    let items = input.commands;
    if (typeof items === 'string') {
      try {
        items = JSON.parse(items);
      } catch (e) {
        throw new FrError('INVALID_ARGS', `commands is not valid JSON: ${(e as Error).message}`);
      }
    }
    if (!Array.isArray(items)) {
      throw new FrError('INVALID_ARGS', 'commands must be a JSON array of {cmd, args}');
    }
    return { items, where: (i) => `commands[${i}]` };
  }
  let text = input.script!;
  const one = text.trim();
  if (!one.includes('\n') && /\.jsonl$/i.test(one) && !isAbsolute(one)) {
    throw new FrError('INVALID_ARGS', `script ${one}: give a script file as an absolute path (the hub reads it, and its working directory is not yours)`);
  }
  if (!one.includes('\n') && isAbsolute(one)) {
    const file = one;
    if (!existsSync(file)) {
      throw new FrError('NOT_FOUND', `script file ${file} does not exist`);
    }
    text = readFileSync(file, 'utf8');
  }
  const items: unknown[] = [];
  const lineNo: number[] = [];
  text.split(/\r?\n/).forEach((l, i) => {
    if (!l.trim()) {
      return;
    }
    try {
      items.push(JSON.parse(l));
    } catch (e) {
      throw new FrError('INVALID_ARGS', `script line ${i + 1} is not JSON: ${(e as Error).message}`);
    }
    lineNo.push(i + 1);
  });
  return { items, where: (i) => `script line ${lineNo[i]}` };
}

/**
 * The script checked for `panel` (D10): each line a known command whose args encode as they would for the board
 * (the generated schema and codec; a layout no BULK frame carries is refused as command_send refuses it), ui_load
 * and ui_set only on a ui panel, touch only on a panel with a bound touch. Throws INVALID_ARGS naming the line.
 */
export function checkScript(input: { commands?: unknown; script?: string }, panel: Panel): ScriptLine[] {
  const { items, where } = rawLines(input);
  if (!items.length) {
    throw new FrError('INVALID_ARGS', 'the script has no command');
  }
  if (items.length > SCRIPT_MAX_LINES) {
    throw new FrError('INVALID_ARGS', `the script has ${items.length} commands; at most ${SCRIPT_MAX_LINES}`);
  }
  return items.map((item, i) => {
    const at = where(i);
    if (!isObject(item) || typeof item.cmd !== 'string') {
      throw new FrError('INVALID_ARGS', `${at}: expected {"cmd": <command>, "args": {...}}`);
    }
    const cmd = item.cmd as RenderCommand;
    if (!RENDER_COMMANDS.includes(cmd)) {
      throw new FrError('INVALID_ARGS', `${at}: unknown cmd ${item.cmd} (${RENDER_COMMANDS.join(', ')})`);
    }
    const args = item.args === undefined ? {} : item.args;
    if (!isObject(args)) {
      throw new FrError('INVALID_ARGS', `${at}: args must be a JSON object`);
    }
    if ((cmd === 'ui_load' || cmd === 'ui_set') && !panel.ui) {
      throw new FrError('INVALID_ARGS', `${at}: ${panel.profile} ${panel.name} draws no layouts (trait ui false: the board answers ${cmd} UNSUPPORTED); use clear, text, fill_rect`);
    }
    if (cmd === 'touch' && !panel.touch) {
      throw new FrError('INVALID_ARGS', `${at}: ${panel.profile} ${panel.name} has no touch instance bound to it`);
    }
    try {
      const [cap, command] = cmd === 'touch' ? ['fr.touch', 'inject'] : ['fr.display', cmd];
      checkArgsSize(cap, command, args, encodeArgs(cap, command, args));
    } catch (e) {
      if (e instanceof FrError) {
        throw new FrError(e.code, `${at}: ${e.message}`, { hint: e.hint, details: e.details });
      }
      throw e;
    }
    return { cmd, args };
  });
}

/** The newest modification time under `path` (a file or a directory, recursively), 0 when it does not exist. */
export function newestMtime(path: string): number {
  let st;
  try {
    st = statSync(path);
  } catch {
    return 0;
  }
  if (!st.isDirectory()) {
    return st.mtimeMs;
  }
  let newest = st.mtimeMs;
  for (const d of readdirSync(path, { withFileTypes: true })) {
    if (d.isDirectory() && SKIP_DIRS.has(d.name)) {
      continue;
    }
    newest = Math.max(newest, newestMtime(join(path, d.name)));
  }
  return newest;
}

/** Per checkout: the sources' newest time the last good build saw (a no-op incremental build leaves the binary's time). */
const builtAt = new Map<string, number>();
/** Per checkout: the build in flight, which concurrent renders share. */
const building = new Map<string, Promise<void>>();

function run(file: string, args: string[], opts: { cwd: string; timeoutMs: number }): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    execFile(file, args, { cwd: opts.cwd, timeout: Math.round(opts.timeoutMs), maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string }) | null;
      resolve({ code: e ? (typeof e.code === 'number' ? e.code : -1) : 0, stdout, stderr: stderr || (e && typeof e.code === 'string' ? e.message : ''), timedOut: Boolean(e?.killed && e.signal === 'SIGTERM') });
    });
  });
}

const tail = (s: string, n = 20) => s.trimEnd().split('\n').slice(-n).join('\n');

/** How long a timed-out build's process group has after SIGTERM before SIGKILL. */
export const BUILD_KILL_GRACE_MS = 3000;
/** The most output of a build kept (its tail is what a refusal shows). */
const BUILD_OUTPUT_MAX = 1024 * 1024;

/**
 * Runs a build in its own process group (detached): on timeout the whole group gets SIGTERM, then SIGKILL after
 * BUILD_KILL_GRACE_MS, so cmake, ninja and the compilers it started stop with it (execFile's timeout kills only
 * the direct child). Resolves once the child has exited (and, after a timeout, once the group is signalled).
 */
export function runBuild(file: string, args: string[], opts: { cwd: string; timeoutMs: number }): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const keep = (buf: string, chunk: string) => {
      const next = buf + chunk;
      return next.length > BUILD_OUTPUT_MAX ? next.slice(-BUILD_OUTPUT_MAX) : next;
    };
    const child = spawn(file, args, { cwd: opts.cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const group = (sig: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, sig);
      } catch {
        // the group is gone already
      }
    };
    child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout = keep(stdout, c)));
    child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr = keep(stderr, c)));
    const timer = setTimeout(() => {
      timedOut = true;
      group('SIGTERM');
      killTimer = setTimeout(() => group('SIGKILL'), BUILD_KILL_GRACE_MS);
      killTimer.unref();
    }, Math.max(1, Math.round(opts.timeoutMs)));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr || e.message, timedOut: false });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        // The child is gone; whatever of its group outlived it gets SIGKILL now rather than later.
        clearTimeout(killTimer);
        group('SIGKILL');
      }
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/**
 * The renderer binary of `sourceDir`, built first (`node tools/display-build.mjs`) when it is missing or older than
 * its sources. Refuses with NOT_FOUND when there is neither a binary nor a build script, BUILD_FAILED when the
 * build fails or leaves no binary, TIMEOUT when it outlasts `timeoutMs`.
 */
export async function ensureRenderer(sourceDir: string, timeoutMs: number): Promise<{ bin: string; built: boolean }> {
  const bin = join(sourceDir, RENDERER_BIN);
  const script = join(sourceDir, RENDERER_BUILD);
  const sources = Math.max(...RENDERER_SOURCES.map((p) => newestMtime(join(sourceDir, p))));
  const binAt = existsSync(bin) ? statSync(bin).mtimeMs : 0;
  if (binAt && (binAt >= sources || (builtAt.get(sourceDir) ?? 0) >= sources)) {
    return { bin, built: false };
  }
  if (!existsSync(script)) {
    throw new FrError('NOT_FOUND', `the desktop renderer is not built (${RENDERER_BIN}) and this checkout has no ${RENDERER_BUILD} to build it`, {
      hint: 'the desktop renderer (design m2-c5-display D6) is not in this checkout yet',
    });
  }
  let pending = building.get(sourceDir);
  if (!pending) {
    pending = (async () => {
      const r = await runBuild(process.execPath, [script], { cwd: sourceDir, timeoutMs });
      if (r.timedOut) {
        throw new FrError('TIMEOUT', `the desktop renderer build (node ${RENDERER_BUILD}) took over ${Math.round(timeoutMs / 1000)} s`, {
          remediation: [{ human: `run \`node ${RENDERER_BUILD}\` in ${sourceDir} once (the first build fetches and compiles LVGL), then retry` }],
        });
      }
      if (r.code !== 0) {
        throw new FrError('BUILD_FAILED', `the desktop renderer build (node ${RENDERER_BUILD}) failed (exit ${r.code})`, {
          remediation: [{ human: `run \`node ${RENDERER_BUILD}\` in ${sourceDir} and fix what it reports` }],
          details: { output: tail(`${r.stdout}\n${r.stderr}`, 40) },
        });
      }
      if (!existsSync(bin)) {
        throw new FrError('BUILD_FAILED', `node ${RENDERER_BUILD} succeeded but left no ${RENDERER_BIN}`, { details: { output: tail(r.stdout) } });
      }
      builtAt.set(sourceDir, sources);
    })().finally(() => building.delete(sourceDir));
    building.set(sourceDir, pending);
  }
  await pending;
  return { bin, built: true };
}

/** What the renderer prints: its one JSON line. */
export interface RenderOutput {
  crc: number;
  width: number;
  height: number;
  format: DisplayFormat;
  bytes: number;
  png?: string;
  events: unknown[];
  [k: string]: unknown;
}

/** Runs the renderer on a script file for `panel`, writing `out`; throws INTERNAL with its output when it fails. */
export async function runRenderer(bin: string, panel: Panel, scriptFile: string, out: string, opts: { cwd: string; timeoutMs: number }): Promise<RenderOutput> {
  const args = [
    '--width',
    String(panel.width),
    '--height',
    String(panel.height),
    '--format',
    panel.format,
    '--rotation',
    String(panel.rotation),
    '--ui',
    panel.ui ? '1' : '0',
    '--script',
    scriptFile,
    '--out',
    out,
    // A round panel's PNG greys the corners its glass does not show; the crc stays the whole frame's.
    ...(panel.round ? ['--round', '1'] : []),
  ];
  const r = await run(bin, args, opts);
  if (r.timedOut) {
    throw new FrError('TIMEOUT', `the desktop renderer took over ${Math.round(opts.timeoutMs / 1000)} s`, { details: { stderr: tail(r.stderr) } });
  }
  const line = r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'))
    .at(-1);
  let parsed: unknown;
  try {
    parsed = line ? JSON.parse(line) : undefined;
  } catch {
    parsed = undefined;
  }
  if (r.code !== 0 || !isObject(parsed) || typeof parsed.crc !== 'number') {
    throw new FrError('INTERNAL', `the desktop renderer failed (exit ${r.code})${r.stderr.trim() ? `: ${tail(r.stderr, 1)}` : ''}`, {
      details: { stdout: tail(r.stdout), stderr: tail(r.stderr), args },
    });
  }
  if (!existsSync(out)) {
    throw new FrError('INTERNAL', `the desktop renderer wrote no PNG at ${out}`, { details: { stdout: tail(r.stdout) } });
  }
  return { ...parsed, events: Array.isArray(parsed.events) ? parsed.events : [] } as RenderOutput;
}
