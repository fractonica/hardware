// The hub's own bus events C6 adds (design c6 §5 S2, D19, D29), published into the event store like the
// router's and stored with them:
// - port.attached, port.detached and port.state from the SerialPortManager: after each poll, port_list is
//   compared with the last one (a state change is an event; a new holder alone is not, 09 §9.2);
// - job.state from the JobRunner, on a status or stage change (progress reaches `/ws` only, as `job`
//   frames, so a build's percentages never fill the store);
// - hub.warning `loop_delay` when the event loop's 60 s p99 goes above 5 ms, plus the hub_status line
//   while it stays there. The delay is the router's LoopMonitor (a 20 ms timer, router/latency.ts), not
//   perf_hooks' monitorEventLoopDelay, whose own resolution reads as ~10 ms on an idle loop.
// The WsServer (web/ws.ts) starts them right after it subscribes to the bus.

import type { Job, PortInfo } from '@fractonica/protocol';

import type { HubContext } from '../context.ts';
import type { JobChange } from '../jobs.ts';
import { nowUs } from '../ring.ts';
import { type LoopDelay, routerLoopDelay } from '../router/index.ts';

/** D29: a p99 above this (ms) over the last minute is a warning. */
export const LOOP_DELAY_WARN_MS = 5;
const LOOP_WINDOW_MS = 60_000;
const LOOP_CHECK_MS = 5_000;

/** The port events; a `ports: true` subscription on `/ws` gets these. */
export const PORT_EVENT_TYPES = ['port.attached', 'port.detached', 'port.state', 'port.leased', 'port.released'] as const;

export interface FeedOptions {
  /** The event loop's delay over a window (default: the router's LoopMonitor). */
  loopDelay?: (windowMs: number) => LoopDelay | null;
  loopCheckMs?: number;
}

export interface Feeds {
  start(): void;
  stop(): void;
  /** hub_status lines: the loop-delay warning while it lasts. */
  warnings(): string[];
}

/** A port's identity across polls: its USB serial (the chip MAC), else its path. */
function portKey(p: PortInfo): string {
  return p.usb_serial ?? p.path;
}

export function createFeeds(hub: () => HubContext, opts: FeedOptions = {}): Feeds {
  const loopDelay = opts.loopDelay ?? ((ms: number) => routerLoopDelay(hub().router, ms));
  const offs: (() => void)[] = [];
  let ports = new Map<string, PortInfo>();
  let loopTimer: NodeJS.Timeout | null = null;
  let slowP99: number | null = null;

  /** The registry's alias of a port's device, when it has one. */
  const aliasOf = (deviceId: string | undefined): string | undefined => {
    if (!deviceId) {
      return undefined;
    }
    try {
      return hub().registry?.get(deviceId)?.alias;
    } catch {
      return undefined;
    }
  };

  const publish = (type: string, fields: Record<string, unknown>, deviceId?: string) => {
    const alias = aliasOf(deviceId);
    hub().events.publish({ type, ...(deviceId ? { device: deviceId } : {}), ...(alias ? { alias } : {}), t_hub_us: nowUs(), fields });
  };

  const portsChanged = () => {
    const now = new Map(hub().serial.list().map((p) => [portKey(p), p]));
    for (const [key, p] of now) {
      const before = ports.get(key);
      if (!before) {
        publish('port.attached', { path: p.path, usb_serial: key, ...(p.device_id ? { device_id: p.device_id } : {}) }, p.device_id);
      } else if (before.state !== p.state) {
        publish('port.state', { path: p.path, state: p.state, ...(p.holder ? { holder: p.holder } : {}) }, p.device_id);
      }
    }
    for (const [key, p] of ports) {
      if (!now.has(key)) {
        publish('port.detached', { path: p.path, usb_serial: key }, p.device_id);
      }
    }
    ports = now;
  };

  const jobChanged = (job: Job, change: JobChange) => {
    if (change === 'progress') {
      return;
    }
    publish('job.state', {
      job_id: job.job_id,
      kind: job.kind,
      status: job.status,
      ...(job.stage ? { stage: job.stage } : {}),
      targets: job.targets,
      ...(job.origin ? { origin: job.origin } : {}),
    });
  };

  const checkLoop = () => {
    const p99 = loopDelay(LOOP_WINDOW_MS)?.p99_ms ?? null;
    const slow = p99 !== null && p99 > LOOP_DELAY_WARN_MS;
    if (slow && slowP99 === null) {
      publish('hub.warning', {
        code: 'loop_delay',
        p99_ms: p99,
        hint: 'the hub event loop is slowed (a sync SQLite write, a heavy op, or the Mac under load): input latency rises with it',
      });
    }
    slowP99 = slow ? p99 : null;
  };

  return {
    start() {
      const { serial, jobs } = hub();
      // Test hubs pass partial parts: a serial or job runner without the hooks has no feed.
      if (typeof serial?.onChange === 'function') {
        offs.push(serial.onChange(portsChanged));
      }
      if (typeof jobs?.onChange === 'function') {
        offs.push(jobs.onChange(jobChanged));
      }
      loopTimer = setInterval(checkLoop, opts.loopCheckMs ?? LOOP_CHECK_MS);
      loopTimer.unref();
    },
    stop() {
      for (const off of offs.splice(0)) {
        off();
      }
      if (loopTimer) {
        clearInterval(loopTimer);
        loopTimer = null;
      }
    },
    warnings() {
      return slowP99 === null
        ? []
        : [`event loop delay p99 ${slowP99} ms over the last 60 s (above ${LOOP_DELAY_WARN_MS} ms): node frames wait that long before the hub handles them`];
    },
  };
}
