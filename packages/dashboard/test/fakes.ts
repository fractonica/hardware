// Test doubles for the dashboard's pure modules: a scripted WebSocket, manual timers and event builders.

import type { HubEvent, LogLine, WsClientFrame } from '@fractonica/protocol/browser';

import type { Timers, WsLike } from '../src/api/ws.ts';

export class FakeWs implements WsLike {
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readonly sent: WsClientFrame[] = [];
  closed: { code?: number; reason?: string } | null = null;
  readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as WsClientFrame);
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }

  // ---- the hub's side ----

  open(): void {
    this.onopen?.({});
  }

  frame(f: object | string): void {
    this.onmessage?.({ data: typeof f === 'string' ? f : JSON.stringify(f) });
  }

  hello(run: number, head = `c:${run}.0`): void {
    this.frame({ t: 'hello', v: 1, run, head, version: '0.1.0', registry_hash: 'abc123' });
  }

  /** The server closes (or the network drops). */
  drop(code = 1006): void {
    this.onclose?.({ code, reason: '' });
  }

  subs(): Extract<WsClientFrame, { op: 'sub' }>[] {
    return this.sent.filter((f): f is Extract<WsClientFrame, { op: 'sub' }> => f.op === 'sub');
  }
}

/** Timers run by hand: `advance(ms)` fires what is due, in time order. */
export class ManualTimers implements Timers {
  now = 0;
  #seq = 0;
  readonly #due = new Map<number, { at: number; fn: () => void }>();

  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.#seq;
    this.#due.set(id, { at: this.now + ms, fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.#due.delete(handle as number);
  }

  /** Pending timer delays from now, sorted. */
  pending(): number[] {
    return [...this.#due.values()].map((t) => t.at - this.now).sort((a, b) => a - b);
  }

  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const e of this.#due) {
        if (e[1].at <= end && (!next || e[1].at < next[1].at || (e[1].at === next[1].at && e[0] < next[0]))) {
          next = e;
        }
      }
      if (!next) {
        break;
      }
      this.#due.delete(next[0]);
      this.now = next[1].at;
      next[1].fn();
    }
    this.now = end;
  }
}

/** A hub event of run `run` with seq `seq`. */
export function ev(seq: number, type = 'boot.down', extra: Partial<HubEvent> = {}, run = 1): HubEvent {
  return { cursor: `c:${run}.${seq}`, seq, type, device: 'aabbccddeeff', alias: 'pad-c6', t_hub_us: 1_700_000_000_000_000 + seq, ...extra };
}

export function logLine(seq: number, text = `line ${seq}`, run = 1): LogLine {
  return { cursor: `c:${run}.${seq}`, ts: '2026-10-22T10:00:00.000Z', device: 'aabbccddeeff', port: '/dev/cu.usbmodem1', kind: 'esp_log', text };
}

/** Lets pending promise callbacks run. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}
