// Serial `@fr1` ENV frames as a node link (spec 05 §5.12.3, 08 §8.2-8.4): a USB-attached node is a full
// hub link. Ingress: the log store's frame decoder is the one place every `@fr1:` line passes through
// (SerialPortManager splits lines, LogStore renders frames), so a FrameDecoder subclass taps it there and
// the log text stays exactly as before. Egress: one `@fr1:` line per envelope through the hub's own
// handle (SerialPortManager.writeLine).

import { decodeSerialLine, encodeSerialLine, SERIAL_TYPE } from '@fractonica/protocol';

import { FrameDecoder, type FrameText } from '../frames.ts';
import { type Endpoint, type LinkSink, newCounters } from './types.ts';

/** What the serial link needs of SerialPortManager. */
export interface SerialWriter {
  writeLine(selector: string, line: string): Promise<unknown>;
}

/**
 * The log store's frame decoder plus a tap: each `@fr1:` line is rendered for the log as before, then
 * handed to the attached listener in a microtask, so the line is stored (and has its cursor) before the
 * router publishes what it carries, all in the same tick.
 */
export class SerialFrameTap extends FrameDecoder {
  #onLine: ((device: string, line: string) => void) | null = null;

  attach(onLine: ((device: string, line: string) => void) | null): void {
    this.#onLine = onLine;
  }

  override format(device: string, line: string): FrameText {
    const text = super.format(device, line);
    const onLine = this.#onLine;
    if (onLine) {
      queueMicrotask(() => {
        try {
          onLine(device, line);
        } catch (e) {
          console.error(JSON.stringify({ event: 'serial_link_error', device, message: (e as Error).message }));
        }
      });
    }
    return text;
  }
}

/** Envelopes queued for one port before more are dropped (writeLine refuses a stuck port anyway). */
const MAX_QUEUED = 32;

class SerialEndpoint implements Endpoint {
  readonly kind = 'serial' as const;
  readonly id: string;
  readonly remote: string;
  closed = false;
  #link: SerialLink;
  #queued = 0;
  #tail: Promise<void> = Promise.resolve();

  constructor(link: SerialLink, key: string, n: number) {
    this.#link = link;
    this.remote = key;
    this.id = `serial:${key}#${n}`;
  }

  send(envelope: Uint8Array): boolean {
    const writer = this.#link.writer;
    if (this.closed || !writer || this.#queued >= MAX_QUEUED) {
      this.#link.counters.tx_drop++;
      return false;
    }
    let line: string;
    try {
      line = encodeSerialLine(SERIAL_TYPE.ENV, envelope);
    } catch {
      this.#link.counters.tx_drop++; // longer than a serial line can carry
      return false;
    }
    // One write at a time per port, in order: the next line goes once the kernel has the previous one.
    this.#queued++;
    this.#tail = this.#tail.then(() =>
      writer.writeLine(this.remote, line).then(
        () => {
          this.#queued--;
          this.#link.counters.tx++;
        },
        () => {
          this.#queued--;
          this.#link.counters.tx_drop++;
        },
      ),
    );
    return true;
  }

  /** Every line queued so far is written or refused: a serial lease closes the port after the BYE (design c6 D4). */
  flushed(): Promise<void> {
    return this.#tail;
  }

  /** Ends the session on this port; the next line from it starts a new endpoint. */
  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.#link.forget(this);
    }
  }
}

export class SerialLink {
  #sink: LinkSink;
  #endpoints = new Map<string, SerialEndpoint>();
  #n = 0;
  writer: SerialWriter | null;
  readonly counters = newCounters();

  constructor(sink: LinkSink, writer: SerialWriter | null) {
    this.#sink = sink;
    this.writer = writer;
  }

  /** One `@fr1:` line a port printed (device = the port key: the USB serial, which is the MAC). */
  line(device: string, line: string): void {
    const frame = decodeSerialLine(line);
    if (!frame.ok) {
      this.counters.rx_bad++;
      return;
    }
    if (frame.value.type !== SERIAL_TYPE.ENV) {
      return; // gateway frames (GW_*) and LINK_PING arrive with gateway mode (M2)
    }
    this.counters.rx++;
    this.#sink.envelope(this.endpoint(device), frame.value.body);
  }

  endpoint(device: string): Endpoint {
    let ep = this.#endpoints.get(device);
    if (!ep) {
      ep = new SerialEndpoint(this, device, ++this.#n);
      this.#endpoints.set(device, ep);
    }
    return ep;
  }

  /**
   * The port `device` is gone (USB unplugged): its endpoint closes and the sink hears of it now, instead
   * of the session running out its presence timeout. The next line from that port starts a new endpoint.
   */
  gone(device: string, why: string): void {
    const ep = this.#endpoints.get(device);
    if (ep) {
      ep.close();
      this.#sink.closed(ep, why);
    }
  }

  forget(ep: SerialEndpoint): void {
    if (this.#endpoints.get(ep.remote) === ep) {
      this.#endpoints.delete(ep.remote);
    }
  }
}
