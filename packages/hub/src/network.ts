// The Wi-Fi networks nodes are provisioned with (`networks`, spec 08 §8.8; design c3 §4, csi-c1 D4-D5): one row per
// named network (the network of hubs before csi-c1 is `default`), each with its band. Passwords live only in
// secrets.json (`wifi_passwords[name]`). For a hub downgraded to before csi-c1, which reads `networks WHERE id = 1` and
// secrets.json's single `wifi_password`: default always sits at id 1 (other networks from 2 up), and `wifi_password`
// stays written as a copy of default's password.
// Every network shares the fleet's net_id (the logical frame net, D4): a random u16 != 0 created with the first record
// and kept by later changes; hub_host is the Mac's mDNS name, which nodes resolve on every connect.

import { execFileSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';

import { paths } from '@fractonica/host';
import { DEFAULT_NETWORK, FrError, NETWORK_BANDS, type NetworkBand } from '@fractonica/protocol';

import type { Db } from './db.ts';

export interface NetworkRecord {
  name: string;
  ssid: string;
  bssid: string | null;
  country: string | null;
  band: NetworkBand;
  /** u16, 1..65535: every provisioned node's `net`, the same for every network (D4). */
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

type Row = Omit<NetworkRecord, 'net_id' | 'hub_host' | 'band'> & { net_id: number | null; hub_host: string | null; band: string };

const COLUMNS = 'name, ssid, bssid, country, band, net_id, hub_host, updated_at';

/** The fleet's net_id: default's, else any stored network's; null before the first network record (or one with it). */
export function fleetNetId(db: Db): number | null {
  const r = db.prepare(`SELECT net_id FROM networks WHERE net_id IS NOT NULL ORDER BY (name = ?) DESC, name LIMIT 1`).get(DEFAULT_NETWORK) as { net_id: number } | undefined;
  return r?.net_id ?? null;
}

function band(v: string): NetworkBand {
  return (NETWORK_BANDS as readonly string[]).includes(v) ? (v as NetworkBand) : 'auto';
}

/** A row as read, a record from before C3 given the fleet's net_id (or a new one) and the hub host. */
function complete(db: Db, row: Row): NetworkRecord {
  if (row.net_id === null || row.hub_host === null) {
    row.net_id ??= fleetNetId(db) ?? newNetId();
    row.hub_host ??= hubHostName();
    db.prepare('UPDATE networks SET net_id = ?, hub_host = ? WHERE name = ?').run(row.net_id, row.hub_host, row.name);
  }
  return { ...row, band: band(row.band) } as NetworkRecord;
}

/** The named record (default unless named), or null when none was set. */
export function readNetwork(db: Db, name: string = DEFAULT_NETWORK): NetworkRecord | null {
  const row = db.prepare(`SELECT ${COLUMNS} FROM networks WHERE name = ?`).get(name) as Row | undefined;
  return row ? complete(db, row) : null;
}

/** Every stored network, default first, then by name. */
export function listNetworks(db: Db): NetworkRecord[] {
  const rows = db.prepare(`SELECT ${COLUMNS} FROM networks ORDER BY (name = ?) DESC, name`).all(DEFAULT_NETWORK) as Row[];
  return rows.map((r) => complete(db, r));
}

/**
 * Creates or updates the named record: a new one gets the fleet's net_id (a new random one for the first network), an
 * existing one keeps it; hub_host is refreshed.
 */
export function writeNetwork(
  db: Db,
  n: { name?: string; ssid: string; bssid: string | null; country: string | null; band?: NetworkBand },
): NetworkRecord {
  const name = n.name ?? DEFAULT_NETWORK;
  db.transaction(() => {
    const netId = fleetNetId(db) ?? newNetId();
    // Older hubs read `networks WHERE id = 1`: id 1 is default's alone (also before default is set), so another network
    // there (a database written before this rule) moves up, default elsewhere moves down, and new ones count from 2.
    const at1 = db.prepare('SELECT name FROM networks WHERE id = 1').get() as { name: string } | undefined;
    if (at1 && at1.name !== DEFAULT_NETWORK) {
      db.prepare('UPDATE networks SET id = (SELECT MAX(id) + 1 FROM networks) WHERE id = 1').run();
    }
    db.prepare('UPDATE networks SET id = 1 WHERE name = ?').run(DEFAULT_NETWORK);
    const id = name === DEFAULT_NETWORK ? 1 : (db.prepare('SELECT MAX(COALESCE(MAX(id), 0), 1) + 1 AS id FROM networks').get() as { id: number }).id;
    db.prepare(
      `INSERT INTO networks (id, name, ssid, bssid, country, band, updated_at, net_id, hub_host) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET ssid = excluded.ssid, bssid = excluded.bssid, country = excluded.country, band = excluded.band,
         updated_at = excluded.updated_at, net_id = COALESCE(networks.net_id, excluded.net_id), hub_host = excluded.hub_host`,
    ).run(id, name, n.ssid, n.bssid, n.country, n.band ?? 'auto', new Date().toISOString(), netId, hubHostName());
  })();
  return readNetwork(db, name)!;
}

/** Registered devices whose row names `name` (devices.network). */
export function networkDevices(db: Db, name: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM devices WHERE network = ?').get(name) as { n: number }).n;
}

// ---- secrets.json (spec 08 §8.8): the passwords, never in SQLite, results, logs or errors ----

const notJson = (file: string) =>
  // Never pass the parse error on: V8 quotes the input, which would put secret bytes in the result.
  new FrError('ENV_MISSING', `${file} is not valid JSON`, {
    remediation: [{ human: `fix or delete ${file}, then set the networks again`, cli: 'fr net set --ssid <ssid> --password-stdin' }],
  });

export function readSecrets(): Record<string, unknown> {
  const file = paths.secrets();
  if (!existsSync(file)) {
    return {};
  }
  let v: unknown;
  try {
    v = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw notJson(file);
  }
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function writeSecrets(secrets: Record<string, unknown>): void {
  // Written to a 0600 temp file and renamed, so a crash never leaves a half-written secrets.json.
  const tmp = `${paths.secrets()}.tmp`;
  mkdirSync(dirname(tmp), { recursive: true });
  writeFileSync(tmp, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, paths.secrets());
}

/** `wifi_passwords` as stored (only string values), with the old `wifi_password` as default's when it has none. */
function passwords(secrets: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  const map = secrets.wifi_passwords;
  if (map !== null && typeof map === 'object' && !Array.isArray(map)) {
    for (const [k, v] of Object.entries(map as Record<string, unknown>)) {
      if (typeof v === 'string') {
        out[k] = v;
      }
    }
  }
  if (out[DEFAULT_NETWORK] === undefined && typeof secrets.wifi_password === 'string') {
    out[DEFAULT_NETWORK] = secrets.wifi_password;
  }
  return out;
}

/** The stored password of `name` (default unless named), or undefined (an open network). Errors never quote the file. */
export function readWifiPassword(name: string = DEFAULT_NETWORK): string | undefined {
  return passwords(readSecrets())[name];
}

/** The names that have a password stored. */
export function passwordNames(): Set<string> {
  return new Set(Object.keys(passwords(readSecrets())));
}

/**
 * Stores `name`'s password: every password goes into `wifi_passwords` (the old `wifi_password` there as default's,
 * unless default was given one now), and `wifi_password` is kept as a copy of default's (what hubs before csi-c1
 * read), absent while default has none. Other keys of secrets.json (app_token) are kept.
 */
export function writeWifiPassword(name: string, password: string): void {
  const secrets = readSecrets();
  const map = passwords(secrets);
  map[name] = password;
  if (map[DEFAULT_NETWORK] !== undefined) {
    secrets.wifi_password = map[DEFAULT_NETWORK];
  } else {
    delete secrets.wifi_password;
  }
  secrets.wifi_passwords = map;
  writeSecrets(secrets);
}

// ---- a device's network (D5) ----

/** The chips with a 5 GHz radio (SOC_WIFI_SUPPORT_5G): only the ESP32-C5 among Fractonica's targets. */
export const CHIPS_5G: ReadonlySet<string> = new Set(['esp32c5']);

/** A stored network by name; NOT_FOUND (naming the stored ones and network_set) otherwise. */
export function requireNetwork(db: Db, name: string): NetworkRecord {
  const net = readNetwork(db, name);
  if (!net) {
    const known = listNetworks(db).map((n) => n.name);
    throw new FrError(known.length ? 'NOT_FOUND' : 'ENV_MISSING', known.length ? `no network ${name} is stored (stored: ${known.join(', ')})` : 'no Wi-Fi network is stored, so the node would not know where to connect', {
      hint: 'fr net set',
      remediation: [{ tool: 'network_set', args: { name }, cli: `fr net set${name === DEFAULT_NETWORK ? '' : ` --name ${name}`} --ssid <ssid> --password-stdin` }],
    });
  }
  return net;
}

/**
 * The registered devices on network `name` whose chip has no 5 GHz radio (a chip not recorded passes, as in
 * checkBand), by alias: what a switch of that network to band 5g would strand.
 */
export function devicesWithout5g(db: Db, name: string): { alias: string; chip: string }[] {
  const rows = db.prepare('SELECT alias, chip FROM devices WHERE network = ? AND chip IS NOT NULL ORDER BY alias').all(name) as { alias: string; chip: string }[];
  return rows.filter((r) => !CHIPS_5G.has(r.chip));
}

/** D6: a 5g network only for a chip that has 5 GHz; INCOMPATIBLE_PROFILE otherwise (an unknown chip passes). */
export function checkBand(net: Pick<NetworkRecord, 'name' | 'band'>, chip: string | null | undefined, who: string): void {
  if (net.band === '5g' && chip && !CHIPS_5G.has(chip)) {
    throw new FrError('INCOMPATIBLE_PROFILE', `network ${net.name} is 5 GHz only (band 5g), but ${who} is an ${chip}, which has no 5 GHz radio (only ${[...CHIPS_5G].join(', ')} has)`, {
      hint: 'provision it onto a 2g or auto network instead',
      remediation: [{ tool: 'network_list', cli: 'fr net ls' }],
    });
  }
}
