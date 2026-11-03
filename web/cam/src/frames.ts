// Bounded bookkeeping for web/cam's live view (src/main.ts), kept out of the DOM so it is tested on its own: the
// frames-per-second window, the stream's counters (frames, bytes, the board's drops as jumps of index, the hub's gaps as
// jumps of seq, the last frame's age), the decode gate that drops a frame while the previous one is still decoding (a
// slow tab never queues bitmaps), and the text helpers the readouts use. Nothing here grows with the time since the
// page last drew: a background tab (no animation frames) stays bounded.

/** Events in the last `windowS` seconds, counted in `bins` time bins: O(1) add, O(bins) count, fixed memory. */
export class FpsWindow {
  readonly windowS: number;
  #binS: number;
  #counts: Float64Array;
  #bin: Float64Array;

  constructor(windowS = 1, bins = 10) {
    this.windowS = windowS;
    this.#binS = windowS / bins;
    this.#counts = new Float64Array(bins);
    this.#bin = new Float64Array(bins).fill(-Infinity);
  }

  /** One frame at `t` seconds. */
  add(t: number, n = 1): void {
    const b = Math.floor(t / this.#binS);
    const i = ((b % this.#counts.length) + this.#counts.length) % this.#counts.length;
    if (this.#bin[i] !== b) {
      this.#bin[i] = b;
      this.#counts[i] = 0;
    }
    this.#counts[i] += n;
  }

  /** Frames in the window ending at `now`. */
  count(now: number): number {
    const head = Math.floor(now / this.#binS);
    const oldest = head - this.#counts.length + 1;
    let n = 0;
    for (let i = 0; i < this.#counts.length; i++) {
      if (this.#bin[i] >= oldest && this.#bin[i] <= head) {
        n += this.#counts[i];
      }
    }
    return n;
  }

  /** Frames per second over the window ending at `now`. */
  fps(now: number): number {
    return this.count(now) / this.windowS;
  }

  clear(): void {
    this.#counts.fill(0);
    this.#bin.fill(-Infinity);
  }
}

/** The head of one frame, as the stream's accounting needs it (a JpegBlock has these). */
export interface FrameHead {
  seq: number;
  index: number;
  width: number;
  height: number;
  bytes: number;
}

/** The stream as the page sees it: counters, the last frame, fps over the last second. */
export class FrameStats {
  streamId: number | null = null;
  frames = 0;
  bytes = 0;
  /** Frames the board dropped (jumps of index between consecutive blocks). */
  dropped = 0;
  /** Blocks the hub did not send this page (jumps of seq). */
  gaps = 0;
  /** The last frame's receipt time (seconds, the page's clock), null before the first. */
  lastAt: number | null = null;
  lastBytes = 0;
  lastWidth = 0;
  lastHeight = 0;
  readonly window: FpsWindow;
  #nextSeq: number | null = null;
  #nextIndex: number | null = null;

  constructor(windowS = 1) {
    this.window = new FpsWindow(windowS, 10);
  }

  reset(streamId: number | null): void {
    this.streamId = streamId;
    this.frames = this.bytes = this.dropped = this.gaps = 0;
    this.lastAt = null;
    this.lastBytes = this.lastWidth = this.lastHeight = 0;
    this.#nextSeq = this.#nextIndex = null;
    this.window.clear();
  }

  /** One block received at `now` seconds. */
  add(b: FrameHead, now: number): void {
    if (this.#nextSeq !== null && this.#nextIndex !== null) {
      const missing = (b.index - this.#nextIndex) >>> 0;
      if (b.seq !== this.#nextSeq) {
        this.gaps += Math.max(0, (b.seq - this.#nextSeq) >>> 0);
      }
      // A jump of index past the expected one is the board's drop (frames it took that never left it), whether or
      // not the hub also skipped blocks for this socket.
      if (missing < 0x80000000) {
        this.dropped += missing;
      }
    }
    this.#nextSeq = (b.seq + 1) >>> 0;
    this.#nextIndex = (b.index + 1) >>> 0;
    this.frames++;
    this.bytes += b.bytes;
    this.lastAt = now;
    this.lastBytes = b.bytes;
    this.lastWidth = b.width;
    this.lastHeight = b.height;
    this.window.add(now);
  }

  /** Seconds since the last frame, null before the first. */
  age(now: number): number | null {
    return this.lastAt === null ? null : Math.max(0, now - this.lastAt);
  }

  fps(now: number): number {
    return this.window.fps(now);
  }
}

/**
 * The decode gate: one frame decodes at a time, a frame that arrives while one is in flight is dropped (counted), never
 * queued. `begin()` claims the gate (false: busy, the frame is dropped), `end()` releases it. `dropped` counts the
 * frames this page skipped; `pending` says whether a decode runs now.
 */
export class DecodeGate {
  #busy = false;
  dropped = 0;
  decoded = 0;

  get pending(): boolean {
    return this.#busy;
  }

  begin(): boolean {
    if (this.#busy) {
      this.dropped++;
      return false;
    }
    this.#busy = true;
    return true;
  }

  end(): void {
    if (this.#busy) {
      this.#busy = false;
      this.decoded++;
    }
  }

  reset(): void {
    this.#busy = false;
    this.dropped = 0;
    this.decoded = 0;
  }
}

/**
 * The delays between the page's live-view restarts: `minMs` after a stream that worked, then doubling after each failure
 * (a start the hub refused, a stream that ended before it delivered a frame) up to `maxMs`.
 */
export class RestartBackoff {
  readonly minMs: number;
  readonly maxMs: number;
  #failures = 0;

  constructor(o: { minMs?: number; maxMs?: number } = {}) {
    this.minMs = o.minMs ?? 1500;
    this.maxMs = o.maxMs ?? 30_000;
  }

  get failures(): number {
    return this.#failures;
  }

  get nextMs(): number {
    return Math.min(this.maxMs, this.minMs * 2 ** Math.min(this.#failures, 30));
  }

  /** A restart after a failure: its delay, counted so the next waits longer. */
  fail(): number {
    const ms = this.nextMs;
    this.#failures++;
    return ms;
  }

  succeed(): void {
    this.#failures = 0;
  }
}

/** The canvas size that keeps the frame's aspect inside `maxW` × `maxH` (never upscaled past the frame). */
export function fitFrame(width: number, height: number, maxW: number, maxH: number): { w: number; h: number } {
  if (width <= 0 || height <= 0) {
    return { w: 0, h: 0 };
  }
  const scale = Math.min(1, maxW / width, maxH / height);
  return { w: Math.max(1, Math.round(width * scale)), h: Math.max(1, Math.round(height * scale)) };
}

/** `12.3 KB`, `1.20 MB`, `512 B`. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) {
    return '–';
  }
  if (n < 1024) {
    return `${n} B`;
  }
  if (n < 1024 * 1024) {
    return `${(n / 1024).toFixed(1)} KB`;
  }
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/** `0.8 s`, `12 ms`, `3 min`, or `–` for null. */
export function formatAge(s: number | null): string {
  if (s === null || !Number.isFinite(s)) {
    return '–';
  }
  if (s < 1) {
    return `${Math.round(s * 1000)} ms`;
  }
  if (s < 90) {
    return `${s.toFixed(1)} s`;
  }
  return `${Math.round(s / 60)} min`;
}

/** `12.5` fps with one decimal; `0` when none. */
export function formatFps(fps: number): string {
  return fps >= 10 ? fps.toFixed(0) : fps.toFixed(1);
}

/** A stamp for a downloaded frame's file name: `cam-esp32-20261103-141501.jpg`. */
export function frameFileName(alias: string, at: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${alias}-${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}.jpg`;
}
