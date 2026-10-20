import { spawn, type SpawnOptions } from 'node:child_process';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a command to completion and captures its output. Never throws for a non-zero exit. */
export function run(cmd: string, args: string[], opts: SpawnOptions & { input?: string } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (e) => resolve({ code: 127, stdout, stderr: stderr + String(e) }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (opts.input !== undefined) {
      child.stdin?.end(opts.input);
    } else {
      child.stdin?.end();
    }
  });
}
