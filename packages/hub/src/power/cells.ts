// The cell registry (design power-p1 D9) over the hub's db (tables `cells`, `cell_installs`, `cell_samples`,
// `cell_sessions`, db.ts): the rows, where a cell is installed, its sessions and curves, and what is learned from them
// (cycles, capacity, health, internal resistance, the estimates for a place). The tracker (tracker.ts) and the capacity
// test (test.ts) write sessions through here; the ops (ops.ts) read.

import { FrError, type Cell, type CellLearned, type CellPlace, type CellSession, type CellSessionKind, type ChargerMode, type Chemistry, type Curve } from '@fractonica/protocol';

import type { Db } from '../db.ts';
import { downsample, healthPct, median, percentFromTest, remainingOnCurve } from './learn.ts';

export interface CellRow {
  id: number;
  name: string;
  chemistry: Chemistry;
  nominal_mah: number | null;
  notes: string | null;
  created_at: string;
}

export interface InstallRow {
  id: number;
  cell: number;
  device: string;
  instance: string;
  since: string;
  until: string | null;
}

export interface SessionRow {
  id: number;
  cell: number;
  kind: CellSessionKind;
  device: string;
  instance: string;
  started: string;
  ended: string | null;
  start_mv: number | null;
  end_mv: number | null;
  duration_s: number | null;
  complete: number;
  mah: number | null;
  wh: number | null;
  r_int_mohm: number | null;
  curve: string | null;
  json: string | null;
}

const nowIso = () => new Date().toISOString();

export function cellByName(db: Db, name: string): CellRow | null {
  return (db.prepare('SELECT * FROM cells WHERE name = ?').get(name) as CellRow | undefined) ?? null;
}

export function cellById(db: Db, id: number): CellRow | null {
  return (db.prepare('SELECT * FROM cells WHERE id = ?').get(id) as CellRow | undefined) ?? null;
}

/** The cell named `name`, or NOT_FOUND with the list to pick from. */
export function requireCell(db: Db, name: string): CellRow {
  const c = cellByName(db, name);
  if (!c) {
    const names = (db.prepare('SELECT name FROM cells ORDER BY name').all() as { name: string }[]).map((r) => r.name);
    throw new FrError('NOT_FOUND', `no cell ${name} (cells: ${names.join(', ') || 'none yet'})`, {
      remediation: [{ tool: 'cell_add', args: { name, chemistry: 'liion' }, cli: `fr cell add ${name} --chemistry liion` }],
    });
  }
  return c;
}

export function addCell(db: Db, c: { name: string; chemistry: Chemistry; nominal_mah?: number; notes?: string }): CellRow {
  if (cellByName(db, c.name)) {
    throw new FrError('INVALID_ARGS', `a cell named ${c.name} exists already (names are unique, whatever their case)`);
  }
  const r = db.prepare('INSERT INTO cells (name, chemistry, nominal_mah, notes, created_at) VALUES (?, ?, ?, ?, ?)').run(c.name, c.chemistry, c.nominal_mah ?? null, c.notes ?? null, nowIso());
  return cellById(db, Number(r.lastInsertRowid))!;
}

export function updateCell(db: Db, cell: CellRow, p: { rename?: string; chemistry?: Chemistry; nominal_mah?: number; notes?: string }): CellRow {
  if (p.rename !== undefined && p.rename.toLowerCase() !== cell.name.toLowerCase() && cellByName(db, p.rename)) {
    throw new FrError('INVALID_ARGS', `a cell named ${p.rename} exists already`);
  }
  db.prepare('UPDATE cells SET name = ?, chemistry = ?, nominal_mah = ?, notes = ? WHERE id = ?').run(
    p.rename ?? cell.name,
    p.chemistry ?? cell.chemistry,
    p.nominal_mah ?? cell.nominal_mah,
    p.notes === undefined ? cell.notes : p.notes === '' ? null : p.notes,
    cell.id,
  );
  return cellById(db, cell.id)!;
}

export function listCells(db: Db): CellRow[] {
  return db.prepare('SELECT * FROM cells ORDER BY name').all() as CellRow[];
}

// ---- installs ----

/** Where the cell is installed now, or null. */
export function installOf(db: Db, cellId: number): InstallRow | null {
  return (db.prepare('SELECT * FROM cell_installs WHERE cell = ? AND until IS NULL ORDER BY id DESC LIMIT 1').get(cellId) as InstallRow | undefined) ?? null;
}

/** The cell installed in a device's instance now, or null. */
export function installAt(db: Db, device: string, instance: string): InstallRow | null {
  return (db.prepare('SELECT * FROM cell_installs WHERE device = ? AND instance = ? AND until IS NULL ORDER BY id DESC LIMIT 1').get(device, instance) as InstallRow | undefined) ?? null;
}

/** Every open install (the tracker's places). */
export function openInstalls(db: Db): InstallRow[] {
  return db.prepare('SELECT * FROM cell_installs WHERE until IS NULL ORDER BY id').all() as InstallRow[];
}

/**
 * Installs `cell` in (device, instance): the cell's previous place and the place's previous cell are closed (one cell per
 * place, one place per cell). Answers the cell it replaced there, if any.
 */
export function install(db: Db, cellId: number, device: string, instance: string): { row: InstallRow; replaced: number | null } {
  const at = nowIso();
  return db.transaction(() => {
    const here = installAt(db, device, instance);
    if (here && here.cell === cellId) {
      return { row: here, replaced: null };
    }
    db.prepare('UPDATE cell_installs SET until = ? WHERE until IS NULL AND (cell = ? OR (device = ? AND instance = ?))').run(at, cellId, device, instance);
    const r = db.prepare('INSERT INTO cell_installs (cell, device, instance, since) VALUES (?, ?, ?, ?)').run(cellId, device, instance, at);
    return { row: db.prepare('SELECT * FROM cell_installs WHERE id = ?').get(Number(r.lastInsertRowid)) as InstallRow, replaced: here ? here.cell : null };
  })();
}

/** Ends the cell's install; answers where it was. */
export function uninstall(db: Db, cellId: number): InstallRow | null {
  const was = installOf(db, cellId);
  if (was) {
    db.prepare('UPDATE cell_installs SET until = ? WHERE id = ?').run(nowIso(), was.id);
  }
  return was;
}

// ---- samples and sessions ----

export function addSample(db: Db, cellId: number, s: { ts_ms: number; mv: number; charger: ChargerMode | null; load: boolean }): void {
  db.prepare('INSERT INTO cell_samples (cell, ts_ms, mv, charger, load) VALUES (?, ?, ?, ?, ?)').run(cellId, s.ts_ms, s.mv, s.charger, s.load ? 1 : 0);
}

/** The cell's samples between two times (ms), as a `[t_s, mv]` curve from `fromMs`. */
export function samplesCurve(db: Db, cellId: number, fromMs: number, toMs: number): Curve {
  const rows = db.prepare('SELECT ts_ms, mv FROM cell_samples WHERE cell = ? AND ts_ms >= ? AND ts_ms <= ? ORDER BY ts_ms').all(cellId, fromMs, toMs) as { ts_ms: number; mv: number }[];
  return rows.map((r) => [Math.round((r.ts_ms - fromMs) / 100) / 10, r.mv]);
}

export function openSessionRow(db: Db, s: { cell: number; kind: CellSessionKind; device: string; instance: string; started: string; start_mv: number | null; json?: unknown }): number {
  const r = db
    .prepare('INSERT INTO cell_sessions (cell, kind, device, instance, started, start_mv, json) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(s.cell, s.kind, s.device, s.instance, s.started, s.start_mv, s.json === undefined ? null : JSON.stringify(s.json));
  return Number(r.lastInsertRowid);
}

export function closeSessionRow(
  db: Db,
  id: number,
  s: { ended: string; end_mv: number | null; duration_s: number; complete: boolean; curve: Curve; mah?: number | null; wh?: number | null; r_int_mohm?: number | null; json?: unknown },
): void {
  db.prepare('UPDATE cell_sessions SET ended = ?, end_mv = ?, duration_s = ?, complete = ?, curve = ?, mah = ?, wh = ?, r_int_mohm = ?, json = COALESCE(?, json) WHERE id = ?').run(
    s.ended,
    s.end_mv,
    s.duration_s,
    s.complete ? 1 : 0,
    JSON.stringify(downsample(s.curve)),
    s.mah ?? null,
    s.wh ?? null,
    s.r_int_mohm ?? null,
    s.json === undefined ? null : JSON.stringify(s.json),
    id,
  );
}

/**
 * A running session's progress (a capacity test writes it at every renewal), so a hub that stops keeps what came: the
 * curve so far, its last voltage and figures. It stays open (ended NULL) until closeSessionRow.
 */
export function updateSessionProgress(db: Db, id: number, s: { end_mv: number | null; duration_s: number; curve: Curve; mah?: number | null; wh?: number | null; r_int_mohm?: number | null }): void {
  db.prepare('UPDATE cell_sessions SET end_mv = ?, duration_s = ?, curve = ?, mah = ?, wh = ?, r_int_mohm = ? WHERE id = ? AND ended IS NULL').run(
    s.end_mv,
    s.duration_s,
    JSON.stringify(downsample(s.curve)),
    s.mah ?? null,
    s.wh ?? null,
    s.r_int_mohm ?? null,
    id,
  );
}

/** How long cell_samples rows are kept (design D9 thinning keeps a row per 10 s; older rows outside an open session go). */
export const SAMPLES_KEEP_MS = 30 * 24 * 3_600_000;

/**
 * Forgets samples older than `beforeMs`, except those inside a session still open on their cell (its curve is read from
 * them when it closes). Answers the rows removed.
 */
export function pruneSamples(db: Db, beforeMs: number): number {
  const r = db
    .prepare(
      `DELETE FROM cell_samples WHERE ts_ms < ? AND NOT EXISTS (
         SELECT 1 FROM cell_sessions s WHERE s.cell = cell_samples.cell AND s.ended IS NULL
           AND cell_samples.ts_ms >= CAST((julianday(s.started) - 2440587.5) * 86400000 AS INTEGER))`,
    )
    .run(beforeMs);
  return r.changes;
}

export function sessionRow(db: Db, id: number): SessionRow | null {
  return (db.prepare('SELECT * FROM cell_sessions WHERE id = ?').get(id) as SessionRow | undefined) ?? null;
}

/** Sessions left open by a hub that stopped (ended NULL). */
export function orphanSessions(db: Db): SessionRow[] {
  return db.prepare('SELECT * FROM cell_sessions WHERE ended IS NULL ORDER BY id').all() as SessionRow[];
}

export function sessionsOf(db: Db, cellId: number, limit = 20): SessionRow[] {
  return db.prepare('SELECT * FROM cell_sessions WHERE cell = ? ORDER BY id DESC LIMIT ?').all(cellId, limit) as SessionRow[];
}

/** The newest complete session of a kind (a discharge: on `device` when given), or null. */
export function latestComplete(db: Db, cellId: number, kind: CellSessionKind, device?: string): SessionRow | null {
  const row =
    device === undefined
      ? db.prepare('SELECT * FROM cell_sessions WHERE cell = ? AND kind = ? AND complete = 1 ORDER BY id DESC LIMIT 1').get(cellId, kind)
      : db.prepare('SELECT * FROM cell_sessions WHERE cell = ? AND kind = ? AND complete = 1 AND device = ? ORDER BY id DESC LIMIT 1').get(cellId, kind, device);
  return (row as SessionRow | undefined) ?? null;
}

export function curveOf(row: SessionRow | null): Curve | null {
  if (!row?.curve) {
    return null;
  }
  try {
    const c = JSON.parse(row.curve) as unknown;
    return Array.isArray(c) ? (c as Curve) : null;
  } catch {
    return null;
  }
}

export function jsonOf(row: SessionRow | null): Record<string, unknown> {
  try {
    const v = row?.json ? (JSON.parse(row.json) as unknown) : null;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** A test session's load resistance (its json), or null (a test via a haptic). */
export function testLoadOhm(row: SessionRow | null): number | null {
  const v = jsonOf(row).load_ohm;
  return typeof v === 'number' && v > 0 ? v : null;
}

// ---- what is learned ----

export function learned(db: Db, cell: CellRow): CellLearned {
  const cycles = (db.prepare("SELECT COUNT(*) AS n FROM cell_sessions WHERE cell = ? AND kind = 'charge' AND complete = 1").get(cell.id) as { n: number }).n;
  const tests = db.prepare("SELECT * FROM cell_sessions WHERE cell = ? AND kind = 'test' AND complete = 1 AND mah IS NOT NULL ORDER BY id").all(cell.id) as SessionRow[];
  const lastTest = (db.prepare("SELECT * FROM cell_sessions WHERE cell = ? AND kind = 'test' AND ended IS NOT NULL ORDER BY id DESC LIMIT 1").get(cell.id) as SessionRow | undefined) ?? null;
  const latest = tests.length ? tests[tests.length - 1].mah : null;
  const first = tests.length ? tests[0].mah : null;
  const charge = latestComplete(db, cell.id, 'charge');
  const discharge = latestComplete(db, cell.id, 'discharge');
  const r = (x: number | null) => (x === null ? null : Math.round(x * 10) / 10);
  return {
    cycles,
    capacity_mah: r(latest),
    first_capacity_mah: r(first),
    health_pct: healthPct(latest, first, tests.length, cell.nominal_mah),
    r_int_mohm: tests.length ? tests[tests.length - 1].r_int_mohm : (lastTest?.r_int_mohm ?? null),
    last_charge_s: charge?.duration_s ?? null,
    last_discharge_s: discharge?.duration_s ?? null,
    tested_at: lastTest?.ended ?? null,
  };
}

export interface PlaceLookup {
  alias(device: string): string;
}

export function placeOf(db: Db, cellId: number, look: PlaceLookup): CellPlace | null {
  const i = installOf(db, cellId);
  return i ? { device: i.device, alias: look.alias(i.device), instance: i.instance, since: i.since } : null;
}

export function cellView(db: Db, cell: CellRow, look: PlaceLookup): Cell {
  return {
    name: cell.name,
    chemistry: cell.chemistry,
    nominal_mah: cell.nominal_mah,
    notes: cell.notes,
    created_at: cell.created_at,
    installed: placeOf(db, cell.id, look),
    learned: learned(db, cell),
  };
}

export function sessionView(row: SessionRow, look: PlaceLookup): CellSession {
  return {
    id: row.id,
    kind: row.kind,
    device: row.device,
    alias: look.alias(row.device),
    instance: row.instance,
    started: row.started,
    ended: row.ended,
    start_mv: row.start_mv,
    end_mv: row.end_mv,
    duration_s: row.duration_s === null ? null : Math.round(row.duration_s * 10) / 10,
    complete: row.complete === 1,
    mah: row.mah === null ? null : Math.round(row.mah * 10) / 10,
    wh: row.wh === null ? null : Math.round(row.wh * 1000) / 1000,
    r_int_mohm: row.r_int_mohm,
    points: curveOf(row)?.length ?? 0,
  };
}

/** The latest test (complete, with a curve), the one percent_learned reads. */
export function latestTest(db: Db, cellId: number): SessionRow | null {
  return (db.prepare("SELECT * FROM cell_sessions WHERE cell = ? AND kind = 'test' AND complete = 1 AND curve IS NOT NULL ORDER BY id DESC LIMIT 1").get(cellId) as SessionRow | undefined) ?? null;
}

/**
 * The estimates for a cell at (device, mv, charger) (design D9): percent from its latest complete test; while charging,
 * the time to full on its latest complete charge curve (else the median length of complete charges that began within
 * 100 mV of the voltage now); otherwise the time to low on its latest complete discharge on this device.
 */
export function estimate(db: Db, cellId: number, device: string, mv: number | null, charger: ChargerMode | null): { percent_learned: number | null; time_to_full_s: number | null; time_to_low_s: number | null } {
  if (mv === null) {
    return { percent_learned: null, time_to_full_s: null, time_to_low_s: null };
  }
  const test = latestTest(db, cellId);
  const testCurve = curveOf(test);
  const percent = testCurve ? percentFromTest(testCurve, mv, testLoadOhm(test)) : null;
  let toFull: number | null = null;
  let toLow: number | null = null;
  if (charger === 'charging') {
    const c = curveOf(latestComplete(db, cellId, 'charge'));
    toFull = c ? remainingOnCurve(c, mv, 'rising') : null;
    if (toFull === null) {
      const near = db
        .prepare("SELECT duration_s FROM cell_sessions WHERE cell = ? AND kind = 'charge' AND complete = 1 AND start_mv BETWEEN ? AND ? AND duration_s IS NOT NULL")
        .all(cellId, mv - 100, mv + 100) as { duration_s: number }[];
      toFull = median(near.map((r) => r.duration_s));
    }
  } else if (charger !== 'charged') {
    const c = curveOf(latestComplete(db, cellId, 'discharge', device));
    toLow = c ? remainingOnCurve(c, mv, 'falling') : null;
  } else {
    toFull = 0;
  }
  const r = (x: number | null) => (x === null ? null : Math.round(x));
  return { percent_learned: percent, time_to_full_s: r(toFull), time_to_low_s: r(toLow) };
}
