// Handler of the log assertion op (packages/protocol/src/ops/logs.ts; spec 09 §9.4 Logs, design c6 §6 S4):
// logs_assert. logs_read and wait_for_log stay in ops.ts with the C1 ops. Spread into HANDLERS
// (packages/hub/src/ops.ts).
//
// The lines after `since` from the selected devices are read in cursor order, the backlog first and then
// live ones as they arrive: each `expect` pattern must match a line of its own, in the order given, and no
// `forbid` pattern may match a line before the last expected one has. A line is checked against the
// forbidden patterns first, so a line that matches both fails the assertion. Device text stays in the
// data fields (09 §9.2): the failure message names patterns and cursors only, its details carry the lines.
//
// A device the hub hears only over Wi-Fi (net_log, design m2-c2 D21) never sends panic, bootloader or D/V lines
// (logs/source.ts): a `forbid` checked against it passes without having seen what it forbids, so the result
// carries a warning naming the devices and the crash check that works there.

import { FrError, type LogsOpName, parseCursor } from '@fractonica/protocol';

import type { Handler, HubContext, OpInput } from '../context.ts';
import { mintCursor, mintTimeUs } from '../events/index.ts';
import { staleNetLine, type StoredLine, toLogLine } from '../logstore.ts';
import { TCP_CRASH_CHECK, TCP_LOG_LIMITS, tcpOnlyDevices } from './source.ts';

/** A line that matched a pattern, as the result and the failure details list it. */
export interface LogMatch {
  pattern: string;
  cursor: string;
  device: string;
  text: string;
}

/** The backlog is read in pages of this many lines. */
const PAGE = 5000;

/** Parses `since` and rejects cursors from an earlier hub run (spec 08 §8.7), as wait_for_log does. */
function sinceSeq(since: string, hub: HubContext): number {
  const c = parseCursor(since);
  if (!c) {
    throw new FrError('INVALID_ARGS', `bad cursor ${since}; expected c:<run>.<seq>`);
  }
  if (c.run !== hub.logs.run) {
    throw new FrError('HUB_RESTARTED', `cursor ${since} is from an earlier hub run`, { details: { resume_cursor: mintCursor(hub) } });
  }
  return c.seq;
}

function matcher(pattern: string, regex: boolean): (text: string) => boolean {
  if (!regex) {
    return (text) => text.includes(pattern);
  }
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch (e) {
    throw new FrError('INVALID_ARGS', `bad regex ${JSON.stringify(pattern)}: ${(e as Error).message}`);
  }
  return (text) => re.test(text);
}

export async function assertLogs(
  hub: HubContext,
  input: OpInput<'logs_assert'>,
): Promise<{ matched: LogMatch[]; forbidden: LogMatch[]; warnings?: string[] }> {
  const after = sinceSeq(input.since, hub);
  // A net line logged before the cursor was minted but sent late is neither expected nor forbidden (design m2-c2 D21).
  const sinceUs = mintTimeUs(hub, after);
  // ops.ts spreads this module's handlers into HANDLERS, so its selector rules are loaded when called.
  const { logDevices } = await import('../ops.ts');
  const devices = logDevices(hub, input.selector);
  const expect = input.expect.map((p) => ({ pattern: p, test: matcher(p, input.regex) }));
  const forbid = (input.forbid ?? []).map((p) => ({ pattern: p, test: matcher(p, input.regex) }));
  const matched: LogMatch[] = [];
  const forbidden: LogMatch[] = [];
  // Devices heard over TCP alone at the start or the end of the wait (a reboot may change it in between).
  const tcpOnly = new Set(tcpOnlyDevices(hub, devices));
  const hit = (pattern: string, l: StoredLine): LogMatch => {
    const { cursor, device, text } = toLogLine(l);
    return { pattern, cursor, device, text };
  };
  /** Checks one line; true once the assertion is decided (every pattern matched, or a forbidden one). */
  const step = (l: StoredLine): boolean => {
    if (staleNetLine(l, sinceUs)) {
      return false;
    }
    const bad = forbid.find((f) => f.test(l.text));
    if (bad) {
      forbidden.push(hit(bad.pattern, l));
      return true;
    }
    const next = expect[matched.length];
    if (next.test(l.text)) {
      matched.push(hit(next.pattern, l));
    }
    return matched.length === expect.length;
  };

  let lastSeen = after;
  let done = false;
  const queue: StoredLine[] = [];
  let wake: (() => void) | null = null;
  // Subscribed before the backlog is read, so no line falls between the two; the queue keeps what
  // arrives while the backlog pages are checked, and lastSeen drops the ones read twice.
  const unsubscribe = hub.logs.subscribe((l) => {
    if (!devices || devices.includes(l.device)) {
      queue.push(l);
      wake?.();
    }
  });
  try {
    let rows: StoredLine[];
    do {
      rows = hub.logs.query({ devices, afterSeq: lastSeen, limit: PAGE, direction: 'forward' });
      for (const l of rows) {
        lastSeen = l.seq;
        if ((done = step(l))) {
          break;
        }
      }
    } while (!done && rows.length === PAGE);
    const deadline = Date.now() + input.timeout_s * 1000;
    while (!done) {
      const l = queue.shift();
      if (l) {
        if (l.seq > lastSeen) {
          lastSeen = l.seq;
          done = step(l);
        }
        continue;
      }
      const left = deadline - Date.now();
      if (left <= 0) {
        break;
      }
      let timer: NodeJS.Timeout | undefined;
      await new Promise<void>((r) => {
        wake = r;
        timer = setTimeout(r, left);
      });
      wake = null;
      clearTimeout(timer);
    }
  } finally {
    unsubscribe();
  }

  for (const d of tcpOnlyDevices(hub, devices)) {
    tcpOnly.add(d);
  }
  const wifiOnly = [...tcpOnly].join(', ');
  const warnings =
    tcpOnly.size && forbid.length
      ? [`${wifiOnly}: ${TCP_LOG_LIMITS}, so forbid ${JSON.stringify(forbid.map((f) => f.pattern))} saw only what came over Wi-Fi; ${TCP_CRASH_CHECK}`]
      : [];
  if (forbidden.length === 0 && matched.length === expect.length) {
    return { matched, forbidden, ...(warnings.length ? { warnings } : {}) };
  }
  const tail = hub.logs.query({ devices, afterSeq: after, limit: 20, direction: 'tail' }).map((l) => l.text);
  const details = {
    matched,
    forbidden,
    tail,
    ...(forbidden.length ? {} : { missing: expect[matched.length].pattern, index: matched.length }),
    ...(warnings.length ? { warnings } : {}),
  };
  const message = forbidden.length
    ? `forbidden ${JSON.stringify(forbidden[0].pattern)} matched a line (${forbidden[0].cursor}) after ${matched.length} of ${expect.length} expected lines`
    : `no line matching ${JSON.stringify(expect[matched.length].pattern)} (expected ${matched.length + 1} of ${expect.length}) within ${input.timeout_s}s`;
  throw new FrError('ASSERTION_FAILED', message, {
    details,
    // An expected line that never came from a device heard over Wi-Fi alone may be one that never comes that way.
    ...(!forbidden.length && tcpOnly.size ? { hint: `${wifiOnly}: ${TCP_LOG_LIMITS}` } : {}),
    remediation: [{ tool: 'logs_read', args: { selector: input.selector, since: input.since } }],
  });
}

export const LOGS_HANDLERS: Record<LogsOpName, Handler> = {
  logs_assert: (input: OpInput<'logs_assert'>, hub) => assertLogs(hub, input),
};
