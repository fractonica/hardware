// LOG frames over TCP into the log store (design m2-c2 D21; stream S5): a net_log FakeNode's lines through the
// router and the ingest into logs_read and wait_for_log; the cross-source dedup (one line over serial and TCP stored
// once, either copy first; a same-source repeat stored twice; a USB node whose TCP came back after 120 s; a line that
// was not UTF-8); TCP text kept from posing as a serial frame or a diag answer; a banner past the old 200 B limit;
// the per-device cap; t_log_us from the line's esp_log ms through the TIME sync (unwrapped past 2^32 ms, less how far
// the boot's esp_log runs ahead of esp_timer, never after its arrival), returned in LogLine, and the stale-line rule
// the waits apply with it; the dedup window counting only unmatched lines; the warning and hints for a device the
// hub hears over Wi-Fi alone.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { CLS, encodeSerialLine, FrError, type Header, SERIAL_TYPE } from '@fractonica/protocol';
import { encodeEnvelope } from '@fractonica/protocol/gen';

import type { HubContext } from '../src/context.ts';
import { type Db, openDb } from '../src/db.ts';
import { mintCursor, mintTimeUs } from '../src/events/index.ts';
import { SerialFrameTap } from '../src/links/serial.ts';
import { createLogIngest, LOG_AHEAD_MAX_US, type LogFrame, lineTimeUs, unwrapLogMs } from '../src/logs/ingest.ts';
import { DEDUP_MAX, DEDUP_MS, LogStore, staleNetLine, type StoredLine, toLogLine } from '../src/logstore.ts';
import { HANDLERS } from '../src/ops.ts';
import { type ClockView, NodeClock } from '../src/router/clock.ts';
import { createScaleCounters, type ScaleCounters, scaleWindows } from '../src/router/scale.ts';
import { type FakeNode, type Rig, rig, until } from './fake-node.ts';

let dir: string;
const cleanups: (() => unknown)[] = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'fr-log-ingest-'));
});
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const MAC = 'c6c6c6000042';

/** A store and its ingest on a clock the test moves (ms), as main.ts wires them. */
function unit(): { db: Db; logs: LogStore; scale: ScaleCounters; ingest: ReturnType<typeof createLogIngest>; clock: { ms: number } } {
  const db = openDb(join(dir, `hub-${Math.random().toString(36).slice(2)}.db`));
  const clock = { ms: 1_800_000_000_000 };
  const logs = new LogStore(db, 1, { retention: false, now: () => clock.ms });
  const scale = createScaleCounters();
  const ingest = createLogIngest(logs, scale);
  cleanups.push(() => {
    logs.close();
    db.close();
  });
  return { db, logs, scale, ingest, clock };
}

/** A node clock as the router's TIME sync has it: node µs = hub µs - `offsetUs` (synced unless said). */
function nodeClock(offsetUs: number, synced = true): ClockView {
  return {
    synced: () => synced,
    info: () => null,
    toNode: (hubUs: number) => hubUs - offsetUs,
    toHub: (nodeUs: number) => nodeUs + offsetUs,
    unwrap: (t: number) => t,
  } as unknown as ClockView;
}

/** One decoded LOG frame from `device`, as the router hands it to the ingest, arrived at `rxMs` (hub ms). */
function frame(device: string, text: string, rxMs: number, clock: ClockView = nodeClock(0, false), level = 3, epoch = 1): LogFrame {
  return { device, alias: 'pad', link: 'tcp', header: { epoch } as Header, level, line: { tag: 'app', text }, rx_us: rxMs * 1000, clock };
}

/** A real NodeClock synced by one burst at hub µs `hubUs`, when the node's esp_timer read `nodeUs`. */
function syncedClock(hubUs: number, nodeUs: number): NodeClock {
  const c = new NodeClock();
  c.addBurst([{ t1: hubUs - 100, t2: nodeUs, t3: nodeUs, t4: hubUs + 100 }]);
  return c;
}

const rows = (logs: LogStore, device = MAC): StoredLine[] => logs.query({ devices: [device], limit: 10_000, direction: 'forward' });
const texts = (logs: LogStore, device = MAC) => rows(logs, device).map((l) => l.text);

/** The hub as the op handlers get it, with log selectors resolved through the registry (no USB port). */
function opsHub(r: Rig): HubContext {
  const serial = {
    resolve: (sel: string) => {
      throw new FrError('NOT_FOUND', `no attached Espressif port matches ${sel}`);
    },
    list: () => [],
  };
  return { ...r.hub, serial } as unknown as HubContext;
}

async function netNode(r: Rig, alias = 'pad'): Promise<FakeNode> {
  r.registry.add({ device_id: MAC, addr: 42, alias, provisioned: true });
  const n = r.node({ mac: MAC, addr: 42, alias, netLog: true, autoHeartbeat: false });
  await n.connected(r.events);
  return n;
}

describe('LOG frames over TCP (design m2-c2 D21)', () => {
  it('stores them under the device with level, tag and port tcp, for logs_read by alias and wait_for_log', async () => {
    const r = await rig();
    cleanups.push(() => r.close());
    const node = await netNode(r);
    expect(r.router.info(MAC)?.hello_caps ?? 0).toBe((1 << 1) | (1 << 4) | (1 << 5) | (1 << 6));
    const hub = opsHub(r);
    const since = r.logs.head();
    node.log(node.logLine('ready id=c6c6c6000042 fw=0011223344aa', { tag: 'fr' }));
    node.log(node.logLine('disk almost full', { level: 'W', tag: 'store' }));
    await until(() => rows(r.logs).filter((l) => l.port === 'tcp').length === 2, 3000, 'two net lines');
    const read = (await HANDLERS.logs_read({ selector: 'pad', since, max_lines: 10, direction: 'forward' }, hub)) as {
      lines: { level?: string; tag?: string; port: string; kind: string; text: string }[];
    };
    expect(read.lines.filter((l) => l.port === 'tcp')).toMatchObject([
      { level: 'I', tag: 'fr', port: 'tcp', kind: 'esp_log', text: expect.stringMatching(/^I \(\d+\) fr: ready id=c6c6c6000042 fw=0011223344aa$/) },
      { level: 'W', tag: 'store', port: 'tcp', kind: 'esp_log', text: expect.stringContaining('disk almost full') },
    ]);
    // Each TCP line carries its own time on the hub clock (design m2-c2 D22's output), never after it arrived.
    for (const l of read.lines.filter((x) => x.port === 'tcp') as unknown as { ts: string; t_log_us?: number }[]) {
      expect(l.t_log_us).toEqual(expect.any(Number));
      expect(l.t_log_us!).toBeLessThanOrEqual(Date.parse(l.ts) * 1000 + 999);
      expect(l.t_log_us!).toBeGreaterThan(Date.parse(l.ts) * 1000 - 2_000_000);
    }
    expect(r.scale.log_frames).toBe(2);
    // The store's batched writes are timed into the router's windows (hub_status.router.scale.logs_flush_ms, D16).
    r.logs.flush();
    expect(scaleWindows(r.scale).logs_flush_ms.view().all.count).toBeGreaterThan(0);
    // A wait since a cursor matches a line that comes after it.
    const cursor = r.logs.head();
    const wait = HANDLERS.wait_for_log({ selector: 'pad', pattern: 'alive fw=', regex: false, since: cursor, count: 1, timeout_s: 3 }, hub) as Promise<{
      matches: { port: string; text: string }[];
    }>;
    node.log(node.logLine('alive fw=0011223344aa id=c6c6c6000042 uptime_s=10 heap=200000', { tag: 'fr' }));
    expect((await wait).matches).toMatchObject([{ port: 'tcp', text: expect.stringContaining('alive fw=0011223344aa'), t_log_us: expect.any(Number) }]);
    // A serial line has none: its arrival is its time.
    expect(toLogLine(r.logs.append(MAC, '/dev/cu.usbmodem1', 'I (1) app: over usb'))).not.toHaveProperty('t_log_us');
  });

  it('stores a banner longer than the old 200 B limit whole', async () => {
    const r = await rig();
    cleanups.push(() => r.close());
    const node = await netNode(r);
    // The C6 ready banner with long alias, board and version strings, plus built=: about 340 chars, a BULK frame.
    const banner = node.logLine(
      `ready id=${MAC} fw=0011223344aa state=provisioned addr=002a alias=a-rather-long-pad-alias-for-the-bench board=esp32c6-supermini-with-a-long-board-name profile=c6-pad part=fr-4mb-v1 app=node ver=1a2b3c4-dirty.0011223344aa idf=v6.1-dev-1234-gabcdef0123 reset=sw slot=ota_1 caps=4 epoch=17 built=2026-10-26T12:00:00Z`,
      { tag: 'fr' },
    );
    expect(banner.length).toBeGreaterThan(300);
    expect(banner.length).toBeLessThanOrEqual(384);
    node.log(banner);
    await until(() => rows(r.logs).some((l) => l.port === 'tcp'), 3000, 'the banner');
    expect(rows(r.logs).find((l) => l.port === 'tcp')).toMatchObject({ kind: 'esp_log', text: banner });
  });

  it('stores one line that came over serial and over TCP once, whichever came first, and counts the copy', () => {
    const { logs, scale, ingest, clock } = unit();
    // Serial first (the usual order: TCP waits for its session, its pace and its window).
    logs.append(MAC, '/dev/cu.usbmodem1', 'I (1000) fr: alive fw=aa');
    clock.ms += 400;
    ingest.frame(frame(MAC, 'I (1000) fr: alive fw=aa', clock.ms));
    // TCP first (a serial port read late): the serial copy is the one dropped.
    ingest.frame(frame(MAC, 'I (2000) fr: alive fw=bb', clock.ms));
    clock.ms += 50;
    const matched = logs.append(MAC, '/dev/cu.usbmodem1', 'I (2000) fr: alive fw=bb');
    expect(matched).toMatchObject({ port: 'tcp', text: 'I (2000) fr: alive fw=bb' }); // the copy already stored
    expect(rows(logs).map((l) => [l.port, l.text])).toEqual([
      ['/dev/cu.usbmodem1', 'I (1000) fr: alive fw=aa'],
      ['tcp', 'I (2000) fr: alive fw=bb'],
    ]);
    expect(scale).toMatchObject({ log_frames: 2, logs_dup: 2 });
    expect(logs.dups()).toBe(2);
    // Another device's line of the same text is its own.
    logs.append('c6c6c6000043', '/dev/cu.usbmodem2', 'I (1000) fr: alive fw=aa');
    expect(texts(logs, 'c6c6c6000043')).toEqual(['I (1000) fr: alive fw=aa']);
    // Past 60 s a copy has nothing left to match: stored.
    logs.append(MAC, '/dev/cu.usbmodem1', 'I (3000) fr: late');
    clock.ms += DEDUP_MS + 1;
    ingest.frame(frame(MAC, 'I (3000) fr: late', clock.ms));
    expect(texts(logs).filter((t) => t.endsWith('late'))).toHaveLength(2);
  });

  it('stores a same-source repeat twice: identical serial lines, a quick reboot\'s identical bootloader lines', () => {
    const { logs, scale, ingest, clock } = unit();
    // The bootloader prints the same lines, ms stamps included, on every boot; two boots within 60 s.
    const boot = ['I (27) boot: ESP-IDF v6.1 2nd stage bootloader', 'I (27) boot: compile time Oct 26 2026 12:00:00'];
    for (let i = 0; i < 2; i++) {
      for (const l of boot) {
        logs.append(MAC, '/dev/cu.usbmodem1', l);
      }
      clock.ms += 5000;
    }
    expect(texts(logs)).toEqual([...boot, ...boot]);
    // Two lines with one text and one ms stamp over TCP: both stored.
    ingest.frame(frame(MAC, 'I (500) app: tick', clock.ms));
    ingest.frame(frame(MAC, 'I (500) app: tick', clock.ms));
    expect(texts(logs).filter((t) => t === 'I (500) app: tick')).toHaveLength(2);
    // Each serial copy consumes one net copy, never more: a third one is a line of its own.
    logs.append(MAC, '/dev/cu.usbmodem1', 'I (500) app: tick');
    logs.append(MAC, '/dev/cu.usbmodem1', 'I (500) app: tick');
    logs.append(MAC, '/dev/cu.usbmodem1', 'I (500) app: tick');
    expect(texts(logs).filter((t) => t === 'I (500) app: tick')).toHaveLength(3);
    expect(scale.logs_dup).toBe(2);
    // Lines of another shape are never deduplicated (only esp_log lines reach the node's ring).
    logs.append(MAC, '/dev/cu.usbmodem1', 'ESP-ROM:esp32c6-20220919');
    ingest.frame(frame(MAC, 'ESP-ROM:esp32c6-20220919', clock.ms));
    expect(texts(logs).filter((t) => t.startsWith('ESP-ROM'))).toHaveLength(2);
  });

  it('stores each line once for a USB node whose TCP was down for 120 s', () => {
    const { logs, scale, ingest, clock } = unit();
    const t0 = clock.ms;
    const line = (i: number) => `I (${10_000 + i * 1000}) app: tick ${i}`;
    // One line a second over USB; TCP is down for the first 120 s.
    for (let i = 0; i <= 120; i++) {
      clock.ms = t0 + i * 1000;
      logs.append(MAC, '/dev/cu.usbmodem1', line(i));
    }
    // TCP back and settled at 121 s: the node's ring sends what is at most 30 s old (it dropped the rest).
    clock.ms = t0 + 121_000;
    for (let i = 91; i <= 120; i++) {
      ingest.frame(frame(MAC, line(i), clock.ms));
    }
    // From then on each line comes both ways, TCP a little later.
    for (let i = 121; i <= 180; i++) {
      clock.ms = t0 + i * 1000;
      logs.append(MAC, '/dev/cu.usbmodem1', line(i));
      clock.ms += 60;
      ingest.frame(frame(MAC, line(i), clock.ms));
    }
    const got = texts(logs);
    expect(got).toHaveLength(181);
    expect(new Set(got).size).toBe(181);
    expect(scale.logs_dup).toBe(30 + 60);
  });

  it('dedups a serial and a net copy of one line that was not UTF-8', () => {
    const { logs, scale, ingest, clock } = unit();
    // The bytes esp_log printed: a Latin-1 é, a stray 0xFF, a cut 2-byte sequence at the end.
    const bytes = Buffer.concat([Buffer.from('I (77) app: caf'), Buffer.from([0xe9, 0x20, 0xff, 0x20, 0xc3])]);
    // The serial copy as SerialPortManager decodes its chunks; the net copy as the node sanitizes it (WHATWG's
    // U+FFFD per maximal subpart, which net_log_test.cpp checks on the node with the same vectors).
    const serial = new StringDecoder('utf8').write(Buffer.concat([bytes, Buffer.from('\n')])).split('\n')[0];
    const net = new TextDecoder('utf-8').decode(bytes);
    expect(net).toBe('I (77) app: caf� � �');
    expect(serial).toBe(net);
    logs.append(MAC, '/dev/cu.usbmodem1', serial);
    ingest.frame(frame(MAC, net, clock.ms));
    expect(texts(logs)).toEqual([net]);
    expect(scale.logs_dup).toBe(1);
    // Unicode's table 3-8 and the node's other vectors decode on the hub as the node's sanitizer writes them.
    const R = '�';
    expect(new TextDecoder().decode(Buffer.from([0x61, 0xf1, 0x80, 0x80, 0xe1, 0x80, 0xc2, 0x62, 0x80, 0x63, 0x80, 0xbf, 0x64]))).toBe(`a${R}${R}${R}b${R}c${R}${R}d`);
    expect(new TextDecoder().decode(Buffer.from([0xed, 0xa0, 0x80, 0x7c, 0xe0, 0x80, 0x80, 0x7c, 0xe2, 0x82]))).toBe(`${R}${R}${R}|${R}${R}${R}|${R}`);
    const sd = new StringDecoder('utf8');
    expect(sd.write(Buffer.from([0x61, 0xf1, 0x80, 0x80, 0xe1, 0x80, 0xc2, 0x62, 0x80, 0x63, 0x80, 0xbf, 0x64, 0x0a]))).toBe(`a${R}${R}${R}b${R}c${R}${R}d\n`);
  });

  it('never lets TCP text pose as a serial frame, a boot line or a diag answer', () => {
    const db = openDb(join(dir, `hub-${Math.random().toString(36).slice(2)}.db`));
    const tap = new SerialFrameTap(db);
    const tapped: string[] = [];
    tap.attach((_device, line) => tapped.push(line));
    const logs = new LogStore(db, 1, { retention: false, frames: tap });
    const ingest = createLogIngest(logs, createScaleCounters());
    cleanups.push(() => {
      logs.close();
      db.close();
    });
    const header = { flags: 0, cls: CLS.EVENT, kind: 1, seq: 1, net: 0, src: 42, dst: 0, epoch: 1, ttl: 0x22, port: 1 };
    const env = encodeSerialLine(SERIAL_TYPE.ENV, encodeEnvelope({ header, prefix: { type: 'time', t_us: 5 }, body: new Uint8Array(0) }));
    const diags: StoredLine[] = [];
    logs.subscribe((l) => l.kind === 'diag' && diags.push(l));
    for (const text of [env, '#12 {"ok":true}', 'ESP-ROM:esp32c6-20220919']) {
      ingest.frame(frame(MAC, text, Date.now()));
    }
    expect(rows(logs).map((l) => [l.kind, l.text])).toEqual([
      ['raw', env],
      ['raw', '#12 {"ok":true}'],
      ['raw', 'ESP-ROM:esp32c6-20220919'],
    ]);
    return new Promise<void>((resolve) =>
      queueMicrotask(() => {
        expect(tapped).toEqual([]); // the serial link never saw the TCP `@fr1:` text
        expect(diags).toEqual([]); // and no diag wait could take `#12 {...}` for its answer
        // The same lines from a USB port are what they say.
        logs.append(MAC, '/dev/cu.usbmodem1', '#12 {"ok":true}');
        logs.append(MAC, '/dev/cu.usbmodem1', env);
        queueMicrotask(() => {
          expect(diags.map((l) => l.text)).toEqual(['#12 {"ok":true}']);
          expect(tapped).toEqual([env]);
          resolve();
        });
      }),
    );
  });

  it('caps each device at 50 lines/s and counts the excess', () => {
    const { logs, scale, ingest, clock } = unit();
    for (let i = 0; i < 60; i++) {
      ingest.frame(frame(MAC, `I (${i}) app: burst ${i}`, clock.ms));
    }
    ingest.frame(frame('c6c6c6000043', 'I (1) app: another device', clock.ms));
    expect(rows(logs)).toHaveLength(50);
    expect(texts(logs, 'c6c6c6000043')).toHaveLength(1);
    expect(scale).toMatchObject({ log_frames: 61, log_dropped: 10 });
    // A second later the bucket is full again.
    for (let i = 0; i < 60; i++) {
      ingest.frame(frame(MAC, `I (${2000 + i}) app: next ${i}`, clock.ms + 1000));
    }
    expect(rows(logs)).toHaveLength(100);
    expect(scale.log_dropped).toBe(20);
  });

  it("stamps t_log_us from the line's esp_log ms through the TIME sync, null while unsynced", () => {
    const { logs, ingest, clock } = unit();
    const offsetUs = clock.ms * 1000 - 5_000_000; // the node booted 5 s ago on the hub clock
    ingest.frame(frame(MAC, 'I (4200) app: synced', clock.ms, nodeClock(offsetUs)));
    ingest.frame(frame(MAC, 'I (4300) app: unsynced', clock.ms, nodeClock(offsetUs, false)));
    ingest.frame(frame(MAC, 'no esp_log shape', clock.ms, nodeClock(offsetUs)));
    logs.append(MAC, '/dev/cu.usbmodem1', 'I (4400) app: serial');
    expect(rows(logs).map((l) => [l.text, l.t_log_us])).toEqual([
      ['I (4200) app: synced', offsetUs + 4_200_000],
      ['I (4300) app: unsynced', null],
      ['no esp_log shape', null],
      ['I (4400) app: serial', null],
    ]);
    expect(rows(logs)[0]).toMatchObject({ port: 'tcp', ts_us: clock.ms * 1000 });
    // Never later than it arrived: a stamp past the arrival (an esp_log clock ahead of esp_timer) is the arrival.
    expect(lineTimeUs('W (12) x: y', nodeClock(1000), 20_000)).toBe(13_000);
    expect(lineTimeUs('W (12) x: y', nodeClock(1000), 12_500)).toBe(12_500);
    expect(lineTimeUs('W (12) x: y', nodeClock(1000), 20_000, 400)).toBe(12_600);
    expect(lineTimeUs(`W (${2 ** 32}) x: y`, nodeClock(1000), 20_000)).toBeNull(); // no u32 holds it
  });

  it('marks a net line logged more than 1 s before a cursor as stale for the waits', async () => {
    const r = await rig();
    cleanups.push(() => r.close());
    const hub = opsHub(r);
    const since = mintCursor(hub);
    const seq = Number(since.split('.')[1]);
    const mint = mintTimeUs(hub, seq);
    expect(staleNetLine({ t_log_us: mint - 1_500_000 }, mint)).toBe(true); // a backlog line from before the cursor
    expect(staleNetLine({ t_log_us: mint - 500_000 }, mint)).toBe(false); // within the clocks' slack
    expect(staleNetLine({ t_log_us: null }, mint)).toBe(false); // serial lines, unsynced net lines
  });

  // wait_for_log (ops.ts) and logs_assert (logs/ops.ts) skip staleNetLine(l, mintTimeUs(hub, since)) (design m2-c2 D21).
  it('wait_for_log since a cursor does not take a backlog line logged before it', async () => {
    const r = await rig();
    cleanups.push(() => r.close());
    const node = await netNode(r);
    const hub = opsHub(r);
    await until(() => r.router.info(MAC)?.clock, 3000, 'the TIME sync');
    const before = node.logLine('ready id=old-boot');
    await new Promise((res) => setTimeout(res, 1500));
    const since = mintCursor(hub); // as an op hands it out, so the wait knows when it was minted
    const wait = HANDLERS.wait_for_log({ selector: 'pad', pattern: 'ready id=', regex: false, since, count: 1, timeout_s: 2 }, hub) as Promise<{ matches: { text: string }[] }>;
    node.log(before); // the backlog: logged 1.5 s before the cursor, sent after it
    node.log(node.logLine('ready id=new-boot'));
    expect((await wait).matches.map((m) => m.text)).toEqual([expect.stringContaining('new-boot')]);
  });

  it('logs_assert since a cursor neither expects nor forbids a backlog line logged before it', async () => {
    const r = await rig();
    cleanups.push(() => r.close());
    const node = await netNode(r);
    const hub = opsHub(r);
    await until(() => r.router.info(MAC)?.clock, 3000, 'the TIME sync');
    const stale = node.logLine('Guru Meditation Error: old boot');
    const old = node.logLine('ready id=old-boot');
    await new Promise((res) => setTimeout(res, 1500));
    const since = mintCursor(hub);
    const assert = HANDLERS.logs_assert(
      { selector: 'pad', since, expect: ['ready id='], forbid: ['Guru Meditation'], regex: false, timeout_s: 2 },
      hub,
    ) as Promise<{ matched: { text: string }[]; forbidden: unknown[] }>;
    node.log(stale); // backlog from before the cursor: not a new crash
    node.log(old); // nor the line the assertion waits for
    node.log(node.logLine('ready id=new-boot'));
    const res = await assert;
    expect(res.forbidden).toEqual([]);
    expect(res.matched.map((m) => m.text)).toEqual([expect.stringContaining('new-boot')]);
  });
});

describe("t_log_us: a net line's own time (design m2-c2 D21)", () => {
  const H = 1_800_000_000_000_000; // hub µs

  it('unwraps the u32 esp_log ms against the node clock: after 49.7 days of uptime a live line is not stale', () => {
    const { logs, ingest } = unit();
    const wrap = 2 ** 32; // ms
    // Synced at node uptime 2^32 ms + 5 s; the line `I (5000)` logged then arrives 10 ms later.
    const clock = syncedClock(H, (wrap + 5000) * 1000);
    ingest.frame(frame(MAC, 'I (5000) app: hello', (H + 10_000) / 1000, clock));
    const [l] = rows(logs);
    expect(l.t_log_us).toBe(H);
    expect(staleNetLine(l, H - 500_000)).toBe(false); // a cursor taken half a second before: a new line
    // Just before the wrap, and a line logged before it that arrives after it.
    expect(lineTimeUs(`I (${wrap - 3005}) app: x`, syncedClock(H, (wrap - 3000) * 1000), H + 1000)).toBe(H - 5000);
    expect(lineTimeUs(`I (${wrap - 100}) app: x`, syncedClock(H, (wrap + 200) * 1000), H + 1000)).toBe(H - 300_000);
    // A stamp just past the wrap while esp_timer has not reached it (esp_log runs ahead): no earlier than arrival.
    expect(lineTimeUs('I (200) app: x', syncedClock(H, (wrap - 100) * 1000), H)).toBe(H);
    // The unwrap itself, in RFC 1982 order around the node's now.
    expect(unwrapLogMs(5000, wrap + 5010)).toBe(wrap + 5000);
    expect(unwrapLogMs(wrap - 100, wrap + 200)).toBe(wrap - 100);
    expect(unwrapLogMs(200, wrap - 100)).toBe(wrap + 200);
    expect(unwrapLogMs(1000, 1500)).toBe(1000);
  });

  it("takes off how far the boot's esp_log runs ahead of esp_timer, learnt from live lines, per boot epoch", () => {
    const { logs, ingest } = unit();
    const boot = H - 100_000_000; // the node booted 100 s ago on the hub clock
    const clock = nodeClock(boot); // its esp_timer: node µs = hub µs - boot
    /** The line esp_log prints at hub µs `at` when its stamp runs `aheadMs` ahead of esp_timer. */
    const line = (at: number, aheadMs: number, msg: string) => `I (${Math.floor((at - boot) / 1000) + aheadMs}) app: ${msg}`;
    const t = (msg: string) => rows(logs).find((l) => l.text.endsWith(msg))!.t_log_us!;

    // A live line (5 ms on the way): its stamp lies 395 ms past its arrival; it is stamped its arrival.
    ingest.frame(frame(MAC, line(H, 400, 'live'), (H + 5000) / 1000, clock, 3, 7));
    expect(t('live')).toBe(H + 5000);
    // A backlog line logged 20 s ago: its own time within the live line's 5 ms, not 400 ms late.
    ingest.frame(frame(MAC, line(H - 20_000_000, 400, 'backlog'), (H + 6000) / 1000, clock, 3, 7));
    expect(t('backlog')).toBe(H - 20_000_000 + 5000);
    // So a line logged 1.2 s before a cursor is stale, as the waits need (taken 400 ms late, it was not).
    ingest.frame(frame(MAC, line(H - 1_200_000, 400, 'before cursor'), (H + 7000) / 1000, clock, 3, 7));
    expect(staleNetLine({ t_log_us: t('before cursor') }, H)).toBe(true);
    expect(staleNetLine({ t_log_us: t('before cursor') + 395_000 }, H)).toBe(false);

    // The next boot (epoch 8) runs 200 ms ahead: the last boot's 395 ms is not carried over.
    const boot2 = H + 10_000_000;
    const clock2 = nodeClock(boot2);
    const line2 = (at: number, msg: string) => `I (${Math.floor((at - boot2) / 1000) + 200}) app: ${msg}`;
    ingest.frame(frame(MAC, line2(H + 15_000_000, 'live 2'), (H + 15_005_000) / 1000, clock2, 3, 8));
    ingest.frame(frame(MAC, line2(H + 12_000_000, 'backlog 2'), (H + 15_006_000) / 1000, clock2, 3, 8));
    expect(t('live 2')).toBe(H + 15_005_000);
    expect(t('backlog 2')).toBe(H + 12_000_000 + 5000);

    // A sample past LOG_AHEAD_MAX_US (a poor sync) counts as that much and no more.
    ingest.frame(frame('c6c6c6000043', line(H, 3000, 'far ahead'), H / 1000, clock, 3, 1));
    ingest.frame(frame('c6c6c6000043', line(H - 10_000_000, 3000, 'far backlog'), H / 1000, clock, 3, 1));
    const far = rows(logs, 'c6c6c6000043').find((l) => l.text.endsWith('far backlog'))!;
    expect(far.t_log_us).toBe(H - 10_000_000 + 3_000_000 - LOG_AHEAD_MAX_US);
    // Never later than the arrival, whatever the estimate.
    for (const l of [...rows(logs), ...rows(logs, 'c6c6c6000043')]) {
      expect(l.t_log_us!).toBeLessThanOrEqual(l.ts_us);
    }
  });
});

describe('the cross-source dedup window (design m2-c2 D21)', () => {
  const USB = '/dev/cu.usbmodem1';

  it('pairs net copies that come after more than 512 newer serial lines, within 30 s', () => {
    const { logs, scale, ingest, clock } = unit();
    const t0 = clock.ms;
    // A TCP stall: 600 serial lines in 25 s, then the net ring's copies of the first 50 go out under its 30 s limit.
    for (let i = 0; i < 600; i++) {
      clock.ms = t0 + Math.floor((i * 25_000) / 600);
      logs.append(MAC, USB, `I (${1000 + i}) app: line ${i}`);
    }
    clock.ms = t0 + 29_000;
    for (let i = 0; i < 50; i++) {
      ingest.frame(frame(MAC, `I (${1000 + i}) app: line ${i}`, clock.ms));
    }
    expect(rows(logs)).toHaveLength(600);
    expect(scale.logs_dup).toBe(50);
  });

  it('counts only unmatched lines against the cap: matched pairs and lines that never come over TCP do not push one out', () => {
    const { logs, scale, ingest, clock } = unit();
    // One line waiting for its late TCP copy, then 600 lines paired at once, then 2000 D lines (USB only).
    logs.append(MAC, USB, 'I (10) app: waiting');
    for (let i = 0; i < 600; i++) {
      logs.append(MAC, USB, `I (${100 + i}) app: paired ${i}`);
      ingest.frame(frame(MAC, `I (${100 + i}) app: paired ${i}`, clock.ms + i * 20));
    }
    for (let i = 0; i < 2000; i++) {
      logs.append(MAC, USB, `D (${1000 + i}) app: debug ${i}`);
    }
    clock.ms += 20_000;
    ingest.frame(frame(MAC, 'I (10) app: waiting', clock.ms + 20_000));
    expect(texts(logs).filter((t) => t.endsWith('waiting'))).toHaveLength(1);
    expect(scale.logs_dup).toBe(601);
  });

  it('still bounds the unmatched lines it keeps at DEDUP_MAX, oldest out first', () => {
    const { logs, scale, ingest, clock } = unit();
    for (let i = 0; i < DEDUP_MAX + 10; i++) {
      logs.append(MAC, USB, `D (${i}) app: n ${i}`);
    }
    ingest.frame(frame(MAC, 'D (0) app: n 0', clock.ms)); // pushed out: stored again
    ingest.frame(frame(MAC, 'D (10) app: n 10', clock.ms)); // the oldest kept: paired
    expect(rows(logs)).toHaveLength(DEDUP_MAX + 11);
    expect(scale.logs_dup).toBe(1);
  });
});

describe('a device heard over Wi-Fi alone (design m2-c2 D21)', () => {
  it('logs_assert warns that its forbid checked only what TCP carries, and names the crash check that works', async () => {
    const r = await rig();
    cleanups.push(() => r.close());
    const node = await netNode(r);
    const hub = opsHub(r);
    const since = mintCursor(hub);
    node.log(node.logLine('ready id=c6c6c6000042 reset=SW', { tag: 'fr' }));
    const res = (await HANDLERS.logs_assert({ selector: 'pad', since, expect: ['ready id='], forbid: ['Guru Meditation'], regex: false, timeout_s: 3 }, hub)) as {
      warnings?: string[];
    };
    expect(res.warnings).toEqual([expect.stringMatching(/^pad: .*panic, abort and assert output.* come only over USB.*"Guru Meditation".*reset=PANIC.*node\.boot$/)]);
    // Without a forbid there is nothing it could have missed.
    const plain = (await HANDLERS.logs_assert({ selector: 'pad', since, expect: ['ready id='], regex: false, timeout_s: 3 }, hub)) as { warnings?: string[] };
    expect(plain).not.toHaveProperty('warnings');
    // An expectation that times out says what never arrives over TCP; so does wait_for_log.
    await expect(HANDLERS.logs_assert({ selector: 'pad', since, expect: ['boot: ESP-IDF'], regex: false, timeout_s: 1 }, hub)).rejects.toMatchObject({
      code: 'ASSERTION_FAILED',
      hint: expect.stringMatching(/^pad: .*ROM and bootloader lines and D\/V lines come only over USB$/),
    });
    await expect(HANDLERS.wait_for_log({ selector: 'pad', pattern: 'boot: ESP-IDF', regex: false, since, count: 1, timeout_s: 1 }, hub)).rejects.toMatchObject({
      code: 'TIMEOUT',
      hint: expect.stringContaining('come only over USB'),
    });
  });
});
