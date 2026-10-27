// Test helpers for the hub's fixture module (design m2-c1-hil; stream S4): FixtureNode, a scripted HIL
// fixture on a FakeNode, and benchRig(), a netRig with that fixture over a FakeSerial, two DUT pads over
// loopback TCP/UDP, a bench naming them, and the fixture module in the HubContext the op handlers get.
//
// FixtureNode speaks the generated fr.fixture codecs (packages/protocol/src/gen/caps/fixture.ts): HELLO role
// fixture; per channel `press {segments_us}` (BUSY while a press runs or when the line does not read
// released, UNSUPPORTED on drive none; RESULT {at_us, total_us} at the first press edge), `release` and
// `read`; `edges` batches (levels bit i, dt_us from the first edge's t_us, flushed flush_us after the last
// edge and 20 ms at most after the first, 32 at most) and `frame`s; the `level` property after a flush that
// changed it. Edge stamps are the intended times (a hardware timer's), and the fixture reads back what it
// drives. wire() connects a BOOT channel to a DUT FakeNode's button: the DUT stamps `down` at the press edge
// on its own clock plus its ISR latency, debounced (a bounce gives one down), and `up` once released. A pwm
// channel (fr.fixture 0.2, design m2-c3-inputs D5) takes `set_duty {duty}` (RESULT {at_us}; UNSUPPORTED on any
// other drive, and `press` on it is UNSUPPORTED); its `level` reads duty > 0, and `release` sets duty 0.
//
// Everything the fixture and a wired DUT do later (a gesture's next edges, an edges flush, the DUT's debounce)
// is on one agenda in fixture time, run in that order once the fixture's clock reaches it, as hardware timers
// would: a timer only wakes the agenda, and every command the fixture takes runs what is due first. So a busy
// event loop (a loaded Mac) delays when the fake's events go out, never what they say or in which order the
// fixture and its DUTs see them: a release that ran 30 ms late still ends the DUT's debounce 20 ms after its
// stamp, before a press the hub timed from those stamps.

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type ArtifactManifest, type Bench, BenchSchema, CLS, findOp, FLAG, type OpName } from '@fractonica/protocol';
import {
  decodeFixturePressArgs,
  decodeFixtureSetDutyArgs,
  encodeFixtureSetDutyResult,
  encodeMember,
  encodeFixtureEdges,
  encodeFixtureFrame,
  encodeFixtureLevelState,
  encodeFixturePressResult,
  encodeFixtureReadResult,
  encodePresenceHello,
  findCap,
  KIND,
  PORT,
  STATUS,
} from '@fractonica/protocol/gen';

import type { HubContext, HubRunOptions } from '../src/context.ts';
import type { Db } from '../src/db.ts';
import { createFixture, type FixtureModule } from '../src/fixture/index.ts';
import { HANDLERS } from '../src/ops.ts';
import { FakeNode, type FakeNodeOptions, type NetRig, netRig } from './fake-node.ts';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const RUN: HubRunOptions = { apiHost: '127.0.0.1', apiPort: 0, nodeHost: '127.0.0.1', nodePort: 0, nodeHttpPort: 0, noAdvert: true, serial: false };

const BUTTON = findCap('fr.button')!;
const DOWN = BUTTON.events.find((e) => e.name === 'down')!.id;
const UP = BUTTON.events.find((e) => e.name === 'up')!.id;
const LED_BLINK = findCap('fr.led')!.commands.find((c) => c.name === 'blink')!.id;
const FIX_EDGES = 1;
const FIX_FRAME = 2;
const FIX_LEVEL = 1;

/** One fixture line, as the s3k-fixture profile instances it. */
export interface ChannelSpec {
  name: string;
  port: number;
  drive?: 'none' | 'open_drain' | 'nfet_gate' | 'pwm';
  decode?: 'level' | 'ws2812';
}

interface LineSim {
  spec: ChannelSpec;
  /** What the fixture reads: an open-drain line is low while pressed or held. */
  level: boolean;
  pressing: boolean;
  /** Pulled low from outside (a hand, an unpowered DUT): an open-drain line then reads low at idle. */
  held: boolean;
  /** The running gesture's next edges and a pulse's end (a `release` drops them). */
  timers: Agendum[];
  pending: { t: number; level: boolean }[];
  flush: Agendum | null;
  firstAt: number;
  reported: boolean | null;
  edges: number;
  /** A pwm channel's duty (1/10,000). */
  duty: number;
  wire?: { dut: FakeNode; port: number; isrUs: number; delta: number; down: boolean; upTimer: Agendum | null };
}

/** One thing the fixture (or a wired DUT) does at fixture µs `t`; `done` once it ran or was cancelled. */
interface Agendum {
  t: number;
  seq: number;
  fn: () => void;
  done: boolean;
}

/** The wired DUT's button debounce (fr.button debounce_ms default): a release that lasts this long is its up. */
const DUT_DEBOUNCE_US = 20_000;

export interface FixtureNodeOptions extends FakeNodeOptions {
  channels: ChannelSpec[];
  /** The fixture's own status LED (fr.led), port. */
  statusPort?: number;
  /** fr.fixture flush_us. */
  flushUs?: number;
}

/** A scripted HIL fixture (see the file comment). */
export class FixtureNode extends FakeNode {
  lines = new Map<string, LineSim>();
  /** Presses taken (segments as sent, at_us), releases, read calls and BUSY answers. */
  presses: { channel: string; segments: number[]; at: number }[] = [];
  releases: string[] = [];
  /** set_duty calls taken (and answered OK), in order. */
  duties: { channel: string; duty: number; at: number }[] = [];
  reads = 0;
  busyAnswers = 0;
  /** status.blink calls (the identify blink at WELCOME). */
  blinks: number[] = [];
  #flushUs: number;
  /** What is still to happen, in fixture-time order (see the file comment). */
  #agenda: Agendum[] = [];
  #agendaSeq = 0;
  #wake: NodeJS.Timeout | null = null;
  #catching = false;

  constructor(opts: FixtureNodeOptions) {
    const { channels, statusPort = 20, flushUs = 2000, ...rest } = opts;
    super(rest);
    this.#flushUs = flushUs;
    this.describeAs([...channels.map((c) => ({ port: c.port, cap_id: 0x0006, name: c.name })), { port: statusPort, cap_id: 0x0002, name: 'status' }]);
    for (const spec of channels) {
      const idle = spec.drive !== 'pwm'; // a pwm line reads duty > 0: low at duty 0
      const line: LineSim = { spec, level: idle, pressing: false, held: false, timers: [], pending: [], flush: null, firstAt: 0, reported: null, edges: 0, duty: 0 };
      this.lines.set(spec.name, line);
      if (spec.decode !== 'ws2812') {
        this.props.set(`${spec.port}/${FIX_LEVEL}`, encodeFixtureLevelState({ level: idle }));
        line.reported = idle;
      }
      // Each command finds the line as the fixture's clock has it now, whatever ran late.
      this.handlers.set(`${spec.port}/1`, (args) => {
        this.#catchUp();
        return this.#press(line, args);
      });
      this.handlers.set(`${spec.port}/2`, () => {
        this.#catchUp();
        this.#release(line);
      });
      this.handlers.set(`${spec.port}/3`, () => {
        this.#catchUp();
        this.reads++;
        return { fields: encodeFixtureReadResult({ level: line.level, edges: line.edges, dropped: 0, bad_frames: 0 }) };
      });
      this.handlers.set(`${spec.port}/4`, (args) => {
        this.#catchUp();
        return this.#setDuty(line, args);
      });
    }
    this.handlers.set(`${statusPort}/${LED_BLINK}`, () => {
      this.blinks.push(this.nodeNowUs());
    });
  }

  /** HELLO with role fixture (05 §5.7 Role 2), as an s3k-fixture image sends it. */
  override hello(): void {
    const o = this.opts;
    const body = encodePresenceHello({
      mac: Buffer.from(o.mac, 'hex'),
      chip: 9,
      chip_rev: 2,
      fw_id_prefix: Buffer.from(o.fwPrefix, 'hex'),
      descriptor_hash: o.descriptorHash,
      board_hash: 0x51a3b0c1,
      role: 'fixture',
      caps: o.caps & ~(1 << 1), // no Wi-Fi: radio off
      hb_interval_ms: o.hbMs,
      reset_reason: 1,
      ota_state: this.otaState,
      alias: o.alias,
      alias_rev: o.aliasRev,
      channel: 0,
    });
    const { bytes } = this.envelope(CLS.PRESENCE, KIND.PRESENCE.HELLO, PORT.NODE, body, undefined, FLAG.ACK_REQ);
    this.raw(bytes, this.link === 'serial' ? 'serial' : 'tcp');
  }

  /** A BOOT channel wired to `dut`'s button on `port`; `isrUs`: the DUT's ISR-to-stamp latency. */
  wire(channel: string, dut: FakeNode, opts: { port?: number; isrUs?: number } = {}): void {
    const line = this.#line(channel);
    // Both clocks run on performance.now(): their difference is fixed (read at one instant: exact).
    const delta = clockDelta(dut, this);
    line.wire = { dut, port: opts.port ?? 1, isrUs: opts.isrUs ?? 30, delta, down: false, upTimer: null };
  }

  /** The line is pulled low from outside (true) or let go: an open-drain line's readback follows. */
  hold(channel: string, held: boolean): void {
    const line = this.#line(channel);
    this.#catchUp();
    line.held = held;
    this.#set(line, this.nodeNowUs(), this.#reads(line));
  }

  /** An input line changes level (an LED tap, a test_pin), stamped now or at `tUs`. */
  drive(channel: string, level: boolean, tUs = this.nodeNowUs()): void {
    this.#catchUp();
    this.#set(this.#line(channel), tUs, level);
  }

  /** A test_pin pulse: low now (or at `tUs`), high `us` later. */
  pulse(channel: string, us: number, tUs = this.nodeNowUs()): void {
    const line = this.#line(channel);
    this.#catchUp();
    this.#set(line, tUs, false);
    line.timers.push(this.#at(tUs + us, () => this.#set(line, tUs + us, true)));
  }

  /** One decoded WS2812 refresh on a ws2812 channel. */
  frame(channel: string, grb: number, opts: { bits?: number; tUs?: number } = {}): void {
    const line = this.#line(channel);
    this.#catchUp();
    this.event(line.spec.port, FIX_FRAME, encodeFixtureFrame({ bits: opts.bits ?? 24, grb }), { tUs: opts.tUs ?? this.nodeNowUs() });
  }

  /**
   * An edges batch as given (a ring overflow, a chattering burst, a hand-made batch), then, as the firmware's
   * flush does, the `level` STATE when the pin's level after it differs from the one last reported. `level`:
   * the pin's level after the flush (default: the batch's last edge's; null: the line and its STATE as they are,
   * a flush whose pin read the level already reported).
   */
  edges(channel: string, batch: { tUs: number; levels: number; dt_us: number[]; dropped?: number }, opts: { level?: boolean | null } = {}): void {
    const line = this.#line(channel);
    this.#catchUp();
    const n = batch.dt_us.length;
    this.event(line.spec.port, FIX_EDGES, encodeFixtureEdges({ n, levels: batch.levels, dt_us: batch.dt_us, dropped: batch.dropped ?? 0 }), { tUs: batch.tUs });
    const after = opts.level === undefined ? (n ? ((batch.levels >>> (n - 1)) & 1) === 1 : null) : opts.level;
    if (after !== null) {
      line.level = after;
      if (line.reported !== after) {
        line.reported = after;
        this.state(line.spec.port, FIX_LEVEL, encodeFixtureLevelState({ level: after }));
      }
    }
  }

  override close(): void {
    clearTimeout(this.#wake ?? undefined);
    this.#wake = null;
    for (const a of this.#agenda.splice(0)) {
      a.done = true;
    }
    super.close();
  }

  /** `fn` at fixture µs `t` (see the file comment); cancel with #cancel. */
  #at(t: number, fn: () => void): Agendum {
    const a: Agendum = { t, seq: this.#agendaSeq++, fn, done: false };
    let i = this.#agenda.length;
    while (i > 0 && this.#agenda[i - 1].t > t) {
      i--;
    }
    this.#agenda.splice(i, 0, a);
    if (!this.#catching) {
      this.#arm();
    }
    return a;
  }

  #cancel(a: Agendum | null | undefined): void {
    if (a) {
      a.done = true;
    }
  }

  /** The wake-up for the agenda's next entry: a timer only says when to look, the stamps say what happens. */
  #arm(): void {
    clearTimeout(this.#wake ?? undefined);
    this.#wake = null;
    while (this.#agenda.length && this.#agenda[0].done) {
      this.#agenda.shift();
    }
    const next = this.#agenda[0];
    if (next) {
      this.#wake = setTimeout(
        () => {
          this.#wake = null;
          this.#catchUp();
        },
        Math.max(0, (next.t - this.nodeNowUs()) / 1000),
      );
    }
  }

  /** Runs everything due by the fixture's clock now, in fixture-time order (what it adds that is due too). */
  #catchUp(): void {
    if (this.#catching) {
      return;
    }
    this.#catching = true;
    try {
      const now = this.nodeNowUs();
      while (this.#agenda.length && this.#agenda[0].t <= now) {
        const a = this.#agenda.shift()!;
        if (!a.done) {
          a.done = true;
          a.fn();
        }
      }
    } finally {
      this.#catching = false;
      this.#arm();
    }
  }

  #line(name: string): LineSim {
    const line = this.lines.get(name);
    if (!line) {
      throw new Error(`no fixture channel ${name}`);
    }
    return line;
  }

  /** What the fixture reads on the line now. */
  #reads(line: LineSim): boolean {
    if (line.spec.drive === 'nfet_gate') {
      return line.pressing;
    }
    if (line.spec.drive === 'open_drain') {
      return !line.pressing && !line.held;
    }
    return line.level;
  }

  #press(line: LineSim, args: Uint8Array): { status: number; fields?: Uint8Array } {
    const d = decodeFixturePressArgs(args);
    if (!d.ok || !d.value.segments_us.length) {
      return { status: STATUS.INVALID_ARGS };
    }
    if (!line.spec.drive || line.spec.drive === 'none' || line.spec.drive === 'pwm') {
      return { status: STATUS.UNSUPPORTED };
    }
    if (line.pressing || !this.#released(line)) {
      this.busyAnswers++;
      return { status: STATUS.BUSY };
    }
    const segs = d.value.segments_us;
    const at = this.nodeNowUs();
    const total = segs.reduce((a, b) => a + b, 0);
    this.presses.push({ channel: line.spec.name, segments: [...segs], at });
    let t = 0;
    segs.forEach((seg, i) => {
      const edgeAt = at + t;
      const pressing = i % 2 === 0;
      if (i === 0) {
        this.#drivePress(line, edgeAt, pressing);
      } else {
        line.timers.push(this.#at(edgeAt, () => this.#drivePress(line, edgeAt, pressing)));
      }
      t += seg;
    });
    line.timers.push(this.#at(at + total, () => this.#drivePress(line, at + total, false)));
    return { status: STATUS.OK, fields: encodeFixturePressResult({ at_us: at >>> 0, total_us: total }) };
  }

  /** set_duty on a pwm line: the duty now, its `level` STATE when duty > 0 changes. */
  #setDuty(line: LineSim, args: Uint8Array): { status: number; fields?: Uint8Array } {
    const d = decodeFixtureSetDutyArgs(args);
    if (!d.ok || d.value.duty > 10_000) {
      return { status: STATUS.INVALID_ARGS };
    }
    if (line.spec.drive !== 'pwm') {
      return { status: STATUS.UNSUPPORTED };
    }
    const at = this.nodeNowUs();
    this.duties.push({ channel: line.spec.name, duty: d.value.duty, at });
    this.#duty(line, d.value.duty);
    return { status: STATUS.OK, fields: encodeFixtureSetDutyResult({ at_us: at >>> 0 }) };
  }

  #duty(line: LineSim, duty: number): void {
    line.duty = duty;
    line.level = duty > 0;
    if (line.reported !== line.level) {
      line.reported = line.level;
      this.state(line.spec.port, FIX_LEVEL, encodeFixtureLevelState({ level: line.level }));
    }
  }

  #released(line: LineSim): boolean {
    return line.spec.drive === 'nfet_gate' ? !line.pressing : !line.held;
  }

  #release(line: LineSim): void {
    this.releases.push(line.spec.name);
    if (line.spec.drive === 'pwm') {
      this.#duty(line, 0);
      return;
    }
    line.timers.forEach((a) => this.#cancel(a));
    line.timers = [];
    if (line.pressing) {
      this.#drivePress(line, this.nodeNowUs(), false);
    }
  }

  /** The fixture drives (or stops driving) a press at fixture time `t`; a wired DUT sees it. */
  #drivePress(line: LineSim, t: number, pressing: boolean): void {
    if (line.pressing === pressing) {
      return;
    }
    line.pressing = pressing;
    this.#set(line, t, this.#reads(line));
    const w = line.wire;
    if (!w || w.dut.silent) {
      return;
    }
    // The DUT's button, debounced 20 ms in fixture time: a press while released is its down, stamped at the
    // edge on its own clock plus its ISR latency; a release that lasts 20 ms is its up (a press sooner, a bounce,
    // cancels it: the agenda has run every up due by then).
    if (pressing) {
      this.#cancel(w.upTimer);
      w.upTimer = null;
      if (!w.down) {
        w.down = true;
        w.dut.event(w.port, DOWN, new Uint8Array(0), { prio: 'realtime', tUs: t + w.delta + w.isrUs });
      }
    } else {
      const upAt = t + DUT_DEBOUNCE_US;
      this.#cancel(w.upTimer);
      w.upTimer = this.#at(upAt, () => {
        w.upTimer = null;
        w.down = false;
        if (!w.dut.silent) {
          w.dut.event(w.port, UP, new Uint8Array(0), { prio: 'realtime', tUs: upAt + w.delta });
        }
      });
    }
  }

  /** A level change at fixture time `t`: an edge in the batch, flushed after flushUs (20 ms at most). */
  #set(line: LineSim, t: number, level: boolean): void {
    if (level === line.level) {
      return;
    }
    line.level = level;
    line.edges++;
    if (!line.pending.length) {
      line.firstAt = t;
    }
    line.pending.push({ t, level });
    this.#cancel(line.flush);
    line.flush = null;
    if (line.pending.length >= 32 || t - line.firstAt >= 20_000) {
      this.#flush(line);
    } else {
      line.flush = this.#at(t + this.#flushUs, () => this.#flush(line));
    }
  }

  #flush(line: LineSim): void {
    line.flush = null;
    const batch = line.pending.splice(0);
    if (!batch.length || this.silent) {
      return;
    }
    const t0 = batch[0].t;
    const levels = batch.reduce((acc, e, i) => (e.level ? acc | (1 << i) : acc), 0) >>> 0;
    this.event(line.spec.port, FIX_EDGES, encodeFixtureEdges({ n: batch.length, levels, dt_us: batch.map((e) => Math.round(e.t - t0)), dropped: 0 }), { tUs: Math.round(t0) });
    if (line.reported !== line.level) {
      line.reported = line.level;
      this.state(line.spec.port, FIX_LEVEL, encodeFixtureLevelState({ level: line.level }));
    }
  }
}

/** `a`'s clock less `b`'s (FakeNodes count on one performance.now()), read at one instant: exact to the µs. */
export function clockDelta(a: FakeNode, b: FakeNode): number {
  const at = performance.now();
  return a.nodeUsAt(at) - b.nodeUsAt(at);
}

/** A member body from its JSON form (generated codecs); throws on a value they refuse. */
export function member(cap: string, part: 'args' | 'event' | 'state', name: string, value: Record<string, unknown> = {}): Uint8Array {
  const enc = encodeMember(cap, part, name, value);
  if (!enc.ok) {
    throw new Error(`${cap} ${part} ${name}: ${enc.detail}`);
  }
  return enc.value;
}

// ---- artifacts ----

/**
 * Registers an artifact manifest (no image: dry runs and caps lookups only) for `profile`, with `caps` as
 * fr_manifest.json lists them; fw_id defaults to a hash of the profile and `fw` (a FakeNode's fwPrefix
 * is its first 16 hex).
 */
export function addManifest(
  db: Db,
  dir: string,
  o: { profile: string; fw?: string; board?: string; target?: string; chipId?: number; caps?: ArtifactManifest['caps'] } & Record<string, unknown>,
): { buildId: string; manifest: ArtifactManifest } {
  const { profile, fw, board, target, chipId, caps, ...extra } = o;
  const fwId = fw ? fw.padEnd(64, '0') : createHash('sha256').update(profile).digest('hex');
  const buildId = `node/${profile}/debug/${fwId.slice(0, 12)}`;
  const manifest = {
    schema: 'fractonica.artifact/1',
    build_id: buildId,
    app: 'node',
    profile,
    build_type: 'debug',
    board: board ?? 'esp32s3-devkitc1-n16r8',
    target: target ?? 'esp32s3',
    chip_id: chipId ?? 9,
    part_profile: 'fr-4mb-v1',
    version: '1a2b3c4',
    source_dir: '/src',
    git: { sha: 'abc', dirty: false },
    idf: { version: 'v6.1', commit: 'def' },
    fw_id: fwId,
    elf_sha256: '00',
    size: 1024,
    built_at: new Date().toISOString(),
    flash: {
      mode: 'dio',
      freq: '80m',
      size: '4MB',
      files: [
        { offset: '0x0', role: 'bootloader', blob: `sha256:${fwId}`, size: 1024 },
        { offset: '0x8000', role: 'partition_table', blob: `sha256:${fwId}`, size: 1024 },
        { offset: '0xd000', role: 'ota_data_initial', blob: `sha256:${fwId}`, size: 1024 },
        { offset: '0x10000', role: 'app', blob: `sha256:${fwId}`, size: 1024 },
      ],
    },
    partitions: [],
    ...(caps ? { caps } : {}),
    ...extra,
  } as ArtifactManifest;
  const path = join(dir, `${buildId.replaceAll('/', '_')}.json`);
  writeFileSync(path, JSON.stringify(manifest));
  db.prepare('INSERT INTO artifacts (build_id, source_dir, profile, build_type, fw_id, built_at, manifest_path, fault) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    buildId,
    '/src',
    profile,
    'debug',
    fwId,
    manifest.built_at,
    path,
    null,
  );
  return { buildId, manifest };
}

// ---- the bench rig ----

export const FIX = { mac: 'e8f60a81bc48', addr: 0x0070, alias: 'fix-s3', profile: 's3k-fixture' };
export const C3 = { mac: '1cdbd4175cc4', addr: 0x0071, alias: 'pad-c3', profile: 'c3o-pad' };
export const C6 = { mac: '58e6c5d55e64', addr: 0x0072, alias: 'pad-c6', profile: 'c6-pad' };

/** The fixture channels benchRig's bench wires (a subset of §2.2: two DUTs). */
export const CHANNELS: ChannelSpec[] = [
  { name: 'ch0', port: 1, drive: 'open_drain' },
  { name: 'ch2', port: 3, drive: 'open_drain' },
  { name: 'ch4', port: 5 },
  { name: 'ch6', port: 7, decode: 'ws2812' },
  { name: 'ch8', port: 9 },
  { name: 'ch10', port: 11 },
  { name: 'ch12', port: 13, drive: 'pwm' },
];

/** The fixture firmware FixtureNode reports (its HELLO fw_id prefix), which testBench pins. */
export const FIX_FW = '00112233aabbccdd';

/**
 * The bench of benchRig (§2.3, two DUTs): pad-c3 with a led_gpio tap and a reserved analog line, pad-c6 with
 * WS2812; fixture.fw_id pinned to the build FixtureNode runs (FIX_FW).
 */
export function testBench(patch: (b: Record<string, any>) => void = () => undefined): Bench {
  const b: Record<string, any> = {
    schema: 'fractonica/bench@1',
    id: 'lab',
    fixture: { device: FIX.mac, profile: FIX.profile, fw_id: FIX_FW },
    duts: {
      [C3.mac]: {
        profile: C3.profile,
        rf_weak: true,
        lines: {
          boot: { role: 'button', dut_gpio: 9, channel: 'ch0', fixture_gpio: 42, via: 'direct', series_ohm: 1000 },
          status: { role: 'led', dut_gpio: 8, channel: 'ch4', fixture_gpio: 4, active_level: 'low', series_ohm: 10000 },
          test_pin: { role: 'test_pin', dut_gpio: 10, channel: 'ch8', fixture_gpio: 15, series_ohm: 1000 },
          analog: { role: 'analog', dut_gpio: 3, channel: 'ch12', fixture_gpio: 11, dut_profile: 'c3o-analog', rc: { r_ohm: 10000, c_nf: 1000 }, wired: false },
        },
      },
      [C6.mac]: {
        profile: C6.profile,
        lines: {
          boot: { role: 'button', dut_gpio: 9, channel: 'ch2', fixture_gpio: 40, via: 'direct', series_ohm: 1000 },
          status: { role: 'led', dut_gpio: 8, channel: 'ch6', fixture_gpio: 6, decode: 'ws2812', series_ohm: 1000 },
          test_pin: { role: 'test_pin', dut_gpio: 20, channel: 'ch10', fixture_gpio: 17, series_ohm: 1000 },
        },
      },
    },
  };
  patch(b);
  return BenchSchema.parse(b);
}

export interface BenchRig {
  r: NetRig;
  fixture: FixtureNode;
  c3: FakeNode;
  c6: FakeNode;
  module: FixtureModule;
  hub: HubContext;
  bench: Bench;
  /** An op through HANDLERS with its parsed input, as the REST layer calls it. */
  call(op: OpName, input: Record<string, unknown>): Promise<any>;
  close(): Promise<void>;
}

/**
 * The `release` the fixture module sends on every driven line of `bench` at each fixture WELCOME (D11), and the
 * `set_duty {duty: 0}` on every wired analog (pwm) line (m2-c3-inputs D5): waits until the fixture has them all,
 * then forgets them (`releases`, `duties`; its `frames` keep them), so a test sees only its own.
 */
export async function welcomeReleases(fixture: FixtureNode, bench: Bench): Promise<void> {
  const lines = Object.values(bench.duts).flatMap((d) => Object.values(d.lines).filter((l) => l.wired));
  const driven = lines.filter((l) => l.role === 'button' || l.role === 'en').map((l) => l.channel);
  const pwm = lines.filter((l) => l.role === 'analog').map((l) => l.channel);
  const done = () => driven.every((ch) => fixture.releases.includes(ch)) && pwm.every((ch) => fixture.duties.some((d) => d.channel === ch && d.duty === 0));
  const deadline = Date.now() + 3000;
  while (!done()) {
    if (Date.now() > deadline) {
      throw new Error(`no release at the fixture's WELCOME on ${[...driven.filter((ch) => !fixture.releases.includes(ch)), ...pwm].join(', ')}`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  fixture.releases = [];
  fixture.duties = [];
}

/**
 * A netRig with FixtureNode fix-s3 on a FakeSerial (role fixture, profile s3k-fixture), pads pad-c3 and
 * pad-c6 over loopback (registry profiles c3o-pad and c6-pad), each BOOT channel wired to its pad unless
 * `wire` is false, the fixture module started on `bench`, everything connected unless `connect` is false.
 */
export async function benchRig(
  opts: {
    bench?: Bench;
    wire?: boolean;
    connect?: boolean;
    isrUs?: number;
    hbMs?: number;
    fixture?: Partial<FixtureNodeOptions>;
    c3?: Partial<Omit<FakeNodeOptions, 'caps' | 'hub' | 'addr' | 'alias'>>;
    c6?: Partial<Omit<FakeNodeOptions, 'caps' | 'hub' | 'addr' | 'alias'>>;
    /** pad-c3's instances (default boot and status; c3o-analog adds analog on port 3). */
    c3Caps?: { port: number; cap_id: number; name: string }[];
  } = {},
): Promise<BenchRig> {
  const r = await netRig();
  const bench = opts.bench ?? testBench();
  r.registry.add({ device_id: FIX.mac, addr: FIX.addr, alias: FIX.alias, role: 'fixture', profile: FIX.profile, board: 'esp32s3-devkitc1-n16r8', chip: 'esp32s3', provisioned: true, net: 0 });
  const fixture = new FixtureNode({ mac: FIX.mac, addr: FIX.addr, alias: FIX.alias, serial: r.serial, hbMs: opts.hbMs ?? 500, channels: CHANNELS, clockOffsetUs: 77_000_000, fwPrefix: FIX_FW, ...opts.fixture });
  const c3 = r.pad({ mac: C3.mac, addr: C3.addr, alias: C3.alias, hbMs: opts.hbMs ?? 500, clockOffsetUs: 3_000_000, ...opts.c3, ...(opts.c3Caps ? { caps: opts.c3Caps } : {}) });
  const c6 = r.pad({ mac: C6.mac, addr: C6.addr, alias: C6.alias, hbMs: opts.hbMs ?? 500, clockOffsetUs: 9_500_000, ...opts.c6 });
  r.registry.get(C3.mac)!.profile = C3.profile;
  r.registry.get(C6.mac)!.profile = C6.profile;
  const module = createFixture(() => hub, RUN, { bench });
  const hub = { ...r.hub, fixture: module, hubSourceDir: REPO, startedAt: Date.now() } as HubContext;
  module.start();
  if (opts.wire !== false) {
    fixture.wire('ch0', c3, { isrUs: opts.isrUs });
    fixture.wire('ch2', c6, { isrUs: opts.isrUs });
  }
  if (opts.connect !== false) {
    await fixture.connected(r.events);
    await welcomeReleases(fixture, bench);
    await c3.connected(r.events);
    await c6.connected(r.events);
  }
  return {
    r,
    fixture,
    c3,
    c6,
    module,
    hub,
    bench,
    call: async (op, input) => HANDLERS[op](findOp(op)!.input.parse(input), hub),
    async close() {
      module.stop();
      fixture.close();
      await r.close();
    },
  };
}
