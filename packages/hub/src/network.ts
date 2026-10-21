// The Wi-Fi network record (`networks`, spec 08 §8.8; design c3 §4) nodes are provisioned with. Its
// password lives only in secrets.json (ops.ts). net_id is a random u16 != 0 created with the record
// and kept by later changes; hub_host is the Mac's mDNS name, which nodes resolve on every connect.

import { execFileSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { hostname } from 'node:os';

import type { Db } from './db.ts';

export interface NetworkRecord {
  ssid: string;
  bssid: string | null;
  country: string | null;
  /** u16, 1..65535: every provisioned node's `net`. */
  net_id: number;
  /** `<LocalHostName>.local`. */
  hub_host: string;
  updated_at: string;
}

let localHost: string | null = null;

/** `scutil --get LocalHostName` + `.local` (macOS answers mDNS for it whatever the Local Network
 * Privacy state); elsewhere the short host name. Read once per process. */
export function hubHostName(): string {
  if (localHost === null) {
    let name = '';
    try {
      name = execFileSync('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      // not macOS, or no LocalHostName set
    }
    if (!name) {
      name = hostname().replace(/\.local$/, '').split('.')[0];
    }
    localHost = `${name}.local`;
  }
  return localHost;
}

function newNetId(): number {
  return randomInt(1, 0x10000);
}

type Row = Omit<NetworkRecord, 'net_id' | 'hub_host'> & { net_id: number | null; hub_host: string | null };

/** The record, or null when none was set. A record from before C3 gets its net_id and hub_host here. */
export function readNetwork(db: Db): NetworkRecord | null {
  const row = db.prepare('SELECT ssid, bssid, country, net_id, hub_host, updated_at FROM networks WHERE id = 1').get() as Row | undefined;
  if (!row) {
    return null;
  }
  if (row.net_id === null || row.hub_host === null) {
    row.net_id ??= newNetId();
    row.hub_host ??= hubHostName();
    db.prepare('UPDATE networks SET net_id = ?, hub_host = ? WHERE id = 1').run(row.net_id, row.hub_host);
  }
  return row as NetworkRecord;
}

/** Creates or updates the record: a new one gets a net_id, an existing one keeps it; hub_host is refreshed. */
export function writeNetwork(db: Db, n: { ssid: string; bssid: string | null; country: string | null }): NetworkRecord {
  db.prepare(
    `INSERT INTO networks (id, ssid, bssid, country, updated_at, net_id, hub_host) VALUES (1, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET ssid = excluded.ssid, bssid = excluded.bssid, country = excluded.country,
       updated_at = excluded.updated_at, net_id = COALESCE(networks.net_id, excluded.net_id), hub_host = excluded.hub_host`,
  ).run(n.ssid, n.bssid, n.country, new Date().toISOString(), newNetId(), hubHostName());
  return readNetwork(db)!;
}
