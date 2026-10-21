// The event bus and store (design c3 §4, stream H2; spec 08 §8.7). publish() runs in the receive tick:
// it takes the cursor from the Seq that logs share, notifies subscribers synchronously, and queues the
// row; rows are written to the `events` table in one transaction every 50 ms, off the input path. The
// table is a ring trimmed like logs (main.ts runs a RingRetention on it). The store also remembers when
// cursors were handed out (mintCursor), which dates a wait's `since` (09 §9.2).

import { formatCursor } from '@fractonica/protocol';

import type { Events, HubContext, HubEvent, Lifecycle, Seq } from '../context.ts';
import type { Db } from '../db.ts';
import { nowUs } from '../ring.ts';
import { sqliteGlob } from './match.ts';

export { matchType, matchTypes, matchWhere, parseTypes } from './match.ts';

export interface EventQuery {
  afterSeq?: number;
  types?: string[];
  /** null (or absent) is every device, hub events included; [] matches nothing. */
  devices?: string[] | null;
  limit: number;
}

interface Row {
  seq: number;
  run: number;
  ts_us: number;
  t_hub_us: number;
  type: string;
  device: string | null;
  json: string;
}

/** What `json` holds: the event without the columns (seq, run, type, device, t_hub_us) and its cursor. */
type Body = Omit<HubEvent, 'cursor' | 'seq' | 'type' | 'device' | 't_hub_us'>;

const FLUSH_MS = 50;
/** Cursors whose mint time is kept (the newest distinct seqs handed out); older ones are dated by rows. */
const MINTS_KEPT = 1024;

export class EventStore implements Events, Lifecycle {
  readonly run: number;
  #db: Db;
  #seq: Seq;
  #pending: Row[] = [];
  #timer: NodeJS.Timeout | null = null;
  #listeners = new Set<(e: HubEvent) => void>();
  /** seq -> when that cursor was first handed out (µs since the Unix epoch), oldest first. */
  #mints = new Map<number, number>();

  constructor(db: Db, seq: Seq, run: number) {
    this.#db = db;
    this.#seq = seq;
    this.run = run;
  }

  start(): void {}

  /** Writes what is queued; call before the db closes. */
  stop(): void {
    this.flush();
  }

  publish(e: Omit<HubEvent, 'cursor' | 'seq'>): HubEvent {
    const seq = this.#seq.next();
    const event: HubEvent = { ...e, seq, cursor: formatCursor({ run: this.run, seq }) };
    const { cursor: _c, seq: _s, type, device, t_hub_us, ...body } = event;
    this.#pending.push({ seq, run: this.run, ts_us: nowUs(), t_hub_us: Math.round(t_hub_us), type, device: device ?? null, json: JSON.stringify(body) });
    this.#timer ??= setTimeout(() => this.flush(), FLUSH_MS);
    for (const fn of this.#listeners) {
      try {
        fn(event);
      } catch (err) {
        // A failing subscriber must not cost the others (or the input path) their event.
        console.error(JSON.stringify({ event: 'event_subscriber_failed', message: (err as Error).message }));
      }
    }
    return event;
  }

  subscribe(fn: (e: HubEvent) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /**
   * The cursor at `seq` was handed out now. The first time counts: on a quiet hub one cursor is handed out
   * again and again, and a wait since it must not drop what followed its first mint.
   */
  noteMint(seq: number, atUs = nowUs()): void {
    if (this.#mints.has(seq)) {
      return;
    }
    this.#mints.set(seq, atUs);
    if (this.#mints.size > MINTS_KEPT) {
      this.#mints.delete(this.#mints.keys().next().value!);
    }
  }

  /** When the cursor at `seq` was first handed out (µs since the Unix epoch); null when not recorded. */
  mintedAtUs(seq: number): number | null {
    return this.#mints.get(seq) ?? null;
  }

  flush(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (!this.#pending.length || !this.#db.open) {
      return;
    }
    const rows = this.#pending;
    this.#pending = [];
    const insert = this.#db.prepare('INSERT INTO events (seq, run, ts_us, t_hub_us, type, device, json) VALUES (@seq, @run, @ts_us, @t_hub_us, @type, @device, @json)');
    this.#db.transaction((all: Row[]) => {
      for (const r of all) {
        insert.run(r);
      }
    })(rows);
  }

  /** Oldest first, after `afterSeq`. */
  query(q: EventQuery): HubEvent[] {
    return this.#select(q, 'ASC');
  }

  /** The newest `limit` events (after `afterSeq` if given), oldest first. */
  tail(q: EventQuery): HubEvent[] {
    return this.#select(q, 'DESC').reverse();
  }

  #select(q: EventQuery, order: 'ASC' | 'DESC'): HubEvent[] {
    this.flush();
    const where: string[] = [];
    const args: unknown[] = [];
    if (q.devices) {
      if (!q.devices.length) {
        return [];
      }
      where.push(`device IN (${q.devices.map(() => '?').join(',')})`);
      args.push(...q.devices);
    }
    if (q.afterSeq !== undefined) {
      where.push('seq > ?');
      args.push(q.afterSeq);
    }
    if (q.types?.length) {
      where.push(`(${q.types.map(() => 'type GLOB ?').join(' OR ')})`);
      args.push(...q.types.map(sqliteGlob));
    }
    const sql = `SELECT seq, run, t_hub_us, type, device, json FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY seq ${order} LIMIT ?`;
    return (this.#db.prepare(sql).all(...args, q.limit) as Row[]).map(toEvent);
  }
}

function toEvent(r: Pick<Row, 'seq' | 'run' | 't_hub_us' | 'type' | 'device' | 'json'>): HubEvent {
  let body: Body = {};
  try {
    body = JSON.parse(r.json) as Body;
  } catch {
    // A row this code did not write: keep the columns.
  }
  return {
    cursor: formatCursor({ run: r.run, seq: r.seq }),
    seq: r.seq,
    type: r.type,
    ...(r.device !== null ? { device: r.device } : {}),
    t_hub_us: r.t_hub_us,
    ...body,
  };
}

export function createEvents(db: Db, seq: Seq, run: number): EventStore {
  return new EventStore(db, seq, run);
}

/** The newest events through any Events (tail reads need the store; another implementation pages forward). */
export function tailEvents(events: Events, q: EventQuery): HubEvent[] {
  if (events instanceof EventStore) {
    return events.tail(q);
  }
  return events.query(q).slice(-q.limit);
}

/**
 * The head cursor, recorded as handed out now: ops return their cursors through this, so a wait since one
 * is dated by when it was handed out (mintTimeUs).
 */
export function mintCursor(hub: Pick<HubContext, 'logs' | 'events'>): string {
  const seq = hub.logs.headSeq();
  if (hub.events instanceof EventStore) {
    hub.events.noteMint(seq);
  }
  return formatCursor({ run: hub.logs.run, seq });
}

/**
 * When the cursor `seq` was minted (µs since the Unix epoch), for the waits' "no stale matches" (09 §9.2):
 * the time it was first handed out when the store recorded that (mintCursor), never earlier than the
 * newest row at or before it. The rows alone can be far older on a quiet hub (heartbeats store nothing).
 */
export function mintTimeUs(hub: Pick<HubContext, 'db' | 'events'>, seq: number): number {
  const minted = hub.events instanceof EventStore ? hub.events.mintedAtUs(seq) : null;
  return Math.max(cursorTimeUs(hub.db, seq), minted ?? 0);
}

/**
 * When the cursor `seq` was minted, as well as the tables can tell: the hub receive time of the newest
 * log line or event at or before it (0 when there is none); a lower bound of the mint time (mintTimeUs).
 */
export function cursorTimeUs(db: Db, seq: number): number {
  const row = db
    .prepare(
      `SELECT MAX(ts) AS ts FROM (
         SELECT ts_us AS ts FROM (SELECT ts_us FROM logs WHERE seq <= ? ORDER BY seq DESC LIMIT 1)
         UNION ALL
         SELECT ts_us AS ts FROM (SELECT ts_us FROM events WHERE seq <= ? ORDER BY seq DESC LIMIT 1))`,
    )
    .get(seq, seq) as { ts: number | null };
  return row.ts ?? 0;
}
