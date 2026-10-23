// Handler of the log assertion op (packages/protocol/src/ops/logs.ts; spec 09 §9.4 Logs, design c6 §6 S4):
// logs_assert. logs_read and wait_for_log stay in ops.ts with the C1 ops. Spread into HANDLERS
// (packages/hub/src/ops.ts).
//
// The lines after `since` from the selected devices are read in cursor order, the backlog first and then
// live ones as they arrive: each `expect` pattern must match a line of its own, in the order given, and no
// `forbid` pattern may match a line before the last expected one has. A line is checked against the
// forbidden patterns first, so a line that matches both fails the assertion. Device text stays in the
// data fields (09 §9.2): the failure message names patterns and cursors only, its details carry the lines.

import { FrError, type LogsOpName, parseCursor } from '@fractonica/protocol';

import type { Handler, HubContext, OpInput } from '../context.ts';
import { mintCursor } from '../events/index.ts';
import { type StoredLine, toLogLine } from '../logstore.ts';

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

export async function assertLogs(hub: HubContext, input: OpInput<'logs_assert'>): Promise<{ matched: LogMatch[]; forbidden: LogMatch[] }> {
  const after = sinceSeq(input.since, hub);
  // ops.ts spreads this module's handlers into HANDLERS, so its selector rules are loaded when called.
  const { logDevices } = await import('../ops.ts');
  const devices = logDevices(hub, input.selector);
  const expect = input.expect.map((p) => ({ pattern: p, test: matcher(p, input.regex) }));
  const forbid = (input.forbid ?? []).map((p) => ({ pattern: p, test: matcher(p, input.regex) }));
  const matched: LogMatch[] = [];
  const forbidden: LogMatch[] = [];
  const hit = (pattern: string, l: StoredLine): LogMatch => {
    const { cursor, device, text } = toLogLine(l);
    return { pattern, cursor, device, text };
  };
  /** Checks one line; true once the assertion is decided (every pattern matched, or a forbidden one). */
  const step = (l: StoredLine): boolean => {
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

  if (forbidden.length === 0 && matched.length === expect.length) {
    return { matched, forbidden };
  }
  const tail = hub.logs.query({ devices, afterSeq: after, limit: 20, direction: 'tail' }).map((l) => l.text);
  const details = { matched, forbidden, tail, ...(forbidden.length ? {} : { missing: expect[matched.length].pattern, index: matched.length }) };
  const message = forbidden.length
    ? `forbidden ${JSON.stringify(forbidden[0].pattern)} matched a line (${forbidden[0].cursor}) after ${matched.length} of ${expect.length} expected lines`
    : `no line matching ${JSON.stringify(expect[matched.length].pattern)} (expected ${matched.length + 1} of ${expect.length}) within ${input.timeout_s}s`;
  throw new FrError('ASSERTION_FAILED', message, {
    details,
    remediation: [{ tool: 'logs_read', args: { selector: input.selector, since: input.since } }],
  });
}

export const LOGS_HANDLERS: Record<LogsOpName, Handler> = {
  logs_assert: (input: OpInput<'logs_assert'>, hub) => assertLogs(hub, input),
};
