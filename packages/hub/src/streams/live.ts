// The live side of the generic streams (design csi-c1 D12, D13, §12; camera-c1 D12; stream H): which stream runs on
// which (device, instance), its counters, and the `/app/stream` sockets subscribed to it, whatever its kind (csi
// blocks of fr.csi, jpeg frames of fr.camera). The stream jobs (csi/ops.ts, camera/ops.ts) register their stream here
// and hand each block over; sockets (apps/stream.ts) subscribe per (device, instance) and get the stream that runs
// now, every block of it, its start and end. A stream an app began (`start` in its hello) is stopped when the last
// socket that asked for `start` leaves. A stream that is ending (`stopping`: its last starter left, or its job is
// stopping it) is not one to join for a `start`: the socket waits (afterEnd) and begins a new stream once it ended.
// One registry per hub, keyed by its event bus.

import type { StreamEndedFrame, StreamInfo } from '@fractonica/sdk/wire';

import type { Events } from '../context.ts';

/** What every sink counts, whatever the kind: `records` are csi records or jpeg frames, `bytes` the blocks' payload. */
export interface StreamCounts {
  records: number;
  /** Records (frames) the board dropped: jumps of first_index (index), counted, never filled. */
  dropped: number;
  blocks: number;
  /** csi: block bytes; jpeg: JPEG bytes. */
  bytes: number;
  /** Date.now() of the first block, null before it. */
  firstAt: number | null;
  lastAt: number | null;
}

/** One subscriber (an /app/stream socket). */
export interface StreamSubscriber {
  /** A stream began on its instance (also for one registered while it waited). */
  started(info: StreamInfo): void;
  /** One block, its exact bytes. */
  block(bytes: Uint8Array, info: StreamInfo): void;
  ended(frame: StreamEndedFrame): void;
  /** Blocks this subscriber was not sent (its backpressure), for the status ops' `gaps`. */
  readonly gaps: number;
}

export interface LiveStream {
  device: string;
  alias: string;
  instance: string;
  info: StreamInfo;
  counts: StreamCounts;
  /** The job carrying it (csi_stream, camera_stream, camera_snap, camera_sd_fetch). */
  jobId?: string;
  /** The .csi file (csi) or the directory or file of frames (jpeg) being written. */
  path?: string;
  /** Began by an app (/app/stream `start`): stopped when its last starter leaves. */
  appOwned: boolean;
  /** Published on /app/stream; a stream that is not is only counted (the status ops, BUSY). */
  live: boolean;
  /** Ends the stream (its job sends stream_stop): the last starter of an app's stream left. */
  stop(): void;
  /** Gaps of subscribers that have left (the status ops' `gaps` add the present ones'). */
  pastGaps: number;
  /** It is ending (its last starter left, or its job is stopping it): a `start` waits for its end, then begins anew. */
  stopping?: boolean;
}

const key = (device: string, instance: string) => `${device}/${instance}`;

export class LiveStreams {
  #streams = new Map<string, LiveStream>();
  #subs = new Map<string, Set<StreamSubscriber>>();
  /** Per stream, the subscribers that asked for `start` (an app's stream lives while one remains). */
  #starters = new Map<string, Set<StreamSubscriber>>();
  /** Per instance, the subscribers that asked for `start`, whatever runs (they hold the next app stream open too). */
  #askers = new Map<string, Set<StreamSubscriber>>();
  /** Per instance, what runs once its stream ended (a `start` that came while it was stopping). */
  #afterEnd = new Map<string, (() => void)[]>();

  /** The stream running on the instance, live or not. */
  get(device: string, instance: string): LiveStream | null {
    return this.#streams.get(key(device, instance)) ?? null;
  }

  /** The instance's stream when it is published live, else null (what /app/stream sees). */
  liveStream(device: string, instance: string): LiveStream | null {
    const s = this.get(device, instance);
    return s?.live ? s : null;
  }

  /** Streams running now. */
  all(): LiveStream[] {
    return [...this.#streams.values()];
  }

  subscribers(device: string, instance: string): number {
    return this.#subs.get(key(device, instance))?.size ?? 0;
  }

  /** Blocks the subscribers of the instance's stream were not sent, past and present. */
  gaps(device: string, instance: string): number {
    const s = this.get(device, instance);
    let n = s?.pastGaps ?? 0;
    for (const sub of this.#subs.get(key(device, instance)) ?? []) {
      n += sub.gaps;
    }
    return n;
  }

  /** A stream begins: subscribers already waiting on the instance hear of it. */
  register(s: LiveStream): void {
    const k = key(s.device, s.instance);
    this.#streams.set(k, s);
    // An app's stream is held open by every subscriber that asked for `start`, also one that waited for it.
    this.#starters.set(k, new Set(s.appOwned ? this.#askers.get(k) : []));
    if (!s.live) {
      return;
    }
    for (const sub of this.#subs.get(k) ?? []) {
      try {
        sub.started(s.info);
      } catch {
        // a socket that failed is its own
      }
    }
  }

  /** A block of the instance's stream to every subscriber. */
  block(device: string, instance: string, bytes: Uint8Array): void {
    const s = this.get(device, instance);
    if (!s?.live) {
      return;
    }
    for (const sub of this.#subs.get(key(device, instance)) ?? []) {
      try {
        sub.block(bytes, s.info);
      } catch {
        // its own
      }
    }
  }

  /** The stream ended: subscribers are told, and it is no longer the instance's. */
  end(device: string, instance: string, frame: StreamEndedFrame): void {
    const k = key(device, instance);
    const s = this.#streams.get(k);
    if (!s || s.info.stream_id !== frame.stream_id) {
      return;
    }
    this.#streams.delete(k);
    this.#starters.delete(k);
    if (s.live) {
      for (const sub of this.#subs.get(k) ?? []) {
        try {
          sub.ended(frame);
        } catch {
          // its own
        }
      }
    }
    const next = this.#afterEnd.get(k) ?? [];
    this.#afterEnd.delete(k);
    for (const fn of next) {
      try {
        fn();
      } catch {
        // its own
      }
    }
  }

  /** `fn` runs once the instance's stream ended (at once when none runs). */
  afterEnd(device: string, instance: string, fn: () => void): void {
    const k = key(device, instance);
    if (!this.#streams.has(k)) {
      fn();
      return;
    }
    const list = this.#afterEnd.get(k) ?? [];
    list.push(fn);
    this.#afterEnd.set(k, list);
  }

  /** `sub` hears the instance's streams; `starter`: it holds an app's stream open. Returns the unsubscribe. */
  subscribe(device: string, instance: string, sub: StreamSubscriber, starter = false): () => void {
    const k = key(device, instance);
    let set = this.#subs.get(k);
    if (!set) {
      set = new Set();
      this.#subs.set(k, set);
    }
    set.add(sub);
    if (starter) {
      let askers = this.#askers.get(k);
      if (!askers) {
        askers = new Set();
        this.#askers.set(k, askers);
      }
      askers.add(sub);
      const s = this.#streams.get(k);
      if (s?.appOwned && !s.stopping) {
        this.#starters.get(k)?.add(sub);
      }
    }
    return () => {
      set.delete(sub);
      if (!set.size) {
        this.#subs.delete(k);
      }
      const askers = this.#askers.get(k);
      if (askers?.delete(sub) && !askers.size) {
        this.#askers.delete(k);
      }
      const s = this.#streams.get(k);
      if (s) {
        s.pastGaps += sub.gaps;
      }
      const starters = this.#starters.get(k);
      if (starters?.delete(sub) && !starters.size && s?.appOwned) {
        s.stopping = true; // a `start` from now on begins the next stream once this one ended
        s.stop(); // its last starter left (D12)
      }
    };
  }
}

const registries = new WeakMap<Events, LiveStreams>();

/** The hub's live stream registry (one per event bus: a hub, or a test rig). */
export function liveStreams(hub: { events: Events }): LiveStreams {
  let r = registries.get(hub.events);
  if (!r) {
    r = new LiveStreams();
    registries.set(hub.events, r);
  }
  return r;
}
