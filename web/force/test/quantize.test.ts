// The theremin's quantiser (src/dsp/quantize.ts): the scales' notes, the hysteresis at a boundary, off.

import { describe, expect, it } from 'vitest';

import { nearestNote, Quantizer, SCALES } from '../src/dsp/quantize.ts';

describe('the quantiser', () => {
  it('snaps to the nearest note of the scale, in any octave', () => {
    expect(nearestNote(0.4, SCALES.chromatic.steps!)).toBe(0);
    expect(nearestNote(0.6, SCALES.chromatic.steps!)).toBe(1);
    expect(nearestNote(5.4, SCALES['major-pentatonic'].steps!)).toBe(4);
    expect(nearestNote(5.6, SCALES['major-pentatonic'].steps!)).toBe(7);
    expect(nearestNote(11, SCALES['major-pentatonic'].steps!)).toBe(12); // 9 or the next octave's root
    expect(nearestNote(13.2, SCALES.minor.steps!)).toBe(14);
    expect(nearestNote(15.1, SCALES.minor.steps!)).toBe(15); // the minor third
    expect(nearestNote(-0.8, SCALES.minor.steps!)).toBe(0);
    expect(nearestNote(-1.2, SCALES.minor.steps!)).toBe(-2); // the octave below's seventh
  });

  it('off passes the pitch through', () => {
    const q = new Quantizer('off');
    expect(q.quantize(3.37)).toBe(3.37);
  });

  it('holds a note across a boundary until the pitch is past it by the hysteresis', () => {
    const q = new Quantizer('chromatic', 0.2);
    expect(q.quantize(0.1)).toBe(0);
    expect(q.quantize(0.6)).toBe(0); // past the boundary (0.5), not by 0.2
    expect(q.quantize(0.69)).toBe(0);
    expect(q.quantize(0.71)).toBe(1);
    expect(q.quantize(0.4)).toBe(1); // back under the boundary: still held
    expect(q.quantize(0.29)).toBe(0);
  });

  it('a jump over several notes changes at once', () => {
    const q = new Quantizer('major-pentatonic', 0.2);
    expect(q.quantize(0)).toBe(0);
    expect(q.quantize(9.1)).toBe(9);
  });

  it('noise at a boundary does not flip the note', () => {
    const q = new Quantizer('chromatic', 0.2);
    q.quantize(0);
    let flips = 0;
    let prev = q.quantize(0.5);
    for (let i = 0; i < 1000; i++) {
      const n = q.quantize(0.5 + 0.15 * Math.sin(i * 1.7));
      flips += n !== prev ? 1 : 0;
      prev = n;
    }
    expect(flips).toBe(0);
  });
});
