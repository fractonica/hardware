// The M2-C1 harness (design m2-c1-hil §4 S6, §5.2, D13, D14): T-HIL (tests/e2e/t-hil.ts, lib/hil.ts) and the
// fixture's use by the other gates, without a board:
// - lib/hil.ts on recorded figures: §2.1's gesture expectations (with a DUT's own long_press_ms from its
//   profile), a gesture's verdict (order, extra, down within 2 ms of the edge, held_ms, bounce on counts),
//   attribution by DUT time, the loss accounting with rf_weak, the LED matcher (the clamped brightness scale
//   (c·b+127)/255, identical re-sends ignored, resync STATEs untimed and at most 5 %, lost STATEs, blinks
//   within on_ms ± 5 ms), the fit, test_pin pulses and run.ts's preflight;
// - the bench's chattering edges (first T-HIL run) through the hub's glitch filter (timeline.ts LevelFilter)
//   into the verdicts: pad-c6's double_click with each release read twice, pad-c3's blink with a 4 µs dip, a
//   press read as 4 same-level edges; press and release paired by transition even on the raw stream;
// - T-HIL against a scripted bench hub on a random port (a fixture that answers input_simulate {layer: gpio}
//   with hil.edge readings and the DUT's boot events, LEDs with hil.frame/hil.edge, diag stats, pin_pulse):
//   the four DUTs pass, pad-c3's accounted RF loss warns, an unaccounted loss fails, a DUT on another profile
//   is skipped (and fails the gate run, not a run narrowed by --devices), an unpinned fixture or a bench that
//   pins none fails fast unless --any-fixture-fw, a stale fit is warmed outside the verdict, phase 4 judges a
//   failed pulse per DUT, phase 3's losses go over its reports, the restore checks each LED on the fixture
//   (after phase 4's reboots too), and a cancel releases every line, puts the LEDs and bindings back within
//   the runner's grace;
// - run.ts --tier hil: the tier in the report, the bench_get preflight failing fast with the faulty line,
//   the suite's args after `--`, --list per tier, standalone --help/--list without reaching FR_HUB;
// - T-LAT skipped while the bench wires its rig (the checkout's file when the hub has none), T-INPUT --press-by
//   fixture (no person needed under test_run), T-LED --verify fixture (its tolerance published, a profile
//   mismatch named) and T-AGENT (a) on op.called (a real press it asked for, test runs' calls not its own,
//   the hub's support from the hub);
// - a dry run on a real loopback hub (hil-rig.ts: real-hub.ts with its serial bridge, four fr_net_node pads and
//   S2's serial-only virtual fixture): T-HIL passes on every phase, and a cancel mid-buttons leaves every line idle.
// Nothing here reaches the lab hub on 7420 or the boards.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer as createTcpServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { readBench } from '@fractonica/host';
import { type Bench, type BenchStatus, type HubEvent, matchType, REGISTRY_HASH } from '@fractonica/protocol';

import { BINDING, callProblems, type Ev, evaluateBinding, testWindows } from '../../../tests/e2e/lib/agent-evidence.ts';
import {
  accountLosses,
  alignEvents,
  attribute,
  benchEdit,
  benchFileLines,
  buttonConfig,
  type ButtonCfg,
  diagnoseWiring,
  type HilDut,
  judgeFit,
  judgePulses,
  judgeTrial,
  type LedCommand,
  ledConfig,
  matchLed,
  parseFlow,
  preflightVerdict,
  profileInstances,
  pulseWidths,
  readProfile,
  scale,
  segmentsFor,
  simulateButton,
  summarizeTrials,
  type WiringProbe,
  wsGrb,
} from '../../../tests/e2e/lib/hil.ts';
import { Hub, HubError } from '../../../tests/e2e/lib/hub.ts';
import { CANCEL_GRACE_MS, discover, parseArgs as runnerArgs, runScenarios, select, standaloneList, standaloneUsage } from '../../../tests/e2e/lib/runner.ts';
import { type ScenarioCtx, scenarioOf, skipReason, tierOf } from '../../../tests/e2e/lib/scenario.ts';
import { sleep } from '../../../tests/e2e/lib/tasks.ts';
import { hubPublishesOpCalled } from '../../../tests/e2e/t-agent.ts';
import tHil, { DEFAULTS as T_HIL, parseArgs as hilArgs, isGateRun, runTHil, type THilOptions, WS_COLORS } from '../../../tests/e2e/t-hil.ts';
import tInput, { DEFAULTS as T_INPUT, humanPhase, parseArgs as inputArgs, needsFor as inputNeeds, type Target } from '../../../tests/e2e/t-input.ts';
import tLat, { benchSkip, DEFAULTS as T_LAT } from '../../../tests/e2e/t-lat.ts';
import { DEFAULTS as T_LED, parseArgs as ledArgs, runTLed } from '../../../tests/e2e/t-led.ts';
import { batchSettles, LevelFilter } from '../src/fixture/timeline.ts';
import { BIN } from './cpp-node.ts';
import { until } from './fake-node.ts';
import { fixtureLines, startHilRig } from './hil-rig.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const E2E = join(REPO, 'tests', 'e2e');
/** This checkout's lab bench, for the dry run on a real hub (the hub loads the same file). */
const LAB_BENCH = readBench(REPO, 'lab').bench as Bench | null;
/**
 * The lab bench as designed (§2.3: pad-c3 on ch0/ch4/ch8, pad-c3b on ch1/ch5/ch9), frozen: the cases that need
 * exact channels read it, never the checkout's file, which is the rig as wired and follows the bench.
 */
const DESIGN_BENCH_YAML = readFileSync(join(REPO, 'packages', 'codegen', 'test', 'fixtures', 'lab-design.bench.yaml'), 'utf8');

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
});

// ---- recorded rows ----

const DEFAULT_CFG: ButtonCfg = { debounce_ms: 20, long_press_ms: 600, multi_press_gap_ms: 250, multi_press_max: 2 };
let seq = 1000;
/** A hub event as events_read returns it. */
const ev = (type: string, over: Partial<HubEvent> & { fields?: Record<string, unknown> } = {}): HubEvent => {
  const s = over.seq ?? ++seq;
  return { cursor: `c:7.${s}`, seq: s, type, t_hub_us: 1_792_000_000_000_000 + s, ...over } as HubEvent;
};
/** A fixture reading on a line: fixture µs, and the DUT time on the wired fit (DUT = fixture + 1 s). */
const edge = (line: string, level: boolean, tFix: number, over: Record<string, unknown> = {}) =>
  ev('hil.edge', { fields: { line, level, t_fix_us: tFix, t_hub_us: 1_792_000_000_000_000 + tFix, t_dut_us: (tFix + 1_000_000) >>> 0, sync: 'wired', u_us: 60, ...over } });
const frame = (grb: number, tFix: number, over: Record<string, unknown> = {}) =>
  ev('hil.frame', { fields: { line: 'status', grb, lit: grb !== 0, bits: 24, t_fix_us: tFix, t_hub_us: 1_792_000_000_000_000 + tFix, t_dut_us: (tFix + 1_000_000) >>> 0, sync: 'wired', u_us: 60, ...over } });
/** A DUT event at fixture time tFix (+ the DUT's ISR latency). */
const btn = (member: string, tFix: number, fields: Record<string, unknown> = {}, lat = 40) => ev(`boot.${member}`, { part: 'event', member, t_dev_us: (tFix + 1_000_000 + lat) >>> 0, fields });
const state = (member: string, value: unknown, tFix: number, over: Partial<HubEvent> = {}) => ev(`status.${member}`, { part: 'state', member, t_dev_us: (tFix + 1_000_000 + 30) >>> 0, fields: { [member]: value }, ...over });

/** What a gesture yields on a DUT that behaves: the fixture's edges and the expected events at their times. */
function recorded(segments: number[], t0: number, cfg = DEFAULT_CFG) {
  const edges: HubEvent[] = [];
  let t = t0;
  segments.forEach((d, k) => {
    edges.push(edge('boot', k % 2 === 1, t));
    t += d;
  });
  edges.push(edge('boot', true, t));
  const events = simulateButton(segments, cfg).map((x) => btn(x.evt, t0 + x.at_us, x.evt === 'click' ? { count: x.count } : x.held_ms !== undefined ? { held_ms: x.held_ms } : {}));
  return { edges, events };
}

describe('tests/e2e/lib/hil.ts: gestures (§2.1)', () => {
  it('segments and expected events per gesture, at button.cap.yaml defaults', () => {
    const names = (segs: number[], cfg = DEFAULT_CFG) => simulateButton(segs, cfg).map((e) => (e.evt === 'click' ? `click{${e.count}}` : e.evt));
    expect(segmentsFor('click', DEFAULT_CFG)).toEqual([80_000]);
    expect(names(segmentsFor('click', DEFAULT_CFG))).toEqual(['down', 'up', 'click{1}']);
    expect(simulateButton([80_000], DEFAULT_CFG).find((e) => e.evt === 'click')!.at_us).toBe(330_000); // the 250 ms gap after the release
    expect(segmentsFor('double_click', DEFAULT_CFG)).toEqual([80_000, 100_000, 80_000]);
    expect(names(segmentsFor('double_click', DEFAULT_CFG))).toEqual(['down', 'up', 'down', 'up', 'click{2}']);
    expect(segmentsFor('long_press', DEFAULT_CFG)).toEqual([800_000]);
    expect(simulateButton([800_000], DEFAULT_CFG)).toEqual([
      { evt: 'down', at_us: 0 },
      { evt: 'long_press', at_us: 600_000, held_ms: 600 },
      { evt: 'up', at_us: 800_000, held_ms: 800 },
    ]);
    // press: a real hold (a 2 s one: long_press at 600 ms, no click); released before long_press_ms: a click.
    expect(names(segmentsFor('press', DEFAULT_CFG, 2000))).toEqual(['down', 'long_press', 'up']);
    expect(names([400_000])).toEqual(['down', 'up', 'click{1}']);
    // bounce: the short pulses fall inside the 20 ms lockout: exactly one down, one up, one click.
    expect(segmentsFor('bounce', DEFAULT_CFG)).toEqual([600, 400, 600, 400, 80_000]);
    expect(simulateButton(segmentsFor('bounce', DEFAULT_CFG), DEFAULT_CFG).map((e) => [e.evt, e.at_us])).toEqual([
      ['down', 0],
      ['up', 82_000],
      ['click', 332_000],
    ]);
  });

  it("follows the DUT's own config: long_press_ms from its profile, multi_press_max 1, long_press off", () => {
    const slow = { ...DEFAULT_CFG, long_press_ms: 800 };
    expect(segmentsFor('long_press', slow)).toEqual([1_000_000]);
    expect(simulateButton([1_000_000], slow).map((e) => e.evt)).toEqual(['down', 'long_press', 'up']);
    expect(simulateButton(segmentsFor('double_click', DEFAULT_CFG), { ...DEFAULT_CFG, multi_press_max: 1 }).map((e) => e.evt)).toEqual(['down', 'up', 'click', 'down', 'up', 'click']);
    // long_press_ms 0 disables it: the fixture still holds 800 ms, and the release is a click.
    expect(segmentsFor('long_press', { ...DEFAULT_CFG, long_press_ms: 0 })).toEqual([800_000]);
    expect(simulateButton([800_000], { ...DEFAULT_CFG, long_press_ms: 0 }).map((e) => e.evt)).toEqual(['down', 'up', 'click']);
  });

  it("reads each DUT's fr.button and fr.led config from its profile, over the cap defaults", () => {
    expect(parseFlow('{ cap: fr.led, driver: led_ws2812, bind: leds.rgb, config: { max_brightness: 64 } }')).toEqual({ cap: 'fr.led', driver: 'led_ws2812', bind: 'leds.rgb', config: { max_brightness: 64 } });
    const text = `profile: x\nboard: y\ncaps:\n  boot:   { cap: fr.button, driver: button_gpio, bind: buttons.boot, config: { long_press_ms: 800, debounce_ms: 30 } }  # slow\n  status: { cap: fr.led, driver: led_gpio, bind: leds.status }\n  ch0:    { cap: fr.fixture, driver: fixture_gpio, bind: gpio.42, config: { drive: open_drain } }\nnet: { link_profile: default }\n`;
    const inst = profileInstances(text);
    expect(Object.keys(inst)).toEqual(['boot', 'status', 'ch0']);
    expect(buttonConfig(inst)).toEqual({ debounce_ms: 30, long_press_ms: 800, multi_press_gap_ms: 250, multi_press_max: 2 });
    expect(inst.ch0.config).toEqual({ drive: 'open_drain' });
    // The repo's profiles: the WS2812 pads cap at 64, the C3s' led_gpio keeps the cap default.
    expect(ledConfig(readProfile(REPO, 'c6-pad'))).toEqual({ max_brightness: 64, driver: 'led_ws2812' });
    expect(ledConfig(readProfile(REPO, 's3l-pad'))).toEqual({ max_brightness: 64, driver: 'led_ws2812' });
    expect(ledConfig(readProfile(REPO, 'c3o-pad'))).toEqual({ max_brightness: 255, driver: 'led_gpio' });
    expect(buttonConfig(readProfile(REPO, 'c3o-pad'))).toEqual(DEFAULT_CFG);
    expect(buttonConfig(readProfile(REPO, 'no-such-profile'))).toEqual(DEFAULT_CFG);
  });
});

describe('tests/e2e/lib/hil.ts: a gesture’s verdict (§5.2 phase 2)', () => {
  it('passes a click and a double click in DUT-time order, each down 40 µs after its edge on the fit', () => {
    const c = recorded([80_000], 0);
    const v = judgeTrial({ gesture: 'click', segments_us: [80_000], ...c }, DEFAULT_CFG);
    expect(v).toMatchObject({ ok: true, expected: ['down', 'up', 'click{1}'], got: ['down', 'up', 'click{1}'], missing: [], extra: [], down_latency_us: [40] });
    // Arrival out of DUT-time order (the click before the up) is published, not judged.
    const d = recorded([80_000, 100_000, 80_000], 1_000_000);
    const shuffled = [d.events[0], d.events[2], d.events[1], d.events[4], d.events[3]].map((e, k) => ({ ...e, seq: 5000 + k }));
    const dv = judgeTrial({ gesture: 'double_click', segments_us: [80_000, 100_000, 80_000], edges: d.edges, events: shuffled }, DEFAULT_CFG);
    expect(dv).toMatchObject({ ok: true, got: ['down', 'up', 'down', 'up', 'click{2}'], down_latency_us: [40, 40] });
    expect(dv.out_of_order).toBeGreaterThan(0);
  });

  it('a gesture a hub release cut short fails on the cut alone: none of its events count as missing or extra', () => {
    const d = recorded([80_000, 100_000, 80_000], 0);
    const cut = judgeTrial(
      { gesture: 'double_click', segments_us: [80_000, 100_000, 80_000], edges: d.edges.slice(0, 2), events: d.events.slice(0, 2), interrupted: { reason: 'dut_offline', after_us: 120_000 } },
      DEFAULT_CFG,
    );
    expect(cut).toMatchObject({ ok: false, expected: [], missing: [], extra: [], got: ['down', 'up'], problems: ['cut short 120 ms in by a hub release (dut_offline): not judged'] });
    expect(summarizeTrials([cut])).toMatchObject({ trials: 1, ok: 0, expected: 0, missing: 0, extra: 0 });
  });

  it('fails an extra event, a late down, a wrong hold and an untimed down; a missing one is only counted', () => {
    const c = recorded([80_000], 0);
    const extra = judgeTrial({ gesture: 'click', segments_us: [80_000], edges: c.edges, events: [...c.events, btn('click', 400_000, { count: 1 })] }, DEFAULT_CFG);
    expect(extra).toMatchObject({ ok: false, extra: ['click{1}'], problems: ['extra click{1}'] });
    const late = recorded([80_000], 0);
    late.events[0] = btn('down', 0, {}, 2500);
    expect(judgeTrial({ gesture: 'click', segments_us: [80_000], ...late }, DEFAULT_CFG).problems).toEqual(["down 1 2500 µs after the fixture's edge (want -500..2000)"]);
    const early = recorded([80_000], 0);
    early.events[0] = btn('down', 0, {}, -800);
    expect(judgeTrial({ gesture: 'click', segments_us: [80_000], ...early }, DEFAULT_CFG).ok).toBe(false);
    const held = recorded([80_000], 0);
    held.events[1] = btn('up', 80_000, { held_ms: 120 });
    expect(judgeTrial({ gesture: 'click', segments_us: [80_000], ...held }, DEFAULT_CFG).problems).toEqual(['up 1 held_ms 120 for a 80 ms hold (± 22)']);
    const hubOnly = recorded([80_000], 0);
    hubOnly.edges = hubOnly.edges.map((e) => ({ ...e, fields: { ...e.fields, sync: 'hub' } }));
    expect(judgeTrial({ gesture: 'click', segments_us: [80_000], ...hubOnly }, DEFAULT_CFG).problems).toEqual(['down 1 untimed: no wired fit for its press edge']);
    // A lost click: missing, still ok (the loss accounting judges it).
    const lost = recorded([80_000], 0);
    expect(judgeTrial({ gesture: 'click', segments_us: [80_000], edges: lost.edges, events: lost.events.slice(0, 2) }, DEFAULT_CFG)).toMatchObject({ ok: true, missing: ['click{1}'], extra: [] });
    // A click with the wrong count is missing one and has one extra.
    const two = recorded([80_000], 0);
    two.events[2] = btn('click', 330_000, { count: 2 });
    expect(judgeTrial({ gesture: 'click', segments_us: [80_000], ...two }, DEFAULT_CFG)).toMatchObject({ ok: false, missing: ['click{1}'], extra: ['click{2}'] });
  });

  it('judges bounce on counts only: a down stamped at a later bounce edge (2 ms late) passes; a second down fails', () => {
    const segs = segmentsFor('bounce', DEFAULT_CFG);
    const b = recorded(segs, 0);
    b.events[0] = btn('down', 0, {}, 2000 + 40);
    expect(judgeTrial({ gesture: 'bounce', segments_us: segs, ...b }, DEFAULT_CFG)).toMatchObject({ ok: true, down_latency_us: [] });
    expect(judgeTrial({ gesture: 'bounce', segments_us: segs, edges: b.edges, events: [...b.events, btn('down', 1000)] }, DEFAULT_CFG).ok).toBe(false);
  });

  it('attributes events to gestures by DUT time: a late arrival stays with its gesture; with no fit, by seq', () => {
    const a = recorded([80_000], 0);
    const b = recorded([80_000], 360_000); // the next press 280 ms after the last release
    const marks = [a.edges[0].seq - 1, b.edges[0].seq - 1];
    // a's click arrives after b's press (an RF retry): its DUT time keeps it in a's window.
    const lateClick = { ...a.events[2], seq: b.edges[1].seq + 5 };
    const att = attribute(marks, [...a.edges, ...b.edges], [a.events[0], a.events[1], ...b.events, lateClick], 350_000);
    expect(att.events[0].map((e) => e.type)).toEqual(['boot.down', 'boot.up', 'boot.click']);
    expect(att.events[1].map((e) => e.type)).toEqual(['boot.down', 'boot.up', 'boot.click']);
    expect(att.unattributed).toEqual([]);
    // An event far from both: unattributed (an extra).
    expect(attribute(marks, [...a.edges, ...b.edges], [btn('down', 5_000_000)], 350_000).unattributed).toHaveLength(1);
    // Without wired times: by the cursors' seqs.
    const none = [...a.edges, ...b.edges].map((e) => ({ ...e, fields: { ...e.fields, t_dut_us: null, sync: 'none' } }));
    const bySeq = attribute(marks, none, [{ ...a.events[0], seq: marks[0] + 1, t_dev_us: undefined }, { ...b.events[0], seq: marks[1] + 1, t_dev_us: undefined }], 350_000);
    expect(bySeq.events.map((x) => x.length)).toEqual([1, 1]);
  });

  it('pairs a double_click by kind and time: any one lost event is exactly one missing, each surviving down on its own edge (an accounted RF loss)', () => {
    const segs = [80_000, 100_000, 80_000];
    const names = ['down', 'up', 'down', 'up', 'click{2}'];
    for (let drop = 0; drop < 5; drop++) {
      const r = recorded(segs, 5_000_000);
      const v = judgeTrial({ gesture: 'double_click', segments_us: segs, edges: r.edges, events: r.events.filter((_, k) => k !== drop) }, DEFAULT_CFG);
      // Before the alignment, losing #0 or #1 gave missing [down, up], extra [up] and "down 1 180040 µs after
      // the fixture's edge" (the second down timed against the first edge).
      expect(v, `drop #${drop}`).toMatchObject({ ok: true, missing: [names[drop]], extra: [], problems: [] });
      expect(v.down_latency_us, `drop #${drop}`).toEqual(drop === 0 || drop === 2 ? [40] : [40, 40]);
      // One lost Q1 frame is +1 on the DUT's counters: accounted, a warning on pad-c3, and on pad-c6 at
      // 0.6 % of a phase's 170 events, a pass.
      const lossOf = (expected: number, rfWeak: boolean) =>
        accountLosses({ expected, missing: summarizeTrials([v]).missing, before: { events_dropped: 0, delivery_failed: 0 }, after: { events_dropped: 0, delivery_failed: 1 }, rfWeak });
      expect(lossOf(5, true), `drop #${drop}`).toMatchObject({ verdict: 'warn', unaccounted: 0, accounted: 1 });
      expect(lossOf(170, false).verdict, `drop #${drop}`).toBe('pass');
    }
    // Without a timed edge (no fit, no hub clock), kind and order alone still pair them.
    const r = recorded(segs, 5_000_000);
    const untimed = r.edges.map((e) => ({ ...e, fields: { ...e.fields, t_dut_us: null, sync: 'none' } }));
    expect(judgeTrial({ gesture: 'double_click', segments_us: segs, edges: untimed, events: r.events.slice(1) }, DEFAULT_CFG)).toMatchObject({ missing: ['down'], extra: [] });
    // Time keeps a stray event of the right kind from taking an expected one: a down 100 ms off is extra.
    const exp = simulateButton([80_000], DEFAULT_CFG);
    const c = recorded([80_000], 0);
    const ref = (c.edges[0].fields!.t_dut_us as number) >>> 0;
    expect(alignEvents(exp, [btn('down', -100_000), ...c.events], ref)).toEqual([1, 2, 3]);
    expect(alignEvents(exp, [btn('down', -100_000), c.events[1], c.events[2]], ref)).toEqual([-1, 1, 2]);
    expect(alignEvents(exp, [btn('down', -100_000), c.events[1], c.events[2]], null)).toEqual([0, 1, 2]);
  });
});

describe('tests/e2e/lib/hil.ts: the loss accounting (§5.2 phase 2)', () => {
  const c0 = { events_dropped: 10, delivery_failed: 3 };
  it('accounts a missing event by events_dropped + delivery_failed; above 1 % fails, or warns on an rf_weak DUT; unaccounted always fails', () => {
    expect(accountLosses({ expected: 170, missing: 1, before: c0, after: { events_dropped: 11, delivery_failed: 3 }, rfWeak: false })).toMatchObject({ verdict: 'pass', delta: 1, accounted: 1, unaccounted: 0, loss_pct: 0.59 });
    const over = { expected: 170, missing: 4, before: c0, after: { events_dropped: 12, delivery_failed: 5 }, alias: 'pad-c3b' };
    expect(accountLosses({ ...over, rfWeak: false })).toMatchObject({ verdict: 'fail', loss_pct: 2.35, problems: ['pad-c3b: RF loss 2.35 % (4 of 170 events) above 1 %'] });
    // pad-c3 (rf_weak, about -80 dBm): the same loss is a warning, named.
    expect(accountLosses({ ...over, alias: 'pad-c3', rfWeak: true })).toMatchObject({ verdict: 'warn', problems: ['pad-c3: RF loss 2.35 % (4 of 170 events) above 1 % (rf_weak: a warning)'] });
    // A loss the counters do not show fails, rf_weak or not.
    expect(accountLosses({ expected: 170, missing: 2, before: c0, after: { events_dropped: 11, delivery_failed: 3 }, rfWeak: true, alias: 'pad-c3' })).toMatchObject({ verdict: 'fail', unaccounted: 1 });
    expect(accountLosses({ expected: 170, missing: 1, before: null, after: null, rfWeak: true }).verdict).toBe('fail');
    // A counter that went back (a reboot) counts from 0.
    expect(accountLosses({ expected: 100, missing: 1, before: c0, after: { events_dropped: 1, delivery_failed: 0 }, rfWeak: false })).toMatchObject({ delta: 1, verdict: 'pass' });
    expect(accountLosses({ expected: 100, missing: 0, before: c0, after: c0, rfWeak: false })).toMatchObject({ verdict: 'pass', loss_pct: 0 });
  });

  it('phase 3: lost STATEs count in the figure with no counter (uncounted), over the reports expected; one loss is allowed', () => {
    // 46 reports, one lost STATE: no counter moved (a LATEST frame), still accounted, and one loss passes.
    expect(accountLosses({ expected: 46, missing: 0, uncounted: 1, before: c0, after: c0, rfWeak: false, allow: 1 })).toMatchObject({ verdict: 'pass', accounted: 1, uncounted: 1, unaccounted: 0, loss_pct: 2.17 });
    // Before: the same loss over 45 commands, with no allowance, failed a healthy pad-c6.
    expect(accountLosses({ expected: 45, missing: 0, uncounted: 1, before: c0, after: c0, rfWeak: false }).verdict).toBe('fail');
    // A missing effect_done (Q1) still needs its counter; with it, one passes.
    expect(accountLosses({ expected: 46, missing: 1, before: c0, after: { ...c0, delivery_failed: 4 }, rfWeak: false, allow: 1 })).toMatchObject({ verdict: 'pass', accounted: 1 });
    expect(accountLosses({ expected: 46, missing: 1, before: c0, after: c0, rfWeak: false, allow: 1 })).toMatchObject({ verdict: 'fail', unaccounted: 1 });
    // Two losses: above the allowance and 1 %: fails, or warns on pad-c3.
    const two = { expected: 46, missing: 1, uncounted: 1, before: c0, after: { ...c0, delivery_failed: 4 }, allow: 1, alias: 'pad-c6' };
    expect(accountLosses({ ...two, rfWeak: false })).toMatchObject({ verdict: 'fail', problems: ['pad-c6: RF loss 4.35 % (2 of 46 events, 1 of them lost STATEs no counter covers) above 1 %'] });
    expect(accountLosses({ ...two, rfWeak: true }).verdict).toBe('warn');
  });
});

describe('tests/e2e/lib/hil.ts: the LED matcher (§5.2 phase 3)', () => {
  const WS = { decode: 'ws2812' as const, active_level: 'high' as const, max_brightness: 64 };
  const LOW = { decode: 'level' as const, active_level: 'low' as const, max_brightness: 255 };
  const OFF = { on: false, color: 0xffffff, brightness: 64 };

  it('scales each component by the clamped brightness, (c·b+127)/255, in GRB order', () => {
    expect(scale(255, 64)).toBe(64);
    expect(scale(0x20, 64)).toBe(8);
    expect(scale(13, 64)).toBe(3); // below 14 a component reads 3 or less: WS_COLORS keep every component ≥ 0x20
    expect(wsGrb({ on: true, color: 0x20ff40, brightness: 64 }, 64)).toBe(0x400810);
    expect(wsGrb({ on: true, color: 0x20ff40, brightness: 200 }, 64)).toBe(0x400810); // clamped to max_brightness
    expect(wsGrb({ on: false, color: 0x20ff40, brightness: 64 }, 64)).toBe(0);
    for (const c of WS_COLORS) {
      for (const shift of [16, 8, 0]) {
        expect(scale((c >> shift) & 0xff, 64), c.toString(16)).toBeGreaterThanOrEqual(4);
      }
    }
  });

  it('matches sets with colours and toggles: each change within 5 ms of its STATE, the value right, identical re-sends ignored', () => {
    const green = wsGrb({ on: true, color: 0x20ff40, brightness: 64 }, 64);
    const cmds: LedCommand[] = [];
    const states: HubEvent[] = [];
    const readings: HubEvent[] = [];
    const step = (command: string, on: boolean, t: number, grb: number, color?: number) => {
      cmds.push({ seq: ev('cmd').seq, command, on });
      readings.push(frame(grb, t));
      if (command !== 'noop') {
        states.push(state('on', on, t));
      }
      if (color !== undefined) {
        states.push(state('color', color, t));
      }
    };
    step('set', true, 1_000_000, green, 0x20ff40); // on, in the new colour: two STATEs, one frame
    step('set', false, 1_200_000, 0);
    step('noop', false, 1_400_000, 0); // a set that changes nothing re-sends the same frame: ignored
    step('toggle', true, 1_600_000, green); // back on, in the steady colour the color STATE left
    const v = matchLed({ initial: OFF, states, readings, effects: [], commands: cmds }, WS);
    expect(v.problems).toEqual([]);
    expect(v).toMatchObject({ pass: true, changes: 3, resends: 1, explained: { state: 3, blink: 0, resync: 0 }, state_lost: 0, timed_states: 4, state_to_change_us: { n: 3, p50: 30 } });
    // The unclamped brightness (or RGB order) shows as a wrong value.
    const wrong = matchLed({ initial: OFF, states, readings: readings.map((r, k) => (k === 0 ? frame(0x08ff10, 1_000_000) : r)), effects: [], commands: cmds }, WS);
    expect(wrong.wrong_value).toEqual([{ cursor: expect.any(String), want: 'lit 0x400810', got: 'lit 0x08ff10' }]);
    expect(wrong.pass).toBe(false);
  });

  it('gives two changes 3 ms apart each its own STATE (a fast set right before a toggle)', () => {
    const c1 = ev('cmd');
    const r1 = frame(0x404040, 1_000_000);
    const s1 = state('on', true, 1_000_000);
    const c2 = ev('cmd');
    const r2 = frame(0, 1_002_700);
    const s2 = state('on', false, 1_002_700);
    const v = matchLed({ initial: OFF, states: [s1, s2], readings: [r1, r2], effects: [], commands: [{ seq: c1.seq, command: 'set', on: true }, { seq: c2.seq, command: 'toggle', on: false }] }, WS);
    expect(v.problems).toEqual([]);
    expect(v).toMatchObject({ pass: true, changes: 2, explained: { state: 2 }, wrong_value: [] });
  });

  it('fails an LED change no STATE explains and a status.on change the fixture never saw; a lost STATE is left to the accounting', () => {
    const c = ev('cmd');
    const s1 = state('on', true, 1_000_000);
    const v = matchLed({ initial: { ...OFF }, states: [s1], readings: [edge('status', false, 1_000_000)], effects: [], commands: [{ seq: c.seq, command: 'set', on: true }] }, LOW);
    expect(v).toMatchObject({ pass: true, changes: 1, explained: { state: 1 } }); // active low: level false is lit
    // The edge 8 ms after its STATE: missing (the STATE has no change) and unexplained.
    const off = matchLed({ initial: OFF, states: [state('on', true, 1_000_000)], readings: [edge('status', false, 1_008_000)], effects: [], commands: [] }, LOW);
    expect(off.missing_changes).toHaveLength(1);
    expect(off.unexplained).toHaveLength(1);
    expect(off.pass).toBe(false);
    // A change in a command's window with no STATE at all: its STATE was lost.
    const c2 = ev('cmd');
    const lost = matchLed({ initial: OFF, states: [], readings: [edge('status', false, 2_000_000)], effects: [], commands: [{ seq: c2.seq, command: 'set', on: true }] }, LOW);
    expect(lost).toMatchObject({ pass: true, state_lost: 1, unexplained: [] });
  });

  it('takes resync STATEs untimed (at most 5 %, each listed) and explains a change a resync caught up with', () => {
    const cmds: LedCommand[] = [];
    const states: HubEvent[] = [];
    const readings: HubEvent[] = [];
    let on = false;
    for (let k = 0; k < 20; k++) {
      const c = ev('cmd');
      on = !on;
      cmds.push({ seq: c.seq, command: 'toggle', on });
      readings.push(edge('status', !on, 1_000_000 + k * 100_000));
      states.push(k === 7 ? state('on', on, 1_000_000 + k * 100_000 + 900_000, { resync: true }) : state('on', on, 1_000_000 + k * 100_000));
    }
    const v = matchLed({ initial: OFF, states, readings, effects: [], commands: cmds }, LOW);
    expect(v).toMatchObject({ pass: true, explained: { state: 19, resync: 1 }, resync: { n: 1, pct: 5 } });
    expect(v.resync.states[0]).toMatchObject({ type: 'status.on', value: false });
    // Two of twenty is 10 %: above the limit.
    states[12] = { ...states[12], resync: true, t_dev_us: (states[12].t_dev_us ?? 0) + 900_000 };
    const many = matchLed({ initial: OFF, states, readings, effects: [], commands: cmds }, LOW);
    expect(many.pass).toBe(false);
    expect(many.problems).toContain('2 resync STATEs (10 %) above 5 %');
  });

  it('judges each blink: 3 pulses of on_ms ± 5 ms (p99), effect_done within 5 ms of the last edge (WS2812 restore frame; led_gpio last off + off_ms)', () => {
    const blink = { count: 3, on_ms: 100, off_ms: 100 };
    const lit = wsGrb({ on: true, color: 0xffffff, brightness: 64 }, 64);
    const run = (widthMs: number, doneMs: number, ws = true) => {
      const c = ev('cmd');
      const readings: HubEvent[] = [];
      for (let k = 0; k < 3; k++) {
        const t = 1_000_000 + k * 200_000;
        readings.push(ws ? frame(lit, t) : edge('status', false, t));
        readings.push(ws ? frame(0, t + widthMs * 1000) : edge('status', true, t + widthMs * 1000));
      }
      if (ws) {
        readings.push(frame(0, 1_600_000)); // show_steady after the last off phase: identical, a re-send
      }
      const done = ev('status.effect_done', { part: 'event', member: 'effect_done', t_dev_us: 1_000_000 + 1_000_000 + doneMs * 1000, fields: { effect: 'blink' } });
      return matchLed({ initial: OFF, states: [], readings, effects: [done], commands: [{ seq: c.seq, command: 'blink', blink }] }, ws ? WS : LOW);
    };
    const ok = run(100.4, 600.6);
    expect(ok.problems).toEqual([]);
    expect(ok).toMatchObject({ pass: true, explained: { blink: 6 }, resends: 1, blink: { n: 1, pass: true, width_p50_ms: 100.4 } });
    expect(ok.blinks[0]).toMatchObject({ pulses: 3, done_after_last_ms: 0.6 });
    expect(run(100.4, 600.6, false).blinks[0]).toMatchObject({ pass: true, done_after_last_ms: 0.2 });
    // pad-s3 at -75 dBm, first bench run: one 102.03 ms on-phase (its core task late under Wi-Fi load) passes.
    expect(run(102.03, 600).blinks[0]).toMatchObject({ pass: true, widths_ms: [102.03, 102.03, 102.03] });
    expect(run(105, 600).blinks[0].pass).toBe(true);
    expect(run(105.5, 600).blinks[0].problems).toEqual(['on-phase widths 105.5..105.5 ms (p99), want 100 ± 5']);
    expect(run(94.5, 600).blinks[0].problems).toEqual(['on-phase widths 94.5..94.5 ms (p99), want 100 ± 5']);
    expect(run(100, 610).blinks[0].problems[0]).toMatch(/^effect_done 10 ms from the last edge/);
  });

  it('fails a set or toggle the DUT answered ok but that changed nothing (no STATE, no reading): the fixture shows the wrong level by the next command', () => {
    const green = wsGrb({ on: true, color: 0x20ff40, brightness: 64 }, 64);
    const cmds: LedCommand[] = [];
    const states: HubEvent[] = [];
    const readings: HubEvent[] = [];
    // 4 alternating sets; every set {on: false} ignored (no STATE, no frame), as a LedService regression would.
    for (let k = 0; k < 4; k++) {
      const on = k % 2 === 0;
      cmds.push({ seq: ev('cmd').seq, command: 'set', on });
      if (on) {
        const t = 1_000_000 + k * 200_000;
        readings.push(frame(green, t));
        if (k === 0) {
          states.push(state('on', true, t), state('color', 0x20ff40, t));
        }
      }
    }
    const v = matchLed({ initial: { on: false, color: 0xffffff, brightness: 64 }, states, readings, effects: [], commands: cmds }, { decode: 'ws2812', active_level: 'high', max_brightness: 64 });
    // Before: pass, 0 unexplained, 0 missing, with the LED lit while the harness believed it off.
    expect(v.pass).toBe(false);
    expect(v.unexplained).toEqual([]);
    expect(v.missing_changes).toEqual([]);
    expect(v.not_applied.map((x) => [x.command, x.want, x.got])).toEqual([
      ['set', false, true],
      ['set', false, true],
    ]);
    expect(v.problems).toContain(`2 command(s) the fixture shows had no effect by the next command (first status.set at seq ${cmds[1].seq}: want dark, reads lit)`);
    // A toggle that does nothing on a led_gpio tap (no edge): reads the old level.
    const t1 = ev('cmd');
    const toggle = matchLed({ initial: { on: false, color: 0xffffff, brightness: 255 }, states: [], readings: [], effects: [], commands: [{ seq: t1.seq, command: 'toggle', on: true }] }, { decode: 'level', active_level: 'low', max_brightness: 255 });
    expect(toggle.not_applied).toEqual([{ seq: t1.seq, command: 'toggle', want: true, got: false }]);
  });

  it('keeps bad frames (bits != 24) out: a glitch between on and off passes, listed; a 48-bit frame in place of the off frame fails, named', () => {
    const WS = { decode: 'ws2812' as const, active_level: 'high' as const, max_brightness: 64 };
    const lit = wsGrb({ on: true, color: 0xffffff, brightness: 64 }, 64);
    // In arrival order: the on command and its frame, one partial refresh (23 bits, sent with grb 0), then
    // the off command and its frame.
    const on = ev('cmd');
    const litFrame = frame(lit, 1_000_000);
    const partial = frame(0, 1_100_000, { bits: 23, lit: false });
    const off = ev('cmd');
    const offFrame = frame(0, 1_200_000);
    const cmds: LedCommand[] = [
      { seq: on.seq, command: 'set', on: true },
      { seq: off.seq, command: 'set', on: false },
    ];
    const states = [state('on', true, 1_000_000), state('on', false, 1_200_000)];
    const glitch = matchLed({ initial: { on: false, color: 0xffffff, brightness: 64 }, states, readings: [litFrame, partial, offFrame], effects: [], commands: cmds }, WS);
    // Before: "1 LED change(s) no STATE or blink explains" and the real off frame dropped as a re-send.
    expect(glitch.problems).toEqual([]);
    expect(glitch).toMatchObject({ pass: true, changes: 2, unexplained: [], missing_changes: [], bad_frames: { n: 1, bits: [23] } });
    // A driver that sends 48 bits on its off write: no real off frame at all.
    const wide = frame(0, 1_200_000, { bits: 48, lit: false });
    const v = matchLed({ initial: { on: false, color: 0xffffff, brightness: 64 }, states, readings: [litFrame, wide], effects: [], commands: cmds }, WS);
    expect(v.pass).toBe(false);
    expect(v.missing_changes).toEqual([{ cursor: states[1].cursor, on: false, bad_frame: wide.cursor }]);
    expect(v.not_applied).toEqual([{ seq: off.seq, command: 'set', want: false, got: true }]);
    expect(v.problems[0]).toMatch(/1 met by a bad frame instead \(bits 48\)$/);
  });

  it('takes a lost on STATE beside its colour STATE as a lost STATE, not a wrong value; publishes the hub-time tolerance it judged with', () => {
    const WS = { decode: 'ws2812' as const, active_level: 'high' as const, max_brightness: 64 };
    const c = ev('cmd');
    const v = matchLed({ initial: { on: false, color: 0xffffff, brightness: 64 }, states: [state('color', 0x20ff40, 1_000_000)], readings: [frame(wsGrb({ on: true, color: 0x20ff40, brightness: 64 }, 64), 1_000_000)], effects: [], commands: [{ seq: c.seq, command: 'set', on: true }] }, WS);
    expect(v).toMatchObject({ pass: true, state_lost: 1, wrong_value: [] });
    // Readings on hub time (no fresh fit, as in T-LED): judged within 5 ms + u_us, and that is published.
    const hubTime = matchLed({ initial: { on: false, color: 0xffffff, brightness: 64 }, states: [state('on', true, 1_000_000)], readings: [frame(wsGrb({ on: true, color: 0xffffff, brightness: 64 }, 64), 1_007_000, { sync: 'hub', u_us: 3500 })], effects: [], commands: [{ seq: ev('cmd').seq - 3, command: 'set', on: true }] }, WS);
    expect(hubTime).toMatchObject({ pass: true, sync: { hub: 1 }, tolerance_us: { wired: 5000, hub_max: 8500 } });
  });
});

describe("the hub's glitch filter into T-HIL's verdicts (bench patterns, first T-HIL run)", () => {
  type Batch = { t: number; levels: number; dt_us: number[] };
  const bit = (b: Batch, i: number) => ((b.levels >>> i) & 1) === 1;
  /** The fixture's `edges` batches on a line, through the hub's glitch filter, as the hil.edge rows T-HIL reads. */
  const filtered = (line: string, batches: Batch[], level: boolean) => {
    const filter = new LevelFilter(level);
    return batches
      .flatMap((b) => filter.edges(b.dt_us.map((dt, i) => ({ t_fix_us: b.t + dt, t_hub_us: 1_792_000_000_000_000 + b.t + dt, level: bit(b, i) })), batchSettles(b.dt_us.length, b.dt_us.at(-1) ?? 0, 0)))
      .map((t) => edge(line, t.level, t.t_fix_us));
  };
  /** The same batches unfiltered: one row per edge, as hil.edge was before the filter. */
  const unfiltered = (line: string, batches: Batch[]) => batches.flatMap((b) => b.dt_us.map((dt, i) => edge(line, bit(b, i), b.t + dt)));
  const fixOf = (rows: HubEvent[]) => rows.map((e) => [e.fields!.t_fix_us, e.fields!.level]);
  const events = (segs: number[], t0: number) =>
    simulateButton(segs, DEFAULT_CFG).map((x) => btn(x.evt, t0 + x.at_us, x.evt === 'click' ? { count: x.count } : x.held_ms !== undefined ? { held_ms: x.held_ms } : {}));

  it("passes pad-c6's double_click whose releases each read twice, 11 µs apart (ch2.edges {n: 2, levels: 3, dt_us: [0, 11]}; 10/10 failed)", () => {
    const segs = [80_000, 100_000, 80_000];
    const t0 = 5_000_000;
    const batches: Batch[] = [
      { t: t0, levels: 0, dt_us: [0] },
      { t: t0 + 80_000, levels: 0b11, dt_us: [0, 11] },
      { t: t0 + 180_000, levels: 0, dt_us: [0] },
      { t: t0 + 260_000, levels: 0b11, dt_us: [0, 11] },
    ];
    const evs = events(segs, t0);
    const edges = filtered('boot', batches, true);
    expect(fixOf(edges)).toEqual([
      [t0, false],
      [t0 + 80_000, true],
      [t0 + 180_000, false],
      [t0 + 260_000, true],
    ]);
    expect(judgeTrial({ gesture: 'double_click', segments_us: segs, edges, events: evs }, DEFAULT_CFG)).toMatchObject({ ok: true, missing: [], extra: [], problems: [], down_latency_us: [40, 40] });
    // Should a repeat ever reach the harness, press and release still pair by transition (by ordinal, the second
    // press took the first release's repeat: a hold 99.99 ms off).
    expect(judgeTrial({ gesture: 'double_click', segments_us: segs, edges: unfiltered('boot', batches), events: evs }, DEFAULT_CFG)).toMatchObject({ ok: true, problems: [] });
  });

  it("passes pad-c3's blink whose second on-phase has a 4 µs dip 27.69 ms in (before: split 27.69 + 72.38 ms, 4 pulses)", () => {
    const LOW = { decode: 'level' as const, active_level: 'low' as const, max_brightness: 255 };
    const blink = { count: 3, on_ms: 100, off_ms: 100 };
    const t0 = 1_000_000;
    const batches: Batch[] = [];
    for (let k = 0; k < 3; k++) {
      const t = t0 + k * 200_000;
      batches.push({ t, levels: 0, dt_us: [0] }); // lit (active low)
      if (k === 1) {
        batches.push({ t: t + 27_690, levels: 0b01, dt_us: [0, 4] }); // the dip
      }
      batches.push({ t: t + 100_400, levels: 1, dt_us: [0] }); // dark
    }
    const run = (readings: (c: HubEvent) => HubEvent[]) => {
      const c = ev('cmd');
      const rows = readings(c);
      // effect_done off_ms after the last off edge (a led_gpio line's restore to off leaves it flat).
      const done = ev('status.effect_done', { part: 'event', member: 'effect_done', t_dev_us: t0 + 500_400 + 100_000 + 1_000_000 + 300, fields: { effect: 'blink' } });
      return matchLed({ initial: { on: false, color: 0xffffff, brightness: 255 }, states: [], readings: rows, effects: [done], commands: [{ seq: c.seq, command: 'blink', blink }] }, LOW);
    };
    const v = run(() => filtered('status', batches, true));
    expect(v.problems).toEqual([]);
    expect(v.blinks[0]).toMatchObject({ pass: true, pulses: 3, widths_ms: [100.4, 100.4, 100.4], done_after_last_ms: 0.3 });
    expect(v.blink).toMatchObject({ n: 1, pass: true, width_p50_ms: 100.4, width_p99_ms: 100.4 });
    // Unfiltered, what the first run saw.
    expect(run(() => unfiltered('status', batches)).blinks[0].problems[0]).toBe('4 pulses, not 3');
  });

  it('passes a click whose press reads as 4 same-level edges (ch5.edges {n: 4, levels: 0, dt_us: [0, 12, 20, 27]}), its down timed on the first', () => {
    const t0 = 2_000_000;
    const burst = { levels: 0, dt_us: [0, 12, 20, 27] };
    const edges = filtered('boot', [{ t: t0, ...burst }, { t: t0 + 80_000, levels: 1, dt_us: [0] }], true);
    expect(fixOf(edges)).toEqual([
      [t0, false],
      [t0 + 80_000, true],
    ]);
    expect(judgeTrial({ gesture: 'click', segments_us: [80_000], edges, events: events([80_000], t0) }, DEFAULT_CFG)).toMatchObject({ ok: true, problems: [], down_latency_us: [40] });
    // The same burst on a line already low (pad-c3's lit LED, ch5): no change at all.
    expect(filtered('status', [{ t: t0, ...burst }], false)).toEqual([]);
  });
});

describe('tests/e2e/lib/hil.ts: fit, pulses, preflight', () => {
  it('judges the fit (residual p99 ≤ 500 µs, ≤ 10 % rejected) and test_pin pulses (p90 1000 ± 500 µs, no low across the reboot)', () => {
    expect(judgeFit({ samples: 10, rejected: 1, offset_us: 1_000_040, skew_ppm: 3.1, residual_p99_us: 180, age_ms: 900, valid: true, isr_latency_us: 38 })).toMatchObject({ pass: true, late_stamps: 1, isr_latency_us: 38 });
    expect(judgeFit({ samples: 8, rejected: 2, residual_p99_us: 180, valid: true }).problems).toEqual(['2 of 10 samples rejected (20 % > 10 %)']);
    expect(judgeFit({ samples: 10, rejected: 0, residual_p99_us: 720, valid: true }).pass).toBe(false);
    expect(judgeFit(null).problems).toEqual(['no fit (no accepted press sample)']);
    const edges = [0, 1, 2].flatMap((k) => [edge('test_pin', false, k * 200_000), edge('test_pin', true, k * 200_000 + 1030)]);
    const w = pulseWidths(edges);
    expect(w).toEqual({ widths_us: [1030, 1030, 1030], unpaired: 0 });
    // By transition: a low read twice is one fall, its pulse measured from the first.
    expect(pulseWidths([edge('test_pin', false, 0), edge('test_pin', false, 11), edge('test_pin', true, 1030)])).toEqual({ widths_us: [1030], unpaired: 0 });
    expect(judgePulses({ ...w, count: 3, lowsAcrossReboot: 0 })).toMatchObject({ pass: true, width_us: { p90: 1030 } });
    expect(judgePulses({ ...w, count: 3, lowsAcrossReboot: 1 }).problems).toEqual(['the line went low 1 time(s) across the reboot (outside a pulse)']);
    expect(judgePulses({ widths_us: [1700, 1700], unpaired: 1, count: 3, lowsAcrossReboot: 0 }).problems).toEqual(['2 pulses seen, not 3 (1 unpaired edges)', 'width p90 1700 µs, want 1000 ± 500']);
  });

  it("run.ts's preflight: the fixture away, a DUT in download mode and a BOOT line low at idle are fatal; the rest are notes", () => {
    const st = benchStatus(defaultDuts());
    expect(preflightVerdict(st)).toMatchObject({ ok: true, fatal: [], notes: [], bench: 'hardware/bench/lab.bench.yaml', fixture: { alias: 'fix-s3', presence: 'online', fw_ok: true } });
    const low = defaultDuts();
    low[1].bootLow = true;
    low[2].running = 'c6-pad-mono';
    low[3].testPinLow = true;
    const v = preflightVerdict(benchStatus(low, { fwOk: false }));
    expect(v.fatal).toEqual(['pad-c3b boot: fix-s3 ch1 reads low at idle']);
    expect(v.notes).toEqual(expect.arrayContaining([expect.stringContaining('fix-s3 runs'), 'pad-c6: runs c6-pad-mono, not its bench profile c6-pad', 'pad-s3 test_pin: fix-s3 ch11 reads low']));
    const dl = defaultDuts();
    dl[0].problem = 'download_mode';
    // A bench that pins no fixture fw_id: bench_get's fw_ok is false (fw_pinned false), and the preflight says only
    // that T-HIL needs --any-fixture-fw, not that the fixture runs another build than a pinned null.
    expect(preflightVerdict(benchStatus(defaultDuts(), { pinned: null })).notes).toEqual([
      'the bench lab pins no fixture fw_id (fix-s3 runs a1b2c3d4e5f60718): T-HIL runs only with --any-fixture-fw until fixture.fw_id is pinned in hardware/bench/lab.bench.yaml (§5.3 step 2)',
    ]);
    expect(preflightVerdict(benchStatus(dl, { fixturePresence: 'offline' })).fatal).toEqual([
      'fix-s3 (the fixture, e8f60a81bc48) is offline: it must be on its USB serial session; after any fixture power loss, run fr bench before touching a DUT',
      'pad-c3: on USB with no HELLO, likely download mode: power-cycle it (C3/S3 on USB: esptool --after watchdog-reset)',
    ]);
  });
});

// ---- a scripted bench hub ----

type Reply = { ok: boolean; cursor: string; data?: unknown; error?: { code: string; message: string; retryable: boolean; details?: Record<string, unknown> } };
type Handler = (input: Record<string, any>) => Reply | 'hang' | Promise<Reply | 'hang'>;

interface FakeHub {
  url: string;
  calls: { op: string; input: Record<string, any>; at: number }[];
  on: Record<string, Handler>;
}

async function fakeHub(on: Record<string, Handler>): Promise<FakeHub> {
  const hub: FakeHub = { url: '', calls: [], on };
  const held = new Set<ServerResponse>();
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c));
    req.on('end', () => {
      const op = req.url!.split('/').pop()!;
      const input = JSON.parse(raw || '{}') as Record<string, any>;
      hub.calls.push({ op, input, at: Date.now() });
      void Promise.resolve(hub.on[op] ? hub.on[op](input) : { ok: false, cursor: '', error: { code: 'NOT_FOUND', message: `unknown op ${op}`, retryable: false } }).then((reply) => {
        if (reply === 'hang') {
          held.add(res);
          res.on('close', () => held.delete(res));
          return;
        }
        if (!res.destroyed) {
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply));
        }
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  hub.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(() => closeServer(server, held));
  return hub;
}

function closeServer(server: Server, held: Set<ServerResponse>): Promise<void> {
  held.forEach((r) => r.destroy());
  server.closeAllConnections();
  return new Promise((r) => server.close(() => r()));
}

function ctxOn(url: string, args: string[] = [], signal: AbortSignal = new AbortController().signal) {
  const logs: string[] = [];
  const measured: Record<string, unknown> = {};
  const hub = new Hub(url);
  const ctx: ScenarioCtx = { hub, hubUrl: hub.url, sourceDir: REPO, allowHuman: false, signal, args, log: (m) => logs.push(m), measure: (n, v) => (measured[n] = v) };
  return { ctx, logs, measured };
}

/** One DUT of the scripted bench (lab.bench.yaml's four, §2.3). */
interface FakeDut {
  device: string;
  alias: string;
  profile: string;
  running: string;
  presence: string;
  rf_weak: boolean;
  debug: boolean;
  decode: 'level' | 'ws2812';
  channels: { boot: string; status: string; test_pin: string };
  /** DUT µs = fixture µs + offset (u32): pad-s3's wraps during the run. */
  offsetUs: number;
  latencyUs: number;
  rssi: number;
  led: { on: boolean; color: number; brightness: number };
  max: number;
  stats: { events_dropped: number; delivery_failed: number; dup: number; cached_replies: number };
  /** Drops the k-th boot event it would publish; `counted` adds it to events_dropped. */
  drop?: { at: number[]; counted: boolean };
  bootEvents: number;
  /** Sends RGB order instead of GRB (a broken driver). */
  rgbOrder?: boolean;
  /** The LED's readings come this long after its write (a slow refresh, µs). */
  ledLagUs?: number;
  bootLow?: boolean;
  testPinLow?: boolean;
  problem?: string | null;
  pressAt?: number;
  samples: number;
  bindings: { slot: number; from: string; to: string; args: unknown }[];
  /** With it, the fit goes stale as the hub's does (D10): invalid this long after its newest sample, readings then on hub time. */
  fitMaxAgeMs?: number;
  lastSampleAt?: number;
  /** Its presses add no fit sample (a DUT whose boot.down never reaches the hub). */
  noSamples?: boolean;
  /** pin_pulse calls (0-based) that fail over the link (TIMEOUT), and how long each takes. */
  pulseFail?: number[];
  pulseDelayMs?: number;
  pulses?: number;
  /** wait_for_device after its reboot times out. */
  noComeBack?: boolean;
  /** Answers status.set {on: false} ok and changes nothing (a LedService regression). */
  ignoreOff?: boolean;
  /** status STATEs (0-based, in publish order) that never reach the hub, and effect_done events likewise. */
  dropStates?: number[];
  statePubs?: number;
  dropDone?: { at: number[]; counted: boolean };
  donePubs?: number;
  /** The bits of its LED's off frames (a driver that sends 48 bits on its off write). */
  offBits?: number;
  /**
   * Its status.* command_send calls (0-based, every send counted, re-sends included) answered `expired`
   * (the CMD came after its expire_at: the node refused it, nothing ran); answered `timeout` though they ran
   * (the RESULT lost); answered `timeout` with nothing run (the CMD lost).
   */
  expireCmds?: number[];
  timeoutRan?: number[];
  lostCmds?: number[];
  statusCmds?: number;
  /** pin_pulse calls (0-based) that reach it after their expire_at (diag over its link: TIMEOUT, details.status expired). */
  pulseExpire?: number[];
}

const DUT_IDS = { 'pad-c3': '1cdbd4175cc4', 'pad-c3b': '1cdbd416ba34', 'pad-c6': '58e6c5d55e64', 'pad-s3': '94a99015cecc' } as const;
const FIX = 'e8f60a81bc48';

function defaultDuts(): FakeDut[] {
  const base = (alias: keyof typeof DUT_IDS, profile: string, decode: 'level' | 'ws2812', ch: [string, string, string], offsetUs: number): FakeDut => ({
    device: DUT_IDS[alias],
    alias,
    profile,
    running: profile,
    presence: 'online',
    rf_weak: alias === 'pad-c3',
    debug: alias !== 'pad-s3',
    decode,
    channels: { boot: ch[0], status: ch[1], test_pin: ch[2] },
    offsetUs,
    latencyUs: 40,
    rssi: alias === 'pad-c3' ? -80 : -58,
    led: { on: false, color: 0xffffff, brightness: decode === 'ws2812' ? 64 : 255 },
    max: decode === 'ws2812' ? 64 : 255,
    stats: { events_dropped: 3, delivery_failed: 1, dup: 0, cached_replies: 0 },
    bootEvents: 0,
    samples: 0,
    bindings: alias === 'pad-c6' ? [{ slot: 0, from: 'pad-c6.msg:ping', to: 'pad-c6.status.blink', args: { count: 1 } }, { slot: 1, from: 'pad-c6.boot.down', to: 'pad-c3.status.blink', args: { count: 1 } }] : [],
  });
  return [
    base('pad-c3', 'c3o-pad', 'level', ['ch0', 'ch4', 'ch8'], 1_000_000_000),
    base('pad-c3b', 'c3o-pad', 'level', ['ch1', 'ch5', 'ch9'], 2_000_000_000),
    base('pad-c6', 'c6-pad', 'ws2812', ['ch2', 'ch6', 'ch10'], 3_000_000_000),
    // pad-s3's DUT clock wraps about 2 s into the run (DUT µs are u32).
    base('pad-s3', 's3l-pad', 'ws2812', ['ch3', 'ch7', 'ch11'], 0x1_0000_0000 - 7_000_000),
  ];
}

const GPIO = { ch0: 42, ch1: 41, ch2: 40, ch3: 39, ch4: 4, ch5: 5, ch6: 6, ch7: 7, ch8: 15, ch9: 16, ch10: 17, ch11: 18 } as Record<string, number>;

/** bench_get's answer for the scripted bench. */
/** The fake's fit freshness, as the hub's (D10): with fitMaxAgeMs, valid only while its newest sample is that young. */
const fitAge = (d: FakeDut) => (d.lastSampleAt === undefined ? 400 : Date.now() - d.lastSampleAt);
const fitValid = (d: FakeDut) => d.samples >= 4 && (d.fitMaxAgeMs === undefined || fitAge(d) <= d.fitMaxAgeMs);

function benchStatus(duts: FakeDut[], o: { fwOk?: boolean; fixturePresence?: string; clock?: boolean; pinned?: string | null; file?: string } = {}): BenchStatus {
  const problems: string[] = [];
  const lines: BenchStatus['lines'] = [];
  for (const d of duts) {
    const levelOf = (name: 'boot' | 'status' | 'test_pin') =>
      name === 'boot' ? !d.bootLow : name === 'test_pin' ? !d.testPinLow : d.decode === 'ws2812' ? null : !d.led.on; // active low taps
    for (const name of ['boot', 'status', 'test_pin'] as const) {
      const level = levelOf(name);
      const problem = name === 'boot' && d.bootLow ? 'line_low' : name === 'test_pin' && d.testPinLow ? 'line_low' : null;
      if (problem) {
        problems.push(`${d.alias} ${name}: fix-s3 ${d.channels[name]} reads low${name === 'boot' ? ' at idle' : ''}`);
      }
      lines.push({ dut: d.device, alias: d.alias, line: name, role: name === 'boot' ? 'button' : name === 'status' ? 'led' : 'test_pin', channel: d.channels[name], fixture_gpio: GPIO[d.channels[name]], wired: true, level, problem });
    }
    if (d.running !== d.profile) {
      problems.push(`${d.alias}: runs ${d.running}, not its bench profile ${d.profile}`);
    }
  }
  return {
    file: o.file ?? 'hardware/bench/lab.bench.yaml',
    bench: {
      schema: 'fractonica/bench@1',
      id: 'lab',
      fixture: { device: FIX, profile: 's3k-fixture', fw_id: o.pinned === undefined ? 'a1b2c3d4e5f60718' : o.pinned, vdd_mv: 3300 },
      duts: Object.fromEntries(
        duts.map((d) => [
          d.device,
          {
            profile: d.profile,
            rf_weak: d.rf_weak,
            lines: {
              boot: { role: 'button', dut_gpio: d.alias === 'pad-s3' ? 0 : 9, channel: d.channels.boot, fixture_gpio: GPIO[d.channels.boot], via: 'direct', series_ohm: 1000, wired: true },
              status:
                d.decode === 'ws2812'
                  ? { role: 'led', dut_gpio: d.alias === 'pad-s3' ? 15 : 8, channel: d.channels.status, fixture_gpio: GPIO[d.channels.status], decode: 'ws2812', series_ohm: 1000, wired: true }
                  : { role: 'led', dut_gpio: 8, channel: d.channels.status, fixture_gpio: GPIO[d.channels.status], active_level: 'low', series_ohm: 10000, wired: true },
              test_pin: { role: 'test_pin', dut_gpio: d.alias === 'pad-s3' ? 16 : d.alias === 'pad-c6' ? 20 : 10, channel: d.channels.test_pin, fixture_gpio: GPIO[d.channels.test_pin], series_ohm: 1000, wired: true },
              ...(d.alias.startsWith('pad-c3') ? { analog: { role: 'analog', dut_gpio: 3, channel: d.alias === 'pad-c3' ? 'ch12' : 'ch13', fixture_gpio: d.alias === 'pad-c3' ? 11 : 12, dut_profile: 'c3o-analog', rc: { r_ohm: 10000, c_nf: 1000 }, wired: false } } : {}),
            },
          },
        ]),
      ),
    } as BenchStatus['bench'],
    fixture: { device: FIX, alias: 'fix-s3', presence: (o.fixturePresence ?? 'online') as BenchStatus['fixture']['presence'], boot_at: '2026-10-23T20:00:00.000Z', fw_id: o.fwOk === false ? 'ffff0000ffff0000' : 'a1b2c3d4e5f60718', fw_ok: o.fwOk !== false && o.pinned !== null, fw_pinned: o.pinned !== null, profile: 's3k-fixture' } as BenchStatus['fixture'],
    clock: o.clock === false ? null : { uncertainty_us: 180, rtt_min_us: 360, bursts: 8, age_ms: 900 },
    lines,
    duts: duts.map((d) => ({
      device: d.device,
      alias: d.alias,
      profile: d.profile,
      running_profile: d.running,
      presence: d.presence as BenchStatus['duts'][number]['presence'],
      problem: d.problem ?? (d.running !== d.profile ? 'profile_mismatch' : null),
      fit: d.samples ? { samples: d.samples, rejected: 0, offset_us: d.offsetUs, skew_ppm: 1.4, residual_p99_us: 140, age_ms: fitAge(d), valid: fitValid(d), late_stamps: 0, isr_latency_us: d.debug ? 38 : null } : null,
    })),
    problems,
    ok: problems.length === 0,
  };
}

/**
 * The scripted bench: the fixture module's answers on the hub's API. input_simulate {layer: gpio} replies once
 * the gesture is over (D8; press: after its press edge) and publishes the fixture's hil.edge readings and the
 * DUT's boot events at their times (simulateButton on the DUT's config); status commands publish STATEs and
 * the LED's readings (a frame on every WS2812 write, an edge when a led_gpio tap changes); pin_pulse publishes
 * the test_pin's low and high. Faults are knobs on the DUTs.
 */
async function scriptedBench(duts: FakeDut[] = defaultDuts(), o: { fwOk?: boolean; pinned?: string | null; file?: string; wires?: Record<string, string | null> } = {}) {
  const events: HubEvent[] = [];
  let next = 100;
  const t0 = performance.now();
  const fixNow = () => (Math.round((performance.now() - t0) * 1000) + 5_000_000) >>> 0;
  const cur = () => `c:7.${next}`;
  const byAlias = (a: string) => duts.find((d) => d.alias === a || d.device === a);
  // The wires as they are (o.wires: a channel -> the DUT whose pin is physically on it, null for none), which
  // the bench file (each DUT's `channels`) may not match: a channel's readings go out on the DUT the file
  // gives it (as the hub's do), a press on it presses whichever DUT is on it.
  type Line = 'boot' | 'status' | 'test_pin';
  const physOn = (ch: string, line: Line): FakeDut | undefined => (o.wires && ch in o.wires ? (o.wires[ch] === null ? undefined : byAlias(o.wires[ch]!)) : duts.find((x) => x.channels[line] === ch));
  /** The bench DUT whose `line` channel a DUT's own pin is on (its readings are published there), or none. */
  const readsOn = (d: FakeDut, line: Line) => duts.find((x) => physOn(x.channels[line], line) === d);
  const publish = (d: FakeDut | null, type: string, fields: Record<string, unknown>, extra: Partial<HubEvent> = {}) => {
    const s = ++next;
    events.push({ cursor: `c:7.${s}`, seq: s, type, ...(d ? { device: d.device, alias: d.alias } : {}), t_hub_us: Date.now() * 1000, fields, ...extra } as HubEvent);
  };
  // As the hub's timeline: a reading goes out on the wired fit while it is valid, else on hub time.
  const reading = (d: FakeDut, type: 'hil.edge' | 'hil.frame', line: string, tFix: number, f: Record<string, unknown>) =>
    publish(d, type, { line, ...f, t_fix_us: tFix, t_hub_us: Date.now() * 1000, t_dut_us: (tFix + d.offsetUs) >>> 0, sync: d.fitMaxAgeMs === undefined || fitValid(d) ? 'wired' : 'hub', u_us: 60 });
  const sample = (d: FakeDut, n: number) => {
    if (!d.noSamples) {
      d.samples += n;
      d.lastSampleAt = Date.now();
    }
  };
  const bootEvent = (d: FakeDut, member: string, tFix: number, fields: Record<string, unknown> = {}) => {
    const k = d.bootEvents++;
    if (d.drop?.at.includes(k)) {
      if (d.drop.counted) {
        d.stats.events_dropped++;
      }
      return;
    }
    publish(d, `boot.${member}`, fields, { part: 'event', member, t_dev_us: (tFix + d.offsetUs + d.latencyUs) >>> 0 });
    if (member === 'down' || member === 'up') {
      publish(d, 'boot.pressed', { pressed: member === 'down' }, { part: 'state', member: 'pressed', t_dev_us: (tFix + d.offsetUs + d.latencyUs + 5) >>> 0 });
    }
  };
  const cfgOf = (d: FakeDut) => buttonConfig(readProfile(REPO, d.profile));
  const emit = (d: FakeDut, segments: number[], at: number, skipFirstDown = false) => {
    simulateButton(segments, cfgOf(d)).forEach((x, k) => {
      if (skipFirstDown && k === 0) {
        return;
      }
      bootEvent(d, x.evt, at + x.at_us, x.evt === 'click' ? { count: x.count } : x.held_ms !== undefined ? { held_ms: x.held_ms } : {});
    });
  };
  const grbOf = (d: FakeDut, s: { on: boolean; color: number; brightness: number }) => {
    const v = wsGrb(s, d.max);
    return d.rgbOrder ? (((v >> 8) & 0xff) << 16) | (((v >> 16) & 0xff) << 8) | (v & 0xff) : v;
  };
  const ledWrite = (d: FakeDut, s: { on: boolean; color: number; brightness: number }, at: number, prevOn: boolean) => {
    const tFix = at + (d.ledLagUs ?? 0);
    const on = readsOn(d, 'status');
    if (!on) {
      return; // its LED pin is on no fixture channel
    }
    if (d.decode === 'ws2812') {
      const bits = !s.on && d.offBits !== undefined ? d.offBits : 24;
      reading(on, 'hil.frame', 'status', tFix, bits === 24 ? { grb: grbOf(d, s), lit: s.on, bits } : { grb: 0, lit: false, bits });
    } else if (s.on !== prevOn) {
      reading(on, 'hil.edge', 'status', tFix, { level: !s.on });
    }
  };
  const setLed = (d: FakeDut, next: Partial<FakeDut['led']>) => {
    const before = { ...d.led };
    d.led = { ...d.led, ...next, brightness: Math.min(next.brightness ?? d.led.brightness, d.max) };
    const t = fixNow();
    ledWrite(d, d.led, t, before.on);
    for (const k of ['on', 'brightness', 'color'] as const) {
      if (d.led[k] !== before[k] && (k === 'on' || d.decode === 'ws2812')) {
        const n = (d.statePubs = (d.statePubs ?? 0) + 1) - 1;
        if (!d.dropStates?.includes(n)) {
          publish(d, `status.${k}`, { [k]: d.led[k] }, { part: 'state', member: k, t_dev_us: (t + d.offsetUs + 30) >>> 0 });
        }
      }
    }
  };
  const ok = (data: unknown = {}, cursor = cur()): Reply => ({ ok: true, cursor, data });
  const fail = (code: string, message: string, retryable = false): Reply => ({ ok: false, cursor: cur(), error: { code, message, retryable } });
  const on: Record<string, Handler> = {
    hub_status: () => ok({ warnings: [] }),
    bench_get: () => ok(benchStatus(duts, o)),
    device_get: (i) => {
      const d = byAlias(i.device);
      if (!d) {
        return fail('NOT_FOUND', `no device ${i.device}`);
      }
      const props: Record<string, unknown> = { 'status.on': d.led.on, 'boot.pressed': d.pressAt !== undefined };
      if (d.decode === 'ws2812') {
        props['status.color'] = d.led.color;
        props['status.brightness'] = d.led.brightness;
      }
      return ok({ device_id: d.device, alias: d.alias, presence: d.presence, profile: d.running, router: { presence: d.presence, links: ['tcp'], hello_caps: d.debug ? 0x12 : 0x02, heartbeat: { rssi_ap: d.rssi }, properties: props, instances: [{ name: 'boot' }, { name: 'status' }], clock: { uncertainty_us: 900 }, hb_interval_ms: 1000 } });
    },
    device_list: (i) => {
      const d = byAlias(i.selector);
      return d ? ok({ devices: [{ device_id: d.device, alias: d.alias, chip: null, profile: d.running, presence: d.presence }] }) : fail('NOT_FOUND', `no device ${i.selector}`);
    },
    diag_exec: async (i) => {
      if (i.port === FIX) {
        return i.line === 'info' ? ok({ response: { test_pin: -1, profile: 's3k-fixture' }, via: 'serial' }) : fail('INVALID_ARGS', 'fixture_internal');
      }
      const d = byAlias(i.port);
      if (!d) {
        return fail('NOT_FOUND', `no port ${i.port}`);
      }
      if (i.line === 'stats') {
        return ok({ response: { ...d.stats }, via: 'serial' });
      }
      const pulse = /^pin_pulse (\d+)$/.exec(i.line);
      if (pulse) {
        const k = (d.pulses = (d.pulses ?? 0) + 1) - 1;
        if (d.pulseDelayMs) {
          await sleep(d.pulseDelayMs);
        }
        if (d.pulseFail?.includes(k)) {
          return fail('TIMEOUT', `no RESULT from ${d.alias} within 5 s (diag over its link)`, true);
        }
        if (d.pulseExpire?.includes(k)) {
          return { ok: false, cursor: cur(), error: { code: 'TIMEOUT', message: `${d.device} received fr.diag.exec after it expired`, retryable: true, details: { status: 'expired', link: 'tcp' } } };
        }
        const t = fixNow();
        const tp = readsOn(d, 'test_pin');
        if (tp) {
          reading(tp, 'hil.edge', 'test_pin', t, { level: false });
          reading(tp, 'hil.edge', 'test_pin', t + Number(pulse[1]) + 25, { level: true });
        }
        return ok({ response: { ok: true, us: Number(pulse[1]) }, via: 'tcp' });
      }
      return fail('INVALID_ARGS', `unknown line ${i.line}`);
    },
    input_simulate: async (i) => {
      const d = byAlias(i.selector);
      if (!d) {
        return fail('NOT_FOUND', `no device ${i.selector}`);
      }
      if (i.layer !== 'gpio') {
        return fail('INVALID_ARGS', 'this bench only presses with layer gpio');
      }
      const cursor = cur();
      const t = fixNow();
      // The DUT the fixture's channel presses (the bench file's, unless the wires say otherwise).
      const pressed = physOn(d.channels.boot, 'boot');
      const result = (segments: number[], tFix: number) => ok({ results: [{ device: d.device, alias: d.alias, status: 'ok', layer: 'gpio', fixture: 'fix-s3', channel: d.channels.boot, press: { t_fix_us: tFix, t_hub_us: Date.now() * 1000, segments_us: segments, total_us: segments.reduce((a, b) => a + b, 0) } }] }, cursor);
      if (i.gesture === 'press') {
        d.pressAt = t;
        reading(d, 'hil.edge', 'boot', t, { level: false });
        if (pressed === d) {
          sample(d, 1);
        }
        if (pressed) {
          bootEvent(pressed, 'down', t);
        }
        return result([], t);
      }
      if (i.gesture === 'release') {
        if (d.pressAt === undefined) {
          return result([], t);
        }
        const from = d.pressAt;
        d.pressAt = undefined;
        reading(d, 'hil.edge', 'boot', t, { level: true });
        if (pressed) {
          emit(pressed, [(t - from) >>> 0], from, true);
        }
        return result([], t);
      }
      const segments = segmentsFor(i.gesture, cfgOf(d));
      let at = t;
      segments.forEach((s, k) => {
        reading(d, 'hil.edge', 'boot', at, { level: k % 2 === 1 });
        at += s;
      });
      reading(d, 'hil.edge', 'boot', at, { level: true });
      if (i.gesture !== 'bounce' && pressed === d) {
        sample(d, Math.ceil(segments.length / 2));
      }
      if (pressed) {
        emit(pressed, segments, t);
      }
      // D8: the op returns once the gesture is over.
      await sleep(segments.reduce((a, b) => a + b, 0) / 1000);
      return result(segments, t);
    },
    command_send: (i) => {
      const d = byAlias(i.selector);
      if (!d) {
        return fail('NOT_FOUND', `no device ${i.selector}`);
      }
      const cursor = cur();
      const [inst, cmd] = String(i.command).split('.');
      const answer = (status: string) => ok({ results: [{ device: d.device, alias: d.alias, status, rtt_ms: 4.2, link: 'tcp', t_hub_us: Date.now() * 1000 }] }, cursor);
      // The node's answer to a status command: expired (nothing ran), or none (timeout) after it ran or with nothing run.
      let late: string | undefined;
      if (inst === 'status') {
        const n = (d.statusCmds = (d.statusCmds ?? 0) + 1) - 1;
        if (d.expireCmds?.includes(n)) {
          return answer('expired');
        }
        if (d.lostCmds?.includes(n)) {
          return answer('timeout');
        }
        late = d.timeoutRan?.includes(n) ? 'timeout' : undefined;
      }
      const res = (status = late ?? (i.ack === 'none' ? 'sent' : 'ok')) => answer(status);
      if (inst === 'node') {
        if (cmd === 'reboot') {
          // LedService and led_ws2812 start dark: the boot refresh.
          const was = d.led.on;
          d.led = { ...d.led, on: false };
          ledWrite(d, d.led, fixNow(), was);
        }
        return res();
      }
      if (cmd === 'set') {
        if (d.ignoreOff && i.args?.on === false) {
          return res();
        }
        setLed(d, { on: i.args?.on === true, ...(typeof i.args?.color === 'number' && d.decode === 'ws2812' ? { color: i.args.color } : {}), ...(typeof i.args?.brightness === 'number' && d.decode === 'ws2812' ? { brightness: i.args.brightness } : {}) });
        return res();
      }
      if (cmd === 'toggle') {
        setLed(d, { on: !d.led.on });
        if (i.duplicate) {
          d.stats.dup++;
          d.stats.cached_replies++;
        }
        return res();
      }
      if (cmd === 'blink') {
        const b = { count: 3, on_ms: 200, off_ms: 200, ...(i.args ?? {}) };
        const t = fixNow();
        const steady = { ...d.led };
        for (let k = 0; k < b.count; k++) {
          const on = t + k * (b.on_ms + b.off_ms) * 1000;
          ledWrite(d, { ...steady, on: true }, on, false);
          ledWrite(d, { ...steady, on: false }, on + b.on_ms * 1000 + 300, true);
        }
        const end = t + b.count * (b.on_ms + b.off_ms) * 1000 + 300;
        ledWrite(d, steady, end, false);
        // effect_done reaches the hub when the blink is over, as the node sends it then.
        const n = (d.donePubs = (d.donePubs ?? 0) + 1) - 1;
        if (d.dropDone?.at.includes(n)) {
          if (d.dropDone.counted) {
            d.stats.delivery_failed++;
          }
        } else {
          setTimeout(() => publish(d, 'status.effect_done', { effect: 'blink' }, { part: 'event', member: 'effect_done', t_dev_us: (end + d.offsetUs + 40) >>> 0 }), (end - t) / 1000);
        }
        return res();
      }
      return fail('INVALID_ARGS', `unknown command ${i.command}`);
    },
    events_read: (i) => {
      const after = Number(/\.(\d+)$/.exec(i.since ?? 'c:7.0')![1]);
      const globs = i.types ? String(i.types).split(',') : null;
      const aliases = i.selector ? String(i.selector).split(',') : null;
      const found = events.filter((e) => e.seq > after && (!globs || globs.some((g) => matchType(g, e.type))) && (!aliases || aliases.includes(e.alias ?? '')));
      const page = found.slice(0, Math.min(500, i.max_events ?? 1000));
      return ok({ events: page, next_cursor: page.length ? page[page.length - 1].cursor : i.since, truncated: found.length > page.length });
    },
    wait_for_event: async (i) => {
      const after = Number(/\.(\d+)$/.exec(i.since ?? 'c:7.0')![1]);
      const globs = String(i.types).split(',');
      const want = Number(i.count ?? 1);
      const end = Date.now() + Number(i.timeout_s ?? 5) * 1000;
      for (;;) {
        const got = events.filter((e) => e.seq > after && globs.some((g) => matchType(g, e.type)) && (!i.selector || e.alias === i.selector) && Object.entries(i.where ?? {}).every(([k, v]) => e.fields?.[k] === v));
        if (got.length >= want) {
          return ok({ events: got.slice(0, want), cursor: cur() });
        }
        if (Date.now() > end) {
          return { ok: false, cursor: cur(), error: { code: 'TIMEOUT', message: 'no events', retryable: true, details: { events: got } } };
        }
        await sleep(10);
      }
    },
    wait_for_device: (i) => (byAlias(i.selector)?.noComeBack ? fail('TIMEOUT', `${i.selector} not online within ${i.timeout_s} s`, true) : ok({ devices: [] })),
    binding_list: (i) => ok({ bindings: (byAlias(i.selector)?.bindings ?? []).map((b) => ({ ...b })) }),
    binding_clear: (i) => {
      const d = byAlias(i.device)!;
      d.bindings = d.bindings.filter((b) => b.slot !== i.slot);
      return ok({});
    },
    binding_set: (i) => {
      const d = byAlias(String(i.from).split('.')[0])!;
      let slot = 0;
      while (d.bindings.some((b) => b.slot === slot)) {
        slot++;
      }
      d.bindings.push({ slot, from: i.from, to: i.to, args: i.args ?? null });
      d.bindings.sort((a, b) => a.slot - b.slot);
      return ok({ slot });
    },
  };
  const hub = await fakeHub(on);
  return { hub, duts, events, publish };
}

/** T-HIL's procedure, shortened for loopback: two rounds, short LED and pulse phases. */
const FAST: THilOptions = {
  ...T_HIL,
  rounds: 1,
  fitClicks: 5,
  fitGapMs: 20,
  fitPulses: 2,
  holdMs: 700,
  settleMs: 40,
  ledSets: 4,
  ledToggles: 4,
  blinks: 2,
  blink: { count: 3, on_ms: 30, off_ms: 30 },
  ledGapMs: 20,
  keepFitMs: 400,
  pulses: 4,
  pulseGapMs: 10,
  rebootWaitS: 5,
  retryPauseMs: 20,
  ranWaitMs: 300,
  wiringWaitMs: 1000,
  wiringLedMs: 40,
};

const calls = (h: FakeHub, op: string, alias?: string) => h.calls.filter((c) => c.op === op && (!alias || c.input.selector === alias || c.input.device === alias || c.input.port === alias));

describe('tests/e2e/t-hil.ts', () => {
  it('parseArgs: --devices, --phase, --rounds, --any-fixture-fw; anything else throws', () => {
    expect(hilArgs([])).toEqual(T_HIL);
    // The wiring check runs first by default, and alone with --phase wiring.
    expect(T_HIL).toMatchObject({ devices: ['pad-c3', 'pad-c3b', 'pad-c6', 'pad-s3'], phases: ['wiring', 'fit', 'buttons', 'leds', 'test_pin'], rounds: 10, anyFixtureFw: false });
    expect(hilArgs(['--devices', 'pad-c6,pad-s3', '--phase', 'fit,buttons', '--rounds', '3', '--any-fixture-fw'])).toMatchObject({ devices: ['pad-c6', 'pad-s3'], phases: ['fit', 'buttons'], rounds: 3, anyFixtureFw: true });
    expect(hilArgs(['--phase', 'all']).phases).toEqual(['wiring', 'fit', 'buttons', 'leds', 'test_pin']);
    expect(hilArgs(['--phase', 'wiring']).phases).toEqual(['wiring']);
    expect(() => hilArgs(['--phase', 'leds,boom'])).toThrow('--phase takes wiring|fit|buttons|leds|test_pin');
    expect(() => hilArgs(['--rounds', '0'])).toThrow('--rounds takes a number ≥ 1');
    expect(() => hilArgs(['--allow-erase'])).toThrow('unknown option --allow-erase');
    expect(tHil).toMatchObject({ gate: 'T-HIL', tier: 'hil', needs: { fixture: true } });
  });

  it('passes the four DUTs on a scripted bench: every phase, pad-c3’s accounted RF loss a warning, no prompt, the bench put back', async () => {
    const duts = defaultDuts();
    // pad-c3 (rf_weak) loses one boot event in the buttons phase (its 21st: 3 from the wiring check's click,
    // 15 from the fit's 5 clicks), counted in events_dropped.
    duts[0].drop = { at: [20], counted: true };
    const b = await scriptedBench(duts);
    const { ctx, logs, measured } = ctxOn(b.hub.url);
    const out = await runTHil(ctx, FAST);
    const m = out.measured as Record<string, any>;
    expect(out.pass, JSON.stringify({ duts: m.duts, cleanup: m.cleanup, fit: m.fit, b: m.buttons, l: m.leds, t: m.test_pin }, null, 1)).toBe(true);
    expect(m.duts).toEqual({ 'pad-c3': true, 'pad-c3b': true, 'pad-c6': true, 'pad-s3': true });
    expect(m.full_gate).toBe(true);
    expect(m.prompts_human).toBe(0);
    // Phase 0b: every line on its own DUT, nothing elsewhere.
    expect(m.wiring_check).toMatchObject({ pass: true, swapped: [], moves: [], problems: [], edit: null });
    expect(Object.values(m.wiring).map((w: any) => w.pass)).toEqual([true, true, true, true]);
    expect(m.delivery['pad-c6']).toEqual({ sent: expect.any(Number), expired: 0, timed_out: 0, retried: 0 });
    // Phase 0: the fixture, each DUT's config, its RSSI (pad-c3 warned).
    expect(m.preflight.fixture).toMatchObject({ alias: 'fix-s3', fw_ok: true, test_pin: -1, clock: { uncertainty_us: 180 } });
    expect(m.preflight.duts['pad-c3']).toMatchObject({ rf_weak: true, debug: true, rssi_dbm: -80, rssi_warning: expect.stringContaining('below -70') });
    expect(m.preflight.duts['pad-c6'].led).toMatchObject({ decode: 'ws2812', max_brightness: 64, driver: 'led_ws2812' });
    // Phase 1.
    expect(m.fit['pad-c6']).toMatchObject({ pass: true, valid: true, residual_p99_us: 140, isr_latency_us: 38, wired_minus_hub_us: { n: 5 } });
    expect(m.fit['pad-s3']).toMatchObject({ pass: true, isr_latency_us: null }); // a release build: no pin_pulse
    // Phase 2: every gesture as expected, down 40 µs after its edge (pad-s3's DUT clock wraps meanwhile).
    for (const a of ['pad-c3b', 'pad-c6', 'pad-s3']) {
      expect(m.buttons[a], a).toMatchObject({ pass: true, trials: 5, ok: 5, missing: 0, extra: 0, unattributed: 0, down_latency_us: { p50: 40, max: 40 }, loss: { verdict: 'pass' } });
      expect(m.buttons[a].by_gesture, a).toEqual({ click: { n: 1, ok: 1, missing: 0, extra: 0 }, double_click: { n: 1, ok: 1, missing: 0, extra: 0 }, long_press: { n: 1, ok: 1, missing: 0, extra: 0 }, press: { n: 1, ok: 1, missing: 0, extra: 0 }, bounce: { n: 1, ok: 1, missing: 0, extra: 0 } });
    }
    expect(m.buttons['pad-c3']).toMatchObject({ pass: true, missing: 1, loss: { verdict: 'warn', accounted: 1, unaccounted: 0, rf_weak: true } });
    expect(m.warnings).toEqual([expect.stringMatching(/^buttons pad-c3: pad-c3: RF loss 5\.88 % \(1 of 17 events\) above 1 % \(rf_weak: a warning\)$/)]);
    expect(logs.some((l) => l.startsWith('warning: buttons pad-c3'))).toBe(true);
    // Phase 3: the WS2812 frames at the clamped brightness, the C3 taps active low, the blinks.
    expect(m.leds['pad-c6']).toMatchObject({ pass: true, decode: 'ws2812', unexplained: [], missing_changes: [], wrong_value: [], state_lost: 0, blink: { n: 2, pass: true } });
    expect(m.leds['pad-c6'].resends).toBeGreaterThan(0); // the blink's restore frames, identical, ignored
    expect(m.leds['pad-c3b']).toMatchObject({ pass: true, decode: 'level', blink: { n: 2, pass: true } });
    // Phase 4: the debug DUTs only, each on its own line.
    expect(Object.keys(m.test_pin).sort()).toEqual(['pad-c3', 'pad-c3b', 'pad-c6']);
    expect(m.test_pin['pad-c6']).toMatchObject({ pass: true, pulses: 4, width_us: { p90: 1025 }, lows_across_reboot: 0 });
    // Phase 5: every line released, pad-c6's boot binding parked and back in its slot, every LED as before.
    expect(m.cleanup).toMatchObject({ ok: true, released: { 'pad-c3': 'ok', 'pad-c3b': 'ok', 'pad-c6': 'ok', 'pad-s3': 'ok' }, lines_not_idle: [] });
    expect(b.duts[2].bindings.map((x) => [x.slot, x.from])).toEqual([
      [0, 'pad-c6.msg:ping'],
      [1, 'pad-c6.boot.down'],
    ]);
    expect(calls(b.hub, 'binding_clear')).toEqual([expect.objectContaining({ input: { device: 'pad-c6', slot: 1 } })]);
    for (const d of b.duts) {
      expect(d.led.on, d.alias).toBe(false);
    }
    expect(b.duts[2].led.color).toBe(0xffffff);
    // Never a command to the fixture, never a person.
    expect(b.hub.calls.filter((c) => c.input.selector === 'fix-s3' || (c.op !== 'diag_exec' && c.input.port === FIX))).toEqual([]);
    expect(calls(b.hub, 'diag_exec').filter((c) => c.input.port === FIX).map((c) => c.input.line)).toEqual(['info']);
    expect(b.hub.calls.some((c) => c.input.prompt_human)).toBe(false);
    expect(Object.keys(measured)).toEqual(expect.arrayContaining(['preflight', 'wiring.pad-c3', 'wiring_check', 'fit.pad-c3', 'buttons.pad-s3', 'leds.pad-c6', 'test_pin.pad-c6', 'cleanup']));
    console.log(`[measured] T-HIL on a scripted bench: ${m.summary}; pad-c3 ${JSON.stringify(m.buttons['pad-c3'].loss)}`);
  }, 60_000);

  it('skips a DUT on another profile (pad-c6 after T-AGENT (c)); fails an unaccounted loss, a lost frame colour order, and a test_pin low', async () => {
    const duts = defaultDuts();
    duts[2].running = 'c6-pad-mono';
    duts[1].drop = { at: [17], counted: false }; // pad-c3b: lost, and its counters do not show it
    duts[3].rgbOrder = true; // pad-s3: frames in RGB order
    const b = await scriptedBench(duts);
    const { ctx } = ctxOn(b.hub.url);
    const out = await runTHil(ctx, { ...FAST, phases: ['fit', 'buttons', 'leds'] });
    const m = out.measured as Record<string, any>;
    expect(out.pass).toBe(false);
    expect(m.preflight.skipped).toEqual({ 'pad-c6': 'runs c6-pad-mono, not its bench profile c6-pad (after T-AGENT (c): flash it back to c6-pad)' });
    expect(m.full_gate).toBe(false);
    expect(m.duts).toEqual({ 'pad-c3': true, 'pad-c3b': false, 'pad-s3': false });
    expect(m.buttons['pad-c3b']).toMatchObject({ pass: false, missing: 1, loss: { verdict: 'fail', unaccounted: 1 } });
    expect(m.leds['pad-s3'].wrong_value.length).toBeGreaterThan(0);
    // pad-c6 was never pressed, nor its bindings touched.
    expect(calls(b.hub, 'input_simulate', 'pad-c6')).toEqual([]);
    expect(calls(b.hub, 'binding_list', 'pad-c6')).toEqual([]);
    expect(m.cleanup.ok).toBe(true);

    const low = defaultDuts();
    low[3].testPinLow = true;
    const b2 = await scriptedBench(low);
    const two = ctxOn(b2.hub.url);
    const out2 = await runTHil(two.ctx, { ...FAST, phases: ['fit'] });
    expect(out2.pass).toBe(false);
    expect((out2.measured as Record<string, any>).preflight.failed).toEqual({ 'pad-s3': 'pad-s3 test_pin: fix-s3 ch11 reads low: pad-s3 is unpowered or stuck' });
    expect((out2.measured as Record<string, any>).duts).toEqual({ 'pad-c3': true, 'pad-c3b': true, 'pad-c6': true });
  }, 60_000);

  it('fails fast before any press on an unpinned fixture build or a BOOT line low at idle; --any-fixture-fw runs it', async () => {
    const b = await scriptedBench(defaultDuts(), { fwOk: false });
    const { ctx, logs } = ctxOn(b.hub.url);
    const out = await runTHil(ctx, FAST);
    expect(out.pass).toBe(false);
    expect((out.measured as Record<string, any>).preflight.fatal).toEqual(["fix-s3 runs ffff0000ffff0000, not the bench's pinned a1b2c3d4e5f60718: flash the pinned s3k-fixture build, or run with --any-fixture-fw"]);
    expect(logs.some((l) => l.startsWith('preflight: fix-s3 runs ffff0000ffff0000'))).toBe(true);
    expect(calls(b.hub, 'input_simulate')).toEqual([]);
    expect(calls(b.hub, 'binding_clear')).toEqual([]);
    const any = ctxOn(b.hub.url);
    expect((await runTHil(any.ctx, { ...FAST, phases: ['fit'], anyFixtureFw: true })).pass).toBe(true);

    const duts = defaultDuts();
    duts[1].bootLow = true;
    const b2 = await scriptedBench(duts);
    const low = ctxOn(b2.hub.url);
    const out2 = await runTHil(low.ctx, FAST);
    expect((out2.measured as Record<string, any>).preflight.fatal).toEqual(['pad-c3b boot: fix-s3 ch1 reads low at idle']);
    expect(calls(b2.hub, 'input_simulate')).toEqual([]);
  }, 60_000);

  it('--phase buttons alone warms a stale fit with 4 clicks first, outside the verdict', async () => {
    const b = await scriptedBench();
    const { ctx } = ctxOn(b.hub.url);
    const out = await runTHil(ctx, { ...FAST, phases: ['buttons'], devices: ['pad-c6', 'pad-s3'] });
    const m = out.measured as Record<string, any>;
    expect(out.pass, JSON.stringify(m.buttons)).toBe(true);
    expect(m.fit_warmed).toEqual(['pad-c6', 'pad-s3']);
    expect(m.buttons['pad-c6']).toMatchObject({ trials: 5, ok: 5, missing: 0 });
    // 4 warm-up clicks, then the round's click among the five gestures.
    expect(calls(b.hub, 'input_simulate', 'pad-c6').filter((c) => c.input.gesture === 'click')).toHaveLength(5);
  }, 60_000);

  it('a cancel mid-run stops every DUT and still releases every line, puts the LEDs and bindings back, within the 10 s grace', async () => {
    const b = await scriptedBench();
    const ac = new AbortController();
    const { ctx, measured } = ctxOn(b.hub.url, [], ac.signal);
    const run = runTHil(ctx, { ...FAST, phases: ['fit', 'buttons', 'leds'], rounds: 5 });
    // Cancelled once the buttons phase runs (pad-c6's binding is parked by then).
    while (!calls(b.hub, 'input_simulate').some((c) => c.input.gesture === 'double_click')) {
      await sleep(5);
    }
    const t0 = Date.now();
    ac.abort(new Error('cancelled (SIGTERM)'));
    await expect(run).rejects.toThrow('cancelled (SIGTERM)');
    expect(Date.now() - t0).toBeLessThan(CANCEL_GRACE_MS);
    expect(CANCEL_GRACE_MS).toBe(10_000);
    const releases = new Set(b.hub.calls.filter((c) => c.op === 'input_simulate' && c.input.gesture === 'release' && c.at >= t0).map((c) => c.input.selector));
    expect([...releases].sort()).toEqual(['pad-c3', 'pad-c3b', 'pad-c6', 'pad-s3']);
    expect(b.duts[2].bindings.map((x) => x.from)).toEqual(['pad-c6.msg:ping', 'pad-c6.boot.down']);
    expect(measured.cleanup).toMatchObject({ ok: true, leds_not_restored: [], bindings_not_restored: [] });
    // No LED was touched before the cancel, so none was set back.
    expect(calls(b.hub, 'command_send').filter((c) => c.input.command === 'status.set')).toEqual([]);
  }, 60_000);

  it('the gate run (no --devices, no --phase) fails with a DUT skipped on another profile; the same DUTs named with --devices are a partial pass', async () => {
    expect(isGateRun(T_HIL)).toBe(true);
    expect(isGateRun({ ...T_HIL, devices: ['pad-c3', 'pad-c3b', 'pad-s3'] })).toBe(false);
    expect(isGateRun({ ...T_HIL, phases: ['fit', 'buttons', 'leds'] })).toBe(false);
    const duts = defaultDuts();
    duts[2].running = 'c6-pad-mono'; // pad-c6 after T-AGENT (c), as D14 expects
    const b = await scriptedBench(duts);
    const { ctx, logs } = ctxOn(b.hub.url);
    const out = await runTHil(ctx, FAST);
    const m = out.measured as Record<string, any>;
    // Before: pass (gate status pass, "PASS: 1 passed"), with full_gate false only in measured.
    expect(out.pass).toBe(false);
    expect(m.duts).toEqual({ 'pad-c3': true, 'pad-c3b': true, 'pad-s3': true });
    expect(m).toMatchObject({ gate_run: true, full_gate: false });
    expect(m.gate_problem).toBe(
      'the gate needs all four bench DUTs on their bench profiles (skipped pad-c6: runs c6-pad-mono, not its bench profile c6-pad (after T-AGENT (c): flash it back to c6-pad)); narrow the run with --devices for a partial one',
    );
    expect(m.summary).toBe('3/3 DUTs pass, skipped pad-c6: not the full gate (all four DUTs needed)');
    expect(logs).toContain(m.gate_problem);
    const partial = ctxOn(b.hub.url);
    const out2 = await runTHil(partial.ctx, { ...FAST, devices: ['pad-c3', 'pad-c3b', 'pad-s3'] });
    expect(out2.pass, JSON.stringify((out2.measured as Record<string, any>).gate_problem)).toBe(true);
    expect(out2.measured).toMatchObject({ gate_run: false, full_gate: false, summary: expect.stringMatching(/: a partial run, not the full gate$/) });
  }, 120_000);

  it('refuses a bench that pins no fixture fw_id before any press (bench_get fw_ok false, fw_pinned false), in one sentence, unless --any-fixture-fw', async () => {
    const b = await scriptedBench(defaultDuts(), { pinned: null });
    const { ctx } = ctxOn(b.hub.url);
    const out = await runTHil(ctx, { ...FAST, phases: ['fit'] });
    expect(out.pass).toBe(false);
    expect((out.measured as Record<string, any>).preflight.fixture).toMatchObject({ fw_ok: false, pinned: null });
    expect((out.measured as Record<string, any>).preflight.fatal).toEqual([
      'the bench lab pins no fixture fw_id (fix-s3 runs a1b2c3d4e5f60718): pin fixture.fw_id in hardware/bench/lab.bench.yaml (§5.3 step 2), or run with --any-fixture-fw',
    ]);
    expect(calls(b.hub, 'input_simulate')).toEqual([]);
    const any = ctxOn(b.hub.url);
    expect((await runTHil(any.ctx, { ...FAST, phases: ['fit'], anyFixtureFw: true })).pass).toBe(true);
  }, 60_000);

  it('warms a fit that went stale while the slowest DUT finished phase 1 (outside the verdict); a fit that never becomes valid fails the phase, bounded', async () => {
    const opts: THilOptions = { ...FAST, devices: ['pad-c3', 'pad-s3'], phases: ['fit', 'buttons'], fitFreshMs: 1000 };
    const stale = () => {
      const duts = defaultDuts();
      for (const d of duts) {
        d.fitMaxAgeMs = 2000; // the hub's 10 s, scaled to the loopback run
      }
      duts[0].pulseDelayMs = 1300; // pad-c3's pin_pulses crawl over its weak link; pad-s3 (release) has none
      return duts;
    };
    const b = await scriptedBench(stale());
    const { ctx, logs } = ctxOn(b.hub.url);
    const out = await runTHil(ctx, opts);
    const m = out.measured as Record<string, any>;
    expect(out.pass, JSON.stringify({ fit: m.fit, buttons: m.buttons })).toBe(true);
    // Before: pad-s3's first down went out on hub time ("down 1 untimed: no wired fit") and failed it.
    // pad-c3 pulses first and ends its phase on its clicks, so its own fit is fresh.
    expect(m.fit_warmed).toEqual(['pad-s3']);
    expect(m.fit['pad-c3']).toMatchObject({ pass: true, valid: true });
    expect(m.buttons['pad-s3']).toMatchObject({ pass: true, trials: 5, ok: 5, missing: 0, extra: 0, unattributed: 0 });
    expect(logs.some((l) => l.startsWith('warmed the fit outside the verdict: ') && l.includes('pad-s3'))).toBe(true);
    // A DUT whose presses never give the hub a sample: the warm-up gives up after warmClicks, and the phase fails.
    const never = defaultDuts();
    never[3].noSamples = true;
    const b2 = await scriptedBench(never);
    const two = ctxOn(b2.hub.url);
    const out2 = await runTHil(two.ctx, { ...FAST, devices: ['pad-s3'], phases: ['buttons'], warmClicks: 3 });
    expect(out2.pass).toBe(false);
    expect((out2.measured as Record<string, any>).buttons['pad-s3']).toEqual({ pass: false, rounds: 1, warmed: 3, problems: ['the wired fit is not valid after 3 warm-up click(s) (no accepted press sample)'] });
    expect(calls(b2.hub, 'input_simulate', 'pad-s3').filter((c) => c.input.gesture !== 'release')).toHaveLength(3);
  }, 120_000);

  it('phase 4: a pin_pulse that fails over the link, or a DUT that does not come back, fails that DUT, not the run', async () => {
    const duts = defaultDuts();
    duts[0].pulseFail = [1]; // pad-c3's second pulse: TIMEOUT
    duts[2].noComeBack = true; // pad-c6 not back within rebootWaitS
    const b = await scriptedBench(duts);
    const { ctx } = ctxOn(b.hub.url);
    // Before: the first failed call threw, allOrAbort stopped every DUT's phase 4, and T-HIL errored.
    const out = await runTHil(ctx, { ...FAST, devices: ['pad-c3', 'pad-c3b', 'pad-c6'], phases: ['test_pin'] });
    const m = out.measured as Record<string, any>;
    expect(out.pass).toBe(false);
    expect(m.test_pin['pad-c3']).toMatchObject({ pass: false, pulses: 3 });
    expect(m.test_pin['pad-c3'].problems).toEqual(['pin_pulse 2: TIMEOUT no RESULT from pad-c3 within 5 s (diag over its link)', '3 pulses seen, not 4']);
    expect(m.test_pin['pad-c6']).toMatchObject({ pass: false, pulses: 4 });
    expect(m.test_pin['pad-c6'].problems).toEqual(['pad-c6 did not come back online within 5 s of its node.reboot (TIMEOUT pad-c6 not online within 5 s)']);
    expect(m.test_pin['pad-c3b']).toMatchObject({ pass: true, pulses: 4 });
    expect(m.cleanup.ok).toBe(true);
  }, 60_000);

  it('phase 3 judges losses over the reports it expects: one lost effect_done (counted) or one lost STATE passes pad-c6; two lost STATEs fail it', async () => {
    const run = async (knobs: Partial<FakeDut>) => {
      const duts = defaultDuts();
      Object.assign(duts[2], knobs);
      const b = await scriptedBench(duts);
      const { ctx } = ctxOn(b.hub.url);
      const out = await runTHil(ctx, { ...FAST, devices: ['pad-c6'], phases: ['leds'] });
      return (out.measured as Record<string, any>).leds['pad-c6'];
    };
    // Before: either single loss over 13 commands was above 1 %, so a healthy pad-c6 failed.
    const done = await run({ dropDone: { at: [0], counted: true } });
    expect(done, JSON.stringify(done.problems)).toMatchObject({ pass: true, commands: 10, loss: { verdict: 'pass', missing: 1, accounted: 1, uncounted: 0 } });
    const one = await run({ dropStates: [7] }); // the second toggle's status.on STATE
    expect(one, JSON.stringify(one.problems)).toMatchObject({ pass: true, state_lost: 1, loss: { verdict: 'pass', missing: 0, uncounted: 1, accounted: 1 } });
    expect(one.reports).toBe(one.timed_states + one.resync.n + 1 + 2);
    const two = await run({ dropStates: [7, 9] });
    expect(two).toMatchObject({ pass: false, state_lost: 2, loss: { verdict: 'fail', uncounted: 2 } });
  }, 60_000);

  it('the restore checks each LED on the fixture: after --phase test_pin\'s reboot it is lit again; a status.set that changes nothing is not "restored"', async () => {
    const duts = defaultDuts();
    duts[2].led = { on: true, color: 0x20ff40, brightness: 64 }; // pad-c6 shows an app's status
    const b = await scriptedBench(duts);
    const { ctx } = ctxOn(b.hub.url);
    const out = await runTHil(ctx, { ...FAST, devices: ['pad-c6'], phases: ['test_pin'] });
    const m = out.measured as Record<string, any>;
    // Before: the reboot left it dark, and cleanup said ok with leds_not_restored [].
    expect(out.pass, JSON.stringify(m.cleanup)).toBe(true);
    expect(b.duts[2].led).toEqual({ on: true, color: 0x20ff40, brightness: 64 });
    expect(calls(b.hub, 'command_send', 'pad-c6').filter((c) => c.input.command === 'status.set').map((c) => c.input.args)).toEqual([{ on: true, color: 0x20ff40, brightness: 64 }]);
    // A DUT that answers status.set {on: false} ok and stays lit: phase 3 fails it, and so does the restore.
    const ign = defaultDuts();
    ign[2].ignoreOff = true;
    const b2 = await scriptedBench(ign);
    const two = ctxOn(b2.hub.url);
    const out2 = await runTHil(two.ctx, { ...FAST, devices: ['pad-c6'], phases: ['leds'] });
    const m2 = out2.measured as Record<string, any>;
    expect(out2.pass).toBe(false);
    expect(m2.leds['pad-c6'].not_applied.length).toBeGreaterThan(0);
    expect(m2.cleanup).toMatchObject({ ok: false, leds_not_restored: ['pad-c6'] });
    expect(two.logs.some((l) => l.includes('status.set answered ok, but the fixture reads it lit'))).toBe(true);
  }, 60_000);

  // ---- DUT commands that expired (the second bench run: a ~1 s Wi-Fi gap expired every DUT's first set) ----

  /** T-HIL on a scripted bench whose DUTs get `knobs`, by alias (phase 3 alone unless `opts` says otherwise). */
  const knobbed = async (knobs: Record<string, Partial<FakeDut>>, opts: Partial<THilOptions> = {}) => {
    const duts = defaultDuts();
    for (const d of duts) {
      Object.assign(d, knobs[d.alias] ?? {});
    }
    const b = await scriptedBench(duts);
    const { ctx, logs } = ctxOn(b.hub.url);
    const out = await runTHil(ctx, { ...FAST, phases: ['leds'], ...opts });
    return { b, out, logs, m: out.measured as Record<string, any> };
  };
  const sent = (h: FakeHub, alias: string, command: string) => calls(h, 'command_send', alias).filter((c) => c.input.command === command);

  it('an expired first status.set (it never ran) is re-sent once and judged from the re-send: pass, counted in the loss figure; two fail a normal DUT and warn on rf_weak', async () => {
    // Before: "status.set: expired" and "1 command(s) the fixture shows had no effect by the next command" on all four.
    const all = await knobbed({ 'pad-c3': { expireCmds: [0] }, 'pad-c3b': { expireCmds: [0] }, 'pad-c6': { expireCmds: [0] }, 'pad-s3': { expireCmds: [0] } });
    expect(all.out.pass, JSON.stringify(Object.fromEntries(Object.entries(all.m.leds).map(([a, v]: [string, any]) => [a, v.problems])))).toBe(true);
    for (const a of ['pad-c3', 'pad-c3b', 'pad-c6', 'pad-s3']) {
      expect(all.m.leds[a], a).toMatchObject({ pass: true, commands: 10, not_applied: [], delivery: { sent: 10, expired: 1, timed_out: 0, retried: 1 }, loss: { verdict: 'pass', commands_sent: 10, commands_lost: 1, accounted: 1 } });
      // The same set again, after the pause; the run's tally has the restore's set too.
      const sets = sent(all.b.hub, a, 'status.set');
      expect(sets[1].input.args, a).toEqual(sets[0].input.args);
      expect(sets[1].at - sets[0].at, a).toBeGreaterThanOrEqual(FAST.retryPauseMs);
      expect(all.m.delivery[a], a).toEqual({ sent: 11, expired: 1, timed_out: 0, retried: 1 });
    }
    expect(all.logs).toContain('DUT command sends lost or late (expired ones re-sent once): pad-c3 1 expired, 0 unanswered, 1 re-sent, of 11; pad-c3b 1 expired, 0 unanswered, 1 re-sent, of 11; pad-c6 1 expired, 0 unanswered, 1 re-sent, of 11; pad-s3 1 expired, 0 unanswered, 1 re-sent, of 11');
    // Two expired sends (the first and the third set's; send 1 is the first one's re-send): above the one loss
    // the phase tolerates and above 1 %: pad-c3b fails on the figure alone, pad-c3 (rf_weak) warns.
    const two = await knobbed({ 'pad-c3': { expireCmds: [0, 3] }, 'pad-c3b': { expireCmds: [0, 3] } }, { devices: ['pad-c3', 'pad-c3b'] });
    expect(two.m.leds['pad-c3b']).toMatchObject({ pass: false, not_applied: [], unexplained: [], delivery: { expired: 2, retried: 2 }, loss: { verdict: 'fail', commands_lost: 2 } });
    expect(two.m.leds['pad-c3b'].problems).toEqual([expect.stringMatching(/^pad-c3b: RF loss [\d.]+ % \(2 of \d+ events and commands, 2 of them sends of a DUT command that expired or went unanswered \(of 10 commands\)\) above 1 %$/)]);
    expect(two.m.leds['pad-c3']).toMatchObject({ pass: true, loss: { verdict: 'warn' }, warning: expect.stringContaining('(rf_weak: a warning)') });
    // pin_pulse over the link (TIMEOUT, details.status expired) and the test_pin phase: re-sent, 4 pulses seen.
    const tp = await knobbed({ 'pad-c3b': { pulseExpire: [0] } }, { devices: ['pad-c3b'], phases: ['test_pin'] });
    expect(tp.m.test_pin['pad-c3b']).toMatchObject({ pass: true, pulses: 4, delivery: { sent: 5, expired: 1, retried: 1 }, loss: { verdict: 'pass' } });
  }, 60_000);

  it('a status.set that expires again when re-sent fails the command as before, re-sent only once', async () => {
    const r = await knobbed({ 'pad-c6': { expireCmds: [0, 1] } }, { devices: ['pad-c6'] });
    expect(r.out.pass).toBe(false);
    expect(r.m.leds['pad-c6']).toMatchObject({ pass: false, delivery: { sent: 10, expired: 2, retried: 1 } });
    expect(r.m.leds['pad-c6'].problems[0]).toBe('status.set: expired; re-sent once: expired again');
    // The phase's 4 sets, the one re-send, the restore's set.
    expect(sent(r.b.hub, 'pad-c6', 'status.set')).toHaveLength(FAST.ledSets + 1 + 1);
  }, 60_000);

  it('a toggle that went unanswered but ran (the fixture shows it) is not re-sent: no double toggle, pass; one that did not run is re-sent once', async () => {
    // Send 4 is the first toggle (after the 4 sets): it runs, its RESULT is lost.
    const ran = await knobbed({ 'pad-c3b': { timeoutRan: [4] }, 'pad-c6': { timeoutRan: [4] } }, { devices: ['pad-c3b', 'pad-c6'] });
    expect(ran.out.pass, JSON.stringify([ran.m.leds['pad-c3b'].problems, ran.m.leds['pad-c6'].problems])).toBe(true);
    for (const a of ['pad-c3b', 'pad-c6']) {
      expect(ran.m.leds[a], a).toMatchObject({ pass: true, not_applied: [], unexplained: [], delivery: { sent: 10, expired: 0, timed_out: 1, retried: 0 }, loss: { verdict: 'pass', commands_lost: 1 } });
      expect(sent(ran.b.hub, a, 'status.toggle'), a).toHaveLength(FAST.ledToggles);
    }
    // The same toggle lost on the way (no answer, nothing ran): the fixture shows no change, so it goes again.
    const lost = await knobbed({ 'pad-c6': { lostCmds: [4] } }, { devices: ['pad-c6'] });
    expect(lost.out.pass, JSON.stringify(lost.m.leds['pad-c6'].problems)).toBe(true);
    expect(lost.m.leds['pad-c6']).toMatchObject({ pass: true, not_applied: [], delivery: { timed_out: 1, retried: 1 } });
    expect(sent(lost.b.hub, 'pad-c6', 'status.toggle')).toHaveLength(FAST.ledToggles + 1);
  }, 60_000);

  // ---- the wiring check (phase 0b) ----

  /** Who a probe call went to: its selector, or the DUT whose device id a diag_exec port names. */
  const probeOf = (c: FakeHub['calls'][number]) => c.input.selector ?? Object.entries(DUT_IDS).find(([, id]) => id === c.input.port)?.[0];
  const isProbe = (c: FakeHub['calls'][number]) =>
    (c.op === 'input_simulate' && c.input.gesture === 'click') || (c.op === 'command_send' && c.input.command === 'status.set') || (c.op === 'diag_exec' && /^pin_pulse/.test(String(c.input.line)));

  it('--phase wiring on a bench wired as its file says: every line on its own DUT, one DUT after another', async () => {
    const b = await scriptedBench();
    const { ctx } = ctxOn(b.hub.url);
    const out = await runTHil(ctx, { ...FAST, phases: ['wiring'] });
    const m = out.measured as Record<string, any>;
    expect(out.pass, JSON.stringify(m.wiring_check)).toBe(true);
    expect(m.wiring_check).toMatchObject({ pass: true, swapped: [], moves: [], problems: [], edit: null });
    expect(m.wiring['pad-c3'].lines).toEqual({
      boot: { ok: true, channel: 'ch0', reached: ['pad-c3'], seen: { 'pad-c3': ['boot.down', 'boot.up', 'boot.click'] } },
      status: { ok: true, channel: 'ch4', reached: ['pad-c3'], seen: { 'pad-c3': ['lit', 'dark'] } },
      test_pin: { ok: true, channel: 'ch8', reached: ['pad-c3'], seen: { 'pad-c3': ['low', 'high'] } },
    });
    expect(m.wiring['pad-c6'].lines.status).toMatchObject({ ok: true, channel: 'ch6', seen: { 'pad-c6': ['lit', 'dark'] } });
    expect(Object.keys(m.wiring['pad-s3'].lines)).toEqual(['boot', 'status']); // a release build: no pin_pulse
    expect(m).toMatchObject({ duts: { 'pad-c3': true, 'pad-c3b': true, 'pad-c6': true, 'pad-s3': true }, gate_run: false, cleanup: { ok: true } });
    // One DUT after another, one line at a time: click, set on, set off, pin_pulse.
    const order = b.hub.calls.filter(isProbe).map(probeOf);
    expect(order.slice(0, 15)).toEqual(['pad-c3', 'pad-c3', 'pad-c3', 'pad-c3', 'pad-c3b', 'pad-c3b', 'pad-c3b', 'pad-c3b', 'pad-c6', 'pad-c6', 'pad-c6', 'pad-c6', 'pad-s3', 'pad-s3', 'pad-s3']);
    expect(calls(b.hub, 'input_simulate').filter((c) => c.input.gesture !== 'release')).toHaveLength(4);
    // Every LED put back after the probe's on/off.
    expect(b.duts.map((d) => d.led.on)).toEqual([false, false, false, false]);
  }, 60_000);

  it('a wiring probe whose sends expired is re-sent and still judged on its line: the losses warn, never a wiring failure that stops the gate', async () => {
    // pad-c6's status.set on and off both expire (sends 0 and 2; 1 and 3 are their re-sends): 2 lost of its 3
    // commands (with the pin_pulse), which would fail a normal DUT's figure in phases 1-3; its lines are wired right.
    const duts = defaultDuts();
    duts[2].expireCmds = [0, 2];
    const b = await scriptedBench(duts);
    const { ctx, logs } = ctxOn(b.hub.url);
    const out = await runTHil(ctx, { ...FAST, phases: ['wiring'] });
    const m = out.measured as Record<string, any>;
    expect(out.pass, JSON.stringify(m.wiring_check)).toBe(true);
    expect(m.wiring_check).toMatchObject({ pass: true, swapped: [], moves: [], problems: [] });
    expect(m.stopped_after).toBeUndefined();
    expect(m.wiring['pad-c6']).toMatchObject({ pass: true, delivery: { sent: 3, expired: 2, timed_out: 0, retried: 2 }, loss: { verdict: 'fail', commands_lost: 2 }, problems: [] });
    expect(m.wiring['pad-c6'].lines.status).toMatchObject({ ok: true, reached: ['pad-c6'] });
    expect(m.wiring['pad-c6'].warning).toMatch(/^pad-c6: RF loss 66.67 % \(2 of 3 events and commands/);
    expect(logs.some((l) => l.startsWith('warning: wiring pad-c6: pad-c6: RF loss'))).toBe(true);
    expect(sent(b.hub, 'pad-c6', 'status.set').slice(0, 4).map((c) => c.input.args.on)).toEqual([true, true, false, false]);
  }, 60_000);

  it('--phase wiring narrowed by --devices parks the boot bindings of the other bench DUTs too (a miswired click may reach them), and puts them back', async () => {
    const b = await scriptedBench();
    const before = b.duts[2].bindings.map((x) => ({ ...x }));
    const { ctx } = ctxOn(b.hub.url);
    const out = await runTHil(ctx, { ...FAST, devices: ['pad-c3'], phases: ['wiring'] });
    const m = out.measured as Record<string, any>;
    expect(out.pass, JSON.stringify(m.wiring_check)).toBe(true);
    // pad-c6's pad-c6.boot.down -> pad-c3.status.blink was off while the probes ran, and is back as it was.
    expect(calls(b.hub, 'binding_clear')).toEqual([expect.objectContaining({ input: { device: 'pad-c6', slot: 1 } })]);
    expect(calls(b.hub, 'binding_set').map((c) => c.input.from)).toEqual(['pad-c6.boot.down']);
    expect(b.duts[2].bindings).toEqual(before);
    expect(calls(b.hub, 'binding_list').map((c) => c.input.selector)).toEqual(['pad-c3', 'pad-c3b', 'pad-c6', 'pad-s3']);
    expect(m.cleanup).toMatchObject({ ok: true, bindings_not_restored: [] });
    // Only pad-c3 was probed.
    expect(calls(b.hub, 'input_simulate').filter((c) => c.input.gesture !== 'release').map((c) => c.input.selector)).toEqual(['pad-c3']);
  }, 60_000);

  // The design's table (§2.3) for the two C3s, the bench file before the 2026-10-24 edit.
  const C3_BENCH = `schema: fractonica/bench@1
id: lab
fixture:
  device: e8f60a81bc48
  profile: s3k-fixture
  fw_id: null
duts:
  1cdbd4175cc4:                    # pad-c3: C3 OLED board #2 (8.5 dBm cap; -80 dBm at M1 step 7)
    profile: c3o-pad
    rf_weak: true
    lines:
      boot:     { role: button,   dut_gpio: 9,  channel: ch0,  fixture_gpio: 42, via: direct, series_ohm: 1000 }
      status:   { role: led,      dut_gpio: 8,  channel: ch4,  fixture_gpio: 4,  active_level: low, series_ohm: 10000 }
      test_pin: { role: test_pin, dut_gpio: 10, channel: ch8,  fixture_gpio: 15, series_ohm: 1000 }
      analog:   { role: analog,   dut_gpio: 3,  channel: ch12, fixture_gpio: 11, dut_profile: c3o-analog, rc: { r_ohm: 10000, c_nf: 1000 }, wired: false }   # M2-C3
  1cdbd416ba34:                    # pad-c3b: C3 OLED board #1
    profile: c3o-pad
    lines:
      boot:     { role: button,   dut_gpio: 9,  channel: ch1,  fixture_gpio: 41, via: direct, series_ohm: 1000 }
      status:   { role: led,      dut_gpio: 8,  channel: ch5,  fixture_gpio: 5,  active_level: low, series_ohm: 10000 }
      test_pin: { role: test_pin, dut_gpio: 10, channel: ch9,  fixture_gpio: 16, series_ohm: 1000 }
`;

  it('the bench as first wired (the C3 line sets on each other’s board): swapped: pad-c3 <-> pad-c3b, the exact bench-file edit, the gate stopped before the fit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fr-wiring-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, 'lab.bench.yaml');
    writeFileSync(file, C3_BENCH);
    // The file says pad-c3 ch0/ch4/ch8 and pad-c3b ch1/ch5/ch9; the wires go the other way round. pad-c3's LED
    // is on before the run, pad-c3b's off: each one's bench status channel reads the other's LED.
    const swappedDuts = defaultDuts();
    swappedDuts[0].led.on = true;
    const b = await scriptedBench(swappedDuts, { file, wires: { ch0: 'pad-c3b', ch4: 'pad-c3b', ch8: 'pad-c3b', ch1: 'pad-c3', ch5: 'pad-c3', ch9: 'pad-c3' } });
    const { ctx, logs } = ctxOn(b.hub.url);
    const out = await runTHil(ctx, FAST);
    const m = out.measured as Record<string, any>;
    expect(out.pass).toBe(false);
    expect(m.wiring_check.swapped).toEqual(['swapped: pad-c3 <-> pad-c3b (boot, status, test_pin)']);
    expect(m.wiring_check.problems).toEqual([
      "pad-c3 boot: a click on fix-s3 ch0 (pad-c3's bench boot line) pressed pad-c3b, not pad-c3 (boot.down, boot.up, boot.click from pad-c3b)",
      "pad-c3 status: status.set on pad-c3 showed on fix-s3 ch5 (pad-c3b's bench status line), not on ch4",
      "pad-c3 test_pin: pin_pulse on pad-c3 showed on fix-s3 ch9 (pad-c3b's bench test_pin line), not on ch8",
      "pad-c3b boot: a click on fix-s3 ch1 (pad-c3b's bench boot line) pressed pad-c3, not pad-c3b (boot.down, boot.up, boot.click from pad-c3)",
      "pad-c3b status: status.set on pad-c3b showed on fix-s3 ch4 (pad-c3's bench status line), not on ch5",
      "pad-c3b test_pin: pin_pulse on pad-c3b showed on fix-s3 ch8 (pad-c3's bench test_pin line), not on ch9",
    ]);
    // The edit that matches the wiring: what lab.bench.yaml was edited to by hand (as wired, 2026-10-24).
    expect(m.wiring_check.edit).toBe(
      [
        `to match the wiring found, edit ${file} (- as it reads, + as it would read):`,
        '   1cdbd4175cc4:   # pad-c3',
        '-      boot:     { role: button,   dut_gpio: 9,  channel: ch0,  fixture_gpio: 42, via: direct, series_ohm: 1000 }',
        '+      boot:     { role: button,   dut_gpio: 9,  channel: ch1,  fixture_gpio: 41, via: direct, series_ohm: 1000 }',
        '-      status:   { role: led,      dut_gpio: 8,  channel: ch4,  fixture_gpio: 4,  active_level: low, series_ohm: 10000 }',
        '+      status:   { role: led,      dut_gpio: 8,  channel: ch5,  fixture_gpio: 5,  active_level: low, series_ohm: 10000 }',
        '-      test_pin: { role: test_pin, dut_gpio: 10, channel: ch8,  fixture_gpio: 15, series_ohm: 1000 }',
        '+      test_pin: { role: test_pin, dut_gpio: 10, channel: ch9,  fixture_gpio: 16, series_ohm: 1000 }',
        '   1cdbd416ba34:   # pad-c3b',
        '-      boot:     { role: button,   dut_gpio: 9,  channel: ch1,  fixture_gpio: 41, via: direct, series_ohm: 1000 }',
        '+      boot:     { role: button,   dut_gpio: 9,  channel: ch0,  fixture_gpio: 42, via: direct, series_ohm: 1000 }',
        '-      status:   { role: led,      dut_gpio: 8,  channel: ch5,  fixture_gpio: 5,  active_level: low, series_ohm: 10000 }',
        '+      status:   { role: led,      dut_gpio: 8,  channel: ch4,  fixture_gpio: 4,  active_level: low, series_ohm: 10000 }',
        '-      test_pin: { role: test_pin, dut_gpio: 10, channel: ch9,  fixture_gpio: 16, series_ohm: 1000 }',
        '+      test_pin: { role: test_pin, dut_gpio: 10, channel: ch8,  fixture_gpio: 15, series_ohm: 1000 }',
      ].join('\n'),
    );
    expect(m.wiring_check.moves).toHaveLength(6);
    expect(logs).toContain(m.wiring_check.edit);
    expect(logs).toContain('wiring: swapped: pad-c3 <-> pad-c3b (boot, status, test_pin)');
    // pad-c6 and pad-s3 are wired right; the gate stopped before the fit (one click per DUT, nothing else), the restore ran.
    expect([m.wiring['pad-c3'].pass, m.wiring['pad-c3b'].pass, m.wiring['pad-c6'].pass, m.wiring['pad-s3'].pass]).toEqual([false, false, true, true]);
    expect(calls(b.hub, 'input_simulate').filter((c) => c.input.gesture !== 'release').map((c) => c.input.gesture)).toEqual(['click', 'click', 'click', 'click']);
    expect(m.fit).toBeUndefined();
    expect(m).toMatchObject({ stopped_after: 'wiring', duts: { 'pad-c3': false, 'pad-c3b': false, 'pad-c6': false, 'pad-s3': false }, cleanup: { ok: true }, full_gate: true });
    expect(m.stop_reason).toBe(`the wiring check failed (swapped: pad-c3 <-> pad-c3b (boot, status, test_pin)): no later phase ran; once the wiring or ${file} is right, run --phase wiring again`);
    expect(m.summary).toMatch(/; the wiring check failed, no later phase ran$/);
    // The restore set each LED back (pad-c3 on, pad-c3b off) and, the status channels being each other's, read
    // neither back there: before, pad-c3's check read pad-c3b's dark LED and failed the cleanup ("LED not restored").
    expect(b.duts.slice(0, 2).map((d) => d.led.on)).toEqual([true, false]);
    expect(m.cleanup.leds_not_restored).toEqual([]);
    expect(logs).toContain('pad-c3: its LED was set back (status.set ok), not read back on its bench status channel ch4: the wiring check found that channel not on its LED');
    expect(logs).toContain('pad-c3b: its LED was set back (status.set ok), not read back on its bench status channel ch5: the wiring check found that channel not on its LED');
    // The same bench with the edited file passes the check.
    const fixed = defaultDuts();
    fixed[0].channels = { boot: 'ch1', status: 'ch5', test_pin: 'ch9' };
    fixed[1].channels = { boot: 'ch0', status: 'ch4', test_pin: 'ch8' };
    const b2 = await scriptedBench(fixed, { wires: { ch0: 'pad-c3b', ch4: 'pad-c3b', ch8: 'pad-c3b', ch1: 'pad-c3', ch5: 'pad-c3', ch9: 'pad-c3' } });
    const out2 = await runTHil(ctxOn(b2.hub.url).ctx, { ...FAST, phases: ['wiring'] });
    expect(out2.pass, JSON.stringify((out2.measured as Record<string, any>).wiring_check.problems)).toBe(true);
  }, 60_000);

  it('a dead line answers nowhere: named with its channel and the wait, no swap, no edit', async () => {
    // pad-c6's BOOT wire and pad-s3's LED wire go nowhere.
    const b = await scriptedBench(defaultDuts(), { wires: { ch2: null, ch7: null } });
    const { ctx } = ctxOn(b.hub.url);
    const out = await runTHil(ctx, { ...FAST, phases: ['wiring'] });
    const m = out.measured as Record<string, any>;
    expect(out.pass).toBe(false);
    expect(m.wiring_check).toMatchObject({ pass: false, swapped: [], moves: [], edit: null });
    expect(m.wiring_check.problems).toEqual([
      `pad-c6 boot: a click on fix-s3 ch2 (pad-c6's bench boot line) reached no DUT: no boot event from any bench DUT within ${FAST.wiringWaitMs} ms`,
      `pad-s3 status: status.set on, then off, on pad-s3 showed on no fix-s3 channel: its bench status line ch7 read nothing within ${FAST.wiringWaitMs} ms`,
    ]);
    // The fixture did drive ch2 (its own readings), so the wire, not the fixture.
    expect(m.wiring['pad-c6'].lines.boot).toMatchObject({ ok: false, reached: [], seen: {} });
    expect(m.wiring['pad-c6'].lines.status).toMatchObject({ ok: true });
    expect(m).toMatchObject({ duts: { 'pad-c3': true, 'pad-c3b': true, 'pad-c6': false, 'pad-s3': false }, cleanup: { ok: true } });
  }, 60_000);

  it('diagnoseWiring and benchEdit: a short (one probe on two DUTs) and a one-sided miswire get no edit; a three-way rotation gets one', () => {
    const st = benchStatus(defaultDuts());
    const all: HilDut[] = st.duts.map((d) => ({ device: d.device, alias: d.alias!, profile: d.profile, running_profile: d.running_profile ?? null, presence: d.presence, problem: null, rf_weak: false, fit: null, lines: Object.fromEntries(Object.entries(st.bench.duts[d.device].lines).map(([n, l]) => [n, { name: n, role: l.role, channel: l.channel, fixture_gpio: l.fixture_gpio, wired: true, level: true, problem: null, decode: 'level' as const }])) }));
    const probe = (alias: string, reached: string[], line: WiringProbe['line'] = 'boot'): WiringProbe => ({ alias, line, channel: all.find((d) => d.alias === alias)!.lines[line].channel, reached, seen: Object.fromEntries(reached.map((a) => [a, ['boot.down']])), waited_ms: 1000 });
    const short = diagnoseWiring([probe('pad-c3', ['pad-c3', 'pad-c3b']), probe('pad-c3b', ['pad-c3b'])], all, 'fix-s3');
    expect(short).toMatchObject({ pass: false, swapped: [], moves: [] });
    expect(short.problems).toEqual(["pad-c3 boot: a click on fix-s3 ch0 (pad-c3's bench boot line) pressed pad-c3b as well as pad-c3 (boot.down from pad-c3b)"]);
    // pad-c3's line on pad-c3b, pad-c3b's on itself: no edit would match (two DUTs on one channel).
    expect(diagnoseWiring([probe('pad-c3', ['pad-c3b']), probe('pad-c3b', ['pad-c3b'])], all, 'fix-s3')).toMatchObject({ swapped: [], moves: [] });
    // c3 -> c3b -> c6 -> c3 on the boot line: three moves, no pair swapped.
    const rot = diagnoseWiring([probe('pad-c3', ['pad-c3b']), probe('pad-c3b', ['pad-c6']), probe('pad-c6', ['pad-c3'])], all, 'fix-s3');
    expect(rot.swapped).toEqual([]);
    expect(rot.moves.map((x) => `${x.alias} ${x.from.channel}->${x.to.channel}`)).toEqual(['pad-c3 ch0->ch1', 'pad-c3b ch1->ch2', 'pad-c6 ch2->ch0']);
    // A file whose line does not read as bench_get reports it: the move is unmatched, never a wrong edit.
    expect(benchEdit(C3_BENCH.replace('channel: ch0,', 'channel: ch3,'), rot.moves.slice(0, 1))).toEqual({ lines: [], unmatched: rot.moves.slice(0, 1) });
  });
});

// ---- run.ts --tier hil ----

async function deadHub(): Promise<{ url: string; connections: () => number }> {
  let n = 0;
  const server = createTcpServer((s) => {
    n++;
    s.destroy();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, connections: () => n };
}

function node(args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, ['--conditions=@fractonica/source', ...args], { cwd: REPO, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => (out += c));
    child.stderr.on('data', (c: Buffer) => (err += c));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rej(new Error(`${args.join(' ')} did not exit within 30 s: ${err}`));
    }, 30_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      res({ code, out, err });
    });
  });
}

describe('tests/e2e/run.ts --tier hil', () => {
  it('parses --tier and the suite’s args after --; the scenario contract keeps tier and skip', async () => {
    expect(runnerArgs(['--json'])).toMatchObject({ tier: 'target', suiteArgs: [], rest: [] });
    expect(runnerArgs(['--json', '--tier', 'hil', '--suite', 't-hil', '--', '--phase', 'fit', '--rounds', '3'])).toMatchObject({ tier: 'hil', suites: ['t-hil'], json: true, suiteArgs: ['--phase', 'fit', '--rounds', '3'], rest: [] });
    const found = await discover(E2E);
    const hil = found.find((f) => f.file === 't-hil.ts')!;
    expect(hil.scenario).toMatchObject({ gate: 'T-HIL', tier: 'hil', needs: { fixture: true } });
    expect(tierOf(hil.scenario!)).toBe('hil');
    expect(tierOf(found.find((f) => f.file === 't-led.ts')!.scenario!)).toBe('target');
    expect(typeof found.find((f) => f.file === 't-lat.ts')!.scenario!.skip).toBe('function');
    expect(scenarioOf({ default: { gate: 'T-X', tier: 'sim', run: async () => ({ pass: true, measured: {}, evidence: null }) } })).toBe('T-X names tier sim, not target or hil');
    // hil gates never need a person.
    expect(skipReason({ fixture: true }, false)).toBeNull();
    // A tier holds its own modules; naming one of another tier says which.
    expect(select(found, [], 'target').chosen.some((f) => f.file === 't-hil.ts')).toBe(false);
    expect(select(found, [], 'hil').chosen.map((f) => f.file)).toEqual(['t-analog.ts', 't-hil.ts']);
    expect(select(found, ['t-hil'], 'target')).toMatchObject({ chosen: [], unknown: ['t-hil'], otherTier: [{ suite: 't-hil', tier: 'hil' }] });
  });

  it('reports the tier and fails every hil gate fast with the faulty line when the bench_get preflight does', async () => {
    const duts = defaultDuts();
    duts[1].bootLow = true;
    const b = await scriptedBench(duts);
    const errs: string[] = [];
    const found = (await discover(E2E)).filter((f) => f.file === 't-hil.ts');
    const report = await runScenarios(found, { hubUrl: b.hub.url, sourceDir: REPO, allowHuman: false, signal: new AbortController().signal, tier: 'hil', err: (l) => errs.push(l) });
    expect(report).toMatchObject({ tier: 'hil', pass: false, counts: { error: 1 }, preflight: { ok: false, fatal: ['pad-c3b boot: fix-s3 ch1 reads low at idle'], bench: 'hardware/bench/lab.bench.yaml' } });
    expect(report.gates[0]).toMatchObject({ gate: 'T-HIL', status: 'error', reason: 'bench preflight: pad-c3b boot: fix-s3 ch1 reads low at idle' });
    expect(calls(b.hub, 'input_simulate')).toEqual([]);
    expect(errs).toContain('[preflight] pad-c3b boot: fix-s3 ch1 reads low at idle');
    // A hub without the fixture module (the M2-C1 foundation's NOT_FOUND stub).
    const old = await fakeHub({ bench_get: () => ({ ok: false, cursor: 'c:1.1', error: { code: 'NOT_FOUND', message: 'bench_get is not implemented in this hub yet (M2-C1)', retryable: false } }) });
    const r2 = await runScenarios(found, { hubUrl: old.url, sourceDir: REPO, allowHuman: false, signal: new AbortController().signal, tier: 'hil', err: () => {} });
    expect(r2.gates[0].reason).toBe('bench preflight: bench_get: NOT_FOUND bench_get is not implemented in this hub yet (M2-C1)');
    // A target run has no preflight and says so in its tier.
    const r3 = await runScenarios([], { hubUrl: old.url, sourceDir: REPO, allowHuman: false, signal: new AbortController().signal, err: () => {} });
    expect(r3).toMatchObject({ tier: 'target', gates: [] });
    expect(r3.preflight).toBeUndefined();
  });

  it('hands the suite’s args (after --) to the one gate, and the preflight’s pass lets it run', async () => {
    const b = await scriptedBench();
    const found = (await discover(E2E)).filter((f) => f.file === 't-hil.ts');
    // --phase fit with --devices pad-c6: one DUT, one phase (FR_T_HIL_ARGS would be the fallback).
    const report = await runScenarios(found, { hubUrl: b.hub.url, sourceDir: REPO, allowHuman: false, signal: new AbortController().signal, tier: 'hil', args: ['--phase', 'fit', '--devices', 'pad-c6'], err: () => {} });
    expect(report.gates[0], JSON.stringify(report.gates[0])).toMatchObject({ gate: 'T-HIL', status: 'pass', measured: { phases: ['fit'], devices: ['pad-c6'], duts: { 'pad-c6': true } } });
    expect(report.preflight).toMatchObject({ ok: true });
    expect(new Set(calls(b.hub, 'input_simulate').map((c) => c.input.selector))).toEqual(new Set(['pad-c6']));
  }, 60_000);

  it('lists the tier’s modules, refuses a gate of another tier, and answers --help/--list on its own without reaching FR_HUB', async () => {
    const dead = await deadHub();
    const env = { FR_HUB: dead.url, FR_T_HIL_ARGS: '' };
    const [target, hil, wrong, sim, list, help] = await Promise.all([
      node([join('tests', 'e2e', 'run.ts'), '--list'], env),
      node([join('tests', 'e2e', 'run.ts'), '--tier', 'hil', '--list'], env),
      node([join('tests', 'e2e', 'run.ts'), 't-hil', '--json'], env),
      node([join('tests', 'e2e', 'run.ts'), '--tier', 'sim', 't2-nope', '--json'], env),
      node([join('tests', 'e2e', 't-hil.ts'), '--list'], env),
      node([join('tests', 'e2e', 't-hil.ts'), '--help'], env),
    ]);
    expect(target.code).toBe(0);
    expect(target.out).not.toContain('t-hil.ts');
    expect(target.out).toContain('t-lat.ts\tT-LAT\t{"wiring":true,"usb":true}');
    expect(hil).toMatchObject({ code: 0, out: 't-analog.ts\tT-ANALOG\t{"fixture":true}\nt-hil.ts\tT-HIL\t{"fixture":true}\n' });
    expect(wrong.code).toBe(3);
    expect(wrong.err).toContain('t-hil is a hil gate: run it with --tier hil');
    // Tier sim runs the scenarios (design m2-c2 D14); an unknown one is refused before anything starts.
    expect(sim.code).toBe(3);
    expect(sim.err).toContain('no sim scenario t2-nope');
    expect(list).toMatchObject({ code: 0, out: 't-hil.ts\tT-HIL\t{"fixture":true}\n' });
    expect(help.code).toBe(0);
    for (const flag of ['--devices', '--phase wiring|fit|buttons|leds|test_pin|all', '--rounds 10', '--any-fixture-fw', 'FR_T_HIL_ARGS', 'a hil gate: bench_get is checked first']) {
      expect(help.err).toContain(flag);
    }
    expect(standaloneList(tHil, 't-hil.ts')).toBe('t-hil.ts\tT-HIL\t{"fixture":true}');
    expect(standaloneUsage(tHil, 't-hil.ts').split('\n')[0]).toBe('usage: node --conditions=@fractonica/source tests/e2e/t-hil.ts [options] [--hub URL] [--json]');
    // Arguments after -- need exactly one suite.
    const many = await node([join('tests', 'e2e', 'run.ts'), '--json', '--', '--phase', 'fit'], env);
    expect(many.code).toBe(64);
    expect(many.err).toContain('arguments after -- go to one suite');
    expect(dead.connections()).toBe(0);
  }, 120_000);
});

// ---- the other gates on the bench ----

describe('T-LAT, T-INPUT, T-LED and T-AGENT with the HIL bench', () => {
  it('T-LAT is skipped while the bench wires its rig’s pins to the fixture; runs where the bench has no such line', async () => {
    const b = await scriptedBench();
    const { ctx } = ctxOn(b.hub.url);
    const why = await benchSkip(ctx, T_LAT);
    expect(why).toBe(
      "the HIL bench lab wires the T-LAT rig's pins to the fixture (pad-c6 test_pin GPIO20 on fix-s3 ch10, pad-c3b boot GPIO9 on fix-s3 ch1, pad-c3b test_pin GPIO10 on fix-s3 ch9, pad-c6 boot GPIO9 on fix-s3 ch2): the cross-jumpers are off; T-LAT returns at M2-C8 on the fixture",
    );
    expect(await benchSkip(ctx, { ...T_LAT, pairs: [['lat-a', 'lat-b']] })).toBeNull();
    // Through the runner: skipped with that reason, no latency_probe, no binding touched.
    const report = await runScenarios([{ file: 't-lat.ts', scenario: scenarioOf({ default: tLat }) as never }], { hubUrl: b.hub.url, sourceDir: REPO, allowHuman: true, signal: new AbortController().signal, err: () => {} });
    expect(report.gates[0]).toMatchObject({ gate: 'T-LAT', status: 'skipped', reason: why });
    expect(b.hub.calls.map((c) => c.op)).not.toContain('latency_probe');
    // A hub with no bench loaded (bench_get NOT_FOUND: its bench file refused, or no fixture module): the
    // checkout's bench file still says how the rig is wired. Before: T-LAT ran on a rig without its jumpers.
    const ids = Object.fromEntries(Object.entries(DUT_IDS).map(([a, id]) => [a, id]));
    const noBench = await fakeHub({
      bench_get: () => ({ ok: false, cursor: 'c:7.1', error: { code: 'NOT_FOUND', message: 'no HIL bench: duts.58e6c5d55e64.lines.boot.channel: Required', retryable: false } }),
      device_list: (i) => ({ ok: true, cursor: 'c:7.2', data: { devices: ids[i.selector] ? [{ device_id: ids[i.selector], alias: i.selector }] : [] } }),
    });
    // A scratch checkout with the lab bench as designed (§2.3, frozen in packages/codegen/test/fixtures): the
    // checkout's own hardware/bench/lab.bench.yaml is the rig as wired and follows the bench.
    const designed = mkdtempSync(join(tmpdir(), 'fr-tlat-design-'));
    cleanups.push(() => rmSync(designed, { recursive: true, force: true }));
    mkdirSync(join(designed, 'hardware', 'bench'), { recursive: true });
    writeFileSync(join(designed, 'hardware', 'bench', 'lab.bench.yaml'), DESIGN_BENCH_YAML);
    const onDesigned = { ...ctxOn(noBench.url).ctx, sourceDir: designed };
    const fromFile = await benchSkip(onDesigned, T_LAT);
    expect(fromFile).toBe(
      "the checkout's hardware/bench/lab.bench.yaml wires the T-LAT rig's pins to the fixture (pad-c6 test_pin GPIO20 on fixture ch10, pad-c3b boot GPIO9 on fixture ch1, pad-c3b test_pin GPIO10 on fixture ch9, pad-c6 boot GPIO9 on fixture ch2), though the hub has no bench loaded (bench_get: NOT_FOUND no HIL bench: duts.58e6c5d55e64.lines.boot.channel: Required): the cross-jumpers are off; T-LAT returns at M2-C8 on the fixture",
    );
    // This checkout's file (the rig as wired) wires the same rig's pins, wherever they went: T-LAT stays skipped.
    expect(await benchSkip(ctxOn(noBench.url).ctx, T_LAT)).toMatch(/^the checkout's hardware\/bench\/lab\.bench\.yaml wires the T-LAT rig's pins to the fixture \(/);
    // A checkout with no bench file, or pairs it does not wire: T-LAT runs.
    const bare = mkdtempSync(join(tmpdir(), 'fr-tlat-'));
    cleanups.push(() => rmSync(bare, { recursive: true, force: true }));
    expect(await benchSkip({ ...ctxOn(noBench.url).ctx, sourceDir: bare }, T_LAT)).toBeNull();
    expect(await benchSkip(onDesigned, { ...T_LAT, pairs: [['lat-a', 'lat-b']] })).toBeNull();
    // A hub hiccup is the gate's error, not a reason to run.
    const flaky = await fakeHub({ bench_get: () => ({ ok: false, cursor: '', error: { code: 'TIMEOUT', message: 'no answer from the hub within 15000 ms', retryable: true } }) });
    await expect(benchSkip(ctxOn(flaky.url).ctx, T_LAT)).rejects.toBeInstanceOf(HubError);
    const errored = await runScenarios([{ file: 't-lat.ts', scenario: scenarioOf({ default: tLat }) as never }], { hubUrl: flaky.url, sourceDir: REPO, allowHuman: true, signal: new AbortController().signal, err: () => {} });
    expect(errored.gates[0]).toMatchObject({ gate: 'T-LAT', status: 'error', code: 'TIMEOUT' });
    // The lenient reader takes the lab bench as the hub's loader does.
    const lines = benchFileLines(DESIGN_BENCH_YAML);
    expect(lines['58e6c5d55e64']).toMatchObject({ boot: { role: 'button', channel: 'ch2', dut_gpio: 9, wired: true }, test_pin: { channel: 'ch10', dut_gpio: 20, wired: true } });
    expect(lines['1cdbd4175cc4'].analog).toMatchObject({ role: 'analog', wired: true });
    expect(lines['94a99015cecc'].en).toMatchObject({ role: 'en', wired: false });
  });

  it('T-INPUT --press-by fixture: the human phase clicks through the fixture, no prompt, no identify', async () => {
    expect(inputArgs(['--phase', 'human', '--press-by', 'fixture'])).toMatchObject({ phases: ['human'], pressBy: 'fixture' });
    expect(T_INPUT.pressBy).toBe('person');
    expect(() => inputArgs(['--press-by', 'robot'])).toThrow('--press-by takes person or fixture');
    const t: Target = { alias: 'pad-c6', id: DUT_IDS['pad-c6'], dev: {} as Target['dev'], seen: [] };
    let busy = false;
    const hub = await fakeHub({
      input_simulate: (i) => {
        if (busy) {
          return { ok: false, cursor: 'c:7.9', error: { code: 'DEVICE_BUSY', message: 'pad-c6 boot: fix-s3 ch2 does not read released', retryable: true } };
        }
        expect(i).toEqual({ selector: 'pad-c6', instance: 'boot', gesture: 'click', layer: 'gpio', timeout_s: 5 });
        // What the SDK client would see, as the real press goes through the DUT.
        for (const evt of ['down', 'up', 'click']) {
          t.seen.push({ device: t.id, inst: 'boot', evt, tDevUs: 1, late: false, at: Date.now() });
        }
        return { ok: true, cursor: 'c:7.8', data: { results: [{ device: t.id, alias: 'pad-c6', status: 'ok', layer: 'gpio', channel: 'ch2', press: { t_fix_us: 5_000_000, segments_us: [80_000], total_us: 80_000 } }] } };
      },
    });
    const { ctx } = ctxOn(hub.url);
    const r = await humanPhase(ctx, t, { ...T_INPUT, phases: ['human'], pressBy: 'fixture' });
    expect(r).toMatchObject({ pass: true, press_by: 'fixture', got: ['down', 'up', 'click'], channel: 'ch2', press: { segments_us: [80_000] } });
    expect(hub.calls.map((c) => c.op)).toEqual(['input_simulate']);
    busy = true;
    expect(await humanPhase(ctx, t, { ...T_INPUT, pressBy: 'fixture' })).toMatchObject({ pass: false, error: 'DEVICE_BUSY pad-c6 boot: fix-s3 ch2 does not read released' });
    // A hub that cannot press at all (no fixture module) is an error, not a slip.
    const none = await fakeHub({});
    await expect(humanPhase(ctxOn(none.url).ctx, t, { ...T_INPUT, pressBy: 'fixture' })).rejects.toBeInstanceOf(HubError);
    // A board the bench does not wire (an online non-bench node under the default `online`): that board
    // fails, the run goes on. Before: NOT_FOUND threw and errored the whole gate.
    const unwired = await fakeHub({
      input_simulate: () => ({ ok: false, cursor: 'c:7.9', error: { code: 'NOT_FOUND', message: 'pad-x is not a DUT of bench lab; layer gpio presses bench-wired button lines only', retryable: false, details: { not_wired: true, device: 'aabbccddeeff', instance: 'boot' } } }),
    });
    expect(await humanPhase(ctxOn(unwired.url).ctx, { ...t, alias: 'pad-x' }, { ...T_INPUT, pressBy: 'fixture' })).toEqual({
      pass: false,
      press_by: 'fixture',
      error: 'not wired on the bench: pad-x is not a DUT of bench lab; layer gpio presses bench-wired button lines only',
    });
  });

  it('T-INPUT --phase human --press-by fixture needs no person: test_run runs it without allow_human; a person-pressed run is still skipped', async () => {
    expect(inputNeeds(inputArgs(['--phase', 'human', '--press-by', 'fixture']))).toEqual({ human: false, usb: false });
    expect(inputNeeds(inputArgs([]))).toEqual({ human: true, usb: true });
    expect(inputNeeds(inputArgs(['--phase', 'human']))).toEqual({ human: true, usb: false });
    expect(inputNeeds(inputArgs(['--phase', 'sim,loss']))).toEqual({ human: false, usb: true });
    const scenario = scenarioOf({ default: tInput }) as Exclude<ReturnType<typeof scenarioOf>, string>;
    expect(scenario.needs).toEqual({ human: true, usb: true });
    // Through the runner as test_run starts it (args after --, no allow_human). The hub here answers
    // nothing, so a run that starts errors on its first call: it was not skipped.
    const hub = await fakeHub({});
    const run = (args: string[]) => runScenarios([{ file: 't-input.ts', scenario }], { hubUrl: hub.url, sourceDir: REPO, allowHuman: false, signal: new AbortController().signal, args, err: () => {} });
    // Before: skipped, "needs a person at the bench; run with allow_human".
    expect((await run(['--phase', 'human', '--press-by', 'fixture'])).gates[0]).toMatchObject({ gate: 'T-INPUT', status: 'error', code: 'NOT_FOUND' });
    expect((await run(['--phase', 'human'])).gates[0]).toMatchObject({ status: 'skipped', reason: 'needs a person at the bench; run with allow_human (--allow-human)' });
    expect((await run([])).gates[0]).toMatchObject({ status: 'skipped' });
    // Arguments it cannot parse keep the declared needs (and the run's own parse says what is wrong).
    expect((await run(['--press-by', 'robot'])).gates[0]).toMatchObject({ status: 'skipped' });
  });

  it('T-LED --verify fixture reads every change back: the WS2812 frames and the C3 tap pass; an LED 8 ms behind its STATEs fails', async () => {
    expect(ledArgs(['--verify', 'fixture'])).toMatchObject({ verify: 'fixture' });
    expect(ledArgs([])).toEqual(T_LED);
    expect(() => ledArgs(['--verify', 'eyes'])).toThrow('--verify takes fixture');
    const duts = defaultDuts();
    duts[3].ledLagUs = 8000;
    duts[0].fitMaxAgeMs = 1000; // pad-c3 has no sample at all: its readings come on hub time
    const b = await scriptedBench(duts);
    const { ctx, measured } = ctxOn(b.hub.url);
    const out = await runTLed(ctx, { ...T_LED, onMs: 30, offMs: 30, settleMs: 100, devices: ['pad-c6', 'pad-c3', 'pad-s3'], verify: 'fixture' });
    expect(out.pass).toBe(false);
    expect(out.measured).toMatchObject({ verify: 'fixture', bench: 'lab' });
    for (const a of ['pad-c6', 'pad-c3']) {
      expect(measured[a], a).toMatchObject({ pass: true, blink: { pass: true }, set: { pass: true }, toggle: { pass: true }, fixture: { pass: true, state_lost: 0 } });
    }
    expect(measured['pad-c6']).toMatchObject({ fixture: { decode: 'ws2812', channel: 'ch6', blink: { n: 1, pass: true } } });
    expect(measured['pad-c3']).toMatchObject({ fixture: { decode: 'level', channel: 'ch4' } });
    // What it was judged within is published: 5 ms on the wired fit, 5 ms + u_us on hub time.
    expect((measured['pad-c6'] as Record<string, any>).fixture.tolerance_us).toEqual({ wired: 5000, hub_max: null });
    expect((measured['pad-c3'] as Record<string, any>).fixture).toMatchObject({ sync: { hub: expect.any(Number) }, tolerance_us: { wired: 5000, hub_max: 5060 } });
    expect(measured['pad-s3']).toMatchObject({ pass: false, toggle: { pass: true }, fixture: { pass: false, missing_changes: expect.any(Array) } });
  }, 60_000);

  it('T-LED --verify fixture names a DUT on another profile instead of reporting every change missing', async () => {
    const duts = defaultDuts();
    duts[2].running = 'c6-pad-mono';
    const b = await scriptedBench(duts);
    const { ctx, measured } = ctxOn(b.hub.url);
    const out = await runTLed(ctx, { ...T_LED, phases: ['set'], settleMs: 100, devices: ['pad-c6'], verify: 'fixture' });
    expect(out.pass).toBe(false);
    expect((measured['pad-c6'] as Record<string, any>).fixture).toEqual({ pass: false, error: 'pad-c6 runs c6-pad-mono, not its bench profile c6-pad: its LED line is not known to be wired (bench_get: profile_mismatch)' });
  }, 60_000);

  it('T-AGENT (a) needs op.called {client: mcp} for binding_set and input_simulate; a hub that publishes none (from what it is) is judged on the effects, and says so', () => {
    const T = 1_792_000_000_000_000;
    let s = 100;
    const e = (type: string, alias: string, t: number, fields: Record<string, unknown> = {}): Ev => ({ cursor: `c:7.${++s}`, seq: s, type, alias, device: alias, t_hub_us: t, fields });
    const rows = [{ slot: 1, from: BINDING.from, to: BINDING.to, args: { count: 1 } }];
    const downs = [e('boot.down', 'pad-c6', T)];
    const fired = [e('node.binding_fired', 'pad-c6', T + 6000, { slot: 1, target_status: 0, rtt_us: 4360, path: 0 })];
    const done = [e('status.effect_done', 'pad-c3', T + 420_000, { effect: 'blink' })];
    const call = (op: string, client: string | null, alias = 'pad-c6') => e('op.called', alias, T - 1000, { op, client, ...(op === 'input_simulate' ? { instance: 'boot', gesture: 'click', layer: 'inject' } : {}) });
    const base = { rows, downs, fired, done, minPresses: 1 };
    const ok = evaluateBinding({ ...base, calls: [call('binding_set', 'mcp'), call('binding_set', 'mcp', 'pad-c3'), call('input_simulate', 'mcp')] });
    expect(ok.problems).toEqual([]);
    expect(ok.measured.op_called).toEqual({ binding_set: { mcp: 2 }, input_simulate: { mcp: 1 } });
    const byCli = evaluateBinding({ ...base, calls: [call('binding_set', 'cli'), call('input_simulate', 'mcp')] });
    expect(byCli.pass).toBe(false);
    expect(byCli.problems).toEqual(['no op.called {op: binding_set, client: mcp} on pad-c6 or pad-c3 after the cursor (the hub recorded 1 by cli)']);
    expect(callProblems([call('binding_set', 'mcp'), call('command_send', 'mcp')])).toEqual(['no op.called {op: input_simulate, client: mcp} on pad-c6 after the cursor']);
    // input_simulate on another device does not count.
    expect(callProblems([call('binding_set', 'mcp'), call('input_simulate', 'mcp', 'pad-c3')])).toHaveLength(1);
    // A hub before M2-C1 (it publishes no op.called, which the harness learns from the hub): (a) on its effects, said so.
    const legacy = evaluateBinding({ ...base, calls: [], opCalled: false });
    expect(legacy.pass).toBe(true);
    expect(legacy.measured.origin_of_commands).toBe('the hub publishes no op.called (it has no bench_get op: a hub before M2-C1), so (a) is proven by its effects alone');
    // An M2-C1 hub that recorded none (the binding left from M1, a person's press, op.called broken): no
    // longer the effects fallback. Before: pass, "a hub before M2-C1".
    const none = evaluateBinding({ ...base, calls: [], opCalled: true });
    expect(none.pass).toBe(false);
    expect(none.problems).toEqual([
      'no op.called {op: binding_set, client: mcp} on pad-c6 or pad-c3 after the cursor',
      'no op.called {op: input_simulate, client: mcp} on pad-c6 after the cursor, nor a real press it asked for (prompt_human, then a boot.down no input_simulate made)',
    ]);
    expect(evaluateBinding({ ...base, calls: [] }).pass).toBe(false); // opCalled absent: taken as true
  });

  it('T-AGENT (a): a real press the agent asked for (prompt_human) proves it; a simulated one by another client does not; a test run’s calls are not the agent’s', () => {
    const T = 1_792_000_000_000_000;
    let s = 300;
    const e = (type: string, alias: string | undefined, t: number, fields: Record<string, unknown> = {}): Ev => ({ cursor: `c:7.${++s}`, seq: s, type, ...(alias ? { alias, device: alias } : {}), t_hub_us: t, fields });
    const rows = [{ slot: 1, from: BINDING.from, to: BINDING.to, args: { count: 1 } }];
    const press = { downs: [e('boot.down', 'pad-c6', T)], fired: [e('node.binding_fired', 'pad-c6', T + 6000, { slot: 1, target_status: 0, rtt_us: 4360, path: 0 })], done: [e('status.effect_done', 'pad-c3', T + 420_000, { effect: 'blink' })] };
    const set = e('op.called', 'pad-c6', T - 30_000_000, { op: 'binding_set', client: 'mcp' });
    const prompt = e('hub.prompt', undefined, T - 8_000_000, { prompt_id: 'p_00000002', text: 'Press BOOT on pad-c6' });
    const base = { rows, ...press, minPresses: 1, opCalled: true };
    // binding_set by the agent, then a person's press it asked for: (a) passes with no input_simulate.
    // Before: "no op.called {op: input_simulate, client: mcp}", a legitimate run failed.
    const real = evaluateBinding({ ...base, calls: [set], prompts: [prompt] });
    expect(real.problems).toEqual([]);
    expect(real.measured).toMatchObject({ op_called: { binding_set: { mcp: 1 } }, press_by: 'a person (prompt_human)', real_presses: 1 });
    // No prompt: nobody was asked, so the press does not prove the agent's (a).
    expect(evaluateBinding({ ...base, calls: [set], prompts: [] }).pass).toBe(false);
    // The press came from someone's input_simulate (fr press, client cli) right before: not a real press.
    const cli = e('op.called', 'pad-c6', T - 2000, { op: 'input_simulate', client: 'cli', instance: 'boot', gesture: 'click', layer: 'gpio' });
    expect(evaluateBinding({ ...base, calls: [set, cli], prompts: [prompt] }).problems).toEqual([
      'no op.called {op: input_simulate, client: mcp} on pad-c6 after the cursor (the hub recorded 1 by cli), nor a real press it asked for (prompt_human, then a boot.down no input_simulate made)',
    ]);
    // A test run the agent started (T-HIL: FR_CLIENT=mcp) re-sets the parked binding and presses pad-c6: its calls are the run's.
    const states = [e('job.state', undefined, T - 60_000_000, { job_id: 'j_test01', kind: 'test', status: 'queued', origin: 'mcp' }), e('job.state', undefined, T - 10_000_000, { job_id: 'j_test01', kind: 'test', status: 'completed', origin: 'mcp' })];
    const windows = testWindows(states);
    expect(windows).toEqual([{ job_id: 'j_test01', from_us: T - 60_000_000, to_us: T - 10_000_000 }]);
    const inRun = [e('op.called', 'pad-c6', T - 20_000_000, { op: 'binding_set', client: 'mcp' }), e('op.called', 'pad-c6', T - 19_000_000, { op: 'input_simulate', client: 'mcp', gesture: 'click', layer: 'gpio' })];
    const byRun = evaluateBinding({ ...base, calls: inRun, prompts: [], testWindows: windows });
    expect(byRun.pass).toBe(false);
    expect(byRun.measured).toMatchObject({ op_called: {}, op_called_by_test_runs: 2 });
    expect(testWindows([states[0]])[0].to_us).toBe(Infinity); // still running: open
  });

  it('T-AGENT learns whether the hub publishes op.called from the hub: its registry, or a bench_get op; a hub that does not answer is an error', async () => {
    const ask = async (on: Record<string, Handler>) => hubPublishesOpCalled(ctxOn((await fakeHub(on)).url).ctx);
    const status = (hash: string) => () => ({ ok: true, cursor: 'c:7.1', data: { registry_hash: hash, warnings: [] } });
    expect((await ask({ hub_status: status(REGISTRY_HASH) })).yes).toBe(true);
    // Another registry: an M1 hub has no bench_get (unknown op); an M2-C1 hub without a bench still knows it.
    expect(await ask({ hub_status: status('000000000000') })).toEqual({ yes: false, how: 'the hub has no bench_get op: a hub before M2-C1, which publishes no op.called' });
    expect((await ask({ hub_status: status('000000000000'), bench_get: () => ({ ok: false, cursor: 'c:7.2', error: { code: 'NOT_FOUND', message: 'no HIL bench: hardware/bench/lab.bench.yaml not loaded', retryable: false } }) })).yes).toBe(true);
    expect((await ask({ hub_status: status('000000000000'), bench_get: () => ({ ok: true, cursor: 'c:7.2', data: {} }) })).yes).toBe(true);
    await expect(ask({ hub_status: status('000000000000'), bench_get: () => ({ ok: false, cursor: '', error: { code: 'TIMEOUT', message: 'no answer', retryable: true } }) })).rejects.toBeInstanceOf(HubError);
  });
});

// ---- a dry run on a real hub with the virtual fixture ----

describe.skipIf(!existsSync(BIN) || !LAB_BENCH)('T-HIL on a real loopback hub with the virtual fixture', () => {
  // hil-rig.ts (I1): a real hub process (real-hub.ts) on this checkout's lab bench, one fr_net_node pad per bench
  // DUT on its MAC, alias and profile (over TCP/UDP, rebootable), and S2's serial-only virtual fixture on the
  // hub's serial bridge (virtual-usb.ts), every line wired by loopback datagrams. T-HIL runs against it through
  // REST as on the bench; the lab bench's fixture.fw_id is not pinned yet (§5.3 step 2), hence --any-fixture-fw.
  // The pads are host processes: their LED timers are fr_net_node's poll() (ms, woken late by macOS), and a
  // loaded Mac (the full suite runs files in parallel) wakes one up to ~15 ms after its wire's edge. So the
  // timing gates widen here (a down after its edge and blink widths 25 ms, a STATE to its reading and effect_done
  // 15 ms, with LED commands 60 ms apart so that a reading still pairs with its own STATE); what this run proves
  // is that the pieces meet, every phase measured and judged. interop-hil.test.ts holds the 2 ms and 5 ms rules
  // (at the median) on this same rig.
  const DRY: THilOptions = {
    ...FAST,
    anyFixtureFw: true,
    wiringWaitMs: 3000,
    ledGapMs: 60,
    trial: { ...FAST.trial, downMaxUs: 25_000 },
    led: { ...FAST.led, blinkTolMs: 25, tolUs: 15_000 },
  };

  it('runs every phase against fr_net_node pads and the serial-only virtual fixture: pass, full gate, cleanup ok, no hub.prompt', async () => {
    const rig = await startHilRig(LAB_BENCH!);
    cleanups.push(() => rig.stop());
    const { ctx, measured, logs } = ctxOn(rig.hub.url);
    const out = await runTHil(ctx, DRY);
    expect(out.pass, `${JSON.stringify(out.measured)}\n${logs.join('\n')}`).toBe(true);
    expect(out.measured).toMatchObject({ full_gate: true, prompts_human: 0, cleanup: { ok: true }, duts: { 'pad-c3': true, 'pad-c3b': true, 'pad-c6': true, 'pad-s3': true } });
    for (const phase of ['wiring', 'fit', 'buttons', 'leds', 'test_pin']) {
      for (const a of ['pad-c3', 'pad-c3b', 'pad-c6', 'pad-s3']) {
        expect(measured[`${phase}.${a}`], `${phase} ${a}`).toMatchObject({ pass: true });
      }
    }
    const st = await rig.hub.api.ok<BenchStatus>('bench_get', {});
    expect(st.lines.filter((l) => l.wired).map((l) => l.state)).toEqual(st.lines.filter((l) => l.wired).map(() => 'idle'));
  }, 240_000);

  it('a cancel mid-buttons stops the run within the grace and leaves bench_get idle, every line released', async () => {
    const rig = await startHilRig(LAB_BENCH!);
    cleanups.push(() => rig.stop());
    const ac = new AbortController();
    const { ctx, measured } = ctxOn(rig.hub.url, [], ac.signal);
    const run = runTHil(ctx, { ...DRY, phases: ['fit', 'buttons'], rounds: 3 });
    // Cancelled in the buttons phase (the fit phase measured every DUT), while a gesture holds a BOOT line low.
    await until(() => measured['fit.pad-s3'] !== undefined, 120_000, 'the buttons phase');
    await until(() => rig.pads.some((p) => p.node.of('pin_in').at(-1)?.level === 0), 30_000, 'a line held low');
    const t0 = Date.now();
    ac.abort(new Error('cancelled (SIGTERM)'));
    await expect(run).rejects.toThrow('cancelled (SIGTERM)');
    expect(Date.now() - t0).toBeLessThan(CANCEL_GRACE_MS);
    expect(measured.cleanup, JSON.stringify(measured.cleanup)).toMatchObject({ ok: true, bindings_not_restored: [] });
    const st = await rig.hub.api.ok<BenchStatus>('bench_get', {});
    expect(st.lines.filter((l) => l.wired).map((l) => [l.channel, l.state])).toEqual(st.lines.filter((l) => l.wired).map((l) => [l.channel, 'idle']));
    const lines = await fixtureLines(rig.fixture);
    for (const p of rig.pads) {
      expect(lines[p.boot], p.alias).toMatchObject({ level: true, pressing: false });
    }
  }, 240_000);
});
