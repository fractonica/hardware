// The C++ fr_net_node for interop tests (design c3 §5, c4 §5): build/host-tests/fr_net_node runs the real
// fr_net core, services and (C4) the real fr_ota core on POSIX links. CppNode is one process; CppBoard is
// one board across boots: with --ota-dir an exited process (an OTA restart, a rollback, a crash) is power
// cycled into the next boot, which reads what the last one left in its flash and nvs.
// `pnpm test:host` builds the binary (run it again after changing C++); without it the suites are skipped.

import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { until } from './fake-node.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const BIN = resolve(REPO, 'build', 'host-tests', 'fr_net_node');

export type Line = { ev: string; [k: string]: unknown };

/**
 * One fr_net_node process: its JSON lines, and stdin commands (state, udp_block <s>, drop_hub_link <s>, ip_block <s>,
 * tcp 0|1, usb 0|1, bye, crash, quit).
 */
export class CppNode {
  readonly lines: Line[] = [];
  readonly proc: ChildProcessWithoutNullStreams;
  exited: number | null = null;
  /** With --serial: the node's `@fr1:` lines, as its USB port would print them. */
  onSerial: (line: string) => void = () => undefined;
  #buf = '';
  #onExit: Array<(code: number) => void> = [];

  constructor(args: string[]) {
    this.proc = spawn(BIN, args, { env: { ...process.env, ASAN_OPTIONS: 'detect_leaks=0:abort_on_error=1' } });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk: string) => {
      this.#buf += chunk;
      let nl: number;
      while ((nl = this.#buf.indexOf('\n')) >= 0) {
        const text = this.#buf.slice(0, nl);
        this.#buf = this.#buf.slice(nl + 1);
        if (text.startsWith('@fr1:')) {
          this.onSerial(text);
          continue;
        }
        try {
          this.lines.push(JSON.parse(text) as Line);
        } catch {
          this.lines.push({ ev: 'text', text });
        }
      }
    });
    this.proc.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk));
    this.proc.stdin.on('error', () => undefined); // a line written after the node exited
    // 'close', not 'exit': stdout is drained by then, so every line the process printed is in `lines`.
    this.proc.on('close', (code) => {
      this.exited = code ?? -1;
      for (const fn of this.#onExit.splice(0)) {
        fn(this.exited);
      }
    });
  }

  send(cmd: string): void {
    this.proc.stdin.write(`${cmd}\n`);
  }

  of(ev: string): Line[] {
    return this.lines.filter((l) => l.ev === ev);
  }

  /** Dispatches of `port/cmd` the node ran. */
  ran(port: number, cmd: number): number {
    return this.of('dispatch').filter((l) => l.port === port && l.cmd === cmd).length;
  }

  async state(): Promise<Line> {
    const n = this.of('state').length;
    this.send('state');
    await until(() => this.of('state').length > n, 2000, 'a state line');
    return this.of('state').at(-1)!;
  }

  /** Calls `fn` once the process has exited (at once if it has). */
  onExit(fn: (code: number) => void): void {
    if (this.exited !== null) {
      fn(this.exited);
    } else {
      this.#onExit.push(fn);
    }
  }

  stop(): void {
    if (this.exited === null) {
      this.proc.kill('SIGKILL');
    }
  }
}

/**
 * One board across boots: the same args (so the same --ota-dir: flash, otadata, nvs:fr_ota, boot epoch) for
 * every process. While powered, a process that exits (OTA restart, rollback reboot, `crash`) is followed by
 * the next boot after `bootMs`; `power(false)` holds it off, as a board that lost power.
 */
export class CppBoard {
  readonly boots: CppNode[] = [];
  readonly args: string[];
  #powered = true;
  #stopped = false;
  #bootMs: number;

  constructor(args: string[], opts: { bootMs?: number } = {}) {
    this.args = args;
    this.#bootMs = opts.bootMs ?? 50;
    this.#boot();
  }

  /** The current (or last) boot's process. */
  get node(): CppNode {
    return this.boots.at(-1)!;
  }

  /** Lines of every boot, in order. */
  lines(ev?: string): Line[] {
    const all = this.boots.flatMap((b) => b.lines);
    return ev ? all.filter((l) => l.ev === ev) : all;
  }

  /** Power on (boots now if no process runs) or off (no next boot once the current process ends). */
  power(on: boolean): void {
    this.#powered = on;
    if (on && this.node.exited !== null && !this.#stopped) {
      this.#boot();
    }
  }

  /** Waits until boot number `n` (1 = the first) has started. */
  async booted(n: number, timeoutMs = 10_000): Promise<CppNode> {
    await until(() => this.boots.length >= n && this.boots[n - 1].of('started').length > 0, timeoutMs, `boot ${n}`);
    return this.boots[n - 1];
  }

  stop(): void {
    this.#stopped = true;
    for (const b of this.boots) {
      b.stop();
    }
  }

  #boot(): void {
    const node = new CppNode(this.args);
    this.boots.push(node);
    node.onExit(() => {
      if (this.#stopped || !this.#powered) {
        return;
      }
      setTimeout(() => {
        if (!this.#stopped && this.#powered && this.node === node) {
          this.#boot();
        }
      }, this.#bootMs);
    });
  }
}

/** `fr_net_node --make-image`: an app image the node's CHECK accepts (06 §6.8 layout, SHA-256 appended). */
export function makeImage(path: string, opts: { version: string; size: number; seed: number; fault?: boolean; profile?: string }): { fw_id: string; image: Buffer } {
  const args = ['--make-image', path, '--version', opts.version, '--size', String(opts.size), '--seed', String(opts.seed)];
  if (opts.fault) {
    args.push('--fault', '1');
  }
  if (opts.profile) {
    args.push('--profile', opts.profile);
  }
  const r = spawnSync(BIN, args, { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`fr_net_node --make-image failed: ${r.stderr}`);
  }
  const line = JSON.parse(r.stdout.trim().split('\n').at(-1)!) as { ev: string; fw_id: string; size: number };
  return { fw_id: line.fw_id, image: readFileSync(path) };
}
