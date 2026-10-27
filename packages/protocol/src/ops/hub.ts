// Hub ops (design c6 §3.2 and D14, spec 09 §9.4 Hub; stream S2): hub_doctor, and the output of
// hub_status (which stays in ops.ts with the C1 ops). Spread into OPS (packages/protocol/src/ops.ts);
// the hub_doctor handler is S2's, in packages/hub/src/doctor/ops.ts.

import { z } from 'zod';

import { PromptSchema } from '../events.ts';
import { cursor, op } from './common.ts';

/** One doctor check (packages/host doctor.ts Check): `fix` says what to do, `fixed` that --fix did it. */
export const CheckSchema = z.looseObject({
  id: z.string(),
  level: z.enum(['ok', 'warn', 'error']),
  detail: z.string(),
  fix: z.string().optional(),
  fixed: z.boolean().optional(),
});
export type Check = z.infer<typeof CheckSchema>;

/** The Local Network permission self-test (design c6 §5, lan/lnp.ts): a UDP connect to the LAN router. */
export const LNP_STATES = ['allowed', 'denied', 'unknown'] as const;
export type LnpState = (typeof LNP_STATES)[number];

/** The `_fractonica._tcp` advert (design c6 §5, lan/advert.ts); `off` for test hubs and --no-advert. */
export const ADVERT_STATES = ['registered', 'retrying', 'off'] as const;

/**
 * hub_status `data`. The C6 additions are optional until the stream that fills each lands: prompts
 * (S5), lnp, lnp_checked_at, launched_by, advert, dashboard (S2), sleep_guard and router.counters.
 */
export const HubStatusSchema = z.looseObject({
  version: z.string(),
  registry_hash: z.string(),
  pid: z.number().int(),
  run: z.number().int(),
  uptime_s: z.number(),
  node: z.looseObject({ version: z.string(), path: z.string() }),
  source_dir: z.string(),
  /** ESP-IDF pin check, null when not checked yet. */
  idf: z.looseObject({ ok: z.boolean() }).nullable(),
  /** The pytools sidecar, null when not checked yet. */
  pytools: z.looseObject({ ok: z.boolean() }).nullable(),
  ports: z.looseObject({ total: z.number().int(), open: z.number().int() }),
  devices: z.looseObject({ registered: z.number().int(), online: z.number().int() }),
  /** Node links (C3): the listeners' counters plus sessions per link. */
  links: z.looseObject({ sessions: z.looseObject({ tcp: z.number().int(), serial: z.number().int() }) }).optional(),
  ota: z.looseObject({ http_port: z.number().int().nullable(), listen_error: z.string().nullable(), active: z.boolean() }).optional(),
  /** Job counts by status (queued, working). */
  jobs: z.record(z.string(), z.number()),
  head: cursor,
  warnings: z.array(z.string()),
  prompts: z.array(PromptSchema).optional(),
  lnp: z.enum(LNP_STATES).optional(),
  lnp_checked_at: z.string().nullable().optional(),
  /** The app that started the hub (macOS attributes Local Network access to it). */
  launched_by: z.string().optional(),
  advert: z.looseObject({ state: z.enum(ADVERT_STATES), name: z.string().optional(), error: z.string().optional() }).optional(),
  dashboard: z.looseObject({ url: z.string(), built: z.boolean(), stale: z.boolean() }).optional(),
  sleep_guard: z.looseObject({ active: z.boolean() }).optional(),
  /**
   * The router's counters; since M2-C3 `reorder` (design m2-c3-inputs D9): ordered-port events held, released in
   * order, released without their predecessor (timeout, cap, reset), holds ended by the 8 cap, the longest hold in
   * µs, and the events held now.
   */
  /** The event store (design m2-c3-inputs D6): streaming STATEs replaced before being written, since the hub started. */
  events: z.looseObject({ state_thinned: z.number().int() }).optional(),
  router: z
    .looseObject({
      counters: z.record(z.string(), z.number()),
      reorder: z
        .looseObject({
          held: z.number().int(),
          released_in_order: z.number().int(),
          released_timeout: z.number().int(),
          overflows: z.number().int(),
          hold_us_max: z.number(),
          holding: z.number().int(),
        })
        .optional(),
    })
    .optional(),
});
export type HubStatus = z.infer<typeof HubStatusSchema>;

export const HUB_OPS = [
  op({
    name: 'hub_doctor',
    kind: 'query',
    tier: 'read',
    summary:
      "The hub's health checks, run in the hub process: fr doctor's (IDF pin, pytools, Node, firewall, LAN route, serial ports) plus its Local Network permission self-test and the _fractonica._tcp advert. Each check is ok, warn or error with a fix. `fr doctor` runs the host checks without a hub.",
    input: z.object({}),
    output: z.looseObject({ checks: z.array(CheckSchema) }),
    cli: { path: ['hub', 'doctor'] },
  }),
] as const;

export type HubOpName = (typeof HUB_OPS)[number]['name'];
