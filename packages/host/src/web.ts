// The Vite-built web packages the hub serves (design c6 D10; spec 08 §8.9-8.10): the dashboard
// (packages/dashboard, at `/`) and the hosted apps (web/<name>, at `/apps/<name>/`). The hub runs its own
// TS from source, but these are bundles, so each dist keeps `.source-hash`: the hash of the sources it was
// built from, its own and those of the workspace packages it bundles (the @fractonica/source condition
// pulls their src in, so a protocol change makes the dashboard stale too). `fr doctor --fix` builds what
// is missing or stale; the hub reports the dashboard's state in hub_status.dashboard.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import type { Check } from './doctor.ts';
import { run } from './proc.ts';

/** In a package's dist: the source hash it was built from (one hex line). */
export const SOURCE_HASH_FILE = '.source-hash';

export interface WebPackage {
  /** `dashboard`, or the app's name (web/<name>, served at /apps/<name>/). */
  name: string;
  kind: 'dashboard' | 'app';
  /** Absolute package directory. */
  dir: string;
}

/** packages/dashboard of a checkout. */
export function dashboardDir(sourceDir: string): string {
  return join(sourceDir, 'packages', 'dashboard');
}

/** web/<name> of a checkout: an app's directory, its build in dist. */
export function appDir(sourceDir: string, name: string): string {
  return join(sourceDir, 'web', name);
}

/** The dashboard (when the checkout has it), then web/<name> for every directory with a package.json, by name. */
export function webPackages(sourceDir: string): WebPackage[] {
  const out: WebPackage[] = [];
  const dash = dashboardDir(sourceDir);
  if (existsSync(join(dash, 'package.json'))) {
    out.push({ name: 'dashboard', kind: 'dashboard', dir: dash });
  }
  for (const name of subdirs(join(sourceDir, 'web'))) {
    if (existsSync(join(sourceDir, 'web', name, 'package.json'))) {
      out.push({ name, kind: 'app', dir: appDir(sourceDir, name) });
    }
  }
  return out;
}

function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** Workspace package name -> directory, for packages/* and web/*. */
function workspaceDirs(sourceDir: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const parent of ['packages', 'web']) {
    for (const name of subdirs(join(sourceDir, parent))) {
      const dir = join(sourceDir, parent, name);
      const pkg = readPackageJson(dir);
      if (pkg?.name) {
        map.set(pkg.name, dir);
      }
    }
  }
  return map;
}

interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readPackageJson(dir: string): PackageJson | null {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PackageJson;
  } catch {
    return null;
  }
}

/**
 * The package directories a web package's bundle is made from: itself, then every workspace package it
 * depends on (`workspace:` versions), transitively.
 */
export function bundledPackages(sourceDir: string, pkgDir: string): string[] {
  const dirs = workspaceDirs(sourceDir);
  const out: string[] = [];
  const visit = (dir: string) => {
    if (out.includes(dir)) {
      return;
    }
    out.push(dir);
    const pkg = readPackageJson(dir);
    for (const [name, version] of Object.entries({ ...pkg?.dependencies, ...pkg?.devDependencies })) {
      const dep = dirs.get(name);
      if (dep && version.startsWith('workspace:')) {
        visit(dep);
      }
    }
  };
  visit(pkgDir);
  return out;
}

/** A package's build inputs: these files at its root, and everything under src/ and public/. */
const ROOT_FILES = ['package.json', 'index.html', 'vite.config.ts', 'tsconfig.json'];
const TREES = ['src', 'public'];

async function treeFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { recursive: true, withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && !e.name.startsWith('.'))
    .map((e) => join(e.parentPath, e.name))
    .filter((f) => !relative(dir, f).split('/').some((part) => part === 'node_modules' || part.startsWith('.')));
}

/**
 * sha256 over the build inputs of a web package and of the workspace packages it bundles, each file as
 * its checkout-relative path and contents, in path order. Read asynchronously: the hub computes it on
 * its event loop.
 */
export async function sourceHash(sourceDir: string, pkgDir: string): Promise<string> {
  const files: string[] = [];
  for (const dir of bundledPackages(sourceDir, pkgDir)) {
    files.push(...ROOT_FILES.map((f) => join(dir, f)).filter((f) => existsSync(f)));
    for (const tree of TREES) {
      files.push(...(await treeFiles(join(dir, tree))));
    }
  }
  const rel = [...new Set(files)].map((f) => relative(sourceDir, f)).sort();
  const h = createHash('sha256');
  for (const f of rel) {
    h.update(f).update('\0').update(await readFile(join(sourceDir, f))).update('\0');
  }
  return h.digest('hex');
}

export interface DistStatus {
  /** dist/index.html exists. */
  built: boolean;
  /** Built, but not from the current sources (no .source-hash counts as not). */
  stale: boolean;
  /** The current sources' hash. */
  hash: string;
  /** The hash dist was built from, or null. */
  built_hash: string | null;
}

export async function distStatus(sourceDir: string, pkgDir: string): Promise<DistStatus> {
  const dist = join(pkgDir, 'dist');
  const built = existsSync(join(dist, 'index.html'));
  let builtHash: string | null = null;
  try {
    builtHash = readFileSync(join(dist, SOURCE_HASH_FILE), 'utf8').trim() || null;
  } catch {
    // never built by fr doctor --fix (or by hand): stale when built
  }
  const hash = await sourceHash(sourceDir, pkgDir);
  return { built, stale: built && builtHash !== hash, hash, built_hash: builtHash };
}

/**
 * `vite build` in the package with this Node (the shim's pinned one, not whatever `node` is on PATH),
 * then dist/.source-hash with the hash of the sources as they were before the build: a source edited
 * while it ran leaves dist stale, not falsely fresh.
 */
export async function buildDist(sourceDir: string, pkgDir: string): Promise<{ ok: boolean; output: string }> {
  const vite = join(pkgDir, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!existsSync(vite)) {
    return { ok: false, output: `vite is not installed in ${relative(sourceDir, pkgDir)}: run pnpm install in the checkout` };
  }
  const hash = await sourceHash(sourceDir, pkgDir);
  const r = await run(process.execPath, [vite, 'build'], { cwd: pkgDir });
  const output = (r.stdout + r.stderr).slice(-2000);
  if (r.code !== 0 || !existsSync(join(pkgDir, 'dist', 'index.html'))) {
    return { ok: false, output: output || `vite build exited with code ${r.code}` };
  }
  writeFileSync(join(pkgDir, 'dist', SOURCE_HASH_FILE), `${hash}\n`);
  return { ok: true, output };
}

/** The doctor check id of a web package: `dashboard`, `web_<name>`. */
export function webCheckId(pkg: WebPackage): string {
  return pkg.kind === 'dashboard' ? 'dashboard' : `web_${pkg.name}`;
}

/**
 * One check per web package: built from the current sources, stale or not built. With `fix`, the missing
 * and stale ones are built (`build` is injectable for tests). Both are warnings: the hub runs without
 * them and serves a "not built" page instead.
 */
export async function webChecks(sourceDir: string, opts: { fix: boolean; build?: typeof buildDist }): Promise<Check[]> {
  const build = opts.build ?? buildDist;
  const checks: Check[] = [];
  for (const pkg of webPackages(sourceDir)) {
    const id = webCheckId(pkg);
    const where = `${relative(sourceDir, pkg.dir)}/dist`;
    const st = await distStatus(sourceDir, pkg.dir);
    if (st.built && !st.stale) {
      checks.push({ id, level: 'ok', detail: `${where} built from the current sources` });
      continue;
    }
    if (opts.fix) {
      const b = await build(sourceDir, pkg.dir);
      checks.push(
        b.ok
          ? { id, level: 'ok', detail: `built ${where}`, fixed: true }
          : { id, level: 'error', detail: `vite build in ${relative(sourceDir, pkg.dir)} failed: ${b.output.trim().split('\n').slice(-5).join(' | ')}` },
      );
      continue;
    }
    checks.push({
      id,
      level: 'warn',
      detail: st.built ? `${where} is older than its sources` : `${where} missing (the hub serves a "not built" page)`,
      fix: 'fr doctor --fix',
    });
  }
  return checks;
}
