// The T2 virtual fleet (design m2-c2 D8, D13, §2.2, §3): the scenario file, tests/sim/scenarios/<id>.yaml, schema
// fractonica/sim-scenario@1, which the sim runner (tests/sim/lib/runner.ts) loads and test_run's tier sim names by id;
// and fr_fleet's contract: the spec file the runner writes for it (fractonica/fleet-spec@1), the `ready` line it
// prints, and the answers on its control channel. A scenario is thin by design: it names each run's bench module and
// its args (the gate's verdict is that module's) and adds only what the fleet must emulate. These schemas are only the
// shapes; the runner's validator checks the rest (D10's seeder rule, the aliases a run's args name).

import { z } from 'zod';

export const SIM_SCENARIO_SCHEMA = 'fractonica/sim-scenario@1';
export const FLEET_SPEC_SCHEMA = 'fractonica/fleet-spec@1';

const HEX12 = /^[0-9a-f]{12}$/;
const ALIAS = /^[a-z0-9][a-z0-9-]{0,30}$/;
/** A closed range [lo, hi]. */
const range = (v: z.ZodNumber) => z.tuple([v, v]).refine(([lo, hi]) => lo <= hi, { message: 'expected [lo, hi] with lo <= hi' });
const u16 = z.number().int().min(0).max(0xffff);
const u32 = z.number().int().min(0).max(0xffffffff);

/** The ESP-NOW PHY rates the medium models (design m2-c2 §2.1): router mode runs 1M; 6M is for C4 and C6. */
export const SIM_RATES = ['1M', '6M'] as const;
export type SimRate = (typeof SIM_RATES)[number];

/** How the medium's pair table is filled (D3). The router-mode gates are judged on one_room only (D10). */
export const SIM_TOPOLOGIES = ['one_room', 'two_rooms', 'matrix', 'positions'] as const;
export type SimTopology = (typeof SIM_TOPOLOGIES)[number];

/** One directed pair of a `matrix` medium (D3), by alias; a pair not listed is out of reach. */
export const SimPairSchema = z.strictObject({
  tx: z.string().regex(ALIAS),
  rx: z.string().regex(ALIAS),
  loss: z.number().min(0).max(1).default(0),
  rssi_dbm: z.number().int().min(-100).max(0).default(-60),
});
export type SimPair = z.infer<typeof SimPairSchema>;

/** The air (D3, D4). Ranges are drawn per pair from the scenario seed; loss is independent of RSSI. */
export const SimMediumSchema = z.strictObject({
  topology: z.enum(SIM_TOPOLOGIES).default('one_room'),
  /** Per-pair RSSI range (dBm), with up to `asymmetry_db` between the two directions of a pair. */
  rssi_dbm: range(z.number().int().min(-100).max(0)).default([-85, -45]),
  asymmetry_db: z.number().min(0).max(20).default(3),
  /** Per-frame RSSI noise: N(0, sigma) on top of the pair's RSSI. */
  rssi_sigma_db: z.number().min(0).max(20).default(0),
  /** Per-pair loss range (a fraction: 0.015 is 1.5 %), C5's bench range by default. */
  loss: range(z.number().min(0).max(1)).default([0.001, 0.015]),
  /** Chance a received frame is delivered twice. */
  dup: z.number().min(0).max(1).default(0),
  /** Reception after a frame's on-air end: U(min, max) µs (driver and task latency). */
  latency_us: range(z.number().int().min(0).max(1_000_000)).default([50, 200]),
  rate: z.strictObject({ broadcast: z.enum(SIM_RATES).default('1M'), unicast: z.enum(SIM_RATES).default('1M') }).prefault({}),
  /** Overlapping frames collide at a receiver (false: the collision-free C5 model, which the transmission bounds are gated in). */
  collisions: z.boolean().default(true),
  /** A frame this much stronger than every overlapping one survives. */
  capture_db: z.number().min(0).max(40).default(10),
  /** two_rooms: the share of cross-room pairs in reach (the rooms split the nodes in two halves). */
  cross_reach: z.number().min(0).max(1).optional(),
  /** matrix: every pair in reach, by alias. */
  pairs: z.array(SimPairSchema).optional(),
  /** positions: metres per alias, and the log-distance model (RSSI = p0 - 10 n log10(d)); uncalibrated, published runs only. */
  positions: z.record(z.string().regex(ALIAS), z.tuple([z.number(), z.number()])).optional(),
  path_loss: z.strictObject({ p0_dbm: z.number().default(-40), n: z.number().min(1).max(6).default(2.7) }).optional(),
});
export type SimMedium = z.infer<typeof SimMediumSchema>;

/** The router the Wi-Fi nodes associate with (D7): on/off, latency, loss and gaps; no CSA or channel change in C2. */
export const SimApSchema = z.strictObject({
  channel: z.number().int().min(1).max(13).default(6),
  /** Per node, drawn from the seed; a node below -90 dBm does not associate. */
  rssi_dbm: range(z.number().int().min(-100).max(0)).default([-75, -45]),
  uplink_ms: range(z.number().min(0).max(10_000)).default([0.5, 3]),
  downlink_ms: range(z.number().min(0).max(10_000)).default([0.5, 3]),
  udp_loss: z.number().min(0).max(1).default(0),
  /** Wi-Fi gaps (TCP stalls, UDP drops): `len_ms` every `every_s`; none by default. */
  gaps: z.strictObject({ every_s: z.number().positive(), len_ms: z.number().int().positive() }).nullable().default(null),
  /** The PHY rate IP frames through the AP are accounted at on channel C (Mbps). */
  phy_rate: z.number().positive().default(24),
  /** Each node's HTTP download from the hub's node port (OTA images), KB/s in wall time; 0: as fast as loopback (tens of ms for 600 KB). */
  http_kbps: z.number().min(0).max(1_000_000).default(0),
  /** Association plus DHCP after the AP comes back, drawn per node (ms). */
  assoc_ms: range(z.number().int().min(0).max(60_000)).default([1000, 3000]),
});
export type SimAp = z.infer<typeof SimApSchema>;

/**
 * One run of a scenario: a bench module (tests/e2e/<run>.ts, or tests/sim/<run>.ts) with its args, or one of the sim
 * runner's own steps (tests/sim/lib/runner.ts). In args, `sim-01..sim-30` stands for that range of aliases.
 */
export const SimRunSchema = z.strictObject({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'expected kebab-case'),
  run: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'expected a module name, e.g. t-flood'),
  args: z.array(z.string().min(1).max(200)).default([]),
  /** Reported, never gated, inside a gated scenario (T2-NN-30's running phase again under hub broadcasts). */
  published: z.boolean().default(false),
});
export type SimRun = z.infer<typeof SimRunSchema>;

/** The scenario's nodes: `count` started at the storm, then `spares` provisioned rows only a join starts. */
export const SimNodesSchema = z.strictObject({
  count: z.number().int().min(1).max(250),
  profile: z.string().min(1).default('c6-pad'),
  hb_ms: z.number().int().min(100).max(60_000).default(1000),
  /** The OTA health deadline (fr_net_node's --health-ms); T2-OTA-30 sets 10 s. */
  health_ms: z.number().int().min(1000).max(600_000).default(60_000),
  /** Nodes on the fleet's serial bridge (a USB port the hub holds), by alias. */
  usb: z.array(z.string().regex(ALIAS)).default([]),
  spares: z.number().int().min(0).max(32).default(0),
});
export type SimNodes = z.infer<typeof SimNodesSchema>;

/** A parsed scenario file (D13, example in design m2-c2 §2.2). */
export const SimScenarioSchema = z
  .strictObject({
    schema: z.literal(SIM_SCENARIO_SCHEMA),
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'expected kebab-case, e.g. t2-flood-30'),
    /** The gate it judges (T2-FLOOD-30 ...); absent on a published-only scenario. */
    gate: z.string().regex(/^[A-Z0-9][A-Z0-9-]*$/).optional(),
    summary: z.string().min(1),
    nodes: SimNodesSchema,
    seed: u32.default(1),
    medium: SimMediumSchema.prefault({}),
    ap: SimApSchema.prefault({}),
    /** The reconnect storm before the runs (§5.3): nodes start `stagger_ms` apart (0: all at once). */
    storm: z.strictObject({ stagger_ms: z.number().int().min(0).max(60_000).default(0) }).prefault({}),
    /** The fleet's own generators' pace (1: as scripted). */
    pace: z.number().positive().max(10).default(1),
    runs: z.array(SimRunSchema).min(1),
    /** Figures reported, never gated: runs only by its id, and never fails a job. */
    published: z.boolean().default(false),
  })
  .superRefine((s, ctx) => {
    const known = new Set(simAliases(s.nodes.count + s.nodes.spares));
    for (const [i, alias] of s.nodes.usb.entries()) {
      if (!known.has(alias)) {
        ctx.addIssue({ code: 'custom', path: ['nodes', 'usb', i], message: `no node ${alias} (aliases are ${simAlias(1, s.nodes.count + s.nodes.spares)} ...)` });
      }
    }
    const names = s.runs.map((r) => r.name);
    for (const [i, name] of names.entries()) {
      if (names.indexOf(name) !== i) {
        ctx.addIssue({ code: 'custom', path: ['runs', i, 'name'], message: `run name ${name} repeats` });
      }
    }
    if (!s.published && s.gate === undefined) {
      ctx.addIssue({ code: 'custom', path: ['gate'], message: 'a gated scenario names its gate (or set published: true)' });
    }
  });
export type SimScenario = z.infer<typeof SimScenarioSchema>;

/** The alias of fleet node `i` (1-based) of `total`: sim-01 ..., zero-padded to at least two digits. */
export function simAlias(i: number, total: number): string {
  return `sim-${String(i).padStart(Math.max(2, String(total).length), '0')}`;
}

/** Every alias of a fleet of `total` nodes, in order. */
export function simAliases(total: number): string[] {
  return Array.from({ length: total }, (_, k) => simAlias(k + 1, total));
}

/**
 * The MAC (device id, 12 hex) of fleet node `i` (1-based): 02:f2:00:00:xx:yy, locally administered, so no fleet node
 * can share a bench board's id (D9).
 */
export function simMac(i: number): string {
  if (!Number.isInteger(i) || i < 1 || i > 0xffff) {
    throw new RangeError(`fleet node index ${i} is outside 1..65535`);
  }
  return `02f20000${i.toString(16).padStart(4, '0')}`;
}

// ---- fr_fleet's contract (design m2-c2 §3 "The fleet's contract"; implemented by stream S2, used by S6) ----

/** One node of the fleet spec: its registry row (addr, alias, alias_rev, epoch floor) and how the fleet runs it. */
export const FleetNodeSchema = z.strictObject({
  alias: z.string().regex(ALIAS),
  mac: z.string().regex(HEX12, 'expected a 12-hex device id'),
  addr: u16,
  net: u16,
  /** This boot's epoch: the row's epoch_floor first, +1 at every reboot or power-on (the state dir keeps it). */
  epoch: u16,
  alias_rev: u32,
  /** Net::Config::rng_seed: mix(scenario seed, MAC), so heartbeats and relay jitter are not in lockstep. */
  rng_seed: u32,
  hb_ms: z.number().int().min(100).max(60_000).default(1000),
  health_ms: z.number().int().min(1000).max(600_000).default(60_000),
  /** On the fleet's serial bridge: a port the hub can open. */
  usb: z.boolean().default(false),
  /** UDP to the hub: the fleet's one shared socket, or a socket of its own. */
  udp: z.enum(['shared', 'own']).default('shared'),
  /** Runs the real fr_ota core on a memory flash (OFFERs download from the hub's node HTTP port). */
  ota: z.boolean().default(true),
  radio: z
    .strictObject({ channel: z.number().int().min(1).max(13).default(6), bcast_rate: z.enum(SIM_RATES).default('1M'), ucast_rate: z.enum(SIM_RATES).default('1M') })
    .prefault({}),
  /** The profile its HELLO, descriptor and OTA CHECK say (the registry row's). */
  profile: z.string().min(1).default('c6-pad'),
  /** A spare row (T2-CHURN-30's joins): provisioned, not started by `fleet start`, only by `fleet spawn <alias>`. */
  spare: z.boolean().default(false),
});
export type FleetNode = z.infer<typeof FleetNodeSchema>;

/** `fr_fleet --spec <file>`: written by the sim runner from a scenario and the private hub's registry. */
export const FleetSpecSchema = z
  .strictObject({
    schema: z.literal(FLEET_SPEC_SCHEMA),
    seed: u32,
    /** The fleet's own generators' pace (`fleet pace <x>` changes it). */
    pace: z.number().positive().max(10).default(1),
    /** 0: answers and 1 s counter lines only, never per-frame lines. */
    verbosity: z.number().int().min(0).max(3).default(0),
    /** Where the nodes' blobs, flash and epochs persist across power cycles and fleet restarts within one run. */
    state_dir: z.string().min(1),
    medium: SimMediumSchema,
    ap: SimApSchema,
    nodes: z.array(FleetNodeSchema).min(1),
  })
  .superRefine((s, ctx) => {
    for (const key of ['alias', 'mac', 'addr'] as const) {
      const seen = new Set<string | number>();
      for (const [i, n] of s.nodes.entries()) {
        if (seen.has(n[key])) {
          ctx.addIssue({ code: 'custom', path: ['nodes', i, key], message: `${key} ${n[key]} repeats` });
        }
        seen.add(n[key]);
      }
    }
  });
export type FleetSpec = z.infer<typeof FleetSpecSchema>;

const hostPort = z.string().regex(/^127\.0\.0\.1:\d{1,5}$/, 'expected 127.0.0.1:<port>');

/**
 * The one line fr_fleet prints once its control and bridge listeners are open, before any node starts (they start
 * on `fleet start`, so the private hub can start with --serial-bridge pointing at `bridge` first).
 */
export const FleetReadySchema = z.looseObject({
  fleet: z.literal('ready'),
  nodes: z.number().int().min(0),
  control: hostPort,
  bridge: hostPort,
  /** RLIMIT_NOFILE: the soft limit fr_fleet raised to min(hard, need). */
  nofile: z.strictObject({ soft: z.number().int(), hard: z.number().int(), need: z.number().int() }),
  /** Built with ASan/UBSan: its timing never satisfies a T2 gate (design m2-c2 §5.6). */
  sanitized: z.boolean(),
});
export type FleetReady = z.infer<typeof FleetReadySchema>;

/**
 * Control lines, on stdin or the control port: `[@<rid>] <target> <command...>`, target a node alias, `*` (every
 * started node) or `fleet`:
 * - `@<rid> fleet start <hub host> <tcp> <udp> <http> [--stagger-ms n]`;
 * - `@<rid> fleet stats|medium|ap off|ap on|spawn <alias>|pace <x>|quit` (stats carries the lag histogram and the
 *   nodes' arrival skew);
 * - `@<rid> <alias|*> <command>`: fr_net_node's stdin commands, plus `diag <line>` (NodeDiag's answer, as
 *   fr.diag.exec gives it), `power off|on`, `usb attach|detach` and `log <L> <tag> <text>`.
 * Each node answers one line; a `*` command ends with FleetDoneSchema's line.
 */
export const FleetAnswerSchema = z.looseObject({
  rid: z.string().optional(),
  node: z.string(),
  ok: z.boolean(),
});
export type FleetAnswer = z.infer<typeof FleetAnswerSchema>;

/** After every node answered a `*` command: `n` answers. */
export const FleetDoneSchema = z.looseObject({
  rid: z.string().optional(),
  done: z.literal(true),
  n: z.number().int().min(0),
});
export type FleetDone = z.infer<typeof FleetDoneSchema>;
