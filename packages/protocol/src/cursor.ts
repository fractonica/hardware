// Cursors are "c:<hub_run>.<seq>" (spec 08 §8.7). hub_run increments at every hub start;
// seq is monotonic across runs, so cursors from one run compare by seq alone.

export interface Cursor {
  run: number;
  seq: number;
}

const CURSOR_RE = /^c:(\d+)\.(\d+)$/;

export function formatCursor(c: Cursor): string {
  return `c:${c.run}.${c.seq}`;
}

export function parseCursor(s: string): Cursor | null {
  const m = CURSOR_RE.exec(s.trim());
  if (!m) {
    return null;
  }
  return { run: Number(m[1]), seq: Number(m[2]) };
}
