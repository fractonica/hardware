// T-PROV (spec 10 §10.5; 06 §6.3-6.4; how it first passed: docs/spikes/2026-10-22-c4-ota.md): provision each
// M1 board from blank (detect, Wi-Fi network, profile, alias, flash, join): online and provisioned within 60 s
// each; its identity survives an app reflash and an OTA; a rename propagates (alias_rev). On the bench (11
// §11.1: the C3s and the C6, one board after another; the S3 joins with --new once it has an s3l-pad build):
//
//   node --conditions=@fractonica/source tests/e2e/t-prov.ts --allow-erase
//   node --conditions=@fractonica/source tests/e2e/t-prov.ts --allow-erase --devices pad-c3b
//   node --conditions=@fractonica/source tests/e2e/t-prov.ts --new pad-s3:94a99015cecc:s3l-pad
//   node --conditions=@fractonica/source tests/e2e/t-prov.ts --phase reflash,ota,rename --devices pad-c6
//
// Phases, per board:
//   provision: with --allow-erase the whole flash is erased first, through a serial lease: `fr serial lease
//      <dev> --ttl 300 -- <pytools python> -m esptool --port $FR_PORT erase-flash` (the hub's pytools venv,
//      FR_HOME/pytools/bin/python, or --python). Then device_provision {port, alias: the same}. Pass: wifi
//      joined within 60 s of the call (C4: 12.3 s C3 #1, 14.6 s C6); the registry identity reused (device id,
//      addr, alias); epoch_floor above the board's last epoch (C4: 28) and the new boot's epoch after it; the
//      node's diag info PROVISIONED with that alias and addr. A provisioned board is never erased without
//      --allow-erase: the phase is then not run, and the gate cannot pass (it needs the boards blank). A board
//      named with --new (alias:port[:profile]; one the registry does not know as provisioned) is provisioned
//      from whatever it runs, after an erase too with --allow-erase.
//   reflash:   flash_start {plan: app} over USB; after the new boot the registry identity (addr, alias,
//      alias_rev, net, profile) and the node's own are unchanged.
//   ota:       ota_deploy {via: wifi, force: true}: the image it runs, so a real download, reboot and health
//      gate; identity unchanged after it.
//   rename:    device_update {alias: <alias>-rn}, then back (C4: pad-c3b -> pad-c3-blue -> pad-c3b): each
//      bumps alias_rev by one and reaches the node at once (its diag info alias, else its `alias <a> (rev N)`
//      log line; alias_pushed).
// RSSI (HEARTBEAT rssi_ap) is reported per board, with a warning below -70 dBm (the C3s' 8.5 dBm cap).
//
// No bench state left behind: a rename is undone in a finally (else the log names `fr devices set`); a board
// erased and not provisioned (its provisioning failed) gets flash_start {plan: recover}, the registry's
// identity written back; a cancelled run cancels its OTA job but lets a serial flash or a provisioning finish
// at the hub (cutting either short leaves the board without firmware), and says so. Run on its own
// (lib/runner.ts runStandalone; --hub URL, --json); under tests/e2e/run.ts (test_run) FR_T_PROV_ARGS holds
// the flags, and without --allow-erase there the gate fails without erasing anything.

import { existsSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

import type { Job } from '@fractonica/protocol';

import { runStandalone } from './lib/runner.ts';
import {
  defaultPython,
  eraseFlash,
  followJob,
  jobBody,
  jobError,
  nodeInfo,
  noteRssi,
  type OtaRow,
  type Snapshot,
  snapshot,
  startJob,
  waitNewBoot,
} from './lib/prov-ota-bench.ts';
import { identityChanges, nodeIdentityChanges, parseNewBoard, parsePhases, type ProvisionResult, provisionVerdict, renameTarget } from './lib/prov-ota-checks.ts';
import { defineScenario, type Outcome, type ScenarioCtx } from './lib/scenario.ts';
import { sleep } from './lib/tasks.ts';

const PHASES = ['provision', 'reflash', 'ota', 'rename'] as const;
type Phase = (typeof PHASES)[number];

export interface TProvOptions {
  phases: Phase[];
  /** Provisioned boards, by alias (default the M1 boards). */
  devices: string[];
  /** Boards the registry does not know as provisioned (--new alias:port[:profile]). */
  fresh: { alias: string; port: string; profile?: string }[];
  /** Erase each board's flash before provisioning it (destructive; the registry keeps the identity). */
  allowErase: boolean;
  /** The Python that runs esptool; default the hub's pytools venv. */
  python: string | null;
  renameSuffix: string;
  /** The gate's bound to online over Wi-Fi. */
  maxOnlineS: number;
}

export const DEFAULTS: TProvOptions = {
  phases: [...PHASES],
  devices: ['pad-c3', 'pad-c3b', 'pad-c6'],
  fresh: [],
  allowErase: false,
  python: null,
  renameSuffix: '-rn',
  maxOnlineS: 60,
};

/** The harness's own flags (the runner takes --allow-human, --hub and --json); anything else throws. */
export function parseArgs(argv: string[]): TProvOptions {
  const o: TProvOptions = { ...DEFAULTS, phases: [...DEFAULTS.phases], devices: [...DEFAULTS.devices], fresh: [] };
  let devicesGiven = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) {
        throw new Error(`t-prov: ${a} needs a value`);
      }
      return v;
    };
    switch (a) {
      case '--phase':
        o.phases = parsePhases('t-prov', value(), PHASES);
        break;
      case '--devices':
        o.devices = value().split(',').filter(Boolean);
        devicesGiven = true;
        break;
      case '--new':
        o.fresh.push(parseNewBoard(value()));
        break;
      case '--allow-erase':
        o.allowErase = true;
        break;
      case '--python':
        o.python = value();
        break;
      case '--rename-suffix': {
        const s = value();
        if (!/^-[a-z0-9-]{1,8}$/.test(s)) {
          throw new Error(`t-prov: --rename-suffix takes -<1..8 of a-z 0-9 ->, not ${JSON.stringify(s)}`);
        }
        o.renameSuffix = s;
        break;
      }
      case '--max-online-s': {
        const n = Number(value());
        if (!Number.isFinite(n) || n <= 0) {
          throw new Error('t-prov: --max-online-s takes a number of seconds');
        }
        o.maxOnlineS = n;
        break;
      }
      default:
        throw new Error(`t-prov: unknown option ${a} (--phase, --devices, --new, --allow-erase, --python, --rename-suffix, --max-online-s)`);
    }
  }
  // --new alone runs the new boards only.
  if (o.fresh.length && !devicesGiven) {
    o.devices = [];
  }
  return o;
}

/** One board of the run. */
interface Board {
  alias: string;
  /** --new: the USB serial (or /dev path) of a board the registry does not know as provisioned. */
  port?: string;
  profile?: string;
  fresh: boolean;
}

/** What the run changed on a board, for its finally. */
interface BoardState {
  id: string | null;
  /** The alias it had; a rename that did not come back is undone to it. */
  alias: string;
  renamedTo: string | null;
  erased: boolean;
  /** Provisioning went on at the hub when this run stopped waiting (it finishes there). */
  provisionRunning: boolean;
  provisioned: boolean;
  /** The registry has it as provisioned (so flash_start {plan: recover} can restore it). */
  known: boolean;
}

type PhaseResult = Record<string, unknown> & { pass: boolean };

const isHex12 = (s: string | undefined) => !!s && /^[0-9a-f]{12}$/.test(s);
const ms = (t0: number) => Math.round(performance.now() - t0);

// ---- provision ----

async function provisionPhase(ctx: ScenarioCtx, o: TProvOptions, b: Board, snap: Snapshot | null, state: BoardState): Promise<PhaseResult> {
  // The registry identity to reuse: a provisioned row. A HELLO-only row (provisioned false) is a first provisioning.
  const before = snap?.reg.provisioned ? snap : null;
  if (!o.allowErase && before) {
    return { pass: false, skipped: `from blank needs --allow-erase (it erases ${b.alias}'s whole flash; the registry keeps its identity)` };
  }
  const port = before ? before.reg.device_id : (b.port ?? snap?.reg.device_id);
  if (!port) {
    return { pass: false, error: `no USB port for ${b.alias}` };
  }
  const out: Record<string, unknown> = { from: o.allowErase ? 'erased' : 'unprovisioned', port };
  if (o.allowErase) {
    // Taken as erased from the moment esptool may have started: a half-erased board needs the recovery too.
    state.erased = true;
    const er = await eraseFlash(ctx, before ? `id:${before.reg.device_id}` : port, o.python ?? defaultPython());
    out.erase = { ms: er.ms, exit: er.code };
    ctx.signal.throwIfAborted();
    if (er.code !== 0) {
      return { ...out, pass: false, error: `erase failed (exit ${er.code}): ${er.tail.join(' | ')}` };
    }
    if (before) {
      // Its flash is blank and the ROM loops: the hub sees it go once its heartbeats stop.
      const off = await ctx.hub.call('wait_for_device', { selector: `id:${before.reg.device_id}`, state: 'offline', timeout_s: 30 }, undefined, ctx.signal);
      out.offline_after_erase = off.ok;
    }
  }
  const t0 = performance.now();
  state.provisionRunning = true;
  const { job } = await startJob(ctx, 'device_provision', { port, alias: b.alias, ...(b.profile ? { profile: b.profile } : {}) });
  const done = await followJob(ctx, job, { cancelOnAbort: false, timeoutMs: 5 * 60_000 });
  state.provisionRunning = false;
  const toOnlineMs = ms(t0);
  out.job_id = job.job_id;
  if (done.status !== 'completed') {
    return { ...out, pass: false, to_online_ms: toOnlineMs, error: jobError(done) };
  }
  const r = done.result as ProvisionResult;
  state.provisioned = true;
  state.known = true;
  state.id = r.device_id;
  const after = await waitNewBoot(ctx, r.device_id, before?.epoch ?? null, 30_000, { diag: true });
  const v = provisionVerdict(r, {
    before: before?.reg ?? null,
    beforeEpoch: before?.epoch ?? null,
    alias: b.alias,
    toOnlineMs,
    newEpoch: after?.epoch ?? null,
    maxMs: o.maxOnlineS * 1000,
  });
  const problems = [...v.problems];
  if (!after) {
    problems.push('not up on a new boot within 30 s of the provisioning');
  } else {
    problems.push(...nodeIdentityChanges(after.reg, after.node));
    if (after.hello_provisioned === false) {
      problems.push('its HELLO says it is not provisioned');
    }
  }
  return {
    ...out,
    pass: problems.length === 0,
    to_online_ms: toOnlineMs,
    duration_ms: r.duration_ms,
    wifi: r.wifi,
    device_id: r.device_id,
    addr: r.addr,
    alias: r.alias,
    alias_rev: r.alias_rev,
    reused: before ? { addr: before.reg.addr === r.addr, alias: before.reg.alias === r.alias } : null,
    epoch: { before: before?.epoch ?? null, floor: r.epoch_floor, after: after?.epoch ?? null },
    build_id: r.build_id,
    ...(after ? { rssi: after.rssi, node: after.node ?? after.node_error } : {}),
    ...(problems.length ? { problems } : {}),
  };
}

// ---- reflash and OTA: identity across them ----

function survived(before: Snapshot, after: Snapshot | null): string[] {
  if (!after) {
    return ['not up on a new boot'];
  }
  return [...identityChanges(before.reg, after.reg), ...nodeIdentityChanges(after.reg, after.node)];
}

async function reflashPhase(ctx: ScenarioCtx, id: string): Promise<PhaseResult> {
  const before = await snapshot(ctx, `id:${id}`);
  if (before.port_state !== 'open') {
    return { pass: false, error: `${before.reg.alias} is not on a USB port the hub holds open (${before.port_state ?? 'no port'})` };
  }
  const t0 = performance.now();
  const { job } = await startJob(ctx, 'flash_start', { device: `id:${id}`, plan: 'app' });
  const done = await followJob(ctx, job, { cancelOnAbort: false, timeoutMs: 5 * 60_000 });
  if (done.status !== 'completed') {
    return { pass: false, job_id: job.job_id, error: jobError(done) };
  }
  const flashMs = ms(t0);
  const after = await waitNewBoot(ctx, id, before.epoch, 60_000, { diag: true });
  const problems = survived(before, after);
  return {
    pass: problems.length === 0,
    job_id: job.job_id,
    flash_ms: flashMs,
    back_ms: ms(t0),
    epoch: { before: before.epoch, after: after?.epoch ?? null },
    fw: after?.fw?.slice(0, 12) ?? null,
    identity: { addr: after?.reg.addr, alias: after?.reg.alias, alias_rev: after?.reg.alias_rev, node: after?.node ?? after?.node_error },
    ...(problems.length ? { problems } : {}),
  };
}

async function otaPhase(ctx: ScenarioCtx, id: string): Promise<PhaseResult> {
  const before = await snapshot(ctx, `id:${id}`);
  const t0 = performance.now();
  // force: the image it runs (REJECT same_fw otherwise), so a real download, reboot and health gate.
  const { job } = await startJob(ctx, 'ota_deploy', { selector: `id:${id}`, via: 'wifi', force: true });
  const done = await followJob(ctx, job, { cancelOnAbort: true, timeoutMs: 10 * 60_000 });
  const row = jobBody<{ devices: OtaRow[] }>(done)?.devices?.find((d) => d.device === id);
  if (row?.state !== 'SUCCEEDED') {
    return { pass: false, job_id: job.job_id, state: row?.state ?? null, error: jobError(done) };
  }
  const after = await waitNewBoot(ctx, id, before.epoch, 60_000, { diag: true });
  const problems = survived(before, after);
  return {
    pass: problems.length === 0,
    job_id: job.job_id,
    ota_ms: ms(t0),
    attempt: row.attempt,
    timings_ms: row.timings_ms,
    epoch: { before: before.epoch, after: after?.epoch ?? null },
    identity: { addr: after?.reg.addr, alias: after?.reg.alias, alias_rev: after?.reg.alias_rev, node: after?.node ?? after?.node_error },
    rssi: after?.rssi ?? before.rssi,
    ...(problems.length ? { problems } : {}),
  };
}

// ---- rename ----

/**
 * Whether the node took `alias` (06 §6.3 renames: fr.node.set_alias): its diag info alias, polled for up to
 * `timeoutMs`; for a node whose info has no alias, its `alias <a> (rev N)` log line (fr_core) since `since`.
 * null when neither can say.
 */
async function nodeTook(ctx: ScenarioCtx, id: string, alias: string, since: string, timeoutMs: number): Promise<{ seen: boolean | null; via?: string; ms?: number }> {
  const t0 = performance.now();
  let reportsAlias = false;
  for (;;) {
    const n = await nodeInfo(ctx, id);
    if (n.info?.alias !== undefined) {
      reportsAlias = true;
      if (n.info.alias === alias) {
        return { seen: true, via: `diag info (${n.via})`, ms: ms(t0) };
      }
    } else {
      const logs = await ctx.hub.call<{ lines: { text: string }[] }>('logs_read', { selector: `id:${id}`, since, grep: `alias ${alias} (rev`, direction: 'forward', max_lines: 5 }, undefined, ctx.signal);
      if (logs.ok && logs.data!.lines.length) {
        return { seen: true, via: 'log', ms: ms(t0) };
      }
    }
    if (performance.now() - t0 > timeoutMs) {
      return reportsAlias ? { seen: false, ms: ms(t0) } : { seen: null };
    }
    await sleep(250, ctx.signal);
  }
}

async function renamePhase(ctx: ScenarioCtx, o: TProvOptions, id: string, state: BoardState): Promise<PhaseResult> {
  const before = await snapshot(ctx, `id:${id}`);
  const orig = before.reg.alias;
  state.alias = orig;
  const tmp = renameTarget(orig, o.renameSuffix);
  const steps: Record<string, unknown>[] = [];
  let pass = true;
  for (const [to, rev] of [
    [tmp, before.reg.alias_rev + 1],
    [orig, before.reg.alias_rev + 2],
  ] as const) {
    const r = await ctx.hub.call<{ alias: string; alias_rev: number; alias_pushed?: boolean }>('device_update', { device: `id:${id}`, alias: to }, undefined, ctx.signal);
    if (!r.ok) {
      steps.push({ to, error: `${r.error?.code} ${r.error?.message}` });
      pass = false;
      break;
    }
    state.renamedTo = to === orig ? null : to;
    const node = await nodeTook(ctx, id, to, r.cursor, 5000);
    const ok = r.data!.alias_rev === rev && r.data!.alias_pushed === true && node.seen !== false;
    pass &&= ok;
    steps.push({ to, alias_rev: r.data!.alias_rev, want_rev: rev, alias_pushed: r.data!.alias_pushed ?? null, node: node.seen, ...(node.via ? { node_via: node.via, node_ms: node.ms } : {}) });
  }
  const unread = steps.some((s) => s.node === null);
  return {
    pass,
    alias: orig,
    via: tmp,
    alias_rev: { before: before.reg.alias_rev, after: (steps.at(-1)?.alias_rev as number | undefined) ?? null },
    steps,
    ...(unread ? { note: "the node's alias could not be read back (no alias in its diag info, no USB log line)" } : {}),
  };
}

// ---- one board ----

async function runBoard(ctx: ScenarioCtx, o: TProvOptions, b: Board): Promise<{ pass: boolean; measured: Record<string, unknown> }> {
  const measured: Record<string, unknown> = {};
  const warnings: string[] = [];
  let snap: Snapshot | null = null;
  if (!b.fresh) {
    snap = await snapshot(ctx, b.alias, { diag: true });
  } else if (isHex12(b.port)) {
    // A board that said HELLO has a row (provisioned false) under its MAC; one that never did has none.
    snap = await snapshot(ctx, `id:${b.port}`, { diag: true }).catch(() => null);
  }
  if (snap) {
    noteRssi(ctx, snap, warnings);
    measured.rssi = snap.rssi;
  }
  const state: BoardState = {
    id: snap?.reg.device_id ?? null,
    alias: snap?.reg.alias ?? b.alias,
    renamedTo: null,
    erased: false,
    provisionRunning: false,
    provisioned: false,
    known: snap?.reg.provisioned ?? false,
  };
  const results: boolean[] = [];
  const record = (phase: Phase, r: PhaseResult) => {
    measured[phase] = r;
    results.push(r.pass);
    ctx.log(`${b.alias} ${phase}: ${r.pass ? 'ok' : `FAILED ${String(r.error ?? r.skipped ?? (r.problems as string[] | undefined)?.join('; ') ?? '')}`}`);
  };
  const guarded = async (phase: Phase, fn: () => Promise<PhaseResult>) => {
    try {
      record(phase, await fn());
    } catch (e) {
      ctx.signal.throwIfAborted();
      record(phase, { pass: false, error: (e as Error).message });
    }
  };
  try {
    if (o.phases.includes('provision')) {
      await guarded('provision', () => provisionPhase(ctx, o, b, snap, state));
    }
    for (const phase of ['reflash', 'ota', 'rename'] as const) {
      if (!o.phases.includes(phase)) {
        continue;
      }
      const id = state.id;
      if (!id || !(state.known || state.provisioned)) {
        record(phase, { pass: false, error: `${b.alias} is not provisioned` });
        continue;
      }
      await guarded(phase, () => (phase === 'reflash' ? reflashPhase(ctx, id) : phase === 'ota' ? otaPhase(ctx, id) : renamePhase(ctx, o, id, state)));
    }
  } finally {
    await cleanup(ctx, b, state, measured);
  }
  if (warnings.length) {
    measured.warnings = warnings;
  }
  return { pass: results.length > 0 && results.every(Boolean), measured };
}

/** Undoes a rename that did not come back, and recovers a board left erased. Logs what it could not do. */
async function cleanup(ctx: ScenarioCtx, b: Board, state: BoardState, measured: Record<string, unknown>): Promise<void> {
  if (state.renamedTo && state.id) {
    const r = await ctx.hub.call('device_update', { device: `id:${state.id}`, alias: state.alias }, 5000);
    ctx.log(r.ok ? `${b.alias}: alias ${state.renamedTo} put back to ${state.alias}` : `could not put ${state.renamedTo} back to ${state.alias} (${r.error?.code} ${r.error?.message}); by hand: fr devices set id:${state.id} --alias ${state.alias}`);
    measured.alias_restored = r.ok;
  }
  if (state.erased && !state.provisioned && !state.provisionRunning) {
    if (!state.known || !state.id) {
      ctx.log(`${b.alias} was erased and is not provisioned; provision it by hand: fr devices provision --port ${b.port ?? state.id} --alias ${b.alias}`);
      return;
    }
    // The registry has its identity: the full image plus fr_ident, as after any erase-flash (06 §6.4 plan recover).
    const r = await ctx.hub.call<Job>('flash_start', { device: `id:${state.id}`, plan: 'recover', wait_s: 0 }, 10_000);
    if (!r.ok) {
      ctx.log(`${b.alias} was erased and is not provisioned; flash_start recover failed (${r.error?.code} ${r.error?.message}); by hand: fr flash id:${state.id} --plan recover`);
      measured.recover = { started: false, error: r.error?.code };
      return;
    }
    ctx.log(`${b.alias} was erased and is not provisioned: flash_start recover ${r.data!.job_id} started (fr jobs wait ${r.data!.job_id})`);
    measured.recover = { started: true, job_id: r.data!.job_id };
    if (!ctx.signal.aborted) {
      const done = await followJob(ctx, r.data!, { cancelOnAbort: false, timeoutMs: 5 * 60_000 }).catch((e: Error) => e);
      measured.recover = { job_id: r.data!.job_id, status: done instanceof Error ? done.message : done.status };
    }
  }
}

// ---- the gate ----

/**
 * Checks every board before touching any (a typo must not leave the first board erased): a provisioned
 * board must be in the registry, and with an erase on a USB port the hub holds open; a --new board's port
 * must be one the hub sees.
 */
async function precheck(ctx: ScenarioCtx, o: TProvOptions, boards: Board[]): Promise<void> {
  const problems: string[] = [];
  const erasing = o.allowErase && o.phases.includes('provision');
  const python = o.python ?? defaultPython();
  if (erasing && !existsSync(python)) {
    problems.push(`no Python for esptool at ${python} (the hub's pytools venv: fr doctor --fix; or --python)`);
  }
  const ports = (await ctx.hub.ok<{ ports: { path: string; usb_serial?: string; device_id?: string; state: string }[] }>('port_list', {}, undefined, ctx.signal)).ports;
  for (const b of boards) {
    if (b.fresh) {
      if (!ports.some((p) => p.usb_serial === b.port || p.device_id === b.port || p.path === b.port)) {
        problems.push(`${b.alias}: no USB port ${b.port} on this Mac`);
      }
      continue;
    }
    const r = await ctx.hub.call<{ device_id: string; provisioned: boolean; port_state?: string }>('device_get', { device: b.alias }, undefined, ctx.signal);
    if (!r.ok) {
      problems.push(`${b.alias}: ${r.error?.code} ${r.error?.message}`);
    } else if (erasing && r.data!.port_state !== 'open') {
      problems.push(`${b.alias}: not on a USB port the hub holds open (${r.data!.port_state ?? 'no port'}), so it cannot be provisioned after the erase`);
    }
  }
  if (problems.length) {
    throw new Error(`t-prov: ${problems.join('; ')}`);
  }
}

export async function runTProv(ctx: ScenarioCtx, o: TProvOptions): Promise<Outcome> {
  const boards: Board[] = [...o.devices.map((alias) => ({ alias, fresh: false })), ...o.fresh.map((f) => ({ ...f, fresh: true }))];
  if (!boards.length) {
    throw new Error('t-prov: no boards (--devices or --new)');
  }
  await precheck(ctx, o, boards);
  const measured: Record<string, unknown> = { phases: o.phases, erase: o.allowErase };
  let pass = true;
  for (const b of boards) {
    ctx.signal.throwIfAborted();
    ctx.log(`${b.alias}: ${o.phases.join(', ')}${o.allowErase && o.phases.includes('provision') ? ' (from blank: its flash is erased first)' : ''}`);
    const r = await runBoard(ctx, o, b);
    ctx.measure(b.alias, r.measured);
    measured[b.alias] = r.measured;
    pass &&= r.pass;
  }
  return { pass, measured, evidence: { boards: boards.map((b) => b.alias), phases: o.phases, erase: o.allowErase } };
}

const scenario = defineScenario({
  gate: 'T-PROV',
  title: 'each board provisioned from blank online within 60 s; identity survives an app reflash and an OTA; a rename propagates',
  needs: { usb: true },
  usage: `--phase provision|reflash|ota|rename|all   comma-separated (default all)
--devices pad-c3,pad-c3b,pad-c6   provisioned boards, by alias (default these, one after another)
--new alias:port[:profile]   a board not provisioned yet, e.g. pad-s3:94a99015cecc:s3l-pad (repeatable; alone, only these)
--allow-erase                erase each board's whole flash first (destructive; needed for "from blank")
--python PATH                the Python that runs esptool (default FR_HOME/pytools/bin/python)
--rename-suffix -rn          the temporary alias is <alias><suffix>
--max-online-s 60            the bound from the provisioning call to online over Wi-Fi
under tests/e2e/run.ts (test_run), FR_T_PROV_ARGS holds these`,
  run: (ctx) => runTProv(ctx, parseArgs(ctx.args?.length ? ctx.args : (process.env.FR_T_PROV_ARGS ?? '').split(/\s+/).filter(Boolean))),
});
export default scenario;

if (import.meta.main) {
  await runStandalone(scenario, import.meta.dirname);
}
