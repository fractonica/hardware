// Device log lines with a hub-wide monotonic cursor (spec 08 §8.3, §8.7). Lines are appended and
// published synchronously; SQLite writes are batched every 50 ms.

import { formatCursor, type LogLine } from '@fractonica/protocol';

import type { Db } from './db.ts';

export interface StoredLine {
  seq: number;
  run: number;
  ts_us: number;
  device: string;
  port: string;
  level: string | null;
  tag: string | null;
  kind: 'esp_log' | 'raw' | 'boot';
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

export function parseLine(raw: string): Pick<StoredLine, 'level' | 'tag' | 'kind' | 'text'> {
  const text = raw.replace(ANSI_RE, '').replace(/\r$/, '');
  const m = ESP_LOG_RE.exec(text);
  if (m) {
    return { level: m[1], tag: m[3], kind: 'esp_log', text };
  }
  return { level: null, tag: null, kind: BOOT_RE.test(text) ? 'boot' : 'raw', text };
}

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

  constructor(db: Db, run: number) {
    this.#db = db;
    this.run = run;
    const row = db.prepare('SELECT MAX(seq) AS m FROM logs').get() as { m: number | null };
    this.#nextSeq = (row.m ?? 0) + 1;
  }

  /** Cursor of the newest line (or of "nothing yet" in this run). */
  head(): string {
    return formatCursor({ run: this.run, seq: this.#nextSeq - 1 });
  }

  headSeq(): number {
    return this.#nextSeq - 1;
  }

  append(device: string, port: string, raw: string): StoredLine {
    const line: StoredLine = { seq: this.#nextSeq++, run: this.run, ts_us: nowUs(), device, port, ...parseLine(raw) };
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
