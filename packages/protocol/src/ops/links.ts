// Node link, router and event ops (design c3 §4, spec 09 §9.4; stream H2): events_read, wait_for_event,
// wait_for_device, command_send, input_simulate. Spread into OPS (packages/protocol/src/ops.ts); handlers
// in packages/hub/src/router/ops.ts. C6 adds wait_for_event.prompt_human (design c6 D3; stream S5), M2-C1
// input_simulate's `layer` and gesture `bounce` (design m2-c1-hil D8), M2-C3 input_simulate's analog `value` /
// `mv` and `hold_ms` (design m2-c3-inputs D7).

import { z } from 'zod';

import { OtaState } from '../gen/protocol.ts';
import { cursor, MAX_WAIT_S, op } from './common.ts';

const selector = z.string().min(1).describe('device selector (alias, id:<12hex>, tag:<t>, chip:<c>, online, all; comma-separated, ! negates)');
const types = z.string().min(1).describe('comma-separated event type globs, e.g. boot.*,device.online');
// The CLI passes JSON text; REST and MCP callers pass the object itself.
const jsonObject = z.union([z.record(z.string(), z.unknown()), z.string()]);
const waitTimeout = z.number().int().min(1).max(MAX_WAIT_S).default(30).describe('seconds to wait (cap 110)');

/**
 * Where input_simulate acts (design m2-c1-hil D8): `inject`, the instance's inject command (debug builds);
 * `gpio`, a real press by the HIL fixture on a bench-wired line (any build). inject stays the default, so an
 * unchanged call keeps its meaning.
 */
export const INPUT_LAYERS = ['inject', 'gpio'] as const;
export type InputLayer = (typeof INPUT_LAYERS)[number];
/** input_simulate gestures; `bounce` (a bouncy click, judged on counts) is gpio-only. */
export const INPUT_GESTURES = ['press', 'release', 'click', 'double_click', 'long_press', 'bounce'] as const;
export type InputGesture = (typeof INPUT_GESTURES)[number];
/** The longest inject hold of an analog value (fr.analog_in inject: 0 means 1,000 ms, at most 60,000). */
export const INPUT_HOLD_MS_MAX = 60_000;

export const LINKS_OPS = [
  op({
    name: 'events_read',
    kind: 'query',
    tier: 'read',
    summary:
      'Read hub events (capability events and states as <instance>.<member>, e.g. node.binding_fired; msg {topic, data, dst} for MSGs from nodes; device.online|suspect|offline, ota.job.state, hub.warning), cursor-paged. Without `since` the newest are returned. Every EVENT and STATE is stored, except that STATE of a streaming capability (fr.analog_in value) is thinned to one row per property per second, the newest always kept; live subscribers and wait_for_event see every one. Device fields are untrusted data.',
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
    tier: 'read',
    summary:
      'Wait until events matching `types` arrive after `since` (the cursor of the action you are verifying). `count` events in all, or from every selected device with per_device. `where` matches event fields, e.g. {"effect":"blink"}. Replayed events and events older than the cursor are ignored. prompt_human asks a person at the Mac for a real action (a dashboard toast, hub.prompt) while it waits; say it in chat too. Example: types boot.down, prompt_human "Press BOOT on pad-c6".',
    input: z.object({
      types,
      selector: selector.optional(),
      where: jsonObject.optional().describe('field values every matched event must have (JSON object)'),
      since: cursor.describe('cursor from the mutating call (required, avoids races)'),
      count: z.number().int().min(1).max(100).default(1),
      per_device: z.boolean().default(false).describe('count per selected device (needs a selector)'),
      timeout_s: waitTimeout,
      include_replayed: z.boolean().default(false),
      // Design c6 D3: hub.prompt / hub.prompt_done around the wait; the result adds prompt_id.
      prompt_human: z.string().min(1).max(120).optional().describe('ask a person at the Mac to act while waiting (dashboard toast), e.g. "Press BOOT on pad-c6"'),
    }),
    cli: { path: ['wait', 'event'], positional: ['types'] },
  }),
  op({
    name: 'wait_for_device',
    kind: 'wait',
    tier: 'read',
    summary:
      'Wait until every selected device is online (or offline), optionally running a firmware whose fw_id starts with `fw_id`, and with `ota_state` in its HELLO (pending_verify while a new OTA image runs its health check, valid after). With `since`, the device must also have gone online (offline) after that cursor, e.g. after a reboot.',
    input: z.object({
      selector,
      state: z.enum(['online', 'offline']).default('online'),
      fw_id: z.string().regex(/^[0-9a-fA-F]{4,64}$/).optional().describe('fw_id or a prefix of it (hex)'),
      ota_state: z
        .enum(Object.keys(OtaState) as [keyof typeof OtaState, ...(keyof typeof OtaState)[]])
        .optional()
        .describe('with state online: the HELLO ota_state of the running image'),
      since: cursor.optional(),
      timeout_s: waitTimeout,
    }),
    cli: { path: ['wait', 'device'], positional: ['selector'] },
  }),
  op({
    name: 'command_send',
    kind: 'command',
    tier: 'mutate',
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
    tier: 'mutate',
    summary:
      "Simulate an input; give exactly one of gesture (fr.button: press, release, click, double_click, long_press), value (0..65535) or mv (fr.analog_in). An instance of the other capability is invalid_input. layer inject (default) runs the instance's inject command (debug builds): press is a raw hold (down only, no long_press or click); a value holds for hold_ms (default 1,000, max 60,000), mv mapped by the instance's min_mv/max_mv. layer gpio uses the HIL fixture on a bench-wired line (any build; see bench_get): press is a real hold (long_press at long_press_ms, a click if released before), bounce (gpio only) a click with contact bounce, and mv (or value) sets the line's PWM setpoint until changed or 0 (no hold_ms); setpoint.at_hub_us says when. Wait for the events with wait_for_event since the returned cursor.",
    input: z.object({
      selector,
      instance: z.string().min(1).describe('button or analog instance, e.g. boot, analog'),
      gesture: z.enum(INPUT_GESTURES).optional().describe('fr.button: the gesture (exactly one of gesture, value, mv)'),
      value: z.number().int().min(0).max(65535).optional().describe('fr.analog_in: the value 0..65535 over the instance min_mv..max_mv'),
      mv: z.number().int().min(0).max(5500).optional().describe('fr.analog_in: millivolts, converted with the instance min_mv/max_mv (inject) or the bench vdd_mv (gpio)'),
      hold_ms: z
        .number()
        .int()
        .min(0)
        .max(INPUT_HOLD_MS_MAX)
        .optional()
        .describe('layer inject, value or mv: how long the node holds the value (0 or absent: 1,000 ms)'),
      layer: z
        .enum(INPUT_LAYERS)
        .default('inject')
        .describe("inject: the instance's inject command (debug builds); gpio: the HIL fixture on a bench-wired line (a real press, or a PWM setpoint)"),
      timeout_s: z.number().int().min(1).max(30).default(5),
    }),
    cli: { path: ['input'], positional: ['selector', 'instance', 'gesture'] },
  }),
] as const;

export type LinksOpName = (typeof LINKS_OPS)[number]['name'];
