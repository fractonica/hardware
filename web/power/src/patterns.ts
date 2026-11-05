// The haptic buttons' patterns (design power-p1 D11): fr.haptic play steps (on, off, on, off... ms), DOM-free.

export interface Pattern {
  name: string;
  steps: number[];
  repeat: number;
}

export const PATTERNS: readonly Pattern[] = [
  { name: 'Tap', steps: [60], repeat: 1 },
  { name: 'Double', steps: [80, 80, 80], repeat: 1 },
  { name: 'Heartbeat', steps: [70, 90, 110, 600], repeat: 3 },
  { name: 'Ramp', steps: [30, 60, 60, 60, 120, 60, 240], repeat: 1 },
  { name: 'Alarm', steps: [200, 100], repeat: 5 },
];

/** A pattern's length in ms (every step, every repeat). */
export function patternMs(p: Pick<Pattern, 'steps' | 'repeat'>): number {
  return p.steps.reduce((a, b) => a + b, 0) * p.repeat;
}

/** "100,50,100" typed by a person as steps (1-32 whole ms), or null. */
export function parseSteps(text: string): number[] | null {
  const parts = text.split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length || parts.length > 32) {
    return null;
  }
  const steps = parts.map(Number);
  return steps.every((n) => Number.isInteger(n) && n >= 0 && n <= 60_000) ? steps : null;
}
