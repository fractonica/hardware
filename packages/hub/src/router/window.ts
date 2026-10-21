// Duplicate filtering (spec 05 §5.8): a replay window `{top_seq, bitmap}` of 256 bits per (origin, epoch)
// at the hub, and RFC 1982 serial comparison for the u16 epochs and u32 seqs and clocks.

/** RFC 1982 on u16 (epochs): 1 when a is newer than b, -1 when older, 0 when equal. */
export function cmp16(a: number, b: number): number {
  const d = (a - b) & 0xffff;
  return d === 0 ? 0 : d < 0x8000 ? 1 : -1;
}

/** RFC 1982 on u32 (seqs, t_us): 1 when a is newer than b, -1 when older, 0 when equal. */
export function cmp32(a: number, b: number): number {
  const d = (a - b) >>> 0;
  return d === 0 ? 0 : d < 0x80000000 ? 1 : -1;
}

export type Verdict = 'new' | 'dup' | 'old';

/** FR_WINDOW_BITS_HUB. */
export const WINDOW_BITS = 256;

export class ReplayWindow {
  #top: number | null = null;
  #seen = new Uint8Array(WINDOW_BITS);

  /** Classifies `seq` and records it: a seq above the top slides the window. */
  check(seq: number): Verdict {
    if (this.#top === null) {
      this.#top = seq;
      this.#seen[seq % WINDOW_BITS] = 1;
      return 'new';
    }
    const top = this.#top;
    const ahead = (seq - top) | 0; // signed serial distance
    if (ahead > 0) {
      if (ahead >= WINDOW_BITS) {
        this.#seen.fill(0);
      } else {
        for (let i = 1; i <= ahead; i++) {
          this.#seen[(top + i) % WINDOW_BITS] = 0;
        }
      }
      this.#top = seq >>> 0;
      this.#seen[seq % WINDOW_BITS] = 1;
      return 'new';
    }
    if (-ahead >= WINDOW_BITS) {
      return 'old';
    }
    const slot = seq % WINDOW_BITS;
    if (this.#seen[slot]) {
      return 'dup';
    }
    this.#seen[slot] = 1;
    return 'new';
  }

  top(): number | null {
    return this.#top;
  }
}
