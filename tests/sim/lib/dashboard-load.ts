// The dashboard's load on the private hub during a sim run (design m2-c2 D16): one live client on `/ws` subscribed as
// the dashboard's runtime subscribes (every event and every job, packages/dashboard/src/runtime.ts), and one REST
// poller replaying the devices page: device_list every 10 s (pages/devices.tsx), and again after each 50 ms burst of
// events that makes it stale (state/invalidate.ts: device.* and registry.* invalidate device_list, device_get and
// latency_stats; port.* port_list and device_list). The tiles read device_list's summary since S3 (no device_get per
// tile), so the poller sends none. Its figures (frames, gaps, refetches and their p99) are published with each run,
// T2-INPUT-30's `/ws` gaps among them.

import { WS_PATH } from '@fractonica/protocol';

import type { Hub } from '../../e2e/lib/hub.ts';

/** The dashboard's event batch (runtime.ts EVENT_BATCH_MS) and devices page poll. */
export const EVENT_BATCH_MS = 50;
export const POLL_MS = 10_000;

/** Which ops an event makes stale, by its type (state/invalidate.ts's rules for the devices page). */
export function staleOps(type: string): string[] {
  if (type.startsWith('device.') || type.startsWith('registry.')) {
    return ['device_list', 'device_get', 'latency_stats'];
  }
  if (type.startsWith('port.')) {
    return ['port_list', 'device_list'];
  }
  if (type === 'hub.prompt' || type === 'hub.prompt_done' || type === 'hub.warning') {
    return ['hub_status'];
  }
  return [];
}

export interface DashboardFigures {
  ws: { connected: boolean; frames: number; events: number; jobs: number; gaps: number; errors: number; closes: number };
  rest: Record<string, { count: number; failed: number; p99_ms: number | null; max_ms: number | null }>;
  /** Refetches an event burst caused (the invalidation rule at work). */
  invalidations: number;
}

const p99 = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(0.99 * xs.length) - 1)] : null);

export class DashboardLoad {
  readonly #hub: Hub;
  readonly #ws: { connected: boolean; frames: number; events: number; jobs: number; gaps: number; errors: number; closes: number } = {
    connected: false,
    frames: 0,
    events: 0,
    jobs: 0,
    gaps: 0,
    errors: 0,
    closes: 0,
  };
  readonly #times = new Map<string, { ms: number[]; failed: number }>();
  #socket: WebSocket | null = null;
  #poll: NodeJS.Timeout | null = null;
  #batch: NodeJS.Timeout | null = null;
  #stale = new Set<string>();
  #invalidations = 0;
  #stopped = false;

  private constructor(hub: Hub) {
    this.#hub = hub;
  }

  /** Connects the live client and starts the poller; never throws (a failed socket counts as an error). */
  static start(hub: Hub, o: { pollMs?: number } = {}): DashboardLoad {
    const d = new DashboardLoad(hub);
    d.#connect();
    d.#poll = setInterval(() => void d.#fetch('device_list'), o.pollMs ?? POLL_MS);
    d.#poll.unref();
    void d.#fetch('device_list');
    return d;
  }

  #connect(): void {
    try {
      const ws = new WebSocket(`${this.#hub.url.replace(/^http/, 'ws')}${WS_PATH}`);
      this.#socket = ws;
      ws.onmessage = (m) => this.#frame(String(m.data));
      ws.onerror = () => this.#ws.errors++;
      ws.onclose = () => {
        this.#ws.connected = false;
        this.#ws.closes++;
      };
    } catch {
      this.#ws.errors++;
    }
  }

  #frame(text: string): void {
    this.#ws.frames++;
    let f: { t?: string; e?: { type?: string }; type?: string };
    try {
      f = JSON.parse(text) as typeof f;
    } catch {
      return;
    }
    if (f.t === 'hello') {
      this.#ws.connected = true;
      this.#socket?.send(JSON.stringify({ op: 'sub', id: 'app', events: {}, jobs: true }));
    } else if (f.t === 'ev') {
      this.#ws.events++;
      const type = f.e?.type ?? f.type ?? '';
      for (const op of staleOps(type)) {
        this.#stale.add(op);
      }
      this.#batch ??= setTimeout(() => this.#flush(), EVENT_BATCH_MS);
    } else if (f.t === 'job') {
      this.#ws.jobs++;
    } else if (f.t === 'gap') {
      this.#ws.gaps++;
    } else if (f.t === 'err') {
      this.#ws.errors++;
    }
  }

  /** The burst's stale ops the devices page holds: device_list is the one it refetches (no device_get per tile). */
  #flush(): void {
    this.#batch = null;
    if (this.#stale.has('device_list')) {
      this.#invalidations++;
      void this.#fetch('device_list');
    }
    this.#stale.clear();
  }

  async #fetch(op: string): Promise<void> {
    if (this.#stopped) {
      return;
    }
    const t0 = performance.now();
    const r = await this.#hub.call(op, {}, 10_000).catch(() => ({ ok: false }));
    const rec = this.#times.get(op) ?? { ms: [], failed: 0 };
    rec.ms.push(performance.now() - t0);
    if (!r.ok) {
      rec.failed++;
    }
    this.#times.set(op, rec);
  }

  figures(): DashboardFigures {
    const rest: DashboardFigures['rest'] = {};
    for (const [op, r] of this.#times) {
      const v = p99(r.ms);
      rest[op] = { count: r.ms.length, failed: r.failed, p99_ms: v === null ? null : Math.round(v * 10) / 10, max_ms: r.ms.length ? Math.round(Math.max(...r.ms) * 10) / 10 : null };
    }
    return { ws: { ...this.#ws }, rest, invalidations: this.#invalidations };
  }

  /** Stops polling and closes the socket; the figures so far. */
  stop(): DashboardFigures {
    this.#stopped = true;
    clearInterval(this.#poll ?? undefined);
    clearTimeout(this.#batch ?? undefined);
    try {
      this.#socket?.close();
    } catch {
      // closed already
    }
    return this.figures();
  }
}
