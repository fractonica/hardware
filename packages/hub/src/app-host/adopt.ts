// device_adopt (design uno-q-host §2.3, UNOQ-1 step 5): provisioning for a node that joins over the network by itself
// (a Linux node: the UNO Q's qonu-node on fr_posix), which has no fr_ident partition to flash. The registry row is
// prepared and marked provisioned as a flash would (prepareIdentity, markIdentWritten); the identity goes to the node
// over its session as a MSG from the hub, topic `fr.adopt`, data {addr, net, alias, alias_rev, epoch_floor}. The node
// saves it and restarts with it (a new epoch, a provisioned HELLO), and apps see it from then on.
import { DEFAULT_NETWORK, FrError } from '@fractonica/protocol';

import type { HubContext } from '../context.ts';
import { readNetwork, listNetworks } from '../network.ts';
import { presenceOf, resolveOne } from '../registry/hub.ts';
import { markIdentWritten, prepareIdentity } from '../registry/store.ts';

export const ADOPT_TOPIC = 'fr.adopt';

export async function adopt(hub: HubContext, input: { device: string; alias?: string; network?: string }) {
  const d = resolveOne(hub, input.device);
  const presence = presenceOf(hub)(d.device_id);
  if (presence !== 'online' && presence !== 'suspect') {
    throw new FrError('DEVICE_OFFLINE', `${d.alias} has no session: adopt it while it is connected`);
  }
  const name = input.network ?? DEFAULT_NETWORK;
  const net = readNetwork(hub.db, name);
  if (!net) {
    const known = listNetworks(hub.db).map((n) => n.name);
    throw new FrError(known.length ? 'NOT_FOUND' : 'ENV_MISSING', known.length ? `no network ${name} is stored (stored: ${known.join(', ')})` : 'no network is stored: its id is what the node joins', {
      hint: 'fr net set --ssid <your Wi-Fi> (the password can wait until an ESP32 needs it)',
      remediation: [{ tool: 'network_set', args: { name }, cli: `fr net set${name === DEFAULT_NETWORK ? '' : ` --name ${name}`} --ssid <ssid>` }],
    });
  }
  const prep = prepareIdentity(hub.db, {
    deviceId: d.device_id,
    alias: input.alias ?? (d.alias || undefined),
    profile: d.profile,
    board: d.board,
    chip: d.chip,
    net: net.net_id,
    network: net.name,
  });
  const dev = prep.device;
  const data = new TextEncoder().encode(
    JSON.stringify({ addr: dev.addr, net: dev.net, alias: dev.alias, alias_rev: dev.alias_rev, epoch_floor: prep.epoch_floor }),
  );
  const sent = await hub.broadcast.sendMsg(d.device_id, ADOPT_TOPIC, data, { timeoutMs: 3000 });
  if (sent.status !== 0) {
    throw new FrError('DELIVERY_FAILED', `${d.alias} did not take the identity (status ${sent.status}); the registry row stays unprovisioned`);
  }
  const done = markIdentWritten(hub.db, d.device_id, {
    at: new Date().toISOString(),
    via: 'provision',
    build_id: null,
    fw_id: d.fw_id ?? null,
    profile: d.profile,
    board: d.board,
    part_profile: null,
    ident: { offset: 0, size: 0 },
    addr: dev.addr!,
    alias: dev.alias,
    alias_rev: dev.alias_rev,
    epoch_floor: prep.epoch_floor,
    net: dev.net!,
    // The node keeps its own hub host and Wi-Fi (qonu-node set-hub, iwd); nothing of them is written here.
    hub_host: '',
    ssid: net.ssid,
    network: net.name,
    prov_ts: Math.floor(Date.now() / 1000),
  });
  return { ...done, presence: presenceOf(hub)(d.device_id) };
}
