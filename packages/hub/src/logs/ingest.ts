// LOG frames over TCP into the log store (design m2-c2 D21, spec 05 §5.7): the router decodes a LOG frame's
// LOG.LINE after its window check (a failure counts log_bad) and hands it here, with what the store needs to stamp
// it: the device, the link, the arrival time and the session's TIME sync (the line's own esp_log ms becomes
// t_log_us through it). The ingest keeps a per-device rate cap and appends the line as port `tcp`, source `net`,
// where the LogStore dedups it against the serial copy of the same line.
//
// t_log_us. The `(ms)` of `I (ms) tag: …` is esp_log_timestamp(), not the esp_timer µs the TIME sync maps: a u32
// that wraps after 2^32 ms (49.7 days), and on target (LOG v1, RTOS source) the cycle-counter ms at the scheduler's
// start plus the tick count, which runs ahead of esp_timer by the time before esp_timer starts (the bootloader:
// about 0.15 to 0.6 s on the bench's C3, C6 and S3). The stamp cannot change: the dedup pairs the serial and TCP
// copies byte for byte. So the ingest unwraps it against the node's clock at arrival, maps it through the TIME sync,
// and takes off how far this boot's esp_log runs ahead: the most any of its lines' mapped stamps lay past their
// arrival (a line is never logged after it arrives, and a live line arrives within milliseconds), per boot epoch.
// The result is never later than the arrival (ts_us). On the host (FakeNode, fr_net_node, fr_fleet) both clocks are
// one and the estimate stays 0.
//
// The node caps itself at 20 lines/s (design m2-c2 D20); the hub's bucket per device is 50 lines/s with as large a
// burst (proposed), so only a node that ignores its own cap loses lines here (log_dropped). A line is the node's
// whole formatted esp_log line, ANSI and line end stripped and valid UTF-8, byte for byte the serial copy: the
// store parses it as it parses a serial line (ESP_LOG_RE), but never as a frame, a boot line or a diag answer.

import type { Header } from '@fractonica/protocol';
import type { LogLineMsg } from '@fractonica/protocol/gen';

import type { LinkName } from '../context.ts';
import { espLogMs, type LogStore } from '../logstore.ts';
import type { ClockView } from '../router/clock.ts';
import type { ScaleCounters } from '../router/scale.ts';

/** One decoded LOG frame from a node, as the router hands it on. */
export interface LogFrame {
  device: string;
  alias: string;
  /** The link it came on: `tcp` from a net_log node (a node sends LOG over nothing else). */
  link: LinkName;
  header: Header;
  /** The esp_log level: the frame's kind, E 1 .. V 5. */
  level: number;
  line: LogLineMsg;
  /** When the envelope arrived, µs since the Unix epoch (the router clock's nowUs). */
  rx_us: number;
  /** The session's TIME sync: node µs since boot <-> hub µs (synced() false until the first burst). */
  clock: ClockView;
}

/** What the router calls for every fresh LOG frame (RouterDeps.logIngest). */
export interface LogIngest {
  frame(f: LogFrame): void;
}

/** Per-device cap (design m2-c2 D21, proposed): lines per second, and the burst a full bucket allows. */
export const LOG_INGEST_PER_S = 50;

/** esp_log's ms stamp is a uint32 (esp_log_timestamp): it wraps after 2^32 ms, 49.7 days of uptime. */
const MS_WRAP = 2 ** 32;
/**
 * The most a boot's esp_log stamp is taken to run ahead of its esp_timer. The bench's bootloaders take at most about
 * 0.6 s; a larger sample (a poor TIME sync) counts as this much, so the estimate can never make a new line look older
 * than the waits' 1 s slack (NET_LINE_SLACK_US) allows.
 */
export const LOG_AHEAD_MAX_US = 1_000_000;

/**
 * The full node ms of a u32 esp_log stamp seen when the node's clock read `nodeNowMs`: the value congruent to it
 * mod 2^32 nearest to that, in RFC 1982 order (NodeClock.unwrap does the same for a u32 µs).
 */
export function unwrapLogMs(ms: number, nodeNowMs: number): number {
  const low = ((nodeNowMs % MS_WRAP) + MS_WRAP) % MS_WRAP;
  let behind = (low - ms + MS_WRAP) % MS_WRAP;
  if (behind >= MS_WRAP / 2) {
    behind -= MS_WRAP;
  }
  return nodeNowMs - behind;
}

/**
 * A line's esp_log stamp on the hub clock, as the session's TIME sync maps it once unwrapped against the node's
 * clock at its arrival `rxUs` (hub µs); null for another shape, a stamp no u32 holds, or an unsynced clock.
 */
export function stampHubUs(text: string, clock: Pick<ClockView, 'synced' | 'toHub' | 'toNode'>, rxUs: number): number | null {
  const ms = espLogMs(text);
  if (ms === null || ms >= MS_WRAP || !clock.synced()) {
    return null;
  }
  const full = unwrapLogMs(ms, Math.floor(clock.toNode(rxUs) / 1000));
  return clock.toHub(full * 1000);
}

/**
 * A line's own time on the hub clock (t_log_us): its stamp (stampHubUs) less `aheadUs`, how far its boot's esp_log
 * runs ahead of the esp_timer the TIME sync maps, and never later than its arrival `rxUs`; null as stampHubUs.
 */
export function lineTimeUs(text: string, clock: Pick<ClockView, 'synced' | 'toHub' | 'toNode'>, rxUs: number, aheadUs = 0): number | null {
  const at = stampHubUs(text, clock, rxUs);
  return at === null ? null : Math.round(Math.min(rxUs, at - aheadUs));
}

/** The ingest over `logs`, counting into `counters` (one per router process, router/scale.ts). */
export function createLogIngest(logs: LogStore, counters: ScaleCounters, opts: { perS?: number } = {}): LogIngest {
  const perS = opts.perS ?? LOG_INGEST_PER_S;
  // The store drops a serial or net copy of a line it already has: hub_status shows those as logs_dup.
  logs.countInto(counters);
  const buckets = new Map<string, { tokens: number; atUs: number }>();
  /** Per device: how far its esp_log stamp runs ahead of its esp_timer in the boot `epoch` (see the header). */
  const ahead = new Map<string, { epoch: number | undefined; us: number }>();
  const tLog = (f: LogFrame): number | null => {
    const at = stampHubUs(f.line.text, f.clock, f.rx_us);
    if (at === null) {
      return null;
    }
    const epoch = f.header?.epoch;
    let a = ahead.get(f.device);
    if (!a || a.epoch !== epoch) {
      a = { epoch, us: 0 };
      ahead.set(f.device, a);
    }
    a.us = Math.max(a.us, Math.min(at - f.rx_us, LOG_AHEAD_MAX_US));
    return Math.round(Math.min(f.rx_us, at - a.us));
  };
  /** One line's token from the device's bucket (refilled by the frames' own arrival times). */
  const take = (device: string, atUs: number): boolean => {
    let b = buckets.get(device);
    if (!b) {
      b = { tokens: perS, atUs };
      buckets.set(device, b);
    }
    b.tokens = Math.min(perS, b.tokens + (Math.max(0, atUs - b.atUs) / 1e6) * perS);
    b.atUs = Math.max(b.atUs, atUs);
    if (b.tokens < 1) {
      return false;
    }
    b.tokens -= 1;
    return true;
  };
  return {
    frame(f: LogFrame): void {
      counters.log_frames++;
      if (typeof f?.line?.text !== 'string' || typeof f.device !== 'string') {
        return; // nothing to store (the router hands only decoded frames)
      }
      if (!take(f.device, f.rx_us)) {
        counters.log_dropped++;
        return;
      }
      if (!f.line.text.trim()) {
        return; // blank: a serial port stores none either
      }
      logs.append(f.device, f.link, f.line.text, { source: 'net', ts_us: f.rx_us, t_log_us: tLog(f) });
    },
  };
}
