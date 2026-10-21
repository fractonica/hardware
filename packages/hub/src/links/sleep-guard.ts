// SleepGuard (spec 05 §5.11, 08 §8.2 and §8.11; design c3 §4): while at least one node session is up the
// Mac must not idle-sleep, or every node loses the hub. `caffeinate -i -w <hub pid>` holds the
// PreventUserIdleSystemSleep assertion and exits by itself when the hub dies, so a crashed hub never
// leaves the assertion behind. Closing the lid still sleeps the Mac (the dashboard warns about that).

import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';

export type Spawn = (cmd: string, args: string[]) => ChildProcess;

export interface SleepGuardOptions {
  /** The process whose lifetime bounds the assertion (default: this one). */
  pid?: number;
  /** Default: darwin only; elsewhere the guard does nothing. */
  enabled?: boolean;
  spawn?: Spawn;
}

export class SleepGuard {
  #pid: number;
  #enabled: boolean;
  #spawn: Spawn;
  #child: ChildProcess | null = null;
  #want = false;

  constructor(opts: SleepGuardOptions = {}) {
    this.#pid = opts.pid ?? process.pid;
    this.#enabled = opts.enabled ?? process.platform === 'darwin';
    this.#spawn = opts.spawn ?? ((cmd, args) => nodeSpawn(cmd, args, { stdio: 'ignore' }));
  }

  /** The number of node sessions now up: the assertion is held while it is at least 1. */
  update(sessions: number): void {
    this.#want = sessions > 0;
    if (this.#want && !this.#child && this.#enabled) {
      this.#start();
    } else if (!this.#want && this.#child) {
      this.#kill();
    }
  }

  /** Whether the assertion is held. */
  active(): boolean {
    return this.#child !== null;
  }

  stop(): void {
    this.#want = false;
    this.#kill();
  }

  #start(): void {
    let child: ChildProcess;
    try {
      child = this.#spawn('caffeinate', ['-i', '-w', String(this.#pid)]);
    } catch (e) {
      this.#enabled = false;
      console.error(JSON.stringify({ event: 'sleep_guard_failed', message: (e as Error).message }));
      return;
    }
    this.#child = child;
    child.unref?.();
    child.on('error', (e: Error) => {
      // No caffeinate (not macOS after all): stop trying.
      if (this.#child === child) {
        this.#child = null;
      }
      this.#enabled = false;
      console.error(JSON.stringify({ event: 'sleep_guard_failed', message: e.message }));
    });
    child.on('exit', () => {
      if (this.#child === child) {
        this.#child = null;
        // Killed from outside while sessions are still up: take the assertion again.
        if (this.#want && this.#enabled) {
          setTimeout(() => this.#want && !this.#child && this.#enabled && this.#start(), 1000).unref();
        }
      }
    });
  }

  #kill(): void {
    const child = this.#child;
    this.#child = null;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
    }
  }
}
