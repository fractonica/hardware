// What the audio tests share (design audio-a1; stream H): a sine, a peak-frequency search (Goertzel over a band of
// candidate frequencies), and a raw-socket record POST as a board sends it (chunked, one block per chunk), with the
// option to cut the bytes into arbitrary TCP writes.

import { connect } from 'node:net';

/** `n` samples of a sine at `hz` and amplitude `amp` (s16 units) sampled at `rate`, starting at sample `from`. */
export function sine(n: number, hz: number, rate: number, amp = 12000, from = 0): Int16Array {
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = Math.round(amp * Math.sin((2 * Math.PI * hz * (from + i)) / rate));
  }
  return out;
}

/** The power of `x` at `hz` (Goertzel). */
export function goertzel(x: ArrayLike<number>, hz: number, rate: number): number {
  const w = (2 * Math.PI * hz) / rate;
  const c = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < x.length; i++) {
    const s = x[i] + c * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return s1 * s1 + s2 * s2 - c * s1 * s2;
}

/** The frequency in [lo, hi] (step `step` Hz) where `x` has the most power. */
export function peakHz(x: ArrayLike<number>, rate: number, lo = 50, hi = rate / 2 - 50, step = 1): number {
  let best = lo;
  let bestP = -1;
  for (let f = lo; f <= hi; f += step) {
    const p = goertzel(x, f, rate);
    if (p > bestP) {
      bestP = p;
      best = f;
    }
  }
  return best;
}

/** One block as the board frames it: 8-byte head (seq, first_sample, u32 LE) and s16le PCM. */
export function block(seq: number, firstSample: number, pcm: Int16Array): Buffer {
  const b = Buffer.alloc(8 + pcm.length * 2);
  b.writeUInt32LE(seq, 0);
  b.writeUInt32LE(firstSample, 4);
  Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).copy(b, 8);
  return b;
}

/** A chunk of chunked transfer coding around `data`. */
export function chunk(data: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${data.length.toString(16)}\r\n`), data, Buffer.from('\r\n')]);
}

export const LAST_CHUNK = Buffer.from('0\r\n\r\n');

export interface PostOptions {
  device: string;
  rate?: number;
  /** Extra or replacing header lines. */
  headers?: Record<string, string>;
  /** Cut the bytes into writes of this size (default: one write per chunk). */
  writeEvery?: number;
  /** Send the zero chunk at the end (default true); false closes the connection without it. */
  end?: boolean;
  /** Wait this long between the head and the first chunk (a board's mic still warming up). */
  firstDelayMs?: number;
}

/** A raw record POST: the head, then `body` (chunks already framed); resolves with the status and body once the hub closes. */
export function rawPost(port: number, path: string, body: Buffer[], o: PostOptions): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = {
    Host: '127.0.0.1',
    'Transfer-Encoding': 'chunked',
    'X-Fr-Device': o.device,
    'X-Fr-Format': `s16le;rate=${o.rate ?? 16000};ch=1`,
    Connection: 'close',
    ...o.headers,
  };
  const head = `POST ${path} HTTP/1.1\r\n${Object.entries(headers)
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${k}: ${v}\r\n`)
    .join('')}\r\n`;
  const parts = [Buffer.from(head), ...body, ...(o.end === false ? [] : [LAST_CHUNK])];
  return new Promise((resolve, reject) => {
    const s = connect(port, '127.0.0.1');
    let got = Buffer.alloc(0);
    s.on('data', (d: Buffer) => (got = Buffer.concat([got, d])));
    s.on('error', (e) => (got.length ? undefined : reject(e)));
    s.on('close', () => {
      const text = got.toString('latin1');
      const m = /^HTTP\/1\.1 (\d{3})/.exec(text);
      const at = text.indexOf('\r\n\r\n');
      resolve({ status: m ? Number(m[1]) : 0, body: at >= 0 ? text.slice(at + 4) : '' });
    });
    s.on('connect', async () => {
      if (o.firstDelayMs) {
        s.write(parts.shift()!);
        await new Promise((r) => setTimeout(r, o.firstDelayMs));
      }
      const all = Buffer.concat(parts);
      if (o.writeEvery) {
        for (let i = 0; i < all.length; i += o.writeEvery) {
          s.write(all.subarray(i, i + o.writeEvery));
          await new Promise((r) => setImmediate(r));
        }
      } else {
        for (const p of parts) {
          s.write(p);
          await new Promise((r) => setImmediate(r));
        }
      }
      if (o.end === false) {
        s.end();
      }
    });
  });
}

/** `seconds` of a sine at `hz` as framed blocks of `blockMs`, the blocks whose index `skip` says left out (a gap). */
export function sineBlocks(seconds: number, hz: number, rate: number, o: { blockMs?: number; skip?: (i: number) => boolean } = {}): { chunks: Buffer[]; dropped: number } {
  const per = (rate * (o.blockMs ?? 100)) / 1000;
  const n = Math.round((seconds * 1000) / (o.blockMs ?? 100));
  const chunks: Buffer[] = [];
  let dropped = 0;
  let seq = 0;
  for (let i = 0; i < n; i++) {
    if (o.skip?.(i)) {
      dropped += per;
      continue;
    }
    chunks.push(chunk(block(seq++, i * per, sine(per, hz, rate, 12000, i * per))));
  }
  return { chunks, dropped };
}
