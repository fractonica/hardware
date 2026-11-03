// The page's side of the synth: one AudioContext asking for the lowest output latency the browser gives (a latencyHint
// of 0 s where a number is accepted, else 'interactive'), one AudioWorkletNode running ./worklet.ts, and the hot path
// `send`: one postMessage on the node's port per value, called straight from the socket's message handler.
// Created on a user gesture (autoplay rules).

import type { EngineParams } from './dsp/engine.ts';
import type { Meter } from './dsp/engine.ts';
import type { ToSynth } from './worklet.ts';
import workletUrl from './worklet.ts?worker&url';

export interface AudioLatency {
  /** The hint the context accepted. */
  hint: string;
  sampleRate: number;
  /** s: the context's processing latency (one or two quanta in most browsers). */
  base: number;
  /** s: the output's own (device, OS mixer); NaN when the browser does not say. */
  output: number;
  /** s: one render quantum (a value waits at most this for the worklet to take it). */
  quantum: number;
}

export class Instrument {
  #ctx: AudioContext | null = null;
  #node: AudioWorkletNode | null = null;
  #port: MessagePort | null = null;
  #hint = '';
  #starting: Promise<void> | null = null;
  onMeter: ((m: Meter) => void) | null = null;

  get running(): boolean {
    return this.#port !== null && this.#ctx?.state === 'running';
  }

  get context(): AudioContext | null {
    return this.#ctx;
  }

  /** Call from a user gesture: creates the context and the worklet the first time, resumes it. */
  start(params: EngineParams): Promise<void> {
    if (this.#ctx && this.#node) {
      return this.#ctx.state === 'running' ? Promise.resolve() : this.#ctx.resume();
    }
    this.#starting ??= this.#create(params).finally(() => (this.#starting = null));
    return this.#starting;
  }

  async #create(params: EngineParams): Promise<void> {
    const AC = globalThis.AudioContext ?? (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) {
      throw new Error('this browser has no Web Audio');
    }
    let ctx: AudioContext;
    try {
      ctx = new AC({ latencyHint: 0 });
      this.#hint = '0 s';
    } catch {
      ctx = new AC({ latencyHint: 'interactive' });
      this.#hint = 'interactive';
    }
    this.#ctx = ctx;
    if (!ctx.audioWorklet) {
      throw new Error('this browser has no AudioWorklet (a secure context is needed: open the page from 127.0.0.1)');
    }
    await ctx.audioWorklet.addModule(workletUrl);
    const node = new AudioWorkletNode(ctx, 'force-synth', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    node.port.onmessage = (e: MessageEvent<{ meter?: Meter }>) => {
      if (e.data.meter) {
        this.onMeter?.(e.data.meter);
      }
    };
    node.port.postMessage({ set: params } satisfies ToSynth);
    node.connect(ctx.destination);
    this.#node = node;
    this.#port = node.port;
    if (ctx.state !== 'running') {
      await ctx.resume();
    }
  }

  /** The hot path: the force (0..1) and a hit's strength, to the worklet now. */
  send(f: number, hit: number | null): void {
    const p = this.#port;
    if (p) {
      p.postMessage(hit === null ? { f } : { f, h: hit });
    }
  }

  set(params: Partial<EngineParams>): void {
    this.#port?.postMessage({ set: params } satisfies ToSynth);
  }

  latency(): AudioLatency | null {
    const ctx = this.#ctx;
    if (!ctx) {
      return null;
    }
    const output = (ctx as AudioContext & { outputLatency?: number }).outputLatency;
    return { hint: this.#hint, sampleRate: ctx.sampleRate, base: ctx.baseLatency ?? NaN, output: typeof output === 'number' ? output : NaN, quantum: 128 / ctx.sampleRate };
  }
}
