// Display op handlers (packages/protocol/src/ops/display.ts; design m2-c5-display D10, stream H), spread into
// HANDLERS (packages/hub/src/ops.ts):
// - display_snapshot: per device, fr.display's snapshot (CRC-32, size, format), then snapshot_read in 1,024 B
//   chunks (both BULK: TCP or serial, never a gateway, so a gateway-only device is refused before a frame is
//   frozen; a chunk is retried once), the bytes checked against the snapshot's size and CRC-32/ISO-HDLC, written
//   as a PNG (png.ts) under FR_HOME/snapshots or `out`. One snapshot per device at a time (the device keeps one
//   frozen frame: a second snapshot would replace it under the first one's reads), within total_timeout_s.
// - display_render: the desktop renderer (render.ts) on a checked script, for a profile's panel; no board needed.
//   Its PNG is decoded and written again by png.ts, so a render and a snapshot of the same framebuffer are the
//   same bytes (the renderer deflates with the macOS SDK's zlib, the hub with Node's).
// Both are tier read yet write files: `out` must lie under FR_HOME (as the defaults do).

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { crc32 } from 'node:zlib';

import { paths } from '@fractonica/host';
import { DISPLAY_FORMATS, type DisplayFormat, type DisplayOpName, FrError } from '@fractonica/protocol';

import type { Device, Handler, HubContext, OpInput } from '../context.ts';
import { allRefused, type CommandOutcome, selectDevices, sendCommandTo } from '../router/ops.ts';
import { framebufferBytes, framebufferToPng, pngToFramebuffer } from './png.ts';
import { checkScript, ensureRenderer, resolvePanel, runRenderer } from './render.ts';

/** snapshot_read's largest chunk (fr.display: len 1..1024). */
export const SNAPSHOT_CHUNK = 1024;

/** One device's display_snapshot row. */
export interface SnapshotRow {
  device: string;
  alias: string;
  status: string;
  path?: string;
  crc?: number;
  width?: number;
  height?: number;
  format?: DisplayFormat;
  bytes?: number;
  ms?: number;
  link?: string;
  error?: string;
  details?: Record<string, unknown>;
  png_base64?: string;
}

/** A file-name stamp: the ISO time without separators, to the millisecond (20261028T101500123Z). */
function stamp(): string {
  return new Date().toISOString().replace(/[-:.]/g, '');
}

/** `p` with symlinks resolved as far as it exists (the rest appended), so a link out of FR_HOME is seen. */
function realish(p: string): string {
  let head = p;
  const rest: string[] = [];
  while (!existsSync(head)) {
    const up = dirname(head);
    if (up === head) {
      return p;
    }
    rest.unshift(basename(head));
    head = up;
  }
  try {
    return join(realpathSync(head), ...rest);
  } catch {
    return p;
  }
}

const inside = (p: string, base: string) => {
  const r = relative(base, p);
  return r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r));
};

/** Whether absolute `o` lies under FR_HOME, symlinks resolved (a link out of FR_HOME is outside). */
export function underHome(o: string): boolean {
  const home = resolve(paths.home());
  return inside(o, home) && inside(realish(o), realish(home));
}

/**
 * `out` checked: absolute, and under FR_HOME (symlinks resolved). The display ops are tier read (an agent may run
 * them unasked), so the files they write stay in the hub's own directory.
 */
function checkOut(out: string): string {
  if (!isAbsolute(out)) {
    throw new FrError('INVALID_ARGS', `out must be an absolute path (got ${out}): the hub writes it, and its working directory is not yours`);
  }
  const home = resolve(paths.home());
  const o = resolve(out);
  if (!underHome(o)) {
    throw new FrError('INVALID_ARGS', `out ${out} is outside FR_HOME (${home}): the display ops are tier read and write files only under FR_HOME`, {
      hint: `give a path under ${home} (e.g. ${join(home, 'renders', 'ui.png')}), or leave out out and copy the PNG from the path returned`,
    });
  }
  return o;
}

/** Where a PNG goes: `out` (a .png file, -<suffix> added when several share it, or a directory), else FR_HOME/<sub>. */
function pngPath(out: string | undefined, sub: string, name: string, suffix: string | null): string {
  if (out === undefined) {
    return join(paths.home(), sub, `${name}-${stamp()}.png`);
  }
  const o = checkOut(out);
  if (/\.png$/i.test(o)) {
    return suffix ? o.replace(/\.png$/i, `-${suffix}.png`) : o;
  }
  return join(o, `${name}-${stamp()}.png`);
}

function writePng(file: string, png: Uint8Array): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, png);
}

/** A failed step as a row: the command outcome's status and error, the step named. */
function failedRow(base: Pick<SnapshotRow, 'device' | 'alias'>, step: string, o: CommandOutcome, t0: number): SnapshotRow {
  return {
    ...base,
    status: o.status === 'ok' ? 'failed' : o.status,
    error: `${step}: ${o.error ?? o.status}`,
    ...(o.link ? { link: o.link } : {}),
    ...(o.details ? { details: o.details } : {}),
    ms: Math.round(performance.now() - t0),
  };
}

/**
 * Per hub and device: the tail of the snapshots queued on it. A device keeps one frozen frame (the last `snapshot`),
 * so a second snapshot taken while the first one's chunks are read would hand the first a mix of two frames (the
 * dashboard's and an agent's can overlap): one snapshot and all its reads per device at a time.
 */
const snapshotQueues = new WeakMap<HubContext, Map<string, Promise<void>>>();

/**
 * Waits for `device`'s earlier snapshots (at most `waitMs`), then holds it: the release function, or null when the
 * wait ran out (the place in the queue is given up; later snapshots still wait for the earlier ones).
 */
async function lockDevice(hub: HubContext, device: string, waitMs: number): Promise<(() => void) | null> {
  let queues = snapshotQueues.get(hub);
  if (!queues) {
    queues = new Map();
    snapshotQueues.set(hub, queues);
  }
  const prev = queues.get(device) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const tail = prev.then(() => mine);
  queues.set(device, tail);
  void tail.then(() => {
    if (queues.get(device) === tail) {
      queues.delete(device);
    }
  });
  let timer: NodeJS.Timeout | undefined;
  const got = await Promise.race([prev.then(() => true), new Promise<boolean>((r) => (timer = setTimeout(() => r(false), Math.max(0, waitMs))))]);
  clearTimeout(timer);
  if (!got) {
    release();
    return null;
  }
  return release;
}

/** One device's snapshot: the framebuffer read, checked and written as a PNG; failures are rows, not errors. */
async function snapshotOne(hub: HubContext, dev: Device, input: OpInput<'display_snapshot'>, several: boolean): Promise<SnapshotRow> {
  const t0 = performance.now();
  const base = { device: dev.device_id, alias: dev.alias };
  const totalMs = input.total_timeout_s * 1000;
  const deadline = t0 + totalMs;
  const release = await lockDevice(hub, dev.device_id, totalMs);
  if (!release) {
    return { ...base, status: 'timeout', error: `another display_snapshot of ${dev.alias} held it for the whole ${input.total_timeout_s} s (total_timeout_s)`, ms: Math.round(performance.now() - t0) };
  }
  try {
    return await snapshotLocked(hub, dev, input, several, base, t0, deadline);
  } finally {
    release();
  }
}

async function snapshotLocked(
  hub: HubContext,
  dev: Device,
  input: OpInput<'display_snapshot'>,
  several: boolean,
  base: Pick<SnapshotRow, 'device' | 'alias'>,
  t0: number,
  deadline: number,
): Promise<SnapshotRow> {
  const ms = () => Math.round(performance.now() - t0);
  /** Each answer's wait: timeout_s, cut to what is left of total_timeout_s (null: nothing is left). */
  const opts = () => {
    const left = deadline - performance.now();
    return left < 1 ? null : { ack: 'result' as const, timeoutMs: Math.min(input.timeout_s * 1000, left) };
  };
  const outOfTime = (what: string): SnapshotRow => ({ ...base, status: 'timeout', error: `${what}: total_timeout_s (${input.total_timeout_s} s) ran out`, ms: ms() });
  const first = opts();
  if (!first) {
    return outOfTime('snapshot (waiting for an earlier snapshot of this device)');
  }
  const snap = await sendCommandTo(hub, dev, input.instance, 'snapshot', {}, first);
  if (snap.status !== 'ok') {
    return failedRow(base, 'snapshot', snap, t0);
  }
  const f = (snap.fields ?? {}) as { crc?: number; width?: number; height?: number; format?: string; bytes?: number };
  const { crc = 0, width = 0, height = 0, bytes = 0 } = f;
  const format = f.format as DisplayFormat;
  if (!(DISPLAY_FORMATS as readonly string[]).includes(String(f.format)) || bytes !== framebufferBytes(width, height, format) || !bytes) {
    return { ...base, status: 'failed', error: `snapshot: ${width}x${height} ${String(f.format)} with ${bytes} B is no framebuffer this hub reads`, ms: ms() };
  }
  const shape = { crc, width, height, format, bytes };
  const fb = new Uint8Array(bytes);
  let link = snap.link;
  for (let offset = 0; offset < bytes; offset += SNAPSHOT_CHUNK) {
    const len = Math.min(SNAPSHOT_CHUNK, bytes - offset);
    let got: CommandOutcome | null = null;
    let data: Uint8Array | null = null;
    // A chunk that fails or comes back short is asked for once more.
    for (let attempt = 0; attempt < 2 && !data; attempt++) {
      const o = opts();
      if (!o) {
        return { ...outOfTime(`snapshot_read at offset ${offset} of ${bytes} B`), ...shape, ...(link ? { link } : {}) };
      }
      got = await sendCommandTo(hub, dev, input.instance, 'snapshot_read', { offset, len }, o);
      const hex = (got.fields as { data?: unknown } | undefined)?.data;
      if (got.status === 'ok' && typeof hex === 'string' && hex.length === len * 2) {
        data = Buffer.from(hex, 'hex');
      }
    }
    if (!data) {
      const o = got!;
      const short = o.status === 'ok' ? { ...o, error: `${((o.fields as { data?: string } | undefined)?.data?.length ?? 0) / 2} B of ${len}` } : o;
      return { ...failedRow(base, `snapshot_read at offset ${offset} (twice)`, short, t0), ...shape };
    }
    fb.set(data, offset);
    link = got!.link ?? link;
  }
  const read = crc32(fb);
  if (read !== crc) {
    return {
      ...base,
      status: 'failed',
      error: `the bytes read have CRC-32 ${read.toString(16)}, the snapshot said ${crc.toString(16)}: snapshot again`,
      ...shape,
      ...(link ? { link } : {}),
      ms: ms(),
    };
  }
  const png = framebufferToPng(fb, width, height, format);
  const path = pngPath(input.out, 'snapshots', `${dev.alias}-${input.instance}`, several ? dev.alias : null);
  writePng(path, png);
  return {
    ...base,
    status: 'ok',
    path,
    ...shape,
    ms: ms(),
    ...(link ? { link } : {}),
    ...(input.inline ? { png_base64: png.toString('base64') } : {}),
  };
}

/**
 * The renderer's PNG written again through png.ts (decoded, checked against the renderer's own size, format and
 * CRC, encoded): the bytes display_snapshot writes for the same framebuffer. INTERNAL when it does not decode or match.
 */
function reencodeRender(file: string, r: { crc: number; width: number; height: number; format: DisplayFormat }): Buffer {
  let d;
  try {
    d = pngToFramebuffer(readFileSync(file));
  } catch (e) {
    throw new FrError('INTERNAL', `the desktop renderer's PNG does not decode: ${(e as Error).message}`);
  }
  const crc = crc32(d.fb);
  if (d.width !== r.width || d.height !== r.height || d.format !== r.format || crc !== r.crc) {
    throw new FrError(
      'INTERNAL',
      `the desktop renderer's PNG (${d.width}x${d.height} ${d.format}, CRC-32 ${crc.toString(16)}) is not the framebuffer it reported (${r.width}x${r.height} ${r.format}, ${r.crc.toString(16)})`,
    );
  }
  return framebufferToPng(d.fb, d.width, d.height, d.format);
}

export const DISPLAY_HANDLERS: Record<DisplayOpName, Handler> = {
  display_snapshot: async (input: OpInput<'display_snapshot'>, hub) => {
    if (input.out !== undefined) {
      checkOut(input.out);
    }
    const devices = selectDevices(hub, input.selector);
    const results = await Promise.all(devices.map((d) => snapshotOne(hub, d, input, devices.length > 1)));
    // All offline (or all release builds): the op fails, as command_send does. Offline names each device's reason:
    // no link at all, or only a gateway's, which carries no BULK (snapshot is BULK, so nothing was frozen).
    const refused = allRefused(results);
    if (refused?.code === 'DEVICE_OFFLINE' && results.every((r) => r.error)) {
      throw new FrError('DEVICE_OFFLINE', results.map((r) => `${r.alias}: ${r.error}`).join('; '), { remediation: refused.remediation, details: refused.details });
    }
    if (refused) {
      throw refused;
    }
    return { results };
  },

  display_render: async (input: OpInput<'display_render'>, hub) => {
    const t0 = performance.now();
    const deadline = t0 + input.timeout_s * 1000;
    const panel = await resolvePanel(hub.hubSourceDir, input.profile, input.instance);
    const lines = checkScript(input, panel);
    const out = pngPath(input.out, 'renders', `${panel.profile}-${panel.name}`, null);
    const { bin, built } = await ensureRenderer(hub.hubSourceDir, Math.max(1000, deadline - performance.now()));
    const dir = mkdtempSync(join(tmpdir(), 'fr-render-'));
    try {
      const script = join(dir, 'script.jsonl');
      writeFileSync(script, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
      const drawn = join(dir, 'render.png');
      const { png: _drawn, ...r } = await runRenderer(bin, panel, script, drawn, { cwd: hub.hubSourceDir, timeoutMs: Math.max(5000, deadline - performance.now()) });
      const png = reencodeRender(drawn, r);
      writePng(out, png);
      return {
        ...r,
        path: out,
        profile: panel.profile,
        instance: panel.name,
        rotation: panel.rotation,
        ui: panel.ui,
        touch: panel.touch,
        built,
        ms: Math.round(performance.now() - t0),
        ...(input.inline ? { png_base64: png.toString('base64') } : {}),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
};
