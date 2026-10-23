// A latency_probe's raw samples (design c6 §6 S7): one NDJSON line per pulse and per PING, in
// <FR_HOME>/latency/<job_id>.ndjson, which the published T-LAT figures and tests/e2e/t-lat.ts read back.
// Lines are buffered and appended once a second, off the receive path; the file is complete once the job
// has ended (close() flushes).

import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const FLUSH_MS = 1000;

export class RawWriter {
  readonly path: string;
  #lines: string[] = [];
  #timer: NodeJS.Timeout | null = null;
  #writing: Promise<void> = Promise.resolve();
  #ready: Promise<void>;
  #closed = false;
  /** The first write error; later lines are dropped (the run goes on: the figures come from memory). */
  error: string | null = null;

  constructor(dir: string, jobId: string) {
    this.path = join(dir, `${jobId}.ndjson`);
    this.#ready = mkdir(dir, { recursive: true }).then(
      () => undefined,
      (e: Error) => {
        this.error = e.message;
      },
    );
  }

  /** Buffers one line; after close() (a cancelled run's stragglers) lines are dropped. */
  write(line: Record<string, unknown>): void {
    if (this.error || this.#closed) {
      return;
    }
    this.#lines.push(JSON.stringify(line));
    if (!this.#timer) {
      this.#timer = setTimeout(() => this.#flush(), FLUSH_MS);
      this.#timer.unref();
    }
  }

  #flush(): Promise<void> {
    this.#timer = null;
    if (!this.#lines.length) {
      return this.#writing;
    }
    const text = this.#lines.join('\n') + '\n';
    this.#lines = [];
    this.#writing = this.#writing
      .then(() => this.#ready)
      .then(() => (this.error ? undefined : appendFile(this.path, text)))
      .catch((e: Error) => {
        this.error ??= e.message;
      });
    return this.#writing;
  }

  /** Writes what is buffered; resolves once it is on disk. */
  async close(): Promise<void> {
    this.#closed = true;
    clearTimeout(this.#timer ?? undefined);
    await this.#flush();
  }
}
