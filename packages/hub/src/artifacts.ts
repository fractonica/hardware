// Content-addressed artifact store and build manifests (spec 06 §6.8).

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { paths } from '@fractonica/host';
import { type ArtifactManifest, ArtifactManifestSchema, FrError } from '@fractonica/protocol';

import type { Db } from './db.ts';

const IMAGE_MAGIC = 0xe9;
const APP_DESC_OFFSET = 32;          // esp_app_desc_t follows the 24 B image header and 8 B segment header
const APP_DESC_MAGIC = 0xabcd5432;

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function cstr(buf: Buffer, offset: number, len: number): string {
  const s = buf.subarray(offset, offset + len);
  const end = s.indexOf(0);
  return s.subarray(0, end < 0 ? len : end).toString('utf8');
}

export interface AppImageInfo {
  chip_id: number;
  fw_id: string;
  version: string;
  project_name: string;
  idf_ver: string;
  elf_sha256: string;
}

/** Parses an ESP app image: header, esp_app_desc_t and the appended SHA-256 (fw_id). */
export function parseAppImage(bin: Buffer): AppImageInfo {
  if (bin[0] !== IMAGE_MAGIC) {
    throw new FrError('BUILD_FAILED', 'app binary has no ESP image magic');
  }
  if (bin.readUInt32LE(APP_DESC_OFFSET) !== APP_DESC_MAGIC) {
    throw new FrError('BUILD_FAILED', 'app binary has no esp_app_desc_t');
  }
  const hashAppended = bin[23] === 1;
  const tail = bin.subarray(bin.length - 32);
  const fw_id = hashAppended && sha256(bin.subarray(0, bin.length - 32)) === tail.toString('hex') ? tail.toString('hex') : sha256(bin);
  return {
    chip_id: bin.readUInt16LE(12),
    fw_id,
    version: cstr(bin, APP_DESC_OFFSET + 16, 32),
    project_name: cstr(bin, APP_DESC_OFFSET + 48, 32),
    idf_ver: cstr(bin, APP_DESC_OFFSET + 112, 32),
    elf_sha256: bin.subarray(APP_DESC_OFFSET + 144, APP_DESC_OFFSET + 176).toString('hex'),
  };
}

export interface Partition {
  label: string;
  type: number;
  subtype: number;
  offset: number;
  size: number;
  readonly: boolean;
}

/** Parses a binary partition table (32-byte entries, magic 0x50AA). */
export function parsePartitionTable(bin: Buffer): Partition[] {
  const out: Partition[] = [];
  for (let off = 0; off + 32 <= bin.length; off += 32) {
    if (bin.readUInt16LE(off) !== 0x50aa) {
      break;
    }
    const flags = bin.readUInt32LE(off + 28);
    out.push({
      type: bin[off + 2],
      subtype: bin[off + 3],
      offset: bin.readUInt32LE(off + 4),
      size: bin.readUInt32LE(off + 8),
      label: cstr(bin, off + 12, 16),
      readonly: (flags & 0x2) !== 0,
    });
  }
  return out;
}

export function blobPath(ref: string): string {
  const hash = ref.replace(/^sha256:/, '');
  return join(paths.artifacts(), 'blobs', 'sha256', hash.slice(0, 2), hash);
}

function storeBlob(file: string): { ref: string; size: number; sha: string } {
  const buf = readFileSync(file);
  const sha = sha256(buf);
  const dest = blobPath(sha);
  if (!existsSync(dest)) {
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(file, dest);
  }
  return { ref: `sha256:${sha}`, size: buf.length, sha };
}

interface FlasherArgs {
  flash_settings: { flash_mode: string; flash_size: string; flash_freq: string };
  bootloader?: { offset: string; file: string };
  app?: { offset: string; file: string };
  'partition-table'?: { offset: string; file: string };
  otadata?: { offset: string; file: string };
}

export interface IngestInput {
  sourceDir: string;
  buildDir: string;
  app: string;
  profile: string;
  buildType: 'debug' | 'release';
  board: string;
  target: string;
  partProfile: string;
  git: { sha: string; dirty: boolean };
  idf: { version: string; commit: string };
}

export function ingestBuild(db: Db, inp: IngestInput): { manifest: ArtifactManifest; manifestPath: string } {
  const flasher = JSON.parse(readFileSync(join(inp.buildDir, 'flasher_args.json'), 'utf8')) as FlasherArgs;
  const roles: Array<[string, { offset: string; file: string } | undefined]> = [
    ['bootloader', flasher.bootloader],
    ['partition_table', flasher['partition-table']],
    ['ota_data_initial', flasher.otadata],
    ['app', flasher.app],
  ];
  const files: ArtifactManifest['flash']['files'] = [];
  let appBin: Buffer | null = null;
  let ptable: Buffer | null = null;
  for (const [role, entry] of roles) {
    if (!entry) {
      continue;
    }
    const file = join(inp.buildDir, entry.file);
    const blob = storeBlob(file);
    files.push({ offset: entry.offset, role, blob: blob.ref, size: blob.size });
    if (role === 'app') {
      appBin = readFileSync(file);
    } else if (role === 'partition_table') {
      ptable = readFileSync(file);
    }
  }
  if (!appBin || !ptable) {
    throw new FrError('BUILD_FAILED', 'build produced no app or partition table');
  }
  const image = parseAppImage(appBin);
  const fwShort = image.fw_id.slice(0, 12);
  const build_id = `${inp.app}/${inp.profile}/${inp.buildType}/${fwShort}`;
  const manifest: ArtifactManifest = ArtifactManifestSchema.parse({
    schema: 'fractonica.artifact/1',
    build_id,
    app: inp.app,
    profile: inp.profile,
    build_type: inp.buildType,
    board: inp.board,
    target: inp.target,
    chip_id: image.chip_id,
    part_profile: inp.partProfile,
    version: inp.git.dirty ? `${image.version}.dirty.${image.fw_id.slice(0, 8)}` : image.version,
    source_dir: inp.sourceDir,
    git: inp.git,
    idf: inp.idf,
    fw_id: image.fw_id,
    elf_sha256: image.elf_sha256,
    size: appBin.length,
    built_at: new Date().toISOString(),
    flash: { mode: flasher.flash_settings.flash_mode, freq: flasher.flash_settings.flash_freq, size: flasher.flash_settings.flash_size, files },
    partitions: parsePartitionTable(ptable),
  });
  const manifestPath = join(paths.artifacts(), 'builds', build_id, 'manifest.json');
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  db.prepare(
    'INSERT INTO artifacts (build_id, source_dir, profile, build_type, fw_id, built_at, manifest_path) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(build_id) DO UPDATE SET built_at = excluded.built_at, manifest_path = excluded.manifest_path',
  ).run(build_id, inp.sourceDir, inp.profile, inp.buildType, image.fw_id, manifest.built_at, manifestPath);
  return { manifest, manifestPath };
}

export function loadManifest(db: Db, buildId: string): ArtifactManifest {
  const row = db.prepare('SELECT manifest_path FROM artifacts WHERE build_id = ?').get(buildId) as { manifest_path: string } | undefined;
  if (!row || !existsSync(row.manifest_path)) {
    throw new FrError('NOT_FOUND', `no artifact ${buildId}`, { remediation: [{ tool: 'artifact_list', cli: 'fr artifacts ls' }] });
  }
  return ArtifactManifestSchema.parse(JSON.parse(readFileSync(row.manifest_path, 'utf8')));
}

export function newestBuildId(db: Db, profile: string, buildType?: string): string | null {
  const row = db
    .prepare(`SELECT build_id FROM artifacts WHERE profile = ? ${buildType ? 'AND build_type = ?' : ''} ORDER BY built_at DESC LIMIT 1`)
    .get(...(buildType ? [profile, buildType] : [profile])) as { build_id: string } | undefined;
  return row?.build_id ?? null;
}

export function lastFwId(db: Db, sourceDir: string, profile: string, buildType: string): string | null {
  const row = db
    .prepare('SELECT fw_id FROM artifacts WHERE source_dir = ? AND profile = ? AND build_type = ? ORDER BY built_at DESC LIMIT 1')
    .get(sourceDir, profile, buildType) as { fw_id: string } | undefined;
  return row?.fw_id ?? null;
}

export function listArtifacts(db: Db, opts: { profile?: string; buildType?: string; limit: number }) {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.profile) {
    where.push('profile = ?');
    args.push(opts.profile);
  }
  if (opts.buildType) {
    where.push('build_type = ?');
    args.push(opts.buildType);
  }
  return db
    .prepare(`SELECT build_id, profile, build_type, fw_id, built_at, source_dir FROM artifacts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY built_at DESC LIMIT ?`)
    .all(...args, opts.limit);
}
