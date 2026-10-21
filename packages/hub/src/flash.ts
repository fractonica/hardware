// Serial flashing through the pytools sidecar (spec 06 §6.4, §6.10; 08 §8.5): flash plans and the
// sidecar runner.

import { spawn } from 'node:child_process';

import { pytoolsPython } from '@fractonica/host';
import { type ArtifactManifest, type ErrorCode, ERROR_CODES, FrError } from '@fractonica/protocol';

import { blobPath } from './artifacts.ts';
import type { HubContext } from './context.ts';
import type { JobCtx } from './jobs.ts';

/** Flash plans (06 §6.4). */
export type PlanName = 'app' | 'full' | 'identity' | 'recover';

/** Where fr_ident lives in flash: the last 16 KB, found by label (06 §6.2). */
export interface IdentRegion {
  offset: number;
  size: number;
}

export interface FlashPlan {
  plan: PlanName;
  files: Array<{ offset: string; role: string; path: string; size: number }>;
  erase: Array<{ offset: string; size: string; why: string }>;
  /**
   * fr_ident from the registry, rendered when the job runs and written in the same write_flash. Never
   * part of `files` in a plan or a dry run: the image holds the Wi-Fi password.
   */
  ident?: { offset: string; size: string; why: string };
}

const FULL_ROLES = ['bootloader', 'partition_table', 'ota_data_initial', 'app'];
const APP_ROLES = ['ota_data_initial', 'app'];

const hex = (n: number) => '0x' + n.toString(16);

/** The fr_ident partition in an artifact's partition table, or null. */
export function identRegion(m: ArtifactManifest): IdentRegion | null {
  const p = m.partitions.find((x) => x.label === 'fr_ident');
  return p ? { offset: p.offset, size: p.size } : null;
}

/**
 * app: otadata + app (otadata is required, or a device that last booted ota_1 keeps the old image).
 * full: bootloader, partition table, otadata, app; plus fr_ident when `ident` is given (a device the
 *   registry provisioned), else the fr_ident region is erased so stale data from earlier firmware can
 *   never be read as identity (the board boots UNASSIGNED).
 * identity: fr_ident only (rename, new Wi-Fi, new hub host); `m` may be null.
 * recover: full with fr_ident restored from the registry, for a provisioned device that lost its flash.
 */
export function flashPlan(m: ArtifactManifest | null, plan: PlanName, opts: { ident?: IdentRegion } = {}): FlashPlan {
  const { ident } = opts;
  if ((plan === 'identity' || plan === 'recover') && !ident) {
    throw new FrError('INTERNAL', `plan ${plan} needs the device's fr_ident region`);
  }
  if (plan === 'app' && ident) {
    throw new FrError('INTERNAL', 'plan app never writes fr_ident');
  }
  if (plan !== 'identity' && !m) {
    throw new FrError('INTERNAL', `plan ${plan} needs an artifact`);
  }
  const roles = plan === 'identity' ? [] : plan === 'app' ? APP_ROLES : FULL_ROLES;
  const files = (m?.flash.files ?? [])
    .filter((f) => roles.includes(f.role))
    .map((f) => ({ offset: f.offset, role: f.role, path: blobPath(f.blob), size: f.size }));
  for (const role of roles) {
    if (!files.some((f) => f.role === role)) {
      throw new FrError('FLASH_FAILED', `artifact ${m?.build_id} has no ${role} image`);
    }
  }
  const erase: FlashPlan['erase'] = [];
  if (ident) {
    const why = plan === 'identity' ? 'identity from the registry' : 'identity from the registry (provisioned device)';
    return { plan, files, erase, ident: { offset: hex(ident.offset), size: hex(ident.size), why } };
  }
  const region = m && identRegion(m);
  if (plan === 'full' && region) {
    erase.push({ offset: hex(region.offset), size: hex(region.size), why: 'no identity yet (UNASSIGNED)' });
  }
  return { plan, files, erase };
}

/**
 * Hard reset through the hub's open port, so the ROM, bootloader and boot banner lines are captured
 * (06 §6.4 step 8); falls back to esptool when the hub cannot, and then the boot log may be incomplete.
 */
export async function hardResetCapturing(hub: Pick<HubContext, 'serial'>, key: string, ctx: JobCtx): Promise<'hub' | 'esptool'> {
  try {
    await hub.serial.hardReset(key);
    return 'hub';
  } catch (e) {
    ctx.log(`hub reset failed (${(e as Error).message}); resetting with esptool, boot log may be incomplete`, 'event');
    const lease = await hub.serial.lease(key, `job ${ctx.jobId}`);
    try {
      await runPytools({ cmd: 'reset', port: lease.path, mode: 'hard' }, ctx);
      return 'esptool';
    } finally {
      lease.release();
    }
  }
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
  | { cmd: 'reset'; port: string; mode: 'hard' | 'bootloader' }
  /**
   * Renders an NVS image (fr_ident, spec 06 §6.3) from a CSV; resolves with `{out_path, size, rows}`.
   * The CSV holds the Wi-Fi password: the sidecar never echoes its content (errors name the row only),
   * and the caller keeps it in a 0700 temp dir it deletes (design c3 §4).
   */
  | { cmd: 'nvs_gen'; csv_path: string; size: number | string; out_path: string };

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
