// T-PRES (spec 05 §5.18): "Unplug a node; send BYE (fr.node.reboot); block UDP (diag net udp_block 30)".
// Pass: offline 2.4–3.5 s after the unplug (default heartbeat); immediate on BYE; a `udp_blocked` warning
// with no false offline (the hub's own TCP heartbeat is the keepalive), cleared when UDP resumes. On the
// bench (11 §11.1: the C3 and the C6; pad-s3 too once provisioned), every board on the Mac's USB:
//
//   node --conditions=@fractonica/source tests/e2e/t-pres.ts --phase bye,udp --devices pad-c3,pad-c3b,pad-c6,pad-s3
//   node --conditions=@fractonica/source tests/e2e/t-pres.ts --phase unplug --devices pad-c3,pad-c6 --say
//
// Phases, as at C3 (spike 2026-10-21-c3-hub-link, T-PRES), in this order:
//   bye (no person; boards one after another): `--reboots 5` times fr.node.reboot with ack result: RESULT
//          ok, device.offline {reason: reboot} within --bye-max-ms (1,000) of the send on the hub's clock
//          (a heartbeat timeout would take 2.5 s more and say `timeout`), node.boot, device.online again.
//          C3: "TCP and serial end together with offline: reboot at once; node.boot 0.6 s later; RESULT ok
//          in 5 of 5 reboots".
//   udp (no person; boards side by side): the board must be online on Wi-Fi with UDP (udp_ok); `diag net
//          udp_block 30`, then device_get every 250 ms: hub.warning {code: udp_blocked} for the board, no
//          device.offline and no offline sample while it lasts, udp_blocked false again within 5 s of the
//          hook's end. Reported: the warning's delay (C3: ≈ 10 s), the longest gap between frames (C3: TCP
//          frames < 1 s apart), device.suspect events and diag stats delivery_failed (C6: 0). A run that
//          stops early ends the hook (`net udp_block 0`, retried once; else the log says the fr diag).
//   unplug (a person; boards one after another): node.identify blinks the board, prompt_human "Unplug
//          <alias>'s USB cable" (the dashboard toast; `sk say` with --say), then the board's events: the
//          unplug is the hub's port.detached or the serial session ending `usb port gone`, then
//          device.suspect and device.offline {reason: timeout}; offline must come 2.4–3.5 heartbeats after
//          it (C6: 2.76 s; the C3 3.52 s after its last frame on older hub code). Then "Plug <alias> back
//          in": device.online, and the TCP link (C6: back over TCP ≈ 9 s after the replug).
// Each board's results carry its RSSI (below -70 dBm is logged: the C3 uplink dominates). A board the hub
// does not know (pad-s3 before it is provisioned) fails on its own.
//
// Run on its own (lib/runner.ts runStandalone: --allow-human is implied; --hub URL, --json); under
// tests/e2e/run.ts (test_run) FR_T_PRES_ARGS holds the same flags, and without --allow-human the whole
// gate is skipped (the unplug needs a person). The verdicts are lib/led-pres-checks.ts.

import { performance } from 'node:perf_hooks';

import type { HubEvent } from '@fractonica/protocol';

import {
  asker,
  type Board,
  diag,
  eventsSince,
  linkInfo,
  listFlag,
  numberFlag,
  promptedWait,
  resolveBoards,
  rssiNote,
  send,
  summary,
  transient,
  waitEvent,
} from './lib/led-pres-bench.ts';
import { type ByeRun, byeProblems, byeRun, replugTimings, udpProblems, unplugTimings, unplugVerdict } from './lib/led-pres-checks.ts';
import { runStandalone } from './lib/runner.ts';
import { defineScenario, type Outcome, type ScenarioCtx } from './lib/scenario.ts';
import { allOrAbort, retrying, sleep } from './lib/tasks.ts';

export type PresPhase = 'bye' | 'udp' | 'unplug';
const PHASES: readonly PresPhase[] = ['bye', 'udp', 'unplug'];

export interface TPresOptions {
  /** Aliases; default every online device. */
  devices?: string[];
  phases: PresPhase[];
  reboots: number;
  /** "Immediate on BYE": device.offline within this of the reboot's send (hub clock). */
  byeMaxMs: number;
  /** `net udp_block <s>`: long enough for the hub's 10 s rule, as at C3. */
  udpBlockS: number;
  /** udp_blocked must read false again within this of the hook's end. */
  clearMaxMs: number;
  /** How many times a person is asked (110 s each) before the board fails. */
  promptTries: number;
  /** Speak each request with `sk say` (and again every 10 min). */
  say: boolean;
}

export const DEFAULTS: TPresOptions = { phases: ['bye', 'udp', 'unplug'], reboots: 5, byeMaxMs: 1000, udpBlockS: 30, clearMaxMs: 5000, promptTries: 3, say: false };

/** The harness's own flags (the runner takes --allow-human, --hub and --json); anything else throws. */
export function parseArgs(argv: string[]): TPresOptions {
  const o: TPresOptions = { ...DEFAULTS, phases: [...DEFAULTS.phases] };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i + 1];
    switch (argv[i]) {
      case '--phase':
        o.phases = listFlag('t-pres', '--phase', v, PHASES);
        i++;
        break;
      case '--devices':
        o.devices = (v ?? '').split(',').filter(Boolean);
        if (!o.devices.length) {
          throw new Error('t-pres: --devices takes aliases, comma-separated');
        }
        i++;
        break;
      case '--reboots':
        o.reboots = numberFlag('t-pres', '--reboots', v, 1);
        i++;
        break;
      case '--bye-max-ms':
        o.byeMaxMs = numberFlag('t-pres', '--bye-max-ms', v, 1);
        i++;
        break;
      case '--udp-block-s':
        o.udpBlockS = numberFlag('t-pres', '--udp-block-s', v, 1);
        i++;
        break;
      case '--clear-max-ms':
        o.clearMaxMs = numberFlag('t-pres', '--clear-max-ms', v, 1);
        i++;
        break;
      case '--prompt-tries':
        o.promptTries = numberFlag('t-pres', '--prompt-tries', v, 1);
        i++;
        break;
      case '--say':
        o.say = true;
        break;
      default:
        throw new Error(`t-pres: unknown option ${argv[i]} (--phase, --devices, --reboots, --bye-max-ms, --udp-block-s, --clear-max-ms, --prompt-tries, --say)`);
    }
  }
  // Phases run in their own order whatever the flag's order: the ones without a person first.
  o.phases = PHASES.filter((p) => o.phases.includes(p));
  return o;
}

const firstOf = (r: Awaited<ReturnType<typeof waitEvent>>): HubEvent | undefined => ('timeout' in r ? undefined : r.events[0]);

// ---- bye ----

async function byePhase(ctx: ScenarioCtx, b: Board, o: TPresOptions) {
  const runs: (ByeRun & { problems: string[]; error?: string })[] = [];
  for (let i = 1; i <= o.reboots; i++) {
    ctx.signal.throwIfAborted();
    const up = await ctx.hub.call('wait_for_device', { selector: b.alias, state: 'online', timeout_s: 60 }, undefined, ctx.signal);
    if (!up.ok) {
      runs.push({ ...byeRun({ outcome: { status: 'not_sent' }, nodeBoot: false }), problems: [`not online before reboot ${i}`], error: up.error?.message });
      break;
    }
    const { outcome, cursor } = await send(ctx, b.alias, 'node.reboot', { timeout_s: 5 });
    const offline = outcome.status === 'ok' ? firstOf(await waitEvent(ctx, { types: 'device.offline', selector: b.alias, since: cursor, timeout_s: 10 })) : undefined;
    const online = offline ? firstOf(await waitEvent(ctx, { types: 'device.online', selector: b.alias, since: cursor, timeout_s: 60 })) : undefined;
    // node.boot follows the first WELCOME of the new boot (it may come with device.online or just after).
    const boot = online ? firstOf(await waitEvent(ctx, { types: 'node.boot', selector: b.alias, since: cursor, timeout_s: 10 })) : undefined;
    const r = byeRun({ outcome, offline, online, nodeBoot: Boolean(boot) });
    const problems = byeProblems(r, o.byeMaxMs);
    runs.push({ ...r, problems, ...(outcome.error ? { error: outcome.error } : {}) });
    ctx.log(`${b.alias} reboot ${i}/${o.reboots}: ${outcome.status}, offline ${r.offline_reason ?? '-'} after ${r.offline_after_send_ms ?? '-'} ms, online again after ${r.online_after_offline_ms ?? '-'} ms`);
  }
  const ok = runs.filter((r) => !r.problems.length).length;
  return {
    pass: runs.length === o.reboots && ok === o.reboots,
    reboots: o.reboots,
    ok,
    offline_after_send_ms: summary(runs.flatMap((r) => (r.offline_after_send_ms === null ? [] : [r.offline_after_send_ms]))),
    online_after_offline_ms: summary(runs.flatMap((r) => (r.online_after_offline_ms === null ? [] : [r.online_after_offline_ms]))),
    node_boot: runs.filter((r) => r.node_boot).length,
    runs,
  };
}

// ---- udp ----

/**
 * Ends `net udp_block` on a board (over whichever path the hub has; serial or TCP still carry), retried
 * once; a failure says how to end it by hand. A board left blocked would raise udp_blocked in the next gate.
 */
async function unblock(ctx: ScenarioCtx, b: Board): Promise<void> {
  try {
    await retrying(() => ctx.hub.ok('diag_exec', { port: b.device_id, line: 'net udp_block 0', timeout_s: 5 }), { retries: 1, delayMs: 500, transient });
  } catch (e) {
    ctx.log(`${b.alias}: net udp_block 0 failed (${(e as Error).message}); end it by hand: fr diag ${b.alias} net udp_block 0`);
  }
}

/** `signal`: the run's, aborted too when another board's udp phase failed (allOrAbort), so every board stops and unblocks. */
async function udpPhase(ctx: ScenarioCtx, b: Board, o: TPresOptions, signal: AbortSignal) {
  const c = { ...ctx, signal };
  // On Wi-Fi with UDP proven (udp_ok: the hub has had a datagram this session): right after the bye
  // phase's last reboot the first one may still be on its way, so wait up to 15 s.
  let pre = await linkInfo(ctx.hub, b.alias, signal);
  for (let i = 0; i < 60 && (!pre.links.includes('tcp') || pre.udp_ms_ago === null || pre.udp_blocked); i++) {
    await sleep(250, signal);
    pre = await linkInfo(ctx.hub, b.alias, signal);
  }
  if (!pre.links.includes('tcp') || pre.udp_ms_ago === null || pre.udp_blocked) {
    return {
      pass: false,
      error: `${b.alias} must be online on Wi-Fi with UDP (links ${pre.links.join(',') || 'none'}, udp_ms_ago ${pre.udp_ms_ago}, udp_blocked ${pre.udp_blocked})`,
    };
  }
  const stats0 = await diag(c, b, 'stats').catch(() => null);
  // Until when the hook may be armed (this process's clock): set before the line goes out, so a line the
  // board took whose answer was lost still ends in the finally's unblock.
  let armedUntil = performance.now() + o.udpBlockS * 1000 + 2000;
  let hookEnd = 0;
  try {
    const armed = await diag(c, b, `net udp_block ${o.udpBlockS}`, { retry: false });
    if (armed.response.ok !== true) {
      return { pass: false, error: `${b.alias}: net udp_block refused: ${JSON.stringify(armed.response)} (needs a debug build)` };
    }
    const t0 = performance.now();
    hookEnd = t0 + o.udpBlockS * 1000;
    armedUntil = hookEnd + 2000;
    // The warning: a long wait on the bus, timed on this process's clock from the hook's answer.
    let warningMs: number | null = null;
    let warningError: unknown;
    const warning = waitEvent(c, { types: 'hub.warning', selector: b.alias, where: { code: 'udp_blocked' }, since: armed.cursor, timeout_s: Math.min(110, o.udpBlockS + 5) }).then(
      (r) => {
        if (!('timeout' in r)) {
          warningMs = Math.round(performance.now() - t0);
        }
      },
      // Settled either way (a cancel drops the wait): never an unhandled rejection while the loop below runs.
      (e: unknown) => {
        warningError = e;
      },
    );
    let maxGap: number | null = null;
    let down = 0;
    let cleared: number | null = null;
    let seenBlocked = false;
    while (performance.now() < hookEnd + o.clearMaxMs) {
      await sleep(250, signal);
      const s = await linkInfo(ctx.hub, b.alias, signal);
      if (s.presence !== 'online' && s.presence !== 'suspect') {
        down++;
      }
      seenBlocked ||= s.udp_blocked;
      if (performance.now() < hookEnd && s.last_rx_ms_ago !== null) {
        maxGap = Math.max(maxGap ?? 0, s.last_rx_ms_ago);
      }
      if (performance.now() >= hookEnd && seenBlocked && !s.udp_blocked) {
        cleared = Math.round(performance.now() - hookEnd);
        break;
      }
    }
    await warning;
    if (warningError !== undefined) {
      throw warningError;
    }
    const events = await eventsSince(ctx.hub, { selector: b.alias, types: 'device.offline,device.suspect', since: armed.cursor }, signal);
    const stats1 = await diag(c, b, 'stats').catch(() => null);
    const df0 = stats0?.response.delivery_failed;
    const df1 = stats1?.response.delivery_failed;
    const obs = {
      warning_after_ms: warningMs,
      cleared_after_hook_ms: cleared,
      offline_events: events.filter((e) => e.type === 'device.offline').length,
      suspect_events: events.filter((e) => e.type === 'device.suspect').length,
      presence_down_samples: down,
      max_rx_gap_ms: maxGap,
    };
    const problems = udpProblems(obs, o.clearMaxMs);
    const deliveryFailed = typeof df0 === 'number' && typeof df1 === 'number' ? df1 - df0 : null;
    if (deliveryFailed) {
      ctx.log(`${b.alias}: delivery_failed +${deliveryFailed} while UDP was blocked (C6 had 0)`);
    }
    return { pass: problems.length === 0, block_s: o.udpBlockS, ...obs, delivery_failed: deliveryFailed, via: armed.via, problems };
  } finally {
    if (performance.now() < armedUntil) {
      await unblock(ctx, b);
    }
  }
}

// ---- unplug ----

async function unplugPhase(ctx: ScenarioCtx, b: Board, o: TPresOptions) {
  const ask = asker(ctx, o.say);
  const pre = await linkInfo(ctx.hub, b.alias, ctx.signal);
  const hbMs = pre.hb_interval_ms;
  if (!pre.links.includes('tcp')) {
    return { pass: false, error: `${b.alias} has no Wi-Fi (tcp) session (links ${pre.links.join(',') || 'none'}): the bound is for a Wi-Fi node` };
  }
  if (!b.port) {
    return { pass: false, error: `${b.alias} is not on a USB port of this Mac: the hub cannot see the unplug` };
  }
  // D15: the board to unplug blinks.
  const ident = await ctx.hub.call('command_send', { selector: b.alias, command: 'node.identify', args: { ms: 3000 }, ack: 'result', timeout_s: 5, duplicate: false }, undefined, ctx.signal);
  const since = ident.cursor || pre.cursor;
  let unplugged = false;
  let replugged = false;
  try {
    const off = await promptedWait(ctx, ask, `Unplug the USB cable of ${b.alias} (the board that blinks); keep it out until asked`, { types: 'device.offline', selector: b.alias, since }, o.promptTries);
    if (!off) {
      return { pass: false, hb_ms: hbMs, error: `${b.alias} did not go offline within ${o.promptTries} prompts` };
    }
    unplugged = true;
    // port.detached and the serial session's end come from the same poll; give a late one a moment.
    await sleep(300, ctx.signal);
    const t = unplugTimings(await eventsSince(ctx.hub, { selector: b.alias, types: 'port.detached,device.link,device.suspect,device.offline', since }, ctx.signal));
    const v = unplugVerdict(t, hbMs);
    ctx.log(`${b.alias}: offline (${t.offline_reason}) ${t.offline_after_unplug_ms ?? '?'} ms after the unplug (bound ${v.bound_ms.min}–${v.bound_ms.max} ms)`);
    const back = await promptedWait(ctx, ask, `Plug ${b.alias} back in`, { types: 'device.online', selector: b.alias, since: off.cursor }, o.promptTries);
    replugged = Boolean(back);
    // Back on Wi-Fi too (the bench's next gate needs it): the TCP link, up to 60 s.
    let tcp = false;
    for (let i = 0; back && i < 240 && !tcp; i++) {
      tcp = (await linkInfo(ctx.hub, b.alias, ctx.signal)).links.includes('tcp');
      if (!tcp) {
        await sleep(250, ctx.signal);
      }
    }
    const r = back ? replugTimings(await eventsSince(ctx.hub, { selector: b.alias, types: 'port.attached,device.online,device.link', since: off.cursor }, ctx.signal)) : null;
    const problems = [...v.problems, ...(back ? [] : [`${b.alias} did not come back online`]), ...(back && !tcp ? [`${b.alias} did not rejoin Wi-Fi within 60 s of coming back`] : [])];
    return {
      pass: v.pass && Boolean(back) && tcp,
      hb_ms: hbMs,
      bound_ms: v.bound_ms,
      ...t,
      ...(r ? { online_after_replug_ms: r.online_after_replug_ms, tcp_after_replug_ms: r.tcp_after_replug_ms, online_link: r.online_link } : {}),
      prompts: { unplug: off.attempt, replug: back?.attempt ?? null },
      problems,
    };
  } finally {
    if (unplugged && !replugged) {
      ctx.log(`PLEASE: plug ${b.alias} back in (the run stopped while it was unplugged)`);
    }
  }
}

// ---- the gate ----

export async function runTPres(ctx: ScenarioCtx, o: TPresOptions): Promise<Outcome> {
  const { boards, missing } = await resolveBoards(ctx.hub, o.devices);
  if (!boards.length && !missing.length) {
    throw new Error(`no device matches ${o.devices?.join(',') ?? 'online'}`);
  }
  const measured: Record<string, Record<string, unknown> & { pass?: boolean }> = {};
  const results: boolean[] = [];
  for (const m of missing) {
    measured[m.alias] = { pass: false, error: m.error };
    ctx.measure(m.alias, measured[m.alias]);
    results.push(false);
  }
  for (const b of boards) {
    const info = await linkInfo(ctx.hub, b.alias, ctx.signal);
    measured[b.alias] = { chip: b.chip, profile: b.profile, port: b.port ?? null, links: info.links, hb_ms: info.hb_interval_ms, ...rssiNote(ctx, b.alias, info.rssi) };
  }
  // Per board: its links and RSSI under `<alias>`, each phase's figures under `<phase>.<alias>` (the key
  // ctx.measure used, so a run that stops half-way reports the same names).
  const record = (b: Board, phase: PresPhase, r: { pass: boolean }) => {
    ctx.measure(`${phase}.${b.alias}`, r);
    measured[`${phase}.${b.alias}`] = r;
    results.push(r.pass);
  };
  if (o.phases.includes('bye')) {
    for (const b of boards) {
      ctx.log(`${b.alias}: ${o.reboots} reboots (BYE)`);
      record(b, 'bye', await byePhase(ctx, b, o));
    }
  }
  if (o.phases.includes('udp')) {
    ctx.log(`${boards.map((b) => b.alias).join(', ')}: net udp_block ${o.udpBlockS}`);
    const udp = await allOrAbort(boards, ctx.signal, (b, signal) => udpPhase(ctx, b, o, signal));
    boards.forEach((b, i) => record(b, 'udp', udp[i]));
  }
  if (o.phases.includes('unplug')) {
    if (!ctx.allowHuman) {
      for (const b of boards) {
        measured[`unplug.${b.alias}`] = { pass: false, skipped: 'needs a person at the bench (--allow-human)' };
      }
      results.push(false);
    } else {
      for (const b of boards) {
        // device_list's port is read once at the start; the bye phase's reboots keep USB enumerated.
        record(b, 'unplug', await unplugPhase(ctx, b, o));
      }
    }
  }
  for (const b of boards) {
    measured[b.alias].pass = o.phases.every((p) => measured[`${p}.${b.alias}`]?.pass === true);
  }
  return {
    pass: results.length > 0 && results.every(Boolean),
    measured: { phases: o.phases, ...measured },
    evidence: { devices: [...boards.map((b) => b.alias), ...missing.map((m) => m.alias)], bye_max_ms: o.byeMaxMs, udp_block_s: o.udpBlockS },
  };
}

const scenario = defineScenario({
  gate: 'T-PRES',
  title: 'offline 2.4–3.5 s after an unplug; immediate on BYE; udp_blocked raised and cleared with no false offline',
  needs: { human: true, usb: true },
  usage: `--devices a,b                aliases (default every online device; the bench: pad-c3,pad-c3b,pad-c6,pad-s3)
--phase bye|udp|unplug|all   comma-separated (default all; run in that order); bye and udp need no person
--reboots 5 --bye-max-ms 1000   fr.node.reboot runs, and the bound for "immediate" (hub clock, from the send)
--udp-block-s 30 --clear-max-ms 5000   net udp_block's length, and udp_blocked cleared within this of its end
--prompt-tries 3             prompts (110 s each) for an unplug or a replug before the board fails
--say                        speak each request with sk say
under tests/e2e/run.ts (test_run), FR_T_PRES_ARGS holds these`,
  // Standalone, the flags the runner does not know (ctx.args); under run.ts, FR_T_PRES_ARGS.
  run: (ctx) => runTPres(ctx, parseArgs(ctx.args?.length ? ctx.args : (process.env.FR_T_PRES_ARGS ?? '').split(/\s+/).filter(Boolean))),
});
export default scenario;

if (import.meta.main) {
  await runStandalone(scenario, import.meta.dirname);
}
