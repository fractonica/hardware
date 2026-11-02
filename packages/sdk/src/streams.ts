// `client.streams` (design csi-c1 D12, §12): one `/app/stream` WebSocket per subscription, beside the hub's `/app`.
// The hello carries the token (never the URL), the device and its instance, and `start` to begin a live stream when
// none runs; every binary message is one csi1 block, parsed and handed to onBlock as it arrives; the text
// frames (welcome, started, ended, gap, error) go to onEvent. A lost socket reconnects with the hub's backoff (and
// asks for `start` again) until the returned unsubscribe is called; 4400, 4401 and 4409 are final. onBlock gets
// (block, bytes): the parsed block and its exact bytes.

import { type CsiBlock, parseCsiBlock } from './csi.ts';
import { FATAL_CLOSE_CODES } from './connection.ts';
import type { ReconnectOptions } from './types.ts';
import { APP_PROTOCOL_V, APP_STREAM_PATH, type StreamHelloFrame, type StreamHubFrame, type StreamInfo } from './wire.ts';

export type StreamSource = 'router' | 'peer' | 'any';

/** A stream as the SDK reports it (StreamInfo in camelCase). */
export interface StreamDescription {
  streamId: number;
  kind: 'csi';
  format: 'csi1';
  source: StreamSource;
  peerMac?: string;
  /** 0: until stopped. */
  seconds: number;
}

export type StreamEvent =
  /** The socket opened (the hello went out). */
  | { type: 'open' }
  /** The hub took the hello: the stream running now (or the one `start` began), null while none runs. */
  | { type: 'welcome'; device: string; alias: string; instance: string; stream: StreamDescription | null }
  | { type: 'started'; stream: StreamDescription }
  | { type: 'ended'; streamId: number; reason: 'stopped' | 'done' | 'net_lost' | 'overflow' | 'error' | 'timeout'; records: number; dropped: number }
  /** Blocks the hub did not send this socket (it was too slow); the board's own drops show in firstIndex instead. */
  | { type: 'gap'; streamId: number; blocks: number }
  /** A refusal (a device or instance that is not there: final) or a start that failed (the socket waits on). */
  | { type: 'error'; code: string; message: string }
  /** The socket closed; `retry`: it reconnects. */
  | { type: 'closed'; code: number; reason: string; retry: boolean };

export interface StreamSubscribeOptions {
  /** Begin a live stream when none runs (stopped by the hub when its last such subscriber leaves). */
  start?: { source?: StreamSource; /** The transmitter for source peer: a device alias or id, or a MAC. */ peer?: string };
  onEvent?: (e: StreamEvent) => void;
}

/** One block: parsed (parseCsiBlock), and its exact bytes (the node's HTTP chunk, as a .csi file keeps them). */
export type StreamBlockHandler = (block: CsiBlock, bytes: Uint8Array) => void;

export interface Streams {
  /**
   * Subscribes to the stream of `device`'s fr.csi `instance` (undefined: its only one). Returns the unsubscribe, which
   * closes the socket (and, when this was the last subscriber that started it, ends the stream).
   */
  subscribe(device: string, instance: string | undefined, onBlock: StreamBlockHandler, opts?: StreamSubscribeOptions): () => void;
}

interface WsLike {
  readonly readyState: number;
  binaryType: string;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface StreamClientOptions {
  /** The hub's `/app` URL; the stream socket is its sibling `/app/stream`. */
  url: string;
  token: () => string;
  WebSocket: new (url: string) => unknown;
  reconnect: Required<ReconnectOptions> | false;
}

/** `ws://host/app` -> `ws://host/app/stream` (any other path: APP_STREAM_PATH on its origin). */
export function streamUrl(appUrl: string): string {
  const u = new URL(appUrl);
  u.pathname = /\/app\/?$/.test(u.pathname) ? u.pathname.replace(/\/?$/, '').replace(/\/app$/, APP_STREAM_PATH) : APP_STREAM_PATH;
  u.search = '';
  return u.toString();
}

const describe = (s: StreamInfo): StreamDescription => ({
  streamId: s.stream_id,
  kind: s.kind,
  format: s.format,
  source: s.source,
  ...(s.peer_mac !== undefined ? { peerMac: s.peer_mac } : {}),
  seconds: s.seconds,
});

/** Binary message data as bytes: an ArrayBuffer (browsers, binaryType arraybuffer), a view, a Buffer, or an array of Buffers (ws). */
function bytesOf(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (Array.isArray(data) && data.every((d) => ArrayBuffer.isView(d))) {
    const parts = data as ArrayBufferView[];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
    let at = 0;
    for (const p of parts) {
      out.set(new Uint8Array(p.buffer, p.byteOffset, p.byteLength), at);
      at += p.byteLength;
    }
    return out;
  }
  return null;
}

export class StreamClient implements Streams {
  #o: StreamClientOptions;
  #subs = new Set<() => void>();

  constructor(o: StreamClientOptions) {
    this.#o = o;
  }

  subscribe(device: string, instance: string | undefined, onBlock: StreamBlockHandler, opts: StreamSubscribeOptions = {}): () => void {
    const o = this.#o;
    let ws: WsLike | null = null;
    let done = false;
    let attempt = 0;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const emit = (e: StreamEvent) => {
      try {
        opts.onEvent?.(e);
      } catch (err) {
        if (typeof console !== 'undefined') {
          console.error(err);
        }
      }
    };
    const open = () => {
      retry = null;
      let sock: WsLike;
      try {
        sock = new o.WebSocket(streamUrl(o.url)) as WsLike;
      } catch (e) {
        emit({ type: 'error', code: 'HUB_UNREACHABLE', message: (e as Error).message });
        return;
      }
      ws = sock;
      sock.binaryType = 'arraybuffer';
      sock.onopen = () => {
        const hello: StreamHelloFrame = {
          t: 'stream.hello',
          v: APP_PROTOCOL_V,
          token: o.token(),
          device,
          ...(instance !== undefined ? { instance } : {}),
          ...(opts.start ? { start: opts.start } : {}),
        };
        sock.send(JSON.stringify(hello));
        emit({ type: 'open' });
      };
      sock.onmessage = (ev) => {
        if (done) {
          return;
        }
        if (typeof ev.data === 'string') {
          let f: StreamHubFrame;
          try {
            f = JSON.parse(ev.data) as StreamHubFrame;
          } catch {
            return;
          }
          frame(sock, f);
          return;
        }
        const b = bytesOf(ev.data);
        if (b) {
          let block: CsiBlock;
          try {
            block = parseCsiBlock(b);
          } catch (err) {
            emit({ type: 'error', code: 'PROTOCOL', message: `a binary message that is not a csi1 block: ${(err as Error).message}` });
            return;
          }
          try {
            onBlock(block, b);
          } catch (err) {
            if (typeof console !== 'undefined') {
              console.error(err);
            }
          }
        }
      };
      sock.onerror = () => undefined; // onclose follows
      sock.onclose = (ev) => {
        if (ws === sock) {
          ws = null;
        }
        if (done) {
          return; // unsubscribed: no more events
        }
        const again = !done && o.reconnect !== false && !FATAL_CLOSE_CODES.includes(ev.code);
        emit({ type: 'closed', code: ev.code, reason: ev.reason, retry: again });
        if (again && o.reconnect !== false) {
          const r = o.reconnect;
          const base = Math.min(r.maxMs, r.minMs * r.factor ** attempt++);
          retry = setTimeout(open, base * (1 + (Math.random() * 2 - 1) * r.jitter));
        }
      };
    };
    const frame = (sock: WsLike, f: StreamHubFrame) => {
      switch (f.t) {
        case 'stream.welcome':
          attempt = 0;
          emit({ type: 'welcome', device: f.device, alias: f.alias, instance: f.instance, stream: f.stream ? describe(f.stream) : null });
          return;
        case 'stream.started':
          emit({ type: 'started', stream: describe(f.stream) });
          return;
        case 'stream.ended':
          emit({ type: 'ended', streamId: f.stream_id, reason: f.reason, records: f.records, dropped: f.dropped });
          return;
        case 'stream.gap':
          emit({ type: 'gap', streamId: f.stream_id, blocks: f.blocks });
          return;
        case 'ping':
          sock.send(JSON.stringify({ t: 'pong', id: f.id }));
          return;
        case 'error':
          emit({ type: 'error', code: f.code, message: f.message });
          return;
        default:
          return;
      }
    };
    const unsubscribe = () => {
      if (done) {
        return;
      }
      done = true;
      this.#subs.delete(unsubscribe);
      if (retry) {
        clearTimeout(retry);
        retry = null;
      }
      const s = ws as WsLike | null;
      ws = null;
      try {
        s?.close(1000, 'unsubscribed');
      } catch {
        // already closed
      }
    };
    this.#subs.add(unsubscribe);
    open();
    return unsubscribe;
  }

  /** Every subscription ends (hub.close()). */
  closeAll(): void {
    for (const u of [...this.#subs]) {
      u();
    }
  }
}
