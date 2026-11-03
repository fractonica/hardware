// web/csi's drone sonification, the Web Audio half (design csi-c1 §14), and the Sound panel that drives it. The
// mapping (bands, shape, activity, motion) is ./sonify-map.ts; here one oscillator voice per band, pitched on a
// scale from the root (low bands low, ~3 octaves): a sine and a quieter triangle an octave up, each with a slow LFO
// on its detune whose depth follows the shimmer (up to ±20 cents). In the raw pitch mode the voices are unquantised,
// evenly spaced, and each one's detune follows its band's bend (up to ±the Bend slider's semitones). The voices share a low-pass filter whose cutoff
// follows the brightness (~400 Hz to 6 kHz), a convolver reverb (its impulse response made here: decaying,
// darkened stereo noise), a compressor and the master gain; per-voice levels leave headroom for every band at once.
// The AudioContext is created on the first "Sound on" click (autoplay rules); the engine is updated at ~60 Hz from
// the latest mapping, not per record. Off ramps to silence, then suspends the context.
// The parrot mode (design §15; the listening is ./parrot.ts) mutes the drone and speaks each word: a sawtooth buzz at
// an octave above the root, its pitch following the word's intonation (± Bend semitones, falling 2 semitones over the
// word), plus a little breath noise, through a bank of band-pass "formants" (250 Hz .. 5 kHz, one per band, low bands
// low) whose gains follow the bands' activity curves. Words share the drone's reverb and compressor, not its filter.
// The laughter mode (design §16; the recording and composing is ./laugh.ts) plays each laugh as a run of "ha"s: one
// sawtooth two octaves above the root stepping through the syllables' pitches (each "ha" glides down a little), breath
// noise puffing before each one, through two vowel formants (F1/F2 set per syllable between "ho", "ha" and "hee") and
// a fixed third, with a sharp attack and a quick decay per syllable. The babble mode (§17) plays the same way with
// five vowels, four onsets (a breath, a stop's burst, a nasal's hum, a glide's formant sweep) and a softer attack.

import {
  BAND_CHOICES,
  BEND_MAX,
  DEFAULT_BEND,
  DEFAULT_PITCH_MODE,
  DEFAULT_ROOT,
  DEFAULT_SCALE,
  DroneMapper,
  midiToHz,
  noteName,
  PITCH_MODES,
  rawFrequencies,
  ROOT_MAX,
  ROOT_MIN,
  SCALES,
  voiceFrequencies,
  type DroneFrame,
  type PitchMode,
  type ScaleName,
} from './sonify-map.ts';
import type { Laugh, Syllable } from './laugh.ts';
import { LaughRecorder } from './laugh.ts';
import { DEFAULT_LISTEN, DEFAULT_RATIO, DEFAULT_THRESHOLD, LISTEN_MAX, LISTEN_MIN, ParrotRecorder, RATIO_MAX, RATIO_MIN, type ParrotWord } from './parrot.ts';

const UPDATE_MS = 16;
/** Time constants (s) of the per-voice gain, the cutoff, the shimmer depth, pitch glides and the raw mode's bends. */
const GAIN_TAU = 0.02;
const CUTOFF_TAU = 0.06;
const SHIMMER_TAU = 0.1;
const GLIDE_TAU = 0.25;
const BEND_TAU = 0.015;
const CUTOFF_MIN = 400;
const CUTOFF_MAX = 6000;
/** Detune LFO depth (cents) at shimmer 0 and 1. */
const SHIMMER_MIN_C = 1;
const SHIMMER_MAX_C = 20;
/** A word starts this long after it is asked for (s), so its automation is scheduled ahead of the audio clock. */
const SPEAK_LEAD_S = 0.03;
/** The formants' range (Hz), the breath noise's level and the words' overall level. */
const FORMANT_LO = 250;
const FORMANT_HI = 5000;
const BREATH = 0.12;
const WORD_GAIN = 0.6;

/** The laughs' level and the vowels' first two formants (Hz): the laugh's "ho", "ha", "hee"; the babble's u o a e i. */
const LAUGH_GAIN = 3; // the formants pass little of the sawtooth: measured offline, a laugh peaks near -3 dBFS
const LAUGH_VOWELS: [number, number][] = [
  [480, 900],
  [720, 1200],
  [300, 2300],
];
const BABBLE_VOWELS: [number, number][] = [
  [320, 800],
  [480, 900],
  [720, 1200],
  [500, 1900],
  [300, 2300],
];

export type SoundMode = 'drone' | 'parrot' | 'laugh' | 'babble';
export const SOUND_MODES: Record<SoundMode, string> = {
  drone: 'drone',
  parrot: 'parrot (speaks movement back)',
  laugh: 'laughter (laughs at movement)',
  babble: 'babble (a language from movement)',
};

interface Voice {
  sine: OscillatorNode;
  tri: OscillatorNode;
  lfo: OscillatorNode;
  depth: GainNode;
  amp: GainNode;
  /** The voice's level scale: headroom over the bands times a gentle tilt down for the high voices. */
  scale: number;
  /** A few cents of random spread, for life. */
  jitter: number;
  /** Its resting detune (cents): the repeated-note offset plus the jitter. */
  spread: number;
}

/** A stereo impulse response: ~3.5 s of decaying noise, low-passed (darker as it decays) after a short pre-delay. */
function impulseResponse(ctx: BaseAudioContext, seconds = 3.5, tau = 0.65): AudioBuffer {
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const pre = Math.floor(rate * 0.02);
  const buf = ctx.createBuffer(2, len, rate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let lp = 0;
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / rate;
      // one-pole low-pass, its coefficient falling with time: the tail loses its highs first
      const k = 0.55 - 0.4 * Math.min(1, t / seconds);
      lp += k * (Math.random() * 2 - 1 - lp);
      d[i] = lp * Math.exp(-t / tau);
    }
    // fade the last 50 ms to avoid a click
    const fade = Math.floor(rate * 0.05);
    for (let i = 0; i < fade; i++) {
      d[len - 1 - i] *= i / fade;
    }
  }
  return buf;
}

/** One second of white noise (looped for the words' breath). */
function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) {
    d[i] = Math.random() * 2 - 1;
  }
  return buf;
}

/** The formant bank for n bands: centre frequencies log-spaced FORMANT_LO..FORMANT_HI, each Q about its spacing. */
export function formants(n: number): { hz: number; q: number }[] {
  const r = n > 1 ? (FORMANT_HI / FORMANT_LO) ** (1 / (n - 1)) : 2;
  const q = Math.min(12, 1 / (Math.sqrt(r) - 1 / Math.sqrt(r)));
  return Array.from({ length: n }, (_, i) => ({ hz: n > 1 ? FORMANT_LO * r ** i : Math.sqrt(FORMANT_LO * FORMANT_HI), q }));
}

/**
 * Schedules word w on ctx at time t0 into dest (any BaseAudioContext, so an OfflineAudioContext can render one for a
 * check): the buzz and breath through the formant bank, the band gains following w.act, the pitch w.contour.
 * Its nodes disconnect themselves once it has played.
 */
export function renderWord(ctx: BaseAudioContext, dest: AudioNode, w: ParrotWord, o: { f0: number; bendSemis: number; noise: AudioBuffer }, t0: number): void {
  const dur = w.durationS;
  const n = w.bands;
  const pts = w.points;
  const fin = (x: number, lo: number, hi: number) => (Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : 0);
  const buzz = new OscillatorNode(ctx, { type: 'sawtooth', frequency: o.f0 });
  buzz.frequency.setValueCurveAtTime(
    Float32Array.from(w.contour, (c, p) => o.f0 * 2 ** ((o.bendSemis * fin(c, -1, 1) - (2 * p) / (pts - 1)) / 12)),
    t0,
    dur,
  );
  const breath = new AudioBufferSourceNode(ctx, { buffer: o.noise, loop: true, loopEnd: o.noise.duration });
  const breathAmp = new GainNode(ctx, { gain: BREATH });
  const source = new GainNode(ctx);
  buzz.connect(source);
  breath.connect(breathAmp).connect(source);
  // the word's edges: 10 ms in, up to 40 ms out
  const env = new GainNode(ctx, { gain: 0 });
  const out = Math.min(0.04, dur / 3);
  env.gain.setValueAtTime(0, t0);
  env.gain.linearRampToValueAtTime(1, t0 + Math.min(0.01, dur / 3));
  env.gain.setValueAtTime(1, t0 + dur - out);
  env.gain.linearRampToValueAtTime(0, t0 + dur);
  env.connect(dest);
  const nodes: AudioNode[] = [buzz, breath, breathAmp, source, env];
  // each word is levelled at its loudest point (the root of the summed squared band gains), so a word from a few
  // bands speaks as clearly as one from all of them: ~-14 dBFS RMS there, before the master gain
  let peak = 0;
  for (let p = 0; p < pts; p++) {
    let e = 0;
    for (let b = 0; b < n; b++) {
      e += fin(w.act[b * pts + p], 0, 1) ** 1.6;
    }
    peak = Math.max(peak, e);
  }
  const scale = WORD_GAIN / Math.max(1, Math.sqrt(peak));
  formants(n).forEach(({ hz, q }, b) => {
    const bp = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: hz, Q: q });
    // a band passes harmonics ~f0/hz as loud as the fundamental: half compensated, so the highs stay a little darker
    const tilt = scale * Math.sqrt(hz / o.f0);
    const amp = new GainNode(ctx, { gain: 0 });
    amp.gain.setValueCurveAtTime(
      Float32Array.from(w.act.subarray(b * pts, (b + 1) * pts), (a) => tilt * fin(a, 0, 1) ** 0.8),
      t0,
      dur,
    );
    source.connect(bp).connect(amp).connect(env);
    nodes.push(bp, amp);
  });
  buzz.onended = () => {
    for (const node of nodes) {
      node.disconnect();
    }
  };
  buzz.start(t0);
  breath.start(t0);
  buzz.stop(t0 + dur + 0.05);
  breath.stop(t0 + dur + 0.05);
}

/** The vowel's F1 and F2 for v 0..1 along the style's anchors (the laugh's three, the babble's five), interpolated. */
export function vowelFormants(v: number, style: Laugh['style'] = 'laugh'): [number, number] {
  const anchors = style === 'babble' ? BABBLE_VOWELS : LAUGH_VOWELS;
  const x = (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5) * (anchors.length - 1);
  const i = Math.min(anchors.length - 2, Math.floor(x));
  const w = x - i;
  const [a, b] = [anchors[i], anchors[i + 1]];
  return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w];
}

/**
 * Schedules laugh l on ctx at time t0 into dest (any BaseAudioContext): the buzz steps through the syllables, each
 * with its vowel, a breath before it, an attack of 15 ms and a decay from 60 % of its length. Its nodes disconnect
 * themselves once it has played.
 */
export function renderLaugh(ctx: BaseAudioContext, dest: AudioNode, l: Laugh, o: { f0: number; noise: AudioBuffer }, t0: number): void {
  const fin = (x: number, lo: number, hi: number, d: number) => (Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d);
  const babble = l.style === 'babble';
  const buzz = new OscillatorNode(ctx, { type: 'sawtooth', frequency: o.f0 });
  const breath = new AudioBufferSourceNode(ctx, { buffer: o.noise, loop: true, loopEnd: o.noise.duration });
  const breathAmp = new GainNode(ctx, { gain: 0 });
  const env = new GainNode(ctx, { gain: 0 });
  // the voice through its envelope and the breath through its own meet before the formants
  const mix = new GainNode(ctx);
  const f1 = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 720, Q: 7 });
  const f2 = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 1200, Q: 9 });
  const f3 = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 2700, Q: 8 });
  // babble's longer syllables and bursts run about 6 dB hotter than a laugh's "ha"s: levelled to the same peaks
  const gain = babble ? LAUGH_GAIN * 0.5 : LAUGH_GAIN;
  const g1 = new GainNode(ctx, { gain });
  const g2 = new GainNode(ctx, { gain: gain * 0.5 });
  const g3 = new GainNode(ctx, { gain: gain * 0.2 });
  buzz.connect(env).connect(mix);
  breath.connect(breathAmp).connect(mix);
  for (const [f, g] of [
    [f1, g1],
    [f2, g2],
    [f3, g3],
  ] as const) {
    mix.connect(f).connect(g).connect(dest);
  }
  let end = t0;
  let prevEnd = t0;
  for (const syl of l.syllables) {
    const on = t0 + fin(syl.at, 0, 60, 0);
    if (on < prevEnd) {
      continue; // overlapping syllables: keep the earlier one
    }
    const dur = fin(syl.durS, 0.03, 2, 0.1);
    const hz = o.f0 * 2 ** (fin(syl.semis, -36, 36, 0) / 12);
    const level = fin(syl.level, 0, 1, 0.5);
    const [F1, F2] = vowelFormants(syl.vowel, l.style);
    // the consonant leads the voice by up to 70 ms, never into the previous syllable
    const lead = Math.min(0.07, on - prevEnd);
    const onset: Syllable['onset'] = babble ? syl.onset : 0;
    let attack = babble ? 0.02 : 0.015;
    if (onset === 1) {
      // a stop: silence, then a 10 ms burst of noise through a bright F2 that slides into the vowel
      const b0 = on - Math.min(0.012, lead);
      breathAmp.gain.setValueAtTime(0, b0);
      breathAmp.gain.linearRampToValueAtTime(0.9 * level, on - Math.min(0.004, lead / 3));
      breathAmp.gain.setTargetAtTime(0, on, 0.008);
      f2.frequency.setValueAtTime(2200, b0);
      f1.frequency.setValueAtTime(F1, b0);
      f2.frequency.setTargetAtTime(F2, on, 0.02);
      attack = 0.006;
    } else if (onset === 2) {
      // a nasal: a soft hum with low formants before the vowel
      const h0 = on - lead;
      f1.frequency.setValueAtTime(250, h0);
      f2.frequency.setValueAtTime(900, h0);
      env.gain.setValueAtTime(0, h0);
      env.gain.linearRampToValueAtTime(0.35 * level, Math.min(on, h0 + 0.03));
      f1.frequency.setTargetAtTime(F1, on, 0.015);
      f2.frequency.setTargetAtTime(F2, on, 0.015);
    } else if (onset === 3) {
      // a glide: the formants sweep up from a "w" into the vowel as the voice swells
      f1.frequency.setValueAtTime(300, on);
      f2.frequency.setValueAtTime(700, on);
      f1.frequency.setTargetAtTime(F1, on, 0.035);
      f2.frequency.setTargetAtTime(F2, on, 0.035);
      attack = 0.06;
    } else {
      // the breath ("h"): a puff from 40 ms before the voice to 20 ms into it
      breathAmp.gain.setValueAtTime(0, on - Math.min(0.04, lead));
      breathAmp.gain.linearRampToValueAtTime(0.35 * level, on);
      breathAmp.gain.setTargetAtTime(0, on + 0.02, 0.015);
      f1.frequency.setValueAtTime(F1, on);
      f2.frequency.setValueAtTime(F2, on);
    }
    // the voice: each "ha" starts 6 % sharp and glides down through the syllable; babble barely moves
    buzz.frequency.setValueAtTime(hz * (babble ? 1.015 : 1.06), on);
    buzz.frequency.exponentialRampToValueAtTime(hz * (babble ? 0.985 : 0.96), on + dur);
    const hold = babble ? 0.75 : 0.6;
    if (onset !== 2) {
      env.gain.setValueAtTime(0, on);
    }
    env.gain.linearRampToValueAtTime(level, on + Math.min(attack, dur / 3));
    env.gain.setValueAtTime(level, on + hold * dur);
    env.gain.setTargetAtTime(0, on + hold * dur, (babble ? 0.1 : 0.15) * dur);
    prevEnd = on + dur;
    end = Math.max(end, on + dur + 0.2);
  }
  const nodes: AudioNode[] = [buzz, breath, breathAmp, env, mix, f1, f2, f3, g1, g2, g3];
  buzz.onended = () => {
    for (const node of nodes) {
      node.disconnect();
    }
  };
  buzz.start(t0);
  breath.start(t0);
  buzz.stop(end);
  breath.stop(end);
}

export interface DroneSettings {
  /** 0..1 (the master gain is its square). */
  volume: number;
  /** MIDI note of the root, C2 (36) .. C4 (60). */
  root: number;
  scale: ScaleName;
  pitch: PitchMode;
  /** The raw mode's bend at full change (semitones). */
  bend: number;
  bands: number;
  mode: SoundMode;
}

export class DroneEngine {
  #ctx: AudioContext | null = null;
  #bus!: GainNode;
  #filter!: BiquadFilterNode;
  #words!: GainNode;
  #noise!: AudioBuffer;
  #master!: GainNode;
  #voices: Voice[] = [];
  #running = false;
  #suspendTimer: ReturnType<typeof setTimeout> | null = null;
  #settings: DroneSettings;

  constructor(settings: DroneSettings) {
    this.#settings = { ...settings };
  }

  get running(): boolean {
    return this.#running;
  }

  get context(): AudioContext | null {
    return this.#ctx;
  }

  /** Call from a user gesture (a click): creates the context the first time, resumes it, fades in. */
  start(): Promise<void> {
    if (this.#suspendTimer) {
      clearTimeout(this.#suspendTimer);
      this.#suspendTimer = null;
    }
    if (!this.#ctx) {
      const AC = globalThis.AudioContext ?? (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) {
        return Promise.reject(new Error('this browser has no Web Audio'));
      }
      this.#ctx = new AC({ latencyHint: 'playback' });
      this.#build(this.#ctx);
    }
    const ctx = this.#ctx;
    this.#running = true;
    const resumed = ctx.state === 'running' ? Promise.resolve() : ctx.resume();
    const now = ctx.currentTime;
    this.#master.gain.cancelScheduledValues(now);
    this.#master.gain.setTargetAtTime(this.#masterGain(), now, 0.4);
    return resumed;
  }

  /** Ramps to silence, then suspends the context (it stays for the next start). */
  stop(): void {
    this.#running = false;
    const ctx = this.#ctx;
    if (!ctx) {
      return;
    }
    const now = ctx.currentTime;
    this.#master.gain.cancelScheduledValues(now);
    this.#master.gain.setTargetAtTime(0, now, 0.15);
    for (const v of this.#voices) {
      v.amp.gain.setTargetAtTime(0, now, 0.15);
    }
    if (this.#suspendTimer) {
      clearTimeout(this.#suspendTimer);
    }
    this.#suspendTimer = setTimeout(() => {
      this.#suspendTimer = null;
      if (!this.#running) {
        ctx.suspend().catch(() => {});
      }
    }, 1000);
  }

  setVolume(v: number): void {
    this.#settings.volume = Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0.6));
    if (this.#ctx && this.#running) {
      this.#master.gain.setTargetAtTime(this.#masterGain(), this.#ctx.currentTime, 0.1);
    }
  }

  /** A new root, scale or pitch mode glides the voices to their new pitches (outside raw, the detunes rest). */
  setPitch(root: number, scale: ScaleName, pitch: PitchMode): void {
    this.#settings.root = root;
    this.#settings.scale = scale;
    this.#settings.pitch = pitch;
    if (!this.#ctx) {
      return;
    }
    const now = this.#ctx.currentTime;
    const f = this.#frequencies(this.#voices.length);
    const scales = this.#levelScales(f.map((x) => x.hz));
    this.#voices.forEach((v, i) => {
      v.sine.frequency.setTargetAtTime(f[i].hz, now, GLIDE_TAU);
      v.tri.frequency.setTargetAtTime(2 * f[i].hz, now, GLIDE_TAU);
      v.scale = scales[i];
      v.spread = f[i].cents + v.jitter;
      if (pitch !== 'raw') {
        v.sine.detune.setTargetAtTime(v.spread, now, GLIDE_TAU);
        v.tri.detune.setTargetAtTime(v.spread, now, GLIDE_TAU);
      }
    });
  }

  /** Parrot and laughter mute the drone's voices (the words and laughs still play); drone brings them back. */
  setMode(mode: SoundMode): void {
    this.#settings.mode = mode;
    if (this.#ctx) {
      this.#bus.gain.setTargetAtTime(mode === 'drone' ? 1 : 0, this.#ctx.currentTime, 0.15);
    }
  }

  /** Plays one laugh, SPEAK_LEAD_S from now (nothing when off). */
  laugh(l: Laugh): void {
    const ctx = this.#ctx;
    if (!ctx || !this.#running || l.syllables.length === 0) {
      return;
    }
    renderLaugh(ctx, this.#words, l, { f0: midiToHz(this.#settings.root + 24), noise: this.#noise }, ctx.currentTime + SPEAK_LEAD_S);
  }

  /** Plays one word, SPEAK_LEAD_S from now (nothing when off). */
  speak(w: ParrotWord): void {
    const ctx = this.#ctx;
    if (!ctx || !this.#running || w.points < 2 || w.bands < 1) {
      return;
    }
    renderWord(ctx, this.#words, w, { f0: midiToHz(this.#settings.root + 12), bendSemis: this.#settings.bend, noise: this.#noise }, ctx.currentTime + SPEAK_LEAD_S);
  }

  setBend(semitones: number): void {
    this.#settings.bend = Math.min(BEND_MAX, Math.max(0, Number.isFinite(semitones) ? semitones : DEFAULT_BEND));
  }

  /** A new band count fades the old voices out and builds new ones. */
  setBands(n: number): void {
    this.#settings.bands = n;
    if (this.#ctx && n !== this.#voices.length) {
      this.#buildVoices(this.#ctx);
    }
  }

  /** The latest mapping: per-voice gains, the shimmer depth and the cutoff. */
  update(f: DroneFrame): void {
    const ctx = this.#ctx;
    if (!ctx || !this.#running || f.gains.length !== this.#voices.length) {
      return;
    }
    const now = ctx.currentTime;
    const fin = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);
    const depth = SHIMMER_MIN_C + (SHIMMER_MAX_C - SHIMMER_MIN_C) * fin(f.shimmer);
    const raw = this.#settings.pitch === 'raw';
    const bendC = 100 * this.#settings.bend;
    this.#voices.forEach((v, i) => {
      v.amp.gain.setTargetAtTime(fin(f.gains[i]) * v.scale, now, GAIN_TAU);
      v.depth.gain.setTargetAtTime(depth, now, SHIMMER_TAU);
      if (raw) {
        const b = f.bends[i];
        const d = v.spread + bendC * (Number.isFinite(b) ? Math.min(1, Math.max(-1, b)) : 0);
        v.sine.detune.setTargetAtTime(d, now, BEND_TAU);
        v.tri.detune.setTargetAtTime(d, now, BEND_TAU);
      }
    });
    const cutoff = CUTOFF_MIN * (CUTOFF_MAX / CUTOFF_MIN) ** fin(f.brightness);
    this.#filter.frequency.setTargetAtTime(cutoff, now, CUTOFF_TAU);
  }

  #frequencies(n: number): { hz: number; cents: number }[] {
    const s = this.#settings;
    return s.pitch === 'raw' ? rawFrequencies(s.root, n) : voiceFrequencies(s.root, s.scale, n);
  }

  #masterGain(): number {
    return this.#settings.volume ** 2;
  }

  /** Every voice at gain 1 sums to an RMS near -12 dBFS (incoherent), times a tilt of -0.35 per octave doubling. */
  #levelScales(hz: number[]): number[] {
    const base = 1.08 / Math.sqrt(Math.max(1, hz.length));
    const f0 = hz[0] || 1;
    return hz.map((f) => base * (f / f0) ** -0.35);
  }

  #build(ctx: AudioContext): void {
    this.#bus = ctx.createGain();
    this.#bus.gain.value = this.#settings.mode === 'drone' ? 1 : 0;
    this.#words = ctx.createGain();
    this.#noise = noiseBuffer(ctx);
    this.#filter = ctx.createBiquadFilter();
    this.#filter.type = 'lowpass';
    this.#filter.Q.value = 0.6;
    this.#filter.frequency.value = CUTOFF_MIN * 1.5;
    const dry = ctx.createGain();
    dry.gain.value = 0.8;
    const send = ctx.createGain();
    send.gain.value = 0.45;
    const verb = ctx.createConvolver();
    verb.buffer = impulseResponse(ctx);
    this.#master = ctx.createGain();
    this.#master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 10;
    comp.ratio.value = 6;
    comp.attack.value = 0.01;
    comp.release.value = 0.3;
    const trim = ctx.createGain();
    trim.gain.value = 0.85;
    const post = ctx.createGain();
    this.#bus.connect(this.#filter).connect(post);
    this.#words.connect(post);
    post.connect(dry).connect(this.#master);
    post.connect(send).connect(verb).connect(this.#master);
    this.#master.connect(comp).connect(trim).connect(ctx.destination);
    this.#buildVoices(ctx);
  }

  #buildVoices(ctx: AudioContext): void {
    const now = ctx.currentTime;
    for (const v of this.#voices) {
      v.amp.gain.cancelScheduledValues(now);
      v.amp.gain.setTargetAtTime(0, now, 0.1);
      for (const o of [v.sine, v.tri, v.lfo]) {
        o.stop(now + 0.8);
      }
      v.sine.onended = () => {
        for (const node of [v.sine, v.tri, v.lfo, v.depth, v.amp]) {
          node.disconnect();
        }
      };
    }
    const f = this.#frequencies(this.#settings.bands);
    const scales = this.#levelScales(f.map((x) => x.hz));
    this.#voices = f.map(({ hz, cents }, i) => {
      const jitter = (Math.random() - 0.5) * 4;
      const spread = cents + jitter;
      const sine = new OscillatorNode(ctx, { type: 'sine', frequency: hz, detune: spread });
      const tri = new OscillatorNode(ctx, { type: 'triangle', frequency: 2 * hz, detune: spread });
      const lfo = new OscillatorNode(ctx, { type: 'sine', frequency: 0.04 + 0.16 * Math.random() });
      const depth = new GainNode(ctx, { gain: SHIMMER_MIN_C });
      const triAmp = new GainNode(ctx, { gain: 0.2 });
      const amp = new GainNode(ctx, { gain: 0 });
      lfo.connect(depth);
      depth.connect(sine.detune);
      depth.connect(tri.detune);
      sine.connect(amp);
      tri.connect(triAmp).connect(amp);
      amp.connect(this.#bus);
      for (const o of [sine, tri, lfo]) {
        o.start(now);
      }
      return { sine, tri, lfo, depth, amp, scale: scales[i], jitter, spread };
    });
  }
}

// ---- the panel ----

export interface SoundPanel {
  /** Whether records should be pushed (the sound is on). */
  readonly on: boolean;
  /** One record of the page's current kind (see DroneMapper.push). */
  push(at: number, t: number, kind: number, amps: ArrayLike<number>, valid: ArrayLike<number> | null, motion: number): void;
}

type Store = (key: string, value?: string) => string | null;

/**
 * Wires the Sound card (index.html: #sound-toggle, -state, -mode, -volume, -root, -scale, -pitch, -bend, -bands,
 * -react, -ratio, -listen, -quiet, -meter, -hint, #parrot-last): settings persisted through `store`, the engine updated
 * every 16 ms while on. The meter shows the band gains (drone), the live band activity while the parrot listens (and
 * the word's while it speaks) or while the laughter mode waits and records. body data-sound-mode is drone/parrot/laugh/babble;
 * data-parrot is the parrot's listening/speaking or the laughter's waiting/recording/laughing.
 * body data-sound is on/off; the meter carries data-bands and data-peak for headless checks.
 */
export function mountSoundPanel(store: Store, now: () => number): SoundPanel {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const toggle = $<HTMLButtonElement>('sound-toggle');
  const state = $('sound-state');
  const volume = $<HTMLInputElement>('sound-volume');
  const rootSel = $<HTMLSelectElement>('sound-root');
  const scaleSel = $<HTMLSelectElement>('sound-scale');
  const pitchSel = $<HTMLSelectElement>('sound-pitch');
  const bend = $<HTMLInputElement>('sound-bend');
  const bandsSel = $<HTMLSelectElement>('sound-bands');
  const react = $<HTMLInputElement>('sound-react');
  const modeSel = $<HTMLSelectElement>('sound-mode');
  const ratio = $<HTMLInputElement>('sound-ratio');
  const listen = $<HTMLInputElement>('sound-listen');
  const quiet = $<HTMLInputElement>('sound-quiet');
  const last = $('parrot-last');
  const meter = $('sound-meter');
  const hint = $('sound-hint');

  const num = (key: string, lo: number, hi: number, dflt: number) => {
    const v = Number(store(key));
    return store(key) !== null && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;
  };
  rootSel.replaceChildren(
    ...Array.from({ length: ROOT_MAX - ROOT_MIN + 1 }, (_, i) => {
      const m = ROOT_MIN + i;
      return new Option(`${noteName(m)} · ${midiToHz(m).toFixed(1)} Hz`, String(m));
    }),
  );
  scaleSel.replaceChildren(...Object.entries(SCALES).map(([k, s]) => new Option(s.label, k)));
  pitchSel.replaceChildren(...Object.entries(PITCH_MODES).map(([k, label]) => new Option(label, k)));
  bend.max = String(BEND_MAX);
  bandsSel.replaceChildren(...BAND_CHOICES.map((n) => new Option(String(n), String(n))));
  modeSel.replaceChildren(...Object.entries(SOUND_MODES).map(([k, label]) => new Option(label, k)));
  ratio.min = String(RATIO_MIN);
  ratio.max = String(RATIO_MAX);
  listen.min = String(LISTEN_MIN);
  listen.max = String(LISTEN_MAX);

  const savedScale = store('sound.scale');
  const savedPitch = store('sound.pitch');
  const savedBands = num('sound.bands', 1, 64, 16);
  const savedMode = store('sound.mode');
  const settings: DroneSettings = {
    volume: num('sound.volume', 0, 100, 60) / 100,
    root: Math.round(num('sound.root', ROOT_MIN, ROOT_MAX, DEFAULT_ROOT)),
    scale: savedScale !== null && savedScale in SCALES ? (savedScale as ScaleName) : DEFAULT_SCALE,
    pitch: savedPitch !== null && savedPitch in PITCH_MODES ? (savedPitch as PitchMode) : DEFAULT_PITCH_MODE,
    bend: Math.round(num('sound.bend', 0, BEND_MAX, DEFAULT_BEND)),
    bands: (BAND_CHOICES as readonly number[]).includes(savedBands) ? savedBands : 16,
    mode: savedMode !== null && savedMode in SOUND_MODES ? (savedMode as SoundMode) : 'drone',
  };
  const reactivity = num('sound.react', 0, 100, 50) / 100;
  volume.value = String(Math.round(settings.volume * 100));
  rootSel.value = String(settings.root);
  scaleSel.value = settings.scale;
  pitchSel.value = settings.pitch;
  bend.value = String(settings.bend);
  modeSel.value = settings.mode;
  ratio.value = String(Math.round(num('sound.ratio', RATIO_MIN, RATIO_MAX, DEFAULT_RATIO)));
  listen.value = String(Math.round(num('sound.listen', LISTEN_MIN, LISTEN_MAX, DEFAULT_LISTEN)));
  quiet.value = String(Math.round(num('sound.quiet', 0, 100, DEFAULT_THRESHOLD * 100)));
  // body data-sound-mode, not data-mode: the heatmap's buttons are [data-mode]
  const showPitch = () => {
    const raw = pitchSel.value === 'raw';
    const speech = modeSel.value !== 'drone';
    scaleSel.disabled = raw;
    bend.disabled = !raw && !speech;
    document.body.dataset.pitch = pitchSel.value;
    document.body.dataset.soundMode = modeSel.value;
    // the shared sliders read differently per mode
    for (const lbl of document.querySelectorAll<HTMLElement>('.sound-controls .lbl')) {
      lbl.textContent = lbl.dataset[modeSel.value] ?? lbl.dataset.parrot ?? lbl.textContent;
    }
  };
  showPitch();
  bandsSel.value = String(settings.bands);
  react.value = String(Math.round(reactivity * 100));
  const showParrot = () => {
    for (const [input, text] of [
      [ratio, `${ratio.value}:1`],
      [listen, `≤ ${listen.value} s`],
      [quiet, (Number(quiet.value) / 100).toFixed(2)],
    ] as const) {
      const o = input.parentElement?.querySelector('output');
      if (o) {
        o.textContent = text;
      }
    }
  };
  showParrot();

  const mapper = new DroneMapper({ bands: settings.bands, reactivity });
  const engine = new DroneEngine(settings);
  const parrot = new ParrotRecorder({ ratio: Number(ratio.value), listenS: Number(listen.value), threshold: Number(quiet.value) / 100 });
  const laugher = new LaughRecorder({
    ratio: Number(ratio.value),
    listenS: Number(listen.value),
    threshold: Number(quiet.value) / 100,
    bendSemis: Number(bend.value),
    style: settings.mode === 'babble' ? 'babble' : 'laugh',
  });
  let actBuf = new Float32Array(settings.bands);
  let bendBuf = new Float32Array(settings.bands);
  /** The word being spoken and when it started (page time), for the meter. */
  let speaking: { word: ParrotWord; at: number } | null = null;
  let on = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let bars: HTMLSpanElement[] = [];

  function buildMeter(n: number): void {
    bars = Array.from({ length: n }, () => document.createElement('span'));
    meter.replaceChildren(...bars);
    meter.dataset.bands = String(n);
    meter.dataset.peak = '0';
  }
  buildMeter(settings.bands);

  function render(f: { gains: ArrayLike<number> } | null): void {
    let peak = 0;
    bars.forEach((b, i) => {
      const g = f?.gains[i] ?? 0;
      peak = Math.max(peak, g);
      b.style.transform = `scaleY(${g.toFixed(3)})`;
    });
    meter.dataset.peak = peak.toFixed(3);
  }

  function tick(): void {
    const at = now();
    const f = mapper.frame(at);
    engine.update(f);
    let s: string;
    const live = f.gains.some((g) => g > 0);
    if (modeSel.value === 'drone') {
      render(f);
      s = live ? 'playing' : 'on · waiting for records';
    } else if (modeSel.value === 'laugh' || modeSel.value === 'babble') {
      const ev = laugher.tick(at);
      if (ev?.kind === 'laugh') {
        engine.laugh(ev.laugh);
        const what = ev.laugh.style === 'babble' ? `${ev.laugh.syllables.length}-syllable phrase` : `${ev.laugh.syllables.length}-ha laugh`;
        last.textContent = `last: a ${what} (${ev.laugh.durationS.toFixed(1)} s) at ${ev.laugh.recordedS.toFixed(1)} s of movement · peak ${ev.laugh.peak.toFixed(2)}`;
      } else if (ev) {
        last.textContent = `last: a ${ev.recordedS.toFixed(2)} s twitch, too brief to answer`;
      }
      const phase = laugher.phase;
      document.body.dataset.parrot = phase;
      if (live) {
        mapper.readBands(actBuf, bendBuf);
        render({ gains: actBuf });
      } else {
        render(null);
      }
      if (!live) {
        s = 'on · waiting for records';
      } else if (phase === 'recording') {
        s = `recording ${laugher.recordingS(at).toFixed(1)} s`;
      } else if (phase === 'laughing') {
        s = modeSel.value === 'babble' ? 'speaking' : 'laughing';
      } else {
        s = `waiting for movement · ${laugher.activity.toFixed(2)}`;
      }
    } else {
      const ev = parrot.tick(at);
      if (ev?.kind === 'word') {
        engine.speak(ev.word);
        speaking = { word: ev.word, at: at + SPEAK_LEAD_S };
        last.textContent = `last: a ${ev.word.durationS.toFixed(2)} s word from ${ev.word.heardS.toFixed(1)} s heard · change ${ev.word.change.toFixed(2)}`;
      } else if (ev) {
        last.textContent = `last: quiet · change ${ev.change.toFixed(2)} < ${(Number(quiet.value) / 100).toFixed(2)}`;
      }
      const pr = parrot.progress(at);
      document.body.dataset.parrot = pr.phase;
      const w = speaking?.word;
      const into = speaking ? (at - speaking.at) / speaking.word.durationS : NaN;
      if (w && into >= 0 && into < 1) {
        const pt = Math.min(w.points - 1, Math.floor(into * w.points));
        render({ gains: Array.from({ length: w.bands }, (_, b) => w.act[b * w.points + pt]) });
      } else if (pr.phase === 'listening' && f.gains.some((g) => g > 0)) {
        mapper.readBands(actBuf, bendBuf);
        render({ gains: actBuf });
      } else {
        render(null);
      }
      if (pr.phase === 'speaking') {
        s = 'speaking';
      } else if (!f.gains.some((g) => g > 0)) {
        s = 'on · waiting for records';
      } else {
        s = `listening ${Math.max(0, pr.elapsedS).toFixed(1)} / ${pr.totalS.toFixed(1)} s`;
      }
    }
    if (state.textContent !== s) {
      state.textContent = s;
    }
  }

  function setOn(v: boolean): void {
    on = v;
    document.body.dataset.sound = v ? 'on' : 'off';
    toggle.textContent = v ? 'Sound off' : 'Sound on';
    toggle.classList.toggle('primary', !v);
    state.classList.toggle('on', v);
    if (v) {
      mapper.reset();
      parrot.reset();
      laugher.reset();
      speaking = null;
      timer ??= setInterval(tick, UPDATE_MS);
      tick();
    } else {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      state.textContent = 'off';
      render(null);
    }
  }

  toggle.addEventListener('click', () => {
    if (on) {
      engine.stop();
      setOn(false);
      return;
    }
    // the context is created (or resumed) inside this click
    engine.start().then(
      () => {
        hint.dataset.error = '';
      },
      (e: unknown) => {
        engine.stop();
        setOn(false);
        hint.dataset.error = 'true';
        hint.textContent = `Sound: ${e instanceof Error ? e.message : String(e)}`;
      },
    );
    setOn(true);
  });
  volume.addEventListener('input', () => {
    engine.setVolume(Number(volume.value) / 100);
    store('sound.volume', volume.value);
  });
  const repitch = () => {
    engine.setPitch(Number(rootSel.value), scaleSel.value as ScaleName, pitchSel.value as PitchMode);
    store('sound.root', rootSel.value);
    store('sound.scale', scaleSel.value);
    store('sound.pitch', pitchSel.value);
    showPitch();
  };
  rootSel.addEventListener('change', repitch);
  scaleSel.addEventListener('change', repitch);
  pitchSel.addEventListener('change', repitch);
  bend.addEventListener('input', () => {
    engine.setBend(Number(bend.value));
    laugher.settings = { bendSemis: Number(bend.value) };
    store('sound.bend', bend.value);
  });
  bandsSel.addEventListener('change', () => {
    const n = Number(bandsSel.value);
    store('sound.bands', bandsSel.value);
    mapper.bands = n;
    engine.setBands(n);
    buildMeter(n);
  });
  react.addEventListener('input', () => {
    mapper.reactivity = Number(react.value) / 100;
    store('sound.react', react.value);
  });
  modeSel.addEventListener('change', () => {
    store('sound.mode', modeSel.value);
    engine.setMode(modeSel.value as SoundMode);
    parrot.reset();
    laugher.reset();
    laugher.settings = { style: modeSel.value === 'babble' ? 'babble' : 'laugh' };
    speaking = null;
    last.textContent = '';
    delete document.body.dataset.parrot;
    showPitch();
  });
  const reparrot = () => {
    parrot.settings = { ratio: Number(ratio.value), listenS: Number(listen.value), threshold: Number(quiet.value) / 100 };
    laugher.settings = parrot.settings;
    store('sound.ratio', ratio.value);
    store('sound.listen', listen.value);
    store('sound.quiet', quiet.value);
    showParrot();
  };
  for (const el of [ratio, listen, quiet]) {
    el.addEventListener('input', reparrot);
  }
  setOn(false);

  return {
    get on() {
      return on;
    },
    push(at, t, kind, amps, valid, motion) {
      if (!on || !mapper.push(at, t, kind, amps, valid, motion) || modeSel.value === 'drone') {
        return;
      }
      if (actBuf.length !== mapper.bands) {
        actBuf = new Float32Array(mapper.bands);
        bendBuf = new Float32Array(mapper.bands);
      }
      mapper.readBands(actBuf, bendBuf);
      if (modeSel.value === 'laugh' || modeSel.value === 'babble') {
        laugher.push(at, t, actBuf, bendBuf);
      } else {
        parrot.push(at, t, actBuf, bendBuf);
      }
    },
  };
}
