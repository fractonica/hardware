// Registry and provisioning ops (design c3 §4, spec 09 §9.4; stream H1): device_list, device_get,
// device_update, device_provision. Spread into OPS (packages/protocol/src/ops.ts); handlers in
// packages/hub/src/registry/ops.ts. flash_start, which also writes fr_ident from the registry, stays
// in ops.ts with the other flash ops.

import { z } from 'zod';

import { op, portSel, waitS } from './common.ts';

/** The 09 §9.2 selector grammar, as agents read it in a field description. */
export const SELECTOR_HELP =
  'device selector: alias | id:<12hex> | mac:<mac> | tag:<t> | board:<b> | chip:<esp32c3|esp32c6|esp32s3> | profile:<p> | role:<node|gateway> | online | offline | all; "," combines (alternatives within one kind, narrowing across kinds), "!" excludes';

/** A selector that must name exactly one device. */
export const deviceSel = z.string().min(1).describe('the device: an alias, id:<12hex> or any selector that matches exactly one device');

export const REGISTRY_OPS = [
  op({
    name: 'device_list',
    kind: 'query',
    summary:
      'Registered devices (provisioned, and seen-only ones with provisioned=false and addr=null) with alias, addr, profile, chip, tags, presence and USB port, at most 100. Example: selector "tag:poc,online".',
    input: z.object({
      selector: z.string().min(1).optional().describe(`${SELECTOR_HELP} (default all)`),
    }),
    cli: { path: ['devices', 'ls'], positional: ['selector'] },
  }),
  op({
    name: 'device_get',
    kind: 'query',
    summary:
      'One device: its registry row, presence, USB port, what this hub run knows of its link (router: links, clock offset, last heartbeat, property mirror; null before its first HELLO) and the record of its last fr_ident write (never the Wi-Fi password).',
    input: z.object({ device: deviceSel }),
    cli: { path: ['devices', 'get'], positional: ['device'] },
  }),
  op({
    name: 'device_update',
    kind: 'command',
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
    summary:
      'Provision a USB-attached board (first flash): probe it, register it (addr, alias, net), write the newest debug artifact of its profile plus fr_ident (Wi-Fi from network_set, hub host) in one write_flash, reset it, wait for its HELLO on serial, then report whether it joined over Wi-Fi (wifi: joined | not_joined). Example: --port 1cdbd416ba34 --profile c6-pad.',
    input: z.object({
      port: portSel,
      profile: z.string().optional().describe('profile to flash; default: the registry profile, else the only one built for the probed chip'),
      build: z.string().optional().describe('build_id; default: newest debug artifact of the profile'),
      alias: z.string().min(1).max(63).optional().describe('alias; default: the registry alias, else <profile>-<last 6 hex of the MAC>'),
      wait_s: waitS,
    }),
    cli: { path: ['devices', 'provision'] },
  }),
] as const;

export type RegistryOpName = (typeof REGISTRY_OPS)[number]['name'];
