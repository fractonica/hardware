// The fixture's readings as bench lines (design m2-c1-hil D9, D10; stream S4). The fixture reports each wired
// line as an fr.fixture instance named by its channel (ch0..): `edges` batches (per-edge levels, µs offsets
// from the event's t_us, ring overflows) and WS2812 `frame`s. The timeline unwraps those times on the
// fixture's clock (F), maps them to the hub's (H, TIME over the serial session) and to the DUT's (D: the
// wired fit when it is valid, else the hub path), and publishes one `hil.edge` per level transition and one
// `hil.frame` per good frame on the DUT whose line it is. A frame that is not exactly 24 bits (a glitch, or one
// lost to a full RX queue, which the fixture sends as 0 bits and grb 0) is no LED reading (D4): it counts in that
// line's bad_frames (bench_get) and is not published, so it never reads as the LED going dark. `wired: false`
// lines have no instance, and a channel the bench does not wire is ignored. It also feeds the fit: press edges on
// BOOT lines and the DUTs' `boot.down` stamps, falling edges on test_pin lines; and it tells the driver when a
// line's release edge came (the hold of a `press` gesture, waitEdge).
//
// The glitch filter (LevelFilter, one per decode: level line, in fixture time): the fixture's any-edge ISR
// re-fires while an input chatters at its threshold, so one transition arrives as a burst of edges whose
// levels repeat, now and then with a short opposite pulse inside (bench, first T-HIL run). Before anything is
// published or reaches the fit or a release's readback, an edge at the line's current level is dropped (a
// repeat), a pulse A -> B -> A whose B phase is under GLITCH_US is dropped, and a transition is accepted once
// GLITCH_US has passed with no reversal, stamped at the burst's first edge to the new level. The line's `level`
// STATE (the pin as read after each flush) settles a burst its batch left open and corrects the line when the
// edges disagree with it (not on nfet_gate lines, whose edges are write stamps, D4). bench_get counts what was
// dropped per line (`glitches`); the raw `edges` events stay in the event store as the fixture sent them, and
// `edges` in bench_get counts them as the fixture did. Gating never waits on it: it reads the `level` property
// itself (Driver.lineLevel).
//
// BenchMap, the bench file's lines by DUT and by channel, lives here and is shared by the driver and ops. It
// refuses a bench whose lines share a channel, a fixture pin or a DUT pin (benchConflicts), so a channel always
// names one line.

import type { Bench, BenchDut, BenchLine, HilSync } from '@fractonica/protocol';

import type { HubContext, HubEvent } from '../context.ts';
import { nowUs } from '../ring.ts';
import { type ClockView, routerProbe } from '../router/index.ts';
import type { BenchSync } from './sync.ts';

/** One bench line, with where it is. */
export interface BenchLineRef {
  /** The DUT's device id. */
  dut: string;
  /** The line's name in the bench (boot, status, test_pin...): the DUT profile's instance of the same name. */
  name: string;
  line: BenchLine;
  entry: BenchDut;
}

/**
 * What drives a line (D3 Drive): a button or EN line `via: nfet` is a MOSFET gate (high = press), else open drain;
 * an analog line is a PWM setpoint through its RC (design m2-c3-inputs D5); the rest are inputs.
 */
export function lineDrive(line: BenchLine): 'open_drain' | 'nfet_gate' | 'pwm' | 'none' {
  if (line.role === 'analog') {
    return 'pwm';
  }
  if (line.role !== 'button' && line.role !== 'en') {
    return 'none';
  }
  return line.via === 'nfet' ? 'nfet_gate' : 'open_drain';
}

/** The fixture line level of a press: low on an open-drain line, high on a MOSFET gate. */
export const pressLevel = (line: BenchLine): boolean => lineDrive(line) === 'nfet_gate';

/**
 * What makes a parsed bench ambiguous to the hub, one line each (empty when none): two lines on one channel or
 * one fixture pin (wired or not, D7), two lines of a DUT on one DUT pin, the fixture device also a DUT. These
 * need no board manifest or profile; `fr gen --check` (codegen checkBench) adds the rest, and the fixture module
 * runs both before a bench takes effect.
 */
export function benchConflicts(bench: Bench): string[] {
  const out: string[] = [];
  const channels = new Map<string, string>();
  const pins = new Map<number, string>();
  if (bench.fixture.device in bench.duts) {
    out.push(`duts.${bench.fixture.device}: the fixture device cannot also be a DUT`);
  }
  for (const [dut, entry] of Object.entries(bench.duts)) {
    const dutPins = new Map<string, string>();
    for (const [name, line] of Object.entries(entry.lines)) {
      const at = `duts.${dut}.lines.${name}`;
      const who = `${dut} ${name}`;
      const ch = channels.get(line.channel);
      if (ch !== undefined) {
        out.push(`${at}.channel: ${line.channel} is already the channel of ${ch}`);
      } else {
        channels.set(line.channel, who);
      }
      const pin = pins.get(line.fixture_gpio);
      if (pin !== undefined) {
        out.push(`${at}.fixture_gpio: fixture GPIO${line.fixture_gpio} is already wired to ${pin}`);
      } else {
        pins.set(line.fixture_gpio, who);
      }
      const dutPin = String(line.dut_gpio ?? line.dut_pin);
      const other = dutPins.get(dutPin);
      if (other !== undefined) {
        out.push(`${at}: ${dut} ${line.dut_gpio !== undefined ? `GPIO${dutPin}` : dutPin} is already on line ${other}`);
      } else {
        dutPins.set(dutPin, name);
      }
    }
  }
  return out;
}

/** A parsed bench file's lines by DUT and by channel; throws on a bench with benchConflicts. */
export class BenchMap {
  readonly bench: Bench;
  readonly lines: BenchLineRef[] = [];
  #byChannel = new Map<string, BenchLineRef>();

  constructor(bench: Bench) {
    const conflicts = benchConflicts(bench);
    if (conflicts.length) {
      throw new Error(`bench ${bench.id}: ${conflicts.join('; ')}`);
    }
    this.bench = bench;
    for (const [dut, entry] of Object.entries(bench.duts)) {
      for (const [name, line] of Object.entries(entry.lines)) {
        const ref = { dut, name, line, entry };
        this.lines.push(ref);
        if (line.wired) {
          this.#byChannel.set(line.channel, ref);
        }
      }
    }
  }

  /** The DUTs' device ids. */
  get duts(): string[] {
    return Object.keys(this.bench.duts);
  }

  get fixture(): string {
    return this.bench.fixture.device;
  }

  /** The wired line on a fixture channel. */
  byChannel(channel: string): BenchLineRef | undefined {
    return this.#byChannel.get(channel);
  }

  /** A DUT's line by name, wired or not. */
  line(dut: string, name: string): BenchLineRef | undefined {
    return this.lines.find((l) => l.dut === dut && l.name === name);
  }

  dutLines(dut: string): BenchLineRef[] {
    return this.lines.filter((l) => l.dut === dut);
  }

  isDut(id: string): boolean {
    return id in this.bench.duts;
  }

  /** The profiles a DUT may run on the bench: its own, and any line's dut_profile (D7). */
  profiles(dut: string): Set<string> {
    const e = this.bench.duts[dut];
    return new Set(e ? [e.profile, ...Object.values(e.lines).flatMap((l) => (l.dut_profile ? [l.dut_profile] : []))] : []);
  }
}

/** A DUT time and how it was found (HilSync). */
export interface DutTime {
  t_dut_us: number | null;
  sync: HilSync;
  u_us: number | null;
}

/** What the timeline reads and calls. */
export interface TimelineDeps {
  hub: () => HubContext;
  map: () => BenchMap | null;
  sync: BenchSync;
  /** The DUT is in a declared power-cut window: its readings are flagged `cut` (§6 rule 3). */
  inCut: (dut: string) => boolean;
  /** The level the fixture last reported on a channel (its `level` property, the router's mirror), or null. */
  level?: (channel: string) => boolean | null;
}

/**
 * Counters per channel, for bench_get: `edges` as the fixture reported them (before the glitch filter, as its
 * own `read` counts them), `frames` the good (24-bit) ones, `bad_frames` the rest; `glitches` on decode: level
 * lines, what the glitch filter dropped and corrected.
 */
export interface ChannelStats {
  edges: number;
  dropped: number;
  frames: number;
  bad_frames: number;
  glitches?: GlitchCounts;
}

/** WS2812 bits of one pixel: a frame of any other length is no reading (D4). */
const FRAME_BITS = 24;
/** A waited-for edge may be stamped this much (hub time) before the wait began: the F <-> H clock's error. */
const EDGE_MARGIN_US = 5000;

const BIT = (levels: number, i: number) => ((levels >>> i) & 1) === 1;

// ---- the glitch filter (decode: level lines) ----

/**
 * The shortest phase a decode: level line (an input tap, or an open-drain line's readback) is taken to have
 * (fixture µs); a shorter one is a glitch. On the bench (first T-HIL run) every transition on these lines came
 * as a burst of edges 7-15 µs apart whose recorded levels repeat: the any-edge GPIO ISR re-fires while the input
 * chatters at its threshold (likely ground bounce over the long GND jumpers; the S3's inputs have no
 * hysteresis), and now and then a burst holds a short opposite pulse (a few µs, up to about 200 µs seen). Real
 * phases on these lines are far longer: BOOT presses ≥ 400 µs (the bounce gesture's shortest segment, §2.1),
 * test_pin pulses about 1,000 µs, LED phases milliseconds. WS2812 lines are no concern: RMT RX has its own
 * 100 ns glitch filter, and they report frames, not edges.
 */
export const GLITCH_US = 50;
/**
 * fr.fixture `edges` limits (fixture.cap.yaml): at most 32 edges a batch, sent flush_us (200 µs at least) after
 * its last edge and 20 ms at most after its first. So a batch of fewer than 32 edges with no ring overflow whose
 * last edge is at least GLITCH_US before its 20 ms span ends shows GLITCH_US of quiet after that edge: an edge
 * within it would have joined the batch.
 */
const BATCH_MAX = 32;
const BATCH_SPAN_US = 20_000;
/**
 * A transition still open after its batch (32 edges, a ring overflow, or a batch cut at 20 ms: the batch cannot
 * show GLITCH_US of quiet after it) is settled by the next batch, or by the line's `level` STATE, which the
 * fixture sends right behind its batch in the same flush when the pin changed. Failing both within this (hub ms:
 * one batch span, 20 ms, plus the serial link), it settles on the level the fixture last reported. A release's
 * readback (RELEASE_EDGE_MS, 200 ms) is never held past it, and the fit pairs by stamps, not arrival.
 */
export const UNSETTLED_MS = 30;

/** One edge as the filter takes it: fixture and hub µs, and the level the fixture recorded after it. */
export interface LevelEdge {
  t_fix_us: number;
  t_hub_us: number;
  level: boolean;
}

/** A transition the filter accepted. `corrected`: put in by the line's `level` STATE, the edges having said otherwise. */
export interface LevelTransition extends LevelEdge {
  corrected: boolean;
}

/** What the filter dropped or corrected on one line (bench_get lines[].glitches). */
export interface GlitchCounts {
  /** Edges at the level the line already had. */
  repeats: number;
  /** Phases under GLITCH_US (A -> B -> A), each dropped with both its edges. */
  pulses: number;
  /** Transitions published on the `level` STATE because the edges disagreed with it. */
  corrections: number;
}

/** The first edge to each level (index: Number(level)). */
type ByLevel = [LevelEdge | null, LevelEdge | null];

/**
 * The glitch filter of one decode: level line, in fixture time (see the file comment and GLITCH_US):
 * - (a) an edge at the line's current level (the accepted one, or the open burst's latest) is a repeat: dropped;
 * - (b) a level change opens a burst, which stays open while changes come less than GLITCH_US apart. It settles
 *   once GLITCH_US has passed with no reversal (the next edge, its batch's quiet, the `level` STATE): a burst
 *   back at the accepted level was glitch pulses only, one away from it is one transition, stamped at its first
 *   edge to the new level. Every dropped phase counts in `pulses`;
 * - (c) the `level` STATE is the pin as the fixture read it after the flush: when the line, open burst included,
 *   is at another level, the STATE's level is put in as a corrected transition, stamped at the earliest time the
 *   record allows (correctionTime).
 * Starts at `level` (the fixture's last reported level), or unknown: then the first transition is published as it comes.
 */
export class LevelFilter {
  readonly counts: GlitchCounts = { repeats: 0, pulses: 0, corrections: 0 };
  /** The accepted level. */
  #level: boolean | null;
  /** The level as the edges have it: the accepted one, or the open burst's latest. */
  #raw: boolean | null;
  /** The open burst: its changes, the last one's time, the first edge to each level. */
  #burst: { changes: number; lastUs: number; first: ByLevel } | null = null;
  /**
   * The latest run of edges (repeats too) each less than GLITCH_US after the one before, since the last accepted
   * transition: where a correction is stamped. Null when there is none, or when a ring overflow lost edges.
   */
  #run: { first: LevelEdge; firstOf: ByLevel; lastUs: number } | null = null;
  #last: LevelEdge | null = null;

  constructor(level: boolean | null = null) {
    this.#level = level;
    this.#raw = level;
  }

  /** The accepted level, null before any is known. */
  get level(): boolean | null {
    return this.#level;
  }

  /** A burst is open: its transition (or glitch) is not settled yet. */
  get pending(): boolean {
    return this.#burst !== null;
  }

  /**
   * One `edges` batch, in fixture-time order. `settled`: the batch shows GLITCH_US of quiet after its last edge
   * (batchSettles), so a burst it leaves open settles now; `lost`: the fixture's ring overflowed (the batch's
   * `dropped`), so where its lost edges fell is unknown and a correction is stamped by the STATE instead.
   */
  edges(edges: readonly LevelEdge[], settled: boolean, lost = false): LevelTransition[] {
    const out: LevelTransition[] = [];
    for (const e of edges) {
      this.#edge(e, out);
    }
    if (settled) {
      this.#settle(out);
    }
    if (lost) {
      this.#run = null;
    }
    return out;
  }

  /**
   * The line's `level` STATE: the pin as the fixture read it after a flush, stamped `at` (the flush's last edge
   * when it reads the same, else when it was sent). An open burst settles on it; a line at another level is
   * corrected to it.
   */
  state(level: boolean, at: { t_fix_us: number; t_hub_us: number }): LevelTransition[] {
    const out: LevelTransition[] = [];
    const b = this.#burst;
    if (b) {
      this.#burst = null;
      // When the burst's latest edge is not at the pin's level, the pin's level counts as one more change: a
      // return the ISR never recorded.
      this.counts.pulses += Math.floor((b.changes + (this.#raw === level ? 0 : 1)) / 2);
      if (this.#raw === level && level !== this.#level) {
        this.#accept(b.first[+level]!, false, out); // the edges were right: the burst settles as they say
        return out;
      }
    }
    this.#raw = level;
    if (this.#level === null) {
      this.#level = level; // the first level known: nothing to correct
      return out;
    }
    if (this.#level !== level) {
      this.counts.corrections++;
      const t = this.#correctionTime(level) ?? at;
      this.#accept({ t_fix_us: t.t_fix_us, t_hub_us: t.t_hub_us, level }, true, out);
    }
    return out;
  }

  /**
   * An open burst nothing settled within UNSETTLED_MS: on `level` (what the fixture last reported, its read
   * after that batch's flush, since no STATE came), else on the edges.
   */
  expire(level: boolean | null): LevelTransition[] {
    if (!this.#burst) {
      return [];
    }
    if (level === null) {
      const out: LevelTransition[] = [];
      this.#settle(out);
      return out;
    }
    return this.state(level, this.#last!);
  }

  /**
   * Where a correction to `level` goes: in the latest run of edges since the last accepted transition (every
   * earlier one was followed by GLITCH_US of quiet at the old level, so the line changed no earlier), its first
   * edge at `level` (what (b) stamps when a burst's last reading is right), else its first edge (the ISR fired
   * at the transition but read the old level). Null without such a run (every edge since was lost to an
   * overflow): the STATE's own stamp then.
   */
  #correctionTime(level: boolean): LevelEdge | null {
    const r = this.#run;
    return r ? (r.firstOf[+level] ?? r.first) : null;
  }

  #edge(e: LevelEdge, out: LevelTransition[]): void {
    if (this.#burst && e.t_fix_us - this.#burst.lastUs >= GLITCH_US) {
      this.#settle(out); // GLITCH_US with no reversal: the burst is over
    }
    let r = this.#run;
    if (!r || e.t_fix_us - r.lastUs >= GLITCH_US) {
      r = this.#run = { first: e, firstOf: [null, null], lastUs: e.t_fix_us };
    }
    r.lastUs = e.t_fix_us;
    r.firstOf[+e.level] ??= e;
    this.#last = e;
    if (e.level === this.#raw) {
      this.counts.repeats++;
      return;
    }
    this.#raw = e.level;
    const b = (this.#burst ??= { changes: 0, lastUs: e.t_fix_us, first: [null, null] });
    b.changes++;
    b.lastUs = e.t_fix_us;
    b.first[+e.level] ??= e;
  }

  /** The open burst ends where the edges left it: one transition, or glitch pulses only. */
  #settle(out: LevelTransition[]): void {
    const b = this.#burst;
    if (!b) {
      return;
    }
    this.#burst = null;
    this.counts.pulses += Math.floor(b.changes / 2);
    if (this.#raw !== this.#level) {
      this.#accept(b.first[+this.#raw!]!, false, out);
    }
  }

  #accept(e: LevelEdge, corrected: boolean, out: LevelTransition[]): void {
    this.#level = e.level;
    this.#raw = e.level;
    this.#run = null;
    out.push({ t_fix_us: e.t_fix_us, t_hub_us: e.t_hub_us, level: e.level, corrected });
  }
}

/** A batch shows GLITCH_US of quiet after its last edge (BATCH_MAX, BATCH_SPAN_US): fewer than 32 edges, no overflow, its last edge not in its span's last GLITCH_US. */
export function batchSettles(n: number, lastDtUs: number, dropped: number): boolean {
  return n > 0 && n < BATCH_MAX && dropped === 0 && lastDtUs <= BATCH_SPAN_US - GLITCH_US;
}

/** A line's filter and the timer that settles a burst its batch left open. */
interface LineFilter {
  filter: LevelFilter;
  timer: NodeJS.Timeout | undefined;
}

/** An edge of a line in fixture and hub µs. */
export interface LineEdge {
  t_fix_us: number;
  t_hub_us: number;
}

interface EdgeWaiter {
  channel: string;
  level: boolean;
  sinceHubUs: number;
  done: (e: LineEdge | null) => void;
}

export class Timeline {
  #deps: TimelineDeps;
  #stats = new Map<string, ChannelStats>();
  #waiters = new Set<EdgeWaiter>();
  /** By fixture channel: the glitch filter of each decode: level line seen so far. */
  #filters = new Map<string, LineFilter>();

  constructor(deps: TimelineDeps) {
    this.#deps = deps;
  }

  stats(channel: string): ChannelStats {
    const st = this.#stats.get(channel) ?? { edges: 0, dropped: 0, frames: 0, bad_frames: 0 };
    if (this.#deps.map()?.byChannel(channel)?.line.decode === 'ws2812') {
      return { ...st };
    }
    const g = this.#filters.get(channel)?.filter.counts;
    return { ...st, glitches: g ? { ...g } : { repeats: 0, pulses: 0, corrections: 0 } };
  }

  /** The fixture rebooted (its clock and lines start over): every line's filter goes, unsettled bursts with it. */
  reset(): void {
    for (const lf of this.#filters.values()) {
      clearTimeout(lf.timer);
    }
    this.#filters.clear();
  }

  /** The module stops: no filter timer outlives it. */
  stop(): void {
    this.reset();
  }

  /**
   * The next edge to `level` on a fixture channel stamped at or after hub µs `sinceHubUs` (less the clock's
   * error), within `ms`: the driver reads a release's edge with it. `wait` resolves to it, or null at the time
   * limit or after `cancel`.
   */
  waitEdge(channel: string, level: boolean, sinceHubUs: number, ms: number): { wait: Promise<LineEdge | null>; cancel: () => void } {
    let w!: EdgeWaiter;
    let timer: NodeJS.Timeout | undefined;
    const wait = new Promise<LineEdge | null>((resolve) => {
      w = {
        channel,
        level,
        sinceHubUs,
        done: (e) => {
          clearTimeout(timer);
          this.#waiters.delete(w);
          resolve(e);
        },
      };
    });
    this.#waiters.add(w);
    timer = setTimeout(() => w.done(null), ms);
    timer.unref?.();
    return { wait, cancel: () => w.done(null) };
  }

  #clock(id: string): ClockView | null {
    const c = routerProbe(this.#deps.hub().router)?.clock(id) ?? null;
    return c?.synced() ? c : null;
  }

  /** A fixture time on the DUT's clock (D10): the wired fit, else the hub path, else none. */
  dutTime(dut: string, tFix: number, tHub: number): DutTime {
    const wired = this.#deps.sync.toDut(dut, tFix);
    if (wired) {
      return { t_dut_us: Math.round(wired.t_dut_us), sync: 'wired', u_us: wired.u_us };
    }
    const map = this.#deps.map();
    const f = map ? this.#clock(map.fixture) : null;
    const d = this.#clock(dut);
    if (f && d) {
      return { t_dut_us: Math.round(d.toNode(tHub)), sync: 'hub', u_us: Math.round(f.info()!.uncertainty_us + d.info()!.uncertainty_us) };
    }
    return { t_dut_us: null, sync: 'none', u_us: null };
  }

  /** Every event on the bus: the fixture's edges, frames and line levels, the DUTs' boot.down. */
  onEvent(e: HubEvent): void {
    const map = this.#deps.map();
    if (!map || !e.device) {
      return;
    }
    if (e.device === map.fixture) {
      const dot = e.type.indexOf('.');
      const ref = map.byChannel(e.type.slice(0, dot));
      if (!ref) {
        return;
      }
      if (e.part === 'event' && (e.member === 'edges' || e.member === 'frame')) {
        this.#reading(map, ref, e);
      } else if (e.part === 'state' && e.member === 'level' && typeof e.fields?.level === 'boolean' && ref.line.decode !== 'ws2812' && lineDrive(ref.line) !== 'nfet_gate' && lineDrive(ref.line) !== 'pwm') {
        // An nfet_gate line's edges are its write stamps, not a capture (D4), so its `level` is no check on them; a
        // pwm line's `level` says only that its duty is above 0 (m2-c3-inputs D5): no transition of the DUT's pin.
        this.#levelState(map, ref, e, e.fields.level);
      }
      return;
    }
    if (e.part === 'event' && e.member === 'down' && map.isDut(e.device) && !e.replayed) {
      const ref = map.line(e.device, e.type.slice(0, e.type.indexOf('.')));
      if (ref?.line.role === 'button' && ref.line.wired) {
        this.#down(ref, e);
      }
    }
  }

  /** The fixture time of an event: its t_us unwrapped on the fixture's clock, else the u32 as it is. */
  #fixTimes(map: BenchMap, e: HubEvent): { tFix: number; toHub: (tFix: number) => number } {
    const t32 = e.t_dev_us ?? 0;
    const c = this.#clock(map.fixture);
    if (c) {
      return { tFix: c.unwrap(t32, nowUs()), toHub: (t) => c.toHub(t) };
    }
    // Before the first TIME burst (not on the bench: the handshake syncs first): hub time is the router's.
    return { tFix: t32, toHub: (t) => e.t_hub_us + (t - t32) };
  }

  #reading(map: BenchMap, ref: BenchLineRef, e: HubEvent): void {
    const hub = this.#deps.hub();
    const f = e.fields ?? {};
    const st = this.#stats.get(ref.line.channel) ?? { edges: 0, dropped: 0, frames: 0, bad_frames: 0 };
    this.#stats.set(ref.line.channel, st);
    if (e.member === 'frame' && Number(f.bits) !== FRAME_BITS) {
      // Not a reading of the LED (its grb is 0 whatever the LED shows): counted, never published as dark.
      st.bad_frames++;
      return;
    }
    const { tFix: base, toHub } = this.#fixTimes(map, e);
    const alias = this.#alias(ref.dut);
    const cut = this.#deps.inCut(ref.dut) ? { cut: true } : {};
    if (e.member === 'frame') {
      st.frames++;
      const grb = (Number(f.grb) || 0) & 0xffffff;
      const tHub = toHub(base);
      hub.events.publish({
        type: 'hil.frame',
        device: ref.dut,
        alias,
        t_hub_us: Math.round(tHub),
        fields: { line: ref.name, channel: ref.line.channel, grb, lit: grb !== 0, bits: FRAME_BITS, t_fix_us: base, t_hub_us: Math.round(tHub), ...this.dutTime(ref.dut, base, tHub), ...cut },
      });
      return;
    }
    const n = Math.min(Number(f.n) || 0, BATCH_MAX);
    const dts = Array.isArray(f.dt_us) ? (f.dt_us as number[]) : [];
    const levels = Number(f.levels) || 0;
    const dropped = Number(f.dropped) || 0;
    st.dropped += dropped;
    st.edges += n;
    const raw: LevelEdge[] = [];
    for (let i = 0; i < n; i++) {
      const tFix = base + (Number(dts[i]) || 0);
      raw.push({ t_fix_us: tFix, t_hub_us: toHub(tFix), level: BIT(levels, i) });
    }
    // Through the line's glitch filter: only its transitions are published, timed, waited for.
    const lf = this.#filter(ref);
    const out = lf.filter.edges(raw, batchSettles(n, Number(dts[n - 1]) || 0, dropped), dropped > 0);
    this.#arm(ref, lf);
    for (const t of out) {
      this.#transition(ref, t, alias, cut);
    }
  }

  /** The fixture's `level` STATE on a line: settles its open burst, or corrects it (LevelFilter.state). */
  #levelState(map: BenchMap, ref: BenchLineRef, e: HubEvent, level: boolean): void {
    const { tFix, toHub } = this.#fixTimes(map, e);
    const lf = this.#filter(ref);
    const out = lf.filter.state(level, { t_fix_us: tFix, t_hub_us: toHub(tFix) });
    this.#arm(ref, lf);
    const cut = this.#deps.inCut(ref.dut) ? { cut: true } : {};
    for (const t of out) {
      this.#transition(ref, t, this.#alias(ref.dut), cut);
    }
  }

  /** The level the fixture last reported on a line, as the filter's reference: none on an nfet_gate line (write stamps, D4). */
  #reported(ref: BenchLineRef): boolean | null {
    return lineDrive(ref.line) === 'nfet_gate' ? null : (this.#deps.level?.(ref.line.channel) ?? null);
  }

  /** The line's filter, made on first use at the level the fixture last reported. */
  #filter(ref: BenchLineRef): LineFilter {
    const ch = ref.line.channel;
    let lf = this.#filters.get(ch);
    if (!lf) {
      lf = { filter: new LevelFilter(this.#reported(ref)), timer: undefined };
      this.#filters.set(ch, lf);
    }
    return lf;
  }

  /** While the line's burst is open, UNSETTLED_MS until it settles on the reported level (LevelFilter.expire). */
  #arm(ref: BenchLineRef, lf: LineFilter): void {
    clearTimeout(lf.timer);
    lf.timer = undefined;
    if (!lf.filter.pending) {
      return;
    }
    lf.timer = setTimeout(() => {
      lf.timer = undefined;
      if (this.#filters.get(ref.line.channel) !== lf) {
        return; // reset since
      }
      try {
        const out = lf.filter.expire(this.#reported(ref));
        const cut = this.#deps.inCut(ref.dut) ? { cut: true } : {};
        for (const t of out) {
          this.#transition(ref, t, this.#alias(ref.dut), cut);
        }
      } catch (err) {
        console.error(JSON.stringify({ event: 'hil_edge_settle_failed', channel: ref.line.channel, message: (err as Error).message }));
      }
    }, UNSETTLED_MS);
    lf.timer.unref?.();
  }

  /**
   * One accepted transition: its hil.edge on the DUT; the fit's press or pin edge (not for a corrected one: its
   * time is the record's best guess, not a capture); a release's readback.
   */
  #transition(ref: BenchLineRef, t: LevelTransition, alias: string, cut: { cut?: boolean }): void {
    const { t_fix_us: tFix, t_hub_us: tHub, level } = t;
    this.#deps.hub().events.publish({
      type: 'hil.edge',
      device: ref.dut,
      alias,
      t_hub_us: Math.round(tHub),
      fields: {
        line: ref.name,
        channel: ref.line.channel,
        level,
        // An LED tap: lit at the bench's active level (led_gpio); a WS2812 line reports frames instead.
        ...(ref.line.role === 'led' && ref.line.active_level ? { lit: level === (ref.line.active_level === 'high') } : {}),
        t_fix_us: tFix,
        t_hub_us: Math.round(tHub),
        ...this.dutTime(ref.dut, tFix, tHub),
        ...(t.corrected ? { corrected: true } : {}),
        ...cut,
      },
    });
    const press = ref.line.role === 'button' ? pressLevel(ref.line) : null;
    if (!t.corrected && press !== null && level === press) {
      this.#deps.sync.pressEdge(ref.dut, tFix, tHub, this.#hubDut(ref.dut, tHub));
    } else if (!t.corrected && ref.line.role === 'test_pin' && !level) {
      this.#deps.sync.pinEdge(ref.dut, tFix, tHub);
    }
    for (const w of this.#waiters) {
      if (w.channel === ref.line.channel && w.level === level && tHub >= w.sinceHubUs - EDGE_MARGIN_US) {
        w.done({ t_fix_us: tFix, t_hub_us: Math.round(tHub) });
      }
    }
  }

  /** The hub path's DUT time at hub µs `tHub` (the cross-check of D10), or null. */
  #hubDut(dut: string, tHub: number): number | null {
    const d = this.#clock(dut);
    return d ? d.toNode(tHub) : null;
  }

  /** A DUT's boot.down: its stamp, unwrapped on its clock, is the other half of a fit sample. */
  #down(ref: BenchLineRef, e: HubEvent): void {
    const d = this.#clock(ref.dut);
    if (!d || e.t_dev_us === undefined) {
      return; // no clock to unwrap its u32 stamp with (not on the bench: the handshake syncs first)
    }
    this.#deps.sync.dutDown(ref.dut, d.unwrap(e.t_dev_us, nowUs()), e.t_hub_us);
  }

  #alias(id: string): string {
    try {
      return this.#deps.hub().registry.get(id)?.alias ?? id;
    } catch {
      return id;
    }
  }
}
