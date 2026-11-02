// A2 stream H (design audio-a2 D3, D5, §10): audio_monitor against a FakeNode that answers fr.audio_in 1.1
// monitor_start / monitor_stop as the board does: the defaults (the first fr.audio_in to the first fr.audio_out), a
// rate mismatch refused before anything is sent, BUSY, monitor_ended into the result, the deadline (monitor_stop,
// reason timeout), a cancel (monitor_stop at once), the `stats audio` deltas, and both instances' locks.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { findOp, type Job } from '@fractonica/protocol';
import { decodeDiagExecArgs, decodeMember, encodeDiagExecResult, encodeMember, PORT } from '@fractonica/protocol/gen';

import { AUDIO_MONITOR_SLACK_MS } from '../src/audio/ops.ts';
import { HANDLERS } from '../src/ops.ts';
import { type FakeNode, type OtaRig, otaRig, STATUS, until } from './fake-node.ts';

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
});

const DEV = 'a0b1c2d3e4f5';
const FW = '00112233aabbccdd'; // FakeNode's default fw_id prefix

const enc = (cap: string, part: 'args' | 'result' | 'event', member: string, v: unknown) => {
  const e = encodeMember(cap, part, member, v);
  if (!e.ok) {
    throw new Error(`${cap}.${member}: ${e.detail}`);
  }
  return e.value;
};
const dec = <T>(cap: string, part: 'args' | 'result' | 'event', member: string, bytes: Uint8Array): T => {
  const d = decodeMember(cap, part, member, bytes);
  if (!d.ok) {
    throw new Error(`${cap}.${member}: ${d.error}`);
  }
  return d.value as T;
};

/** s3a-audio's instances: mic (fr.audio_in) 3, spk (fr.audio_out) 4, rf (fr.audio_in) 5. */
const CAPS = [
  { port: 1, cap_id: 0x0001, name: 'boot' },
  { port: 3, cap_id: 0x0007, name: 'mic' },
  { port: 4, cap_id: 0x0004, name: 'spk' },
  { port: 5, cap_id: 0x0007, name: 'rf' },
];

interface MonitorStart {
  port: number;
  to_port: number;
  seconds: number;
  volume: number;
}

interface Board {
  r: OtaRig;
  node: FakeNode;
  starts: MonitorStart[];
  stops: number[];
  diag: string[];
  /** `stats audio`'s counters, read at each answer (null: the board answers unknown_command). */
  stats: { mic: number; rf: number; spk: number } | null;
}

/**
 * A FakeNode whose inputs monitor as fr.audio_in 1.1 does: monitor_start answers OK and, unless `end` is false, sends
 * monitor_ended done after `endMs` with seconds × 16000 samples; monitor_stop ends a running monitor `stopped` with
 * what it routed so far. `stats audio` answers the board's counters (each answer adds `bump` to them).
 */
async function board(o: { end?: boolean; endMs?: number; bump?: { mic?: number; rf?: number; spk?: number } } = {}): Promise<Board> {
  const r = await otaRig();
  cleanups.push(() => r.close());
  r.registry.add({ device_id: DEV, addr: 0x41, alias: 'mic-s3', provisioned: true, net: 0 });
  const node = r.node({ mac: DEV, addr: 0x41, alias: 'mic-s3' });
  node.describeAs(CAPS);
  const b: Board = { r, node, starts: [], stops: [], diag: [], stats: { mic: 2, rf: 7, spk: 5 } };
  let running: { port: number; to_port: number; t0: number; timer?: NodeJS.Timeout } | null = null;
  const end = (port: number, reason: string, samples: number) => {
    const to = running!.to_port;
    clearTimeout(running!.timer);
    running = null;
    node.event(port, 2, enc('fr.audio_in', 'event', 'monitor_ended', { reason, to_port: to, samples }));
  };
  for (const port of [3, 5]) {
    node.handlers.set(`${port}/4`, (args) => {
      const a = dec<Omit<MonitorStart, 'port'>>('fr.audio_in', 'args', 'monitor_start', args);
      b.starts.push({ port, ...a });
      if (running) {
        return { status: STATUS.BUSY };
      }
      running = { port, to_port: a.to_port, t0: Date.now() };
      if (o.end !== false) {
        running.timer = setTimeout(() => end(port, 'done', a.seconds * 16000), o.endMs ?? 30);
      }
      return undefined;
    });
    node.handlers.set(`${port}/5`, () => {
      b.stops.push(port);
      if (running?.port === port) {
        end(port, 'stopped', Math.round(((Date.now() - running.t0) / 1000) * 16000));
      }
      return undefined;
    });
  }
  node.handlers.set(`${PORT.DIAG}/1`, (args) => {
    const d = decodeDiagExecArgs(args);
    const line = d.ok ? d.value.line : '';
    b.diag.push(line);
    const answer = (json: unknown) => ({ fields: encodeDiagExecResult({ json: JSON.stringify(json) }) });
    if (line !== 'stats audio' || !b.stats) {
      return answer({ ok: false, error: 'unknown_command' });
    }
    const s = b.stats;
    const out = {
      ok: true,
      audio: { mic: { rx_overflows: s.mic, dropped_samples: 0, clipping: 0 }, spk: { underruns: s.spk, ring_dry: 0 }, rf: { rx_overflows: s.rf, dropped_samples: 0, clipping: 0 } },
    };
    s.mic += o.bump?.mic ?? 0;
    s.rf += o.bump?.rf ?? 0;
    s.spk += o.bump?.spk ?? 0;
    return answer(out);
  });
  await node.connected(r.events);
  return b;
}

/** A build of FakeNode's firmware whose manifest gives the instances' drivers and config sample_hz. */
function addManifest(r: OtaRig, rates: { mic: number; spk: number; rf: number }): void {
  const cap = (name: string, port: number, c: string, cap_id: number, driver: string, sample_hz: number) => ({ name, port, cap: c, cap_id, version: '1.1', driver, config: { sample_hz } });
  const buildId = `node/s3a-audio/debug/${FW.slice(0, 12)}`;
  const manifest = {
    schema: 'fractonica.artifact/1',
    build_id: buildId,
    app: 'node',
    profile: 's3a-audio',
    build_type: 'debug',
    board: 'esp32s3-audio',
    target: 'esp32s3',
    chip_id: 9,
    part_profile: 'fr-4mb-v1',
    version: 'v1',
    source_dir: '/src',
    git: { sha: 'abc', dirty: false },
    idf: { version: 'v6.1', commit: 'def' },
    fw_id: `${FW}${'0'.repeat(48)}`,
    elf_sha256: '00',
    size: 1,
    built_at: '2026-11-02T00:00:00Z',
    flash: { mode: 'dio', freq: '80m', size: '4MB', files: [] },
    partitions: [],
    caps: [
      cap('mic', 3, 'fr.audio_in', 0x0007, 'i2s_mic', rates.mic),
      cap('spk', 4, 'fr.audio_out', 0x0004, 'i2s_amp', rates.spk),
      cap('rf', 5, 'fr.audio_in', 0x0007, 'adc_audio', rates.rf),
    ],
  };
  const path = join(r.dir, 'a2-manifest.json');
  writeFileSync(path, JSON.stringify(manifest));
  r.db
    .prepare('INSERT INTO artifacts (build_id, source_dir, profile, build_type, fw_id, built_at, manifest_path, fault) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(buildId, '/src', 's3a-audio', 'debug', manifest.fw_id, manifest.built_at, path, null);
}

const monitor = (b: Board, input: Record<string, unknown>) => Promise.resolve().then(() => HANDLERS.audio_monitor({ device: 'mic-s3', seconds: 1, wait_s: 20, ...input }, b.r.hub) as Promise<Job>);

describe('audio_monitor on a fake board (design audio-a2 D5)', () => {
  it('defaults to the first fr.audio_in and fr.audio_out, sends volume 0, and reports monitor_ended done', async () => {
    const b = await board();
    const job = await monitor(b, {});
    expect(job.status).toBe('completed');
    expect(b.starts).toEqual([{ port: 3, to_port: 4, seconds: 1, volume: 0 }]);
    expect(job.result).toMatchObject({ device: DEV, alias: 'mic-s3', from: 'mic', to: 'spk', seconds: 1, reason: 'done', samples: 16000, sample_hz: 16000 });
    expect(findOp('audio_monitor')!.output!.safeParse(job.result).success).toBe(true);
    // No manifest: an instance named mic is taken for a microphone (the feedback warning).
    expect((job.result as { warning?: string }).warning).toMatch(/howls \(feedback\)/);
    expect(b.stops).toEqual([]);

    const rf = await monitor(b, { from: 'rf', to: 'spk', volume: 60, seconds: 2 });
    expect(b.starts[1]).toEqual({ port: 5, to_port: 4, seconds: 2, volume: 60 });
    expect(rf.result).toMatchObject({ from: 'rf', to: 'spk', seconds: 2, reason: 'done' });
    expect(rf.result).not.toHaveProperty('warning');
  });

  it('refuses instances of the wrong capability, an unknown one, and two config rates, before sending anything', async () => {
    const b = await board();
    await expect(monitor(b, { from: 'spk' })).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('fr.audio_out, not fr.audio_in') });
    await expect(monitor(b, { to: 'rf' })).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('fr.audio_in, not fr.audio_out') });
    await expect(monitor(b, { from: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    addManifest(b.r, { mic: 16000, spk: 8000, rf: 16000 });
    await expect(monitor(b, { from: 'rf' })).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('rf runs at 16000 Hz and spk at 8000 Hz') });
    expect(b.starts).toEqual([]);
    expect(b.diag).toEqual([]);
    expect(b.r.hub.jobs.list(10)).toEqual([]);
  });

  it('warns for the microphone by its driver (i2s_mic), not for the detector (adc_audio), at the manifest rate', async () => {
    const b = await board();
    addManifest(b.r, { mic: 22050, spk: 22050, rf: 22050 });
    const mic = await monitor(b, { from: 'mic' });
    expect(mic.result).toMatchObject({ from: 'mic', sample_hz: 22050, seconds: round3(16000 / 22050), warning: expect.stringContaining('microphone') });
    const rf = await monitor(b, { from: 'rf' });
    expect(rf.result).not.toHaveProperty('warning');
  });

  it("maps the board's BUSY to DEVICE_BUSY", async () => {
    const b = await board();
    b.node.handlers.set('3/4', () => ({ status: STATUS.BUSY }));
    const job = await monitor(b, {});
    expect(job.status).toBe('failed');
    expect(job.error).toMatchObject({ code: 'DEVICE_BUSY', message: expect.stringContaining('already monitors') });
    b.node.handlers.set('3/4', () => ({ status: STATUS.UNSUPPORTED }));
    expect((await monitor(b, {})).error).toMatchObject({ code: 'CAPABILITY_UNSUPPORTED', message: expect.stringContaining('fr.audio_in 1.1') });
  });

  it('gives the stats audio deltas of the output (underruns) and the input (rx_overflows); none when the board does not answer', async () => {
    const b = await board({ bump: { rf: 3, spk: 1 } });
    const job = await monitor(b, { from: 'rf' });
    expect(b.diag).toEqual(['stats audio', 'stats audio']);
    expect(job.result).toMatchObject({ from: 'rf', underruns: 1, rx_overflows: 3 });
    b.stats = null;
    const none = await monitor(b, { from: 'rf' });
    expect(none.status).toBe('completed');
    expect(none.result).not.toHaveProperty('underruns');
    expect(none.result).not.toHaveProperty('rx_overflows');
  });

  it('sends monitor_stop at seconds + 5 s when no monitor_ended came: reason timeout, seconds from the stopped event', async () => {
    const b = await board({ end: false });
    const t0 = Date.now();
    const job = await monitor(b, { from: 'rf' });
    const took = Date.now() - t0;
    expect(job.status).toBe('completed');
    expect(b.stops).toEqual([5]);
    expect(took).toBeGreaterThanOrEqual(1000 + AUDIO_MONITOR_SLACK_MS - 100);
    expect(took).toBeLessThan(1000 + AUDIO_MONITOR_SLACK_MS + 3000);
    expect(job.result).toMatchObject({ from: 'rf', reason: 'timeout' });
    expect((job.result as { seconds: number }).seconds).toBeGreaterThan(5.5);
  }, 20_000);

  it('a cancel sends monitor_stop at once and ends the job cancelled', async () => {
    const b = await board({ end: false });
    const job = await monitor(b, { seconds: 600, wait_s: 0 });
    await until(() => b.starts.length === 1, 3000, 'monitor_start');
    const t0 = Date.now();
    await b.r.hub.jobs.cancel(job.job_id);
    const done = await b.r.hub.jobs.wait(job.job_id, 10);
    expect(done.status).toBe('cancelled');
    expect(b.stops).toEqual([3]);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('holds both instances: a play on the output waits for the monitor', async () => {
    const b = await board({ endMs: 400 });
    b.node.handlers.set('4/1', () => {
      setTimeout(() => b.node.event(4, 1, enc('fr.audio_out', 'event', 'play_done', { play_id: 0, reason: 'done', underruns: 0, samples: 160 })), 10);
      return undefined;
    });
    const mon = await monitor(b, { from: 'rf', wait_s: 0 });
    await until(() => b.starts.length === 1, 3000, 'monitor_start');
    const tone = (await HANDLERS.audio_play({ device: 'mic-s3', tone: { freq_hz: 440, ms: 10 }, wait_s: 0 }, b.r.hub)) as Job;
    expect(b.r.hub.jobs.get(tone.job_id).status).toBe('queued');
    expect((await b.r.hub.jobs.wait(mon.job_id, 10)).status).toBe('completed');
    expect((await b.r.hub.jobs.wait(tone.job_id, 10)).status).toBe('completed');
  });
});

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
