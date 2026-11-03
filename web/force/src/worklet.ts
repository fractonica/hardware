// The synth's AudioWorklet (bundled by vite through `?worker&url`, loaded with audioWorklet.addModule): the engine of
// ./dsp/engine.ts in the audio thread. The page posts each new force on the node's port the moment it arrives (one
// message per value, {f, h?}: the force 0..1 and a hit's strength); the port's messages are handled between render
// quanta (128 samples), so a value reaches the sound at the next quantum, then slews in ~1 ms. Nothing is scheduled
// ahead on the audio clock. It posts its meter back about 20 times a second.

import { Engine, type EngineParams } from './dsp/engine.ts';

// The AudioWorkletGlobalScope, as far as this file uses it (lib.dom does not describe it).
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;

/** What the page posts. */
export interface ToSynth {
  f?: number;
  h?: number;
  set?: Partial<EngineParams>;
}

const METER_SAMPLES = 2048;

class ForceSynth extends AudioWorkletProcessor {
  readonly #engine = new Engine(sampleRate);
  #mono = new Float32Array(128);

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<ToSynth>) => {
      const m = e.data;
      if (m.set) {
        this.#engine.set(m.set);
      }
      if (typeof m.f === 'number') {
        this.#engine.force(m.f);
      }
      if (typeof m.h === 'number') {
        this.#engine.hit(m.h);
      }
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    const l = out[0];
    if (!l) {
      return true;
    }
    let r = out[1];
    if (!r) {
      if (this.#mono.length !== l.length) {
        this.#mono = new Float32Array(l.length);
      }
      r = this.#mono;
    }
    this.#engine.process(l, r);
    if (this.#engine.metered >= METER_SAMPLES) {
      this.port.postMessage({ meter: this.#engine.takeMeter() });
    }
    return true;
  }
}

registerProcessor('force-synth', ForceSynth);
