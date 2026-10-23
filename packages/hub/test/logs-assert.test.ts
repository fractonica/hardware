// logs_assert (spec 09 §9.4 Logs, design c6 §6 S4): ordered expected patterns and a forbid list over the
// lines after a cursor, backlog and live.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { exitCodeFor, formatCursor, type FrError } from '@fractonica/protocol';

import { type Db, openDb } from '../src/db.ts';
import { LogStore } from '../src/logstore.ts';
import { HANDLERS, type HubContext } from '../src/ops.ts';
import { SerialPortManager } from '../src/serial.ts';

const A = '1cdbd416ba34';
const B = '9c9e6e40cc10';

let dir: string;
const open: { db: Db; logs: LogStore }[] = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'fr-logs-assert-'));
});
afterEach(() => {
  for (const { db, logs } of open.splice(0)) {
    logs.close(); // its 50 ms flush timer must not outlive the db
    db.close();
  }
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function setup(): { logs: LogStore; hub: HubContext; line(text: string, device?: string): void } {
  const db = openDb(join(dir, `hub-${open.length}-${Math.random().toString(36).slice(2)}.db`));
  const logs = new LogStore(db, 3, { retention: false });
  open.push({ db, logs });
  const hub = { db, logs, serial: new SerialPortManager(logs, db) } as unknown as HubContext;
  return { logs, hub, line: (text, device = A) => void logs.append(device, '/dev/cu.usbmodem1', text) };
}

type Out = { matched: { pattern: string; cursor: string; device: string; text: string }[]; forbidden: unknown[] };

const assertLogs = (hub: HubContext, input: Record<string, unknown>) =>
  HANDLERS.logs_assert({ selector: A, regex: false, timeout_s: 0.1, ...input }, hub) as Promise<Out>;

async function failure(p: Promise<unknown>): Promise<FrError> {
  try {
    await p;
  } catch (e) {
    return e as FrError;
  }
  throw new Error('expected the assertion to fail');
}

describe('logs_assert', () => {
  it('matches the expected patterns in order, each on a line of its own', async () => {
    const { logs, hub, line } = setup();
    line('before the cursor: fr: ready');
    const since = logs.head();
    line('I (10) fr: boot');
    line('I (11) fr: ready id=1');
    line('I (12) app: tick');
    line('I (13) app: tick');
    const r = await assertLogs(hub, { since, expect: ['fr: ready', 'app: tick', 'app: tick'] });
    expect(r.forbidden).toEqual([]);
    expect(r.matched.map((m) => [m.pattern, m.text, m.device])).toEqual([
      ['fr: ready', 'I (11) fr: ready id=1', A],
      ['app: tick', 'I (12) app: tick', A],
      ['app: tick', 'I (13) app: tick', A],
    ]);
    expect(r.matched[0].cursor).toBe(formatCursor({ run: 3, seq: 3 }));
  });

  it('fails with ASSERTION_FAILED (exit 6) naming the first pattern still missing', async () => {
    const { logs, hub, line } = setup();
    const since = logs.head();
    line('I (1) app: second');
    line('I (2) app: first');
    const e = await failure(assertLogs(hub, { since, expect: ['app: first', 'app: second'] }));
    expect(e.code).toBe('ASSERTION_FAILED');
    expect(exitCodeFor(e.code)).toBe(6);
    expect(e.message).toContain('"app: second" (expected 2 of 2)');
    expect(e.details).toMatchObject({ missing: 'app: second', index: 1, tail: ['I (1) app: second', 'I (2) app: first'] });
    expect((e.details as { matched: unknown[] }).matched).toHaveLength(1);
    expect(e.remediation).toEqual([{ tool: 'logs_read', args: { selector: A, since } }]);
  });

  it('waits for live lines until timeout_s', async () => {
    const { logs, hub, line } = setup();
    const since = logs.head();
    line('I (1) fr: boot');
    const p = assertLogs(hub, { since, expect: ['fr: boot', 'fr: ready'], timeout_s: 5 });
    setTimeout(() => line('I (2) fr: ready', B), 20); // another device: not selected
    setTimeout(() => line('I (3) fr: ready'), 60);
    const t0 = Date.now();
    const r = await p;
    expect(r.matched.map((m) => m.text)).toEqual(['I (1) fr: boot', 'I (3) fr: ready']);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('fails as soon as a forbidden pattern matches before the last expected line', async () => {
    const { logs, hub, line } = setup();
    const since = logs.head();
    line('I (1) fr: boot');
    line('Guru Meditation Error: Core 0 panic');
    line('I (3) fr: ready');
    const e = await failure(assertLogs(hub, { since, expect: ['fr: boot', 'fr: ready'], forbid: ['Guru Meditation', 'abort()'], timeout_s: 30 }));
    expect(e.code).toBe('ASSERTION_FAILED');
    expect(e.message).toContain('forbidden "Guru Meditation"');
    expect(e.message).not.toContain('Core 0 panic'); // device text stays in the data fields
    expect((e.details as { forbidden: { pattern: string; text: string }[] }).forbidden).toEqual([
      expect.objectContaining({ pattern: 'Guru Meditation', text: 'Guru Meditation Error: Core 0 panic' }),
    ]);
  });

  it('ignores forbidden patterns after the last expected line, and fails a line that matches both', async () => {
    const { logs, hub, line } = setup();
    const since = logs.head();
    line('I (1) fr: ready');
    line('E (2) app: error later');
    expect((await assertLogs(hub, { since, expect: ['fr: ready'], forbid: ['error'] })).matched).toHaveLength(1);
    const since2 = logs.head();
    line('E (3) fr: ready with error');
    expect((await failure(assertLogs(hub, { since: since2, expect: ['fr: ready'], forbid: ['error'] }))).details).toMatchObject({
      forbidden: [expect.objectContaining({ pattern: 'error' })],
    });
  });

  it('takes regular expressions with regex, and rejects a bad one', async () => {
    const { logs, hub, line } = setup();
    const since = logs.head();
    line('I (1) fr: ready id=pad-c3 fw=1a2b');
    const r = await assertLogs(hub, { since, expect: ['ready id=\\S+ fw=[0-9a-f]{4}$'], regex: true });
    expect(r.matched).toHaveLength(1);
    expect((await failure(assertLogs(hub, { since, expect: ['('], regex: true }))).code).toBe('INVALID_ARGS');
    // Without regex the pattern is a plain substring.
    expect((await failure(assertLogs(hub, { since, expect: ['ready id=\\S+'] }))).code).toBe('ASSERTION_FAILED');
  });

  it('reads past the first backlog page, and every device without a selector', async () => {
    const { logs, hub, line } = setup();
    const since = logs.head();
    for (let i = 0; i < 6000; i++) {
      line(`I (${i}) app: tick`, i % 2 ? A : B);
    }
    line('I (9) fr: last', B);
    logs.flush();
    const r = await assertLogs(hub, { selector: 'all', since, expect: ['app: tick', 'fr: last'] });
    expect(r.matched[1]).toMatchObject({ device: B, text: 'I (9) fr: last' });
  });

  it('rejects cursors from an earlier hub run and unknown selectors', async () => {
    const { hub } = setup();
    expect((await failure(assertLogs(hub, { since: 'c:2.5', expect: ['x'] }))).code).toBe('HUB_RESTARTED');
    expect((await failure(assertLogs(hub, { since: 'c:3.0', expect: ['x'], selector: 'pad-nope' }))).code).toBe('NOT_FOUND');
  });
});
