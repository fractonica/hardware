// Device log lines with a hub-wide monotonic cursor (spec 08 §8.3, §8.7). Lines are appended and
// published synchronously; SQLite writes are batched every 50 ms. The table is a ring trimmed to the
// retention limits (spec 08 §8.8) in small batches off a timer.

import { formatCursor, SERIAL_PREFIX, type LogKind, type LogLine } from '@fractonica/protocol';

import { type Db, kvGet } from './db.ts';
import type { FrameDecoder } from './frames.ts';

export interface StoredLine {
  seq: number;
  run: number;
  ts_us: number;
  device: string;
  port: string;
  level: string | null;
  tag: string | null;
  kind: LogKind;
  text: string;
}

export interface LogQuery {
  devices: string[] | null;
  afterSeq?: number;
  limit: number;
  minLevel?: string;
  grep?: string;
  direction: 'tail' | 'forward';
}

const LEVELS = ['E', 'W', 'I', 'D', 'V'];
// ESP_LOG format: "I (1234) tag: message"; ROM/bootloader lines are kept as raw.
const ESP_LOG_RE = /^([EWIDV]) \((\d+)\) ([^:]+): ?(.*)$/;
const ANSI_RE = /\x1b\[[0-9;]*m/g;

export const stripAnsi = (s: string): string => s.replace(ANSI_RE, '');
const BOOT_RE = /^(ESP-ROM:|Build:|rst:0x|boot:0x|SPIWP:|mode:|load:0x|entry 0x|Saved PC:)/;
// fr_diag response on the serial command channel (design c2 §5): `#<id> {...}`.
const DIAG_RE = /^#\d{1,8} [{]/;

export function parseLine(raw: string): Pick<StoredLine, 'level' | 'tag' | 'kind' | 'text'> {
  const text = raw.replace(ANSI_RE, '').replace(/\r$/, '');
  const m = ESP_LOG_RE.exec(text);
  if (m) {
    return { level: m[1], tag: m[3], kind: 'esp_log', text };
  }
  return { level: null, tag: null, kind: BOOT_RE.test(text) ? 'boot' : DIAG_RE.test(text) ? 'diag' : 'raw', text };
}

/** Ring defaults (spec 08 §8.8); kv `logs.retention_days` / `logs.retention_rows` override them. */
export const LOG_RETENTION = { days: 7, rows: 1_000_000 };
const PRUNE_FIRST_MS = 5_000;
const PRUNE_EVERY_MS = 60_000;
const PRUNE_BATCH = 5_000;

export function nowUs(): number {
  return Math.round(performance.timeOrigin * 1000 + performance.now() * 1000);
}

export class LogStore {
  readonly run: number;
  #db: Db;
  #nextSeq: number;
  #pending: StoredLine[] = [];
  #timer: NodeJS.Timeout | null = null;
  #listeners = new Set<(line: StoredLine) => void>();
  #pruneTimers: NodeJS.Timeout[] = [];
  #pruning = false;
  #frames: FrameDecoder | null;

  /** `frames` decodes `@fr1:` lines into readable text; without it they are stored raw. */
  constructor(db: Db, run: number, opts: { retention?: boolean; frames?: FrameDecoder } = {}) {
    this.#db = db;
    this.run = run;
    this.#frames = opts.frames ?? null;
    const row = db.prepare('SELECT MAX(seq) AS m FROM logs').get() as { m: number | null };
    this.#nextSeq = (row.m ?? 0) + 1;
    if (opts.retention !== false) {
      // Unref'd: retention never keeps the process alive, and prune() stops once the db is closed.
      const tick = () => void this.prune().catch((e: Error) => console.error(JSON.stringify({ event: 'logs_prune_failed', message: e.message })));
      this.#pruneTimers = [setTimeout(tick, PRUNE_FIRST_MS).unref(), setInterval(tick, PRUNE_EVERY_MS).unref()];
    }
  }

  /** Stops retention and writes pending lines; call before closing the db. */
  close(): void {
    for (const t of this.#pruneTimers) {
      clearTimeout(t);
    }
    this.#pruneTimers = [];
    this.flush();
  }

  /** Cursor of the newest line (or of "nothing yet" in this run). */
  head(): string {
    return formatCursor({ run: this.run, seq: this.#nextSeq - 1 });
  }

  headSeq(): number {
    return this.#nextSeq - 1;
  }

  append(device: string, port: string, raw: string): StoredLine {
    const parsed = parseLine(raw);
    if (this.#frames && parsed.kind === 'raw' && parsed.text.startsWith(SERIAL_PREFIX)) {
      Object.assign(parsed, this.#frames.format(device, parsed.text));
    } else if (this.#frames && parsed.kind === 'esp_log') {
      this.#frames.observe(device, parsed.text);
    }
    const line: StoredLine = { seq: this.#nextSeq++, run: this.run, ts_us: nowUs(), device, port, ...parsed };
    this.#pending.push(line);
    this.#timer ??= setTimeout(() => this.flush(), 50);
    for (const fn of this.#listeners) {
      fn(line);
    }
    return line;
  }

  subscribe(fn: (line: StoredLine) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  flush(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (!this.#pending.length) {
      return;
    }
    const rows = this.#pending;
    this.#pending = [];
    const insert = this.#db.prepare(
      'INSERT INTO logs (seq, run, ts_us, device, port, level, tag, kind, text) VALUES (@seq, @run, @ts_us, @device, @port, @level, @tag, @kind, @text)',
    );
    this.#db.transaction((all: StoredLine[]) => {
      for (const r of all) {
        insert.run(r);
      }
    })(rows);
  }

  /** Whether any line was ever stored under this device key, so a detached device stays readable. */
  hasDevice(device: string): boolean {
    this.flush();
    return this.#db.prepare('SELECT 1 FROM logs WHERE device = ? LIMIT 1').get(device) !== undefined;
  }

  retention(): { days: number; rows: number } {
    const num = (k: string, fallback: number) => {
      const v = Number(kvGet(this.#db, k));
      return Number.isFinite(v) && v > 0 ? v : fallback;
    };
    return { days: num('logs.retention_days', LOG_RETENTION.days), rows: num('logs.retention_rows', LOG_RETENTION.rows) };
  }

  /**
   * Trims the ring, oldest first, to the newest `rows` seqs and the last `days` days. Works in
   * batches of PRUNE_BATCH rows and yields between them, so a large backlog never stalls serial
   * ingestion or HTTP behind one long DELETE. Resolves with the number of rows deleted.
   */
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
    // Look only at the oldest PRUNE_BATCH rows (a bounded rowid range scan) and delete through the
    // newest of them that is past either limit.
    const cut = this.#db
      .prepare('SELECT MAX(seq) AS s FROM (SELECT seq, ts_us FROM logs ORDER BY seq LIMIT ?) WHERE seq <= ? OR ts_us < ?')
      .get(PRUNE_BATCH, this.headSeq() - rows, Math.round(nowUs() - days * 86_400e6)) as { s: number | null };
    return cut.s === null ? 0 : this.#db.prepare('DELETE FROM logs WHERE seq <= ?').run(cut.s).changes;
  }

  query(q: LogQuery): StoredLine[] {
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
    if (q.minLevel) {
      const allowed = LEVELS.slice(0, LEVELS.indexOf(q.minLevel) + 1);
      where.push(`level IN (${allowed.map(() => '?').join(',')})`);
      args.push(...allowed);
    }
    if (q.grep) {
      where.push('instr(text, ?) > 0');
      args.push(q.grep);
    }
    const order = q.direction === 'forward' ? 'ASC' : 'DESC';
    const sql = `SELECT * FROM logs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY seq ${order} LIMIT ?`;
    const rows = this.#db.prepare(sql).all(...args, q.limit) as StoredLine[];
    return q.direction === 'forward' ? rows : rows.reverse();
  }
}

export function toLogLine(l: StoredLine): LogLine {
  return {
    cursor: formatCursor({ run: l.run, seq: l.seq }),
    ts: new Date(Math.floor(l.ts_us / 1000)).toISOString(),
    device: l.device,
    port: l.port,
    ...(l.level ? { level: l.level } : {}),
    ...(l.tag ? { tag: l.tag } : {}),
    kind: l.kind,
    text: l.text,
  };
}
