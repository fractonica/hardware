// CSI-1 on loopback (design csi-c1 D11-D13, §7 gate 3 host side): build/host-tests/fr_net_node's fake CSI source
// (stream F's flag, `--csi sine[:<bpm>]` (a breathing-modulated fake) or `--csi walk`; FR_CSI_NODE_ARGS overrides the flag and its
// value, e.g. `--csi router`) against the hub's csi_stream and /app/stream: the board's own fr_stream engine and csi1
// framing on the Mac. A 3 s stream: records arrive in whole csi1 blocks with consecutive seq, the hub's drop count
// agrees with the board's, the .csi file reads back block for block, and an SDK subscriber on /app/stream gets every
// block in order. Without the binary, or without the flag (before stream F), the suite skips.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { CsiStream, Job } from '@fractonica/protocol';
import { type CsiBlock, connect, parseCsiFile } from '@fractonica/sdk';

import { createAppServer } from '../src/apps/server.ts';
import type { HubContext, HubRunOptions, StaticSite, WsServer } from '../src/context.ts';
import { buildServer } from '../src/http.ts';
import { HANDLERS } from '../src/ops.ts';
import { BIN, CppNode } from './cpp-node.ts';
import { otaRig, until, waitForEvent } from './fake-node.ts';

const CSI_ARGS = (process.env.FR_CSI_NODE_ARGS ?? '--csi sine').split(/\s+/).filter(Boolean);
/** Stream F's fr_net_node takes the fake CSI source flag. */
const CSI = existsSync(BIN) && readFileSync(BIN).includes(CSI_ARGS[0]);
const MAC = '58e6c5d55e72';
const ALIAS = 'csi-host';
const TOKEN = 'test-token-0123456789abcdef0123456789';
const RUN: HubRunOptions = { apiHost: '127.0.0.1', apiPort: 0, nodeHost: '127.0.0.1', nodePort: 0, nodeHttpPort: 0, noAdvert: true, serial: false };
const NOOP: WsServer & StaticSite = { start() {}, stop() {}, routes() {}, dashboard: () => ({ url: '', built: false, stale: false }) };

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
});

describe.skipIf(!CSI)('CSI on loopback: fr_net_node fake CSI against csi_stream and /app/stream (design csi-c1 D11-D13)', () => {
  it('streams 3 s: whole csi1 blocks in order, drops agreed with the board, the .csi file, every block live', async () => {
    const home = mkdtempSync(join(tmpdir(), 'fr-home-'));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const prev = process.env.FR_HOME;
    process.env.FR_HOME = home;
    cleanups.push(() => (prev === undefined ? delete process.env.FR_HOME : (process.env.FR_HOME = prev)));
    const r = await otaRig();
    cleanups.push(() => r.close());
    r.registry.add({ device_id: MAC, addr: 0x48, alias: ALIAS, provisioned: true, net: 0 });
    let hub!: HubContext;
    const part = createAppServer(() => hub, RUN, { token: TOKEN });
    hub = { ...r.hub, appServer: part, wsServer: NOOP, staticSite: NOOP } as HubContext;
    part.start();
    cleanups.push(() => part.stop());
    const app = buildServer(hub, 0);
    cleanups.push(() => app.close());
    await app.listen({ host: '127.0.0.1', port: 0 });
    const url = `ws://127.0.0.1:${(app.server.address() as { port: number }).port}/app`;
    const online = waitForEvent(r.events, (e) => e.type === 'device.online' && e.device === MAC, 8000);
    const node = new CppNode(['--hub-tcp', String(r.ports.tcp), '--hub-udp', String(r.ports.udp), '--hub-http', String(r.httpPort), '--mac', MAC, '--addr', '72', '--net', '0', '--epoch', '3', ...CSI_ARGS]);
    cleanups.push(() => node.stop());
    await online;

    const client = await connect({ url, token: TOKEN, connectTimeoutMs: 10_000 });
    cleanups.push(() => client.close());
    const live: CsiBlock[] = [];
    let welcomed = false;
    cleanups.push(client.streams.subscribe(ALIAS, undefined, (b) => live.push(b), { onEvent: (e) => (welcomed ||= e.type === 'welcome') }));
    await until(() => welcomed, 5000, 'the /app/stream welcome');

    const out = join(home, 'csi', 'host.csi');
    const job = (await HANDLERS.csi_stream({ device: ALIAS, seconds: 3, out, live: true, wait_s: 30 }, hub)) as Job;
    const end = job.status === 'completed' || job.status === 'failed' ? job : await r.jobs.wait(job.job_id, 30);
    expect(end.error).toBeUndefined();
    const res = end.result as CsiStream & { device_records?: number; device_dropped?: number };
    expect(res.reason).toBe('done');
    expect(res.records).toBeGreaterThan(0);
    expect(res.dropped).toBe(res.device_dropped ?? res.dropped);
    if (res.device_records !== undefined) {
      expect(res.records).toBe(res.device_records);
    }
    const file = parseCsiFile(readFileSync(out));
    expect(file.map((b) => b.seq)).toEqual([...Array(res.blocks).keys()]);
    expect(file.reduce((n, b) => n + b.records.length, 0)).toBe(res.records);
    for (const b of file) {
      expect(b.bytes).toBeLessThanOrEqual(8192);
      for (const rec of b.records) {
        expect(rec.len).toBeLessThanOrEqual(512);
        expect(rec.len % 2).toBe(0);
      }
    }
    await until(() => live.length === res.blocks, 5000, 'every block live');
    expect(live.map((b) => b.seq)).toEqual(file.map((b) => b.seq));
    console.log(`[measured] CSI host stream: ${res.records} records in ${res.seconds} s (${res.rate_hz}/s), ${res.blocks} blocks, ${res.dropped} dropped`);
  }, 60_000);
});
