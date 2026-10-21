// Device log lines with a hub-wide monotonic cursor (spec 08 §8.3, §8.7). Lines are appended and
// published synchronously; SQLite writes are batched every 50 ms. Seqs come from the cursor space the
// lines share with events (seq.ts); the table is a ring trimmed to the retention limits (ring.ts).

import { formatCursor, SERIAL_PREFIX, type LogKind, type LogLine } from '@fractonica/protocol';

import type { Seq } from './context.ts';
import type { Db } from './db.ts';
import type { FrameDecoder } from './frames.ts';
import { nowUs, RING_RETENTION, RingRetention, type Retention } from './ring.ts';
import { CursorSeq } from './seq.ts';

export { nowUs } from './ring.ts';

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
export const LOG_RETENTION: Retention = RING_RETENTION;

export class LogStore {
  readonly run: number;
  #db: Db;
  #seq: Seq;
  #pending: StoredLine[] = [];
  #timer: NodeJS.Timeout | null = null;
  #listeners = new Set<(line: StoredLine) => void>();
  #ring: RingRetention;
  #frames: FrameDecoder | null;

  /**
   * `frames` decodes `@fr1:` lines into readable text; without it they are stored raw. `seq` is the
   * cursor space shared with events; by default one of the store's own (over both tables).
   */
  constructor(db: Db, run: number, opts: { retention?: boolean; frames?: FrameDecoder; seq?: Seq } = {}) {
    this.#db = db;
    this.run = run;
    this.#frames = opts.frames ?? null;
    this.#seq = opts.seq ?? new CursorSeq(db);
    this.#ring = new RingRetention(db, 'logs', () => this.#seq.head());
    if (opts.retention !== false) {
      this.#ring.start();
    }
  }

  /** Stops retention and writes pending lines; call before closing the db. */
  close(): void {
    this.#ring.stop();
    this.flush();
  }

  /** Cursor of the newest line or event (or of "nothing yet" in this run). */
  head(): string {
    return formatCursor({ run: this.run, seq: this.#seq.head() });
  }

  headSeq(): number {
    return this.#seq.head();
  }

  append(device: string, port: string, raw: string): StoredLine {
    const parsed = parseLine(raw);
    if (this.#frames && parsed.kind === 'raw' && parsed.text.startsWith(SERIAL_PREFIX)) {
      Object.assign(parsed, this.#frames.format(device, parsed.text));
    } else if (this.#frames && parsed.kind === 'esp_log') {
      this.#frames.observe(device, parsed.text);
    }
    const line: StoredLine = { seq: this.#seq.next(), run: this.run, ts_us: nowUs(), device, port, ...parsed };
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

  retention(): Retention {
    return this.#ring.retention();
  }

  /** Trims the ring now (ring.ts); resolves with the number of rows deleted. */
  prune(): Promise<number> {
    return this.#ring.prune();
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
