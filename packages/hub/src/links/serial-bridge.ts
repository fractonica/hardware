// The serial bridge (design m2-c1-hil §5.1, I1): USB serial ports served by a test's virtual USB hub on loopback
// instead of the Mac's, for a hub started with `--serial-bridge 127.0.0.1:<port>` (real-hub.ts). It is a
// `serialport` binding, so SerialPortManager polls, opens, reads, splits and writes these ports exactly as it does
// USB-Serial/JTAG ones: the frame tap, the router's serial sessions, writeLine, port_list and port.attached or
// port.detached all run unchanged. Only loopback is accepted; nothing else in the hub differs.
//
// The wire, one TCP connection per request to the bridge (packages/hub/test/virtual-usb.ts serves it):
//   - `list\n`: the bridge answers one JSON line, an array of serialport PortInfo ({path, serialNumber, vendorId,
//     productId, ...}), and closes;
//   - `open <path>\n`: the bridge answers `ok\n` and the connection is that port from then on (the device's
//     output in, the hub's writes out), or `err <message>\n` and closes. The bridge closing the connection is an
//     unplug (a disconnect), the hub closing it is a close.

import { connect, type Socket } from 'node:net';

/** What serialport's PortInfo carries (@serialport/bindings-interface). */
export interface BridgePortInfo {
  path: string;
  manufacturer: string | undefined;
  serialNumber: string | undefined;
  pnpId: string | undefined;
  locationId: string | undefined;
  productId: string | undefined;
  vendorId: string | undefined;
}

interface OpenOptions {
  path: string;
  baudRate: number;
  [k: string]: unknown;
}

/** The subset of @serialport/bindings-interface's BindingInterface that SerialPortStream calls. */
export interface SerialBinding {
  list(): Promise<BridgePortInfo[]>;
  open(options: OpenOptions): Promise<BridgePort>;
}

const CONNECT_MS = 2000;

/** `host:port` of a loopback bridge, or throws. */
export function parseBridgeAddress(text: string): { host: string; port: number } {
  const m = /^(127\.0\.0\.1|localhost):(\d{1,5})$/.exec(text.trim());
  const port = m ? Number(m[2]) : NaN;
  if (!m || !(port > 0 && port < 65536)) {
    throw new Error(`--serial-bridge takes 127.0.0.1:<port> (a test's virtual USB hub on loopback), not ${JSON.stringify(text)}`);
  }
  return { host: '127.0.0.1', port };
}

/**
 * The bridge `argv` asks for: `--serial-bridge <addr>` or `--serial-bridge=<addr>`, parsed by parseBridgeAddress;
 * null only when no argument is or starts with `--serial-bridge`. It fails closed: a flag with a missing or
 * empty value, a repeated flag, or a `--serial-bridge…` spelling it does not know throws, so a test hub
 * started with a malformed flag never falls back to the Mac's real USB ports.
 */
export function serialBridgeArg(argv: readonly string[]): { host: string; port: number } | null {
  const FLAG = '--serial-bridge';
  const at = argv.flatMap((a, i) => (a.startsWith(FLAG) ? [i] : []));
  if (!at.length) {
    return null;
  }
  if (at.length > 1) {
    throw new Error(`${FLAG} is given ${at.length} times; give it once, as ${FLAG} 127.0.0.1:<port>`);
  }
  const a = argv[at[0]];
  let value: string | undefined;
  if (a === FLAG) {
    value = argv[at[0] + 1];
  } else if (a.startsWith(`${FLAG}=`)) {
    value = a.slice(FLAG.length + 1);
  } else {
    throw new Error(`unknown flag ${JSON.stringify(a)}; did you mean ${FLAG} 127.0.0.1:<port>?`);
  }
  if (value === undefined || !value.trim()) {
    throw new Error(`${FLAG} needs a value, 127.0.0.1:<port> (a test's virtual USB hub on loopback); the hub does not fall back to the Mac's USB ports`);
  }
  return parseBridgeAddress(value);
}

/** A connection to the bridge with its first request sent; resolves once connected. */
function request(host: string, port: number, line: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = connect({ host, port });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`serial bridge ${host}:${port}: no connection within ${CONNECT_MS} ms`));
    }, CONNECT_MS);
    sock.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    sock.once('connect', () => {
      clearTimeout(timer);
      sock.write(`${line}\n`);
      resolve(sock);
    });
  });
}

/** Reads the first line of `sock`; resolves with it and what came after it. */
function firstLine(sock: Socket): Promise<{ line: string; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(0x0a);
      if (nl >= 0) {
        done();
        resolve({ line: buf.subarray(0, nl).toString('utf8'), rest: buf.subarray(nl + 1) });
      }
    };
    const onEnd = () => {
      done();
      reject(new Error('serial bridge closed the connection before answering'));
    };
    const done = () => {
      sock.off('data', onData);
      sock.off('close', onEnd);
      sock.off('error', onEnd);
    };
    sock.on('data', onData);
    sock.once('close', onEnd);
    sock.once('error', onEnd);
  });
}

/** An error SerialPortStream takes for a close in progress (`canceled`), not a disconnect. */
function canceled(): Error & { canceled: true } {
  return Object.assign(new Error('port closed'), { canceled: true as const });
}

/** One open bridge port: a BindingPortInterface over its TCP connection. */
export class BridgePort {
  readonly openOptions: Required<OpenOptions>;
  isOpen = true;
  #sock: Socket;
  #chunks: Buffer[] = [];
  #waiter: { resolve: () => void; reject: (e: Error) => void } | null = null;
  /** Set once the bridge has closed the connection: an unplug. */
  #gone: Error | null = null;

  constructor(sock: Socket, options: OpenOptions, initial: Buffer) {
    this.#sock = sock;
    this.openOptions = options as Required<OpenOptions>;
    if (initial.length) {
      this.#chunks.push(initial);
    }
    sock.on('data', (chunk: Buffer) => {
      this.#chunks.push(chunk);
      this.#wake();
    });
    const gone = () => {
      if (this.isOpen && !this.#gone) {
        this.#gone = new Error('the device was unplugged (serial bridge closed the port)');
        this.#wake();
      }
    };
    sock.on('close', gone);
    sock.on('error', gone);
  }

  #wake(): void {
    const w = this.#waiter;
    this.#waiter = null;
    w?.resolve();
  }

  async read(buffer: Buffer, offset: number, length: number): Promise<{ buffer: Buffer; bytesRead: number }> {
    for (;;) {
      if (!this.isOpen) {
        throw canceled();
      }
      if (this.#chunks.length) {
        let n = 0;
        while (n < length && this.#chunks.length) {
          const c = this.#chunks[0];
          const take = Math.min(length - n, c.length);
          c.copy(buffer, offset + n, 0, take);
          n += take;
          if (take === c.length) {
            this.#chunks.shift();
          } else {
            this.#chunks[0] = c.subarray(take);
          }
        }
        return { buffer, bytesRead: n };
      }
      if (this.#gone) {
        throw this.#gone;
      }
      await new Promise<void>((resolve, reject) => (this.#waiter = { resolve, reject }));
    }
  }

  async write(buffer: Buffer): Promise<void> {
    if (!this.isOpen) {
      throw canceled();
    }
    if (this.#gone) {
      throw this.#gone;
    }
    await new Promise<void>((resolve, reject) => this.#sock.write(buffer, (err) => (err ? reject(err) : resolve())));
  }

  async close(): Promise<void> {
    if (!this.isOpen) {
      return;
    }
    this.isOpen = false;
    const w = this.#waiter;
    this.#waiter = null;
    w?.reject(canceled());
    this.#sock.destroy();
  }

  async update(): Promise<void> {}

  /** DTR and RTS: a virtual port has no BOOT or EN to drive. */
  async set(): Promise<void> {}

  async get(): Promise<{ cts: boolean; dsr: boolean; dcd: boolean }> {
    return { cts: false, dsr: false, dcd: false };
  }

  async getBaudRate(): Promise<{ baudRate: number }> {
    return { baudRate: this.openOptions.baudRate };
  }

  async flush(): Promise<void> {
    this.#chunks = [];
  }

  async drain(): Promise<void> {}
}

/** The serialport binding of the bridge at `host:port`. */
export function bridgeBinding(address: { host: string; port: number }): SerialBinding {
  const { host, port } = address;
  return {
    // A bridge that does not answer is a USB hub unplugged: no ports (the poll then reports them gone), never a
    // rejection, which SerialPortManager's timer-driven poll would leave unhandled.
    async list() {
      let sock: Socket | null = null;
      try {
        sock = await request(host, port, 'list');
        const { line } = await firstLine(sock);
        const ports = JSON.parse(line) as BridgePortInfo[];
        return Array.isArray(ports) ? ports : [];
      } catch {
        return [];
      } finally {
        sock?.destroy();
      }
    },
    async open(options) {
      const sock = await request(host, port, `open ${options.path}`);
      let answer: { line: string; rest: Buffer };
      try {
        answer = await firstLine(sock);
      } catch (e) {
        sock.destroy();
        throw e;
      }
      if (answer.line !== 'ok') {
        sock.destroy();
        throw new Error(`${options.path}: ${answer.line.replace(/^err\s*/, '') || 'refused by the serial bridge'}`);
      }
      return new BridgePort(sock, options, answer.rest);
    },
  };
}
