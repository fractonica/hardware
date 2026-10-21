// Fuzz case generator shared by the *.fuzz.test.ts suites (T-CODEC, spec 05 §5.18). The scheme is
// identical to firmware/test/host/fuzz/main.cpp, so a failing case index found on one side replays
// on the other: xorshift32 seeded with FNV-1a 32 of the target name, then per case either a mutation
// of a corpus entry or a random buffer.

import { appendFileSync } from 'node:fs';

/** Cases per target: FR_FUZZ_N, default 10^4 in the normal suite (`pnpm test:fuzz` sets 10^6). */
export function fuzzN(): number {
  const n = Number(process.env.FR_FUZZ_N ?? 10_000);
  return Number.isInteger(n) && n > 0 ? n : 10_000;
}

/** Vitest timeout for a fuzz test: generous, since 10^6 cases take a while. */
export function fuzzTimeout(n = fuzzN()): number {
  return Math.max(10_000, n / 5);
}

/**
 * Publishes a target's digest for the cross-language comparison: printed in the fr_host_fuzz line format
 * when the case count is not the suite default (or FR_FUZZ_PRINT is set), and appended to the file named
 * by FR_FUZZ_DIGESTS, which `node tools/host-test.mjs --fuzz N --expect <file>` (the `pnpm test:fuzz`
 * gate) checks the C++ digests against. One short append per line, so parallel workers do not interleave.
 */
export function reportDigest(target: string, n: number, digest: number): void {
  const line = `${target} ${n} cases  digest ${(digest >>> 0).toString(16).padStart(8, '0')}\n`;
  if (n !== 10_000 || process.env.FR_FUZZ_PRINT) {
    process.stderr.write(line);
  }
  if (process.env.FR_FUZZ_DIGESTS) {
    appendFileSync(process.env.FR_FUZZ_DIGESTS, line);
  }
}

export function fnv1a32(text: string): number {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(text)) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function xorshift32(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x;
  };
}

const MAX_RANDOM_LEN = 256;

function mutate(base: Uint8Array, rng: () => number): Uint8Array {
  const buf = Array.from(base);
  const ops = 1 + (rng() % 4);
  for (let k = 0; k < ops; k++) {
    const op = rng() % 5;
    if (op === 2) {
      const i = rng() % (buf.length + 1);
      const v = rng() & 0xff;
      buf.splice(i, 0, v);
      continue;
    }
    if (buf.length === 0) {
      continue;
    }
    const i = rng() % buf.length;
    if (op === 0) {
      buf[i] ^= 1 << (rng() % 8);
    } else if (op === 1) {
      buf[i] = rng() & 0xff;
    } else if (op === 3) {
      buf.splice(i, 1);
    } else {
      buf.length = i;
    }
  }
  return Uint8Array.from(buf);
}

/** Yields `n` inputs for `target`. */
export function* fuzzCases(target: string, n: number, corpus: readonly Uint8Array[] = []): Generator<Uint8Array> {
  const rng = xorshift32(fnv1a32(target));
  for (let c = 0; c < n; c++) {
    if (corpus.length > 0 && rng() & 1) {
      yield mutate(corpus[rng() % corpus.length], rng);
    } else {
      const len = rng() % (MAX_RANDOM_LEN + 1);
      const buf = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        buf[i] = rng() & 0xff;
      }
      yield buf;
    }
  }
}

/** Bytes as a Latin-1 string, so line decoders see every byte value. */
export function latin1(b: Uint8Array): string {
  let s = '';
  for (const x of b) {
    s += String.fromCharCode(x);
  }
  return s;
}

export function hexOf(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}
