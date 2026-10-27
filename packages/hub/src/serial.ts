// The hub is the only owner of USB serial ports (spec 08 §8.2-8.3). Espressif USB-Serial/JTAG
// ports are discovered by polling, keyed by their USB serial number (the chip MAC), opened with
// DTR/RTS deasserted, and split into log lines. Flashing borrows a port through a lease, and so does
// another program through a serial lease (design c6 D4, ports/leases.ts); before either, the hub asks who
// else has the port open (D5, ports/holders.ts). The serial command channel (fr_diag) writes lines through
// the hub's own handle.

import { StringDecoder } from 'node:string_decoder';

import { FrError, type PortHolder, type PortInfo, type PortLease, SERIAL_PREFIX } from '@fractonica/protocol';
import { SerialPort } from 'serialport';

import type { PortHolders } from './context.ts';
import type { Db } from './db.ts';
import type { SerialBinding } from './links/serial-bridge.ts';
import type { LogStore } from './logstore.ts';
import { busyExternal, holderText, LsofHolders, portLeased } from './ports/holders.ts';

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
/**
 * A poll this late did not watch the ports in between (the Mac slept, or the loop stalled): a leased port's
 * absence is not counted across the gap, so a lease outlives a sleep (ports/leases.ts, port_gone).
 */
const LATE_POLL_MS = 2000;

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
  /** onPortGone listeners were told this port is gone; cleared when a poll lists it again. */
  goneTold?: boolean;
  /** A poll did not list it while its handle stayed open: back in the list, the handle is a dead one (M2-C4). */
  vanished?: boolean;
  /** A serial lease (design c6 D4) holds the port: shown in port_list, with state `leased`. */
  lease?: PortLease;
  /** A serial lease is being granted (the node's BYE is going out): the port is promised, still open. */
  claimed?: boolean;
  /** Other programs that have the port open (D5): from the failed open, or port_list's lsof. */
  external?: PortHolder[];
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

/** What a lease asks of SerialPortManager.lease besides its holder text. */
export interface LeaseOptions {
  /** A serial lease (design c6 D4): shown in port_list until released. */
  lease?: PortLease;
  /**
   * Runs once the port is promised to this lease and before the hub closes its handle (the node's BYE on
   * its serial session, Router.endSerialSession). Nothing the device sends after it is read.
   */
  beforeClose?: () => Promise<unknown>;
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
  /** When the last poll listed the ports (the `now` its lastSeen updates carry); 0 before the first. */
  #polledAt = 0;
  #goneListeners = new Set<(key: string) => void>();
  #changeListeners = new Set<() => void>();
  /** Who else holds a port (design c6 D5); lsof by default. */
  #holders: PortHolders;
  /** Every lease asks #holders (D5); without a probe of the hub's, only a port that failed to open busy is asked about. */
  #askEveryLease: boolean;
  /**
   * Where ports are listed and opened: the Mac's USB (serialport's own binding), or a test's virtual USB hub on
   * loopback (`--serial-bridge`, links/serial-bridge.ts, design m2-c1-hil §5.1).
   */
  #binding: SerialBinding | null;

  constructor(logs: LogStore, db: Db, opts: { holders?: PortHolders; binding?: SerialBinding } = {}) {
    this.#logs = logs;
    this.#db = db;
    this.#holders = opts.holders ?? new LsofHolders();
    this.#askEveryLease = opts.holders !== undefined;
    this.#binding = opts.binding ?? null;
  }

  /**
   * The hub's holder probe (HubContext.portHolders), handed over when the lease part starts: from then on
   * every lease asks who else has the port open, not only a port the hub failed to open (design c6 D5).
   */
  useHolders(holders: PortHolders): void {
    this.#holders = holders;
    this.#askEveryLease = true;
  }

  /** The other programs that have `path` open; none when lsof fails. */
  async #others(path: string): Promise<PortHolder[]> {
    try {
      return (await this.#holders.holders([path])).get(path) ?? [];
    } catch {
      return [];
    }
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

  /**
   * Calls `fn` with a port's key as soon as the port is gone (USB unplugged): the first poll that no
   * longer lists it while the hub holds no open handle on it. An unplug errors the open handle at once,
   * and that triggers a poll; a port the hub still reads from is not taken for gone over one missed
   * listing. Once per absence. The router ends the device's serial session with it. Returns the unsubscribe.
   */
  onPortGone(fn: (key: string) => void): () => void {
    this.#goneListeners.add(fn);
    return () => this.#goneListeners.delete(fn);
  }

  /**
   * Calls `fn` after every poll (each 500 ms, and the one a release or an unplug triggers): list() may
   * have changed. The listener compares list() with what it saw before (web/feeds.ts publishes
   * port.attached, port.detached and port.state from that, design c6 §5). Returns the unsubscribe.
   */
  onChange(fn: () => void): () => void {
    this.#changeListeners.add(fn);
    return () => this.#changeListeners.delete(fn);
  }

  #changed(): void {
    for (const fn of this.#changeListeners) {
      try {
        fn();
      } catch (err) {
        console.error(JSON.stringify({ event: 'port_change_listener_failed', message: (err as Error).message }));
      }
    }
  }

  async poll(): Promise<void> {
    if (this.#polling) {
      return;
    }
    this.#polling = true;
    try {
      const now = Date.now();
      const gap = this.#lastPoll ? now - this.#lastPoll : 0;
      if (gap > LATE_POLL_MS) {
        // Nothing watched the ports during the gap: a leased port keeps the absence polls saw before it.
        for (const e of this.#entries.values()) {
          if (e.state === 'leased') {
            e.lastSeen += gap;
          }
        }
      }
      if (gap > RESUME_GAP_MS) {
        await this.#reopenAfterResume(gap);
      }
      this.#lastPoll = now;
      const listed = (await (this.#binding ? this.#binding.list() : SerialPort.list())).filter((p) => p.vendorId?.toLowerCase() === ESPRESSIF_VID);
      const present = new Set<string>();
      for (const p of listed) {
        const key = p.serialNumber ? normalizeMac(p.serialNumber) : cuPath(p.path);
        present.add(key);
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
        e.goneTold = false;
        if (e.vanished && e.state === 'open') {
          // Re-enumerated inside GONE_DEBOUNCE_MS with the old handle still open (macOS gave it no close): that
          // handle reads nothing from the new device (M2-C4 bench: a gateway re-plugged after about 1 s sent no
          // line for 6 min until a USB reset). Reopened.
          await this.#close(e);
          e.state = 'closed';
          e.nextOpenAt = 0;
        }
        e.vanished = false;
        if ((e.state === 'closed' || e.state === 'busy_external' || e.state === 'error') && now >= e.nextOpenAt) {
          this.#open(e);
        }
      }
      this.#polledAt = now;
      for (const e of this.#entries.values()) {
        if (!present.has(e.key) && e.state === 'open') {
          e.vanished = true;
        }
        if (!present.has(e.key) && !e.goneTold && !(e.state === 'open' && e.port?.isOpen)) {
          e.goneTold = true;
          this.#tellGone(e.key);
        }
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
      this.#changed();
    } finally {
      this.#polling = false;
    }
  }

  #open(e: Entry): void {
    e.state = 'open';
    // serialport takes a `binding` beside the open options (its constructor spreads them over its own).
    const port = new SerialPort({ path: e.path, baudRate: 115200, autoOpen: false, hupcl: false, ...(this.#binding ? ({ binding: this.#binding } as object) : {}) });
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
              void this.#others(e.path).then((others) => {
                if (e.state === 'busy_external') {
                  e.external = others;
                  e.holder = others.length ? holderText(others) : undefined;
                }
              });
            }
            return;
          }
          e.holder = undefined;
          e.external = undefined;
          // Never assert DTR (BOOT) or RTS (EN): a reset would roll back an image pending verification.
          port.set({ dtr: false, rts: false }, () => undefined);
        } finally {
          done();
        }
      }),
    );
    // Only while this handle is the entry's: once a lease takes the port (after the node's BYE) or the hub
    // closes it, a line still in flight would start a new serial session (design c6 D4).
    port.on('data', (chunk: Buffer) => e.port === port && this.#onData(e, chunk));
    port.on('close', (err?: { disconnected?: boolean } | null) => {
      if (e.port !== port) {
        return; // closed by #close, which settles the entry itself
      }
      if (e.state === 'open') {
        e.state = 'closed';
        e.nextOpenAt = Date.now() + 250;
      }
      e.port = undefined;
      this.#flushPartial(e);
      if (err?.disconnected) {
        void this.poll(); // an unplug: tell onPortGone listeners now rather than at the next poll
      }
    });
    port.on('error', () => undefined);
  }

  #tellGone(key: string): void {
    for (const fn of this.#goneListeners) {
      try {
        fn(key);
      } catch (err) {
        console.error(JSON.stringify({ event: 'port_gone_listener_failed', key, message: (err as Error).message }));
      }
    }
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
    // A frame written while a log line was still open (a library printing one line in two calls) lands on
    // its end (`I (437) wifi:wifi certification version: v7.0@fr1:AaEA…`, seen on the dual-core S3):
    // give the frame its own line, or the router never sees it.
    const fr = text.indexOf(SERIAL_PREFIX);
    if (fr > 0) {
      this.#emit(e, text.slice(0, fr));
      this.#emit(e, text.slice(fr));
      return;
    }
    // `@fr1:` lines are envelopes of the serial node link, never collapsed: two identical ones are two
    // frames (a cached RESULT answering a duplicate request, a resent BYE), and the router decides.
    if (text.startsWith(SERIAL_PREFIX)) {
      // A gateway's bridge lines (GW_RX for every air frame it hears, GW_STATUS each second, LINK_PONG...) go to the
      // gateway link without becoming log lines (design m2-c4-gateway D13).
      if (this.#logs.bridged?.(e.key, text)) {
        return;
      }
      this.#flushRepeats(e);
      e.repeat = undefined;
      e.lines++;
      this.#logs.append(e.key, e.path, text);
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

  /**
   * Hands the port to another process (pytools, idf.py monitor, a Web Serial page). The hub stops reading
   * until release. Refused with PORT_LEASED while leased (to a job or a serial lease) and with
   * PORT_BUSY_EXTERNAL, naming the program, while another program has it open (design c6 D5): asked of
   * lsof at every lease once the hub's probe is in (useHolders), else only for a port that failed to open.
   */
  async lease(selector: string, holder: string, opts: LeaseOptions = {}): Promise<{ path: string; key: string; release: () => void }> {
    const e = await this.resolveWait(selector);
    if (e.state === 'leased' || e.claimed) {
      throw portLeased(e, e);
    }
    if (e.state === 'busy_external' || this.#askEveryLease) {
      // Asked again for a busy port: the program seen at the last failed open may have let go (a closed Web Serial tab).
      const others = await this.#others(e.path);
      if (e.state === 'busy_external') {
        e.external = others;
        e.holder = others.length ? holderText(others) : undefined;
      }
      if (others.length) {
        throw busyExternal({ path: e.path, key: e.key }, others);
      }
    }
    if ((e.state as State) === 'leased' || e.claimed) {
      throw portLeased(e, e); // taken while lsof ran
    }
    if (opts.beforeClose) {
      e.claimed = true;
      try {
        await opts.beforeClose();
      } finally {
        e.claimed = false;
      }
    }
    e.state = 'leased';
    e.holder = holder;
    e.lease = opts.lease;
    e.external = undefined;
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
        e.lease = undefined;
        e.nextOpenAt = 0;
        void this.poll();
      },
    };
  }

  /**
   * When the poll last listed a port (ms since the epoch), null for one it does not know. A leased port
   * stays known while it is absent, so a lease can tell a USB re-enumeration from an unplug.
   */
  lastSeen(selector: string): number | null {
    try {
      return this.resolve(selector).lastSeen;
    } catch {
      return null;
    }
  }

  /**
   * When the last poll listed the ports (ms since the epoch), null before the first. A lease times a port's
   * absence up to here, not up to now: right after a Mac sleep the wall clock has jumped while no poll has
   * run yet, and that gap is no absence (design c6 D4, port_gone).
   */
  lastPolled(): number | null {
    return this.#polledAt || null;
  }

  /** What port_list's lsof found (ports/holders.ts listPorts): kept for hub_status and the next list(). */
  noteExternal(found: Map<string, PortHolder[]>): void {
    for (const e of this.#entries.values()) {
      if (e.state === 'leased') {
        continue;
      }
      const others = found.get(e.path) ?? [];
      e.external = others.length ? others : undefined;
      if (e.state === 'busy_external') {
        e.holder = others.length ? holderText(others) : e.holder;
      }
    }
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
      throw portLeased(e, e);
    }
    if (e.state === 'busy_external') {
      throw e.external?.length
        ? busyExternal({ path: e.path, key: e.key }, e.external)
        : new FrError('PORT_BUSY_EXTERNAL', `${e.path} is held by ${e.holder ?? 'another program'}`, { details: { holder: e.holder } });
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
    return [...this.#entries.values()].map((e) => {
      // An open port another program has open too (D5) says so; a busy one names its holder.
      const holder = e.holder ?? (e.state === 'open' && e.external?.length ? `also ${holderText(e.external)}` : undefined);
      return {
        path: e.path,
        ...(e.usbSerial ? { usb_serial: e.usbSerial } : {}),
        ...(/^[0-9a-f]{12}$/.test(e.key) ? { device_id: e.key } : {}),
        ...(e.vid ? { vid: e.vid } : {}),
        ...(e.pid ? { pid: e.pid } : {}),
        state: e.state,
        ...(holder ? { holder } : {}),
        lines: e.lines,
        ...(e.lease ? { lease: { ...e.lease } } : {}),
        ...(e.external?.length ? { external: e.external.map((h) => ({ ...h })) } : {}),
      };
    });
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
