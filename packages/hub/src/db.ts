import Database from 'better-sqlite3';

export type Db = Database.Database;

/**
 * The registry table (spec 08 §8.8, design c3 §4): columns as context.ts Device, tags a JSON array, provision
 * the JSON provision record (never a secret). addr is NULL until provisioned and never reused; alias and addr
 * are unique. `role` takes protocol DEVICE_ROLES; `fixture` came with M2-C1 (design m2-c1-hil D6), and an
 * older database's CHECK is widened by rebuilding the table (migrateRoleCheck).
 */
function devicesTable(name: string): string {
  return `CREATE TABLE IF NOT EXISTS ${name} (
     device_id TEXT PRIMARY KEY, addr INTEGER UNIQUE CHECK (addr BETWEEN 1 AND 61439),
     alias TEXT NOT NULL UNIQUE COLLATE NOCASE, alias_rev INTEGER NOT NULL DEFAULT 0,
     net INTEGER, board TEXT, profile TEXT, chip TEXT, tags TEXT NOT NULL DEFAULT '[]',
     role TEXT NOT NULL DEFAULT 'node' CHECK (role IN ('node', 'gateway', 'fixture')), fw_id TEXT,
     provisioned INTEGER NOT NULL DEFAULT 0, last_seen TEXT, last_epoch INTEGER, created_at TEXT NOT NULL,
     provision TEXT, network TEXT NOT NULL DEFAULT 'default')`;
}

/**
 * The networks table (design csi-c1 D4): one row per named network (`default` is the one of hubs before csi-c1), each
 * with its band; net_id is the fleet's, the same in every row (network.ts). `id` stays the rowid, as before csi-c1.
 */
function networksTable(name: string): string {
  return `CREATE TABLE IF NOT EXISTS ${name} (
     id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE DEFAULT 'default', ssid TEXT NOT NULL, bssid TEXT, country TEXT,
     band TEXT NOT NULL DEFAULT 'auto' CHECK (band IN ('auto', '2g', '5g')), updated_at TEXT NOT NULL,
     net_id INTEGER CHECK (net_id BETWEEN 1 AND 65535), hub_host TEXT)`;
}

/**
 * PRAGMA user_version: the schema changes ADD COLUMN cannot make, done once each. 0 is every database before
 * M2-C1; 1 has the `fixture` role (migrateRoleCheck); 2 has named networks (migrateNetworks, design csi-c1 D4).
 */
export const DB_SCHEMA_VERSION = 2;

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS logs (
     seq INTEGER PRIMARY KEY, run INTEGER NOT NULL, ts_us INTEGER NOT NULL, device TEXT NOT NULL,
     port TEXT NOT NULL, level TEXT, tag TEXT, kind TEXT NOT NULL, text TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS logs_device ON logs(device, seq)`,
  `CREATE TABLE IF NOT EXISTS jobs (
     job_id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, json TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS job_logs (
     job_id TEXT NOT NULL, line INTEGER NOT NULL, ts TEXT NOT NULL, stream TEXT NOT NULL, text TEXT NOT NULL,
     PRIMARY KEY (job_id, line))`,
  `CREATE TABLE IF NOT EXISTS artifacts (
     build_id TEXT PRIMARY KEY, source_dir TEXT NOT NULL, profile TEXT NOT NULL, build_type TEXT NOT NULL,
     fw_id TEXT NOT NULL, built_at TEXT NOT NULL, manifest_path TEXT NOT NULL)`,
  networksTable('networks'),
  `CREATE TABLE IF NOT EXISTS ports_seen (
     usb_serial TEXT PRIMARY KEY, last_path TEXT NOT NULL, vid TEXT, pid TEXT, last_seen TEXT NOT NULL)`,
  // The registry (devicesTable).
  devicesTable('devices'),
  // Hub events (spec 08 §8.7): a ring in the cursor space it shares with logs (seq.ts, ring.ts).
  `CREATE TABLE IF NOT EXISTS events (
     seq INTEGER PRIMARY KEY, run INTEGER NOT NULL, ts_us INTEGER NOT NULL, t_hub_us INTEGER NOT NULL,
     type TEXT NOT NULL, device TEXT, json TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS events_device ON events(device, seq)`,
  `CREATE INDEX IF NOT EXISTS events_type ON events(type, seq)`,
  // OTA child jobs (design c4 §4, ota/orchestrator.ts): one row per device and ota_deploy, `json` the
  // OtaRecord (state, attempt, bytes, timings) that ota_status answers; the parent is an ordinary job.
  `CREATE TABLE IF NOT EXISTS ota_jobs (
     job_id TEXT PRIMARY KEY, parent TEXT NOT NULL, device TEXT NOT NULL, state TEXT NOT NULL,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL, json TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS ota_jobs_device ON ota_jobs(device, created_at)`,
  `CREATE INDEX IF NOT EXISTS ota_jobs_parent ON ota_jobs(parent)`,
  // Bindings (design c5 §4, bindings/): one row per source device and slot, as context.ts BindingRow.
  // from_spec/to_spec are binding_set's from/to as given (FROM and TO are SQL keywords); target_id the
  // target device (NULL: broadcast), so a change at the target end finds the rows to re-resolve; args the
  // JSON, binding the hex of the encoded Binding pushed with fr.node.bind_set; pushed_at NULL while a push
  // is due.
  `CREATE TABLE IF NOT EXISTS bindings (
     device_id TEXT NOT NULL, slot INTEGER NOT NULL CHECK (slot BETWEEN 0 AND 15),
     from_spec TEXT NOT NULL, to_spec TEXT NOT NULL, target_id TEXT, args TEXT, binding TEXT NOT NULL,
     pushed_at TEXT, PRIMARY KEY (device_id, slot))`,
  `CREATE INDEX IF NOT EXISTS bindings_target ON bindings(target_id)`,
];

/** Columns added to tables that earlier hubs created (CREATE TABLE IF NOT EXISTS leaves those as they were). */
const ADDED_COLUMNS: { table: string; column: string; decl: string }[] = [
  // C3: the network id nodes are provisioned with and the hub's mDNS name (network.ts fills both).
  { table: 'networks', column: 'net_id', decl: 'INTEGER CHECK (net_id BETWEEN 1 AND 65535)' },
  { table: 'networks', column: 'hub_host', decl: 'TEXT' },
  // C4: a fault build's kind (spec 03 §3.8; NULL for every other build): implicit picks skip those rows.
  { table: 'artifacts', column: 'fault', decl: 'TEXT' },
  // C6: who started a job (design c6 D18: the X-Fr-Client header, cli|mcp|dashboard|app; NULL without
  // one), so job_list filters in SQL. The json keeps it too.
  { table: 'jobs', column: 'origin', decl: 'TEXT' },
  // CSI-1 (design csi-c1 D5): the network a device's fr_ident names.
  { table: 'devices', column: 'network', decl: "TEXT NOT NULL DEFAULT 'default'" },
];

/**
 * Version 1 (design m2-c1-hil D6): the devices CHECK gains `fixture`. SQLite cannot alter a CHECK, so a table
 * created before it is rebuilt (create the new table, copy every row, drop the old one, rename) in one
 * transaction; rows, the unique alias and addr, and their values are kept. A database whose table already
 * has the new CHECK (a fresh one) is only stamped.
 */
function migrateRoleCheck(db: Db): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'devices'").get() as { sql: string } | undefined;
  if (!row || row.sql.includes("'fixture'")) {
    return;
  }
  const old = (db.prepare('PRAGMA table_info(devices)').all() as { name: string }[]).map((c) => c.name);
  db.exec(devicesTable('devices_v1'));
  const fresh = new Set((db.prepare('PRAGMA table_info(devices_v1)').all() as { name: string }[]).map((c) => c.name));
  const cols = old.filter((c) => fresh.has(c)).join(', ');
  db.exec(`INSERT INTO devices_v1 (${cols}) SELECT ${cols} FROM devices`);
  db.exec('DROP TABLE devices');
  db.exec('ALTER TABLE devices_v1 RENAME TO devices');
}

/**
 * Version 2 (design csi-c1 D4): the single-row networks table (`CHECK (id = 1)`) becomes one row per named network.
 * Its row becomes `default` (band auto), keeping id, ssid, bssid, country, updated_at, net_id and hub_host.
 */
function migrateNetworks(db: Db): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'networks'").get() as { sql: string } | undefined;
  if (!row || !/CHECK\s*\(\s*id\s*=\s*1\s*\)/i.test(row.sql)) {
    return;
  }
  const old = new Set((db.prepare('PRAGMA table_info(networks)').all() as { name: string }[]).map((c) => c.name));
  const cols = ['id', 'ssid', 'bssid', 'country', 'updated_at', 'net_id', 'hub_host'].filter((c) => old.has(c)).join(', ');
  db.exec(networksTable('networks_v2'));
  db.exec(`INSERT INTO networks_v2 (name, band, ${cols}) SELECT 'default', 'auto', ${cols} FROM networks`);
  db.exec('DROP TABLE networks');
  db.exec('ALTER TABLE networks_v2 RENAME TO networks');
}

/** The user_version steps, in order: step i takes a database from version i to i + 1. */
const VERSION_STEPS: ((db: Db) => void)[] = [migrateRoleCheck, migrateNetworks];

export function openDb(file: string): Db {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  for (const sql of MIGRATIONS) {
    db.exec(sql);
  }
  for (const { table, column, decl } of ADDED_COLUMNS) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!columns.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
    }
  }
  const version = db.pragma('user_version', { simple: true }) as number;
  for (let v = version; v < DB_SCHEMA_VERSION; v++) {
    db.transaction(() => {
      VERSION_STEPS[v](db);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
  return db;
}

export function kvGet(db: Db, k: string): string | undefined {
  const row = db.prepare('SELECT v FROM kv WHERE k = ?').get(k) as { v: string } | undefined;
  return row?.v;
}

export function kvSet(db: Db, k: string, v: string): void {
  db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v);
}

/** Writes a kv value and syncs it to the disk before returning: FULL syncs the WAL on commit, and
 * fullfsync makes that F_FULLFSYNC on macOS. */
function kvSetDurable(db: Db, k: string, v: string): void {
  db.pragma('synchronous = FULL');
  db.pragma('fullfsync = ON');
  try {
    kvSet(db, k, v);
  } finally {
    db.pragma('fullfsync = OFF');
    db.pragma('synchronous = NORMAL');
  }
}

/**
 * Increments and returns the hub run counter (part of every cursor). The bump is fsynced (spec 08
 * §8.7): with WAL + synchronous=NORMAL a power loss could roll it back and let a reused run number
 * silently re-base old cursors.
 */
export function nextHubRun(db: Db): number {
  const run = Number(kvGet(db, 'hub_run') ?? '0') + 1;
  kvSetDurable(db, 'hub_run', String(run));
  return run;
}

/**
 * Increments and returns the hub epoch, the `epoch` of every hub frame (05 §5.8): a u16 that skips 0
 * when it wraps, so 0 can mean "no hub yet" on a node. Fsynced like the run counter: a rolled-back
 * epoch would let a node's window take this run's frames for replays of the last run's.
 */
export function nextHubEpoch(db: Db): number {
  const prev = Number(kvGet(db, 'hub_epoch') ?? '0');
  const epoch = Number.isInteger(prev) && prev >= 0 && prev < 0xffff ? prev + 1 : 1;
  kvSetDurable(db, 'hub_epoch', String(epoch));
  return epoch;
}
