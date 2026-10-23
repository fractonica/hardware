// `fr codegen client` (design c6 §4, D11, D16; spec 09 §9.4-9.5, 07 §7.9): client_generate's files written
// under --out (default ./fractonica, relative to the cwd: the hub needs no checkout). token.ts is written
// with mode 0600 and never printed, not even with --json, which lists what was written instead of the
// secret's content. Hand-written so the token never reaches stdout; main.ts generates no command for it.
// A .gitignore already in --out (`--out .`, `--out src`) is merged into, never replaced: its own rules stay.

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { Command } from 'commander';

import { type GeneratedFile, type OpName, REGISTRY_HASH, type Result } from '@fractonica/protocol';

import { hubCall, hubHealth } from './client.ts';
import type { CliKit } from './kit.ts';

/** The ops whose commands are written here: main.ts generates none for them. */
export const CODEGEN_CLIENT_OPS: readonly OpName[] = ['client_generate'];

const OP = 'client_generate';

interface ClientGenerated {
  files: GeneratedFile[];
  registry_rev: string;
  catalog_hash: number;
  devices: number;
  warnings: string[];
}

/** A file name the hub may ask for: one path segment, no dot-dot, nothing hidden but .gitignore. */
function safeName(p: unknown): p is string {
  return typeof p === 'string' && /^[A-Za-z0-9_.-]+$/.test(p) && p !== '.' && p !== '..' && (!p.startsWith('.') || p === '.gitignore');
}

/** The answer's data, or why it is not one this command can write. */
function generated(data: unknown): ClientGenerated | string {
  const d = data as Partial<ClientGenerated> | null;
  if (!d || !Array.isArray(d.files) || typeof d.registry_rev !== 'string') {
    return 'the hub answered client_generate without files (an older hub? fr hub restart)';
  }
  for (const f of d.files as unknown[]) {
    const g = f as Partial<GeneratedFile> | null;
    if (!g || !safeName(g.path) || typeof g.content !== 'string') {
      return `the hub answered client_generate with a file this command will not write: ${JSON.stringify((g as { path?: unknown } | null)?.path)}`;
    }
  }
  return { warnings: [], devices: 0, catalog_hash: 0, ...d } as ClientGenerated;
}

/** An existing .gitignore merged into: lines added, or nothing to add. */
export type MergeStatus = 'updated' | 'unchanged';

export interface WrittenFile {
  path: string;
  written: string;
  /** The file's size afterwards. */
  bytes: number;
  /** Set when the file existed and was merged into (.gitignore) rather than written whole. */
  merged?: MergeStatus;
  secret?: true;
}

/** Whether a .gitignore line ignores `name` in its own directory as written (comments and globs are not read). */
function ignores(line: string, name: string): boolean {
  const l = line.trim();
  return l === name || l === `/${name}` || l === `**/${name}`;
}

/**
 * Merges the generated .gitignore's lines into the one at `abs`: each line it lacks is appended (after a
 * newline when the file does not end with one); the user's own rules stay as they are.
 */
function mergeGitignore(abs: string, content: string): MergeStatus {
  const have = readFileSync(abs, 'utf8');
  const lines = have.split(/\r?\n/);
  const missing = content.split('\n').filter((l) => l.trim() && !lines.some((h) => ignores(h, l.trim())));
  if (!missing.length) {
    return 'unchanged';
  }
  appendFileSync(abs, `${have && !have.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
  return 'updated';
}

/**
 * Writes the files under `out`: secret ones 0600, also when the file already existed with another mode (it
 * is narrowed before the new content goes in, so the token is never readable by others, not even briefly);
 * an existing .gitignore gets the generated lines it lacks.
 */
export function writeClientFiles(out: string, files: readonly GeneratedFile[]): WrittenFile[] {
  mkdirSync(out, { recursive: true });
  return files.map((f) => {
    const abs = join(out, f.path);
    let merged: MergeStatus | undefined;
    if (f.secret) {
      if (existsSync(abs)) {
        chmodSync(abs, 0o600);
      }
      writeFileSync(abs, f.content, { mode: 0o600 });
      chmodSync(abs, 0o600);
    } else if (f.path === '.gitignore' && existsSync(abs)) {
      merged = mergeGitignore(abs, f.content);
    } else {
      writeFileSync(abs, f.content);
    }
    const bytes = merged ? readFileSync(abs).length : Buffer.byteLength(f.content);
    return { path: f.path, written: abs, bytes, ...(merged ? { merged } : {}), ...(f.secret ? { secret: true as const } : {}) };
  });
}

/** The human line for one written file. */
function writtenLine(w: WrittenFile, g: ClientGenerated): string {
  if (w.path === 'devices.ts') {
    return `wrote ${w.written} (${g.devices} device${g.devices === 1 ? '' : 's'}, registry_rev ${g.registry_rev})`;
  }
  if (w.merged === 'updated') {
    return `updated ${w.written} (added token.ts; its other rules kept)`;
  }
  if (w.merged === 'unchanged') {
    return `kept ${w.written} (it already ignores token.ts)`;
  }
  return `wrote ${w.written}${w.secret ? ' (secret, mode 0600, git-ignored)' : ''}`;
}

export function addCodegenClientCommand(codegen: Command, kit: CliKit): void {
  codegen
    .command('client')
    .description("Write an app's typed device registry for @fractonica/sdk (devices.ts; token.ts 0600, git-ignored) into --out")
    .option('--out <dir>', 'output directory, e.g. web/demo/src/fractonica', 'fractonica')
    .option('--selector <sel>', 'devices to include (default: every provisioned device)')
    .option('--no-token', 'do not write token.ts')
    .action(async (opts: { out: string; selector?: string; token: boolean }) => {
      const health = await hubHealth();
      if (!health) {
        return kit.fail('HUB_UNREACHABLE', 'the hub is not running', OP, [{ cli: 'fr hub start' }]);
      }
      if (health.registry_hash !== REGISTRY_HASH) {
        return kit.fail('HUB_VERSION_MISMATCH', `hub registry ${health.registry_hash} != CLI ${REGISTRY_HASH}`, OP, [{ cli: 'fr hub restart' }]);
      }
      const r = await hubCall(OP, { ...(opts.selector ? { selector: opts.selector } : {}), token: opts.token }, 30_000);
      if (!r.ok) {
        return kit.emit(r, OP);
      }
      const g = generated(r.data);
      if (typeof g === 'string') {
        return kit.fail('INTERNAL', g, OP);
      }
      const out = resolve(opts.out);
      let written: WrittenFile[];
      try {
        written = writeClientFiles(out, g.files);
      } catch (e) {
        return kit.fail('INVALID_ARGS', `cannot write ${out}: ${(e as Error).message}`, OP);
      }
      // What was written, never the secret's content (D11).
      const data = {
        out,
        files: written.map((w) => {
          const f = g.files.find((x) => x.path === w.path)!;
          return { ...w, ...(f.secret ? {} : { content: f.content }) };
        }),
        registry_rev: g.registry_rev,
        catalog_hash: g.catalog_hash,
        devices: g.devices,
        warnings: g.warnings,
      };
      if (kit.json()) {
        const res: Result = { ok: true, data, cursor: r.cursor };
        return kit.exit(0, JSON.stringify(res) + '\n');
      }
      const lines = written.map((w) => writtenLine(w, g));
      const warnings = g.warnings.map((w) => `warning: ${w}`);
      return kit.exit(0, lines.join('\n') + '\n', warnings.length ? warnings.join('\n') + '\n' : '');
    });
}
