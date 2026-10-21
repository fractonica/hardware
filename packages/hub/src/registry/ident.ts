// fr_ident (spec 06 §6.3): the read-only NVS partition the hub writes with the firmware. Its CSV is
// rendered from the registry row and the active network record plus the Wi-Fi password, in a 0700 temp
// dir that is deleted when the job ends, and converted with the sidecar's nvs_gen (which never echoes the
// CSV). The password reaches only that CSV: never SQLite, logs, job logs, results or errors (design c3 §8).
// The temp dirs live under FR_HOME (tmp/ident, 0700), which only the hub holding hub.lock writes: a hub
// that dies mid-flash leaves them there, and the next start removes them (sweepIdentDirs).

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';

import { paths } from '@fractonica/host';
import { FrError } from '@fractonica/protocol';

import { type PytoolsRequest, runPytools } from '../flash.ts';
import type { JobCtx } from '../jobs.ts';
import type { NetworkRecord } from '../network.ts';

/** fr_ident schema version (06 §6.3, key `schema`). */
export const IDENT_SCHEMA = 1;

/** The fr_id namespace (06 §6.3). */
export interface IdentFields {
  device_id: string;
  addr: number;
  net: number;
  alias: string;
  alias_rev: number;
  epoch_floor: number;
  board: string;
  profile: string;
  part_profile: string;
  /** Unix seconds. */
  prov_ts: number;
}

/** The fr_net namespace (06 §6.3); `pass` is absent for an open network. */
export interface IdentNet {
  ssid: string;
  pass?: string;
  bssid?: string | null;
  country?: string | null;
  hub_host: string;
  hub_ip?: string | null;
}

// A field is quoted when it holds a CSV metacharacter or edge space; the sidecar reads it with Python's csv.
function field(v: string): string {
  return /[",\r\n]|^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** One `key,data,<enc>,<value>` row; strings may hold any printable text, control characters are refused. */
function dataRow(key: string, encoding: 'u8' | 'u16' | 'u32' | 'string' | 'hex2bin', value: string | number, secret = false): string {
  const v = String(value);
  if (/[\x00-\x1f\x7f]/.test(v)) {
    // Named by key only: the value may be the password.
    throw new FrError('INVALID_ARGS', `fr_ident ${key} contains a control character`, {
      ...(secret || key === 'ssid' ? { remediation: [{ tool: 'network_set', cli: 'fr net set --ssid <ssid> --password-stdin' }] } : {}),
    });
  }
  return `${key},data,${encoding},${field(v)}`;
}

/** The fr_ident CSV of 06 §6.3 (esp-idf-nvs-partition-gen format). Holds the password: never log it. */
export function identCsv(id: IdentFields, net: IdentNet): string {
  const rows = [
    'key,type,encoding,value',
    'fr_id,namespace,,',
    dataRow('schema', 'u8', IDENT_SCHEMA),
    dataRow('mac', 'hex2bin', id.device_id),
    dataRow('addr', 'u16', id.addr),
    dataRow('net', 'u16', id.net),
    dataRow('alias', 'string', id.alias),
    dataRow('alias_rev', 'u32', id.alias_rev),
    dataRow('epoch_floor', 'u16', id.epoch_floor),
    dataRow('board', 'string', id.board),
    dataRow('profile', 'string', id.profile),
    dataRow('part_profile', 'string', id.part_profile),
    dataRow('prov_ts', 'u32', id.prov_ts),
    'fr_net,namespace,,',
    dataRow('ssid', 'string', net.ssid),
    ...(net.pass !== undefined ? [dataRow('pass', 'string', net.pass, true)] : []),
    ...(net.bssid ? [dataRow('bssid', 'hex2bin', net.bssid.replace(/[:-]/g, '').toLowerCase())] : []),
    ...(net.country ? [dataRow('country', 'string', net.country)] : []),
    dataRow('hub_host', 'string', net.hub_host),
    ...(net.hub_ip ? [dataRow('hub_ip', 'string', net.hub_ip)] : []),
  ];
  return rows.join('\n') + '\n';
}

/** The stored Wi-Fi password (secrets.json `wifi_password`), or undefined. Errors never quote the file. */
export function readWifiPassword(): string | undefined {
  const file = paths.secrets();
  if (!existsSync(file)) {
    return undefined;
  }
  let secrets: unknown;
  try {
    secrets = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    // V8's parse error quotes the input, which would put secret bytes in the job error.
    throw new FrError('ENV_MISSING', `${file} is not valid JSON`, {
      remediation: [{ human: `fix or delete ${file}, then set the network again`, cli: 'fr net set --ssid <ssid> --password-stdin' }],
    });
  }
  const pass = (secrets as { wifi_password?: unknown } | null)?.wifi_password;
  return typeof pass === 'string' ? pass : undefined;
}

/**
 * The Mac's LAN IPv4, the fallback nodes use when mDNS fails (06 §6.3 `hub_ip`): the first non-internal,
 * non-link-local IPv4 on an `en*` interface (Wi-Fi or Ethernet, not VPN tunnels or bridges), else null.
 */
export function hubIpv4(): string | null {
  const ifs = networkInterfaces();
  for (const name of Object.keys(ifs).sort()) {
    if (!/^en\d+$/.test(name)) {
      continue;
    }
    for (const a of ifs[name] ?? []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) {
        return a.address;
      }
    }
  }
  return null;
}

/** The network part of fr_ident from the active record; ENV_MISSING when there is none (06 §6.4 step 5). */
export function identNet(net: NetworkRecord | null): IdentNet {
  if (!net) {
    throw new FrError('ENV_MISSING', 'no Wi-Fi network is stored, so the node would not know where to connect', {
      hint: 'fr net set',
      remediation: [{ tool: 'network_set', cli: 'fr net set --ssid <ssid> --password-stdin' }],
    });
  }
  const pass = readWifiPassword();
  return { ssid: net.ssid, ...(pass !== undefined ? { pass } : {}), bssid: net.bssid, country: net.country, hub_host: net.hub_host, hub_ip: hubIpv4() };
}

export interface RenderedIdent {
  /** The NVS image, inside the temp dir. */
  path: string;
  size: number;
  /** Deletes the temp dir and the image in it; call when the job ends, whatever happened. */
  dispose(): void;
}

export type PytoolsRunner = (req: PytoolsRequest, ctx: JobCtx) => Promise<unknown>;

const IDENT_DIR_PREFIX = 'fr-ident-';

/** Where fr_ident is rendered: one 0700 dir per render inside it. */
export function identTmpRoot(): string {
  return join(paths.home(), 'tmp', 'ident');
}

/** The dirs of renders not yet disposed of; removed on any exit that still runs JS (process.exit, a crash). */
const liveDirs = new Set<string>();
let exitHooked = false;

function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

function trackDir(dir: string): void {
  liveDirs.add(dir);
  if (!exitHooked) {
    exitHooked = true;
    // 'exit' also runs after an uncaught exception and after the stop backstop's process.exit, while a
    // job's finally may never get its turn; SIGKILL and power loss are left to the sweep at start.
    process.on('exit', () => {
      for (const dir of liveDirs) {
        try {
          removeDir(dir);
        } catch {
          // the next start's sweep gets it
        }
      }
    });
  }
}

/**
 * Earlier hub versions rendered into the system temp dir, which hubs of other FR_HOMEs share: there only
 * this user's `fr-ident-*` dirs older than any flash job are removed, so a live render is never touched.
 */
export const LEGACY_IDENT_MIN_AGE_MS = 10 * 60_000;

/**
 * Removes fr_ident renders that a hub killed mid-flash left behind (they hold the Wi-Fi password): every
 * dir under identTmpRoot(), and stale `fr-ident-*` dirs in `legacyDir`. Only for the hub that holds
 * hub.lock, at start, before any job runs: the dirs it removes are then nobody's. Returns what it removed.
 */
export function sweepIdentDirs(opts: { legacyDir?: string } = {}): string[] {
  const removed: string[] = [];
  const root = identTmpRoot();
  if (existsSync(root)) {
    for (const name of readdirSync(root)) {
      removeDir(join(root, name));
      removed.push(join(root, name));
    }
  }
  const legacyDir = opts.legacyDir ?? tmpdir();
  const now = Date.now();
  let names: string[] = [];
  try {
    names = readdirSync(legacyDir).filter((n) => n.startsWith(IDENT_DIR_PREFIX));
  } catch {
    // no system temp dir to look at
  }
  for (const name of names) {
    const dir = join(legacyDir, name);
    try {
      const st = statSync(dir);
      if (st.isDirectory() && st.uid === process.getuid?.() && now - st.mtimeMs >= LEGACY_IDENT_MIN_AGE_MS) {
        removeDir(dir);
        removed.push(dir);
      }
    } catch {
      // gone meanwhile, or not ours to remove
    }
  }
  return removed;
}

/**
 * Renders fr_ident.bin (`size` bytes, the partition size) in a fresh 0700 dir under identTmpRoot(): the
 * CSV is written 0600, turned into the image by the sidecar's nvs_gen, and deleted at once. The dir is
 * removed on failure; on success the caller disposes of it once the flash is done.
 */
export async function renderIdent(id: IdentFields, net: IdentNet, size: number, ctx: JobCtx, pytools: PytoolsRunner = runPytools): Promise<RenderedIdent> {
  const csv = identCsv(id, net); // validates before anything touches the disk
  const root = identTmpRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const dir = mkdtempSync(join(root, IDENT_DIR_PREFIX));
  trackDir(dir);
  const dispose = () => {
    removeDir(dir);
    liveDirs.delete(dir);
  };
  try {
    chmodSync(dir, 0o700);
    const csvPath = join(dir, 'fr_ident.csv');
    const outPath = join(dir, 'fr_ident.bin');
    writeFileSync(csvPath, csv, { mode: 0o600 });
    const res = (await pytools({ cmd: 'nvs_gen', csv_path: csvPath, size, out_path: outPath }, ctx)) as { size?: unknown } | undefined;
    rmSync(csvPath, { force: true }); // only the image is needed for the flash
    if (!existsSync(outPath)) {
      throw new FrError('FLASH_FAILED', 'nvs_gen reported success but wrote no fr_ident image');
    }
    return { path: outPath, size: typeof res?.size === 'number' ? res.size : size, dispose };
  } catch (e) {
    dispose();
    throw e;
  }
}
