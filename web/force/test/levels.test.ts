// The synth's levels, measured offline before anyone listens (web/csi's lesson: resonant filters and summed voices
// swing levels a lot): every mode rendered through the page's chain and the worklet's engine (./render.ts) on
// synthetic force curves at the board's rate and noise: rest, a slow firm press, taps (soft and hard), slams. At full
// volume the peak before the limiter stays at or under -6 dBFS; at rest every mode is silent; the limiter's ceiling
// (-3 dBFS) holds under abuse. And the engine's own latency: a value or a hit is heard from the next sample.

import { describe, expect, it } from 'vitest';

import { Engine, MODES, type Mode } from '../src/dsp/engine.ts';
import { curve, db, render, shapes } from './render.ts';

const MODE_LIST = Object.keys(MODES) as Mode[];
const CURVES = Object.keys(shapes) as (keyof typeof shapes)[];
const SEEDS = [1, 2, 3];

describe('levels per mode (full volume, before the limiter)', () => {
  const table: string[] = [];
  for (const mode of MODE_LIST) {
    it(`${mode}: silent at rest, peaks at or under -6 dBFS when played`, () => {
      const rest = render(mode, curve(10, shapes.rest, { seed: 9 }));
      expect(rest.peak).toBe(0);
      let worst = -Infinity;
      for (const name of CURVES.filter((c) => c !== 'rest')) {
        let peak = 0;
        let rms = 0;
        for (const seed of SEEDS) {
          const r = render(mode, curve(6, shapes[name], { seed }));
          expect(r.l.every(Number.isFinite)).toBe(true);
          peak = Math.max(peak, r.prePeak);
          rms = Math.max(rms, r.rms);
          if ((mode === 'string' || mode === 'drum') && name === 'slow') {
            expect(r.peak).toBe(0); // a slow press is no hit: nothing plucks or strikes
          }
        }
        worst = Math.max(worst, db(peak));
        table.push(`${mode.padEnd(9)} ${name.padEnd(6)} peak ${peak ? db(peak).toFixed(1).padStart(6) : '  -inf'} dBFS  rms ${rms ? db(rms).toFixed(1).padStart(6) : '  -inf'} dBFS`);
      }
      expect(worst).toBeLessThanOrEqual(-6);
    });
  }

  it('prints the table', () => {
    console.log(`levels at volume 1 (worst of ${SEEDS.length} noise seeds; the default volume 0.3 is 10.5 dB lower):\n${table.join('\n')}`);
  });

  it('at the default volume (0.3) the loudest playing peaks near -17 dBFS', () => {
    for (const mode of MODE_LIST) {
      const r = render(mode, curve(6, shapes.slams, { seed: 2 }), { params: { volume: 0.3 } });
      expect(db(r.peak)).toBeLessThanOrEqual(-16);
    }
  });
});

describe('abuse: the limiter holds -3 dBFS', () => {
  const sr = 48000;
  const run = (mode: Mode, seconds: number, each: (e: Engine, block: number) => void) => {
    const e = new Engine(sr, { mode, volume: 1, room: 1 });
    const l = new Float32Array(128);
    const r = new Float32Array(128);
    let peak = 0;
    for (let b = 0; b < (seconds * sr) / 128; b++) {
      each(e, b);
      e.process(l, r);
      for (let i = 0; i < 128; i++) {
        expect(Number.isFinite(l[i]) && Number.isFinite(r[i])).toBe(true);
        peak = Math.max(peak, Math.abs(l[i]), Math.abs(r[i]));
      }
    }
    return { peak, pre: e.takeMeter().prePeak };
  };

  it('the hardest hits as fast as the refractory time allows, the room full', () => {
    const every = Math.round((0.06 * sr) / 128);
    const lines: string[] = [];
    for (const mode of ['drum', 'string'] as Mode[]) {
      const m = run(mode, 4, (e, b) => {
        e.force(mode === 'string' ? (b % 40) / 40 : 1);
        if (b % every === 0) {
          e.hit(1);
        }
      });
      lines.push(`${mode}: before the limiter ${db(m.pre).toFixed(1)} dBFS, out ${db(m.peak).toFixed(1)} dBFS`);
      expect(m.peak).toBeLessThanOrEqual(10 ** (-3 / 20) + 1e-6);
    }
    console.log(`abuse (hits every 60 ms at full strength, room 100 %):\n${lines.join('\n')}`);
  });

  it('bow and theremin pumped between rest and full at the board rate', () => {
    for (const mode of ['bow', 'theremin'] as Mode[]) {
      const m = run(mode, 3, (e, b) => e.force(Math.floor(b / 4) % 2 ? 1 : 0));
      expect(m.peak).toBeLessThanOrEqual(10 ** (-3 / 20) + 1e-6);
      expect(db(m.pre)).toBeLessThanOrEqual(-5);
    }
  });
});

describe('the engine’s latency', () => {
  const sr = 48000;

  it('a drum hit sounds from the first sample of the next quantum', () => {
    const e = new Engine(sr, { mode: 'drum', volume: 1, room: 0 });
    const l = new Float32Array(128);
    const r = new Float32Array(128);
    e.process(l, r);
    expect(l.every((x) => x === 0)).toBe(true);
    e.hit(0.8);
    e.process(l, r);
    const first = l.findIndex((x) => Math.abs(x) > 1e-3);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(4);
  });

  it('a new force is reached within ~1 ms (63 % in 1 ms, 93 % by the end of the quantum), nothing scheduled ahead', () => {
    const e = new Engine(sr, { mode: 'bow', volume: 1, room: 0 });
    e.force(0.7);
    const one = new Float32Array(48); // 1 ms
    e.process(one, new Float32Array(48));
    expect(e.level).toBeGreaterThan(0.7 * (1 - 1 / Math.E) - 1e-9);
    expect(one.some((x) => x !== 0)).toBe(true); // the bow sounds within that millisecond
    e.process(new Float32Array(80), new Float32Array(80)); // the rest of a 128-sample quantum
    expect(e.level).toBeGreaterThan(0.93 * 0.7); // 1 - e^(-128/48)
  });
});
