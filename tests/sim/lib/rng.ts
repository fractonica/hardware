// The sim runner's seeded draws (design m2-c2 D12, §5.4): a small PRNG (mulberry32), so a scenario's seed gives one
// T2-CHURN-30 schedule and one set of T2-NN-30 press offsets, and a re-run with the same seed draws the same.

/** A small seeded PRNG (mulberry32): uniform in [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0 || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * T2-NN-30's running phase (§5.4): each of `n` pairs is pressed by a user of its own, so each starts at its own
 * offset inside the press period (`gapMs`) and presses every `gapMs` from there. The offsets are stratified (one per
 * n-th of the period, at a seeded point inside it, in a seeded order), so they spread over the whole period and two
 * pairs never share an instant; `lockstep` gives every pair 0 (all press together: the published stress case).
 */
export function pressOffsets(seed: number, n: number, gapMs: number, lockstep = false): number[] {
  if (lockstep || n <= 0 || gapMs <= 0) {
    return Array.from({ length: Math.max(0, n) }, () => 0);
  }
  const r = rng(seed ^ 0x6e6e3330); // 'nn30': apart from the churn schedule's draws on the same seed
  const slot = gapMs / n;
  const offsets = Array.from({ length: n }, (_, k) => Math.floor(k * slot + r() * slot));
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [offsets[i], offsets[j]] = [offsets[j], offsets[i]];
  }
  return offsets;
}
