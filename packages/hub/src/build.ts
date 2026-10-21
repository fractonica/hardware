// BuildRunner (spec 03 §3.6-3.8, 08 §8.6): profile + board -> `fr gen firmware` into <build>/fr_gen ->
// idf.py in the sanitized IDF environment -> artifact ingest. The generator runs as a child from the
// checkout being built, so the hub never loads @fractonica/codegen itself (design c2 §7).

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { checkSourceDir, idfEnv, idfStatus, readIdfLock, run } from '@fractonica/host';
import { FrError, type ToolError } from '@fractonica/protocol';

import { ingestBuild, lastFwId } from './artifacts.ts';
import type { Db } from './db.ts';
import type { JobCtx } from './jobs.ts';
import { stripAnsi } from './logstore.ts';

const DIAG_RE = /^(.+?):(\d+):(\d+): (fatal error|error|warning): (.*)$/;

export interface Diagnostic {
  file: string;
  line: number;
  col: number;
  severity: string;
  message: string;
}

export function parseDiagnostic(line: string): Diagnostic | null {
  const m = DIAG_RE.exec(line);
  return m ? { file: m[1], line: Number(m[2]), col: Number(m[3]), severity: m[4] === 'warning' ? 'warning' : 'error', message: m[5] } : null;
}

const CMAKE_ERROR_RE = /^CMake Error at (.+):(\d+) \([^)]*\):$/;

/**
 * CMake's configure errors, which carry no column and span several lines:
 *   CMake Error at CMakeLists.txt:6 (include):
 *     include could not find requested file:
 *
 *       /x/fr_gen/components.cmake
 * The indented lines (blank ones included) are the message; the next unindented line, often
 * "Call Stack (most recent call first):", ends it. Feed one stream's lines in order, then end().
 */
export class CmakeErrors {
  #open: Diagnostic | null = null;
  #parts: string[] = [];
  #onError: (d: Diagnostic) => void;

  constructor(onError: (d: Diagnostic) => void) {
    this.#onError = onError;
  }

  push(line: string): void {
    const m = CMAKE_ERROR_RE.exec(line);
    if (m) {
      this.end();
      this.#open = { file: m[1], line: Number(m[2]), col: 0, severity: 'error', message: '' };
    } else if (this.#open && /^\s+\S/.test(line)) {
      this.#parts.push(line.trim());
    } else if (this.#open && line.trim()) {
      this.end();
    }
  }

  end(): void {
    if (this.#open) {
      this.#onError({ ...this.#open, message: this.#parts.join(' ') });
    }
    this.#open = null;
    this.#parts = [];
  }
}

async function gitInfo(dir: string): Promise<{ sha: string; dirty: boolean }> {
  const sha = await run('git', ['-C', dir, 'rev-parse', 'HEAD']);
  const status = await run('git', ['-C', dir, 'status', '--porcelain']);
  return { sha: sha.code === 0 ? sha.stdout.trim() : 'unknown', dirty: status.stdout.trim().length > 0 };
}

// Process groups of running builds. A detached group no longer gets the terminal's SIGINT, so the
// hub signals them itself when it exits mid-build.
const liveGroups = new Set<number>();
let exitHooked = false;

function killGroup(pgid: number, sig: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pgid, sig);
    return true;
  } catch {
    return false; // ESRCH: nothing left in the group
  }
}

/** Waits until no process is left in the group (SIGKILL after 5 s, give up after 10 s). */
async function waitGroupGone(pgid: number): Promise<void> {
  for (let i = 0; i < 100 && killGroup(pgid, 0); i++) {
    if (i === 50) {
      killGroup(pgid, 'SIGKILL');
    }
    await sleep(100);
  }
}

/** Resolves with the exit code; 130 without spawning if the job was cancelled already. */
export function spawnLogged(
  cmd: string,
  args: string[],
  env: Record<string, string>,
  cwd: string,
  ctx: JobCtx,
  onLine: (l: string, stream: 'out' | 'err') => void,
): Promise<number> {
  return new Promise((resolve) => {
    // An 'abort' listener added after the abort never fires: a cancel during idf_env lands here.
    if (ctx.signal.aborted) {
      resolve(130);
      return;
    }
    // idf.py starts cmake and ninja in its own process group and has no signal handler, so SIGTERM to
    // idf.py alone orphans them. The build gets a group of its own and a cancel signals all of it;
    // ninja then stops its compiler jobs and removes their partial outputs.
    const child = spawn(cmd, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const pgid = child.pid;
    if (pgid) {
      liveGroups.add(pgid);
      if (!exitHooked) {
        exitHooked = true;
        process.on('exit', () => liveGroups.forEach((g) => killGroup(g, 'SIGTERM')));
      }
    }
    const abort = () => pgid && killGroup(pgid, 'SIGTERM');
    ctx.signal.addEventListener('abort', abort, { once: true });
    const pump = (stream: NodeJS.ReadableStream, name: 'out' | 'err') => {
      let buf = '';
      stream.on('data', (d: Buffer) => {
        buf += d.toString();
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = stripAnsi(buf.slice(0, i)).replace(/\r$/, '');
          buf = buf.slice(i + 1);
          ctx.log(line, name);
          onLine(line, name);
        }
      });
      stream.on('end', () => buf && (ctx.log(stripAnsi(buf), name), onLine(stripAnsi(buf), name)));
    };
    pump(child.stdout!, 'out');
    pump(child.stderr!, 'err');
    child.on('close', (code) => {
      ctx.signal.removeEventListener('abort', abort);
      // On cancel idf.py exits at once while ninja is still stopping its compilers; the build-dir
      // lock must not pass to the next build before they are gone.
      void (ctx.signal.aborted && pgid ? waitGroupGone(pgid) : Promise.resolve()).then(() => {
        if (pgid) {
          liveGroups.delete(pgid);
        }
        resolve(code ?? 1);
      });
    });
    child.on('error', () => resolve(127));
  });
}

/**
 * sdkconfig layers in contract order (spec 03 §3.7). Only sdkconfig.local is optional; a missing
 * required layer is an error rather than a build that silently lacks it.
 */
export function sdkconfigLayers(src: string, appDir: string, genDir: string, buildType: string): string[] {
  const required = [
    join(src, 'firmware', 'config', 'sdkconfig.framework'),
    join(appDir, 'sdkconfig.defaults'),
    join(genDir, 'sdkconfig.board'),
    join(src, 'firmware', 'config', `sdkconfig.build.${buildType}`),
  ];
  for (const f of required) {
    if (!existsSync(f)) {
      throw new FrError('NOT_FOUND', `sdkconfig layer missing: ${f}`);
    }
  }
  const local = join(src, 'firmware', 'config', 'sdkconfig.local');
  return existsSync(local) ? [...required, local] : required;
}

/** Staleness hash: the ordered layers plus the `<layer>.<target>` files IDF applies after each. */
export function layerHash(layers: string[], target: string): string {
  const files = layers.flatMap((f) => (existsSync(`${f}.${target}`) ? [f, `${f}.${target}`] : [f]));
  return createHash('sha256')
    .update(files.map((f) => f + '\n' + readFileSync(f, 'utf8')).join('\n---\n'))
    .digest('hex');
}

/**
 * Hash of the `fr gen firmware` output that feeds the build (design c2 §7): every file under
 * fr_gen except fr_manifest.json, which only the hub reads. Paths are sorted, so the walk order of
 * the file system does not matter.
 */
export function genHash(genDir: string): string {
  const files = readdirSync(genDir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && !(d.parentPath === genDir && d.name === 'fr_manifest.json'))
    .map((d) => join(d.parentPath, d.name))
    .sort();
  const h = createHash('sha256');
  for (const f of files) {
    h.update(`${relative(genDir, f)}\n`).update(readFileSync(f)).update('\n---\n');
  }
  return h.digest('hex');
}

/** What `fr build` reads from the `fr gen firmware --json` envelope (packages/cli/src/gen.ts). */
export interface GenFirmwareOutput {
  files: string[];
  warnings: string[];
  slots_lock: string;
  slots_lock_changed: boolean;
  manifest: { app: string; board: string; target: string };
  part_profile: string;
}

const tail = (text: string, n = 20) => text.trimEnd().split('\n').slice(-n);

/** The last stdout line as JSON (the --json envelope), or null when it is not JSON. */
function lastJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as unknown;
  } catch {
    return null;
  }
}

/**
 * Runs `fr gen firmware` from `src` itself (its CLI, its codegen, its schema), so a checkout or
 * worktree that changes the board emitter together with fr_core builds with its own generator, and
 * an edited generator needs no hub restart. Profile problems (board, drivers, pins, slots) fail the
 * build with every issue; a profile that does not exist is NOT_FOUND.
 */
export async function genFirmwareFromSource(
  src: string,
  profile: string,
  outDir: string,
  signal?: AbortSignal,
  log?: (line: string) => void,
): Promise<GenFirmwareOutput> {
  const main = join(src, 'packages', 'cli', 'src', 'main.ts');
  const cmd = `fr gen firmware --profile ${profile}`;
  if (!existsSync(main)) {
    throw new FrError('INVALID_SOURCE', `${src} has no packages/cli/src/main.ts to run ${cmd} with`, { details: { stage: 'generate' } });
  }
  const args = ['--conditions=@fractonica/source', main, '--json', 'gen', 'firmware', '--profile', profile, '--out', outDir];
  log?.(`${[process.execPath, ...args].join(' ')} (cwd ${src})`);
  const r = await run(process.execPath, args, { cwd: src, signal });
  if (signal?.aborted) {
    throw new FrError('INTERNAL', 'cancelled');
  }
  const env = lastJson(r.stdout) as { ok?: boolean; data?: Partial<GenFirmwareOutput>; error?: ToolError } | null;
  if (!env || typeof env !== 'object') {
    // No envelope: the CLI did not start (dependencies not installed, a syntax error in the checkout).
    throw new FrError('BUILD_FAILED', `${cmd} in ${src} exited ${r.code} without a result`, {
      hint: 'run `pnpm install` in that checkout if its dependencies are missing',
      details: { stage: 'generate', exit: r.code, stderr: tail(r.stderr) },
    });
  }
  if (!env.ok) {
    const e = env.error;
    if (e?.code === 'NOT_FOUND') {
      throw new FrError('NOT_FOUND', e.message, { details: e.details });
    }
    const issues = (e?.details as { issues?: string[] } | undefined)?.issues;
    if (issues?.length) {
      throw new FrError('BUILD_FAILED', `fr gen firmware: ${issues.length} problem(s) in profile ${profile}, first: ${issues[0]}`, { details: { stage: 'generate', issues } });
    }
    throw new FrError('BUILD_FAILED', `${cmd} failed: ${e?.message ?? `exit ${r.code}`}`, { details: { stage: 'generate', error: e ?? null, stderr: tail(r.stderr) } });
  }
  const d = env.data ?? {};
  if (!d.manifest?.target || !d.manifest.app || !d.part_profile || !Array.isArray(d.files) || !Array.isArray(d.warnings)) {
    throw new FrError('BUILD_FAILED', `${cmd} in ${src} did not report the manifest and part_profile fr build needs`, {
      hint: "that checkout's CLI predates this hub; update it, or build it with a hub started from it",
      details: { stage: 'generate' },
    });
  }
  return d as GenFirmwareOutput;
}

/** IDF_TARGET the build dir was configured for, or null before its first configure. */
export function cachedIdfTarget(buildDir: string): string | null {
  const cache = join(buildDir, 'CMakeCache.txt');
  if (!existsSync(cache)) {
    return null;
  }
  return /^IDF_TARGET:[A-Z]+=(.*)$/m.exec(readFileSync(cache, 'utf8'))?.[1].trim() || null;
}

export interface BuildInput {
  sourceDir: string;
  profile: string;
  buildType: 'debug' | 'release';
  app: string;
  clean: boolean;
}

export async function runBuild(db: Db, ctx: JobCtx, inp: BuildInput) {
  const t0 = Date.now();
  const src = checkSourceDir(inp.sourceDir);
  const appDir = join(src, 'firmware', 'apps', inp.app);
  const buildDir = join(appDir, 'build', `${inp.profile}-${inp.buildType}`);
  const genDir = join(buildDir, 'fr_gen');
  if (inp.clean) {
    rmSync(buildDir, { recursive: true, force: true });
  }
  // The generator resolves the profile (app, board, target) as it writes the glue.
  ctx.stage('generate');
  const cachedTarget = cachedIdfTarget(buildDir);
  const existed = existsSync(buildDir);
  const gen = await genFirmwareFromSource(src, inp.profile, genDir, ctx.signal, (line) => ctx.log(`generate: ${line}`, 'event'));
  const prof = { app: gen.manifest.app, board: gen.manifest.board, target: gen.manifest.target, partProfile: gen.part_profile };
  if (prof.app !== inp.app) {
    if (!existed) {
      rmSync(buildDir, { recursive: true, force: true }); // made only to hold the glue just written
    }
    throw new FrError('INCOMPATIBLE_PROFILE', `profile ${inp.profile} is for app ${prof.app}, not ${inp.app}`);
  }
  // idf.py refuses a build dir configured for another target ("Run idf.py set-target"); the
  // equivalent here is a full clean, keeping only the glue just generated for the new target.
  if (cachedTarget !== null && cachedTarget !== prof.target) {
    ctx.log(`build dir was configured for ${cachedTarget}, profile now targets ${prof.target}: cleaning it`, 'event');
    for (const name of readdirSync(buildDir)) {
      if (name !== 'fr_gen') {
        rmSync(join(buildDir, name), { recursive: true, force: true });
      }
    }
  }
  const warnings = [...gen.warnings, ...(gen.slots_lock_changed ? [`${gen.slots_lock}: ports allocated for new instances; commit it`] : [])];
  for (const w of warnings) {
    ctx.log(`fr gen firmware: ${w}`, 'event');
  }
  const lock = readIdfLock(src);
  const idf = await idfStatus(lock);
  ctx.stage('idf_env');
  const env = await idfEnv(idf, { targets: lock.targets });

  const layers = sdkconfigLayers(src, appDir, genDir, inp.buildType);
  const hash = createHash('sha256').update(layerHash(layers, prof.target)).update(genHash(genDir)).digest('hex');
  const hashFile = join(buildDir, 'fr_layers.sha256');
  if (!existsSync(hashFile) || readFileSync(hashFile, 'utf8') !== hash) {
    rmSync(join(buildDir, 'sdkconfig'), { force: true });
    // Recorded now, not after a good build: the next configure regenerates sdkconfig from these
    // layers even if the compile fails, so reverting a layer afterwards must count as a change.
    writeFileSync(hashFile, hash);
    ctx.log('sdkconfig layers or generated firmware changed: regenerating sdkconfig', 'event');
  }

  ctx.stage('compile');
  const diagnostics: Diagnostic[] = [];
  const addDiagnostic = (d: Diagnostic) => diagnostics.length < 50 && diagnostics.push(d);
  // A CMake error block spans lines; stdout and stderr interleave, so each stream gets a parser.
  const cmake = { out: new CmakeErrors(addDiagnostic), err: new CmakeErrors(addDiagnostic) };
  // idf.py explains missing component requirements in a 3-line block ending in "To fix this, ...".
  const hints: string[] = [];
  let hintOpen = false;
  const args = [
    '-C', appDir,
    '-B', buildDir,
    // The app CMakeLists includes ${FR_GEN_DIR}/components.cmake (fr_board + the bound drivers).
    `-DFR_GEN_DIR=${genDir}`,
    `-DIDF_TARGET=${prof.target}`,
    `-DSDKCONFIG=${join(buildDir, 'sdkconfig')}`,
    `-DSDKCONFIG_DEFAULTS=${layers.join(';')}`,
    'build',
  ];
  const code = await spawnLogged('idf.py', args, env, src, ctx, (line, stream) => {
    cmake[stream].push(line);
    const d = parseDiagnostic(line);
    if (d) {
      addDiagnostic(d);
    }
    if (/^Compilation failed because/.test(line)) {
      hintOpen = true;
      hints.push('');
    }
    if (hintOpen && hints.length <= 10) {
      hints[hints.length - 1] = `${hints[hints.length - 1]} ${line}`.trim();
      hintOpen = !/^To fix this/.test(line);
    }
    const pct = /^\[(\d+)\/(\d+)\]/.exec(line);
    if (pct) {
      ctx.progress(Math.round((100 * Number(pct[1])) / Number(pct[2])));
    }
  });
  cmake.out.end();
  cmake.err.end();
  if (ctx.signal.aborted) {
    throw new FrError('INTERNAL', 'cancelled');
  }
  if (code !== 0) {
    throw new FrError('BUILD_FAILED', `idf.py build failed (exit ${code})`, {
      ...(hints.length ? { hint: hints[0] } : {}),
      details: { diagnostics: diagnostics.filter((d) => d.severity === 'error').slice(0, 20), hints, build_dir: buildDir },
      remediation: [{ tool: 'job_logs', args: { job_id: ctx.jobId, errors_only: true } }],
    });
  }

  ctx.stage('ingest');
  const previous = lastFwId(db, src, inp.profile, inp.buildType);
  const git = await gitInfo(src);
  const { manifest, manifestPath } = ingestBuild(db, {
    sourceDir: src,
    buildDir,
    app: inp.app,
    profile: inp.profile,
    buildType: inp.buildType,
    board: prof.board,
    target: prof.target,
    partProfile: prof.partProfile,
    git,
    idf: { version: lock.idf.tag, commit: idf.actual_commit ?? '' },
    genDir,
  });
  const slot = manifest.partitions.find((p) => p.label === 'ota_0');
  return {
    build_id: manifest.build_id,
    fw_id: manifest.fw_id,
    cache_hit: previous === manifest.fw_id,
    size: manifest.size,
    slot_pct: slot ? Math.round((1000 * manifest.size) / slot.size) / 10 : null,
    target: prof.target,
    board: prof.board,
    source_dir: src,
    git,
    manifest: manifestPath,
    duration_ms: Date.now() - t0,
    diagnostics,
    warnings,
  };
}
