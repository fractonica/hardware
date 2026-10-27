// Content-addressed artifact store and build manifests (spec 06 §6.8). Builds come in through ingestBuild (an IDF
// build directory); from M2-C2 (design m2-c2 D9) an app image made elsewhere (fr_fleet --make-image for the T2 runs,
// a host test's) through registerImage.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { paths } from '@fractonica/host';
import {
  type AppDesc,
  type ArtifactManifest,
  ArtifactManifestSchema,
  type FaultKind,
  FrError,
  type ManifestCap,
  ManifestCapSchema,
} from '@fractonica/protocol';
import { z } from 'zod';

import { type Db, kvGet, kvSet } from './db.ts';
import { chipName } from './registry/store.ts';

const IMAGE_MAGIC = 0xe9;
const APP_DESC_OFFSET = 32;          // esp_app_desc_t follows the 24 B image header and 8 B segment header
const APP_DESC_MAGIC = 0xabcd5432;

/**
 * fr_app_desc_t (firmware/components/fr_core/include/fr/app_desc.h; spec 06 §6.8, design c4 §2): IDF links
 * `.rodata_custom_desc` right after esp_app_desc_t, so it starts at 24 + 8 + 256 = 288 and ends at 400.
 */
export const FR_APP_DESC_OFFSET = 288;
export const FR_APP_DESC_SIZE = 112;
const FR_APP_DESC_MAGIC = 0x46524144; // "FRAD"
const FR_APP_DESC_VERSION = 1;
/** fr_app_desc.fault byte per fault build kind (0: none). */
const FAULT_BYTE: Record<FaultKind, number> = { health: 1 };

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
  /** The image's fr_app_desc; null when there is none at offset 288 (a pre-C4 or foreign image). */
  app_desc: AppDesc | null;
}

/**
 * fr_app_desc at image offset 288 (layout: magic u32, version u8, proto major/minor u8, reserved u8,
 * catalog_hash u32, board[32], profile[32], part_profile[16], fault u8, reserved2[19]); null without its
 * magic. A descriptor of an unknown version is an error: its fields may mean something else.
 */
export function parseFrAppDesc(bin: Buffer): AppDesc | null {
  const at = FR_APP_DESC_OFFSET;
  if (bin.length < at + FR_APP_DESC_SIZE || bin.readUInt32LE(at) !== FR_APP_DESC_MAGIC) {
    return null;
  }
  const version = bin[at + 4];
  if (version !== FR_APP_DESC_VERSION) {
    throw new FrError('BUILD_FAILED', `fr_app_desc at image offset ${at} has version ${version}; this hub reads version ${FR_APP_DESC_VERSION}`);
  }
  return {
    board: cstr(bin, at + 12, 32),
    profile: cstr(bin, at + 44, 32),
    part_profile: cstr(bin, at + 76, 16),
    catalog_hash: bin.readUInt32LE(at + 8),
    fault: bin[at + 92],
  };
}

/** Image length through its checksum: 24 B header, the segments, then padding so the checksum byte ends a 16 B block. */
function imageLen(bin: Buffer): number {
  let off = 24;
  for (let i = 0; i < bin[1]; i++) {
    if (off + 8 > bin.length) {
      throw new FrError('BUILD_FAILED', 'app binary is truncated');
    }
    off += 8 + bin.readUInt32LE(off + 4);
  }
  const len = (off + 16) & ~15;
  if (len > bin.length) {
    throw new FrError('BUILD_FAILED', 'app binary is truncated');
  }
  return len;
}

/** Parses an ESP app image: header, esp_app_desc_t and the appended SHA-256 (fw_id). */
export function parseAppImage(bin: Buffer): AppImageInfo {
  if (bin[0] !== IMAGE_MAGIC) {
    throw new FrError('BUILD_FAILED', 'app binary has no ESP image magic');
  }
  if (bin.readUInt32LE(APP_DESC_OFFSET) !== APP_DESC_MAGIC) {
    throw new FrError('BUILD_FAILED', 'app binary has no esp_app_desc_t');
  }
  // fw_id is what esp_partition_get_sha256() reports: the digest right after the walked image. In a
  // signed image (L1, spec 06 §6.9) a signature block follows it, so it is not the file's last 32 B.
  const len = imageLen(bin);
  let fw_id: string;
  if (bin[23] !== 1) {
    fw_id = sha256(bin.subarray(0, len));
  } else {
    const digest = bin.subarray(len, len + 32).toString('hex');
    const tail = bin.subarray(bin.length - 32).toString('hex');
    if (sha256(bin.subarray(0, len)) === digest) {
      fw_id = digest;
    } else if (sha256(bin.subarray(0, bin.length - 32)) === tail) {
      fw_id = tail; // unsigned layout, digest last
    } else {
      throw new FrError('BUILD_FAILED', 'app image digest does not match its contents');
    }
  }
  return {
    chip_id: bin.readUInt16LE(12),
    fw_id,
    version: cstr(bin, APP_DESC_OFFSET + 16, 32),
    project_name: cstr(bin, APP_DESC_OFFSET + 48, 32),
    idf_ver: cstr(bin, APP_DESC_OFFSET + 112, 32),
    elf_sha256: bin.subarray(APP_DESC_OFFSET + 144, APP_DESC_OFFSET + 176).toString('hex'),
    app_desc: parseFrAppDesc(bin),
  };
}

/** What the image's fr_app_desc must say for the build that produced it. */
export interface AppDescExpected {
  board: string;
  profile: string;
  partProfile: string;
  /** fr_manifest.json's catalog_hash; undefined: not checked (a build without one). */
  catalogHash?: number;
  fault?: FaultKind;
}

/**
 * The ingest check of design c4 §2: the image carries fr_app_desc at offset 288 and it names the board,
 * profile, partition profile, catalog and fault kind the hub built. A miss means the link layout moved
 * (IDF changed `.flash.appdesc`, or another `.rodata_custom_desc` came first), or a layer the build
 * asked for did not take effect (sdkconfig.fault without fr_ota's Kconfig): the image must not be
 * offered to nodes, whose OTA CHECK reads the same bytes.
 */
export function checkAppDesc(desc: AppDesc | null, want: AppDescExpected): AppDesc {
  if (!desc) {
    throw new FrError('BUILD_FAILED', `the app image has no fr_app_desc at offset ${FR_APP_DESC_OFFSET} (magic FRAD)`, {
      hint: 'fr_core defines it in section .rodata_custom_desc and links it with -u fr_app_desc; check that fr_core is in the build and nothing else uses that section',
      details: { stage: 'ingest', offset: FR_APP_DESC_OFFSET },
    });
  }
  const expected: Partial<AppDesc> = {
    board: want.board,
    profile: want.profile,
    part_profile: want.partProfile,
    fault: want.fault ? FAULT_BYTE[want.fault] : 0,
    ...(want.catalogHash !== undefined ? { catalog_hash: want.catalogHash } : {}),
  };
  const differ = (Object.keys(expected) as (keyof AppDesc)[]).filter((k) => expected[k] !== desc[k]);
  if (differ.length) {
    throw new FrError('BUILD_FAILED', `fr_app_desc disagrees with the build: ${differ.map((k) => `${k} ${JSON.stringify(desc[k])} != ${JSON.stringify(expected[k])}`).join(', ')}`, {
      ...(differ.includes('fault') ? { hint: 'sdkconfig.fault did not take effect: CONFIG_FR_TEST_FAULT_HEALTH needs fr_ota in the build and CONFIG_FR_TEST_HOOKS' } : {}),
      ...(differ.includes('catalog_hash') ? { hint: 'the firmware was compiled against other generated capability code: run `fr gen`' } : {}),
      details: { stage: 'ingest', offset: FR_APP_DESC_OFFSET, app_desc: desc, expected },
    });
  }
  return desc;
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

export function storeBlob(file: string): { ref: string; size: number; sha: string } {
  return storeBytes(readFileSync(file));
}

/** storeBlob for bytes in memory. */
export function storeBytes(buf: Buffer): { ref: string; size: number; sha: string } {
  const sha = sha256(buf);
  const dest = blobPath(sha);
  // Only presence is checked on later ingests, so a blob is written under a temp name and renamed:
  // a kill or a full disk never leaves a truncated file under the hash. A short one is rewritten.
  if (!existsSync(dest) || statSync(dest).size !== buf.length) {
    mkdirSync(dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp-${process.pid}`;
    try {
      writeFileSync(tmp, buf, { flush: true });
      renameSync(tmp, dest);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
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

interface ProjectDescription {
  app_elf: string;
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
  /** `fr gen firmware` output dir; its fr_manifest.json gives the manifest `caps` and `catalog_hash`. */
  genDir?: string;
  /** A fault build (spec 03 §3.8): build_id `<app>/<profile>/<build_type>-fault/<fw>`, manifest `fault`. */
  fault?: FaultKind;
}

/** The parts of fr_manifest.json (fractonica/fr-manifest@1, written by `fr gen firmware`) the artifact keeps. */
const FrManifestSchema = z.looseObject({
  schema: z.literal('fractonica/fr-manifest@1'),
  caps: z.array(ManifestCapSchema),
  catalog_hash: z.number().int().min(0).max(0xffffffff),
  test_pin: ArtifactManifestSchema.shape.test_pin,
});

/** The caps, catalog_hash and test_pin of a generated fr_manifest.json; null when the build has none. */
export function readFrManifest(genDir: string): { caps: ManifestCap[]; catalog_hash: number; test_pin?: number | null } | null {
  const file = join(genDir, 'fr_manifest.json');
  if (!existsSync(file)) {
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new FrError('BUILD_FAILED', `${file} is not valid JSON: ${(e as Error).message}`);
  }
  const parsed = FrManifestSchema.safeParse(json);
  if (!parsed.success) {
    throw new FrError('BUILD_FAILED', `${file} does not match fractonica/fr-manifest@1: ${z.prettifyError(parsed.error)}`);
  }
  const { caps, catalog_hash, test_pin } = parsed.data;
  return { caps, catalog_hash, ...(test_pin !== undefined ? { test_pin } : {}) };
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
  // The ELF and map are stored too: the build dir is reused per profile, and crash decoding needs
  // the ELF of whatever fw_id a device still runs (spec 06 §6.6, §6.8).
  const desc = JSON.parse(readFileSync(join(inp.buildDir, 'project_description.json'), 'utf8')) as ProjectDescription;
  const elfFile = join(inp.buildDir, desc.app_elf);
  const elf = storeBlob(elfFile);
  if (elf.sha !== image.elf_sha256) {
    throw new FrError('BUILD_FAILED', `${desc.app_elf} is not the ELF the app image was made from (elf_sha256 differs)`);
  }
  const mapFile = elfFile.replace(/\.elf$/, '.map');
  const map = existsSync(mapFile) ? storeBlob(mapFile) : null;
  const debug = { elf: { blob: elf.ref, size: elf.size }, ...(map ? { map: { blob: map.ref, size: map.size } } : {}) };
  const fr = inp.genDir ? readFrManifest(inp.genDir) : null;
  const appDesc = checkAppDesc(image.app_desc, {
    board: inp.board,
    profile: inp.profile,
    partProfile: inp.partProfile,
    catalogHash: fr?.catalog_hash,
    fault: inp.fault,
  });
  const fwShort = image.fw_id.slice(0, 12);
  const variant = buildVariant(inp.buildType, inp.fault);
  const build_id = `${inp.app}/${inp.profile}/${variant}/${fwShort}`;
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
    version: versionLabel(image.version, inp.git.dirty, image.fw_id),
    source_dir: inp.sourceDir,
    git: inp.git,
    idf: inp.idf,
    fw_id: image.fw_id,
    elf_sha256: image.elf_sha256,
    size: appBin.length,
    built_at: new Date().toISOString(),
    flash: { mode: flasher.flash_settings.flash_mode, freq: flasher.flash_settings.flash_freq, size: flasher.flash_settings.flash_size, files },
    partitions: parsePartitionTable(ptable),
    ...(fr ? { caps: fr.caps, catalog_hash: fr.catalog_hash } : {}),
    ...(fr?.test_pin !== undefined ? { test_pin: fr.test_pin } : {}),
    app_desc: appDesc,
    ...(inp.fault ? { fault: inp.fault } : {}),
    debug,
  });
  const manifestPath = join(paths.artifacts(), 'builds', build_id, 'manifest.json');
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  // Two clean checkouts of one commit build the same image (reproducible builds), hence the same
  // build_id: the row follows the latest manifest, and cache_hit is tracked per source_dir in kv.
  db.prepare(
    'INSERT INTO artifacts (build_id, source_dir, profile, build_type, fw_id, built_at, manifest_path, fault) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(build_id) DO UPDATE SET source_dir = excluded.source_dir, built_at = excluded.built_at, manifest_path = excluded.manifest_path, fault = excluded.fault',
  ).run(build_id, inp.sourceDir, inp.profile, inp.buildType, image.fw_id, manifest.built_at, manifestPath, inp.fault ?? null);
  kvSet(db, lastFwKey(inp.sourceDir, inp.profile, variant), image.fw_id);
  return { manifest, manifestPath };
}

/** registerImage's input (design m2-c2 D9). */
export interface RegisterImageInput {
  /** An ESP app image: fw_id, chip id, version and fr_app_desc are read from it (parseAppImage). */
  image: Buffer;
  /** Not an ESP image (a host test's random bytes): its fw_id is its sha256, and nothing is parsed. */
  raw?: boolean;
  profile: string;
  buildType: 'debug' | 'release';
  fault?: FaultKind;
  /**
   * Manifest fields the image does not decide. Defaults: app `node`; board and part_profile from its fr_app_desc
   * (else fr_net_node's esp32c6-supermini, fr-4mb-v1); target from its chip id; version from its esp_app_desc_t;
   * built_at now; no source dir, git or IDF.
   */
  manifest?: Partial<Pick<ArtifactManifest, 'app' | 'board' | 'target' | 'chip_id' | 'part_profile' | 'version' | 'source_dir' | 'git' | 'idf' | 'elf_sha256' | 'built_at'>>;
  /** Where the manifest goes; default builds/<build_id>/manifest.json in the store, as ingestBuild writes it. */
  manifestPath?: string;
}

/**
 * Puts an app image that no IDF build made (ingestBuild needs a build directory) into the artifact store, as the
 * private hub of a T2 run needs before it starts (design m2-c2 D9): the image as one blob (`app` at 0x10000), its
 * manifest under builds/<build_id>/, and the artifacts row with its build type and fault, so ota_deploy and
 * deploy's --no-build path can name it. FR_HOME decides which store: a private hub's temp home for the sim runner.
 */
export function registerImage(db: Db, inp: RegisterImageInput): { buildId: string; fw_id: string; manifest: ArtifactManifest; manifestPath: string } {
  const parsed = inp.raw ? null : parseAppImage(inp.image);
  const blob = storeBytes(inp.image);
  const fw_id = parsed?.fw_id ?? blob.sha;
  const o = inp.manifest ?? {};
  const app = o.app ?? 'node';
  const buildId = `${app}/${inp.profile}/${buildVariant(inp.buildType, inp.fault)}/${fw_id.slice(0, 12)}`;
  const chipId = o.chip_id ?? parsed?.chip_id ?? 13;
  const manifest: ArtifactManifest = ArtifactManifestSchema.parse({
    schema: 'fractonica.artifact/1',
    build_id: buildId,
    app,
    profile: inp.profile,
    build_type: inp.buildType,
    board: o.board ?? parsed?.app_desc?.board ?? 'esp32c6-supermini',
    target: o.target ?? chipName(chipId) ?? 'esp32c6',
    chip_id: chipId,
    part_profile: o.part_profile ?? parsed?.app_desc?.part_profile ?? 'fr-4mb-v1',
    version: o.version ?? parsed?.version ?? fw_id.slice(0, 12),
    source_dir: o.source_dir ?? '',
    git: o.git ?? { sha: '', dirty: false },
    idf: o.idf ?? { version: parsed?.idf_ver ?? '', commit: '' },
    fw_id,
    elf_sha256: o.elf_sha256 ?? parsed?.elf_sha256 ?? '',
    size: inp.image.length,
    built_at: o.built_at ?? new Date().toISOString(),
    flash: { mode: 'dio', freq: '80m', size: '4MB', files: [{ offset: '0x10000', role: 'app', blob: blob.ref, size: blob.size }] },
    partitions: [],
    ...(inp.fault ? { fault: inp.fault } : {}),
    ...(parsed?.app_desc ? { app_desc: parsed.app_desc } : {}),
  });
  const manifestPath = inp.manifestPath ?? join(paths.artifacts(), 'builds', buildId, 'manifest.json');
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  // As ingestBuild: registering the same image again (a re-run into the same FR_HOME) replaces its row.
  db.prepare(
    'INSERT INTO artifacts (build_id, source_dir, profile, build_type, fw_id, built_at, manifest_path, fault) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(build_id) DO UPDATE SET source_dir = excluded.source_dir, built_at = excluded.built_at, manifest_path = excluded.manifest_path, fault = excluded.fault',
  ).run(
    buildId,
    manifest.source_dir,
    inp.profile,
    inp.buildType,
    fw_id,
    manifest.built_at,
    manifestPath,
    inp.fault ?? null,
  );
  return { buildId, fw_id, manifest, manifestPath };
}

/**
 * The manifest's display version (spec 06 §6.8): the image's own, which IDF takes from `git describe
 * --always --tags --dirty` when the build configures (`<sha>` or `<sha>-dirty`), with the tree's state at
 * ingest deciding `-dirty` (a reconfigure is not forced by edits alone). A dirty tree's label adds the
 * image, `<sha>-dirty.<fw_id[0:8]>`, as two dirty builds of one commit differ.
 */
export function versionLabel(imageVersion: string, dirty: boolean, fwId: string): string {
  const base = imageVersion.replace(/-dirty$/, '');
  return dirty ? `${base}-dirty.${fwId.slice(0, 8)}` : base;
}

/** The build_id part and build dir suffix of a build: `debug`, `release`, or `debug-fault` (spec 03 §3.8). */
export function buildVariant(buildType: string, fault?: FaultKind | null): string {
  return fault ? `${buildType}-fault` : buildType;
}

function lastFwKey(sourceDir: string, profile: string, variant: string): string {
  return `last_fw_id:${JSON.stringify([sourceDir, profile, variant])}`;
}

export function loadManifest(db: Db, buildId: string): ArtifactManifest {
  const row = db.prepare('SELECT manifest_path FROM artifacts WHERE build_id = ?').get(buildId) as { manifest_path: string } | undefined;
  if (!row || !existsSync(row.manifest_path)) {
    throw new FrError('NOT_FOUND', `no artifact ${buildId}`, { remediation: [{ tool: 'artifact_list', cli: 'fr artifacts ls' }] });
  }
  return ArtifactManifestSchema.parse(JSON.parse(readFileSync(row.manifest_path, 'utf8')));
}

/**
 * Caps of the newest artifact whose fw_id starts with `prefix` (a device's boot banner prints the
 * first 6 bytes); null when no such artifact or it predates fr_manifest caps.
 */
export function manifestCapsByFwPrefix(db: Db, prefix: string): ManifestCap[] | null {
  const row = db
    .prepare('SELECT manifest_path FROM artifacts WHERE substr(fw_id, 1, ?) = ? ORDER BY built_at DESC LIMIT 1')
    .get(prefix.length, prefix.toLowerCase()) as { manifest_path: string } | undefined;
  if (!row || !existsSync(row.manifest_path)) {
    return null;
  }
  return ArtifactManifestSchema.parse(JSON.parse(readFileSync(row.manifest_path, 'utf8'))).caps ?? null;
}

/**
 * Newest artifact of (app, profile, build_type); build_id is `<app>/<profile>/<build_type>/<fw>`. Never a
 * fault build: flash, provision, ota and deploy pick one only when it is named (spec 03 §3.8).
 */
/** The newest build of (app, profile, build type), never a fault build; of any app when `app` is not given. */
export function newestBuildId(db: Db, q: { app?: string; profile: string; buildType: string }): string | null {
  const row = (
    q.app === undefined
      ? db.prepare('SELECT build_id FROM artifacts WHERE profile = ? AND build_type = ? AND fault IS NULL ORDER BY built_at DESC LIMIT 1').get(q.profile, q.buildType)
      : db
          .prepare(
            'SELECT build_id FROM artifacts WHERE profile = ? AND build_type = ? AND fault IS NULL AND substr(build_id, 1, ?) = ? ORDER BY built_at DESC LIMIT 1',
          )
          .get(q.profile, q.buildType, q.app.length + 1, `${q.app}/`)
  ) as { build_id: string } | undefined;
  return row?.build_id ?? null;
}

/** fw_id of the last build of (source_dir, profile, build_type[, fault]), for cache_hit (spec 03 §3.8). */
export function lastFwId(db: Db, sourceDir: string, profile: string, buildType: string, fault?: FaultKind): string | null {
  const known = kvGet(db, lastFwKey(sourceDir, profile, buildVariant(buildType, fault)));
  if (known) {
    return known;
  }
  // Builds ingested before the kv entry existed.
  const row = db
    .prepare('SELECT fw_id FROM artifacts WHERE source_dir = ? AND profile = ? AND build_type = ? AND fault IS ? ORDER BY built_at DESC LIMIT 1')
    .get(sourceDir, profile, buildType, fault ?? null) as { fw_id: string } | undefined;
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
    .prepare(`SELECT build_id, profile, build_type, fault, fw_id, built_at, source_dir FROM artifacts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY built_at DESC LIMIT ?`)
    .all(...args, opts.limit);
}
