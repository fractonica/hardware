// The live JPEG stream (design camera-c1 D12, §10): a thin wrap of the SDK's `hub.streams.subscribe`, so this app has
// one implementation of mjpg1 and `/app/stream`. The subscription's `start` takes the camera's names in camelCase
// (`intervalMs`, `frameSize`, `quality`) and is handed to the SDK in the hello's spelling; every binary message reaches
// `onFrame` as a JpegBlock: the SDK's own parse when it is jpeg-aware (stream H's handler `(block, bytes, stream)`), else
// parseJpegBlock over the exact bytes. A message of another kind (a csi stream on the instance, which fr.camera never
// has) is ignored. The subscription object says which stream it is on and whether the socket is open.

import type { Hub, StreamDescription, StreamEvent, StreamSubscribeOptions as SdkSubscribeOptions } from '@fractonica/sdk';
import { type JpegBlock, parseJpegBlock } from '@fractonica/sdk/camera';
import type { CameraFrameSize } from '@fractonica/sdk/wire';

export type { JpegBlock, StreamDescription, StreamEvent };

export interface LiveStart {
  /** 0: as fast as the sensor and the path allow. */
  intervalMs?: number;
  frameSize?: CameraFrameSize;
  quality?: number;
}

export interface SubscribeOptions {
  /** Start a live stream (to hub) when none runs; without it the socket joins a running one, or waits for the next. */
  start?: LiveStart;
  onEvent?: (e: StreamEvent) => void;
}

export interface Subscription {
  /** The stream the socket is on now, null while none runs. */
  readonly stream: StreamDescription | null;
  readonly open: boolean;
  /** Leaves for good (a stream this socket started ends when no other starter remains). */
  close(): void;
}

/** The hello's `start` for a camera, in the wire's spelling (StreamHelloFrame.start). */
export function toHelloStart(s: LiveStart): NonNullable<SdkSubscribeOptions['start']> {
  return {
    ...(s.intervalMs !== undefined ? { interval_ms: Math.max(0, Math.round(s.intervalMs)) } : {}),
    ...(s.frameSize !== undefined ? { frame_size: s.frameSize } : {}),
    ...(s.quality !== undefined ? { quality: Math.round(s.quality) } : {}),
  };
}

/** A block the SDK already parsed as mjpg1 (its `jpeg` view), or anything else. */
export function isJpegBlock(b: unknown): b is JpegBlock {
  return typeof b === 'object' && b !== null && (b as { jpeg?: unknown }).jpeg instanceof Uint8Array && typeof (b as { index?: unknown }).index === 'number';
}

/**
 * The JpegBlock of one `/app/stream` message: the SDK's parse when it is one, else the bytes parsed here. Null for a
 * message of another kind (the stream says csi) or bytes that are not an mjpg1 block.
 */
export function frameOf(block: unknown, bytes: Uint8Array, stream?: StreamDescription | null): JpegBlock | null {
  if (stream && stream.kind !== 'jpeg') {
    return null;
  }
  if (isJpegBlock(block)) {
    return block;
  }
  try {
    return parseJpegBlock(bytes);
  } catch {
    return null;
  }
}

/**
 * Subscribes to the fr.camera stream of `device` (alias or id) and `instance`: `onFrame` gets every frame the hub sends.
 * One socket per subscription; the hub's reconnect backoff applies (never after 4400, 4401, 4409).
 */
export function subscribeLive(hub: Hub, device: string, instance: string | undefined, onFrame: (frame: JpegBlock, stream: StreamDescription | null) => void, opts: SubscribeOptions = {}): Subscription {
  const sub = { stream: null as StreamDescription | null, open: false, close: () => {} };
  const emit = (e: StreamEvent) => opts.onEvent?.(e);
  // The SDK's handler is (block, bytes) today and (block, bytes, stream) once jpeg-aware (stream H): both call this.
  const onBlock = (block: unknown, bytes: Uint8Array, stream?: StreamDescription) => {
    const f = frameOf(block, bytes, stream ?? sub.stream);
    if (f) {
      onFrame(f, stream ?? sub.stream);
    }
  };
  sub.close = hub.streams.subscribe(device, instance, onBlock, {
    ...(opts.start ? { start: toHelloStart(opts.start) } : {}),
    onEvent: (e) => {
      switch (e.type) {
        case 'welcome':
          sub.open = true;
          sub.stream = e.stream;
          break;
        case 'started':
          sub.stream = e.stream;
          break;
        case 'ended':
          sub.stream = null;
          break;
        case 'closed':
          sub.open = false;
          sub.stream = null;
          break;
        default:
          break;
      }
      emit(e);
    },
  });
  return sub;
}
