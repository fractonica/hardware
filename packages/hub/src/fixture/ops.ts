// bench_get (design m2-c1-hil D9; packages/protocol/src/ops/bench.ts; stream S4): the bench, the fixture
// against its pin, the fixture <-> hub clock, each line's live level and problem, each DUT's press-based
// fit, and the problems as sentences ("pad-c3b boot: fix-s3 ch1 reads low at idle"). Spread into HANDLERS
// (packages/hub/src/ops.ts); input_simulate's gpio layer reaches the module through router/ops.ts.
//
// Problems, one code per line or DUT (the first that applies):
//   - the fixture: offline; fw_mismatch (bench fixture.fw_id pinned and the fixture runs another); unpinned
//     (fixture.fw_id null: fw_ok is false, since a build tied to no pin is not the instrument the design
//     names, unless the hub runs with the explicit override FR_ANY_FIXTURE_FW=1; fw_pinned says which);
//     profile_mismatch (it runs another profile than bench fixture.profile);
//   - the bench file: changed while a press was held (it takes effect once every press has ended), or no
//     longer validates (the bench last in force stays, for releases; presses are refused): `stale`;
//   - a DUT: download_mode (its USB is present with no HELLO; judged even in a power-cut window), power_cut
//     while a gate's declared power-cut window runs (its lines and presence are not judged then, §6 rule 3, so
//     it adds no sentence), offline (said "since the fixture's last boot" when it has not been up since: after
//     a fixture power loss, D11 item 5), profile_mismatch (D7);
//   - a line: fixture_mismatch (the fixture's running build, when its artifact manifest is known, has no
//     fr.fixture instance on the channel, or drives or decodes it otherwise than the bench line: gpio presses
//     there are refused); line_low (a BOOT line pressed at idle with no press running, by readback or by
//     `boot.pressed`; a test_pin line low: that DUT is unpowered or stuck).
// `wired: false` lines are reserved: level null, state reserved, no problem. A line also says its state
// (reserved, idle, active while a press runs, low, unknown), its drive and its edge, drop, frame and bad-frame
// counts (bad_frames: WS2812 frames that were not 24 bits, never published as hil.frame; edges: as the fixture
// reported them), and on decode: level lines `glitches {repeats, pulses, corrections}`: what the timeline's
// glitch filter dropped (repeated edges, phases under GLITCH_US) and put in from the `level` STATE.

import { type BenchStatus, FrError } from '@fractonica/protocol';

import type { Device, Handler, HubContext, Presence } from '../context.ts';
import { nowUs } from '../ring.ts';
import { routerInfo, routerProbe } from '../router/index.ts';
import type { Driver } from './driver.ts';
import type { BenchSync } from './sync.ts';
import { type BenchMap, lineDrive, type Timeline } from './timeline.ts';

const isUp = (p: Presence) => p === 'online' || p === 'suspect';
/** A USB port present this long with no HELLO is taken for a DUT in download mode (D11 item 5, "Always"). */
export const DOWNLOAD_MODE_MS = 3000;

/** What bench_get reads (the fixture module, fixture/index.ts). */
export interface StatusSource {
  hub: HubContext;
  map: BenchMap;
  /** hardware/bench/<id>.bench.yaml, repo-relative. */
  file: string;
  driver: Driver;
  sync: BenchSync;
  timeline: Timeline;
  /** Date.now() ms a DUT was last seen up, from the bus. */
  lastUp: (dut: string) => number | null;
  /** Date.now() ms its USB port appeared (port.attached), or null when not seen this run. */
  usbSince: (dut: string) => number | null;
  /** Why the bench in force is not the file as it is now (fixture/index.ts), or null. */
  stale?: { reason: 'press_held' | 'invalid'; errors: string[] } | null;
  /** The explicit override that takes an unpinned bench (fixture.fw_id null) as fw_ok (FR_ANY_FIXTURE_FW=1). */
  anyFixtureFw?: boolean;
}

/** Two fw_ids, either a prefix (HELLO: 16 hex), name the same image. */
function sameFw(a: string | null, b: string | null): boolean {
  if (!a || !b) {
    return false;
  }
  const n = Math.min(a.length, b.length);
  return n >= 4 && a.slice(0, n).toLowerCase() === b.slice(0, n).toLowerCase();
}

function getDevice(hub: HubContext, id: string): Device | null {
  try {
    return hub.registry.get(id);
  } catch {
    return null;
  }
}

/** The bench status (BenchStatus). */
export function benchStatus(src: StatusSource): BenchStatus {
  const { hub, map } = src;
  const bench = map.bench;
  const problems: string[] = [];
  const presence = (id: string) => hub.router?.presence(id) ?? 'unknown';
  const aliasOf = (id: string) => getDevice(hub, id)?.alias ?? null;

  // ---- the fixture ----
  const fixId = bench.fixture.device;
  const fixDev = getDevice(hub, fixId);
  const fixAlias = fixDev?.alias ?? null;
  const fixName = fixAlias ?? fixId;
  const fixPresence = presence(fixId);
  const fixUp = isUp(fixPresence);
  const fixInfo = routerInfo(hub.router, fixId);
  const fixClock = routerProbe(hub.router)?.clock(fixId) ?? null;
  const running = fixInfo?.fw_id_prefix ?? fixDev?.fw_id ?? null;
  // The pin is what ties a run to one instrument build (D1): no pin is no match, unless explicitly overridden.
  const pinned = bench.fixture.fw_id !== null;
  const fwOk = pinned ? sameFw(running, bench.fixture.fw_id) : src.anyFixtureFw === true;
  // Its clock counts µs since its boot, so hub time of fixture time 0 is when it booted.
  const bootAt = fixInfo && fixClock?.synced() ? new Date(fixClock.toHub(0) / 1000).toISOString() : null;
  if (!fixUp) {
    problems.push(`${fixName}: the bench fixture is ${fixPresence}; after any fixture power loss, power it first, then run bench_get before touching a DUT`);
  } else if (pinned && !fwOk) {
    problems.push(`${fixName}: runs ${running ?? 'unknown firmware'}, not the bench's pinned fw_id ${bench.fixture.fw_id}`);
  } else if (!fwOk) {
    problems.push(
      `${fixName}: the bench pins no fixture fw_id: pin the build it runs (${running ?? 'unknown'}) as fixture.fw_id in ${src.file} (§5.3 step 2), or run the hub with FR_ANY_FIXTURE_FW=1`,
    );
  }
  if (src.stale?.reason === 'press_held') {
    problems.push(`${src.file} changed while a press was held: it takes effect once every press has ended; presses wait for it`);
  } else if (src.stale?.reason === 'invalid') {
    const [first, ...more] = src.stale.errors;
    problems.push(`${src.file} no longer validates (${first ?? 'unreadable'}${more.length ? `; ${more.length} more` : ''}): presses are refused until it does; this is the bench last in force`);
  }
  if (fixDev?.profile && fixDev.profile !== bench.fixture.profile) {
    problems.push(`${fixName}: runs profile ${fixDev.profile}, not the bench's ${bench.fixture.profile}`);
  }
  const ci = fixClock?.info() ?? null;
  const clock = ci
    ? {
        uncertainty_us: Math.round(ci.uncertainty_us),
        rtt_min_us: Math.round(ci.rtt_us),
        // The bursts this estimate has held through: its own and the worse ones kept since (05 §5.12.4).
        bursts: ci.kept + 1,
        age_ms: Math.max(0, Math.round((nowUs() - ci.at_us) / 1000)),
        offset_us: Math.round(ci.offset_us),
        skew_ppm: ci.skew_ppm,
        samples: ci.samples,
      }
    : null;

  // ---- the DUTs ----
  const now = Date.now();
  const fixBootMs = bootAt ? Date.parse(bootAt) : null;
  const dutProblem = new Map<string, string | null>();
  const duts = Object.entries(bench.duts).map(([id, entry]) => {
    const dev = getDevice(hub, id);
    const name = dev?.alias ?? id;
    const p = presence(id);
    const runningProfile = dev?.profile ?? null;
    let problem: string | null = null;
    const port = hub.serial?.list().find((x) => (x.device_id ?? x.usb_serial) === id && x.state === 'open');
    const serialSession = routerInfo(hub.router, id)?.links.includes('serial') === true;
    const usbAge = now - (src.usbSince(id) ?? hub.startedAt ?? now);
    // Download mode first, power-cut window or not: a DUT that latched it during the cut needs a person.
    if (port && !serialSession && !isUp(p) && usbAge >= DOWNLOAD_MODE_MS) {
      problem = 'download_mode';
      problems.push(`${name}: its USB port ${port.path} is present but it sends no HELLO: likely download mode; power-cycle it`);
    } else if (src.driver.inCut(id)) {
      problem = 'power_cut';
    } else if (!isUp(p)) {
      problem = 'offline';
      const last = src.lastUp(id);
      const sinceBoot = fixBootMs !== null && (last === null || last < fixBootMs);
      problems.push(
        sinceBoot
          ? `${name}: offline since ${fixName}'s last boot: check it is not in download mode (power-cycle it)`
          : `${name}: ${p}`,
      );
    } else if (!runningProfile || !map.profiles(id).has(runningProfile)) {
      problem = 'profile_mismatch';
      problems.push(`${name}: runs ${runningProfile ?? 'an unknown profile'}, not its bench profile ${entry.profile}: gpio presses refused, T-HIL skips it`);
    }
    dutProblem.set(id, problem);
    return {
      device: id,
      alias: dev?.alias ?? null,
      profile: entry.profile,
      running_profile: runningProfile,
      presence: p,
      problem,
      rf_weak: entry.rf_weak,
      fit: src.sync.fit(id),
    };
  });

  // ---- the lines ----
  const lines = map.lines.map((ref) => {
    const { line } = ref;
    const dutName = aliasOf(ref.dut) ?? ref.dut;
    const level = line.wired && fixUp ? src.driver.lineLevel(line.channel) : null;
    const pressing = line.wired && src.driver.running(line.channel);
    let problem: string | null = null;
    let state: 'reserved' | 'idle' | 'active' | 'low' | 'unknown' = 'unknown';
    const mismatch = line.wired && fixUp ? src.driver.channelMismatch(ref) : null;
    if (mismatch) {
      problem = 'fixture_mismatch';
      problems.push(`${dutName} ${ref.name}: ${fixName} ${line.channel}: ${mismatch}`);
    }
    if (!line.wired) {
      state = 'reserved';
    } else if (!fixUp || dutProblem.get(ref.dut) === 'profile_mismatch' || dutProblem.get(ref.dut) === 'power_cut') {
      state = 'unknown';
    } else if (line.role === 'button' || line.role === 'en') {
      const drive = lineDrive(line);
      const held = drive === 'nfet_gate' ? routerInfo(hub.router, ref.dut)?.properties[`${ref.name}.pressed`] === true : level === false;
      if (pressing) {
        state = 'active';
      } else if (held) {
        state = 'low';
        problem ??= 'line_low';
        problems.push(`${dutName} ${ref.name}: ${fixName} ${line.channel} reads ${drive === 'nfet_gate' ? 'pressed' : 'low'} at idle`);
      } else {
        state = level === null && drive !== 'nfet_gate' ? 'unknown' : 'idle';
      }
    } else if (line.role === 'test_pin') {
      if (level === false && isUp(presence(ref.dut))) {
        state = 'low';
        problem ??= 'line_low';
        problems.push(`${dutName} test_pin: ${fixName} ${line.channel} reads low at idle: ${dutName} is unpowered or stuck`);
      } else {
        state = level === null ? 'unknown' : 'idle';
      }
    } else {
      state = level === null && line.decode !== 'ws2812' ? 'unknown' : 'idle';
    }
    return {
      dut: ref.dut,
      alias: aliasOf(ref.dut),
      line: ref.name,
      role: line.role,
      channel: line.channel,
      fixture_gpio: line.fixture_gpio,
      wired: line.wired,
      level,
      problem,
      state,
      drive: lineDrive(line),
      ...(line.wired ? src.timeline.stats(line.channel) : {}),
    };
  });

  return {
    file: src.file,
    bench,
    fixture: {
      device: fixId,
      alias: fixAlias,
      presence: fixPresence,
      boot_at: bootAt,
      fw_id: running,
      fw_ok: fwOk,
      /** bench fixture.fw_id is set: fw_ok then means the fixture runs that build. */
      fw_pinned: pinned,
      profile: fixDev?.profile ?? null,
    },
    clock,
    lines,
    duts,
    problems,
    /** The bench in force is not the file as it is now (changed while a press was held, or no longer validates). */
    stale: src.stale ?? null,
    ok: fixUp && fwOk && problems.length === 0,
  };
}

/** The hub's fixture module, or NOT_FOUND (a hub run without one, or a test context). */
function fixtureOf(hub: HubContext) {
  if (!hub.fixture) {
    throw new FrError('NOT_FOUND', 'this hub runs no fixture module (no HIL bench)', { remediation: [{ tool: 'hub_status' }] });
  }
  return hub.fixture;
}

export const FIXTURE_HANDLERS: { bench_get: Handler } = {
  bench_get: (_input, hub) => fixtureOf(hub).status(),
};
