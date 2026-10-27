// The TS side of fr_fleet (design m2-c2 D8, §3 "The fleet's contract"): spawn it on a spec, wait for its `ready` line,
// and talk to its control channel by request id. The sim runner (runner.ts), the fleet diag (fleet-diag.ts), the
// person bot (person.ts) and packages/hub/test/fleet-hub.test.ts use it.
//
// - Fleet.spawn(spec, opts) writes the spec (fractonica/fleet-spec@1, FleetSpecSchema) to a file when given an object,
//   starts the binary (FR_FLEET_BIN, else build/host-fleet/fr_fleet; `node tools/host-test.mjs --fleet` builds it),
//   optionally in a process group of its own (`detached`, D14: a job cancel's group SIGTERM does not reach it), and
//   resolves with the ready line's ports and fd limits.
// - Commands go to its stdin as `@<rid> <target> <command…>`; each answer line is matched to its request by `rid`
//   (FleetAnswerSchema). cmd() takes one node or `fleet`; all() takes `*` and resolves at FleetDoneSchema's line.
// - Every other line is the fleet's: the 1 s counter line (`{"fleet":"tick",...}`, `ticks`) and, at verbosity 1 and up,
//   node events tagged "node" (`events`, onEvent()).
// - FleetControl.connect(addr) is the same channel over the control port, for a second client (a person bot in
//   another process).
// - quit() asks it to quit, then SIGKILLs it (its group when detached) after `graceMs` (default 1 s).

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type FleetAnswer,
  FleetAnswerSchema,
  type FleetDone,
  FleetDoneSchema,
  type FleetReady,
  FleetReadySchema,
  type FleetSpec,
  FleetSpecSchema,
} from '@fractonica/protocol';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The fleet binary: FR_FLEET_BIN, else the non-sanitized build of `node tools/host-test.mjs --fleet`. */
export function fleetBin(): string {
  return process.env.FR_FLEET_BIN ? resolve(process.env.FR_FLEET_BIN) : resolve(REPO, 'build', 'host-fleet', 'fr_fleet');
}

export function fleetBinExists(): boolean {
  return existsSync(fleetBin());
}

/** A line the fleet printed that is not an answer: a counter line or a node event. */
export type FleetLine = Record<string, unknown>;

/** `{"fleet":"tick",...}`, once a second. */
export interface FleetTick {
  fleet: 'tick';
  t_ms: number;
  powered: number;
  tcp_sessions: number;
  serial_sessions: number;
  lag: { events: number; p50_us: number; p99_us: number; max_us: number; all_p99_us: number; all_max_us: number };
  dropped_lines: number;
}

/** The hub ports `fleet start` takes: its node TCP and UDP ports and its node HTTP port. */
export interface FleetHub {
  host?: string;
  tcp: number;
  udp: number;
  http: number;
}

type Pending = {
  resolve: (v: { answers: FleetAnswer[]; done?: FleetDone }) => void;
  reject: (e: Error) => void;
  answers: FleetAnswer[];
  all: boolean;
  timer: NodeJS.Timeout;
};

/** One control channel (stdin/stdout, or a control-port connection): requests by rid, answers matched back. */
abstract class Channel {
  readonly ticks: FleetTick[] = [];
  readonly events: FleetLine[] = [];
  #rid = 0;
  #pending = new Map<string, Pending>();
  #onEvent: ((l: FleetLine) => void)[] = [];
  #buf = '';
  #closed: Error | null = null;

  protected abstract write(line: string): void;

  /** One command to one node, or to `fleet`: its answer (ok false is still an answer; a timeout throws). */
  async cmd(target: string, command: string, timeoutMs = 10_000): Promise<FleetAnswer> {
    if (target === '*') {
      throw new Error('cmd() takes one node; all() takes `*`');
    }
    const r = await this.#request(target, command, false, timeoutMs);
    return r.answers[0];
  }

  /** One command to every started node: their answers, and the closing line's count. */
  async all(command: string, timeoutMs = 30_000): Promise<{ answers: FleetAnswer[]; done: FleetDone }> {
    const r = await this.#request('*', command, true, timeoutMs);
    return { answers: r.answers, done: r.done! };
  }

  /** Calls `fn` with every node event (verbosity 1 and up) and counter line. */
  onEvent(fn: (l: FleetLine) => void): void {
    this.#onEvent.push(fn);
  }

  /** `fleet start`: every non-spare node powers on against the hub, `staggerMs` apart. */
  async startNodes(hub: FleetHub, staggerMs = 0): Promise<FleetAnswer> {
    const a = await this.cmd('fleet', `start ${hub.host ?? '127.0.0.1'} ${hub.tcp} ${hub.udp} ${hub.http}${staggerMs ? ` --stagger-ms ${staggerMs}` : ''}`);
    if (!a.ok) {
      throw new Error(`fleet start: ${String(a.error)}`);
    }
    return a;
  }

  /** `fleet stats`: the lag histogram (D15), the arrival skew (D16), the links' counters. */
  async stats(): Promise<Record<string, any>> {
    return (await this.cmd('fleet', 'stats')).stats as Record<string, any>;
  }

  /** `fleet medium`: channel use and per-radio counters (D4). */
  async medium(): Promise<Record<string, any>> {
    return (await this.cmd('fleet', 'medium')).medium as Record<string, any>;
  }

  /** `fleet ap off|on`. */
  async ap(on: boolean): Promise<void> {
    await this.cmd('fleet', `ap ${on ? 'on' : 'off'}`);
  }

  /** A node's `diag <line>`: NodeDiag's answer, as diag_exec's `response`. */
  async diag(alias: string, line: string, timeoutMs = 10_000): Promise<Record<string, unknown>> {
    const a = await this.cmd(alias, `diag ${line}`, timeoutMs);
    if (!a.ok) {
      throw new Error(`${alias}: diag ${line}: ${String(a.error)}`);
    }
    return a.response as Record<string, unknown>;
  }

  /** A node's `state` line (fr_net_node's). */
  async state(alias: string): Promise<Record<string, any>> {
    const a = await this.cmd(alias, 'state');
    if (!a.ok) {
      throw new Error(`${alias}: state: ${String(a.error)}`);
    }
    return a.state as Record<string, any>;
  }

  protected receive(chunk: string): void {
    this.#buf += chunk;
    let nl: number;
    while ((nl = this.#buf.indexOf('\n')) >= 0) {
      const text = this.#buf.slice(0, nl);
      this.#buf = this.#buf.slice(nl + 1);
      if (text.trim()) {
        this.#line(text);
      }
    }
  }

  protected closed(e: Error): void {
    this.#closed = e;
    for (const [rid, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(e);
      this.#pending.delete(rid);
    }
  }

  /** The ready line goes to the spawner; anything else not an answer is an event. */
  protected abstract other(line: FleetLine): boolean;

  #line(text: string): void {
    let o: FleetLine;
    try {
      o = JSON.parse(text) as FleetLine;
    } catch {
      o = { text };
    }
    const rid = typeof o.rid === 'string' ? o.rid : undefined;
    const p = rid !== undefined ? this.#pending.get(rid) : undefined;
    if (p) {
      const done = FleetDoneSchema.safeParse(o);
      if (done.success) {
        clearTimeout(p.timer);
        this.#pending.delete(rid!);
        p.resolve({ answers: p.answers, done: done.data });
        return;
      }
      const a = FleetAnswerSchema.safeParse(o);
      if (a.success) {
        p.answers.push(a.data);
        if (!p.all) {
          clearTimeout(p.timer);
          this.#pending.delete(rid!);
          p.resolve({ answers: p.answers });
        }
        return;
      }
    }
    if (this.other(o)) {
      return;
    }
    if (o.fleet === 'tick') {
      this.ticks.push(o as unknown as FleetTick);
      if (this.ticks.length > 3600) {
        this.ticks.splice(0, this.ticks.length - 3600);
      }
    } else {
      this.events.push(o);
      if (this.events.length > 100_000) {
        this.events.splice(0, this.events.length - 100_000);
      }
    }
    for (const fn of this.#onEvent) {
      fn(o);
    }
  }

  #request(target: string, command: string, all: boolean, timeoutMs: number): Promise<{ answers: FleetAnswer[]; done?: FleetDone }> {
    if (this.#closed) {
      return Promise.reject(this.#closed);
    }
    if (/[\r\n]/.test(command)) {
      return Promise.reject(new Error('a fleet command is one line'));
    }
    const rid = String(++this.#rid);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(rid);
        reject(new Error(`fr_fleet: no answer to ${target} ${command} within ${timeoutMs} ms`));
      }, timeoutMs);
      this.#pending.set(rid, { resolve, reject, answers: [], all, timer });
      this.write(`@${rid} ${target} ${command}`);
    });
  }
}

export interface FleetSpawnOptions {
  /** The binary (default fleetBin()). */
  bin?: string;
  /** Where an object spec is written (default a fresh temp dir). */
  specPath?: string;
  /** A process group of its own (D14). */
  detached?: boolean;
  env?: NodeJS.ProcessEnv;
  /** How long to wait for the ready line (default 30 s). */
  readyMs?: number;
  /** Every stderr chunk (default: forwarded to this process's stderr). */
  onStderr?: (chunk: string) => void;
}

/** A spawned fr_fleet and its stdin/stdout channel. */
export class Fleet extends Channel {
  readonly proc: ChildProcessWithoutNullStreams;
  readonly specPath: string;
  readonly detached: boolean;
  ready!: FleetReady;
  exited: number | null = null;
  #ready: { resolve: (r: FleetReady) => void; reject: (e: Error) => void } | null = null;
  #exit: Promise<number | null>;

  private constructor(specPath: string, opts: FleetSpawnOptions) {
    super();
    this.specPath = specPath;
    this.detached = opts.detached ?? false;
    this.proc = spawn(opts.bin ?? fleetBin(), ['--spec', specPath], {
      env: { ASAN_OPTIONS: 'detect_leaks=0:abort_on_error=1', ...process.env, ...opts.env },
      detached: this.detached,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (c: string) => this.receive(c));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (c: string) => (opts.onStderr ? opts.onStderr(c) : process.stderr.write(c)));
    this.proc.stdin.on('error', () => undefined);
    // A binary that cannot start (ENOENT, EACCES): the spawn fails, and 'close' follows.
    this.proc.on('error', (e) => this.#ready?.reject(new Error(`fr_fleet did not start: ${e.message}`)));
    this.#exit = new Promise((r) =>
      this.proc.on('close', (code) => {
        this.exited = code ?? -1;
        const e = new Error(`fr_fleet exited (${String(code)})`);
        this.#ready?.reject(e);
        this.closed(e);
        r(code);
      }),
    );
  }

  /** Writes `spec` (when an object) and starts the fleet; resolves once it printed its ready line. */
  static async spawn(spec: FleetSpec | string, opts: FleetSpawnOptions = {}): Promise<Fleet> {
    let path: string;
    if (typeof spec === 'string') {
      path = spec;
    } else {
      const parsed = FleetSpecSchema.parse(spec);
      path = opts.specPath ?? join(mkdtempSync(join(tmpdir(), 'fr-fleet-spec-')), 'fleet-spec.json');
      writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`);
    }
    const f = new Fleet(path, opts);
    const ready = new Promise<FleetReady>((resolve, reject) => (f.#ready = { resolve, reject }));
    const timer = setTimeout(() => f.#ready?.reject(new Error(`fr_fleet printed no ready line within ${opts.readyMs ?? 30_000} ms`)), opts.readyMs ?? 30_000);
    try {
      f.ready = await ready;
    } catch (e) {
      f.kill();
      throw e;
    } finally {
      clearTimeout(timer);
    }
    return f;
  }

  /** The control port's address, for FleetControl.connect(). */
  get control(): string {
    return this.ready.control;
  }

  /** The bridge's address, for the hub's --serial-bridge. */
  get bridge(): string {
    return this.ready.bridge;
  }

  /** `fleet quit`, then SIGKILL after `graceMs` if it is still there; the exit code. */
  async quit(graceMs = 1000): Promise<number | null> {
    if (this.exited === null) {
      this.write('@quit fleet quit');
      this.proc.stdin.end();
      const t = setTimeout(() => this.kill(), graceMs);
      await this.#exit;
      clearTimeout(t);
    }
    return this.exited;
  }

  /** SIGKILL, its group's when detached. */
  kill(): void {
    if (this.exited !== null) {
      return;
    }
    try {
      if (this.detached && this.proc.pid) {
        process.kill(-this.proc.pid, 'SIGKILL');
      } else {
        this.proc.kill('SIGKILL');
      }
    } catch {
      // gone already
    }
  }

  protected write(line: string): void {
    if (this.exited === null) {
      this.proc.stdin.write(`${line}\n`);
    }
  }

  protected other(line: FleetLine): boolean {
    if (line.fleet === 'ready') {
      const r = FleetReadySchema.safeParse(line);
      if (r.success) {
        this.#ready?.resolve(r.data);
      } else {
        this.#ready?.reject(new Error(`fr_fleet's ready line does not parse: ${r.error.message}`));
      }
      this.#ready = null;
      return true;
    }
    return false;
  }
}

/** The fleet's control port (`127.0.0.1:<p>` from the ready line): the same requests from another client. */
export class FleetControl extends Channel {
  readonly #sock: Socket;

  private constructor(sock: Socket) {
    super();
    this.#sock = sock;
    sock.setEncoding('utf8');
    sock.on('data', (c: string) => this.receive(c));
    sock.on('close', () => this.closed(new Error('the fleet closed its control connection')));
    sock.on('error', () => undefined);
  }

  static connect(addr: string, timeoutMs = 5000): Promise<FleetControl> {
    const m = /^127\.0\.0\.1:(\d+)$/.exec(addr);
    if (!m) {
      return Promise.reject(new Error(`a fleet control address is 127.0.0.1:<port>, not ${addr}`));
    }
    return new Promise((resolve, reject) => {
      const sock = connect({ host: '127.0.0.1', port: Number(m[1]) });
      const t = setTimeout(() => {
        sock.destroy();
        reject(new Error(`fleet control ${addr}: no connection within ${timeoutMs} ms`));
      }, timeoutMs);
      sock.once('error', (e) => {
        clearTimeout(t);
        reject(e);
      });
      sock.once('connect', () => {
        clearTimeout(t);
        resolve(new FleetControl(sock));
      });
    });
  }

  close(): void {
    this.#sock.end();
  }

  protected write(line: string): void {
    this.#sock.write(`${line}\n`);
  }

  protected other(): boolean {
    return false;
  }
}
