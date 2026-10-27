// Device log lines with a hub-wide monotonic cursor (spec 08 §8.3, §8.7). Lines are appended and
// published synchronously; SQLite writes are batched every 50 ms. Seqs come from the cursor space the
// lines share with events (seq.ts); the table is a ring trimmed to the retention limits (ring.ts).
//
// M2-C2 (design m2-c2 D21): lines have a source. `serial` is a USB port's (SerialPortManager), `net` a node's LOG
// frame over TCP (logs/ingest.ts). A net line is classified as esp_log or stored raw, never `boot` or `diag` and
// never rendered as a frame, so TCP text cannot pose as a serial frame or a diag answer. A node sends each esp_log
// line both ways while it has USB and TCP, so the copies are deduplicated across sources and never within one:
// per device and source, a multiset of the recent esp_log texts not yet matched (60 s, at most 8192 unmatched); a
// line is dropped (logs_dup) only by consuming an unmatched entry of the other source, so a line genuinely printed
// twice (the bootloader's identical lines of a quick reboot) is stored twice. The entries are 64-bit hashes of the
// texts, cut as the node cuts them, each with the line it stands for (what append() answers for a dropped copy). A
// net line also keeps `t_log_us`, its own time on the hub clock (logs/ingest.ts; null while the node's clock is
// unsynced), which LogLine returns: it may arrive up to 30 s late, and the waits skip one logged before their cursor
// (staleNetLine).

import { performance } from 'node:perf_hooks';

import { formatCursor, SERIAL_PREFIX, type LogKind, type LogLine } from '@fractonica/protocol';

import type { Seq } from './context.ts';
import type { Db } from './db.ts';
import type { FrameDecoder } from './frames.ts';
import { nowUs, RING_RETENTION, RingRetention, type Retention } from './ring.ts';
import { scaleWindows } from './router/scale.ts';
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
  /** A net line's own time (its esp_log ms through the session's TIME sync), µs on the hub clock; else null. */
  t_log_us: number | null;
}

/** Where a line came from (design m2-c2 D21): a USB port the hub holds, or a LOG frame over TCP. */
export type LogSource = 'serial' | 'net';

export interface AppendOptions {
  /** Default `serial`. */
  source?: LogSource;
  /** A net line's own time on the hub clock (null: the node's clock is not synced). */
  t_log_us?: number | null;
  /** When it reached the hub (µs since the Unix epoch); default now. */
  ts_us?: number;
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

export function parseLine(raw: string, source: LogSource = 'serial'): Pick<StoredLine, 'level' | 'tag' | 'kind' | 'text'> {
  const text = raw.replace(ANSI_RE, '').replace(/\r$/, '');
  const m = ESP_LOG_RE.exec(text);
  if (m) {
    return { level: m[1], tag: m[3], kind: 'esp_log', text };
  }
  if (source === 'net') {
    return { level: null, tag: null, kind: 'raw', text }; // never boot or diag: TCP text is not the USB channel
  }
  return { level: null, tag: null, kind: BOOT_RE.test(text) ? 'boot' : DIAG_RE.test(text) ? 'diag' : 'raw', text };
}

/** The esp_log ms of `I (1234) tag: msg` (ms since the node booted), or null for another shape. */
export function espLogMs(text: string): number | null {
  const m = ESP_LOG_RE.exec(text);
  return m ? Number(m[2]) : null;
}

/**
 * How far before its cursor a backlog net line may have been logged and still match a wait (design m2-c2 D21). On
 * target t_log_us reads late by esp_log's lead over esp_timer (0.15-0.6 s) until a live line of that boot taught the
 * ingest the lead (logs/ingest.ts), so until then a backlog line logged up to 1 s plus that lead before the cursor
 * still matches; on host nodes the lead is 0.
 */
export const NET_LINE_SLACK_US = 1_000_000;

/**
 * A net line logged more than a second before the cursor `sinceUs` was taken (mintTimeUs): a backlog line sent
 * late, which a wait since that cursor must not take for a new one (wait_for_log, logs_assert).
 */
export function staleNetLine(line: Pick<StoredLine, 't_log_us'>, sinceUs: number): boolean {
  return line.t_log_us !== null && line.t_log_us !== undefined && line.t_log_us < sinceUs - NET_LINE_SLACK_US;
}

/**
 * Dedup window per device and source (design m2-c2 D21): unmatched entries and age. The age bounds the window: a TCP
 * copy comes at most 30 s after its serial copy (the node drops older lines, D20), so 60 s covers it with room.
 * The count only caps memory, and counts only entries still unmatched: the serial set also holds lines that never
 * come over TCP (D/V, the bootloader's), and 8192 is 136 such lines a second for the whole 60 s (512 was 8.5, which
 * a burst during a TCP stall outran, storing the late copies twice).
 */
export const DEDUP_MAX = 8192;
export const DEDUP_MS = 60_000;
/** Entries kept at all, matched ones included, until they reach the head of the queue: a memory bound. */
const DEDUP_KEPT_MAX = DEDUP_MAX * 4;
/** LOG.LINE.text's limit, which the node cuts a line to (on a code point): the serial copy is cut the same way. */
const NET_TEXT_BYTES = 384;

/**
 * The dedup key of an esp_log text: its first 384 bytes of UTF-8 (cut on a code point, as the node cuts its copy)
 * hashed into 64 bits (two FNV-1a lanes). Both copies are already valid text: the serial one decoded with
 * U+FFFD for bad bytes, the net one sanitized the same way on the node.
 */
export function dedupKey(text: string): string {
  let bytes = 0;
  let end = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const n = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (bytes + n > NET_TEXT_BYTES) {
      break;
    }
    bytes += n;
    end += ch.length;
  }
  let a = 0x811c9dc5;
  let b = 0x050c5d1f;
  for (let i = 0; i < end; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x01000193) >>> 0;
    b = (b ^ (b >>> 15)) >>> 0;
  }
  return `${a.toString(16)}:${b.toString(16)}:${end}`;
}

interface UnmatchedEntry {
  key: string;
  at: number;
  /** The line it stands for while unmatched; null once a copy consumed it. */
  line: StoredLine | null;
}

/** One source's esp_log lines not yet matched by the other source's copy, oldest first. */
class Unmatched {
  #fifo: UnmatchedEntry[] = [];
  #head = 0;
  #live = new Map<string, UnmatchedEntry[]>();
  /** Entries not yet matched (the queue also keeps matched ones until they reach its head). */
  #unmatched = 0;

  add(key: string, at: number, line: StoredLine): void {
    const e = { key, at, line };
    this.#fifo.push(e);
    this.#unmatched++;
    const list = this.#live.get(key);
    if (list) {
      list.push(e);
    } else {
      this.#live.set(key, [e]);
    }
  }

  /** Consumes the oldest unmatched entry of `key`: the line it stands for, or null when there is none. */
  take(key: string): StoredLine | null {
    const list = this.#live.get(key);
    const e = list?.shift();
    if (!e) {
      return null;
    }
    const line = e.line;
    e.line = null;
    this.#unmatched--;
    if (!list!.length) {
      this.#live.delete(key);
    }
    return line;
  }

  /**
   * Forgets entries older than DEDUP_MS, the oldest unmatched ones beyond DEDUP_MAX, and matched ones as they reach
   * the head (a matched entry counts against nothing but DEDUP_KEPT_MAX).
   */
  expire(now: number): void {
    while (this.#head < this.#fifo.length) {
      const e = this.#fifo[this.#head];
      const keep = e.line !== null && e.at >= now - DEDUP_MS && this.#unmatched <= DEDUP_MAX && this.#fifo.length - this.#head <= DEDUP_KEPT_MAX;
      if (keep) {
        break;
      }
      this.#head++;
      if (e.line !== null) {
        this.take(e.key); // the oldest unmatched one of its key is this one
      }
    }
    if (this.#head > 1024 && this.#head * 2 > this.#fifo.length) {
      this.#fifo = this.#fifo.slice(this.#head);
      this.#head = 0;
    }
  }

  /** Entries still unmatched. */
  get size(): number {
    return this.#unmatched;
  }
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
  #now: () => number;
  /** Per device: the esp_log texts of each source not yet matched by the other's copy (design m2-c2 D21). */
  #unmatched = new Map<string, Record<LogSource, Unmatched>>();
  #dups = 0;
  #counters: { logs_dup: number } | null = null;

  /**
   * `frames` decodes `@fr1:` lines into readable text; without it they are stored raw. `seq` is the
   * cursor space shared with events; by default one of the store's own (over both tables). `now` (ms) times
   * the dedup window; tests move it.
   */
  constructor(db: Db, run: number, opts: { retention?: boolean; frames?: FrameDecoder; seq?: Seq; now?: () => number } = {}) {
    this.#db = db;
    this.run = run;
    this.#frames = opts.frames ?? null;
    this.#seq = opts.seq ?? new CursorSeq(db);
    this.#now = opts.now ?? Date.now;
    this.#ring = new RingRetention(db, 'logs', () => this.#seq.head());
    // t_log_us (design m2-c2 D21): a database from before M2-C2 gets the column here, the one place that writes it.
    const columns = db.prepare('PRAGMA table_info(logs)').all() as { name: string }[];
    if (!columns.some((c) => c.name === 't_log_us')) {
      db.exec('ALTER TABLE logs ADD COLUMN t_log_us INTEGER');
    }
    if (opts.retention !== false) {
      this.#ring.start();
    }
  }

  /** Counts the copies dedup drops into `counters` as well (hub_status.router.scale.logs_dup; logs/ingest.ts). */
  countInto(counters: { logs_dup: number }): void {
    this.#counters = counters;
  }

  /** Copies dropped as the other source's copy of a line already stored, since this store started. */
  dups(): number {
    return this.#dups;
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

  /**
   * Stores one line (source `serial` unless said) and returns it. The other source's copy of a line already stored
   * is not stored again (design m2-c2 D21, counted in logs_dup): the line it matched is returned instead, whose
   * port tells it apart.
   */
  append(device: string, port: string, raw: string, opts: AppendOptions = {}): StoredLine {
    const source = opts.source ?? 'serial';
    const parsed = parseLine(raw, source);
    const key = parsed.kind === 'esp_log' ? dedupKey(parsed.text) : null;
    const matched = key !== null ? this.#match(device, source, key) : null;
    if (matched) {
      return matched;
    }
    if (source === 'serial' && this.#frames && parsed.kind === 'raw' && parsed.text.startsWith(SERIAL_PREFIX)) {
      Object.assign(parsed, this.#frames.format(device, parsed.text));
    } else if (this.#frames && parsed.kind === 'esp_log') {
      this.#frames.observe(device, parsed.text); // learns fw= from the banner, whichever way it came
    }
    const line: StoredLine = {
      seq: this.#seq.next(),
      run: this.run,
      ts_us: opts.ts_us ?? nowUs(),
      device,
      port,
      ...parsed,
      t_log_us: source === 'net' ? (opts.t_log_us ?? null) : null,
    };
    if (key !== null) {
      this.#sets(device)[source].add(key, this.#now(), line);
    }
    this.#pending.push(line);
    this.#timer ??= setTimeout(() => this.flush(), 50);
    for (const fn of this.#listeners) {
      fn(line);
    }
    return line;
  }

  #sets(device: string): Record<LogSource, Unmatched> {
    let sets = this.#unmatched.get(device);
    if (!sets) {
      sets = { serial: new Unmatched(), net: new Unmatched() };
      this.#unmatched.set(device, sets);
    }
    return sets;
  }

  /**
   * Cross-source dedup of an esp_log text (its key): the other source's unmatched copy it consumes (this one is
   * then dropped, and counted), or null. A line not dropped becomes an unmatched entry of its own source, which a
   * repeat from that source never consumes.
   */
  #match(device: string, source: LogSource, key: string): StoredLine | null {
    const now = this.#now();
    const sets = this.#sets(device);
    sets.serial.expire(now);
    sets.net.expire(now);
    const matched = sets[source === 'serial' ? 'net' : 'serial'].take(key);
    if (matched) {
      this.#dups++;
      if (this.#counters) {
        this.#counters.logs_dup++;
      }
    }
    return matched;
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
    const t0 = performance.now();
    const insert = this.#db.prepare(
      'INSERT INTO logs (seq, run, ts_us, device, port, level, tag, kind, text, t_log_us) VALUES (@seq, @run, @ts_us, @device, @port, @level, @tag, @kind, @text, @t_log_us)',
    );
    this.#db.transaction((all: StoredLine[]) => {
      for (const r of all) {
        insert.run(r);
      }
    })(rows);
    if (this.#counters) {
      scaleWindows(this.#counters).logs_flush_ms.add(performance.now() - t0); // hub_status.router.scale (D16)
    }
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
    ...(l.t_log_us !== null && l.t_log_us !== undefined ? { t_log_us: l.t_log_us } : {}),
  };
}
