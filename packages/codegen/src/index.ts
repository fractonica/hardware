// @fractonica/codegen: `fr gen` (spec 07 §7.6, design c2 §2).

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { checkBenches } from './bench.ts';
import { emitCpp } from './emit/cpp.ts';
import { emitSdk } from './emit/sdk.ts';
import { emitTs } from './emit/ts.ts';
import { emitVectors } from './emit/vectors.ts';
import { catalogHash, loadModel, type GeneratedFile, type Model } from './model.ts';

export * from './model.ts';

// ---- emitters ----

export { emitCpp } from './emit/cpp.ts';
export { emitSdk, SDK_EVENT_KEYS, SDK_GEN_DIR, SDK_INSTANCE_KEYS, sdkCamel, sdkSnake } from './emit/sdk.ts';
export { emitTs, TS_GEN_DIR } from './emit/ts.ts';
export { emitVectors, VECTORS_DIR, type GoldenVector } from './emit/vectors.ts';
// fr gen firmware: the board composition root (packages/codegen/src/board.ts).
export * from './board.ts';
// The HIL bench check `fr gen` runs (packages/codegen/src/bench.ts, design m2-c1-hil D7).
export * from './bench.ts';

/**
 * Directories `fr gen` owns entirely (design c2 §2). A file in one of them that no emitter produced is an
 * orphan (a removed capability, a renamed message): --check reports it and a write deletes it.
 */
export const GENERATED_ROOTS: readonly string[] = [
  'packages/protocol/src/gen',
  'schema/vectors',
  'firmware/components/fr_proto/gen',
  'firmware/components/fr_caps/gen',
  'firmware/test/host/gen',
  // The SDK's typed facades (design c6 §4.1).
  'packages/sdk/src/gen',
];

export interface GenerateOptions {
  /** Checkout root: schema/ is read from it and every output is written under it. */
  sourceDir: string;
  /** Compare with the files on disk instead of writing them. */
  check?: boolean;
}

export interface GenerateResult {
  /** Every generated path (repo-relative, sorted). */
  files: string[];
  /** Paths written because they were missing or differed (none with check). */
  written: string[];
  /** Orphans deleted from GENERATED_ROOTS (none with check). */
  removed: string[];
  /** With check: missing, differing and orphaned paths. Empty when everything is current. */
  stale: string[];
  /** The bench files validated against the boards and profiles (design m2-c1-hil D7). */
  benches: string[];
  /** Non-fatal notes for the user (the CLI prints them), e.g. the bench's documented exceptions. */
  warnings: string[];
}

/** Every committed output of `fr gen` for a checkout, without touching the disk. Throws SchemaError. */
export function generateFiles(sourceDir: string, model: Model = loadModel(sourceDir)): GeneratedFile[] {
  const vectors = emitVectors(model);
  // Both suites check every case (decode-only and error cases included) and fuzz with them as corpora.
  const files = [...emitTs(model), ...emitSdk(model, catalogHash(model)), ...vectors.files, ...emitCpp(model, vectors.cases)];
  const seen = new Set<string>();
  for (const f of files) {
    if (seen.has(f.path) || f.path.startsWith('/') || f.path.split('/').includes('..')) {
      throw new Error(`emitters produced ${seen.has(f.path) ? 'a duplicate' : 'an invalid'} path: ${f.path}`);
    }
    seen.add(f.path);
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function walk(sourceDir: string, rel: string, out: string[]): void {
  const abs = join(sourceDir, rel);
  if (!existsSync(abs)) {
    return;
  }
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    // Editor and OS droppings (.DS_Store) are not ours to report or delete.
    if (e.name.startsWith('.')) {
      continue;
    }
    const p = `${rel}/${e.name}`;
    if (e.isDirectory()) {
      walk(sourceDir, p, out);
    } else {
      out.push(p);
    }
  }
}

/** Orphans: files under the roots this run generated into that no emitter produced. */
function orphans(sourceDir: string, files: readonly GeneratedFile[]): string[] {
  const generated = new Set(files.map((f) => f.path));
  const roots = GENERATED_ROOTS.filter((r) => files.some((f) => f.path.startsWith(`${r}/`)));
  const found: string[] = [];
  for (const r of roots) {
    walk(sourceDir, r, found);
  }
  return found.filter((p) => !generated.has(p)).sort();
}

/**
 * `fr gen` (design c2 §7): regenerates every committed output, writing only files whose content
 * changed and deleting orphans; with `check`, writes nothing and lists what is stale (`fr gen --check`).
 * Either way it first validates every hardware/bench/*.bench.yaml against the board manifests and profiles
 * (design m2-c1-hil D7): a bad bench throws SchemaError, as a bad schema does, and nothing is written.
 */
export function generateAll(opts: GenerateOptions): GenerateResult {
  const model = loadModel(opts.sourceDir);
  const files = generateFiles(opts.sourceDir, model);
  const bench = checkBenches(opts.sourceDir, model);
  const changed = files.filter((f) => {
    const abs = join(opts.sourceDir, f.path);
    return !existsSync(abs) || readFileSync(abs, 'utf8') !== f.content;
  });
  const extra = orphans(opts.sourceDir, files);
  const result: GenerateResult = { files: files.map((f) => f.path), written: [], removed: [], stale: [], benches: bench.benches, warnings: bench.notes };
  if (opts.check) {
    result.stale = [...changed.map((f) => f.path), ...extra].sort();
    return result;
  }
  for (const f of changed) {
    const abs = join(opts.sourceDir, f.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
    result.written.push(f.path);
  }
  for (const p of extra) {
    rmSync(join(opts.sourceDir, p));
    result.removed.push(p);
  }
  return result;
}
