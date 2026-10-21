// The device registry (design c3 §4, stream H1): `devices` rows (store.ts), selectors (selector.ts,
// 09 §9.2), alias and tag rules (names.ts), fr_ident rendering (ident.ts), provisioning (provision.ts)
// and the flash_start job with its fr_ident plans (flashing.ts).

import { paths } from '@fractonica/host';

import type { Registry } from '../context.ts';
import type { Db } from '../db.ts';
import { readLockPid } from '../lock.ts';
import { sweepIdentDirs } from './ident.ts';
import { SqliteRegistry } from './store.ts';

export { SqliteRegistry } from './store.ts';

/**
 * Removes the fr_ident renders a killed hub left behind (they hold the Wi-Fi password). main.ts calls it
 * as soon as it holds hub.lock, before any job runs; in a process that does not hold hub.lock (a test, a
 * CLI) it removes nothing, so the running hub's renders are left alone. Returns what it removed.
 */
export function sweepIdentAtStart(): string[] {
  return readLockPid(paths.lock()) === process.pid ? sweepIdentDirs() : [];
}

/** The hub's registry over hub.db. */
export function createRegistry(db: Db): Registry {
  return new SqliteRegistry(db);
}
