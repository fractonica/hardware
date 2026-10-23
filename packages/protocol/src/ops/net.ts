// Node <-> node ops (design c5 §4, spec 09 §9.4-9.5; stream H1): message_send, binding_set, binding_list,
// binding_clear and latency_stats. Spread into OPS (packages/protocol/src/ops.ts); handlers in
// packages/hub/src/bindings/ops.ts. C6 adds PROBE_OPS (latency_probe; design c6 §6.7, T-LAT, stream
// S7), whose handler is in packages/hub/src/latency/.

import { z } from 'zod';

import { JobSchema } from '../types.ts';
import { deviceSel, op, waitS } from './common.ts';

const selector = z.string().min(1).describe('device selector (alias, id:<12hex>, tag:<t>, chip:<c>, online, all; comma-separated, ! negates)');
// The CLI passes JSON text; REST and MCP callers pass the value itself.
const jsonObject = z.union([z.record(z.string(), z.unknown()), z.string()]);

/** `"broadcast"`: the reserved alias message_send and binding targets use for every node (09 §9.4). */
export const BROADCAST_ALIAS = 'broadcast';

/** p50 / p99 / max of the samples in a window, in ms; null without samples (the hub's router/latency.ts). */
const Percentiles = z.looseObject({ n: z.number().int(), p50_ms: z.number().nullable(), p99_ms: z.number().nullable(), max_ms: z.number().nullable() });

/** latency_stats `data`, one row per selected device (at most 100). */
export const LatencyStatsSchema = z.looseObject({
  window_s: z.number().int(),
  /** The hub's event-loop delay (a 20 ms timer's lateness), null when the router does not sample it. */
  event_loop: z.looseObject({ seconds: z.number(), p50_ms: z.number().nullable(), p99_ms: z.number().nullable(), max_ms: z.number().nullable() }).nullable(),
  devices: z.array(
    z.looseObject({
      device: z.string(),
      alias: z.string(),
      presence: z.string(),
      /** PING RTT by link (tcp, serial, udp). */
      ping: z.record(z.string(), Percentiles),
      input: Percentiles,
      /** Binding trigger -> target RESULT by path (espnow, hub, flood, local), plus fast and failed counts. */
      bindings: z.record(z.string(), Percentiles.extend({ fast: z.number().int(), failed: z.number().int() })),
    }),
  ),
  count: z.number().int(),
  truncated: z.boolean(),
});

/** latency_probe modes (T-LAT): `both` alternates, so each mode runs at rate_hz / 2. */
export const PROBE_MODES = ['both', 'immediate', 'exec_at'] as const;

export const NET_OPS = [
  op({
    name: 'message_send',
    kind: 'job',
    tier: 'mutate',
    summary:
      'Send a MSG {topic, data} to every node (to: broadcast; one hub broadcast that nodes also flood over ESP-NOW, never ACKed) or to each selected device (one reliable unicast each). Nodes react through MSG bindings and fr::msg::on; apps see node MSGs as `msg` events. count > 1 repeats it every interval_ms as a job (kind msg, progress = sent), for test bursts; count 1 answers at once.',
    input: z.object({
      to: z.string().min(1).describe('"broadcast", or a device selector'),
      topic: z.string().min(1).max(32).describe('MSG topic (<= 32 bytes)'),
      data: z.unknown().optional().describe('any JSON value, sent as UTF-8 JSON text (<= 168 bytes); a string is JSON text, as the CLI passes it'),
      count: z.number().int().min(1).max(10_000).default(1).describe('sends in all (a job when > 1)'),
      interval_ms: z.number().int().min(20).max(60_000).default(100).describe('time between repeated sends'),
      wait_s: waitS,
    }),
    cli: { path: ['msg'], positional: ['to', 'topic', 'data'] },
  }),
  op({
    name: 'binding_set',
    kind: 'command',
    tier: 'mutate',
    summary:
      'Bind a node event or received MSG topic to a command or MSG on another node (or itself, or every node): `fr bind pad-c6.boot.down pad-c3.status.blink \'{"count":1}\'`. The hub resolves both ends, validates args against the command schema, pre-encodes them (<= 64 B) into the lowest free slot of the source device and pushes fr.node.bind_set; the binding then runs on the nodes over ESP-NOW, with the hub stopped too. A node keeps 16, at most 1400 B encoded (what fr.node.bind_list returns); fr.node\'s own events (boot, binding_fired) cannot trigger one. Each firing emits node.binding_fired {slot, target_status, rtt_us, path}.',
    input: z.object({
      from: z.string().min(1).describe('"<alias>.<instance>.<event>" or "<alias>.msg:<topic>"'),
      to: z.string().min(1).describe('"<alias>.<instance>.<command>", "<alias>.msg:<topic>" or "broadcast.msg:<topic>"'),
      args: jsonObject.optional().describe('the command arguments (JSON object), or the MSG data (any JSON value; a string is JSON text, as the CLI passes it)'),
    }),
    cli: { path: ['bind'], positional: ['from', 'to', 'args'] },
  }),
  op({
    name: 'binding_list',
    kind: 'query',
    tier: 'read',
    summary: "Bindings by source device, as the registry keeps them (slot, from, to, args, pushed_at); live asks each selected online device's fr.node.bind_list instead.",
    input: z.object({
      selector: selector.optional(),
      live: z.boolean().default(false).describe("read the nodes' own tables (fr.node.bind_list) rather than the registry"),
    }),
    cli: { path: ['bind', 'ls'], positional: ['selector'] },
  }),
  op({
    name: 'binding_clear',
    kind: 'command',
    tier: 'mutate',
    summary: "Remove a device's binding in one slot, or all of them: the registry rows go, and fr.node.bind_clear is pushed now if the device is online, else at its next HELLO.",
    input: z.object({
      device: z.string().min(1).describe('the source device: an alias, id:<12hex> or any selector matching one device'),
      slot: z.union([z.number().int().min(0).max(15), z.string().regex(/^([0-9]|1[0-5]|all)$/)]).describe('a slot 0..15, or all'),
    }),
    cli: { path: ['bind', 'rm'], positional: ['device', 'slot'] },
  }),
  op({
    name: 'latency_stats',
    kind: 'query',
    tier: 'read',
    summary:
      'Latency per device over the last window_s: PING RTT p50/p99 per link, input -> hub p50/p99 (EVENT t_dev -> t_hub), binding trigger -> target RESULT p50/p99 per path (espnow, hub, flood; from node.binding_fired rtt_us) and the hub event-loop delay p99.',
    input: z.object({
      selector: selector.optional(),
      window_s: z.number().int().min(1).max(3600).default(60).describe('seconds of samples'),
    }),
    output: LatencyStatsSchema,
    cli: { path: ['latency'], positional: ['selector'] },
  }),
] as const;

export type NetOpName = (typeof NET_OPS)[number]['name'];

/** T-LAT's active probe (design c6 §6.7; stream S7), a group of its own: its handler is S7's latency/. */
export const PROBE_OPS = [
  op({
    name: 'latency_probe',
    kind: 'job',
    tier: 'mutate',
    summary:
      "T-LAT: measure button -> hub latency end to end. `from` pulses its test_pin, wired to `to`'s `input` button, with diag pin_pulse at rate_hz: on receipt (immediate) and/or at a scheduled hub time (exec_at). Each pulse is matched to `to`'s <input>.down; the result has p50/p99 per mode and link path, PING RTTs, clock uncertainty and the gate verdict. Both devices online and synced; `from` runs a debug build with a test_pin. A job (kind latency) locking both; unlike latency_stats it probes. Example: fr latency probe pad-c6 pad-c3b --count 1000 --label wifi.",
    input: z.object({
      from: deviceSel.describe('the device that pulses its test_pin (exactly one)'),
      to: deviceSel.describe('the device whose button the pin drives (exactly one)'),
      input: z.string().min(1).default('boot').describe('the button instance on `to`; its <input>.down events are matched'),
      mode: z.enum(PROBE_MODES).default('both').describe('immediate: pulse on receipt; exec_at: pulse at a scheduled hub time; both: alternate'),
      count: z.number().int().min(1).max(20_000).default(10_000).describe('samples per mode'),
      rate_hz: z.number().min(0.5).max(20).default(10).describe('pulses per second'),
      pulse_us: z.number().int().min(10).max(100_000).default(2000).describe('pulse length'),
      lead_ms: z
        .number()
        .int()
        .min(50)
        .max(1500)
        .default(250)
        .describe('exec_at: how far ahead each pulse is scheduled (a node runs a command at most 2 s ahead; the rest is margin for delay and clock error)'),
      match_timeout_ms: z.number().int().min(100).max(5000).default(1000).describe('a pulse with no matching event by then is missed'),
      ping: z.boolean().default(true).describe('PING both devices during the run (RTT per link)'),
      hub_link: z.enum(['wifi', 'wired']).default('wifi').describe("the Mac's own LAN link; p99 <= 30 ms is gated only when wired"),
      label: z.string().min(1).max(64).optional().describe('kept with the result, e.g. wifi-c6-c3b'),
      wait_s: waitS,
    }),
    output: JobSchema,
    cli: { path: ['latency', 'probe'], positional: ['from', 'to'] },
  }),
] as const;

export type ProbeOpName = (typeof PROBE_OPS)[number]['name'];
