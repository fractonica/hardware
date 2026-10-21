// The hub is the only owner of USB serial ports (spec 08 §8.2-8.3). Espressif USB-Serial/JTAG
// ports are discovered by polling, keyed by their USB serial number (the chip MAC), opened with
// DTR/RTS deasserted, and split into log lines. Flashing borrows a port through a lease. The serial
// command channel (fr_diag) writes lines through the hub's own handle.

import { StringDecoder } from 'node:string_decoder';

import { FrError, type PortInfo } from '@fractonica/protocol';
import { run } from '@fractonica/host';
import { SerialPort } from 'serialport';

import type { Db } from './db.ts';
import type { LogStore } from './logstore.ts';

const ESPRESSIF_VID = '303a';
const POLL_MS = 500;
const GONE_DEBOUNCE_MS = 1500;
const BUSY_RETRY_MS = 5000;
const MAX_LINE = 4096;
/** A port gone for less than this is still waited for (USB re-enumerating after a chip reset). */
const RECENTLY_GONE_MS = 60_000;
const REAPPEAR_WAIT_MS = 5000;
/** writeLine: how long a port the hub is (re)opening may take, and how long the kernel may take the bytes. */
const WRITE_OPEN_WAIT_MS = 1000;
const WRITE_SEND_MS = 2000;
/** Consecutive identical lines are stored once, then as one "repeated N times" line per this period. */
const REPEAT_FLUSH_MS = 1000;
/**
 * A poll tick this late means the Mac slept. USB was suspended meanwhile, and at C2 a C6 stayed
 * silent after wake on a handle that still looked open, so every open port is closed and reopened.
 */
const RESUME_GAP_MS = 10_000;

type State = PortInfo['state'];

interface Entry {
  key: string;
  path: string;
  usbSerial?: string;
  vid?: string;
  pid?: string;
  state: State;
  holder?: string;
  port?: SerialPort;
  /** Settles when the current port.open() call has called back. */
  opening?: Promise<void>;
  decoder: StringDecoder;
  buf: string;
  lines: number;
  lastSeen: number;
  nextOpenAt: number;
  /** The last stored line and how many identical copies have been held back since `since`. */
  repeat?: { text: string; count: number; since: number };
}

/** "1C:DB:D4:16:BA:34" -> "1cdbd416ba34"; anything else is returned unchanged. */
export function normalizeMac(s: string): string {
  const hex = s.replace(/[:\-]/g, '').toLowerCase();
  return /^[0-9a-f]{12}$/.test(hex) ? hex : s;
}

/**
 * Handles whose output is stuck: a line the kernel had not taken after WRITE_SEND_MS, with the write
 * still pending, because the firmware does not read (the tty queue is full). Further lines are refused
 * until that write completes. writeLine never calls drain(): tcdrain() blocks a libuv pool thread until
 * the device has taken the bytes, and a few non-reading devices would stall every serial call. The fd is
 * non-blocking, so a pending write waits on the poller and holds no thread.
 */
const stuck = new WeakMap<SerialPort, Promise<void>>();

function cuPath(path: string): string {
  return path.replace('/dev/tty.', '/dev/cu.');
}

async function portHolder(path: string): Promise<string | undefined> {
  const r = await run('lsof', ['-F', 'pc', path]);
  const cmd = /^c(.+)$/m.exec(r.stdout)?.[1];
  const pid = /^p(\d+)$/m.exec(r.stdout)?.[1];
  return cmd ? `${cmd} (pid ${pid})` : undefined;
}

export class SerialPortManager {
  #entries = new Map<string, Entry>();
  /** Ports that disappeared recently: key -> { path, at }. */
  #gone = new Map<string, { path: string; at: number }>();
  #logs: LogStore;
  #db: Db;
  #timer: NodeJS.Timeout | null = null;
  #polling = false;
  #lastPoll = 0;

  constructor(logs: LogStore, db: Db) {
    this.#logs = logs;
    this.#db = db;
  }

  start(): void {
    void this.poll();
    this.#timer = setInterval(() => void this.poll(), POLL_MS);
  }

  async stop(): Promise<void> {
    if (this.#timer) {
      clearInterval(this.#timer);
    }
    await Promise.all([...this.#entries.values()].map((e) => this.#close(e)));
  }

  async poll(): Promise<void> {
    if (this.#polling) {
      return;
    }
    this.#polling = true;
    try {
      const now = Date.now();
      if (this.#lastPoll && now - this.#lastPoll > RESUME_GAP_MS) {
        await this.#reopenAfterResume(now - this.#lastPoll);
      }
      this.#lastPoll = now;
      const listed = (await SerialPort.list()).filter((p) => p.vendorId?.toLowerCase() === ESPRESSIF_VID);
      for (const p of listed) {
        const key = p.serialNumber ? normalizeMac(p.serialNumber) : cuPath(p.path);
        let e = this.#entries.get(key);
        if (!e) {
          this.#gone.delete(key);
          e = { key, path: cuPath(p.path), usbSerial: p.serialNumber, vid: p.vendorId, pid: p.productId, state: 'closed', decoder: new StringDecoder('utf8'), buf: '', lines: 0, lastSeen: now, nextOpenAt: 0 };
          this.#entries.set(key, e);
          this.#db
            .prepare('INSERT INTO ports_seen (usb_serial, last_path, vid, pid, last_seen) VALUES (?, ?, ?, ?, ?) ON CONFLICT(usb_serial) DO UPDATE SET last_path = excluded.last_path, last_seen = excluded.last_seen')
            .run(key, e.path, p.vendorId ?? null, p.productId ?? null, new Date().toISOString());
        }
        e.path = cuPath(p.path);
        e.lastSeen = now;
        if ((e.state === 'closed' || e.state === 'busy_external' || e.state === 'error') && now >= e.nextOpenAt) {
          this.#open(e);
        }
      }
      for (const e of this.#entries.values()) {
        if (e.repeat?.count && now - e.repeat.since >= REPEAT_FLUSH_MS) {
          this.#flushRepeats(e);
        }
        if (now - e.lastSeen > GONE_DEBOUNCE_MS && e.state !== 'leased') {
          await this.#close(e);
          this.#entries.delete(e.key);
          this.#gone.set(e.key, { path: e.path, at: now });
        }
      }
      for (const [key, g] of this.#gone) {
        if (now - g.at > RECENTLY_GONE_MS) {
          this.#gone.delete(key);
        }
      }
    } finally {
      this.#polling = false;
    }
  }

  #open(e: Entry): void {
    e.state = 'open';
    const port = new SerialPort({ path: e.path, baudRate: 115200, autoOpen: false, hupcl: false });
    e.port = port;
    e.opening = new Promise<void>((done) =>
      port.open((err) => {
        try {
          if (e.port !== port) {
            return; // leased or closed while opening: #close owns this handle now and closes it
          }
          if (err) {
            e.port = undefined;
            const busy = /busy|lock/i.test(err.message);
            e.state = busy ? 'busy_external' : 'error';
            e.nextOpenAt = Date.now() + BUSY_RETRY_MS;
            if (busy) {
              void portHolder(e.path).then((h) => {
                if (e.state === 'busy_external') {
                  e.holder = h;
                }
              });
            }
            return;
          }
          e.holder = undefined;
          // Never assert DTR (BOOT) or RTS (EN): a reset would roll back an image pending verification.
          port.set({ dtr: false, rts: false }, () => undefined);
        } finally {
          done();
        }
      }),
    );
    port.on('data', (chunk: Buffer) => this.#onData(e, chunk));
    port.on('close', () => {
      if (e.port !== port) {
        return; // closed by #close, which settles the entry itself
      }
      if (e.state === 'open') {
        e.state = 'closed';
        e.nextOpenAt = Date.now() + 250;
      }
      e.port = undefined;
      this.#flushPartial(e);
    });
    port.on('error', () => undefined);
  }

  #onData(e: Entry, chunk: Buffer): void {
    e.buf += e.decoder.write(chunk);
    let i: number;
    while ((i = e.buf.indexOf('\n')) >= 0) {
      this.#emit(e, e.buf.slice(0, i));
      e.buf = e.buf.slice(i + 1);
    }
    if (e.buf.length > MAX_LINE) {
      this.#emit(e, e.buf);
      e.buf = '';
    }
  }

  #emit(e: Entry, raw: string): void {
    const text = raw.replace(/\r$/, '');
    if (!text.trim()) {
      return;
    }
    // A reset cuts the line being printed, so the ROM banner lands on the end of it
    // (`invalid header: 0xESP-ROM:esp32c6-20220919`); give the banner its own line.
    const rom = text.indexOf('ESP-ROM:');
    if (rom > 0) {
      this.#emit(e, text.slice(0, rom));
      this.#emit(e, text.slice(rom));
      return;
    }
    // A blank board's ROM prints `invalid header: 0xffffffff` ~400 times a second; store the first
    // copy and then one count per second, like syslog. ESP_LOG lines carry a timestamp, so they
    // never repeat exactly.
    if (e.repeat?.text === text) {
      e.repeat.count++;
      if (Date.now() - e.repeat.since >= REPEAT_FLUSH_MS) {
        this.#flushRepeats(e);
      }
      return;
    }
    this.#flushRepeats(e);
    e.repeat = { text, count: 0, since: Date.now() };
    e.lines++;
    this.#logs.append(e.key, e.path, text);
  }

  #flushRepeats(e: Entry): void {
    if (!e.repeat?.count) {
      return;
    }
    const n = e.repeat.count;
    e.repeat.count = 0;
    e.repeat.since = Date.now();
    e.lines++;
    this.#logs.append(e.key, e.path, `(previous line repeated ${n} more time${n === 1 ? '' : 's'})`);
  }

  /**
   * A partial line left when the port closes is stored on its own; kept, it would be glued to the
   * first line after a reopen (often the ROM boot banner, which then no longer parses as `boot`).
   */
  #flushPartial(e: Entry): void {
    const rest = e.buf;
    e.buf = '';
    e.decoder = new StringDecoder('utf8');
    this.#emit(e, rest);
    this.#flushRepeats(e);
    e.repeat = undefined;
  }

  async #reopenAfterResume(gapMs: number): Promise<void> {
    for (const e of this.#entries.values()) {
      if (e.state !== 'open') {
        continue;
      }
      await this.#close(e);
      e.state = 'closed';
      e.nextOpenAt = 0;
      e.lastSeen = Date.now(); // the gap is not an absence: do not let the gone debounce fire
      this.#logs.append(e.key, e.path, `(hub: system resumed after ${Math.round(gapMs / 1000)} s; port reopened)`);
    }
  }

  async #close(e: Entry): Promise<void> {
    const port = e.port;
    const opening = e.opening;
    e.port = undefined;
    // An open still in flight would finish later with an fd (and its flock) that nothing references,
    // so esptool could not open the port until replug. Wait for it, then close what it opened.
    await opening;
    if (port?.isOpen) {
      await new Promise<void>((resolve) => port.close(() => resolve()));
    }
    this.#flushPartial(e);
  }

  resolve(selector: string): Entry {
    const want = normalizeMac(selector.replace(/^(mac|port|id):/, ''));
    const hits = [...this.#entries.values()].filter(
      (e) => e.key === want || e.path === want || cuPath(want) === e.path || (e.usbSerial && normalizeMac(e.usbSerial) === want),
    );
    if (hits.length === 1) {
      return hits[0];
    }
    if (hits.length > 1) {
      throw new FrError('AMBIGUOUS_SELECTOR', `${selector} matches ${hits.length} ports`, {
        remediation: [{ tool: 'port_list', cli: 'fr ports ls', human: 'select one port by its path (port:<path>)' }],
        details: { candidates: hits.map((e) => ({ path: e.path, ...(e.usbSerial ? { usb_serial: e.usbSerial } : {}) })) },
      });
    }
    throw new FrError('NOT_FOUND', `no attached Espressif port matches ${selector}`, {
      remediation: [{ tool: 'port_list', cli: 'fr ports ls' }],
    });
  }

  /**
   * resolve(), but a port that vanished in the last minute is waited for: a chip reset on the C6
   * (and a blank board's ROM boot loop) re-enumerates USB, so the port is briefly absent.
   */
  async resolveWait(selector: string, waitMs = REAPPEAR_WAIT_MS): Promise<Entry> {
    const want = normalizeMac(selector.replace(/^(mac|port|id):/, ''));
    const deadline = Date.now() + waitMs;
    for (;;) {
      try {
        return this.resolve(selector);
      } catch (err) {
        const recent = [...this.#gone].some(([key, g]) => (key === want || g.path === cuPath(want)) && Date.now() - g.at < RECENTLY_GONE_MS);
        if (!(err instanceof FrError && err.code === 'NOT_FOUND' && recent && Date.now() < deadline)) {
          throw err;
        }
      }
      await sleep(100);
    }
  }

  /** Hands the port to another process (pytools, idf.py monitor). The hub stops reading until release. */
  async lease(selector: string, holder: string): Promise<{ path: string; key: string; release: () => void }> {
    const e = await this.resolveWait(selector);
    if (e.state === 'busy_external') {
      // Ask lsof again: the program seen at the last failed open may have let go (a closed Web Serial tab).
      const h = await portHolder(e.path);
      if (e.state === 'busy_external') {
        e.holder = h;
      }
      if (h) {
        throw new FrError('PORT_BUSY_EXTERNAL', `${e.path} is held by ${h}`, {
          remediation: [{ human: `close the program holding the port (${h}), e.g. a Chrome Web Serial tab` }],
          details: { holder: h },
        });
      }
    }
    if (e.state === 'leased') {
      throw new FrError('PORT_LEASED', `${e.path} is leased to ${e.holder}`, { details: { holder: e.holder } });
    }
    e.state = 'leased';
    e.holder = holder;
    await this.#close(e);
    let released = false;
    return {
      path: e.path,
      key: e.key,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        e.state = 'closed';
        e.holder = undefined;
        e.nextOpenAt = 0;
        void this.poll();
      },
    };
  }

  /**
   * Pulses EN via RTS on the hub's own handle, DTR deasserted so the chip boots normally. Native
   * USB-Serial-JTAG survives the chip reset without re-enumerating, so the ROM, bootloader and
   * boot-banner lines land in the log store instead of being dropped while nobody has the port open.
   */
  async hardReset(selector: string, waitOpenMs = 3000): Promise<{ path: string; key: string }> {
    const e = await this.resolveWait(selector);
    const port = await this.#waitOpen(e, waitOpenMs, 'cannot reset through it');
    const set = (rts: boolean) => new Promise<void>((res, rej) => port.set({ dtr: false, rts }, (err) => (err ? rej(err) : res())));
    await set(true);
    await sleep(200);
    await set(false);
    return { path: e.path, key: e.key };
  }

  /**
   * Writes one line (LF appended) to the device through the hub's open handle: the serial command
   * channel (design c2 §5). A leased port belongs to its holder until released.
   */
  async writeLine(selector: string, line: string): Promise<{ path: string; key: string }> {
    if (/[\r\n]/.test(line)) {
      throw new FrError('INVALID_ARGS', 'a serial line must not contain CR or LF');
    }
    const e = await this.resolveWait(selector);
    if (e.state === 'leased') {
      throw new FrError('PORT_LEASED', `${e.path} is leased to ${e.holder}`, { details: { holder: e.holder } });
    }
    if (e.state === 'busy_external') {
      throw new FrError('PORT_BUSY_EXTERNAL', `${e.path} is held by ${e.holder ?? 'another program'}`, { details: { holder: e.holder } });
    }
    const port = await this.#waitOpen(e, WRITE_OPEN_WAIT_MS, 'cannot write to it');
    if (stuck.has(port)) {
      throw new FrError('DEVICE_BUSY', `${e.path}: the device has not taken an earlier line yet`, {
        hint: 'its firmware is not reading serial input (no serial command channel, or stuck)',
      });
    }
    // The port's stream queues writes in order, so concurrent lines go out one after the other.
    // "Sent" means the kernel has the bytes; a firmware that never answers is diag_exec's TIMEOUT.
    const sent = new Promise<void>((resolve, reject) => port.write(`${line}\n`, (err) => (err ? reject(err) : resolve())));
    let timer: NodeJS.Timeout | undefined;
    let outcome: 'sent' | 'timeout';
    try {
      outcome = await Promise.race([
        sent.then(() => 'sent' as const),
        new Promise<'timeout'>((resolve) => (timer = setTimeout(() => resolve('timeout'), WRITE_SEND_MS))),
      ]);
    } catch (err) {
      throw new FrError('DEVICE_OFFLINE', `${e.path}: write failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
    if (outcome === 'timeout') {
      // Writes complete in order, so the last stuck write completing means the queue moves again.
      stuck.set(port, sent);
      const clear = () => stuck.get(port) === sent && stuck.delete(port);
      sent.then(clear, clear);
      throw new FrError('TIMEOUT', `${e.path}: the device did not take the line within ${WRITE_SEND_MS} ms`, {
        hint: 'its firmware is not reading serial input (no serial command channel, or stuck)',
      });
    }
    return { path: e.path, key: e.key };
  }

  /** The hub's own handle on `e` once it is open, waiting up to `ms` for an open in progress. */
  async #waitOpen(e: Entry, ms: number, what: string): Promise<SerialPort> {
    const deadline = Date.now() + ms;
    while (!(e.state === 'open' && e.port?.isOpen)) {
      if (Date.now() > deadline) {
        throw new FrError('DEVICE_OFFLINE', `${e.path} is ${e.state}, not open by the hub; ${what}`);
      }
      await sleep(25);
    }
    return e.port;
  }

  list(): PortInfo[] {
    return [...this.#entries.values()].map((e) => ({
      path: e.path,
      ...(e.usbSerial ? { usb_serial: e.usbSerial } : {}),
      ...(/^[0-9a-f]{12}$/.test(e.key) ? { device_id: e.key } : {}),
      ...(e.vid ? { vid: e.vid } : {}),
      ...(e.pid ? { pid: e.pid } : {}),
      state: e.state,
      ...(e.holder ? { holder: e.holder } : {}),
      lines: e.lines,
    }));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
