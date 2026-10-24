// `fr gen` (spec 07 §7.6, design c2 §7): regenerates the committed codegen outputs, or renders a
// profile's firmware composition into a build dir. Local like `fr doctor`: it needs a checkout,
// not a hub. The codegen package is loaded on first use, so other commands do not pay for it.

import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { findSourceDir } from '@fractonica/host';
import { FrError, type Result } from '@fractonica/protocol';

type Codegen = typeof import('@fractonica/codegen');

function toError(e: unknown, codegen: Codegen): FrError {
  if (e instanceof FrError) {
    return e;
  }
  // Schema and profile validation lists every problem with its file and YAML path.
  if (e instanceof codegen.SchemaError) {
    const issues = e.issues.map(codegen.formatIssue);
    return new FrError('INVALID_SOURCE', `${issues.length} schema problem(s), first: ${issues[0]}`, { details: { issues } });
  }
  return new FrError('INTERNAL', e instanceof Error ? e.message : String(e));
}

const ok = (data: unknown): Result => ({ ok: true, data, cursor: '' });
const failed = (e: unknown, codegen: Codegen): Result => ({ ok: false, cursor: '', error: toError(e, codegen).toToolError() });

function sourceDir(cwd: string): string {
  const src = findSourceDir(cwd);
  if (!src) {
    throw new FrError('INVALID_SOURCE', `${cwd} is not inside a Fractonica checkout`, { remediation: [{ human: 'cd into the repo' }] });
  }
  return src;
}

/**
 * `fr gen [--check]`: every committed output (C++ and TS codecs, catalog, schemas, golden vectors).
 * With `check`, stale files make a failed Result without an error, which exits 1 like `fr doctor`.
 * Both first validate the HIL bench files (hardware/bench/*.bench.yaml, design m2-c1-hil D7) against the
 * boards and profiles: a bad bench is INVALID_SOURCE with every issue, like a bad schema, and the
 * documented exceptions it relies on come back as warnings.
 */
export async function genAll(opts: { check: boolean; cwd: string }): Promise<Result> {
  const codegen = await import('@fractonica/codegen');
  try {
    const src = sourceDir(opts.cwd);
    const r = await codegen.generateAll({ sourceDir: src, check: opts.check });
    const data = { source_dir: src, files: r.files.length, ...(opts.check ? { stale: r.stale } : { written: r.written }), benches: r.benches, warnings: r.warnings };
    return opts.check && r.stale.length ? { ok: false, data, cursor: '' } : ok(data);
  } catch (e) {
    return failed(e, codegen);
  }
}

/**
 * `fr gen firmware --profile <p> [--out <dir>] [--fault health]`. The default out dir is the one
 * `fr build` uses for a debug build (spec 03 §3.8): firmware/apps/<app>/build/<profile>-debug/fr_gen,
 * or <profile>-debug-fault/fr_gen for a fault build, which also gets the sdkconfig.fault layer. The
 * hub's `fr build` runs this command from the checkout it builds and reads `manifest` (app, board,
 * target), `part_profile` and `fault` from the --json envelope, so it never loads a generator of its own.
 * Every HIL bench naming the profile is validated first (codegen checkProfileBenches, design m2-c1-hil D7): a
 * bad one is INVALID_SOURCE with every issue and nothing is generated; `benches` lists the ones checked.
 */
export async function genFirmware(opts: { profile: string; out?: string; fault?: 'health'; cwd: string }): Promise<Result> {
  const codegen = await import('@fractonica/codegen');
  try {
    const src = sourceDir(opts.cwd);
    const profiles = join(src, 'firmware', 'profiles');
    if (!existsSync(join(profiles, `${opts.profile}.profile.yaml`))) {
      const known = readdirSync(profiles).flatMap((f) => (f.endsWith('.profile.yaml') ? [f.slice(0, -'.profile.yaml'.length)] : []));
      throw new FrError('NOT_FOUND', `no profile ${opts.profile} in ${profiles}`, { details: { profiles: known } });
    }
    const prof = codegen.resolveProfile(src, opts.profile);
    // Design m2-c1-hil D7: every bench that names this profile must pass, so `fr build` refuses a fixture (or
    // DUT) build whose binds no longer match the bench it is wired into, as `fr gen --check` would.
    const benches = codegen.checkProfileBenches(src, opts.profile);
    const buildDir = `${opts.profile}-debug${opts.fault ? '-fault' : ''}`;
    const outDir = opts.out ? resolve(opts.cwd, opts.out) : join(src, 'firmware', 'apps', prof.app, 'build', buildDir, 'fr_gen');
    const r = codegen.generateFirmware({ sourceDir: src, profile: opts.profile, outDir, ...(opts.fault ? { fault: opts.fault } : {}) });
    return ok({
      source_dir: src,
      profile: opts.profile,
      out_dir: outDir,
      files: r.files.map((f) => f.path),
      slots_lock: r.slotsLock.path,
      slots_lock_changed: r.slotsLockChanged,
      warnings: r.warnings,
      manifest: r.manifest,
      part_profile: prof.partProfile,
      fault: opts.fault ?? null,
      benches: benches.benches,
    });
  } catch (e) {
    return failed(e, codegen);
  }
}
