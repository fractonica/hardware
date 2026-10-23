// T-FLOOD-B (spec 05 §5.18; procedure and figures of docs/spikes/2026-10-22-c5-espnow.md): a Wi-Fi outage
// of 120 s while the hub sends `message_send broadcast` at 1 Hz. Only the nodes with a USB line to the hub
// (serial) get the broadcasts from it, and they seed the ESP-NOW flood the others live on. Pass: node ↔ node
// delivery ≥ 99 % on every node, and every node back on TCP < 10 s after Wi-Fi returns.
//
// The router stays on (the owner's choice, as at C5): `net wifi_down <s>` on every node holds its STA down
// (no join, no scan, the radio kept on channel C so ESP-NOW goes on). In the C5 run pad-c3 was on a charger,
// so it had only ESP-NOW; with every pad on the Mac's USB now, the isolated node (default pad-c3) also gets
// `net drop_hub_link`, so its USB line carries no hub frames either. `--router-off` asks the person to power
// the router off and on instead (prompt_human toasts, `sk say` with --say). On the bench:
//
//   node --conditions=@fractonica/source tests/e2e/t-flood-b.ts                     # wifi_down 120, pad-c3 isolated
//   node --conditions=@fractonica/source tests/e2e/t-flood-b.ts --isolate pad-s3    # the S3 on ESP-NOW alone
//   node --conditions=@fractonica/source tests/e2e/t-flood-b.ts --router-off --say  # a person powers the router off and on
//
// Run (hook variant):
//   1. Every node online; at least one keeps a hub link through the outage (on USB and not isolated, or
//      left out of --down); RSSI read; `stats bcast|relay|msgs` and `info` on every node.
//   2. `net wifi_down <outage + 60>` on every --down node (default all), `net drop_hub_link` on the
//      isolated one; the hub must see each one's TCP session end (device.link tcp up:false).
//   3. message_send {to: broadcast, topic t-flood-b, count outage × rate, interval_ms 1000 / rate}, followed to its end.
//   4. 3 s for the last relays, then the USB nodes' counters while Wi-Fi is still down.
//   5. The outage ends: `net drop_hub_link 0`, then `net wifi_down 0` on each node (a node not on USB comes
//      back when its hook expires). Each node's next device.link tcp up:true is timed from its own end, on
//      this process's clock (the waits run before the hooks end).
//   6. Every node's counters once all are online: the topic's delivered count against the broadcasts sent.
// Any way out of 2–5 ends every hook still armed (else the log names `fr diag <alias> net wifi_down 0`) and
// cancels the message_send job. Under tests/e2e/run.ts (test_run) FR_T_FLOOD_B_ARGS holds the flags.

import type { Job } from '@fractonica/protocol';

import {
  ask,
  bootMark,
  cursorNow,
  type Dev,
  type Diag,
  diagOk,
  DiagRefused,
  endHook,
  hubDiag,
  radioOf,
  readFlags,
  readStats,
  rebooted,
  runDevices,
  runJob,
  scenarioArgs,
  tell,
  waitOnline,
} from './lib/nn-flood-common.ts';
import { type Counters, delta, type FloodNode, floodNode, floodSummary, type NodeStats, quantile } from './lib/nn-flood-stats.ts';
import { runStandalone } from './lib/runner.ts';
import { defineScenario, type Outcome, type ScenarioCtx } from './lib/scenario.ts';
import { allOrAbort, sleep } from './lib/tasks.ts';

export interface TFloodBOptions {
  /** Aliases of the run's nodes; default every online device. */
  devices?: string[];
  /** The nodes whose Wi-Fi goes down; default every node of the run (all of them with --router-off). */
  down?: string[];
  /** Also `net drop_hub_link`: its USB line carries no hub frames. undefined: pad-c3 when it is in the run; null: none. */
  isolate?: string | null;
  outageS: number;
  rateHz: number;
  topic: string;
  /** A person powers the router off and on instead of the hooks. */
  routerOff: boolean;
  minDeliveryPct: number;
  /** Every node back on TCP within this many seconds of Wi-Fi's return. */
  backS: number;
  settleMs: number;
  say: boolean;
}

export const DEFAULTS: TFloodBOptions = { outageS: 120, rateHz: 1, topic: 't-flood-b', routerOff: false, minDeliveryPct: 99, backS: 10, settleMs: 3000, say: false };

/** The C5 run's Wi-Fi-only node. */
const DEFAULT_ISOLATE = 'pad-c3';

export function parseArgs(argv: readonly string[]): TFloodBOptions {
  const o: TFloodBOptions = { ...DEFAULTS };
  readFlags('t-flood-b', argv, {
    '--devices': (v) => (o.devices = v.list()),
    '--down': (v) => (o.down = v.list()),
    '--isolate': (v) => {
      const a = v.text();
      o.isolate = a === 'none' ? null : a;
    },
    '--outage-s': (v) => (o.outageS = v.num(5)),
    '--rate': (v) => (o.rateHz = v.num(0.05)),
    '--topic': (v) => (o.topic = v.text()),
    '--router-off': () => (o.routerOff = true),
    '--min-delivery': (v) => (o.minDeliveryPct = v.num(0)),
    '--back-s': (v) => (o.backS = v.num(0)),
    '--settle-ms': (v) => (o.settleMs = v.num(0)),
    '--say': () => (o.say = true),
  });
  if (o.rateHz > 20) {
    throw new Error('t-flood-b: --rate is at most 20 (message_send interval_ms ≥ 50)');
  }
  if (Buffer.byteLength(o.topic) > 32) {
    throw new Error('t-flood-b: --topic is at most 32 bytes');
  }
  return o;
}

/** The run's plan: who goes down, who is isolated, who keeps a hub link, or why it cannot run. */
export function planOutage(devs: readonly Dev[], o: Pick<TFloodBOptions, 'down' | 'isolate'> & { routerOff?: boolean }): { down: string[]; isolate: string | null; keepers: string[]; notes: string[] } {
  const aliases = devs.map((d) => d.alias);
  const notes: string[] = [];
  let isolate: string | null = null;
  // Isolation only cuts a USB node's serial link: a node on Wi-Fi alone has nothing but ESP-NOW once its
  // wifi_down is armed, and dropping its hub link first would leave the hub no way to arm that hook.
  const onUsb = (a: string) => devs.find((d) => d.alias === a)?.port_state === 'open';
  if (o.isolate === undefined) {
    if (!aliases.includes(DEFAULT_ISOLATE)) {
      notes.push(`${DEFAULT_ISOLATE} is not in the run: no node isolated (--isolate <alias>)`);
    } else if (!onUsb(DEFAULT_ISOLATE)) {
      notes.push(`${DEFAULT_ISOLATE} is not on USB: its wifi_down alone leaves it ESP-NOW only, so no node is isolated`);
    } else {
      isolate = DEFAULT_ISOLATE;
    }
  } else if (o.isolate !== null) {
    if (!aliases.includes(o.isolate)) {
      throw new Error(`--isolate ${o.isolate} is not one of the run's nodes (${aliases.join(', ')})`);
    }
    if (!onUsb(o.isolate)) {
      throw new Error(`--isolate ${o.isolate}: it is not on a USB port the hub holds, so wifi_down alone already leaves it ESP-NOW only`);
    }
    isolate = o.isolate;
  }
  if (o.routerOff && o.down?.length) {
    notes.push('--down is ignored with --router-off: every node loses Wi-Fi');
  }
  const unknown = (o.down ?? []).filter((a) => !aliases.includes(a));
  if (!o.routerOff && unknown.length) {
    throw new Error(`--down ${unknown.join(',')}: not among the run's nodes (${aliases.join(', ')})`);
  }
  const down = o.routerOff || !o.down?.length ? [...aliases] : [...new Set([...o.down, ...(isolate ? [isolate] : [])])];
  // A hub link through the outage: a node that keeps Wi-Fi, or one on a USB port the hub holds that is not isolated.
  const keepers = devs.filter((d) => d.alias !== isolate && (!down.includes(d.alias) || d.port_state === 'open')).map((d) => d.alias);
  if (!keepers.length) {
    throw new Error(
      'no node keeps a hub link through the outage, so no broadcast can reach the flood: put one on a USB port of this Mac (the hub holding it), or leave one out of --down / --isolate',
    );
  }
  return { down, isolate, keepers, notes };
}

export interface TFloodBDeps {
  diag?: Diag;
}

const SECTIONS = ['bcast', 'relay', 'msgs'] as const;

/**
 * The arrival of a node's next device.link {link: tcp, up: true} after `since`, on this process's clock (ms),
 * or null by `deadline`; `signal` ends the wait (the run's, or the run ending another way).
 */
async function tcpBack(ctx: ScenarioCtx, alias: string, since: string, deadline: number, signal: AbortSignal): Promise<number | null> {
  for (;;) {
    const left = Math.ceil((deadline - Date.now()) / 1000);
    if (left <= 0) {
      return null;
    }
    const r = await ctx.hub.call('wait_for_event', { types: 'device.link', selector: alias, where: { link: 'tcp', up: true }, since, count: 1, timeout_s: Math.min(110, left) }, undefined, signal);
    if (r.ok) {
      return Date.now();
    }
    if (r.error?.code !== 'TIMEOUT') {
      ctx.log(`${alias}: waiting for its TCP session: ${r.error?.code} ${r.error?.message}`);
      await sleep(1000, signal);
    }
  }
}

/**
 * A prompt_human wait, asked again up to `tries` times (a toast on the dashboard, a PLEASE line, `sk say`
 * with --say): resolves true once every node of `selector` emitted a device.link matching `where` after `since`.
 */
async function promptUntil(ctx: ScenarioCtx, o: TFloodBOptions, text: string, selector: string, where: Record<string, unknown>, since: string, tries = 3): Promise<boolean> {
  const stop = ask(ctx, o.say, text.charAt(0).toLowerCase() + text.slice(1));
  try {
    for (let i = 0; i < tries; i++) {
      const r = await ctx.hub.call('wait_for_event', { types: 'device.link', selector, where, since, count: 1, per_device: true, timeout_s: 110, prompt_human: text.slice(0, 120) }, undefined, ctx.signal);
      if (r.ok) {
        return true;
      }
      if (r.error?.code !== 'TIMEOUT') {
        throw new Error(`wait_for_event: ${r.error?.code} ${r.error?.message}`);
      }
      ctx.log(`still waiting (${r.error.message})`);
    }
    return false;
  } finally {
    stop();
  }
}

export async function runTFloodB(ctx: ScenarioCtx, o: TFloodBOptions, deps: TFloodBDeps = {}): Promise<Outcome> {
  const diag = deps.diag ?? hubDiag(ctx);
  if (o.routerOff && !ctx.allowHuman) {
    return { pass: false, measured: { variant: 'router_off', skipped: 'needs a person at the bench (--allow-human) to power the router off and on' }, evidence: {} };
  }
  const devs = await runDevices(ctx, o.devices, [...(o.down ?? []), ...(o.isolate ? [o.isolate] : [])]);
  const plan = planOutage(devs, o);
  const measured: Record<string, unknown> = {
    variant: o.routerOff ? 'router_off' : 'wifi_down',
    devices: devs.map((d) => d.alias),
    down: plan.down,
    isolated: plan.isolate,
    seeders: plan.keepers,
    outage_s: o.outageS,
    rate_hz: o.rateHz,
  };
  const warnings: string[] = [...plan.notes];
  plan.notes.forEach((n) => ctx.log(n));
  const { radio, warnings: weak } = await radioOf(ctx, diag, devs);
  warnings.push(...weak);
  ctx.measure('rssi', radio);
  weak.forEach((w) => ctx.log(`warning: ${w}`));
  ctx.log(`down: ${plan.down.join(', ')}; isolated: ${plan.isolate ?? 'none'}; hub link kept by ${plan.keepers.join(', ')}`);

  const before = new Map<string, { stats: NodeStats; boot: Awaited<ReturnType<typeof bootMark>> }>();
  for (const d of devs) {
    before.set(d.alias, { stats: (await readStats(diag, d, SECTIONS, ctx.signal)).stats, boot: await bootMark(diag, d) });
  }

  const usb = new Set(devs.filter((d) => d.port_state === 'open').map((d) => d.alias));
  const byAlias = new Map(devs.map((d) => [d.alias, d]));
  const dev = (alias: string): Dev => byAlias.get(alias)!;
  const count = Math.max(1, Math.round(o.outageS * o.rateHz));
  const intervalMs = Math.max(50, Math.round(1000 / o.rateHz));
  // The hooks outlast the run; they are ended at its end (a node not on USB: when they expire).
  const hookS = o.routerOff ? o.outageS + 900 : o.outageS + 60;
  /** Hooks armed and not yet ended: alias -> (hook -> local ms it was armed). */
  const armed = new Map<string, Map<string, number>>();
  /** Local ms each down node's outage ended (its wifi_down 0 answered, or its hook's expiry). */
  const endedAt = new Map<string, number>();
  /** A hook could not be ended: its node comes back only when it expires. */
  let unended = false;
  const arm = async (alias: string, hook: 'wifi_down' | 'drop_hub_link') => {
    const hooks = armed.get(alias) ?? new Map<string, number>();
    armed.set(alias, hooks);
    hooks.set(hook, Date.now());
    try {
      await diagOk(diag, dev(alias), `net ${hook} ${hookS}`, ctx.signal);
    } catch (e) {
      if (e instanceof DiagRefused) {
        hooks.delete(hook); // refused: nothing to end
      }
      throw e;
    }
  };
  /** Ends one armed hook; a node that cannot be reached is left to its expiry. Returns the local end time. */
  const disarm = async (alias: string, hook: string): Promise<number> => {
    const at = armed.get(alias)?.get(hook);
    if (at === undefined) {
      return Date.now();
    }
    const ok = await endHook(ctx, diag, dev(alias), `net ${hook} 0`);
    armed.get(alias)!.delete(hook);
    if (ok) {
      return Date.now();
    }
    unended = true;
    const expiry = at + 300 + hookS * 1000;
    ctx.log(`${alias}: its ${hook} hook ends on its own in ${Math.max(0, Math.round((expiry - Date.now()) / 1000))} s`);
    return expiry;
  };

  let job: Job | null = null;
  /** A run that ended early (the outage never began, the job failed): reported once every node is back. */
  let early: Outcome | null = null;
  const inHook: Record<string, number | null> = {};
  let back: Record<string, number | null> = {};
  /** --router-off: when the router came back (the first STA seen joined), on this process's clock. */
  const router: { back: number | null } = { back: null };
  /** Ends the waits for TCP sessions on any way out (a failed prompt must not leave them running). */
  const waits = new AbortController();
  try {
    const c0 = await cursorNow(ctx);
    // 2. The outage.
    if (plan.isolate) {
      await arm(plan.isolate, 'drop_hub_link');
    }
    if (o.routerOff) {
      const off = await promptUntil(ctx, o, `Power the home router off now and keep it off until asked (about ${Math.ceil(o.outageS / 60)} min)`, plan.down.join(','), { link: 'tcp', up: false }, c0);
      if (!off) {
        early = { pass: false, measured: { ...measured, reasons: ['the nodes never lost their TCP sessions: was the router powered off?'], warnings }, evidence: {} };
      } else {
        tell(ctx, o.say, 'Thank you. Keep the router off.');
      }
    } else {
      for (const a of plan.down) {
        await arm(a, 'wifi_down');
      }
      const t0 = Date.now();
      const lost = await ctx.hub.call<{ events: unknown[] }>(
        'wait_for_event',
        { types: 'device.link', selector: plan.down.join(','), where: { link: 'tcp', up: false }, since: c0, count: 1, per_device: true, timeout_s: 20 },
        undefined,
        ctx.signal,
      );
      if (lost.ok) {
        measured.tcp_lost_ms = Date.now() - t0;
      } else {
        warnings.push(`not every down node's TCP session ended within 20 s (${lost.error?.message})`);
      }
    }

    if (!early) {
      // 3. The broadcasts, at 1 Hz through the outage.
      ctx.log(`${count} broadcasts on ${o.topic}, ${intervalMs} ms apart`);
      job = await runJob(ctx, 'message_send', { to: 'broadcast', topic: o.topic, count, interval_ms: intervalMs });
      if (job.status !== 'completed') {
        early = { pass: false, measured: { ...measured, job: { status: job.status, error: job.error }, warnings }, evidence: { job_id: job.job_id } };
      }
    }
    if (!early) {
      await sleep(o.settleMs, ctx.signal);

      // 4. What the USB nodes had while Wi-Fi was still down.
      for (const a of plan.down.filter((x) => usb.has(x))) {
        const s = await readStats(diag, dev(a), ['msgs']).catch(() => null);
        const b = before.get(a)!.stats.msgs ?? {};
        inHook[a] = s?.stats.msgs && Object.hasOwn(s.stats.msgs, o.topic) ? s.stats.msgs[o.topic] - (b[o.topic] ?? 0) : null;
      }

      // 5. Wi-Fi returns. The waits for each node's TCP session start first, so each is timed from its own end.
      const c1 = await cursorNow(ctx);
      const deadline = Date.now() + (o.routerOff ? 6 * 60_000 : hookS * 1000 + 30_000);
      const waitSignal = AbortSignal.any([ctx.signal, waits.signal]);
      const arrivals = new Map(plan.down.map((a) => [a, tcpBack(ctx, a, c1, deadline, waitSignal)]));
      arrivals.forEach((p) => p.catch(() => undefined)); // awaited below
      if (plan.isolate) {
        await disarm(plan.isolate, 'drop_hub_link');
      }
      if (o.routerOff) {
        // The router's return is seen as the first STA that joins (diag info over USB, every 500 ms).
        const watch = new AbortController();
        const poll = (async () => {
          while (!watch.signal.aborted && router.back === null) {
            for (const a of [...usb]) {
              const r = await diag(dev(a), 'info').catch(() => null);
              if ((r?.response.wifi as { up?: unknown } | undefined)?.up === true) {
                router.back ??= Date.now();
              }
            }
            await sleep(500, watch.signal).catch(() => undefined);
          }
        })();
        try {
          const on = await promptUntil(ctx, o, 'Power the home router back on now', plan.down.join(','), { link: 'tcp', up: true }, c1);
          if (!on) {
            warnings.push('not every node came back on TCP within 5.5 min of asking for the router');
          }
        } finally {
          watch.abort();
          await poll;
        }
        tell(ctx, o.say, 'Thank you. The router test is done.');
        plan.down.forEach((a) => endedAt.set(a, router.back ?? Date.now()));
      } else {
        for (const a of plan.down) {
          endedAt.set(a, await disarm(a, 'wifi_down'));
        }
      }
      const arrived = await allOrAbort(plan.down, ctx.signal, (a) => arrivals.get(a)!);
      back = Object.fromEntries(plan.down.map((a, i) => [a, arrived[i] === null ? null : Math.max(0, arrived[i]! - endedAt.get(a)!)]));
    }
  } finally {
    waits.abort(new Error('the run ended'));
    // Every way out ends what is still armed (a failure, a cancel).
    for (const [alias, hooks] of armed) {
      for (const hook of hooks.keys()) {
        if (!(await endHook(ctx, diag, dev(alias), `net ${hook} 0`))) {
          unended = true;
        }
      }
    }
  }

  // 6. Every node online again (a hook that could not be ended holds its node until it expires), then the counters.
  const notBack = [];
  for (const d of devs) {
    if (!(await waitOnline(ctx, d.alias, unended ? hookS + 60 : 60))) {
      notBack.push(d.alias);
    }
  }
  if (notBack.length) {
    throw new Error(`${notBack.join(', ')} did not come back online after the outage`);
  }
  if (early) {
    return early;
  }
  const res = (job?.result ?? {}) as { sent?: number; seeded?: number; tcp_only?: number; no_session?: number; sessions_max?: number; duration_ms?: number; first_seq?: number; last_seq?: number };
  const sent = res.sent ?? 0;
  const nodes: FloodNode[] = [];
  const reasons: string[] = [];
  for (const d of devs) {
    const b = before.get(d.alias)!;
    const after = (await readStats(diag, d, SECTIONS, ctx.signal)).stats;
    if (rebooted(b.boot, await bootMark(diag, d))) {
      reasons.push(`${d.alias} rebooted during the run: its counters do not cover it`);
    }
    const msgs = after.msgs ?? {};
    nodes.push(
      floodNode(sent, {
        alias: d.alias,
        bcast: delta(b.stats.bcast, after.bcast),
        relay: delta(b.stats.relay, after.relay),
        topic: Object.hasOwn(msgs, o.topic) ? msgs[o.topic] - (b.stats.msgs?.[o.topic] ?? 0) : null,
      }),
    );
  }
  if (sent <= 0) {
    reasons.push('no broadcast was sent');
  }
  for (const n of nodes) {
    if (n.delivery_pct < o.minDeliveryPct) {
      reasons.push(`${n.alias} delivered ${n.delivered}/${sent} (${n.delivery_pct} % < ${o.minDeliveryPct} %)`);
    }
  }
  if (o.routerOff && router.back === null) {
    reasons.push("the router's return was not seen (no USB node's STA joined while polled), so the time back cannot be told");
  }
  for (const [a, ms] of Object.entries(back)) {
    if (ms === null) {
      reasons.push(`${a} never came back on TCP`);
    } else if (ms >= o.backS * 1000) {
      reasons.push(`${a} back on TCP ${Math.round(ms / 100) / 10} s after Wi-Fi returned (≥ ${o.backS} s)`);
    }
  }
  const backs = Object.values(back).filter((x): x is number => x !== null);
  const relay: Record<string, Counters> = Object.fromEntries(nodes.map((n) => [n.alias, n.relay]));
  Object.assign(measured, {
    summary: `delivered ${nodes.map((n) => `${n.alias} ${n.delivered}/${sent}${n.alias === plan.isolate ? ' (ESP-NOW only)' : ''}`).join(', ')}; back on TCP within ${backs.length ? `${(Math.max(...backs) / 1000).toFixed(1)} s` : 'n/a'} of Wi-Fi's return`,
    flood: floodSummary(nodes, sent),
    sent,
    seeded: res.seeded,
    tcp_only: res.tcp_only,
    sessions_max: res.sessions_max,
    duration_s: res.duration_ms !== undefined ? Math.round(res.duration_ms / 100) / 10 : undefined,
    delivered: Object.fromEntries(nodes.map((n) => [n.alias, n.delivered])),
    delivery_pct: Object.fromEntries(nodes.map((n) => [n.alias, n.delivery_pct])),
    duplicates: Object.fromEntries(nodes.map((n) => [n.alias, n.duplicates])),
    during_outage: inHook,
    back_on_tcp_ms: back,
    back_on_tcp_p50_ms: quantile(backs, 0.5),
    relay,
    rssi: radio,
    ...(reasons.length ? { reasons } : {}),
    ...(warnings.length ? { warnings } : {}),
  });
  ctx.measure('summary', measured.summary);
  return { pass: reasons.length === 0, measured, evidence: { job_id: job?.job_id, first_seq: res.first_seq, last_seq: res.last_seq, usb: [...usb] } };
}

/**
 * Under tests/e2e/run.ts the flags come from FR_T_FLOOD_B_ARGS, read when the module loads: with --router-off
 * the gate needs a person, so the runner skips it without --allow-human (status skipped, needs.human).
 */
const ROUTER_OFF_FROM_ENV = (process.env.FR_T_FLOOD_B_ARGS ?? '').split(/\s+/).includes('--router-off');

const scenario = defineScenario({
  gate: 'T-FLOOD-B',
  title: 'a 120 s Wi-Fi outage: hub broadcasts at 1 Hz reach every node through the USB-seeded flood (≥ 99 %), all back on TCP < 10 s after',
  needs: ROUTER_OFF_FROM_ENV ? { human: true, usb: true } : { usb: true },
  usage: `--devices a,b,c              the run's nodes (default every online device)
--down a,b                   the nodes whose Wi-Fi goes down (net wifi_down; default all)
--isolate pad-c3|none        also net drop_hub_link on it: ESP-NOW alone (default pad-c3 when in the run)
--outage-s 120 --rate 1      the outage and the broadcast rate (Hz)
--router-off                 a person powers the router off and on instead (needs --allow-human)
--say                        speak each request with sk say
--min-delivery 99 --back-s 10 --settle-ms 3000 --topic t-flood-b
under tests/e2e/run.ts (test_run), FR_T_FLOOD_B_ARGS holds these`,
  run: (ctx) => runTFloodB(ctx, parseArgs(scenarioArgs(ctx, 'FR_T_FLOOD_B_ARGS'))),
});
export default scenario;

if (import.meta.main) {
  await runStandalone(scenario, import.meta.dirname);
}
