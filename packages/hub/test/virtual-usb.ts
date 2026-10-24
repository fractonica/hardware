// A virtual USB hub for a real hub process (design m2-c1-hil §5.1, I1): the serial bridge that
// packages/hub/src/links/serial-bridge.ts reads when the hub runs with `--serial-bridge 127.0.0.1:<port>`
// (startRealHub({ serialBridge })). Each attached device is one Espressif USB-Serial/JTAG port (VID 0x303A,
// PID 0x1001, the MAC as its USB serial number), so the hub lists, opens, reads and writes it as it does a board
// on the Mac's USB: a serial-only fr_net_node (the virtual fixture) reaches the hub process over its `@fr1:`
// lines. detach() is an unplug.
//
// The wire (one TCP connection per request): `list\n` -> one JSON line of PortInfo, then close; `open <path>\n` ->
// `ok\n` and the port's bytes both ways, or `err <message>\n`.

import { createServer, type Server, type Socket } from 'node:net';

import type { CppNode } from './cpp-node.ts';

interface Port {
  mac: string;
  path: string;
  /** A line the hub wrote to the device (no LF). */
  toDevice: (line: string) => void;
  /** The hub's open handles on it (one, unless a reopen overlaps). */
  open: Set<Socket>;
}

/** One device on the virtual USB hub. */
export interface VirtualPort {
  readonly path: string;
  /** A line the device prints (LF appended); dropped while the hub has the port closed, as on a real port. */
  print(line: string): void;
  /** Unplugs it: gone from the listing, its open handles closed (the hub sees a disconnect). */
  detach(): void;
}

const macText = (mac: string) => mac.toUpperCase().match(/../g)!.join(':');

export class VirtualUsb {
  readonly #server: Server;
  readonly #ports = new Map<string, Port>();
  readonly #sockets = new Set<Socket>();
  #port = 0;

  private constructor() {
    this.#server = createServer((sock) => this.#serve(sock));
  }

  static async open(): Promise<VirtualUsb> {
    const v = new VirtualUsb();
    await new Promise<void>((r) => v.#server.listen(0, '127.0.0.1', () => r()));
    v.#port = (v.#server.address() as { port: number }).port;
    return v;
  }

  /** What the hub's --serial-bridge takes. */
  get address(): string {
    return `127.0.0.1:${this.#port}`;
  }

  /** Plugs in a device with USB serial number `mac` (12 hex); `toDevice` gets every line the hub writes to it. */
  attach(mac: string, toDevice: (line: string) => void): VirtualPort {
    const path = `/dev/cu.usbmodem-fr-${mac}`;
    const port: Port = { mac, path, toDevice, open: new Set() };
    this.#ports.set(path, port);
    return {
      path,
      print: (line) => {
        for (const s of port.open) {
          s.write(`${line}\n`);
        }
      },
      detach: () => {
        if (this.#ports.get(path) === port) {
          this.#ports.delete(path);
        }
        for (const s of port.open) {
          s.destroy();
        }
        port.open.clear();
      },
    };
  }

  /** A `--serial 1` fr_net_node on this hub: its `@fr1:` lines out, the hub's lines to its stdin. */
  attachNode(node: CppNode, mac: string): VirtualPort {
    const port = this.attach(mac, (line) => node.send(line));
    node.onSerial = (line) => port.print(line);
    return port;
  }

  async close(): Promise<void> {
    for (const s of this.#sockets) {
      s.destroy();
    }
    await new Promise<void>((r) => this.#server.close(() => r()));
  }

  #serve(sock: Socket): void {
    this.#sockets.add(sock);
    sock.on('close', () => this.#sockets.delete(sock));
    sock.on('error', () => undefined);
    let head = '';
    let port: Port | null = null;
    let rest = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk: string) => {
      if (port) {
        rest += chunk;
      } else {
        head += chunk;
        const nl = head.indexOf('\n');
        if (nl < 0) {
          return;
        }
        const req = head.slice(0, nl).trim();
        rest = head.slice(nl + 1);
        if (req === 'list') {
          const list = [...this.#ports.values()].map((p) => ({
            path: p.path,
            manufacturer: 'Espressif',
            serialNumber: macText(p.mac),
            pnpId: undefined,
            locationId: undefined,
            vendorId: '303a',
            productId: '1001',
          }));
          sock.end(`${JSON.stringify(list)}\n`);
          return;
        }
        const m = /^open (\S+)$/.exec(req);
        const p = m ? this.#ports.get(m[1]) : undefined;
        if (!p) {
          sock.end(`err ${m ? `no such port ${m[1]}` : `bad request ${JSON.stringify(req)}`}\n`);
          return;
        }
        port = p;
        p.open.add(sock);
        sock.on('close', () => p.open.delete(sock));
        sock.write('ok\n');
      }
      let nl: number;
      while ((nl = rest.indexOf('\n')) >= 0) {
        const line = rest.slice(0, nl).replace(/\r$/, '');
        rest = rest.slice(nl + 1);
        port!.toDevice(line);
      }
    });
  }
}
