// Serial flashing through the pytools sidecar (spec 06 §6.4, §6.10; 08 §8.5).

import { spawn } from 'node:child_process';

import { pytoolsPython } from '@fractonica/host';
import { type ArtifactManifest, type ErrorCode, ERROR_CODES, FrError } from '@fractonica/protocol';

import { blobPath } from './artifacts.ts';
import type { JobCtx } from './jobs.ts';

export interface FlashPlan {
  plan: 'app' | 'full';
  files: Array<{ offset: string; role: string; path: string; size: number }>;
  erase: Array<{ offset: string; size: string; why: string }>;
}

const FULL_ROLES = ['bootloader', 'partition_table', 'ota_data_initial', 'app'];
const APP_ROLES = ['ota_data_initial', 'app'];

/**
 * full: bootloader, partition table, otadata, app. A device without a hub identity also gets its
 * fr_ident region erased so stale data from earlier firmware can never be read as identity.
 * app: otadata + app (otadata is required, or a device that last booted ota_1 keeps the old image).
 */
export function flashPlan(m: ArtifactManifest, plan: 'app' | 'full'): FlashPlan {
  const roles = plan === 'full' ? FULL_ROLES : APP_ROLES;
  const files = m.flash.files
    .filter((f) => roles.includes(f.role))
    .map((f) => ({ offset: f.offset, role: f.role, path: blobPath(f.blob), size: f.size }));
  for (const role of roles) {
    if (!files.some((f) => f.role === role)) {
      throw new FrError('FLASH_FAILED', `artifact ${m.build_id} has no ${role} image`);
    }
  }
  const erase: FlashPlan['erase'] = [];
  const ident = m.partitions.find((p) => p.label === 'fr_ident');
  if (plan === 'full' && ident) {
    erase.push({ offset: '0x' + ident.offset.toString(16), size: '0x' + ident.size.toString(16), why: 'no identity yet (UNASSIGNED)' });
  }
  return { plan, files, erase };
}

interface SidecarEvent {
  ev: string;
  msg?: string;
  level?: string;
  pct?: number;
  prefix?: string;
  stage?: string;
  data?: unknown;
  code?: string;
  message?: string;
  hint?: string;
}

/** Sidecar requests (tools/pytools `__main__.py`). */
export type PytoolsRequest =
  | { cmd: 'version' }
  | { cmd: 'probe'; port: string; before?: string }
  | {
      cmd: 'flash';
      port: string;
      files: Array<{ offset: string; path: string }>;
      erase?: Array<{ offset: string; size: string }>;
      after?: 'hard-reset' | 'no-reset';
      before?: string;
      /** Image header chip id (manifest `chip_id`); the sidecar fails with TARGET_MISMATCH before writing if the chip differs. */
      expect_chip_id?: number;
    }
  | { cmd: 'reset'; port: string; mode: 'hard' | 'bootloader' };

/** Runs one pytools request; progress and log events go to the job; resolves with the result data. */
export function runPytools(req: PytoolsRequest, ctx: JobCtx): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // A cancel during an earlier await (lease, port close) already fired; a listener added now never would.
    ctx.signal.throwIfAborted();
    const child = spawn(pytoolsPython(), ['-I', '-m', 'fractonica_pytools'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const abort = () => child.kill('SIGTERM');
    ctx.signal.addEventListener('abort', abort, { once: true });
    let result: unknown;
    let error: FrError | null = null;
    let buf = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let ev: SidecarEvent;
        try {
          ev = JSON.parse(line) as SidecarEvent;
        } catch {
          ctx.log(line, 'out');
          continue;
        }
        if (ev.ev === 'log' && ev.msg) {
          ctx.log(ev.msg, ev.level === 'error' ? 'err' : 'out');
        } else if (ev.ev === 'progress' && typeof ev.pct === 'number') {
          ctx.progress(ev.pct, ev.prefix);
        } else if (ev.ev === 'stage' && ev.stage) {
          ctx.stage(ev.stage);
        } else if (ev.ev === 'result') {
          result = ev.data;
        } else if (ev.ev === 'error') {
          const code = (ERROR_CODES as readonly string[]).includes(ev.code ?? '') ? (ev.code as ErrorCode) : 'FLASH_FAILED';
          error = new FrError(code, ev.message ?? 'pytools failed', {
            ...(ev.hint ? { hint: ev.hint } : {}),
            details: { stage: ev.stage },
          });
          ctx.log(`error: ${ev.message}`, 'err');
        }
      }
    });
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (e) =>
      reject(new FrError('ENV_MISSING', `cannot start pytools: ${e.message}`, { remediation: [{ cli: 'fr doctor --fix' }] })),
    );
    child.on('close', (code) => {
      ctx.signal.removeEventListener('abort', abort);
      if (stderr.trim()) {
        ctx.log(stderr.trim().slice(-2000), 'err');
      }
      if (error) {
        reject(error);
      } else if (code === 0) {
        resolve(result);
      } else if (ctx.signal.aborted) {
        reject(ctx.signal.reason);
      } else {
        reject(new FrError('FLASH_FAILED', `pytools exited with ${code}`));
      }
    });
    child.stdin.end(JSON.stringify(req));
  });
}
