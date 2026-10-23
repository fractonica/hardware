// Handlers of the node <-> node ops (packages/protocol/src/ops/net.ts; design c5 §4, spec 09 §9.4):
// message_send over HubContext.broadcast (one hub broadcast, or one reliable unicast per selected device;
// count > 1 repeats it as a job of kind msg), binding_set|list|clear over HubContext.bindings, and
// latency_stats from the router's samples. Spread into HANDLERS (packages/hub/src/ops.ts).

import { BROADCAST_ALIAS, CLS, FrError, MAX_WAIT_S, type NetOpName } from '@fractonica/protocol';
import { decodeBinding, encodeMsgMsg, KIND, PORT, statusName } from '@fractonica/protocol/gen';

import type { BindingRow, Device, Handler, HubContext, Presence } from '../context.ts';
import type { JobCtx } from '../jobs.ts';
import { resolveOne } from '../registry/hub.ts';
import { routerLatency, routerLoopDelay } from '../router/index.ts';
import { percentiles } from '../router/latency.ts';
import { bindingJson, jsonText } from './index.ts';

const isUp = (p: Presence) => p === 'online' || p === 'suspect';
/** List budget (spec 09 §9.2). */
const LIST_MAX = 100;
/**
 * How long a unicast MSG waits for its ACK: FR_TCP_DELIVERY_MS, since the hub sends over TCP or serial,
 * where the link retransmits and the hub does not (05 §5.8 TCP hops).
 */
const MSG_ACK_MS = 2000;

interface MessageInput {
  to: string;
  topic: string;
  data?: unknown;
  count: number;
  interval_ms: number;
  wait_s?: number;
}

/** One unicast MSG's outcome per device: the ACK status name, or the hub's own (offline, timeout). */
interface MsgOutcome {
  device: string;
  alias: string;
  status: string;
  rtt_ms?: number;
  link?: string;
  error?: string;
}

/** The MSG data as sent: UTF-8 JSON text (05 §5.7), or nothing. */
function msgData(data: unknown): Uint8Array {
  const j = jsonText(data, 'data');
  return j ? new TextEncoder().encode(j.text) : new Uint8Array(0);
}

/** The devices a selector names (NOT_FOUND for none); every registered device without one. */
function selectDevices(hub: HubContext, selector: string | undefined): Device[] {
  if (!selector) {
    return hub.registry.list();
  }
  const devices = hub.registry.resolve(selector, (id) => hub.router.presence(id));
  if (!devices.length) {
    throw new FrError('NOT_FOUND', `no device matches ${JSON.stringify(selector)}`, { remediation: [{ tool: 'device_list', cli: 'fr devices ls' }] });
  }
  return devices;
}

async function sendMsgTo(hub: HubContext, dev: Device, topic: string, data: Uint8Array): Promise<MsgOutcome> {
  const base = { device: dev.device_id, alias: dev.alias };
  if (!isUp(hub.router.presence(dev.device_id))) {
    return { ...base, status: 'offline', error: `${dev.alias} is ${hub.router.presence(dev.device_id)}` };
  }
  try {
    const r = await hub.broadcast.sendMsg(dev.device_id, topic, data, { timeoutMs: MSG_ACK_MS });
    return { ...base, status: statusName(r.status)?.toLowerCase() ?? String(r.status), rtt_ms: r.rtt_ms, link: r.link };
  } catch (e) {
    if (e instanceof FrError && (e.code === 'DEVICE_OFFLINE' || e.code === 'TIMEOUT')) {
      return { ...base, status: e.code === 'TIMEOUT' ? 'timeout' : 'offline', error: e.message };
    }
    throw e;
  }
}

/** Waits until `at` (Date.now() ms), or rejects when the job is cancelled. */
function sleepUntil(at: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      Math.max(0, at - Date.now()),
    );
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** One send of message_send: a hub broadcast, or a unicast to each selected device. */
async function sendOnce(hub: HubContext, input: Pick<MessageInput, 'to' | 'topic'>, devices: Device[] | null, data: Uint8Array) {
  if (!devices) {
    const body = encodeMsgMsg({ topic: input.topic, data });
    const sent = hub.broadcast.broadcast({ cls: CLS.MSG, kind: KIND.MSG.MSG, port: PORT.NODE, body });
    if (sent.sessions === 0) {
      throw new FrError('DEVICE_OFFLINE', 'no node has a hub link: the broadcast reached nobody', {
        remediation: [{ tool: 'wait_for_device', args: { selector: 'all', state: 'online' } }],
        details: { seq: sent.seq },
      });
    }
    return { to: BROADCAST_ALIAS, topic: input.topic, bytes: data.length, seq: sent.seq, sessions: sent.sessions, seeded: sent.seeded };
  }
  const results = await Promise.all(devices.map((d) => sendMsgTo(hub, d, input.topic, data)));
  if (results.every((r) => r.status === 'offline')) {
    throw new FrError('DEVICE_OFFLINE', `${results.map((r) => r.alias).join(', ')}: no hub link`, {
      remediation: results.map((r) => ({ tool: 'wait_for_device', args: { selector: r.alias, state: 'online' } })),
      details: { results },
    });
  }
  return { to: input.to, topic: input.topic, bytes: data.length, results };
}

/** The MSG data, checked to fit (INVALID_ARGS), and the devices `to` names: null for a broadcast. */
function messagePlan(hub: HubContext, msg: { to: string; topic: string; data?: unknown }): { data: Uint8Array; devices: Device[] | null } {
  const data = msgData(msg.data);
  try {
    encodeMsgMsg({ topic: msg.topic, data });
  } catch (e) {
    throw new FrError('INVALID_ARGS', `the MSG does not fit: ${(e as Error).message} (data is at most 168 bytes of JSON)`);
  }
  return { data, devices: msg.to.toLowerCase() === BROADCAST_ALIAS ? null : selectDevices(hub, msg.to) };
}

/**
 * One message_send of count 1 (design c6 §3.3), which the `/app` bridge's `msg` shares: `to: broadcast` is
 * one hub broadcast, anything else a selector, with one reliable unicast MSG per device (per-device
 * outcomes; DEVICE_OFFLINE only when none has a link). `data` is JSON, sent as its UTF-8 text.
 */
export async function sendMessage(hub: HubContext, msg: { to: string; topic: string; data?: unknown }) {
  const { data, devices } = messagePlan(hub, msg);
  return sendOnce(hub, msg, devices, data);
}

/** count > 1: a job of kind msg (design c5 §4) sending every interval_ms; progress = sent. */
async function repeat(hub: HubContext, input: MessageInput, devices: Device[] | null, data: Uint8Array, ctx: JobCtx) {
  const start = Date.now();
  const body = encodeMsgMsg({ topic: input.topic, data });
  let sent = 0;
  let seeded = 0;
  let reached = 0;
  let nobody = 0;
  let firstSeq: number | null = null;
  let lastSeq: number | null = null;
  const pending: Promise<MsgOutcome>[] = [];
  ctx.stage('sending');
  try {
    // Paced against an anchor, not the last send, so a slow tick does not stretch the run. A stall of more
    // than one interval (a busy hub) moves the anchor to now instead of catching up: the catch-up would be a
    // burst of broadcasts beyond the flood rate and the nodes' relay queues, which a node with no hub link
    // never gets (T-FLOOD). duration_ms then shows the stall.
    let anchor = start;
    let anchorAt = 0;
    for (let i = 0; i < input.count; i++) {
      if (i > 0) {
        const due = anchor + (i - anchorAt) * input.interval_ms;
        if (Date.now() - due > input.interval_ms) {
          ctx.signal.throwIfAborted(); // as sleepUntil would: a cancelled job sends nothing more
          anchor = Date.now();
          anchorAt = i;
        } else {
          await sleepUntil(due, ctx.signal);
        }
      }
      if (!devices) {
        const s = hub.broadcast.broadcast({ cls: CLS.MSG, kind: KIND.MSG.MSG, port: PORT.NODE, body });
        firstSeq ??= s.seq;
        lastSeq = s.seq;
        reached = Math.max(reached, s.sessions);
        if (s.sessions === 0) {
          nobody++;
        }
        if (s.seeded) {
          seeded++;
        }
      } else {
        for (const d of devices) {
          const p = sendMsgTo(hub, d, input.topic, data);
          p.catch(() => undefined); // awaited below; not an unhandled rejection meanwhile
          pending.push(p);
        }
      }
      sent++;
      ctx.progress(Math.floor((sent * 100) / input.count), `${sent}/${input.count} sent`);
    }
  } finally {
    ctx.log(`${sent}/${input.count} sent to ${input.to} in ${Date.now() - start} ms`);
  }
  const duration_ms = Date.now() - start;
  if (!devices) {
    return {
      to: BROADCAST_ALIAS,
      topic: input.topic,
      count: input.count,
      sent,
      seeded,
      tcp_only: sent - seeded,
      no_session: nobody,
      first_seq: firstSeq,
      last_seq: lastSeq,
      sessions_max: reached,
      duration_ms,
    };
  }
  const outcomes = await Promise.all(pending);
  const per = devices.map((d) => {
    const mine = outcomes.filter((o) => o.device === d.device_id);
    const statuses: Record<string, number> = {};
    for (const o of mine) {
      statuses[o.status] = (statuses[o.status] ?? 0) + 1;
    }
    const rtt = percentiles(mine.filter((o) => o.rtt_ms !== undefined).map((o) => o.rtt_ms! * 1000));
    return { device: d.device_id, alias: d.alias, sent: mine.length, acked: statuses.ok ?? 0, statuses, rtt_p50_ms: rtt.p50_ms, rtt_p99_ms: rtt.p99_ms };
  });
  return { to: input.to, topic: input.topic, count: input.count, sent, results: per, duration_ms };
}

/** binding_clear's slot: 0..15 as a number or text, or "all". */
function slotOf(v: number | string): number | 'all' {
  if (v === 'all') {
    return 'all';
  }
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 15) {
    throw new FrError('INVALID_ARGS', `slot ${String(v)}: 0..15 or all`);
  }
  return n;
}

/** A registry row as binding_list shows it: plus both ends' current aliases and the binding's fields. */
function rowView(hub: HubContext, row: BindingRow) {
  const decoded = decodeBinding(Buffer.from(row.binding, 'hex'));
  return {
    device: row.device_id,
    alias: hub.registry.get(row.device_id)?.alias ?? row.device_id,
    slot: row.slot,
    from: row.from,
    to: row.to,
    target: row.target_id,
    args: row.args,
    pushed: row.pushed_at !== null,
    pushed_at: row.pushed_at,
    binding: decoded.ok ? bindingJson(decoded.value) : { hex: row.binding },
  };
}

export const NET_HANDLERS: Record<NetOpName, Handler> = {
  message_send: async (input: MessageInput, hub) => {
    if (input.count <= 1) {
      return sendMessage(hub, input);
    }
    const { data, devices } = messagePlan(hub, input);
    const targets = devices ? devices.map((d) => d.device_id) : [BROADCAST_ALIAS];
    const job = hub.jobs.start('msg', targets, [], (ctx) => repeat(hub, input, devices, data, ctx));
    return hub.jobs.wait(job.job_id, Math.min(input.wait_s ?? 0, MAX_WAIT_S));
  },

  binding_set: async (input: { from: string; to: string; args?: unknown }, hub) => {
    const r = await hub.bindings.set(input);
    return { ...rowView(hub, r.row), replaced: r.replaced, ...(r.pending ? { pending: r.pending } : {}) };
  },

  binding_list: async (input: { selector?: string; live: boolean }, hub) => {
    if (!input.live) {
      const rows = hub.bindings.list(input.selector);
      return { bindings: rows.slice(0, LIST_MAX).map((r) => rowView(hub, r)), count: rows.length, truncated: rows.length > LIST_MAX };
    }
    // The nodes' own tables (fr.node.bind_list), each against the registry's rows.
    const devices = selectDevices(hub, input.selector).slice(0, LIST_MAX);
    const devicesOut = await Promise.all(
      devices.map(async (d) => {
        const base = { device: d.device_id, alias: d.alias, presence: hub.router.presence(d.device_id) };
        const rows = hub.bindings.list(`id:${d.device_id}`);
        if (!isUp(base.presence)) {
          return { ...base, error: `${d.alias} is ${base.presence}`, registry_slots: rows.map((r) => r.slot) };
        }
        try {
          const live = await hub.bindings.live(d.device_id);
          const onNode = new Set(live.map((b) => b.slot));
          return { ...base, bindings: live, missing: rows.map((r) => r.slot).filter((s) => !onNode.has(s)) };
        } catch (e) {
          return { ...base, error: (e as Error).message, ...(e instanceof FrError ? { code: e.code } : {}), registry_slots: rows.map((r) => r.slot) };
        }
      }),
    );
    return { devices: devicesOut };
  },

  binding_clear: async (input: { device: string; slot: number | string }, hub) => {
    const slot = slotOf(input.slot);
    const dev = resolveOne(hub, input.device);
    const out = await hub.bindings.clear(dev.device_id, slot);
    return { device: dev.device_id, alias: dev.alias, slot, ...out };
  },

  latency_stats: (input: { selector?: string; window_s: number }, hub) => {
    const windowMs = input.window_s * 1000;
    const all = selectDevices(hub, input.selector);
    const devices = all.slice(0, LIST_MAX).map((d) => ({
      device: d.device_id,
      alias: d.alias,
      presence: hub.router.presence(d.device_id),
      ...(routerLatency(hub.router, d.device_id, windowMs) ?? { ping: {}, input: percentiles([]), bindings: {} }),
    }));
    return {
      window_s: input.window_s,
      event_loop: routerLoopDelay(hub.router, windowMs),
      devices,
      count: all.length,
      truncated: all.length > LIST_MAX,
    };
  },
};
