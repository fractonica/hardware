// `fr display window` (design m2-c5-display D6): a profile's panel in a window on this Mac, the mouse as the finger,
// with no hub and no board. `fr display render` (the hub op display_render, packages/hub/src/display/render.ts) is
// the agents' path to a PNG; a hub daemon opens no windows, so the window is this local command. The panel (size
// after rotation, format, rotation, LVGL or not, a bound touch) comes from codegen's resolution of the profile, as
// `fr build` would make it; the drawing is the desktop renderer (tools/display, build/host-display/fr_display_render;
// its contract is in tools/display/README.md), built first with `node tools/display-build.mjs` when it is missing or
// older than its sources (the sim runner's rule for fr_fleet). An optional script is drawn first; ui events print as
// they happen; closing the window writes the last frame's PNG and prints the result.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

import type { Command } from 'commander';

import { findSourceDir } from '@fractonica/host';
import { RENDERER_BIN, RENDERER_BUILD, RENDERER_SOURCES, type Result } from '@fractonica/protocol';

import type { CliKit } from './kit.ts';

/** The op whose result shape this command answers with (display_render's, plus `errors`). */
const OP = 'display_render';

/** The renderer, its build script and its sources (one list with the hub's display_render: @fractonica/protocol). */
export { RENDERER_BIN, RENDERER_BUILD, RENDERER_SOURCES };

/** A profile's fr.display instance as the renderer draws it. */
export interface RenderPanel {
  profile: string;
  instance: string;
  /** Pixels after rotation. */
  width: number;
  height: number;
  format: 'rgb565' | 'mono1';
  /** Quarter turns, 0..3. */
  rotation: number;
  ui: boolean;
  touch: boolean;
}

/** The panel `instance` of `profile` (its only fr.display instance when omitted); a string says why there is none. */
export async function resolveRenderPanel(sourceDir: string, profile: string, instance?: string): Promise<RenderPanel | string> {
  const codegen = await import('@fractonica/codegen');
  if (!existsSync(join(sourceDir, 'firmware', 'profiles', `${profile}.profile.yaml`))) {
    return `no profile ${profile} in ${join(sourceDir, 'firmware', 'profiles')}`;
  }
  let caps;
  try {
    caps = codegen.generateFirmware({ sourceDir, profile, outDir: join(tmpdir(), 'fr-display-render-gen'), write: false }).manifest.caps;
  } catch (e) {
    if (e instanceof codegen.SchemaError) {
      return `profile ${profile} does not resolve: ${e.issues.slice(0, 3).map(codegen.formatIssue).join('; ')}`;
    }
    throw e;
  }
  const panels = caps.filter((c) => c.cap === 'fr.display');
  const names = panels.map((p) => p.name).join(', ') || 'none';
  const p = instance === undefined ? (panels.length === 1 ? panels[0] : undefined) : panels.find((c) => c.name === instance);
  if (!p) {
    if (instance === undefined) {
      return panels.length ? `profile ${profile} has several fr.display instances (${names}): give --instance` : `profile ${profile} has no fr.display instance`;
    }
    return `profile ${profile} has no fr.display instance ${instance} (${names})`;
  }
  const format = String(p.traits.color);
  if (format !== 'rgb565' && format !== 'mono1') {
    return `${profile} ${p.name}: trait color ${format} is neither rgb565 nor mono1`;
  }
  return {
    profile,
    instance: p.name,
    width: Number(p.traits.width),
    height: Number(p.traits.height),
    format,
    rotation: Math.max(0, ['r0', 'r90', 'r180', 'r270'].indexOf(String(p.config.rotation ?? 'r0'))),
    ui: p.traits.ui === true,
    touch: p.traits.touch === true,
  };
}

/** The newest source file under `paths` (C/C++ sources and headers, CMakeLists.txt, .mjs), skipping build output. */
function newestSource(sourceDir: string): { path: string; ms: number } {
  let newest = { path: '', ms: 0 };
  const visit = (p: string): void => {
    let st;
    try {
      st = statSync(p);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      for (const n of readdirSync(p)) {
        if (n !== 'build' && n !== 'managed_components' && n !== 'node_modules' && !n.startsWith('.')) {
          visit(join(p, n));
        }
      }
    } else if (/\.(c|cc|cpp|h|hpp|inc|mjs)$|(^|\/)CMakeLists\.txt$/.test(p) && st.mtimeMs > newest.ms) {
      newest = { path: p, ms: st.mtimeMs };
    }
  };
  for (const p of RENDERER_SOURCES) {
    visit(join(sourceDir, p));
  }
  return newest;
}

/** Why the checkout's renderer must be (re)built, else null: missing, or older than a source file. */
export function rendererStaleness(sourceDir: string): string | null {
  const bin = join(sourceDir, RENDERER_BIN);
  if (!existsSync(bin)) {
    return `${RENDERER_BIN} is not built`;
  }
  const newest = newestSource(sourceDir);
  return newest.ms > statSync(bin).mtimeMs ? `${relative(sourceDir, newest.path)} is newer than ${RENDERER_BIN}` : null;
}

/** Builds the renderer when stale; its output goes to stderr (stdout is the command's). A string says why it failed. */
export function ensureRenderer(sourceDir: string): string | null {
  if (rendererStaleness(sourceDir) === null) {
    return null;
  }
  const r = spawnSync(process.execPath, [join(sourceDir, RENDERER_BUILD)], { cwd: sourceDir, stdio: ['ignore', 2, 2] });
  if (r.error || r.status !== 0) {
    return `node ${RENDERER_BUILD} failed (${r.error ? r.error.message : `exit ${r.status}`})`;
  }
  return existsSync(join(sourceDir, RENDERER_BIN)) ? null : `node ${RENDERER_BUILD} left no ${RENDERER_BIN}`;
}

/** What the renderer printed last: its result line, or its error line. */
interface RendererLine {
  crc?: number;
  width?: number;
  height?: number;
  format?: string;
  bytes?: number;
  png?: string;
  events?: unknown[];
  errors?: unknown[];
  lvgl_heap?: unknown;
  error?: { code: string; message: string };
  event?: { id: string; kind: string; value: number };
}

/**
 * Runs the renderer for `panel`; with `live`, each {"event": ...} line it prints (the window's ui events) is handed
 * over as it comes. Resolves with its exit status and its last JSON line.
 */
export function runRenderer(
  bin: string,
  panel: RenderPanel,
  script: string,
  out: string,
  opts: { window: boolean; live?: (e: NonNullable<RendererLine['event']>) => void },
): Promise<{ status: number; line: RendererLine | null; stderr: string }> {
  const args = ['--width', String(panel.width), '--height', String(panel.height), '--format', panel.format, '--rotation', String(panel.rotation)];
  args.push('--ui', panel.ui ? '1' : '0', '--script', script, '--out', out, ...(opts.window ? ['--window'] : []));
  return new Promise((done) => {
    const child = spawn(bin, args, { stdio: [script === '-' ? 'inherit' : 'ignore', 'pipe', 'pipe'] });
    let buf = '';
    let stderr = '';
    let last: RendererLine | null = null;
    const take = (l: string) => {
      if (!l.startsWith('{')) {
        return;
      }
      try {
        const j = JSON.parse(l) as RendererLine;
        if (j.event) {
          opts.live?.(j.event);
        } else {
          last = j;
        }
      } catch {
        // not one of its lines
      }
    };
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        take(buf.slice(0, nl).trim());
        buf = buf.slice(nl + 1);
      }
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', (e) => done({ status: 127, line: null, stderr: e.message }));
    child.on('close', (code) => {
      take(buf.trim());
      done({ status: code ?? 1, line: last, stderr });
    });
  });
}

export function addDisplayWindowCommand(display: Command, kit: CliKit): void {
  display
    .command('window')
    .description("Show a profile's panel in a window on this Mac (no hub, no board): the mouse is the finger, ui events print as they happen")
    .requiredOption('--profile <name>', 'profile, e.g. s3t-pad')
    .option('--instance <name>', "the profile's fr.display instance (default: its only one)")
    .option('--script <file>', 'JSON lines {"cmd": .., "args": {..}} drawn first (tools/display/README.md)')
    .option('--out <png>', 'the PNG of the last frame, written when the window closes (default: a temp file)')
    .action(async (opts: { profile: string; instance?: string; script?: string; out?: string }) => {
      const src = findSourceDir(process.cwd());
      if (!src) {
        return kit.fail('INVALID_SOURCE', `${process.cwd()} is not inside a Fractonica checkout`, OP, [{ human: 'cd into the repo' }]);
      }
      const tmp = opts.script === undefined || opts.out === undefined ? mkdtempSync(join(tmpdir(), 'fr-display-window-')) : '';
      const script = opts.script === undefined ? join(tmp, 'empty.jsonl') : resolve(opts.script);
      if (opts.script === undefined) {
        writeFileSync(script, '');
      } else if (!existsSync(script)) {
        return kit.fail('NOT_FOUND', `no script file ${script}`, OP);
      }
      const panel = await resolveRenderPanel(src, opts.profile, opts.instance);
      if (typeof panel === 'string') {
        return kit.fail(panel.startsWith('no profile') ? 'NOT_FOUND' : 'INVALID_ARGS', panel, OP);
      }
      const built = ensureRenderer(src);
      if (built !== null) {
        return kit.fail('BUILD_FAILED', `the desktop renderer: ${built}`, OP, [{ cli: `node ${RENDERER_BUILD}` }]);
      }
      const t0 = Date.now();
      const live = (e: { id: string; kind: string; value: number }) =>
        process.stdout.write(kit.json() ? JSON.stringify({ event: e }) + '\n' : `ui ${e.id} ${e.kind} ${e.value}\n`);
      const out = opts.out === undefined ? join(tmp, `${panel.profile}-${panel.instance}.png`) : resolve(opts.out);
      const r = await runRenderer(join(src, RENDERER_BIN), panel, script, out, { window: true, live });
      const line = r.line;
      if (r.status !== 0 || !line || typeof line.crc !== 'number') {
        const why = line?.error?.message ?? (r.stderr.trim().split('\n').at(-1) || `exit ${r.status}`);
        const code = line?.error?.code === 'SCRIPT' || r.status === 65 ? 'INVALID_ARGS' : r.status === 69 ? 'ENV_MISSING' : 'INTERNAL';
        return kit.fail(code, `fr_display_render: ${why}`, OP, r.status === 69 ? [{ human: 'brew install sdl2, then node tools/display-build.mjs' }] : undefined);
      }
      const result: Result = {
        ok: true,
        cursor: '',
        data: {
          path: line.png,
          crc: line.crc,
          width: line.width,
          height: line.height,
          format: line.format,
          bytes: line.bytes,
          events: line.events ?? [],
          errors: line.errors ?? [],
          profile: panel.profile,
          instance: panel.instance,
          rotation: panel.rotation,
          ui: panel.ui,
          touch: panel.touch,
          ms: Date.now() - t0,
          ...(line.lvgl_heap ? { lvgl_heap: line.lvgl_heap } : {}),
        },
      };
      return kit.emit(result, OP);
    });
}
