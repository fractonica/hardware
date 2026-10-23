// External holders of serial ports (design c6 D5; stream S5): who else has a USB port open, from one
// `lsof -F pcn` (3 s timeout) over each port's /dev/cu.* and /dev/tty.* names, without the hub itself and
// the processes it started (the pytools sidecar and esptool during a flash). Every serial lease asks
// (SerialPortManager.lease), so do the pre-job checks of provisioning, flashing and resets, a pytools
// "port busy" error, and port_list (cached 2 s). lsof scans every process (0.1-1 s), so nothing on the
// input path calls it. A probe that fails or times out knows of no holder: detection never blocks the hub.

import { run } from '@fractonica/host';
import { FrError, type PortHolder, type PortInfo, type PortLease } from '@fractonica/protocol';

import type { HubContext, HubRunOptions, PortHolders } from '../context.ts';

const LSOF_TIMEOUT_MS = 3000;
const PS_TIMEOUT_MS = 2000;
/** port_list asks lsof at most this often (design c6 D5). */
export const LIST_CACHE_MS = 2000;

/** `/dev/cu.X` and `/dev/tty.X` are one USB port: a Web Serial page or a terminal may hold either. */
function names(path: string): string[] {
  const m = /^\/dev\/(?:cu|tty)\.(.+)$/.exec(path);
  return m ? [`/dev/cu.${m[1]}`, `/dev/tty.${m[1]}`] : [path];
}

/**
 * The holders of each asked path in `lsof -F pcn` output: per process a `p<pid>` and a `c<command>` line,
 * then an `f<fd>` and an `n<name>` line per open file. A file is matched to the asked path it is a name of
 * (cu or tty); a process listed without names holds the one path asked, when only one was. Each pid
 * appears once per path.
 */
export function parseLsof(out: string, paths: string[]): Map<string, PortHolder[]> {
  const byName = new Map<string, string>();
  for (const p of paths) {
    for (const n of names(p)) {
      byName.set(n, p);
    }
  }
  const found = new Map<string, PortHolder[]>();
  const add = (path: string, h: PortHolder) => {
    const list = found.get(path) ?? [];
    if (!list.some((x) => x.pid === h.pid)) {
      list.push(h);
    }
    found.set(path, list);
  };
  let cur: { pid: number; app: string; files: number } | null = null;
  const end = () => {
    if (cur && cur.files === 0 && paths.length === 1) {
      add(paths[0], { app: cur.app, pid: cur.pid });
    }
  };
  for (const line of out.split('\n')) {
    const tag = line[0];
    const value = line.slice(1).trim();
    if (tag === 'p') {
      end();
      const pid = Number(value);
      cur = Number.isInteger(pid) && pid > 0 ? { pid, app: '', files: 0 } : null;
    } else if (tag === 'c' && cur) {
      cur.app = value;
    } else if (tag === 'n' && cur) {
      cur.files++;
      const path = byName.get(value);
      if (path) {
        add(path, { app: cur.app, pid: cur.pid });
      }
    }
  }
  end();
  return found;
}

/** The pids that descend from `root` (its children, theirs, ...) in `ps -A -o pid=,ppid=` output. */
export function descendants(psOut: string, root: number): Set<number> {
  const children = new Map<number, number[]>();
  for (const line of psOut.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (Number.isInteger(pid) && Number.isInteger(ppid)) {
      children.set(ppid, [...(children.get(ppid) ?? []), pid]);
    }
  }
  const out = new Set<number>();
  const todo = [...(children.get(root) ?? [])];
  while (todo.length) {
    const pid = todo.pop()!;
    if (!out.has(pid)) {
      out.add(pid);
      todo.push(...(children.get(pid) ?? []));
    }
  }
  return out;
}

export interface LsofOptions {
  /** `lsof -F pcn -- <names…>` stdout (lsof exits 1 when a name is not open, so its code means nothing). */
  lsof?: (names: string[]) => Promise<string>;
  /** `ps -A -o pid=,ppid=` stdout, asked only when someone other than the hub holds a port. */
  ps?: () => Promise<string>;
  /** The hub's pid (default this process). */
  pid?: number;
}

/** The default PortHolders: lsof, minus the hub's own pid and its descendants. */
export class LsofHolders implements PortHolders {
  #lsof: (names: string[]) => Promise<string>;
  #ps: () => Promise<string>;
  #pid: number;

  constructor(opts: LsofOptions = {}) {
    this.#lsof = opts.lsof ?? (async (n) => (await run('lsof', ['-F', 'pcn', '--', ...n], { timeout: LSOF_TIMEOUT_MS })).stdout);
    this.#ps = opts.ps ?? (async () => (await run('ps', ['-A', '-o', 'pid=,ppid='], { timeout: PS_TIMEOUT_MS })).stdout);
    this.#pid = opts.pid ?? process.pid;
  }

  async holders(paths: string[]): Promise<Map<string, PortHolder[]>> {
    if (!paths.length) {
      return new Map();
    }
    let found: Map<string, PortHolder[]>;
    try {
      found = parseLsof(await this.#lsof([...new Set(paths.flatMap(names))]), paths);
    } catch {
      return new Map();
    }
    for (const [path, list] of found) {
      found.set(path, list.filter((h) => h.pid !== this.#pid));
    }
    if ([...found.values()].some((l) => l.length)) {
      // The hub's children hold a port during a job (the sidecar's esptool): theirs, not someone else's.
      let ours = new Set<number>();
      try {
        ours = descendants(await this.#ps(), this.#pid);
      } catch {
        // no ps: keep them; a job's own esptool is never asked about while it runs (the job holds the port lock)
      }
      for (const [path, list] of found) {
        found.set(path, list.filter((h) => !ours.has(h.pid)));
      }
    }
    for (const [path, list] of found) {
      if (!list.length) {
        found.delete(path);
      }
    }
    return found;
  }
}

export function createPortHolders(_hub: () => HubContext, _run: HubRunOptions): PortHolders {
  return new LsofHolders();
}

/** "Google Chrome (pid 715)", several joined by commas. */
export function holderText(holders: PortHolder[]): string {
  return holders.map((h) => `${h.app || 'unknown program'} (pid ${h.pid})`).join(', ');
}

const BROWSER = /chrom|edge|brave|opera|arc|vivaldi/i;

/**
 * PORT_BUSY_EXTERNAL naming who holds the port (09 §9.3, 06 §6.4 step 2): "/dev/cu.usbmodem2101 (pad-c3b) is
 * held by Google Chrome (pid 715)", with what a person does about it.
 */
export function busyExternal(port: { path: string; key?: string; alias?: string }, holders: PortHolder[]): FrError {
  const who = holderText(holders);
  const remediation = holders.map((h) => ({
    human: BROWSER.test(h.app)
      ? `close the Web Serial tab in ${h.app} (PID ${h.pid}) or click Disconnect there, then retry`
      : `quit ${h.app || 'the program'} (PID ${h.pid}) or close its connection to ${port.path}, then retry`,
  }));
  return new FrError('PORT_BUSY_EXTERNAL', `${port.path}${port.alias ? ` (${port.alias})` : ''} is held by ${who}`, {
    remediation,
    details: {
      path: port.path,
      ...(port.key ? { port: port.key } : {}),
      ...(port.alias ? { device: port.alias } : {}),
      holders,
      holder: who,
    },
  });
}

/**
 * PORT_LEASED (09 §9.3) for a port leased to a job (`holder` "job j_…") or, through a serial lease, to
 * another program: then with the lease, and serial_release as the remedy if it is the caller's.
 */
export function portLeased(port: { path: string; alias?: string }, held: { holder?: string; lease?: PortLease }): FrError {
  const lease = held.lease;
  return new FrError('PORT_LEASED', `${port.path}${port.alias ? ` (${port.alias})` : ''} is leased to ${held.holder ?? 'another program'}`, {
    ...(lease ? { remediation: [{ tool: 'serial_release', args: { lease_id: lease.lease_id }, human: `if the lease is yours, release it; else wait for ${lease.expires_at}` }] } : {}),
    details: { holder: held.holder, ...(lease ? { lease_id: lease.lease_id, holder_pid: lease.holder_pid, expires_at: lease.expires_at } : {}) },
  });
}

/**
 * The pre-job check of provisioning, flashing and resets (06 §6.4: whatever can fail without touching the
 * board fails before the job starts): PORT_LEASED while a serial lease holds the port, PORT_BUSY_EXTERNAL
 * while another program has it open. A port a job of the hub's holds is not refused: the new job queues
 * on the port lock.
 */
export async function assertPortFree(hub: Pick<HubContext, 'serial'> & Partial<Pick<HubContext, 'portHolders'>>, port: { key: string; path: string; alias?: string }): Promise<void> {
  const info = hub.serial.list?.().find((p) => p.path === port.path);
  if (info?.lease) {
    throw portLeased(port, info);
  }
  const others = (await hub.portHolders?.holders([port.path]))?.get(port.path) ?? [];
  if (others.length) {
    throw busyExternal(port, others);
  }
}

/**
 * The pytools sidecar's PORT_BUSY_EXTERNAL ("close any other program using the port") names nobody; this
 * names the holder when lsof finds one. Any other error passes through.
 */
export async function nameBusyHolder(hub: Partial<Pick<HubContext, 'portHolders'>>, port: { path: string; key?: string; alias?: string }, err: unknown): Promise<unknown> {
  if (!(err instanceof FrError) || err.code !== 'PORT_BUSY_EXTERNAL' || err.details?.holders || !hub.portHolders) {
    return err;
  }
  const others = (await hub.portHolders.holders([port.path]).catch(() => new Map<string, PortHolder[]>())).get(port.path) ?? [];
  return others.length ? busyExternal(port, others) : err;
}

const listCache = new WeakMap<PortHolders, { at: number; paths: string; found: Map<string, PortHolder[]> }>();

/**
 * port_list (design c6 D5): SerialPortManager.list() with `external`, the other programs that have a port
 * open too (a Web Serial page opened after the hub did: macOS lets a second open through, since the hub
 * sets no TIOCEXCL). lsof runs at most every 2 s; the serial manager keeps what it found for hub_status.
 */
export async function listPorts(hub: Pick<HubContext, 'serial'> & Partial<Pick<HubContext, 'portHolders'>>, now = Date.now()): Promise<{ ports: PortInfo[] }> {
  const probe = hub.portHolders;
  const paths = hub.serial
    .list()
    .filter((p) => p.state !== 'leased')
    .map((p) => p.path)
    .sort();
  if (probe && paths.length) {
    const key = paths.join('\n');
    let cached = listCache.get(probe);
    if (!cached || cached.paths !== key || now - cached.at >= LIST_CACHE_MS) {
      cached = { at: now, paths: key, found: await probe.holders(paths) };
      listCache.set(probe, cached);
    }
    hub.serial.noteExternal?.(cached.found);
  }
  return { ports: hub.serial.list() };
}
