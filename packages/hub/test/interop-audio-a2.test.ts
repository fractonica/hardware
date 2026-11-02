// T-RF 3 on loopback (design audio-a2 §5 gate 3, D3, D5): the on-board monitor of build/host-tests/fr_net_node
// (`--audio-in sine:<hz>` as fr.audio_in mic, `--audio-out <file.raw>` as fr.audio_out spk; stream F) driven by the
// hub's audio_monitor: a 3 s monitor ends `done`, the --audio-out file then holds about 3 s of the sine (its peak by
// Goertzel at the sine's frequency) and the `stats audio` delta of spk's underruns is 0. `pnpm test:host` builds the
// binary: without it or its audio flags the suite skips, and so does the test while the binary's fr.audio_in answers
// monitor_start UNSUPPORTED (stream C's placeholder, before F lands).

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { AudioMonitor, Job } from '@fractonica/protocol';

import { HANDLERS } from '../src/ops.ts';
import { goertzel, peakHz } from './audio-util.ts';
import { BIN, CppNode } from './cpp-node.ts';
import { otaRig, until, waitForEvent } from './fake-node.ts';

const AUDIO = existsSync(BIN) && readFileSync(BIN).includes('--audio-in');
const MAC = '58e6c5d55e72';
const ALIAS = 'rf-host';
const RATE = 16000;
const HZ = 1000;

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

describe.skipIf(!AUDIO)('T-RF 3 on loopback: fr_net_node host monitor against the hub (design audio-a2 D3, D5)', () => {
  it('monitors a 1 kHz sine to the file speaker for 3 s: done, about 3 s of the sine in the file, 0 underruns', async (ctx) => {
    const r = await otaRig();
    cleanups.push(() => r.close());
    r.registry.add({ device_id: MAC, addr: 0x48, alias: ALIAS, provisioned: true, net: 0 });
    const raw = join(tmp('fr-audio-out-'), 'spk.raw');
    const online = waitForEvent(r.events, (e) => e.type === 'device.online' && e.device === MAC, 8000);
    const args = ['--hub-tcp', String(r.ports.tcp), '--hub-udp', String(r.ports.udp), '--hub-http', String(r.httpPort), '--mac', MAC, '--addr', '72', '--net', '0', '--epoch', '3'];
    const node = new CppNode([...args, '--audio-in', `sine:${HZ}`, '--audio-out', raw]);
    cleanups.push(() => node.stop());
    await online;

    let job = (await HANDLERS.audio_monitor({ device: ALIAS, from: 'mic', to: 'spk', seconds: 3, wait_s: 30 }, r.hub)) as Job;
    if (job.status !== 'completed' && job.status !== 'failed') {
      job = await r.jobs.wait(job.job_id, 30);
    }
    const err = job.error as { code?: string; message?: string } | undefined;
    if (err?.code === 'CAPABILITY_UNSUPPORTED') {
      ctx.skip(`fr_net_node has no on-board monitor yet (stream F): ${err.message}`);
    }
    expect(job.error).toBeUndefined();
    const res = job.result as AudioMonitor;
    expect(res).toMatchObject({ from: 'mic', to: 'spk', reason: 'done', underruns: 0 });
    expect(Math.abs(res.seconds - 3)).toBeLessThanOrEqual(0.05);
    await until(() => existsSync(raw) && statSync(raw).size >= 3 * RATE * 2 * 0.9, 5000, 'the --audio-out file');
    const b = readFileSync(raw);
    const got = new Int16Array(b.buffer, b.byteOffset, Math.floor(b.length / 2));
    expect(Math.abs(got.length - 3 * RATE)).toBeLessThanOrEqual(3 * RATE * 0.1);
    expect(Math.abs(peakHz(got, RATE, 900, 1100) - HZ)).toBeLessThanOrEqual(5);
    // The sine dominates: its power over that of an octave away (nothing else should be there).
    const ratioDb = 10 * Math.log10(goertzel(got, HZ, RATE) / Math.max(1, goertzel(got, HZ * 2, RATE)));
    expect(ratioDb).toBeGreaterThan(30);
    console.log(`[measured] T-RF host monitor: ${res.seconds} s, ${got.length} samples in the file, sine/2f ${ratioDb.toFixed(1)} dB, underruns ${String(res.underruns)}, rx_overflows ${String(res.rx_overflows)}`);
  }, 60_000);
});
