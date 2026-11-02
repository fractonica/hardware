// Registry and provisioning ops (design c3 §4, spec 09 §9.4; stream H1): device_list, device_get,
// device_update, device_provision. Spread into OPS (packages/protocol/src/ops.ts); handlers in
// packages/hub/src/registry/ops.ts. flash_start, which also writes fr_ident from the registry, stays
// in ops.ts with the other flash ops. C6 adds INVENTORY_OPS (board_list, profile_list, capability_list;
// design c6 D14, stream S2) at the end.

import { z } from 'zod';

import { DeviceViewSchema, PRESENCES } from '../types.ts';
import { deviceSel, op, portSel, waitS } from './common.ts';
import { networkName } from './network.ts';

export { deviceSel } from './common.ts';

/** The 09 §9.2 selector grammar, as agents read it in a field description, with the fixture rule of design m2-c1-hil D6. */
export const SELECTOR_HELP =
  'device selector: alias | id:<12hex> | mac:<mac> | tag:<t> | board:<b> | chip:<esp32c3|esp32c5|esp32c6|esp32s3> | profile:<p> | role:<node|gateway|fixture> | online | offline | all; "," combines (alternatives within one kind, narrowing across kinds), "!" excludes; the HIL fixture is picked only by its alias, id:, mac: or role:fixture, never by all or a "!"-only selector';

/**
 * A gateway's bridge as this hub run sees it (design m2-c4-gateway D15, D17): hub_status `links.gateways[G]` and the
 * gateway's own device_get `router.gateway`. Down after 1 s without a LINK_PONG; `status` is its last GW_STATUS.
 */
export const GatewayInfoSchema = z.looseObject({
  alias: z.string(),
  up: z.boolean(),
  rtt_us: z.number().nullable(),
  last_pong_ms_ago: z.number().nullable(),
  status: z.record(z.string(), z.unknown()).nullable(),
  /** Node sessions through it. */
  sessions: z.number().int(),
});

/** What this hub run knows of a device's link (device_get `router`; the hub's router DeviceLinkInfo). */
export const DeviceLinkInfoSchema = z.looseObject({
  presence: z.enum(PRESENCES),
  /** Links with a session, best first (gateway: through a gateway's bridge, design m2-c4-gateway D17). */
  links: z.array(z.enum(['serial', 'tcp', 'gateway'])),
  udp_ms_ago: z.number().nullable(),
  udp_blocked: z.boolean(),
  epoch: z.number().int().nullable(),
  addr: z.number().int(),
  fw_id_prefix: z.string().nullable(),
  ota_state: z.string().nullable(),
  /** HELLO caps bits (b1 wifi, b4 inject_enabled, b5 provisioned; 05 §5.7). */
  hello_caps: z.number().int().nullable(),
  hb_interval_ms: z.number(),
  last_rx_ms_ago: z.number().nullable(),
  clock: z.looseObject({ offset_us: z.number(), uncertainty_us: z.number(), skew_ppm: z.number(), rtt_us: z.number(), at_us: z.number(), samples: z.number() }).nullable(),
  heartbeat: z.record(z.string(), z.unknown()).nullable(),
  /** The property mirror: `<instance>.<property>` -> value. */
  properties: z.record(z.string(), z.unknown()),
  instances: z.array(z.looseObject({ name: z.string(), port: z.number().int(), cap: z.string(), cap_id: z.number().int() })).nullable(),
  /** The alias of the gateway its gateway session goes through, null without one (design m2-c4-gateway D17). */
  gw: z.string().nullable().optional(),
  /** For a gateway: its bridge (GatewayInfoSchema); null for any other device. */
  gateway: GatewayInfoSchema.nullable().optional(),
});

/** A capability instance as capability_list reports it: live from the router, else the build's manifest. */
export const CapInstanceSchema = z.looseObject({
  name: z.string(),
  port: z.number().int(),
  cap: z.string(),
  cap_id: z.number().int(),
  /** Capability version, e.g. 1.0. */
  v: z.string(),
  /** From the running build's manifest (design c6 D13); null for firmware the hub did not build. */
  traits: z.record(z.string(), z.unknown()).nullable(),
  driver: z.string().optional(),
});

export const REGISTRY_OPS = [
  op({
    name: 'device_list',
    kind: 'query',
    tier: 'read',
    mcp: { alwaysLoad: true },
    summary:
      'Registered devices (provisioned, and seen-only ones with provisioned=false and addr=null) with alias, addr, profile, chip, tags, presence and USB port, at most 100. Example: selector "tag:poc,online".',
    input: z.object({
      selector: z.string().min(1).optional().describe(`${SELECTOR_HELP} (default all)`),
    }),
    output: z.looseObject({ devices: z.array(DeviceViewSchema), count: z.number().int(), truncated: z.boolean() }),
    cli: { path: ['devices', 'ls'], positional: ['selector'] },
  }),
  op({
    name: 'device_get',
    kind: 'query',
    tier: 'read',
    summary:
      'One device: its registry row, presence, USB port, what this hub run knows of its link (router: links, clock offset, last heartbeat, property mirror; null before its first HELLO) and the record of its last fr_ident write (never the Wi-Fi password).',
    input: z.object({ device: deviceSel }),
    output: DeviceViewSchema.extend({ provision: z.record(z.string(), z.unknown()).nullable(), router: DeviceLinkInfoSchema.nullable() }),
    cli: { path: ['devices', 'get'], positional: ['device'] },
  }),
  op({
    name: 'device_update',
    kind: 'command',
    tier: 'mutate',
    summary:
      'Rename a device and/or edit its tags. A new alias (RFC 1123 label, at most 31 characters, unique) bumps alias_rev and is pushed to the device if it is online (otherwise on its next HELLO). Example: --alias pad-red-1 --tag +poc,-old.',
    input: z.object({
      device: deviceSel,
      alias: z.string().min(1).max(63).optional().describe('new alias, e.g. pad-red-1'),
      tag: z.string().min(1).optional().describe('comma-separated tag edits: +t (or t) adds, -t removes'),
    }),
    cli: { path: ['devices', 'set'], positional: ['device'] },
  }),
  op({
    name: 'device_provision',
    kind: 'job',
    tier: 'mutate',
    summary:
      'Provision a USB-attached board (first flash): probe it, register it (addr, alias, net), write the newest debug artifact of its profile plus fr_ident (Wi-Fi from network_set, hub host) in one write_flash, reset it, wait for its HELLO on serial, then report whether it joined over Wi-Fi (wifi: joined | not_joined, via: tcp, or gateway_status for a role: gateway profile, which opens no TCP and shows the AP in its GW_STATUS; off for a radio-off profile such as the HIL fixture\'s). Example: --port 1cdbd416ba34 --profile c6-pad.',
    input: z.object({
      port: portSel,
      profile: z.string().optional().describe('profile to flash; default: the registry profile, else the only one built for the probed chip'),
      build: z.string().optional().describe('build_id; default: newest debug artifact of the profile'),
      alias: z.string().min(1).max(63).optional().describe('alias; default: the registry alias, else <profile>-<last 6 hex of the MAC>'),
      network: networkName.optional().describe('the stored network it joins (network_list); default: the registry row\'s, else default'),
      wait_s: waitS,
    }),
    cli: { path: ['devices', 'provision'] },
  }),
] as const;

export type RegistryOpName = (typeof REGISTRY_OPS)[number]['name'];

/**
 * What the hub's checkout and catalog offer (design c6 D14; stream S2): board_list, profile_list and
 * capability_list. A group of their own, so their handlers live apart from the registry's.
 */
export const INVENTORY_OPS = [
  op({
    name: 'board_list',
    kind: 'query',
    tier: 'read',
    summary: "Boards the hub's checkout describes (hardware/boards): id, chip, flash size, button and LED names, and the T-LAT test_pin (null without one).",
    input: z.object({}),
    output: z.looseObject({
      boards: z.array(
        z.looseObject({
          board: z.string(),
          chip: z.string(),
          flash: z.string(),
          buttons: z.array(z.string()),
          leds: z.array(z.string()),
          test_pin: z.number().int().nullable(),
        }),
      ),
    }),
    cli: { path: ['boards', 'ls'] },
  }),
  op({
    name: 'profile_list',
    kind: 'query',
    tier: 'read',
    summary:
      "Firmware profiles in the hub's checkout (firmware/profiles): board, chip, app, capability instances with their drivers, and the newest debug build of each (build_id, fw_id, built_at), for build_start and device_provision.",
    input: z.object({}),
    output: z.looseObject({
      profiles: z.array(
        z.looseObject({
          profile: z.string(),
          board: z.string(),
          chip: z.string(),
          app: z.string(),
          instances: z.record(z.string(), z.looseObject({ cap: z.string(), driver: z.string() })),
          newest_debug: z.looseObject({ build_id: z.string(), fw_id: z.string(), built_at: z.string() }).optional(),
        }),
      ),
    }),
    cli: { path: ['profiles', 'ls'] },
  }),
  op({
    name: 'capability_list',
    kind: 'query',
    tier: 'read',
    summary:
      "The capability catalog the hub runs (catalog_hash, each capability's commands, events and properties); with device, also that device's instances (port, capability, version, traits, driver), as the router knows them this run, else from its build's manifest. Example: device pad-c6.",
    input: z.object({ device: deviceSel.optional() }),
    output: z.looseObject({
      catalog_hash: z.number().int(),
      caps: z.array(z.record(z.string(), z.unknown())),
      device: z.looseObject({ instances: z.array(CapInstanceSchema) }).optional(),
    }),
    cli: { path: ['caps', 'ls'] },
  }),
] as const;

export type InventoryOpName = (typeof INVENTORY_OPS)[number]['name'];
