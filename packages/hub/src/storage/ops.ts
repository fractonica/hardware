// Storage op handlers (packages/protocol/src/ops/storage.ts; design lcd-clock-c1 D9, fr.storage D5), spread into
// HANDLERS (packages/hub/src/ops.ts). Everything goes over the hub link as fr.storage commands; the board does the file
// I/O off its core task and answers BUSY while another command holds the card.
// - storage_info, storage_ls (queries): info; list, page after page (16 entries each) until `more` is false.
// - storage_rm, storage_mkdir (commands).
// - storage_get (job): stat, then read in chunks (each asked for once more when it fails or comes back short of
//   what it said), written to the Mac file as they come; a cancel keeps what came.
// - storage_put (job): the Mac file in chunks, the first write truncating (so a shorter file replaces a longer one).
// - storage_bench (job): a seeded xorshift32 pattern written as storage_put does, read back as storage_get does into
//   memory, compared, and removed (also on a cancel or a failure) unless keep.
// A chunk is 1,024 B (fr.storage's largest); a board configured smaller answers INVALID_ARGS and the job halves it, down
// to 128 B. A BUSY chunk is retried after a short wait a few times. The jobs of one instance run one at a time (lock).

import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

import { paths } from '@fractonica/host';
import {
  FrError,
  MAX_WAIT_S,
  STORAGE_CHUNK_MAX,
  STORAGE_PUT_MAX_BYTES,
  storagePathProblem,
  type StorageBench,
  type StorageEntry,
  type StorageGet,
  type StorageInfo,
  type StorageOpName,
  type StoragePut,
} from '@fractonica/protocol';

import { commandFailed, onlineDevice, sleep } from '../audio/ops.ts';
import { unusedPath } from '../camera/ops.ts';
import type { Device, Handler, HubContext, OpInput } from '../context.ts';
import { underHome } from '../display/ops.ts';
import type { JobCtx } from '../jobs.ts';
import type { PortCap } from '../router/caps.ts';
import { type CommandOutcome, sendCommandTo } from '../router/ops.ts';
import { boolOrNull, capInstance, manifestTraits, num } from './instance.ts';

export const STORAGE_CAP = 'fr.storage';
/** One command's RESULT: a chunk of FAT I/O on the card is a few ms, a first mount about a hundred. */
export const STORAGE_CMD_TIMEOUT_MS = 5000;
/** The smallest chunk the jobs fall back to (fr.storage config chunk: 128..1024). */
export const STORAGE_CHUNK_MIN = 128;
/** A BUSY chunk: waits between tries, and how many. */
const BUSY_WAIT_MS = 200;
const BUSY_TRIES = 5;
/** storage_info: how long a BUSY (a mount in the background) is waited out. */
const INFO_BUSY_MS = 10_000;

// ---- the pattern (pure) ----

/** storage_bench's bytes: xorshift32 from `seed` (0 is taken as 1), four bytes per step, little-endian. */
export function benchPattern(seed: number, bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < bytes; i += 4) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    for (let k = 0; k < 4 && i + k < bytes; k++) {
      out[i + k] = (x >>> (8 * k)) & 0xff;
    }
  }
  return out;
}

/** The first offset where `a` and `b` differ (a length difference counts at the shorter's end), or null. */
export function firstMismatch(a: Uint8Array, b: Uint8Array): number | null {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      return i;
    }
  }
  return a.length === b.length ? null : n;
}

/** KB/s (1 KB = 1,024 B) of `bytes` over `ms`, two decimals; 0 for no time. */
export function kbPerS(bytes: number, ms: number): number {
  return ms > 0 ? Math.round((bytes / 1024 / (ms / 1000)) * 100) / 100 : 0;
}

/** The card path of a Mac file put with no `path`: /<its name>. */
export function defaultCardPath(file: string): string {
  return `/${basename(file)}`;
}

// ---- commands ----

/**
 * A storage command that did not answer OK, as the op's error, in the card's own words: BUSY (another command holds
 * the card), NOT_FOUND (no such path), INVALID_ARGS (a bad path, a directory where a file was meant, not empty),
 * FAILED (no card, or the card failed: storage_info says which).
 */
export function storageFailed(dev: Device, inst: string, what: string, o: CommandOutcome): FrError {
  const details = { status: o.status, ...(o.details ? o.details : {}) };
  const said = o.error ? ` (${o.error})` : '';
  const info = { tool: 'storage_info', args: { device: dev.alias, instance: inst }, cli: `fr storage info ${dev.alias}` };
  if (o.status === 'busy') {
    return new FrError('DEVICE_BUSY', `${dev.alias} ${inst} ${what}: the card is busy with another command, try again${said}`, { details });
  }
  if (o.status === 'not_found') {
    return new FrError('NOT_FOUND', `${dev.alias} ${inst} ${what}: no such file or directory on the card${said}`, {
      details,
      remediation: [{ tool: 'storage_ls', args: { device: dev.alias, path: '/' }, cli: `fr storage ls ${dev.alias} /` }],
    });
  }
  if (o.status === 'invalid_args') {
    return new FrError('INVALID_ARGS', `${dev.alias} ${inst} ${what}: refused${said}`, { details });
  }
  if (o.status === 'failed') {
    return new FrError('DELIVERY_FAILED', `${dev.alias} ${inst} ${what}: the card failed or is not there${said}`, {
      details,
      hint: 'storage_info shows the state: none (no card, or it did not mount: reseat it), error (the card or its filesystem failed: FAT32 is expected)',
      remediation: [info],
    });
  }
  return commandFailed(dev, `${inst} ${what}`, o);
}

async function send(hub: HubContext, dev: Device, inst: PortCap, cmd: string, args: Record<string, unknown>): Promise<CommandOutcome> {
  return sendCommandTo(hub, dev, inst.name, cmd, args, { ack: 'result', timeoutMs: STORAGE_CMD_TIMEOUT_MS }).catch(
    (e: Error) => ({ device: dev.device_id, alias: dev.alias, status: 'error', error: e.message }) as CommandOutcome,
  );
}

async function command(hub: HubContext, dev: Device, inst: PortCap, cmd: string, args: Record<string, unknown>, what = cmd): Promise<Record<string, unknown>> {
  const o = await send(hub, dev, inst, cmd, args);
  if (o.status !== 'ok') {
    throw storageFailed(dev, inst.name, what, o);
  }
  return o.fields ?? {};
}

/** A command sent again after a short wait while the card answers BUSY (BUSY_TRIES), and once more when it fails otherwise. */
async function retried(hub: HubContext, dev: Device, inst: PortCap, cmd: string, args: Record<string, unknown>, signal: AbortSignal): Promise<CommandOutcome> {
  let o = await send(hub, dev, inst, cmd, args);
  let other = 0;
  for (let busy = 0; o.status !== 'ok' && !signal.aborted; ) {
    if (o.status === 'busy' && busy < BUSY_TRIES) {
      busy++;
      await sleep(BUSY_WAIT_MS, signal);
    } else if (o.status !== 'busy' && o.status !== 'invalid_args' && o.status !== 'not_found' && other < 1) {
      other++;
    } else {
      break;
    }
    o = await send(hub, dev, inst, cmd, args);
  }
  return o;
}

const entryOf = (v: unknown): StorageEntry => {
  const e = (v ?? {}) as Record<string, unknown>;
  return { name: String(e.name ?? ''), size: num(e.size) ?? 0, dir: e.dir === true, mtime: num(e.mtime) ?? 0 };
};

const hexBytes = (v: unknown): Buffer | null => (typeof v === 'string' && v.length % 2 === 0 && /^[0-9a-f]*$/i.test(v) ? Buffer.from(v, 'hex') : null);

// ---- transfers ----

interface Transfer {
  hub: HubContext;
  dev: Device;
  inst: PortCap;
  ctx: JobCtx;
  /** The share of the job's progress this transfer covers: [from, to] in %. */
  span: [number, number];
  label: string;
}

/**
 * `data` to `path` on the card in chunks, the first truncating. Returns the bytes written and the file's size after the
 * last write; stops early (fewer bytes) when the job is cancelled.
 */
export async function writeAll(t: Transfer, path: string, data: Uint8Array): Promise<{ bytes: number; size: number; ms: number }> {
  const t0 = performance.now();
  let chunk = STORAGE_CHUNK_MAX;
  let offset = 0;
  let size = 0;
  let lastPct = -1;
  do {
    if (t.ctx.signal.aborted) {
      break;
    }
    const len = Math.min(chunk, data.length - offset);
    const piece = data.subarray(offset, offset + len);
    const o = await retried(t.hub, t.dev, t.inst, 'write', { path, offset, data: Buffer.from(piece).toString('hex'), truncate: offset === 0 }, t.ctx.signal);
    if (o.status === 'invalid_args' && chunk > STORAGE_CHUNK_MIN && len > STORAGE_CHUNK_MIN) {
      chunk = Math.max(STORAGE_CHUNK_MIN, chunk >> 1); // the board's config chunk is smaller: halve and try again
      t.ctx.log(`write: the board refused ${len} B, chunks of ${chunk} B from here`);
      continue;
    }
    if (o.status !== 'ok') {
      if (t.ctx.signal.aborted) {
        break;
      }
      throw storageFailed(t.dev, t.inst.name, `write ${path} at ${offset}`, o);
    }
    size = num(o.fields?.size) ?? offset + len;
    offset += len;
    const pct = Math.round(t.span[0] + ((t.span[1] - t.span[0]) * offset) / Math.max(1, data.length));
    if (pct !== lastPct) {
      lastPct = pct;
      t.ctx.progress(Math.min(99, pct), `${t.label}: ${offset} of ${data.length} B`);
    }
  } while (offset < data.length);
  return { bytes: offset, size, ms: Math.round(performance.now() - t0) };
}

/**
 * `size` bytes of `path` from the card in chunks, each handed to `sink` in order. A chunk that fails or comes back
 * short without eof is asked for once more; eof ends it early. Returns the bytes read; stops early when cancelled.
 */
export async function readAll(t: Transfer, path: string, size: number, sink: (b: Buffer, offset: number) => void): Promise<{ bytes: number; ms: number }> {
  const t0 = performance.now();
  let chunk = STORAGE_CHUNK_MAX;
  let offset = 0;
  let lastPct = -1;
  while (offset < size && !t.ctx.signal.aborted) {
    const len = Math.min(chunk, size - offset);
    let data: Buffer | null = null;
    let eof = false;
    let o: CommandOutcome | null = null;
    for (let attempt = 0; attempt < 2 && !data && !t.ctx.signal.aborted; attempt++) {
      o = await retried(t.hub, t.dev, t.inst, 'read', { path, offset, len }, t.ctx.signal);
      if (o.status === 'invalid_args' && chunk > STORAGE_CHUNK_MIN && len > STORAGE_CHUNK_MIN) {
        break;
      }
      const got = o.status === 'ok' ? hexBytes(o.fields?.data) : null;
      eof = o.fields?.eof === true;
      if (got && (got.length === len || (eof && got.length <= len))) {
        data = got;
      }
    }
    if (!data && o?.status === 'invalid_args' && chunk > STORAGE_CHUNK_MIN && len > STORAGE_CHUNK_MIN) {
      chunk = Math.max(STORAGE_CHUNK_MIN, chunk >> 1);
      t.ctx.log(`read: the board refused ${len} B, chunks of ${chunk} B from here`);
      continue;
    }
    if (!data) {
      if (t.ctx.signal.aborted) {
        break;
      }
      const short = o && o.status === 'ok' ? { ...o, status: 'failed', error: `${hexBytes(o.fields?.data)?.length ?? 0} B of ${len} without eof, twice` } : o!;
      throw storageFailed(t.dev, t.inst.name, `read ${path} at ${offset}`, short);
    }
    sink(data, offset);
    offset += data.length;
    const pct = Math.round(t.span[0] + ((t.span[1] - t.span[0]) * offset) / Math.max(1, size));
    if (pct !== lastPct) {
      lastPct = pct;
      t.ctx.progress(Math.min(99, pct), `${t.label}: ${offset} of ${size} B`);
    }
    if (eof) {
      break; // the file ended before the size stat said (it changed meanwhile)
    }
  }
  return { bytes: offset, ms: Math.round(performance.now() - t0) };
}

// ---- files on the Mac ----

/** `FR_HOME/storage/<alias>`. */
export function storageDir(alias: string): string {
  return join(resolve(paths.home()), 'storage', alias);
}

const inside = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/**
 * `out` checked: absolute, under FR_HOME/storage (the hub writes copies only there, never over its own files: the
 * database, secrets.json), not an existing file (opened with 'wx': nothing is overwritten).
 */
export function checkGetOut(out: string): string {
  if (!isAbsolute(out)) {
    throw new FrError('INVALID_ARGS', `out must be an absolute path (got ${out}): the hub writes it, and its working directory is not yours`);
  }
  const o = resolve(out);
  const dir = join(resolve(paths.home()), 'storage');
  if (!underHome(o) || !inside(o, dir) || o === dir) {
    throw new FrError('INVALID_ARGS', `out ${out} is outside ${dir}: the hub writes copies only there`, {
      hint: `give a path under ${dir} (e.g. ${join(dir, 'copy.bin')}) and copy the file from there`,
    });
  }
  return o;
}

/**
 * A Mac file storage_put may copy to a card: not the hub's own (FR_HOME, but for FR_HOME/storage, where storage_get puts
 * copies) and not ~/.ssh. Symlinks are followed first, so a link to secrets.json is refused too.
 */
export function checkPutFile(file: string): string {
  let real: string;
  try {
    real = realpathSync(file);
  } catch {
    throw new FrError('NOT_FOUND', `no file ${file} on the Mac`);
  }
  const home = (() => {
    try {
      return realpathSync(resolve(paths.home()));
    } catch {
      return resolve(paths.home());
    }
  })();
  const ssh = join(homedir(), '.ssh');
  if ((inside(real, home) && !inside(real, join(home, 'storage'))) || inside(real, ssh)) {
    throw new FrError('INVALID_ARGS', `${file} is one of the hub's own files or a key directory's: storage_put does not copy those to a card`, {
      hint: `files under ${join(home, 'storage')} (storage_get's copies) and anywhere outside ${home} and ~/.ssh can be put`,
    });
  }
  return real;
}

// ---- handlers ----

const lockOf = (dev: Device, inst: PortCap) => `storage:${dev.device_id}:${inst.name}`;

export const STORAGE_HANDLERS: Record<StorageOpName, Handler> = {
  storage_info: async (input: OpInput<'storage_info'>, hub): Promise<StorageInfo> => {
    const dev = onlineDevice(hub, input.device);
    const inst = capInstance(hub, dev, input.instance, STORAGE_CAP);
    // The board answers BUSY while it mounts a card in the background (a card's init takes up to a few seconds, longer
    // with none): ask again until it answers, up to INFO_BUSY_MS.
    let o = await send(hub, dev, inst, 'info', {});
    for (const t0 = performance.now(); o.status === 'busy' && performance.now() - t0 < INFO_BUSY_MS; ) {
      await sleep(BUSY_WAIT_MS);
      o = await send(hub, dev, inst, 'info', {});
    }
    if (o.status !== 'ok') {
      throw storageFailed(dev, inst.name, 'info', o);
    }
    const f = o.fields ?? {};
    const traits = manifestTraits(hub, dev, inst);
    return {
      device: dev.device_id,
      alias: dev.alias,
      instance: inst.name,
      state: (['none', 'mounted', 'error'].includes(String(f.state)) ? f.state : 'error') as StorageInfo['state'],
      card_type: (['unknown', 'sdsc', 'sdhc', 'sdxc'].includes(String(f.card_type)) ? f.card_type : 'unknown') as StorageInfo['card_type'],
      total_mb: num(f.total_mb) ?? 0,
      free_mb: num(f.free_mb) ?? 0,
      name: typeof f.name === 'string' ? f.name : '',
      speed_khz: num(f.speed_khz) ?? 0,
      removable: boolOrNull(traits?.removable),
      card_detect: boolOrNull(traits?.card_detect),
    };
  },

  storage_ls: async (input: OpInput<'storage_ls'>, hub) => {
    const dev = onlineDevice(hub, input.device);
    const inst = capInstance(hub, dev, input.instance, STORAGE_CAP);
    const entries: StorageEntry[] = [];
    // Pages of up to 16 until `more` is false (bounded: a directory of 65,535 entries is past what list's offset reaches).
    for (let page = 0; page < 4096; page++) {
      const f = await command(hub, dev, inst, 'list', { path: input.path, offset: entries.length }, `list ${input.path}`);
      const got = Array.isArray(f.entries) ? f.entries.map(entryOf) : [];
      entries.push(...got);
      if (f.more !== true || !got.length || entries.length >= 0xffff) {
        break;
      }
    }
    return { device: dev.device_id, alias: dev.alias, instance: inst.name, path: input.path, entries };
  },

  storage_rm: async (input: OpInput<'storage_rm'>, hub) => {
    const dev = onlineDevice(hub, input.device);
    const inst = capInstance(hub, dev, input.instance, STORAGE_CAP);
    if (input.path === '/') {
      throw new FrError('INVALID_ARGS', 'the card\'s root cannot be removed');
    }
    await command(hub, dev, inst, 'remove', { path: input.path }, `remove ${input.path}`);
    return { device: dev.device_id, alias: dev.alias, instance: inst.name, path: input.path };
  },

  storage_mkdir: async (input: OpInput<'storage_mkdir'>, hub) => {
    const dev = onlineDevice(hub, input.device);
    const inst = capInstance(hub, dev, input.instance, STORAGE_CAP);
    await command(hub, dev, inst, 'mkdir', { path: input.path }, `mkdir ${input.path}`);
    return { device: dev.device_id, alias: dev.alias, instance: inst.name, path: input.path };
  },

  storage_get: (input: OpInput<'storage_get'>, hub) => {
    const dev = onlineDevice(hub, input.device);
    const inst = capInstance(hub, dev, input.instance, STORAGE_CAP);
    if (input.path === '/') {
      throw new FrError('INVALID_ARGS', 'storage_get copies a file; / is the card\'s root (storage_ls lists it)');
    }
    const path = input.out !== undefined ? checkGetOut(input.out) : unusedPath(join(storageDir(dev.alias), basename(input.path)));
    const job = hub.jobs.start('storage', [dev.device_id], [lockOf(dev, inst)], async (ctx): Promise<StorageGet> => {
      ctx.stage('stat');
      const st = await command(hub, dev, inst, 'stat', { path: input.path }, `stat ${input.path}`);
      const entry = entryOf(st.entry);
      if (entry.dir) {
        throw new FrError('INVALID_ARGS', `${input.path} on ${dev.alias}'s card is a directory: storage_get copies a file (storage_ls lists it)`);
      }
      mkdirSync(dirname(path), { recursive: true });
      let fd: number;
      try {
        fd = openSync(path, 'wx'); // never over an existing file
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new FrError('INVALID_ARGS', `${path} exists already: storage_get does not overwrite (remove it, or give another out)`);
        }
        throw e;
      }
      let r: { bytes: number; ms: number };
      try {
        ctx.stage('read');
        ctx.log(`get ${dev.alias}:${input.path} (${entry.size} B) -> ${path}`);
        r = await readAll({ hub, dev, inst, ctx, span: [0, 100], label: 'read' }, input.path, entry.size, (b) => {
          writeSync(fd, b);
        });
      } finally {
        closeSync(fd);
      }
      const reason = ctx.signal.aborted ? 'stopped' : 'done';
      ctx.log(`got ${r.bytes} B in ${r.ms} ms (${kbPerS(r.bytes, r.ms)} KB/s)${reason === 'stopped' ? ', stopped' : ''}`);
      return { device: dev.device_id, alias: dev.alias, instance: inst.name, card_path: input.path, path, bytes: r.bytes, size: entry.size, ms: r.ms, kb_s: kbPerS(r.bytes, r.ms), reason };
    });
    return hub.jobs.wait(job.job_id, Math.min(input.wait_s ?? 0, MAX_WAIT_S));
  },

  storage_put: (input: OpInput<'storage_put'>, hub) => {
    const dev = onlineDevice(hub, input.device);
    const inst = capInstance(hub, dev, input.instance, STORAGE_CAP);
    if (!isAbsolute(input.file)) {
      throw new FrError('INVALID_ARGS', `file must be an absolute path on the Mac (got ${input.file}): the hub reads it, and its working directory is not yours`);
    }
    const real = checkPutFile(input.file);
    let st;
    try {
      st = statSync(real);
    } catch {
      throw new FrError('NOT_FOUND', `no file ${input.file} on the Mac`);
    }
    if (!st.isFile()) {
      throw new FrError('INVALID_ARGS', `${input.file} is not a file`);
    }
    if (st.size > STORAGE_PUT_MAX_BYTES) {
      throw new FrError('INVALID_ARGS', `${input.file} is ${st.size} B; storage_put takes at most ${STORAGE_PUT_MAX_BYTES} B (at ~100 KB/s a larger file takes many minutes: copy it with a card reader instead)`);
    }
    const cardPath = input.path ?? defaultCardPath(input.file);
    const problem = cardPath === '/' ? 'is the card\'s root, not a file' : storagePathProblem(cardPath);
    if (problem) {
      throw new FrError('INVALID_ARGS', `the card path ${cardPath} ${problem} (give path: ASCII, at most 96 bytes)`);
    }
    const job = hub.jobs.start('storage', [dev.device_id], [lockOf(dev, inst)], async (ctx): Promise<StoragePut> => {
      const data = readFileSync(real);
      if (data.length > STORAGE_PUT_MAX_BYTES) {
        throw new FrError('INVALID_ARGS', `${input.file} grew to ${data.length} B; storage_put takes at most ${STORAGE_PUT_MAX_BYTES} B`);
      }
      ctx.stage('write');
      ctx.log(`put ${input.file} (${data.length} B) -> ${dev.alias}:${cardPath}`);
      const w = await writeAll({ hub, dev, inst, ctx, span: [0, 100], label: 'write' }, cardPath, data);
      const reason = ctx.signal.aborted ? 'stopped' : 'done';
      ctx.log(`put ${w.bytes} B in ${w.ms} ms (${kbPerS(w.bytes, w.ms)} KB/s), card size ${w.size} B${reason === 'stopped' ? ', stopped' : ''}`);
      return { device: dev.device_id, alias: dev.alias, instance: inst.name, file: input.file, card_path: cardPath, bytes: w.bytes, size: w.size, ms: w.ms, kb_s: kbPerS(w.bytes, w.ms), reason };
    });
    return hub.jobs.wait(job.job_id, Math.min(input.wait_s ?? 0, MAX_WAIT_S));
  },

  storage_bench: (input: OpInput<'storage_bench'>, hub) => {
    const dev = onlineDevice(hub, input.device);
    const inst = capInstance(hub, dev, input.instance, STORAGE_CAP);
    if (input.path === '/') {
      throw new FrError('INVALID_ARGS', 'storage_bench needs a file path, not the root');
    }
    const bytes = Math.round(input.mb * 1024 * 1024);
    const seed = (input.seed ?? Date.now() & 0xffffffff) >>> 0;
    const job = hub.jobs.start('storage', [dev.device_id], [lockOf(dev, inst)], async (ctx): Promise<StorageBench> => {
      const pattern = benchPattern(seed, bytes);
      const t = { hub, dev, inst, ctx };
      let removed = false;
      let wrote = false;
      try {
        // Never over a file of the user's: the bench writes its own path only.
        const exists = await send(hub, dev, inst, 'stat', { path: input.path });
        if (exists.status === 'ok') {
          throw new FrError('INVALID_ARGS', `${input.path} exists on ${dev.alias}'s card: storage_bench writes and removes its own file only (give another path, or remove it first)`);
        }
        ctx.stage('write');
        ctx.log(`bench ${dev.alias}:${input.path}: ${bytes} B, seed ${seed}`);
        wrote = true;
        const w = await writeAll({ ...t, span: [0, 50], label: 'write' }, input.path, pattern);
        const back = new Uint8Array(w.bytes);
        let r = { bytes: 0, ms: 0 };
        if (!ctx.signal.aborted) {
          ctx.stage('read');
          r = await readAll({ ...t, span: [50, 99], label: 'read' }, input.path, w.bytes, (b, off) => back.set(b.subarray(0, Math.max(0, Math.min(b.length, back.length - off))), off));
        }
        const reason = ctx.signal.aborted ? 'stopped' : 'done';
        const mismatch = reason === 'done' ? firstMismatch(pattern, back.subarray(0, r.bytes)) : null;
        const identical = reason === 'done' && r.bytes === bytes && mismatch === null;
        if (!input.keep) {
          ctx.stage('remove');
          const o = await send(hub, dev, inst, 'remove', { path: input.path });
          removed = o.status === 'ok';
          wrote = false;
          if (!removed) {
            ctx.log(`remove ${input.path}: ${o.error ?? o.status}`, 'err');
          }
        }
        ctx.log(`bench: write ${kbPerS(w.bytes, w.ms)} KB/s, read ${kbPerS(r.bytes, r.ms)} KB/s, ${identical ? 'identical' : mismatch !== null ? `differs at ${mismatch}` : 'incomplete'}`);
        return {
          device: dev.device_id,
          alias: dev.alias,
          instance: inst.name,
          card_path: input.path,
          bytes,
          write_kb_s: kbPerS(w.bytes, w.ms),
          read_kb_s: kbPerS(r.bytes, r.ms),
          write_ms: w.ms,
          read_ms: r.ms,
          identical,
          mismatch_at: mismatch,
          seed,
          removed,
          reason,
        };
      } finally {
        if (wrote && !input.keep) {
          // A failure on the way: the file is not left behind (best effort).
          await send(hub, dev, inst, 'remove', { path: input.path });
        }
      }
    });
    return hub.jobs.wait(job.job_id, Math.min(input.wait_s ?? 0, MAX_WAIT_S));
  },
};
