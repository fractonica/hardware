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
     id INTEGER PRIMARY KEY CHECK (id = 1), ssid TEXT NOT NULL, bssid TEXT, country TEXT, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ports_seen (
     usb_serial TEXT PRIMARY KEY, last_path TEXT NOT NULL, vid TEXT, pid TEXT, last_seen TEXT NOT NULL)`,
];

export function openDb(file: string): Db {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  for (const sql of MIGRATIONS) {
    db.exec(sql);
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

/** Increments and returns the hub run counter (part of every cursor). */
export function nextHubRun(db: Db): number {
  const run = Number(kvGet(db, 'hub_run') ?? '0') + 1;
  kvSet(db, 'hub_run', String(run));
  return run;
}
