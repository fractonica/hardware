// LOG over TCP end to end (design m2-c2 §5.1, I1; D20, D21): the C++ fr_net_node with the kit's log source
// (`--net-log 1`) against a real hub process (real-hub.ts) whose USB ports are a VirtualUsb (the hub's
// --serial-bridge). A node's `log <L> <tag> <text>` line reaches logs_read, wait_for_log and logs_assert:
// - without --serial, as LOG frames over TCP only (port `tcp`, level and tag parsed, its own time `t_log_us`), with
//   the fr_core banner the node logged at boot sent as backlog once the session settled; logs_assert's forbid on it
//   warns that a panic never comes that way;
// - with --serial, both ways at once (fr_serial's USB copy, which the hub's serial port manager stores, and the LOG
//   frame): the hub stores the line once and counts the other copy in router.scale.logs_dup.
// `node tools/host-test.mjs` builds fr_net_node; without it (or without --net-log) the suite skips.

import { existsSync, readFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BIN, CppNode } from './cpp-node.ts';
import { type RealHub, startRealHub } from './real-hub.ts';
import { VirtualUsb } from './virtual-usb.ts';

const HAS_NET_LOG = existsSync(BIN) && readFileSync(BIN).includes('--net-log');

const TCP_ONLY = { mac: '58e6c5b1d201', alias: 'log-tcp' };
const DUAL = { mac: '58e6c5b1d202', alias: 'log-usb' };

interface LogLine {
  cursor: string;
  ts: string;
  device: string;
  port: string;
  level?: string;
  tag?: string;
  kind: string;
  text: string;
  /** A tcp line's own time on the hub clock (design m2-c2 D21, D22). */
  t_log_us?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!HAS_NET_LOG)('LOG over TCP: fr_net_node --net-log into a real hub (design m2-c2 D20, D21)', () => {
  let h: RealHub;
  let usb: VirtualUsb;
  const nodes: CppNode[] = [];

  /** A node over TCP and UDP with the kit's log source; `serial` adds its USB line on the virtual hub. */
  function logNode(d: { mac: string; alias: string }, serial: boolean): CppNode {
    const node = new CppNode([
      '--hub-tcp', String(h.node.tcp),
      '--hub-udp', String(h.node.udp),
      '--mac', d.mac,
      '--addr', String(h.addrs.get(d.mac)),
      '--net', '42',
      '--alias', d.alias,
      '--epoch', '3',
      '--hb-ms', '500',
      '--net-log', '1',
      ...(serial ? ['--serial', '1'] : []),
    ]);
    nodes.push(node);
    if (serial) {
      usb.attachNode(node, d.mac);
    }
    return node;
  }

  const read = async (selector: string, since: string) =>
    (await h.api.ok<{ lines: LogLine[]; next_cursor: string }>('logs_read', { selector, since, max_lines: 500, direction: 'forward' })).lines;
  const scale = async () => (await h.api.ok<{ router: { scale: { log_frames: number; logs_dup: number; log_dropped: number } } }>('hub_status', {})).router.scale;
  /** A fresh cursor as an op hands it out (logs_read's next_cursor), so a wait since it knows when it was minted. */
  const cursor = async (selector: string) =>
    (await h.api.ok<{ next_cursor: string }>('logs_read', { selector, max_lines: 1, direction: 'tail' })).next_cursor;

  beforeAll(async () => {
    usb = await VirtualUsb.open();
    h = await startRealHub({ devices: [TCP_ONLY, DUAL], serialBridge: usb.address });
  }, 120_000);

  afterAll(async () => {
    nodes.forEach((n) => n.stop());
    expect(await h?.stop()).toBe(0);
    await usb?.close();
  }, 30_000);

  it('sends a TCP-only node’s lines as LOG frames: its boot banner as backlog, then a `log` line, stored once as port tcp', async () => {
    const node = logNode(TCP_ONLY, false);
    await h.api.ok('wait_for_device', { selector: TCP_ONLY.alias, timeout_s: 30 }, 40_000);
    // The banner fr_core logs at boot goes out once the session settled (its TIME burst and get_state, or 3 s).
    let banner: LogLine | undefined;
    const end = Date.now() + 20_000;
    while (!banner && Date.now() < end) {
      const all = (await h.api.ok<{ lines: LogLine[] }>('logs_read', { selector: TCP_ONLY.alias, max_lines: 200, direction: 'tail' })).lines;
      banner = all.find((l) => l.port === 'tcp' && l.text.includes(`ready id=${TCP_ONLY.mac}`));
      if (!banner) {
        await sleep(100);
      }
    }
    expect(banner, 'the ready banner over TCP').toMatchObject({ port: 'tcp', level: 'I', tag: 'fr', kind: 'esp_log', text: expect.stringMatching(/^I \(\d+\) fr: ready id=58e6c5b1d201 fw=[0-9a-f]{12} /) });

    // A `log` line after a cursor: wait_for_log matches it, logs_assert finds it, logs_read shows it once.
    const before = await scale();
    const since = await cursor(TCP_ONLY.alias);
    const wait = h.api.ok<{ matches: LogLine[] }>('wait_for_log', { selector: TCP_ONLY.alias, pattern: 'hello over tcp', since, count: 1, timeout_s: 15 }, 20_000);
    node.send('log W app hello over tcp');
    const got = await wait;
    expect(got.matches).toMatchObject([{ port: 'tcp', level: 'W', tag: 'app', kind: 'esp_log', text: expect.stringMatching(/^W \(\d+\) app: hello over tcp$/) }]);
    // Its own time: the node's ms stamp through the session's TIME sync, a little before it reached the hub.
    const own = got.matches[0].t_log_us!;
    expect(own).toEqual(expect.any(Number));
    expect(own).toBeLessThanOrEqual(Date.parse(got.matches[0].ts) * 1000 + 999);
    expect(own).toBeGreaterThan(Date.parse(got.matches[0].ts) * 1000 - 5_000_000);
    // Heard over Wi-Fi alone: the forbid could not have seen a panic, and the result says so.
    const asserted = await h.api.ok<{ warnings?: string[] }>(
      'logs_assert',
      { selector: TCP_ONLY.alias, since, expect: ['hello over tcp'], forbid: ['Guru Meditation'], timeout_s: 5 },
      10_000,
    );
    expect(asserted.warnings).toEqual([expect.stringMatching(new RegExp(`^${TCP_ONLY.alias}: .*come only over USB.*reset=PANIC`))]);
    expect((await read(TCP_ONLY.alias, since)).filter((l) => l.text.includes('hello over tcp'))).toHaveLength(1);
    const after = await scale();
    expect(after.log_frames - before.log_frames).toBeGreaterThanOrEqual(1);
    expect(after.logs_dup - before.logs_dup).toBe(0); // no other source for this node
    expect(after.log_dropped).toBe(0);
  }, 90_000);

  it('stores a USB-and-TCP node’s line once, whichever copy comes first, and counts the other as logs_dup', async () => {
    const node = logNode(DUAL, true);
    await h.api.ok('wait_for_device', { selector: DUAL.alias, timeout_s: 30 }, 40_000);
    // The hub holds the virtual port open (so the serial copy is stored) and the TCP session's drain has settled.
    const end = Date.now() + 20_000;
    let held = false;
    while (!held && Date.now() < end) {
      const ports = await h.api.ok<{ ports: { device_id?: string; state: string }[] }>('port_list', {});
      held = ports.ports.some((p) => p.device_id === DUAL.mac && p.state === 'open');
      if (!held) {
        await sleep(100);
      }
    }
    expect(held, 'the hub holds the node’s USB port').toBe(true);
    const settled = await cursor(DUAL.alias);
    node.send('log I app settle');
    await h.api.ok('wait_for_log', { selector: DUAL.alias, pattern: 'app: settle', since: settled, count: 1, timeout_s: 15 }, 20_000);
    // Let the second copy of `settle` arrive before the counted line.
    const t0 = Date.now();
    let s0 = await scale();
    while (s0.logs_dup < 1 && Date.now() - t0 < 10_000) {
      await sleep(100);
      s0 = await scale();
    }

    const since = await cursor(DUAL.alias);
    node.send('log I app hello both ways');
    await h.api.ok('wait_for_log', { selector: DUAL.alias, pattern: 'hello both ways', since, count: 1, timeout_s: 15 }, 20_000);
    // The second copy: over TCP after the drain's pacing, or over USB if TCP was first.
    const t1 = Date.now();
    let s1 = await scale();
    while (s1.logs_dup < s0.logs_dup + 1 && Date.now() - t1 < 10_000) {
      await sleep(100);
      s1 = await scale();
    }
    expect(s1.logs_dup - s0.logs_dup).toBe(1);
    const lines = (await read(DUAL.alias, since)).filter((l) => l.text.includes('hello both ways'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'I', tag: 'app', kind: 'esp_log', text: expect.stringMatching(/^I \(\d+\) app: hello both ways$/) });
    expect(['tcp', `/dev/cu.usbmodem-fr-${DUAL.mac}`]).toContain(lines[0].port);
    // The USB copy went to the virtual port (onSerial), not into the node's JSON lines.
    expect(node.lines.some((l) => l.ev === 'text' && String(l.text).includes('hello both ways'))).toBe(false);
  }, 90_000);
});
