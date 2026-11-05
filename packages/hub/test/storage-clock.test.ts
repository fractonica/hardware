// LCD-1 / CLOCK-1 hub stream (design lcd-clock-c1 D8, D9): the pure pieces (the bench pattern and its comparison, the
// second-boundary arithmetic of clock_sync and clock_read, the drift fit and the aging step), then every storage and
// clock op against a FakeNode with c6l-lcd's `card` (fr.storage 0x000F) and `clock` (fr.clock 0x0010): a card in
// memory (chunk limits, BUSY, NOT_FOUND, paging), a file there and back, the bench with and without a corrupted read,
// and an RTC whose seconds the fake keeps on the Mac's clock (or a fast one).

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { findOp, type ClockDrift, type ClockRead, type ClockSet, type Job, type StorageBench, type StorageGet, type StorageInfo, type StorageLs, type StoragePut } from '@fractonica/protocol';
import { decodeMember, encodeMember } from '@fractonica/protocol/gen';

const { HANDLERS } = await import('../src/ops.ts');
const { benchPattern, firstMismatch, kbPerS, defaultCardPath } = await import('../src/storage/ops.ts');
const { syncTarget, errorMs, fitDrift, agingSuggest, parseIsoUnix, isoOf, setClockTiming } = await import('../src/clock/ops.ts');
const { routerProbe } = await import('../src/router/index.ts');
const fakeNode = await import('./fake-node.ts');
const { otaRig, until, STATUS } = fakeNode;
type HubContext = import('../src/context.ts').HubContext;
type FakeNode = import('./fake-node.ts').FakeNode;
type OtaRig = import('./fake-node.ts').OtaRig;

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
  setClockTiming(null);
});

describe('pure pieces', () => {
  it('the bench pattern is the seed\'s, and a mismatch is found where it is', () => {
    const a = benchPattern(42, 1027);
    expect(a).toHaveLength(1027);
    expect(benchPattern(42, 1027)).toEqual(a);
    expect(benchPattern(43, 1027)).not.toEqual(a);
    expect(benchPattern(0, 8)).toEqual(benchPattern(1, 8)); // 0 is taken as 1
    expect(new Set(a).size).toBeGreaterThan(200); // not a constant fill
    const b = Uint8Array.from(a);
    expect(firstMismatch(a, b)).toBeNull();
    b[700] ^= 0xff;
    expect(firstMismatch(a, b)).toBe(700);
    expect(firstMismatch(a, a.subarray(0, 500))).toBe(500);
    expect(kbPerS(1024 * 100, 1000)).toBe(100);
    expect(kbPerS(5, 0)).toBe(0);
    expect(defaultCardPath('/Users/x/notes.txt')).toBe('/notes.txt');
  });

  it('clock_sync aims the next wall second at least 0.6 s ahead and maps it through hub µs to the node', () => {
    // Wall 1,000,000.250 s; the hub's µs run 3 ms behind the wall; the node's clock is hub µs − 1e12 + 5e6.
    const wall = 1_000_000_250_000;
    const hub = wall - 3000;
    const toNode = (h: number) => h - 1e12 + 5e6;
    const t = syncTarget(wall, hub, toNode);
    expect(t.unix).toBe(1_000_001); // 0.250 + 0.6 = 0.85 -> the next whole second
    expect(t.lead_ms).toBe(750);
    // Wall second 1,000,001 is hub µs 1,000,001e6 − 3,000 later... earlier: hub runs behind, so hub = wall − 3 ms.
    expect(t.at_us).toBe(toNode(1_000_001e6 - 3000));
    expect(syncTarget(1_000_000_500_000, 1_000_000_500_000, (h) => h).unix).toBe(1_000_002); // 0.5 + 0.6 = 1.1
  });

  it('error_ms is when the RTC second began against the wall second, negative when the RTC is ahead', () => {
    const toHub = (n: number) => n + 1e12; // node µs + 1e12 = hub µs
    // RTC second 1,000,000 began at node µs 0 = hub 1e12 µs; the wall is 2 ms ahead of hub µs, so it began at wall
    // 1e12 + 2,000 µs = 2 ms after the wall second: the RTC is 2 ms behind.
    expect(errorMs(1_000_000, 0, toHub, 2000)).toBe(2);
    expect(errorMs(1_000_000, -5000, toHub, 0)).toBe(-5); // began 5 ms early: ahead
  });

  it('the drift fit: a fast RTC (falling error) is positive ppm, its residual, and the aging step that cancels it', () => {
    const pts = Array.from({ length: 61 }, (_, i) => ({ t_s: i * 60, error_ms: 12 - (i * 60 * 2.5) / 1000 + (i % 2 ? 0.1 : -0.1) }));
    const f = fitDrift(pts);
    expect(f.ppm).toBeCloseTo(2.5, 1);
    expect(f.s_per_day).toBeCloseTo(0.216, 2);
    expect(f.residual_ms).toBeGreaterThan(0.09);
    expect(f.residual_ms).toBeLessThan(0.11);
    expect(f.span_s).toBe(3600);
    expect(fitDrift([{ t_s: 0, error_ms: 3 }])).toMatchObject({ ppm: null, first_ms: 3, last_ms: 3 });
    expect(fitDrift([])).toMatchObject({ ppm: null, first_ms: null });
    expect(agingSuggest(0, 2.5)).toBe(25); // fast: slow it, positive steps of 0.1 ppm
    expect(agingSuggest(10, -1.04)).toBe(0);
    expect(agingSuggest(120, 5)).toBe(127);
    expect(agingSuggest(-120, -5)).toBe(-128);
  });

  it('parses ISO times with a zone only', () => {
    expect(parseIsoUnix('2026-11-05T14:00:00Z')).toBe(Date.UTC(2026, 10, 5, 14) / 1000);
    expect(parseIsoUnix('2026-11-05T17:00:00+03:00')).toBe(Date.UTC(2026, 10, 5, 14) / 1000);
    expect(parseIsoUnix('2026-11-05T14:00:00.900Z')).toBe(Date.UTC(2026, 10, 5, 14) / 1000);
    expect(parseIsoUnix('2026-11-05T14:00:00')).toBeNull(); // no zone: ambiguous
    expect(parseIsoUnix('yesterday')).toBeNull();
    expect(isoOf(Date.UTC(2026, 10, 5, 14) / 1000)).toBe('2026-11-05T14:00:00Z');
  });
});

// ---- the fake board ----

const DEV = 'a085e3ae96ac';
const PORT = { card: 1, clock: 2 } as const;
const CAPS = [
  { port: 1, cap_id: 0x000f, name: 'card' },
  { port: 2, cap_id: 0x0010, name: 'clock' },
];
const ST = { info: 1, list: 2, stat: 3, read: 4, write: 5, remove: 6, mkdir: 7 } as const;
const CL = { read: 1, set: 2, set_aging: 3 } as const;

const enc = (cap: string, part: 'args' | 'result' | 'event' | 'state', member: string, v: unknown) => {
  const e = encodeMember(cap, part, member, v);
  if (!e.ok) {
    throw new Error(`${cap}.${member}: ${e.detail}`);
  }
  return e.value;
};
const dec = (cap: string, member: string, bytes: Uint8Array): Record<string, unknown> => {
  const d = decodeMember(cap, 'args', member, bytes);
  if (!d.ok) {
    throw new Error(`${cap}.${member}: ${d.error}`);
  }
  return d.value;
};

interface Card {
  files: Map<string, Uint8Array>;
  dirs: Set<string>;
  /** The board's config chunk: a longer read or write is INVALID_ARGS. */
  chunk: number;
  /** BUSY answers left before the next command goes through. */
  busy: number;
  /** Flip a byte at this file offset on every read (a bad card or bus). */
  corruptAt: number | null;
  writes: number;
  reads: number;
}

interface Rtc {
  /** The RTC's ms clock as a function of the wall ms (identity: in step with the Mac). */
  rtcMsAt: (wallMs: number) => number;
  /** The wall ms the RTC's second `s` began (the inverse). */
  wallMsOf: (s: number) => number;
  aging: number;
  sets: Record<string, unknown>[];
  /** The node µs at which the node received each set. */
  setAt: number[];
  /** The board takes set commands but its writes fail (no `set` event). */
  dropWrites?: boolean;
}

interface Board {
  r: OtaRig;
  hub: HubContext;
  node: FakeNode;
  card: Card;
  rtc: Rtc;
}

const parent = (p: string) => p.slice(0, Math.max(1, p.lastIndexOf('/')));

/** FR_HOME at a temp dir for the test, so storage_get's default copies never land in the real one. */
function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'fr-home-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const prev = process.env.FR_HOME;
  process.env.FR_HOME = home;
  cleanups.push(() => (prev === undefined ? delete process.env.FR_HOME : (process.env.FR_HOME = prev)));
  return home;
}

async function board(): Promise<Board> {
  freshHome();
  const r = await otaRig();
  cleanups.push(() => r.close());
  r.registry.add({ device_id: DEV, addr: 0x52, alias: 'lcd-c6', provisioned: true, net: 0, chip: 'esp32c6' });
  const node = r.node({ mac: DEV, addr: 0x52, alias: 'lcd-c6' });
  node.describeAs(CAPS);
  const card: Card = { files: new Map(), dirs: new Set(['/']), chunk: 1024, busy: 0, corruptAt: null, writes: 0, reads: 0 };
  const rtc: Rtc = { rtcMsAt: (w) => w, wallMsOf: (s) => s * 1000, aging: 0, sets: [], setAt: [] };
  const b: Board = { r, hub: r.hub, node, card, rtc };
  const busy = () => (card.busy > 0 ? (card.busy--, { status: STATUS.BUSY }) : null);
  const res = (member: string, v: unknown) => ({ fields: enc('fr.storage', 'result', member, v) });
  node.handlers.set(`${PORT.card}/${ST.info}`, () => res('info', { state: 'mounted', card_type: 'sdhc', total_mb: 30436, free_mb: 30400, name: 'SD32G', speed_khz: 20000 }));
  node.handlers.set(`${PORT.card}/${ST.list}`, (args) => {
    const a = dec('fr.storage', 'list', args);
    const dir = String(a.path);
    if (!card.dirs.has(dir)) {
      return { status: STATUS.NOT_FOUND };
    }
    const prefix = dir === '/' ? '/' : `${dir}/`;
    const names = [...card.dirs].filter((d) => d !== '/' && parent(d) === dir).map((d) => ({ name: d.slice(prefix.length), size: 0, dir: true, mtime: 0 }));
    names.push(...[...card.files].filter(([p]) => parent(p) === dir).map(([p, d]) => ({ name: p.slice(prefix.length), size: d.length, dir: false, mtime: 1793880000 })));
    const off = Number(a.offset ?? 0);
    return res('list', { entries: names.slice(off, off + 16), more: off + 16 < names.length });
  });
  node.handlers.set(`${PORT.card}/${ST.stat}`, (args) => {
    const p = String(dec('fr.storage', 'stat', args).path);
    const f = card.files.get(p);
    if (f) {
      return res('stat', { entry: { name: p.slice(p.lastIndexOf('/') + 1), size: f.length, dir: false, mtime: 0 } });
    }
    return card.dirs.has(p) ? res('stat', { entry: { name: p.slice(p.lastIndexOf('/') + 1), size: 0, dir: true, mtime: 0 } }) : { status: STATUS.NOT_FOUND };
  });
  node.handlers.set(`${PORT.card}/${ST.read}`, (args) => {
    const no = busy();
    if (no) {
      return no;
    }
    const a = dec('fr.storage', 'read', args);
    const len = Number(a.len);
    if (len > card.chunk) {
      return { status: STATUS.INVALID_ARGS };
    }
    const f = card.files.get(String(a.path));
    if (!f) {
      return { status: STATUS.NOT_FOUND };
    }
    card.reads++;
    const off = Number(a.offset);
    const piece = Uint8Array.from(f.subarray(off, off + len));
    if (card.corruptAt !== null && card.corruptAt >= off && card.corruptAt < off + piece.length) {
      piece[card.corruptAt - off] ^= 0x5a;
    }
    return res('read', { data: Buffer.from(piece).toString('hex'), eof: off + piece.length >= f.length });
  });
  node.handlers.set(`${PORT.card}/${ST.write}`, (args) => {
    const no = busy();
    if (no) {
      return no;
    }
    const a = dec('fr.storage', 'write', args);
    const data = typeof a.data === 'string' ? Buffer.from(a.data, 'hex') : (a.data as Uint8Array);
    if (data.length > card.chunk) {
      return { status: STATUS.INVALID_ARGS };
    }
    const p = String(a.path);
    for (let d = parent(p); d !== '/'; d = parent(d)) {
      card.dirs.add(d);
    }
    const off = Number(a.offset);
    let f = card.files.get(p) ?? new Uint8Array(0);
    if (a.truncate === true) {
      f = f.subarray(0, Math.min(f.length, off + data.length));
    }
    const out = new Uint8Array(Math.max(f.length, off + data.length));
    out.set(f);
    out.set(data, off);
    card.files.set(p, out);
    card.writes++;
    return res('write', { size: out.length });
  });
  node.handlers.set(`${PORT.card}/${ST.remove}`, (args) => {
    const p = String(dec('fr.storage', 'remove', args).path);
    if (card.files.delete(p)) {
      return undefined;
    }
    return card.dirs.delete(p) ? undefined : { status: STATUS.NOT_FOUND };
  });
  node.handlers.set(`${PORT.card}/${ST.mkdir}`, (args) => {
    const p = String(dec('fr.storage', 'mkdir', args).path);
    for (let d = p; d !== '/'; d = parent(d)) {
      card.dirs.add(d);
    }
    return undefined;
  });
  // The RTC: its current second from the wall clock through rtcMsAt, the node µs that second began at.
  node.handlers.set(`${PORT.clock}/${CL.read}`, () => {
    const wall = Date.now();
    const s = Math.floor(b.rtc.rtcMsAt(wall) / 1000);
    const began = b.rtc.wallMsOf(s);
    const rollover = Math.round(node.nodeNowUs() - (wall - began) * 1000);
    return { fields: enc('fr.clock', 'result', 'read', { unix: s, valid: true, osf: false, temp_c10: 245, aging: b.rtc.aging, offset_ms: 0, rollover_us: String(rollover), injected: false }) };
  });
  node.handlers.set(`${PORT.clock}/${CL.set}`, (args) => {
    rtc.setAt.push(node.nodeNowUs());
    const a = dec('fr.clock', 'set', args);
    rtc.sets.push(a);
    if (!rtc.dropWrites) {
      // The board answers at once and writes at the target; `set` fires only for a write that landed.
      const delayMs = Math.max(0, (Number(a.at_us) - node.nodeNowUs()) / 1000);
      setTimeout(() => node.event(PORT.clock, 2, enc('fr.clock', 'event', 'set', { unix: a.unix, by: a.by })), Number(a.at_us) === 0 ? 5 : delayMs);
    }
    return undefined;
  });
  node.handlers.set(`${PORT.clock}/${CL.set_aging}`, (args) => {
    rtc.aging = Number(dec('fr.clock', 'set_aging', args).offset);
    return undefined;
  });
  await node.connected(r.events);
  return b;
}

const call = (b: Board, op: keyof typeof HANDLERS, input: Record<string, unknown>) => Promise.resolve().then(() => HANDLERS[op](findOp(op)!.input.parse(input) as never, b.hub));
const job = async (b: Board, op: keyof typeof HANDLERS, input: Record<string, unknown>, s = 20): Promise<Job> => {
  const j = (await call(b, op, input)) as Job;
  return ['completed', 'failed', 'cancelled'].includes(j.status) ? j : b.r.jobs.wait(j.job_id, s);
};

describe('storage ops against a fake card (D9)', { timeout: 20_000 }, () => {
  it('info, mkdir, ls with paging, rm, and the refusals in the card\'s words', async () => {
    const b = await board();
    expect((await call(b, 'storage_info', { device: 'lcd-c6' })) as StorageInfo).toMatchObject({ device: DEV, instance: 'card', state: 'mounted', card_type: 'sdhc', total_mb: 30436, free_mb: 30400, name: 'SD32G', speed_khz: 20000 });
    await call(b, 'storage_mkdir', { device: 'lcd-c6', path: '/logs/2026' });
    for (let i = 0; i < 20; i++) {
      b.card.files.set(`/logs/f${String(i).padStart(2, '0')}.txt`, new Uint8Array(i));
    }
    const ls = (await call(b, 'storage_ls', { device: 'lcd-c6', path: '/logs' })) as StorageLs;
    expect(ls.entries).toHaveLength(21); // two pages: 16 + 5
    expect(ls.entries.filter((e) => e.dir).map((e) => e.name)).toEqual(['2026']);
    expect(ls.entries.find((e) => e.name === 'f07.txt')).toMatchObject({ size: 7, dir: false });
    expect(((await call(b, 'storage_ls', { device: 'lcd-c6' })) as StorageLs).entries.map((e) => e.name)).toEqual(['logs']);
    await call(b, 'storage_rm', { device: 'lcd-c6', path: '/logs/f00.txt' });
    expect(b.card.files.has('/logs/f00.txt')).toBe(false);
    await expect(call(b, 'storage_rm', { device: 'lcd-c6', path: '/nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(call(b, 'storage_ls', { device: 'lcd-c6', path: '/nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(call(b, 'storage_rm', { device: 'lcd-c6', path: '/' })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(call(b, 'storage_info', { device: 'lcd-c6', instance: 'clock' })).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('fr.clock, not fr.storage') });
  });

  it('a file there and back: put in chunks (the last short), get it identical; a smaller board chunk is found; BUSY is waited out', async () => {
    const b = await board();
    const dir = join(b.r.dir, 'up');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'song.bin');
    const data = benchPattern(7, 3 * 1024 + 300);
    writeFileSync(file, data);
    b.card.files.set('/song.bin', new Uint8Array(9000)); // a longer file there before: replaced, not overlaid
    b.card.chunk = 512;
    b.card.busy = 2;
    const put = await job(b, 'storage_put', { device: 'lcd-c6', file });
    expect(put.status, JSON.stringify(put.error)).toBe('completed');
    expect(put.result as StoragePut).toMatchObject({ card_path: '/song.bin', bytes: data.length, size: data.length, reason: 'done' });
    expect(b.card.files.get('/song.bin')).toEqual(data);
    expect(b.card.writes).toBe(Math.ceil(data.length / 512));
    const get = await job(b, 'storage_get', { device: 'lcd-c6', path: '/song.bin' });
    expect(get.status, JSON.stringify(get.error)).toBe('completed');
    const g = get.result as StorageGet;
    expect(g).toMatchObject({ card_path: '/song.bin', bytes: data.length, size: data.length, reason: 'done' });
    expect(g.path).toBe(join(process.env.FR_HOME!, 'storage', 'lcd-c6', 'song.bin'));
    expect(new Uint8Array(readFileSync(g.path))).toEqual(data);
    const missing = await job(b, 'storage_get', { device: 'lcd-c6', path: '/none.bin' });
    expect(missing.status).toBe('failed');
    expect(missing.error).toMatchObject({ code: 'NOT_FOUND' });
    b.card.dirs.add('/d');
    expect((await job(b, 'storage_get', { device: 'lcd-c6', path: '/d' })).error).toMatchObject({ code: 'INVALID_ARGS' });
    await expect(call(b, 'storage_put', { device: 'lcd-c6', file: 'relative.bin' })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(call(b, 'storage_put', { device: 'lcd-c6', file: join(dir, 'absent.bin') })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(call(b, 'storage_get', { device: 'lcd-c6', path: '/song.bin', out: '/tmp/elsewhere.bin' })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  });

  it('bench: identical and removed; a corrupted read is found at its offset; keep leaves the file', async () => {
    const b = await board();
    const ok = await job(b, 'storage_bench', { device: 'lcd-c6', mb: 0.0625, seed: 99 });
    expect(ok.status, JSON.stringify(ok.error)).toBe('completed');
    expect(ok.result as StorageBench).toMatchObject({ bytes: 65536, identical: true, mismatch_at: null, seed: 99, removed: true, reason: 'done', card_path: '/fr-bench.bin' });
    expect((ok.result as StorageBench).write_kb_s).toBeGreaterThan(0);
    expect((ok.result as StorageBench).read_kb_s).toBeGreaterThan(0);
    expect(b.card.files.has('/fr-bench.bin')).toBe(false);
    b.card.corruptAt = 40_000;
    const bad = await job(b, 'storage_bench', { device: 'lcd-c6', mb: 0.0625, seed: 99, keep: true, path: '/b/x.bin' });
    expect(bad.result as StorageBench).toMatchObject({ identical: false, mismatch_at: 40_000, removed: false });
    expect(b.card.files.get('/b/x.bin')).toEqual(benchPattern(99, 65536)); // the card holds the right bytes: the read was bad
  });
});

describe('clock ops against a fake RTC (D8)', { timeout: 20_000 }, () => {
  const synced = (b: Board) => until(() => routerProbe(b.hub.router)?.clock(DEV)?.synced(), 5000, 'the link clock');

  it('read: the time, valid, temperature, and an error_ms near 0 for an RTC in step with the Mac', async () => {
    const b = await board();
    await synced(b);
    const r = (await call(b, 'clock_read', { device: 'lcd-c6' })) as ClockRead;
    expect(r).toMatchObject({ device: DEV, instance: 'clock', valid: true, osf: false, temp_c: 24.5, aging: 0, injected: false });
    expect(Math.abs(r.unix - Math.floor(Date.now() / 1000))).toBeLessThanOrEqual(1);
    expect(r.iso).toBe(isoOf(r.unix));
    expect(Math.abs(r.error_ms!)).toBeLessThan(25);
    b.rtc.rtcMsAt = (w) => w + 1500; // 1.5 s ahead
    b.rtc.wallMsOf = (s) => s * 1000 - 1500;
    const ahead = (await call(b, 'clock_read', { device: 'lcd-c6' })) as ClockRead;
    expect(ahead.error_ms).toBeLessThan(-1450);
    expect(ahead.error_ms).toBeGreaterThan(-1550);
  });

  it('sync aims the next whole wall second through the link clock; set takes an ISO time; aging is sent', async () => {
    const b = await board();
    await synced(b);
    const s = (await call(b, 'clock_sync', { device: 'lcd-c6' })) as ClockSet;
    const sent = b.rtc.sets[0];
    expect(sent).toMatchObject({ unix: s.unix, by: 'sync' });
    expect(s.lead_ms).toBeGreaterThanOrEqual(600);
    expect(s.lead_ms).toBeLessThanOrEqual(1600);
    // at_us is the node time the wall second begins: from when the node got the command, about (unix s − now) ahead.
    const atUs = Number(sent.at_us);
    expect(atUs).toBe(s.at_us);
    const aheadMs = (atUs - b.rtc.setAt[0]) / 1000;
    expect(aheadMs).toBeGreaterThan(s.lead_ms - 100);
    expect(aheadMs).toBeLessThan(s.lead_ms + 5);
    const set = (await call(b, 'clock_set', { device: 'lcd-c6', iso: '2026-11-05T17:00:00+03:00' })) as ClockSet;
    expect(set).toMatchObject({ unix: Date.UTC(2026, 10, 5, 14) / 1000, iso: '2026-11-05T14:00:00Z', at_us: 0, by: 'command' });
    expect(b.rtc.sets[1]).toMatchObject({ unix: Date.UTC(2026, 10, 5, 14) / 1000, by: 'command' });
    await expect(call(b, 'clock_set', { device: 'lcd-c6', iso: '2026-11-05 14:00' })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(call(b, 'clock_set', { device: 'lcd-c6', iso: '2101-01-01T00:00:00Z' })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    expect(await call(b, 'clock_aging', { device: 'lcd-c6', offset: -7 })).toMatchObject({ offset: -7 });
    expect(b.rtc.aging).toBe(-7);
  });

  it('set fails when the board takes the command but never confirms the write (review row 3)', async () => {
    const b = await board();
    await synced(b);
    b.rtc.dropWrites = true;
    // A read after the set shows a second before the one asked (the write never landed).
    b.rtc.rtcMsAt = (w) => w - 3_600_000;
    b.rtc.wallMsOf = (s) => s * 1000 + 3_600_000;
    await expect(call(b, 'clock_set', { device: 'lcd-c6', iso: '2030-01-01T00:00:00Z' })).rejects.toMatchObject({ code: 'DELIVERY_FAILED' });
  });

  it('sync is DEVICE_BUSY while the link clock is not synced', async () => {
    const r = await otaRig();
    cleanups.push(() => r.close());
    r.registry.add({ device_id: DEV, addr: 0x52, alias: 'lcd-c6', provisioned: true, net: 0, chip: 'esp32c6' });
    const node = r.node({ mac: DEV, addr: 0x52, alias: 'lcd-c6' });
    node.answerTime = false;
    node.describeAs(CAPS);
    await node.connected(r.events);
    await expect(Promise.resolve().then(() => HANDLERS.clock_sync({ device: 'lcd-c6' } as never, r.hub))).rejects.toMatchObject({ code: 'DEVICE_BUSY' });
  });

  it('drift: samples a fast RTC, fits a positive ppm and suggests a positive aging step', async () => {
    const b = await board();
    await synced(b);
    // 5 % fast from now (absurd for a crystal, visible within a short test): rtc = t0 + (w − t0) × 1.05.
    const t0 = Date.now();
    const k = 1.05;
    b.rtc.rtcMsAt = (w) => t0 + (w - t0) * k;
    b.rtc.wallMsOf = (s) => t0 + (s * 1000 - t0) / k;
    setClockTiming(40); // a "second" of interval is 40 ms
    const d = await job(b, 'clock_drift', { device: 'lcd-c6', minutes: 1, interval_s: 1 });
    expect(d.status, JSON.stringify(d.error)).toBe('completed');
    const r = d.result as ClockDrift;
    expect(r.samples).toBeGreaterThan(20);
    expect(r.ppm).toBeGreaterThan(10_000);
    expect(r.aging).toBe(0);
    expect(r.aging_suggest).toBe(127); // clamped
    expect(r.reason).toBe('done');
  });
});
