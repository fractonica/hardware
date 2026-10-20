// The hub is the only owner of USB serial ports (spec 08 §8.2-8.3). Espressif USB-Serial/JTAG
// ports are discovered by polling, keyed by their USB serial number (the chip MAC), opened with
// DTR/RTS deasserted, and split into log lines. Flashing borrows a port through a lease.

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
  decoder: StringDecoder;
  buf: string;
  lines: number;
  lastSeen: number;
  nextOpenAt: number;
}

/** "1C:DB:D4:16:BA:34" -> "1cdbd416ba34"; anything else is returned unchanged. */
export function normalizeMac(s: string): string {
  const hex = s.replace(/[:\-]/g, '').toLowerCase();
  return /^[0-9a-f]{12}$/.test(hex) ? hex : s;
}

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
  #logs: LogStore;
  #db: Db;
  #timer: NodeJS.Timeout | null = null;
  #polling = false;

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
      const listed = (await SerialPort.list()).filter((p) => p.vendorId?.toLowerCase() === ESPRESSIF_VID);
      for (const p of listed) {
        const key = p.serialNumber ? normalizeMac(p.serialNumber) : cuPath(p.path);
        let e = this.#entries.get(key);
        if (!e) {
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
        if (now - e.lastSeen > GONE_DEBOUNCE_MS && e.state !== 'leased') {
          await this.#close(e);
          this.#entries.delete(e.key);
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
    port.open((err) => {
      if (err) {
        e.port = undefined;
        const busy = /busy|lock/i.test(err.message);
        e.state = busy ? 'busy_external' : 'error';
        e.nextOpenAt = Date.now() + BUSY_RETRY_MS;
        if (busy) {
          void portHolder(e.path).then((h) => (e.holder = h));
        }
        return;
      }
      e.holder = undefined;
      // Never assert DTR (BOOT) or RTS (EN): a reset would roll back an image pending verification.
      port.set({ dtr: false, rts: false }, () => undefined);
    });
    port.on('data', (chunk: Buffer) => this.#onData(e, chunk));
    port.on('close', () => {
      if (e.state === 'open') {
        e.state = 'closed';
        e.nextOpenAt = Date.now() + 250;
      }
      e.port = undefined;
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
    e.lines++;
    this.#logs.append(e.key, e.path, text);
  }

  #close(e: Entry): Promise<void> {
    const port = e.port;
    e.port = undefined;
    if (!port || !port.isOpen) {
      return Promise.resolve();
    }
    return new Promise((resolve) => port.close(() => resolve()));
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
      throw new FrError('AMBIGUOUS_SELECTOR', `${selector} matches ${hits.length} ports`);
    }
    throw new FrError('NOT_FOUND', `no attached Espressif port matches ${selector}`, {
      remediation: [{ tool: 'port_list', cli: 'fr ports ls' }],
    });
  }

  /** Hands the port to another process (pytools, idf.py monitor). The hub stops reading until release. */
  async lease(selector: string, holder: string): Promise<{ path: string; key: string; release: () => void }> {
    const e = this.resolve(selector);
    if (e.state === 'leased') {
      throw new FrError('PORT_LEASED', `${e.path} is leased to ${e.holder}`, { details: { holder: e.holder } });
    }
    if (e.state === 'busy_external') {
      e.holder = (await portHolder(e.path)) ?? e.holder;
      if (e.holder) {
        throw new FrError('PORT_BUSY_EXTERNAL', `${e.path} is held by ${e.holder}`, {
          remediation: [{ human: `close the program holding the port (${e.holder}), e.g. a Chrome Web Serial tab` }],
          details: { holder: e.holder },
        });
      }
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
        e.buf = '';
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
    const e = this.resolve(selector);
    const deadline = Date.now() + waitOpenMs;
    while (!(e.state === 'open' && e.port?.isOpen)) {
      if (Date.now() > deadline) {
        throw new FrError('DEVICE_OFFLINE', `${e.path} is ${e.state}, not open by the hub; cannot reset through it`);
      }
      await sleep(25);
    }
    const port = e.port;
    const set = (rts: boolean) => new Promise<void>((res, rej) => port.set({ dtr: false, rts }, (err) => (err ? rej(err) : res())));
    await set(true);
    await sleep(200);
    await set(false);
    return { path: e.path, key: e.key };
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

  /** Device ids a selector covers (for log queries); null means all devices. */
  devicesFor(selector: string | undefined): string[] | null {
    if (!selector || selector === 'all') {
      return null;
    }
    try {
      return [this.resolve(selector).key];
    } catch {
      return [normalizeMac(selector.replace(/^(mac|id):/, ''))];
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
