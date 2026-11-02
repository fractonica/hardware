// Network pieces (design csi-c1 D4-D6; stream H implements them): the hub keeps several Wi-Fi networks, each named and
// with a band, all under the fleet's one net_id; a device joins the one its registry row names. network_set,
// network_get and network_list are in OPS (packages/protocol/src/ops.ts); device_provision and flash_start take
// `network`. The node reads the band from fr_ident (fr_net `band`, u8: NETWORK_BAND_IDENT).

import { z } from 'zod';

/** The network every hub has: the single network of hubs before csi-c1, and a device's default. */
export const DEFAULT_NETWORK = 'default';

/** A network's band (D4): what the node passes to esp_wifi_set_band_mode on a 5 GHz chip (D6). */
export const NETWORK_BANDS = ['auto', '2g', '5g'] as const;
export type NetworkBand = (typeof NETWORK_BANDS)[number];

/** fr_ident fr_net `band` (u8; 06 §6.3): auto 0 (absent reads as auto), 2g 1, 5g 2. */
export const NETWORK_BAND_IDENT: Readonly<Record<NetworkBand, number>> = { auto: 0, '2g': 1, '5g': 2 };

/** A network name: a lowercase label, e.g. default, 5g, lab-2g (at most 31 characters). */
export const networkName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,30}$/, 'expected a lowercase label, e.g. 5g')
  .describe('network name, e.g. default, 5g');

/** One stored network as network_get and network_list report it (never the password). */
export const NetworkSchema = z.looseObject({
  name: z.string(),
  ssid: z.string(),
  bssid: z.string().nullable(),
  country: z.string().nullable(),
  band: z.enum(NETWORK_BANDS),
  /** The fleet's logical frame net, the same for every network (D4). */
  net_id: z.number().int(),
  hub_host: z.string(),
  /** secrets.json holds a password for it. */
  password_set: z.boolean(),
  /** Registered devices whose row names this network. */
  devices: z.number().int().optional(),
});
export type Network = z.infer<typeof NetworkSchema>;
