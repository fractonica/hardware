// Node <-> node ops (design c5 §4, spec 09 §9.4-9.5; stream H1): message_send, binding_set, binding_list,
// binding_clear and latency_stats. Spread into OPS (packages/protocol/src/ops.ts); handlers in
// packages/hub/src/bindings/ops.ts.

import { z } from 'zod';

import { op, waitS } from './common.ts';

const selector = z.string().min(1).describe('device selector (alias, id:<12hex>, tag:<t>, chip:<c>, online, all; comma-separated, ! negates)');
// The CLI passes JSON text; REST and MCP callers pass the value itself.
const jsonObject = z.union([z.record(z.string(), z.unknown()), z.string()]);

/** `"broadcast"`: the reserved alias message_send and binding targets use for every node (09 §9.4). */
export const BROADCAST_ALIAS = 'broadcast';

export const NET_OPS = [
  op({
    name: 'message_send',
    kind: 'job',
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
    summary:
      'Latency per device over the last window_s: PING RTT p50/p99 per link, input -> hub p50/p99 (EVENT t_dev -> t_hub), binding trigger -> target RESULT p50/p99 per path (espnow, hub, flood; from node.binding_fired rtt_us) and the hub event-loop delay p99.',
    input: z.object({
      selector: selector.optional(),
      window_s: z.number().int().min(1).max(3600).default(60).describe('seconds of samples'),
    }),
    cli: { path: ['latency'], positional: ['selector'] },
  }),
] as const;

export type NetOpName = (typeof NET_OPS)[number]['name'];
