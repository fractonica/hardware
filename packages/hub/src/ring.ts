// Ring retention for the cursor-indexed tables `logs` and `events` (spec 08 §8.8): the newest `rows`
// cursors and the last `days` days are kept; kv `<table>.retention_days` / `<table>.retention_rows`
// override the defaults. Logs and events share one cursor space (Seq), so the row limit bounds the cursor
// span: each table keeps at most `rows` rows, both together at most `rows` as well. Trimming runs off a
// timer in small batches and yields between them, so a large backlog never stalls serial ingestion,
// node links or HTTP behind one long DELETE.

import { type Db, kvGet } from './db.ts';

export interface Retention {
  days: number;
  rows: number;
}

/** Ring defaults (spec 08 §8.8): 7 days, 1M rows. */
export const RING_RETENTION: Retention = { days: 7, rows: 1_000_000 };

const PRUNE_FIRST_MS = 5_000;
const PRUNE_EVERY_MS = 60_000;
const PRUNE_BATCH = 5_000;

export function nowUs(): number {
  return Math.round(performance.timeOrigin * 1000 + performance.now() * 1000);
}

export class RingRetention {
  #db: Db;
  #table: 'logs' | 'events';
  #head: () => number;
  #timers: NodeJS.Timeout[] = [];
  #pruning = false;

  /** `head`: the newest cursor seq (Seq.head()); rows at or below `head - rows` are trimmed. */
  constructor(db: Db, table: 'logs' | 'events', head: () => number) {
    this.#db = db;
    this.#table = table;
    this.#head = head;
  }

  /** Prunes 5 s after start, then every minute. Unref'd: retention never keeps the process alive. */
  start(): void {
    if (this.#timers.length > 0) {
      return;
    }
    const tick = () =>
      void this.prune().catch((e: Error) => console.error(JSON.stringify({ event: `${this.#table}_prune_failed`, message: e.message })));
    this.#timers = [setTimeout(tick, PRUNE_FIRST_MS).unref(), setInterval(tick, PRUNE_EVERY_MS).unref()];
  }

  stop(): void {
    for (const t of this.#timers) {
      clearTimeout(t);
    }
    this.#timers = [];
  }

  retention(): Retention {
    const num = (k: string, fallback: number) => {
      const v = Number(kvGet(this.#db, k));
      return Number.isFinite(v) && v > 0 ? v : fallback;
    };
    return {
      days: num(`${this.#table}.retention_days`, RING_RETENTION.days),
      rows: num(`${this.#table}.retention_rows`, RING_RETENTION.rows),
    };
  }

  /** Trims the ring, oldest first, in batches; stops once the db is closed. Resolves with the rows deleted. */
  async prune(): Promise<number> {
    if (this.#pruning) {
      return 0;
    }
    this.#pruning = true;
    let total = 0;
    try {
      while (this.#db.open) {
        const n = this.#pruneBatch();
        total += n;
        if (n < PRUNE_BATCH) {
          break;
        }
        await new Promise((r) => setImmediate(r));
      }
    } finally {
      this.#pruning = false;
    }
    return total;
  }

  #pruneBatch(): number {
    const { days, rows } = this.retention();
    // Look only at the oldest PRUNE_BATCH rows (a bounded rowid range scan) and delete through the newest
    // of them that is past either limit.
    const t = this.#table;
    const cut = this.#db
      .prepare(`SELECT MAX(seq) AS s FROM (SELECT seq, ts_us FROM ${t} ORDER BY seq LIMIT ?) WHERE seq <= ? OR ts_us < ?`)
      .get(PRUNE_BATCH, this.#head() - rows, Math.round(nowUs() - days * 86_400e6)) as { s: number | null };
    return cut.s === null ? 0 : this.#db.prepare(`DELETE FROM ${t} WHERE seq <= ?`).run(cut.s).changes;
  }
}
