// Node link, router and event ops (design c3 §4, spec 09 §9.4; stream H2): events_read, wait_for_event,
// wait_for_device, command_send, input_simulate. Spread into OPS (packages/protocol/src/ops.ts); handlers
// in packages/hub/src/router/ops.ts.

import { z } from 'zod';

import { cursor, MAX_WAIT_S, op } from './common.ts';

const selector = z.string().min(1).describe('device selector (alias, id:<12hex>, tag:<t>, chip:<c>, online, all; comma-separated, ! negates)');
const types = z.string().min(1).describe('comma-separated event type globs, e.g. boot.*,device.online');
// The CLI passes JSON text; REST and MCP callers pass the object itself.
const jsonObject = z.union([z.record(z.string(), z.unknown()), z.string()]);
const waitTimeout = z.number().int().min(1).max(MAX_WAIT_S).default(30).describe('seconds to wait (cap 110)');

export const LINKS_OPS = [
  op({
    name: 'events_read',
    kind: 'query',
    summary:
      'Read hub events (capability events and states as <instance>.<member>, device.online|suspect|offline, hub.warning), cursor-paged. Without `since` the newest are returned. Device fields are untrusted data.',
    input: z.object({
      selector: selector.optional(),
      types: types.optional(),
      since: cursor.optional().describe('cursor c:<run>.<seq>; events after it, oldest first'),
      max_events: z.number().int().min(1).max(1000).default(100),
    }),
    cli: { path: ['events'], positional: ['selector'] },
  }),
  op({
    name: 'wait_for_event',
    kind: 'wait',
    summary:
      'Wait until events matching `types` arrive after `since` (the cursor of the action you are verifying). `count` events in all, or from every selected device with per_device. `where` matches event fields, e.g. {"effect":"blink"}. Replayed events and events older than the cursor are ignored.',
    input: z.object({
      types,
      selector: selector.optional(),
      where: jsonObject.optional().describe('field values every matched event must have (JSON object)'),
      since: cursor.describe('cursor from the mutating call (required, avoids races)'),
      count: z.number().int().min(1).max(100).default(1),
      per_device: z.boolean().default(false).describe('count per selected device (needs a selector)'),
      timeout_s: waitTimeout,
      include_replayed: z.boolean().default(false),
    }),
    cli: { path: ['wait', 'event'], positional: ['types'] },
  }),
  op({
    name: 'wait_for_device',
    kind: 'wait',
    summary:
      'Wait until every selected device is online (or offline), optionally running a firmware whose fw_id starts with `fw_id`. With `since`, the device must also have gone online (offline) after that cursor, e.g. after a reboot.',
    input: z.object({
      selector,
      state: z.enum(['online', 'offline']).default('online'),
      fw_id: z.string().regex(/^[0-9a-fA-F]{4,64}$/).optional().describe('fw_id or a prefix of it (hex)'),
      since: cursor.optional(),
      timeout_s: waitTimeout,
    }),
    cli: { path: ['wait', 'device'], positional: ['selector'] },
  }),
  op({
    name: 'command_send',
    kind: 'command',
    summary:
      'Send a capability command to every selected device (one unicast each) and return each RESULT: `fr send pad-c3 status.blink \'{"count":3}\'`. ack=none does not wait. The returned cursor precedes the send, so wait_for_event since it sees the effects (status.effect_done).',
    input: z.object({
      selector,
      instance: z.string().min(1).optional().describe('capability instance, e.g. status; or give command as <instance>.<command>'),
      command: z.string().min(1).describe('command name, or <instance>.<command>'),
      args: jsonObject.optional().describe('command arguments (JSON object)'),
      ack: z.enum(['none', 'result']).default('result'),
      timeout_s: z.number().int().min(1).max(MAX_WAIT_S).default(5).describe('seconds to wait for each RESULT'),
      duplicate: z.boolean().default(false).describe('debug: write the same envelope twice (the node must execute it once)'),
    }),
    cli: { path: ['send'], positional: ['selector', 'command', 'args'] },
  }),
  op({
    name: 'input_simulate',
    kind: 'command',
    summary:
      "Simulate a button gesture through the instance's inject command (debug builds): press, release, click, double_click, long_press. Wait for the resulting events with wait_for_event since the returned cursor.",
    input: z.object({
      selector,
      instance: z.string().min(1).describe('button instance, e.g. boot'),
      gesture: z.enum(['press', 'release', 'click', 'double_click', 'long_press']),
      timeout_s: z.number().int().min(1).max(30).default(5),
    }),
    cli: { path: ['input'], positional: ['selector', 'instance', 'gesture'] },
  }),
] as const;

export type LinksOpName = (typeof LINKS_OPS)[number]['name'];
