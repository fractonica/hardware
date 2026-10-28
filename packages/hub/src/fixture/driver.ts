// The fixture driver (design m2-c1-hil D8, D9, D11, §2.1; stream S4): gestures as fixture segments, the
// gating that keeps a press off a DUT that cannot take one, the releases, and the identify blink. Only this
// module sends CMDs to the fixture (the fence, fence.ts, refuses clients), through sendCommandTo.
//
// Gestures (§2.1, press first, µs): click 80,000; double_click 80,000/100,000/80,000; long_press the DUT's
// long_press_ms + 200,000; press held until release or the line's cap_ms; release the `release` command;
// bounce 600/400/600/400/80,000 (gpio only, never a fit sample). The fixture answers `press` at its first
// press edge; the op returns once the gesture has ended (press: at the press edge). A `release` returns once
// the line's release edge has come back (its `press` then carries that edge: the hold of a held `press` is the
// two edges' difference), or without `press` when the line was not pressed or no edge came within 200 ms.
//
// Gating (D8, D11 item 2), in this order: the bench in force is current (the file neither fails validation
// since nor changed while a press was held: INVALID_SOURCE, DEVICE_BUSY); the line is wired (NOT_FOUND
// not_wired); the fixture is online (DEVICE_OFFLINE) and, when its running build's artifact manifest is known,
// drives that channel as the bench line says (INCOMPATIBLE_PROFILE fixture_mismatch: no fr.fixture instance of
// that name, or another drive); the DUT is online (DEVICE_OFFLINE) and runs a bench profile
// (INCOMPATIBLE_PROFILE profile_mismatch); the DUT has no flash, provision, OTA or reset job and is in no
// declared power-cut window (LOCKED); the line is released (DEVICE_BUSY: by readback on open-drain lines, by
// `boot.pressed` on MOSFET-gated ones) and no press runs on it. The fixture checks the readback itself too
// (BUSY). `release` needs only a wired line of the bench in force and the fixture: letting go is always safe.
//
// Releases (D11 item 2): `release` on a DUT's driven lines at its device.offline, node.boot or port.detached,
// and when a power-cut window is declared on it. A gesture still running then is cut short: it returns status
// `interrupted` (with when and why), never ok with segments it did not make. A press whose RESULT never came
// (timeout, offline) may still run on the fixture, so it gets a `release` too, and its line counts as pressing
// until it reads released. At every fixture WELCOME (its device.link up) every driven line gets a `release`
// before anything else is sent: a session that dropped without a reboot (a BYE and a new HELLO within the
// fixture's 2 s rule) left its presses running. Only the fixture's node.boot (or an offline that says it
// restarted) clears what the driver tracks: a reboot releases every line.
// Identify (D9): `status.blink {count: 3}` at each fixture WELCOME, after those releases, so a person sees the
// fixture's session come up.
//
// Analog lines (design m2-c3-inputs D5, D7): a bench line of role analog is a PWM channel (drive pwm) through an RC
// to the DUT's ADC pin. setMv sets its setpoint with `set_duty {duty}` (duty = round(mv / vdd_mv * 10000), clamped
// to 0..10,000, vdd_mv from the bench file) and answers with the fixture time the duty was applied, mapped to hub
// time through the fixture's TIME offset (as press edges are). Its gates are a press's but the busy ones: a
// wired analog line, the bench current, the fixture online and driving the channel pwm, the DUT online on the
// line's dut_profile, no locking job or power cut; a setpoint replaces the last at once. mv 0 is letting go: it
// needs only the wired line and the fixture. Every release path above sets a pwm line's duty to 0 (`set_duty
// {duty: 0}`) instead of sending `release`, and no gesture or `release` gesture goes to an analog line.

import { FrError, type InputGesture, type Job, type ManifestCap, type Remediation } from '@fractonica/protocol';
import { BUTTON_CONFIG_DEFAULTS } from '@fractonica/protocol/gen';

import { manifestCapsByFwPrefix } from '../artifacts.ts';
import type { Device, HubContext, HubEvent, OpInput, Presence } from '../context.ts';
import { mintCursor } from '../events/index.ts';
import { nowUs } from '../ring.ts';
import { routerInfo, routerProbe } from '../router/index.ts';
import { analogRange, type CommandOutcome, sendCommandTo, valueToMv } from '../router/ops.ts';
import type { BenchSync } from './sync.ts';
import { type BenchLineRef, type BenchMap, type LineEdge, lineDrive, pressLevel } from './timeline.ts';

const isUp = (p: Presence) => p === 'online' || p === 'suspect';

/** The fixture line's longest press (fixture.cap.yaml cap_ms default): `press` holds this long unless released. */
export const DEFAULT_CAP_MS = 15_000;
/** A press with no RESULT within this is a failure (the fixture answers at its first press edge). */
const PRESS_TIMEOUT_MS = 2000;
/**
 * After a gesture's last segment, before the op returns and the line takes another press: the DUT's
 * debounce_ms (a release shorter than that would merge the next press into this gesture), plus this.
 */
const SETTLE_MS = 10;
/**
 * After a `release`, the line still counts as pressing until the fixture reports it released (its `level`
 * STATE follows the RESULT by an edges flush, flush_us) or this long: bench_get then says `active`, never a
 * `line_low` that is only the STATE still on its way.
 */
const RELEASE_SETTLE_MS = 500;
/** The jobs during which a DUT takes no press (D8). */
const LOCKING_JOBS: ReadonlySet<Job['kind']> = new Set(['flash', 'provision', 'ota', 'reset']);
/**
 * Press outcomes that say the fixture started nothing (it answered, refusing): every other non-ok one (timeout,
 * offline, failed...) may leave the press running there, with only its RESULT lost.
 */
const NOT_STARTED: ReadonlySet<string> = new Set(['busy', 'invalid_args', 'unsupported', 'not_found', 'injection_disabled']);
/** How long a `release` waits for the line's release edge to come back (an edges batch, flush_us after it). */
const RELEASE_EDGE_MS = 200;
/** How long the fixture build's caps (its artifact manifest) are kept before they are looked up again. */
const FIXTURE_CAPS_MS = 5000;

/** fr.fixture set_duty's full scale (m2-c3-inputs D5): duty in 1/10,000. */
export const DUTY_FULL = 10_000;

/** The duty of a setpoint (D5): round(mv / vdd_mv * 10000), clamped to 0..10,000. */
export function dutyFor(mv: number, vddMv: number): number {
  return Math.min(DUTY_FULL, Math.max(0, Math.round((mv / vddMv) * DUTY_FULL)));
}

/** A setpoint as the fixture applied it: what was asked, the duty, and when (fixture µs and hub µs). */
export interface Setpoint {
  mv: number;
  duty: number;
  vdd_mv: number;
  /** The voltage the duty stands for: duty * vdd_mv / 10000. */
  applied_mv: number;
  /** The fixture's esp_timer time the duty was applied (set_duty's at_us, unwrapped on its clock), and that in hub µs. */
  at_fix_us: number;
  at_hub_us: number;
}

/** The fixture segments of a gesture (§2.1), press first; `release` has none (it is its own command). */
export function gestureSegments(gesture: InputGesture, opts: { longPressMs?: number; capMs?: number } = {}): number[] {
  switch (gesture) {
    case 'click':
      return [80_000];
    case 'double_click':
      return [80_000, 100_000, 80_000];
    case 'long_press': {
      // long_press_ms 0 disables long_press on the DUT: the hold is still a long one, the cap default's (as the
      // harness's segmentsFor, tests/e2e/lib/hil.ts), so the DUT shows what a disabled long press does.
      const ms = opts.longPressMs ?? BUTTON_CONFIG_DEFAULTS.long_press_ms;
      return [(ms > 0 ? ms : BUTTON_CONFIG_DEFAULTS.long_press_ms) * 1000 + 200_000];
    }
    case 'press':
      return [(opts.capMs ?? DEFAULT_CAP_MS) * 1000];
    case 'bounce':
      return [600, 400, 600, 400, 80_000];
    case 'release':
      return [];
  }
}

/** What the driver reads and calls. */
export interface DriverDeps {
  hub: () => HubContext;
  /** The bench in force (the last one that loaded and validated), null before any. */
  map: () => BenchMap | null;
  sync: BenchSync;
  /** Why presses are refused although a bench is in force (its file fails validation, or changed while a press was held), else null. */
  refusal?: () => FrError | null;
  /** The next edge to `level` on a channel since hub µs `sinceHubUs` (Timeline.waitEdge). */
  waitEdge?: (channel: string, level: boolean, sinceHubUs: number, ms: number) => { wait: Promise<LineEdge | null>; cancel: () => void };
}

/** A press running on a fixture channel. */
interface Running {
  dut: string;
  /** Date.now() ms until which the line is busy: the gesture's end (a held `press`: the fixture's cap). */
  until: number;
  gesture: InputGesture;
  /** Set when a release cut the gesture short: hub µs it was sent, and the event that sent it. */
  interrupted?: { at_hub_us: number; reason: string };
}

function refusal(
  code: 'DEVICE_OFFLINE' | 'INCOMPATIBLE_PROFILE' | 'LOCKED' | 'DEVICE_BUSY',
  message: string,
  details: Record<string, unknown>,
  remediation: Remediation[] = [{ tool: 'bench_get' }],
): FrError {
  return new FrError(code, message, { remediation, details });
}

export class Driver {
  #deps: DriverDeps;
  /** By fixture channel. */
  #running = new Map<string, Running>();
  /** Declared power-cut windows: DUT -> Date.now() ms they end. */
  #cuts = new Map<string, number>();
  /** The fixture build's caps, as last looked up. */
  #capsCache: { fw: string; caps: ManifestCap[] | null; at: number } | null = null;
  /** The duty last applied on each pwm channel (a fixture reboot sets every one to 0). */
  #duty = new Map<string, number>();

  constructor(deps: DriverDeps) {
    this.#deps = deps;
  }

  // ---- state other parts read ----

  /** The DUT is in a declared power-cut window. */
  inCut(dut: string): boolean {
    const until = this.#cuts.get(dut);
    if (until === undefined) {
      return false;
    }
    if (Date.now() >= until) {
      this.#cuts.delete(dut);
      return false;
    }
    return true;
  }

  /**
   * A power-cut window on DUTs (§6 rule 3; in-process only in C1, no op declares one): their lines are let go
   * first (a BOOT held across the replug would latch download mode), then presses are refused until it ends.
   */
  declarePowerCut(ids: string[], ms: number): () => void {
    const until = Date.now() + Math.max(0, ms);
    for (const id of ids) {
      this.#cuts.set(id, Math.max(this.#cuts.get(id) ?? 0, until));
      void this.release(id, 'power_cut');
    }
    return () => {
      for (const id of ids) {
        if (this.#cuts.get(id) === until) {
          this.#cuts.delete(id);
        }
      }
    };
  }

  /** A press runs on the channel now (or its release has not been read back yet). */
  running(channel: string): boolean {
    const r = this.#running.get(channel);
    if (r && (Date.now() >= r.until || (r.gesture === 'release' && this.#readsReleased(channel)))) {
      this.#running.delete(channel);
      return false;
    }
    return r !== undefined;
  }

  /** The fixture reads the channel at its released level (open drain: high; MOSFET gate: low). */
  #readsReleased(channel: string): boolean {
    const ref = this.#deps.map()?.byChannel(channel);
    const level = this.lineLevel(channel);
    return ref !== undefined && level !== null && level !== pressLevel(ref.line);
  }

  /** A press (not a release settling) runs on some channel: the bench in force must not change under it. */
  holding(): boolean {
    return [...this.#running.keys()].some((ch) => this.running(ch) && this.#running.get(ch)?.gesture !== 'release');
  }

  /**
   * A release went out on the channel: settling until it reads released, RELEASE_SETTLE_MS at most (longer
   * when given: a press whose RESULT never came may run on until its own end).
   */
  #settle(channel: string, dut: string, ms = RELEASE_SETTLE_MS): void {
    this.#running.set(channel, { dut, until: Date.now() + Math.max(RELEASE_SETTLE_MS, ms), gesture: 'release' });
  }

  /** A gesture still running on the channel is cut short by a release (`reason`): its gesture() says so. */
  #interrupt(channel: string, reason: string): void {
    const r = this.#running.get(channel);
    if (r && r.gesture !== 'release' && !r.interrupted) {
      r.interrupted = { at_hub_us: nowUs(), reason };
    }
  }

  /**
   * `release` on a channel without waiting for it (it is idempotent): once more if it times out. A line a
   * gesture of ours runs on, or that does not read released, counts as pressing until it reads released (`ms`
   * at most); one that reads released with nothing of ours on it is left as it is. Never throws.
   */
  #letGo(fixture: Device, channel: string, dut: string, ms = RELEASE_SETTLE_MS): Promise<void> {
    const hub = this.#deps.hub();
    const ours = this.#running.get(channel);
    if ((ours && ours.gesture !== 'release') || !this.#readsReleased(channel)) {
      this.#settle(channel, dut, ms);
    }
    const once = () => sendCommandTo(hub, fixture, channel, 'release', {}, { ack: 'result', timeoutMs: PRESS_TIMEOUT_MS });
    try {
      return once()
        .then((out) => (out.status === 'timeout' ? once() : out))
        .then(
          () => undefined,
          () => undefined,
        );
    } catch {
      return Promise.resolve(); // the fixture firmware has no such channel: nothing of ours runs there either
    }
  }

  // ---- devices ----

  #device(id: string): Device | null {
    try {
      return this.#deps.hub().registry.get(id);
    } catch {
      return null;
    }
  }

  #fixture(map: BenchMap): Device {
    const hub = this.#deps.hub();
    const dev = this.#device(map.fixture);
    if (!dev || !isUp(hub.router.presence(dev.device_id))) {
      throw refusal('DEVICE_OFFLINE', `the bench fixture ${dev?.alias ?? map.fixture} is ${dev ? hub.router.presence(dev.device_id) : 'not registered'}`, {
        fixture: map.fixture,
      });
    }
    return dev;
  }

  /** The level the fixture reads on a channel (its `level` property), or null when unknown. */
  lineLevel(channel: string): boolean | null {
    const map = this.#deps.map();
    const v = map ? routerInfo(this.#deps.hub().router, map.fixture)?.properties[`${channel}.level`] : undefined;
    return typeof v === 'boolean' ? v : null;
  }

  /**
   * The DUT's fr.button long_press_ms and debounce_ms: its running firmware's config (the artifact
   * manifest), else the capability defaults (§2.1).
   */
  buttonConfig(dut: Device, instance: string): { long_press_ms: number; debounce_ms: number } {
    const hub = this.#deps.hub();
    const fw = routerInfo(hub.router, dut.device_id)?.fw_id_prefix ?? dut.fw_id;
    let config: Record<string, unknown> = {};
    try {
      config = (fw ? manifestCapsByFwPrefix(hub.db, fw)?.find((c) => c.name === instance)?.config : undefined) ?? {};
    } catch {
      // no manifest for that firmware: the defaults
    }
    const num = (k: 'long_press_ms' | 'debounce_ms') => (typeof config[k] === 'number' ? (config[k] as number) : BUTTON_CONFIG_DEFAULTS[k]);
    return { long_press_ms: num('long_press_ms'), debounce_ms: num('debounce_ms') };
  }

  /**
   * How the fixture's running build (its artifact manifest, when the hub has one for its fw_id) disagrees with
   * a bench line: no fr.fixture instance on the line's channel, another drive, or (an LED line) another decode;
   * null when they agree or the build is unknown (bench_get's fw_ok says whether it is the pinned one).
   */
  channelMismatch(ref: BenchLineRef): string | null {
    const map = this.#deps.map();
    const hub = this.#deps.hub();
    if (!map || !ref.line.wired) {
      return null;
    }
    const fx = this.#device(map.fixture);
    const fw = routerInfo(hub.router, map.fixture)?.fw_id_prefix ?? fx?.fw_id ?? null;
    const caps = fw ? this.#fixtureCaps(fw) : null;
    if (!caps) {
      return null;
    }
    const ch = ref.line.channel;
    const cap = caps.find((c) => c.name === ch);
    if (!cap || cap.cap !== 'fr.fixture') {
      return `its firmware (${fw}) has no fr.fixture instance ${ch}`;
    }
    const drive = String(cap.config.drive ?? 'none');
    if (drive !== lineDrive(ref.line)) {
      return `its firmware (${fw}) drives ${ch} ${drive}, the bench line needs ${lineDrive(ref.line)}`;
    }
    if (ref.line.role === 'led' && String(cap.config.decode ?? 'level') !== (ref.line.decode ?? 'level')) {
      return `its firmware (${fw}) decodes ${ch} as ${String(cap.config.decode ?? 'level')}, the bench line as ${ref.line.decode ?? 'level'}`;
    }
    return null;
  }

  /** The caps of the fixture build `fw` (its artifact manifest), null without one; looked up again after FIXTURE_CAPS_MS. */
  #fixtureCaps(fw: string): ManifestCap[] | null {
    const c = this.#capsCache;
    if (c && c.fw === fw && Date.now() - c.at < FIXTURE_CAPS_MS) {
      return c.caps;
    }
    let caps: ManifestCap[] | null = null;
    try {
      const db = this.#deps.hub().db;
      caps = db ? manifestCapsByFwPrefix(db, fw) : null;
    } catch {
      caps = null;
    }
    this.#capsCache = { fw, caps, at: Date.now() };
    return caps;
  }

  /** The DUT's flash, provision, OTA or reset job that is not over, if any. */
  #lockingJob(id: string): { job_id: string; kind: string } | null {
    const jobs = this.#deps.hub().jobs;
    if (!jobs) {
      return null;
    }
    const j = jobs.list(200).find((x) => LOCKING_JOBS.has(x.kind) && (x.status === 'queued' || x.status === 'working') && x.targets.includes(id));
    return j ? { job_id: j.job_id, kind: j.kind } : null;
  }

  /**
   * The line a gpio gesture presses, after every gate (D8). Throws the refusal; returns the line and the
   * fixture device to send to.
   */
  gate(dev: Device, instance: string, gesture: InputGesture): { ref: BenchLineRef; fixture: Device } {
    const hub = this.#deps.hub();
    const map = this.#deps.map();
    if (!map) {
      throw new FrError('NOT_FOUND', 'this hub has no bench file loaded, so no line is wired', {
        remediation: [{ tool: 'bench_get' }],
        details: { not_wired: true },
      });
    }
    // The bench file changed since this bench took effect: presses wait for a bench the hub can stand behind.
    const stale = gesture === 'release' ? null : (this.#deps.refusal?.() ?? null);
    if (stale) {
      throw stale;
    }
    const ref = map.line(dev.device_id, instance);
    if (!ref || !ref.line.wired || ref.line.role !== 'button') {
      const why = !map.isDut(dev.device_id) ? `${dev.alias} is not a DUT of bench ${map.bench.id}` : !ref ? `bench ${map.bench.id} has no ${instance} line on ${dev.alias}` : !ref.line.wired ? `${dev.alias} ${instance} is reserved (wired: false)` : `${dev.alias} ${instance} is a ${ref.line.role} line, not a button`;
      throw new FrError('NOT_FOUND', `${why}; layer gpio presses bench-wired button lines only`, {
        remediation: [{ tool: 'bench_get' }, { tool: 'input_simulate', args: { selector: dev.alias, instance, gesture, layer: 'inject' } }],
        details: { not_wired: true, device: dev.device_id, instance, ...(ref ? { channel: ref.line.channel, wired: ref.line.wired } : {}) },
      });
    }
    const fixture = this.#fixture(map);
    if (gesture === 'release') {
      return { ref, fixture }; // letting a line go is always safe: an offline or locked DUT is released too
    }
    const mismatch = this.channelMismatch(ref);
    if (mismatch) {
      throw refusal('INCOMPATIBLE_PROFILE', `${fixture.alias} ${ref.line.channel}: ${mismatch}, so ${dev.alias} ${instance} is not known to be wired as the bench says`, {
        problem: 'fixture_mismatch',
        device: dev.device_id,
        channel: ref.line.channel,
        fixture: fixture.device_id,
      });
    }
    const presence = hub.router.presence(dev.device_id);
    if (!isUp(presence)) {
      throw refusal('DEVICE_OFFLINE', `${dev.alias} is ${presence}`, { device: dev.device_id }, [{ tool: 'wait_for_device', args: { selector: dev.alias, state: 'online' } }]);
    }
    const allowed = map.profiles(dev.device_id);
    if (!dev.profile || !allowed.has(dev.profile)) {
      throw refusal('INCOMPATIBLE_PROFILE', `${dev.alias} runs ${dev.profile ?? 'an unknown profile'}, not its bench profile ${ref.entry.profile}: its wiring is not known to match`, {
        problem: 'profile_mismatch',
        device: dev.device_id,
        profile: dev.profile,
        bench_profile: ref.entry.profile,
      });
    }
    const job = this.#lockingJob(dev.device_id);
    if (job) {
      throw refusal('LOCKED', `${dev.alias} has a ${job.kind} job running (${job.job_id}): no presses until it ends`, { device: dev.device_id, job: job.job_id });
    }
    if (this.inCut(dev.device_id)) {
      throw refusal('LOCKED', `${dev.alias} is in a declared power-cut window: no presses until it ends`, { device: dev.device_id, power_cut: true });
    }
    if (this.running(ref.line.channel)) {
      throw refusal('DEVICE_BUSY', `a press runs on ${dev.alias} ${instance} (${fixture.alias} ${ref.line.channel})`, { device: dev.device_id, channel: ref.line.channel });
    }
    // Released by readback (open drain), or by the DUT's own mirror of its button (MOSFET gate).
    const held =
      lineDrive(ref.line) === 'nfet_gate'
        ? routerInfo(hub.router, dev.device_id)?.properties[`${instance}.pressed`] === true
        : this.lineLevel(ref.line.channel) === false;
    if (held) {
      throw refusal('DEVICE_BUSY', `${dev.alias} ${instance}: ${fixture.alias} ${ref.line.channel} reads pressed at idle (held by hand, or the DUT is unpowered)`, {
        device: dev.device_id,
        channel: ref.line.channel,
      });
    }
    return { ref, fixture };
  }

  /**
   * One gpio gesture on one DUT (D8): the gates, the fixture command, then the wait for the gesture's end.
   * The result is the inject result's per-device shape plus layer, fixture, channel and press.
   */
  async gesture(dev: Device, input: OpInput<'input_simulate'>): Promise<CommandOutcome & Record<string, unknown>> {
    const hub = this.#deps.hub();
    const gesture = input.gesture as InputGesture;
    const { ref, fixture } = this.gate(dev, input.instance, gesture);
    const channel = ref.line.channel;
    const base = { device: dev.device_id, alias: dev.alias, layer: 'gpio' as const, fixture: fixture.alias, channel };
    const timeoutMs = Math.min(input.timeout_s * 1000, PRESS_TIMEOUT_MS + 1000);
    if (gesture === 'release') {
      return this.#releaseGesture(dev, fixture, ref, base, timeoutMs);
    }
    const button = this.buttonConfig(dev, input.instance);
    const settleMs = button.debounce_ms + SETTLE_MS;
    const segments = gestureSegments(gesture, { longPressMs: button.long_press_ms, capMs: DEFAULT_CAP_MS });
    const total = segments.reduce((a, b) => a + b, 0);
    // Busy from now (a held press: until `release`, or the fixture's own cap_ms release): the gate above and
    // this mark run in one tick, so two calls cannot both press.
    const mine: Running = { dut: dev.device_id, until: Date.now() + timeoutMs + total / 1000 + settleMs, gesture };
    this.#running.set(channel, mine);
    // A bounce is no fit sample: its window runs from now until the RESULT says when the gesture ends.
    const sentHub = nowUs();
    const endBounce = gesture === 'bounce' ? this.#deps.sync.exclude(dev.device_id, sentHub, sentHub + (timeoutMs + settleMs) * 1000 + total) : null;
    // What is left of the gesture on the fixture if it did start: the line stays pressing that long at most.
    const restMs = () => Math.max(0, sentHub / 1000 + total / 1000 + settleMs - nowUs() / 1000);
    let out: CommandOutcome;
    try {
      out = await sendCommandTo(hub, fixture, channel, 'press', { segments_us: segments }, { ack: 'result', timeoutMs });
    } catch (e) {
      endBounce?.(nowUs());
      if (this.#running.get(channel) === mine) {
        if (e instanceof FrError && e.code === 'INVALID_ARGS') {
          this.#running.delete(channel); // refused before anything was sent
        } else {
          void this.#letGo(fixture, channel, dev.device_id, restMs());
        }
      }
      throw e;
    }
    if (out.status !== 'ok') {
      endBounce?.(nowUs());
      if (NOT_STARTED.has(out.status)) {
        if (this.#running.get(channel) === mine) {
          this.#running.delete(channel);
        }
        if (out.status === 'busy') {
          throw refusal('DEVICE_BUSY', `${fixture.alias} ${channel} answered busy: a press runs, or the line does not read released`, { device: dev.device_id, channel, outcome: out });
        }
        return { ...out, ...base };
      }
      // No RESULT (or a failure after the CMD went out): the press may be running on the fixture with only its
      // answer lost, so it is let go now, and the line counts as pressing until it reads released.
      if (this.#running.get(channel) === mine) {
        void this.#letGo(fixture, channel, dev.device_id, restMs());
      }
      return { ...out, ...base, released: true };
    }
    const atUs = Number(out.fields?.at_us ?? 0);
    const totalUs = Number(out.fields?.total_us ?? total);
    const clock = routerProbe(hub.router)?.clock(fixture.device_id);
    const synced = clock?.synced() === true;
    const tFix = synced ? clock!.unwrap(atUs, out.t_hub_us ?? nowUs()) : atUs;
    const tHub = Math.round(synced ? clock!.toHub(tFix) : (out.t_hub_us ?? nowUs()));
    // Now that the press edge is known, the bounce window ends with the gesture.
    endBounce?.(tHub + totalUs);
    const press = { t_fix_us: tFix, t_hub_us: tHub, segments_us: segments, total_us: totalUs };
    if (gesture === 'press') {
      return { ...out, ...base, press };
    }
    // The gesture's end, in hub time from its first press edge, and the DUT's debounce after it.
    const endMs = (tHub + totalUs - nowUs()) / 1000 + settleMs;
    if (endMs > 0) {
      await new Promise((r) => setTimeout(r, endMs));
    }
    if (this.#running.get(channel) === mine) {
      this.#running.delete(channel);
    }
    if (mine.interrupted) {
      // A release (D11) let the line go before the gesture's end: it did not make these segments.
      const { at_hub_us, reason } = mine.interrupted;
      const afterUs = Math.max(0, Math.round(at_hub_us - tHub));
      return {
        ...out,
        ...base,
        status: 'interrupted',
        error: `cut short ${Math.round(afterUs / 1000)} ms into the gesture by a release (${reason})`,
        interrupted: { reason, at_hub_us: Math.round(at_hub_us), after_us: afterUs },
        press,
      };
    }
    return { ...out, ...base, press };
  }

  /** gesture `release`: the command (once more on a timeout), then the release edge when the line was pressed. */
  async #releaseGesture(dev: Device, fixture: Device, ref: BenchLineRef, base: Record<string, unknown>, timeoutMs: number): Promise<CommandOutcome & Record<string, unknown>> {
    const hub = this.#deps.hub();
    const channel = ref.line.channel;
    const pressed = (this.running(channel) && this.#running.get(channel)?.gesture !== 'release') || this.lineLevel(channel) === pressLevel(ref.line);
    this.#interrupt(channel, 'release');
    // Waiting from before the command: the edge's batch may come right behind its RESULT.
    const edge = pressed ? (this.#deps.waitEdge?.(channel, !pressLevel(ref.line), nowUs(), timeoutMs + RELEASE_EDGE_MS) ?? null) : null;
    let out: CommandOutcome;
    try {
      out = await sendCommandTo(hub, fixture, channel, 'release', {}, { ack: 'result', timeoutMs });
      if (out.status === 'timeout') {
        out = await sendCommandTo(hub, fixture, channel, 'release', {}, { ack: 'result', timeoutMs });
      }
    } catch (e) {
      edge?.cancel();
      throw e;
    }
    // Pressing until it reads released, whatever the answer: a release that timed out twice may still land.
    this.#settle(channel, dev.device_id);
    if (out.status !== 'ok' || !edge) {
      edge?.cancel();
      return { ...out, ...base };
    }
    const deadline = setTimeout(edge.cancel, RELEASE_EDGE_MS);
    const e = await edge.wait;
    clearTimeout(deadline);
    return { ...out, ...base, ...(e ? { press: { t_fix_us: e.t_fix_us, t_hub_us: e.t_hub_us, segments_us: [], total_us: 0 } } : {}) };
  }

  /**
   * input_simulate {layer: gpio} on every selected device: per-device results, in parallel; the cursor precedes the
   * presses. Without a gesture, the analog setpoint (D7): `mv`, or `value` mapped to mV over each instance's range.
   */
  async simulate(devices: Device[], input: OpInput<'input_simulate'>, gated?: () => void): Promise<{ results: unknown[]; cursor: string }> {
    const hub = this.#deps.hub();
    const cursor = mintCursor(hub);
    if (input.gesture === undefined) {
      const mvs = devices.map((d) => input.mv ?? valueToMv(input.value ?? 0, analogRange(hub, d, input.instance)));
      devices.forEach((d, i) => this.gateAnalog(d, input.instance, mvs[i]));
      gated?.();
      const timeoutMs = Math.min(input.timeout_s * 1000, PRESS_TIMEOUT_MS + 1000);
      const results = await Promise.all(devices.map((d, i) => this.setMv(d, input.instance, mvs[i], { timeoutMs })));
      return { results, cursor };
    }
    // Gated before anything is sent: one refused device refuses the op, as invalid args do on inject. A touch
    // gesture never gets here (inputKind refuses a touch on gpio and a touch gesture without x, y).
    for (const d of devices) {
      this.gate(d, input.instance, input.gesture as InputGesture);
    }
    gated?.();
    const results = await Promise.all(devices.map((d) => this.gesture(d, input)));
    return { results, cursor };
  }

  // ---- analog lines (m2-c3-inputs D5, D7) ----

  /** The duty last applied on a pwm channel this hub run (0 after a fixture reboot), or null when not known. */
  duty(channel: string): number | null {
    return this.#duty.get(channel) ?? null;
  }

  /**
   * The analog line a setpoint drives, after its gates (D7). Throws the refusal; returns the line and the fixture.
   * mv 0 lets the line go: it needs only a wired analog line of the bench in force and the fixture.
   */
  gateAnalog(dev: Device, instance: string, mv: number): { ref: BenchLineRef; fixture: Device } {
    const hub = this.#deps.hub();
    const map = this.#deps.map();
    if (!map) {
      throw new FrError('NOT_FOUND', 'this hub has no bench file loaded, so no line is wired', { remediation: [{ tool: 'bench_get' }], details: { not_wired: true } });
    }
    const stale = mv === 0 ? null : (this.#deps.refusal?.() ?? null);
    if (stale) {
      throw stale;
    }
    const ref = map.line(dev.device_id, instance);
    if (!ref || !ref.line.wired || ref.line.role !== 'analog') {
      const why = !map.isDut(dev.device_id) ? `${dev.alias} is not a DUT of bench ${map.bench.id}` : !ref ? `bench ${map.bench.id} has no ${instance} line on ${dev.alias}` : !ref.line.wired ? `${dev.alias} ${instance} is reserved (wired: false)` : `${dev.alias} ${instance} is a ${ref.line.role} line, not an analog one`;
      throw new FrError('NOT_FOUND', `${why}; layer gpio sets bench-wired analog lines only`, {
        remediation: [{ tool: 'bench_get' }, { tool: 'input_simulate', args: { selector: dev.alias, instance, mv, layer: 'inject' } }],
        details: { not_wired: true, device: dev.device_id, instance, ...(ref ? { channel: ref.line.channel, wired: ref.line.wired } : {}) },
      });
    }
    const fixture = this.#fixture(map);
    if (mv === 0) {
      return { ref, fixture };
    }
    const mismatch = this.channelMismatch(ref);
    if (mismatch) {
      throw refusal('INCOMPATIBLE_PROFILE', `${fixture.alias} ${ref.line.channel}: ${mismatch}, so ${dev.alias} ${instance} is not known to be wired as the bench says`, {
        problem: 'fixture_mismatch',
        device: dev.device_id,
        channel: ref.line.channel,
        fixture: fixture.device_id,
      });
    }
    const presence = hub.router.presence(dev.device_id);
    if (!isUp(presence)) {
      throw refusal('DEVICE_OFFLINE', `${dev.alias} is ${presence}`, { device: dev.device_id }, [{ tool: 'wait_for_device', args: { selector: dev.alias, state: 'online' } }]);
    }
    // The line's own profile (c3o-analog): on the bench profile the DUT pin is not an ADC input.
    const want = ref.line.dut_profile ?? ref.entry.profile;
    if (dev.profile !== want) {
      throw refusal('INCOMPATIBLE_PROFILE', `${dev.alias} runs ${dev.profile ?? 'an unknown profile'}, not ${want}, the profile its ${instance} line is wired for`, {
        problem: 'profile_mismatch',
        device: dev.device_id,
        profile: dev.profile,
        bench_profile: want,
      });
    }
    const job = this.#lockingJob(dev.device_id);
    if (job) {
      throw refusal('LOCKED', `${dev.alias} has a ${job.kind} job running (${job.job_id}): no setpoints until it ends`, { device: dev.device_id, job: job.job_id });
    }
    if (this.inCut(dev.device_id)) {
      throw refusal('LOCKED', `${dev.alias} is in a declared power-cut window: no setpoints until it ends`, { device: dev.device_id, power_cut: true });
    }
    return { ref, fixture };
  }

  /**
   * The PWM setpoint of a DUT's analog line (D5, D7): gates, then `set_duty`. The result is the inject result's
   * per-device shape plus layer, fixture, channel and, when the fixture applied it, `setpoint` (mv, duty, vdd_mv,
   * applied_mv, at_fix_us, at_hub_us). Throws a gate's refusal.
   */
  async setMv(dev: Device, instance: string, mv: number, opts: { timeoutMs?: number } = {}): Promise<CommandOutcome & Record<string, unknown>> {
    const hub = this.#deps.hub();
    const { ref, fixture } = this.gateAnalog(dev, instance, mv);
    const channel = ref.line.channel;
    const vdd = this.#deps.map()!.bench.fixture.vdd_mv;
    const duty = dutyFor(mv, vdd);
    const base = { device: dev.device_id, alias: dev.alias, layer: 'gpio' as const, fixture: fixture.alias, channel };
    const out = await sendCommandTo(hub, fixture, channel, 'set_duty', { duty }, { ack: 'result', timeoutMs: opts.timeoutMs ?? PRESS_TIMEOUT_MS });
    if (out.status !== 'ok') {
      return { ...out, ...base };
    }
    this.#duty.set(channel, duty);
    const atUs = Number(out.fields?.at_us ?? 0);
    const clock = routerProbe(hub.router)?.clock(fixture.device_id);
    const synced = clock?.synced() === true;
    const atFix = synced ? clock!.unwrap(atUs, out.t_hub_us ?? nowUs()) : atUs;
    const atHub = Math.round(synced ? clock!.toHub(atFix) : (out.t_hub_us ?? nowUs()));
    const setpoint: Setpoint = { mv, duty, vdd_mv: vdd, applied_mv: Math.round((duty * vdd) / DUTY_FULL), at_fix_us: atFix, at_hub_us: atHub };
    return { ...out, ...base, setpoint };
  }

  /** `set_duty {duty: 0}` on a pwm channel without waiting for it (once more on a timeout). Never throws. */
  #zero(fixture: Device, channel: string): Promise<void> {
    const hub = this.#deps.hub();
    const once = () => sendCommandTo(hub, fixture, channel, 'set_duty', { duty: 0 }, { ack: 'result', timeoutMs: PRESS_TIMEOUT_MS });
    try {
      return once()
        .then((out) => (out.status === 'timeout' ? once() : out))
        .then(
          (out) => {
            if (out.status === 'ok') {
              this.#duty.set(channel, 0);
            }
          },
          () => undefined,
        );
    } catch {
      return Promise.resolve(); // the fixture firmware has no such channel (or no set_duty yet)
    }
  }

  // ---- releases and identify (D9, D11) ----

  /**
   * `release` on every driven line of a DUT (all DUTs without one); their presses end at once. The commands
   * go out now, in parallel; the promise settles when every one has its RESULT or failed (never rejects), so
   * the module's stop can wait for them to reach the fixture before the router closes its session.
   */
  release(dut?: string, reason = 'release'): Promise<void> {
    const map = this.#deps.map();
    if (!map) {
      return Promise.resolve();
    }
    const hub = this.#deps.hub();
    const fixture = this.#device(map.fixture);
    const up = fixture !== null && isUp(hub.router.presence(fixture.device_id)) ? fixture : null;
    const sent: Promise<unknown>[] = [];
    for (const ref of map.lines) {
      if ((dut !== undefined && ref.dut !== dut) || !ref.line.wired || lineDrive(ref.line) === 'none') {
        continue;
      }
      const channel = ref.line.channel;
      if (lineDrive(ref.line) === 'pwm') {
        if (up) {
          sent.push(this.#zero(up, channel)); // a pwm line lets go at duty 0
        }
        continue;
      }
      this.#interrupt(channel, reason);
      if (up) {
        sent.push(this.#letGo(up, channel, ref.dut));
      } else {
        // No session to send on: the fixture's 2 s rule lets it go, and its next WELCOME releases it again.
        this.#running.delete(channel);
      }
    }
    return Promise.all(sent).then(() => undefined);
  }

  /** The bus, for the releases and the identify blink. */
  onEvent(e: HubEvent): void {
    const map = this.#deps.map();
    if (!map || !e.device) {
      return;
    }
    const isFixture = e.device === map.fixture || this.#device(e.device)?.role === 'fixture';
    if (isFixture && e.type === 'device.link' && e.fields?.up === true) {
      // Before anything else on this session (the CMDs go out in order): a session that dropped and came back
      // within the fixture's 2 s rule left its presses running, and a new hub run never knew them.
      if (e.device === map.fixture) {
        void this.release(undefined, 'fixture_welcome');
      }
      this.#identify(e.device);
      return;
    }
    const restarted = e.type === 'node.boot' || (e.type === 'device.offline' && (e.fields?.reason === 'restarted' || e.fields?.reason === 'epoch_regressed'));
    if (isFixture && restarted) {
      this.#running.clear(); // the fixture boots with every line released
      this.#duty.clear(); // and every pwm line at duty 0
      return;
    }
    if (isFixture) {
      return; // offline without a reboot: its presses may still run, and its WELCOME releases them
    }
    if (map.isDut(e.device) && (e.type === 'device.offline' || e.type === 'node.boot' || e.type === 'port.detached')) {
      void this.release(e.device, e.type);
    }
  }

  #identify(id: string): void {
    const dev = this.#device(id);
    if (dev) {
      void sendCommandTo(this.#deps.hub(), dev, 'status', 'blink', { count: 3 }, { ack: 'result', timeoutMs: PRESS_TIMEOUT_MS }).catch(() => undefined);
    }
  }
}
