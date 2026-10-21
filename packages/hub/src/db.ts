import Database from 'better-sqlite3';

export type Db = Database.Database;

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
  `CREATE TABLE IF NOT EXISTS networks (
     id INTEGER PRIMARY KEY CHECK (id = 1), ssid TEXT NOT NULL, bssid TEXT, country TEXT, updated_at TEXT NOT NULL,
     net_id INTEGER CHECK (net_id BETWEEN 1 AND 65535), hub_host TEXT)`,
  `CREATE TABLE IF NOT EXISTS ports_seen (
     usb_serial TEXT PRIMARY KEY, last_path TEXT NOT NULL, vid TEXT, pid TEXT, last_seen TEXT NOT NULL)`,
  // The registry (spec 08 §8.8, design c3 §4): columns as context.ts Device, tags a JSON array, provision
  // the JSON provision record (never a secret). addr is NULL until provisioned and never reused; alias
  // and addr are unique.
  `CREATE TABLE IF NOT EXISTS devices (
     device_id TEXT PRIMARY KEY, addr INTEGER UNIQUE CHECK (addr BETWEEN 1 AND 61439),
     alias TEXT NOT NULL UNIQUE COLLATE NOCASE, alias_rev INTEGER NOT NULL DEFAULT 0,
     net INTEGER, board TEXT, profile TEXT, chip TEXT, tags TEXT NOT NULL DEFAULT '[]',
     role TEXT NOT NULL DEFAULT 'node' CHECK (role IN ('node', 'gateway')), fw_id TEXT,
     provisioned INTEGER NOT NULL DEFAULT 0, last_seen TEXT, last_epoch INTEGER, created_at TEXT NOT NULL,
     provision TEXT)`,
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
];

/** Columns added to tables that earlier hubs created (CREATE TABLE IF NOT EXISTS leaves those as they were). */
const ADDED_COLUMNS: { table: string; column: string; decl: string }[] = [
  // C3: the network id nodes are provisioned with and the hub's mDNS name (network.ts fills both).
  { table: 'networks', column: 'net_id', decl: 'INTEGER CHECK (net_id BETWEEN 1 AND 65535)' },
  { table: 'networks', column: 'hub_host', decl: 'TEXT' },
  // C4: a fault build's kind (spec 03 §3.8; NULL for every other build): implicit picks skip those rows.
  { table: 'artifacts', column: 'fault', decl: 'TEXT' },
];

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
