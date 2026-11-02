// The live CSI channel (design csi-c1 D12, §12): a thin wrap of @fractonica/sdk, so the app has one implementation of
// csi1 and `/app/stream`. parseCsiBlock and csiAmplitudes are the SDK's (a malformed block throws CsiParseError, a
// RangeError; amplitudes of a first word flagged invalid read NaN). streams.subscribe is the SDK's StreamClient
// subscription, kept in this app's shape: the stream URL and token default from the page the hub serves, events
// carry the wire's StreamInfo, and the subscription object says which stream it is on and whether it is open.

import { type CsiBlock, csiAmplitudes as sdkAmplitudes, type CsiRecord, parseCsiBlock, StreamClient, type StreamDescription, type StreamSource } from '@fractonica/sdk';
import { APP_STREAM_PATH, type StreamInfo } from '@fractonica/sdk/wire';

export { parseCsiBlock };
export type { CsiBlock, CsiRecord, StreamInfo, StreamSource };

/** A record's amplitude per subcarrier, √(re² + im²), NaN for the first two when its first word is invalid; into `out` when given. */
export function csiAmplitudes(rec: CsiRecord, out?: Float32Array): Float32Array {
  return sdkAmplitudes(rec, out ? { out } : {});
}

export interface StreamSubscribeOptions {
  /** Start a live stream when none runs (the hub ends it when its last such subscriber leaves). */
  start?: { source?: StreamSource; peer?: string };
  /** Default: `ws(s)://<page host>/app/stream` on a page the hub serves under /apps/, else ws://127.0.0.1:7420. */
  url?: string;
  /** Default: window.__FRACTONICA__.token, which the hub injects into the pages it serves. */
  token?: string;
  /** Reopen after a lost socket, with backoff (default true); never after 4400, 4401 or 4409. */
  reconnect?: boolean;
  /** The socket's life: the welcome, a stream's start and end, hub gaps, errors, closes. */
  onEvent?: (e: StreamEvent) => void;
  WebSocket?: typeof WebSocket;
}

export type StreamEvent =
  | { type: 'open' }
  | { type: 'welcome'; device: string; alias: string; instance: string; stream: StreamInfo | null }
  | { type: 'started'; stream: StreamInfo }
  | { type: 'ended'; streamId: number; reason: string; records: number; dropped: number }
  | { type: 'gap'; streamId: number; blocks: number }
  | { type: 'error'; code: string; message: string }
  | { type: 'closed'; code: number; reason: string; willReconnect: boolean };

export interface StreamSubscription {
  /** The stream the socket is on now, null while none runs. */
  readonly stream: StreamInfo | null;
  readonly open: boolean;
  /** Leaves for good (a stream this socket started ends when no other starter remains). */
  close(): void;
}

type Globals = { location?: { protocol: string; host: string; pathname: string }; __FRACTONICA__?: { token?: unknown } };

export function defaultStreamUrl(): string {
  const loc = (globalThis as Globals).location;
  if (loc && (loc.protocol === 'http:' || loc.protocol === 'https:') && loc.pathname.startsWith('/apps/')) {
    return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}${APP_STREAM_PATH}`;
  }
  return `ws://127.0.0.1:7420${APP_STREAM_PATH}`;
}

function injectedToken(): string | undefined {
  const t = (globalThis as Globals).__FRACTONICA__?.token;
  return typeof t === 'string' ? t : undefined;
}

/** The SDK's StreamDescription as the wire's StreamInfo (what this app shows). */
const info = (s: StreamDescription): StreamInfo => ({
  stream_id: s.streamId,
  kind: s.kind,
  format: s.format,
  source: s.source,
  ...(s.peerMac !== undefined ? { peer_mac: s.peerMac } : {}),
  seconds: s.seconds,
});

const RECONNECT = { minMs: 250, maxMs: 5000, factor: 2, jitter: 0.2 };

export const streams = {
  /**
   * Subscribes to the fr.csi stream of `device` (alias or id) and `instance` (undefined: its only fr.csi one):
   * `onBlock` gets every block the hub sends, parsed, with its bytes. One socket per subscription.
   */
  subscribe(device: string, instance: string | undefined, onBlock: (block: CsiBlock, bytes: Uint8Array) => void, opts: StreamSubscribeOptions = {}): StreamSubscription {
    const client = new StreamClient({
      url: opts.url ?? defaultStreamUrl(),
      token: () => opts.token ?? injectedToken() ?? '',
      WebSocket: (opts.WebSocket ?? globalThis.WebSocket) as unknown as new (url: string) => unknown,
      reconnect: opts.reconnect === false ? false : RECONNECT,
    });
    const sub = { stream: null as StreamInfo | null, open: false, close: () => {} };
    const emit = (e: StreamEvent) => opts.onEvent?.(e);
    sub.close = client.subscribe(device, instance, onBlock, {
      ...(opts.start ? { start: opts.start } : {}),
      onEvent: (e) => {
        switch (e.type) {
          case 'welcome':
            sub.open = true;
            sub.stream = e.stream ? info(e.stream) : null;
            return emit({ type: 'welcome', device: e.device, alias: e.alias, instance: e.instance, stream: sub.stream });
          case 'started':
            sub.stream = info(e.stream);
            return emit({ type: 'started', stream: sub.stream });
          case 'ended':
            sub.stream = null;
            return emit(e);
          case 'closed':
            sub.open = false;
            sub.stream = null;
            return emit({ type: 'closed', code: e.code, reason: e.reason, willReconnect: e.retry });
          default:
            return emit(e);
        }
      },
    });
    return sub;
  },
};
