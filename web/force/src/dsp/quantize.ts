// The theremin's pitch quantiser (pure): a continuous pitch in semitones above the root snapped to a scale's notes,
// with hysteresis so the rest noise or a hand's tremor at a boundary between two notes does not flip between them.

export type ScaleName = 'off' | 'chromatic' | 'major-pentatonic' | 'minor';
export const SCALES: Record<ScaleName, { label: string; steps: readonly number[] | null }> = {
  off: { label: 'off (continuous)', steps: null },
  chromatic: { label: 'chromatic', steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  'major-pentatonic': { label: 'major pentatonic', steps: [0, 2, 4, 7, 9] },
  minor: { label: 'minor', steps: [0, 2, 3, 5, 7, 8, 10] },
};

/** The scale's note nearest to `semis` (semitones above the root, any octave). */
export function nearestNote(semis: number, steps: readonly number[]): number {
  const oct = Math.floor(semis / 12);
  let best = NaN;
  let bestD = Infinity;
  for (let o = oct - 1; o <= oct + 1; o++) {
    for (const s of steps) {
      const n = 12 * o + s;
      const d = Math.abs(n - semis);
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
  }
  return best;
}

export class Quantizer {
  scale: ScaleName;
  /** Semitones past the midpoint between two notes before the note changes. */
  hysteresis: number;
  #note: number | null = null;

  constructor(scale: ScaleName = 'off', hysteresis = 0.2) {
    this.scale = scale;
    this.hysteresis = hysteresis;
  }

  reset(): void {
    this.#note = null;
  }

  /** `semis` snapped (unchanged when the scale is off). */
  quantize(semis: number): number {
    const steps = SCALES[this.scale]?.steps;
    if (!steps) {
      this.#note = null;
      return semis;
    }
    const next = nearestNote(semis, steps);
    const cur = this.#note;
    if (cur === null || next === cur) {
      this.#note = next;
      return next;
    }
    // keep the current note until the pitch is past the midpoint towards the next by the hysteresis (a jump over
    // several notes is far past its midpoint and changes at once)
    const mid = (cur + next) / 2;
    if (Math.abs(semis - mid) > this.hysteresis) {
      this.#note = next;
      return next;
    }
    return cur;
  }
}
