// The fixture <-> DUT clocks (design m2-c1-hil D10; stream S4). On synthetic samples: the least-squares line
// t_D = a + (1 + s)·t_F, the 1 ms rejection (late_stamps), validity (4 samples, the newest ≤ 10 s old), the
// 60 s window, pairing by hub time whichever half comes first, bounce windows, the pin_pulse ISR latency and
// a reset. On a scripted fixture with two DUTs: presses converge to the DUT's own clock plus its ISR latency,
// a late stamp is rejected, bounce presses never become samples, pin_pulse samples on two DUTs at once land
// on their own channels (isr_latency_us), a DUT's reboot starts its fit again, and bench_get publishes the fit
// and the fixture <-> hub uncertainty.

import { afterEach, describe, expect, it } from 'vitest';

import { decodeDiagExecArgs, encodeDiagExecResult, PORT } from '@fractonica/protocol/gen';

import { BenchSync, fitSamples, type FitSample } from '../src/fixture/sync.ts';
import { until } from './fake-node.ts';
import { benchRig, type BenchRig, C3, C6, clockDelta, member } from './fixture-fake.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
});

async function rig(opts: Parameters<typeof benchRig>[0] = {}): Promise<BenchRig> {
  const b = await benchRig(opts);
  cleanups.push(() => b.close());
  return b;
}

/** Samples of t_D = a + (1 + s)·t_F, one a second, hub time = fixture time + 1.7e15. */
function line(n: number, a: number, s: number, opts: { t0?: number; jitter?: (i: number) => number } = {}): FitSample[] {
  const t0 = opts.t0 ?? 50_000_000;
  return Array.from({ length: n }, (_, i) => {
    const tF = t0 + i * 1_000_000;
    return { t_fix_us: tF, t_dut_us: a + (1 + s) * tF + (opts.jitter?.(i) ?? 0), at_hub_us: 1.7e15 + tF, hub_dut_us: null };
  });
}

describe('the wired fit on synthetic samples', () => {
  it('recovers offset and skew by least squares', () => {
    const m = fitSamples(line(10, 2_345_678, 40e-6, { jitter: (i) => (i % 2 ? 3 : -3) }))!;
    expect(m.rejected).toBe(0);
    expect(m.skew * 1e6).toBeCloseTo(40, 0);
    expect(m.residualP99).toBeLessThan(10);
    // At the newest sample the offset is a + s·t_F.
    const tF = 50_000_000 + 9_000_000;
    expect(m.offset + m.skew * (tF - m.x0)).toBeCloseTo(2_345_678 + 40e-6 * tF, -1);
  });

  it('rejects samples more than 1 ms off (late stamps), so they do not pull the line', () => {
    const m = fitSamples(line(10, 1000, 0, { jitter: (i) => (i === 4 ? 2500 : i === 7 ? 1200 : 0) }))!;
    expect(m.rejected).toBe(2);
    expect(m.accepted).toHaveLength(8);
    expect(m.residualP99).toBeLessThan(1);
    expect(m.offset).toBeCloseTo(1000, 3);
    // 900 µs off is still a sample.
    expect(fitSamples(line(10, 1000, 0, { jitter: (i) => (i === 4 ? 900 : 0) }))!.rejected).toBe(0);
  });

  it('is valid with 4 accepted samples, the newest at most 10 s old, over a 60 s window', () => {
    let now = 0;
    const sync = new BenchSync(() => now);
    const feed = (s: FitSample[]) => {
      for (const x of s) {
        now = x.at_hub_us;
        sync.pressEdge('d', x.t_fix_us, x.at_hub_us, null);
        sync.dutDown('d', x.t_dut_us, x.at_hub_us + 2000);
      }
    };
    feed(line(3, 500, 0));
    expect(sync.fit('d')).toMatchObject({ samples: 3, valid: false });
    expect(sync.toDut('d', 52_000_000)).toBeNull();
    feed(line(1, 500, 0, { t0: 53_000_000 }));
    expect(sync.fit('d')).toMatchObject({ samples: 4, rejected: 0, valid: true, offset_us: 500, skew_ppm: 0, residual_p99_us: 0, age_ms: 0 });
    expect(sync.toDut('d', 54_000_000)).toEqual({ t_dut_us: 54_000_500, u_us: expect.any(Number) });
    now += 10_000_001;
    expect(sync.fit('d')).toMatchObject({ valid: false, age_ms: 10_000 });
    // Past 60 s every sample has left the window.
    now += 60_000_000;
    expect(sync.fit('d')).toBeNull();
  });

  it('pairs a fixture edge and a DUT stamp within 50 ms of hub time, either first; a bounce window is no sample', () => {
    let now = 1.7e15;
    const sync = new BenchSync(() => now);
    sync.dutDown('d', 10_000_500, now + 3000); // the DUT's down first (UDP beat the serial batch)
    sync.pressEdge('d', 10_000_000, now, null);
    now += 300_000;
    sync.pressEdge('d', 10_300_000, now, null);
    sync.dutDown('d', 10_300_500, now + 60_000); // too far: not this edge's
    now += 300_000;
    sync.exclude('d', now, now + 82_000); // a bounce: four press edges, one down
    for (const dt of [0, 1000, 2000]) {
      sync.pressEdge('d', 10_600_000 + dt, now + dt, null);
    }
    sync.dutDown('d', 10_600_500, now + 2500);
    expect(sync.fit('d')).toMatchObject({ samples: 1, offset_us: 500 });
  });

  it("gives a DUT's ISR latency from its pin_pulse samples against the press fit, and forgets it at a reset", () => {
    let now = 0;
    const sync = new BenchSync(() => now);
    // Presses: the DUT stamps 35 µs after the edge (its ISR latency is in the fit's offset).
    for (const s of line(5, 700 + 35, 0)) {
      now = s.at_hub_us;
      sync.pressEdge('d', s.t_fix_us, now, s.t_dut_us - 1000);
      sync.dutDown('d', s.t_dut_us, now + 1500);
    }
    // pin_pulse: the DUT stamps the pulse when it drives the pin (no ISR); the fixture sees it.
    for (let i = 0; i < 3; i++) {
      const tF = 54_200_000 + i * 100_000;
      sync.pinPulse('d', tF + 700, now + 10_000 + i * 100_000);
      sync.pinEdge('d', tF, now + 10_000 + i * 100_000 + 800);
    }
    const fit = sync.fit('d')!;
    expect(fit).toMatchObject({ samples: 5, valid: true, offset_us: 735, pin_samples: 3, isr_latency_us: 35 });
    // The hub path read 1 ms early at every sample.
    expect(fit.wired_minus_hub_us).toEqual({ n: 5, p50_us: 1000, p99_us: 1000 });
    sync.reset('d');
    expect(sync.fit('d')).toBeNull();
  });
});

const gpio = (selector: string, gesture: string) => ({ selector, instance: 'boot', gesture, layer: 'gpio' });

/** The DUT's clock less the fixture's (FakeNodes count on one performance.now()). */
const delta = (b: BenchRig, dut: 'c3' | 'c6') => clockDelta(b[dut], b.fixture);

describe('the wired fit on the bench', () => {
  it("converges from presses to the DUT's clock plus its ISR latency, rejecting a late stamp", async () => {
    const b = await rig({ isrUs: 35 });
    for (let i = 0; i < 5; i++) {
      await b.call('input_simulate', gpio('pad-c3', 'click'));
    }
    // One down stamped 3 ms late (the DUT's ISR ran with the flash cache off).
    b.fixture.lines.get('ch0')!.wire!.isrUs = 3035;
    await b.call('input_simulate', gpio('pad-c3', 'click'));
    b.fixture.lines.get('ch0')!.wire!.isrUs = 35;
    await b.call('input_simulate', gpio('pad-c3', 'double_click'));
    await until(() => b.module.sync.fit(C3.mac)?.samples === 7, 2000, '7 samples');
    const fit = b.module.sync.fit(C3.mac)!;
    expect(fit).toMatchObject({ samples: 7, rejected: 1, late_stamps: 1, valid: true });
    expect(Math.abs(fit.offset_us - (delta(b, 'c3') + 35))).toBeLessThan(20);
    expect(fit.residual_p99_us).toBeLessThan(20);
    expect(Math.abs(fit.skew_ppm)).toBeLessThan(50);
    // The hub path beside it, as a cross-check: on one Mac, within a few ms.
    expect(fit.wired_minus_hub_us!.n).toBe(7);
    expect(Math.abs(fit.wired_minus_hub_us!.p50_us)).toBeLessThan(5000);
    expect(b.module.sync.fit(C6.mac)).toBeNull();
  });

  it('never takes a bounce press as a sample', async () => {
    const b = await rig();
    for (let i = 0; i < 4; i++) {
      await b.call('input_simulate', gpio('pad-c6', 'click'));
    }
    await until(() => b.module.sync.fit(C6.mac)?.samples === 4, 2000, `4 samples (${JSON.stringify(b.module.sync.fit(C6.mac))})`);
    await b.call('input_simulate', gpio('pad-c6', 'bounce'));
    await b.call('input_simulate', gpio('pad-c6', 'click'));
    await until(() => b.module.sync.fit(C6.mac)?.samples === 5, 2000, `5 samples (${JSON.stringify(b.module.sync.fit(C6.mac))})`);
    expect(b.module.sync.fit(C6.mac)).toMatchObject({ samples: 5, rejected: 0 });
  });

  it('takes pin_pulse samples on two DUTs at once, each on its own test_pin line, as their ISR latency', async () => {
    const b = await rig({ isrUs: 30 });
    // Each DUT's diag pin_pulse drives its own fixture input (ch8, ch10) and answers its clock at the edge.
    const wirePin = (dut: 'c3' | 'c6', channel: string) => {
      b[dut].handlers.set(`${PORT.DIAG}/1`, (args) => {
        const d = decodeDiagExecArgs(args);
        const us = Number(/^pin_pulse (\d+)$/.exec(d.ok ? d.value.line : '')?.[1] ?? 0);
        const at = b[dut].nodeNowUs();
        b.fixture.pulse(channel, us, at - delta(b, dut));
        return { fields: encodeDiagExecResult({ json: JSON.stringify({ ok: true, pin: 10, us, at_us: at }) }) };
      });
    };
    wirePin('c3', 'ch8');
    wirePin('c6', 'ch10');
    for (let i = 0; i < 4; i++) {
      await b.call('input_simulate', gpio('pad-c3,pad-c6', 'click'));
    }
    await until(() => b.module.sync.fit(C3.mac)?.valid && b.module.sync.fit(C6.mac)?.valid, 2000, 'both fits');
    for (let i = 0; i < 5; i++) {
      const out = await Promise.all([
        b.call('diag_exec', { port: 'pad-c3', line: 'pin_pulse 1000' }),
        b.call('diag_exec', { port: 'pad-c6', line: 'pin_pulse 1000' }),
      ]);
      expect(out.map((o) => o.response.ok)).toEqual([true, true]);
      await new Promise((r) => setTimeout(r, 20));
    }
    await until(() => b.module.sync.fit(C3.mac)?.pin_samples === 5 && b.module.sync.fit(C6.mac)?.pin_samples === 5, 2000, 'pin samples');
    for (const id of [C3.mac, C6.mac]) {
      const fit = b.module.sync.fit(id)!;
      expect(Math.abs(fit.isr_latency_us! - 30)).toBeLessThan(10);
    }
  });

  it("starts a DUT's fit again when it reboots, and bench_get publishes the fits and the fixture clock", async () => {
    const b = await rig();
    for (let i = 0; i < 4; i++) {
      await b.call('input_simulate', gpio('pad-c3', 'click'));
    }
    await until(() => b.module.sync.fit(C3.mac)?.valid, 2000, 'valid fit');
    const s = await b.call('bench_get', {});
    expect(s.duts.find((d: any) => d.device === C3.mac).fit).toMatchObject({ samples: 4, rejected: 0, valid: true, age_ms: expect.any(Number) });
    expect(s.clock).toMatchObject({ uncertainty_us: expect.any(Number), rtt_min_us: expect.any(Number), bursts: expect.any(Number), age_ms: expect.any(Number) });
    // Over loopback serial the fixture's clock is good to well under a millisecond.
    expect(s.clock.uncertainty_us).toBeLessThan(1000);
    b.c3.event(PORT.NODE, 1, member('fr.node', 'event', 'boot', { reset_reason: 1 }));
    await until(() => b.module.sync.fit(C3.mac) === null, 2000, 'fit reset');
  });
});
