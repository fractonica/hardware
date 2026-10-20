import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ArtifactManifest } from '@fractonica/protocol';

import { blobPath, ingestBuild, lastFwId, listArtifacts, loadManifest, parseAppImage, storeBlob } from '../src/artifacts.ts';
import { cachedIdfTarget, layerHash, sdkconfigLayers, spawnLogged } from '../src/build.ts';
import { openDb } from '../src/db.ts';
import type { JobCtx } from '../src/jobs.ts';

let tmp = '';
const savedHome = process.env.FR_HOME;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'fr-build-test-'));
  process.env.FR_HOME = join(tmp, 'home');
});

afterAll(() => {
  if (savedHome === undefined) {
    delete process.env.FR_HOME;
  } else {
    process.env.FR_HOME = savedHome;
  }
  rmSync(tmp, { recursive: true, force: true });
});

function sha256(buf: Buffer): Buffer {
  return createHash('sha256').update(buf).digest();
}

function dir(name: string): string {
  const d = join(tmp, name);
  mkdirSync(d, { recursive: true });
  return d;
}

/** An app image laid out like esptool's: header, segments, checksum ending a 16 B block, digest. */
function appImage(opts: { elfSha?: Buffer; signed?: boolean } = {}): Buffer {
  const desc = Buffer.alloc(256);
  desc.writeUInt32LE(0xabcd5432, 0);
  desc.write('0.1.0', 16);
  desc.write('fr_node', 48);
  desc.write('v6.1', 112);
  (opts.elfSha ?? Buffer.alloc(32)).copy(desc, 144);
  const header = Buffer.alloc(24);
  header[0] = 0xe9;
  header[1] = 2;
  header.writeUInt16LE(13, 12); // ESP32-C6
  header[23] = 1;
  const segments = [desc, Buffer.alloc(37, 0x5a)].flatMap((data) => {
    const h = Buffer.alloc(8);
    h.writeUInt32LE(0x42000020, 0);
    h.writeUInt32LE(data.length, 4);
    return [h, data];
  });
  let body = Buffer.concat([header, ...segments]);
  body = Buffer.concat([body, Buffer.alloc(15 - (body.length % 16)), Buffer.from([0xef])]);
  const img = Buffer.concat([body, sha256(body)]);
  if (!opts.signed) {
    return img;
  }
  // Signed (L1): 0xFF up to a 4 KB boundary, then a signature sector.
  const pad = Buffer.alloc(4096 - (img.length % 4096), 0xff);
  const sig = Buffer.alloc(4096, 0xff);
  sig[0] = 0xe7;
  sig.fill(0x11, 1, 1216);
  return Buffer.concat([img, pad, sig]);
}

describe('parseAppImage fw_id', () => {
  it('takes the digest after the walked image for an unsigned image', () => {
    const img = appImage();
    expect(parseAppImage(img).fw_id).toBe(img.subarray(img.length - 32).toString('hex'));
  });

  it('takes the digest after the walked image, not the last 32 B, for a signed image', () => {
    const img = appImage({ signed: true });
    const unsigned = appImage();
    const info = parseAppImage(img);
    expect(info.fw_id).toBe(unsigned.subarray(unsigned.length - 32).toString('hex'));
    expect(info.fw_id).not.toBe(sha256(img).toString('hex'));
    expect(info.project_name).toBe('fr_node');
  });

  it('rejects an image whose digest does not match', () => {
    const img = appImage();
    img[100] ^= 0xff;
    expect(() => parseAppImage(img)).toThrow(/digest/);
  });

  it('rejects a truncated image', () => {
    const img = appImage();
    expect(() => parseAppImage(img.subarray(0, 200))).toThrow(/truncated/);
  });
});

describe('storeBlob', () => {
  it('stores content-addressed and rewrites a truncated blob', () => {
    const file = join(dir('blob'), 'x.bin');
    writeFileSync(file, Buffer.alloc(1000, 7));
    const first = storeBlob(file);
    const dest = blobPath(first.ref);
    expect(statSync(dest).size).toBe(1000);
    truncateSync(dest, 10);
    expect(storeBlob(file).ref).toBe(first.ref);
    expect(readFileSync(dest)).toEqual(Buffer.alloc(1000, 7));
  });
});

describe('ingestBuild', () => {
  function fakeBuild(name: string, opts: { elf?: Buffer; map?: boolean } = {}): string {
    const b = dir(name);
    const elf = Buffer.from('\x7fELF fake fr_node');
    writeFileSync(join(b, 'fr_node.elf'), opts.elf ?? elf);
    if (opts.map !== false) {
      writeFileSync(join(b, 'fr_node.map'), 'Memory Configuration\n');
    }
    writeFileSync(join(b, 'fr_node.bin'), appImage({ elfSha: sha256(elf) }));
    writeFileSync(join(b, 'bootloader.bin'), Buffer.alloc(64, 0xe9));
    writeFileSync(join(b, 'ota_data_initial.bin'), Buffer.alloc(64, 0xff));
    const entry = Buffer.alloc(32);
    entry.writeUInt16LE(0x50aa, 0);
    entry[2] = 0;
    entry[3] = 0x10;
    entry.writeUInt32LE(0x20000, 4);
    entry.writeUInt32LE(0x1e0000, 8);
    entry.write('ota_0', 12);
    writeFileSync(join(b, 'partition-table.bin'), entry);
    writeFileSync(join(b, 'project_description.json'), JSON.stringify({ app_elf: 'fr_node.elf', project_name: 'fr_node' }));
    writeFileSync(
      join(b, 'flasher_args.json'),
      JSON.stringify({
        flash_settings: { flash_mode: 'dio', flash_size: '4MB', flash_freq: '80m' },
        bootloader: { offset: '0x0', file: 'bootloader.bin' },
        'partition-table': { offset: '0x8000', file: 'partition-table.bin' },
        otadata: { offset: '0xe000', file: 'ota_data_initial.bin' },
        app: { offset: '0x20000', file: 'fr_node.bin' },
      }),
    );
    return b;
  }

  const input = (buildDir: string, sourceDir: string) => ({
    sourceDir,
    buildDir,
    app: 'node',
    profile: 'c6-pad',
    buildType: 'debug' as const,
    board: 'esp32c6-supermini',
    target: 'esp32c6',
    partProfile: 'fr-4mb-v1',
    git: { sha: 'abc', dirty: false },
    idf: { version: 'v6.1', commit: 'def' },
  });

  it('stores the ELF and map as blobs and references them from the manifest', () => {
    const db = openDb(':memory:');
    const { manifest, manifestPath } = ingestBuild(db, input(fakeBuild('b1'), '/src/a'));
    const onDisk = JSON.parse(readFileSync(manifestPath, 'utf8')) as ArtifactManifest;
    const elf = Buffer.from('\x7fELF fake fr_node');
    expect(onDisk.debug?.elf).toEqual({ blob: `sha256:${sha256(elf).toString('hex')}`, size: elf.length });
    expect(onDisk.debug?.elf?.blob).toBe(`sha256:${manifest.elf_sha256}`);
    expect(readFileSync(blobPath(onDisk.debug!.elf!.blob), 'utf8')).toContain('ELF fake');
    expect(readFileSync(blobPath(onDisk.debug!.map!.blob), 'utf8')).toContain('Memory Configuration');
    // The schema keeps the refs when the manifest is read back.
    expect(loadManifest(db, manifest.build_id).debug).toEqual(onDisk.debug);
  });

  it('omits the map when the build has none', () => {
    const db = openDb(':memory:');
    const { manifestPath } = ingestBuild(db, input(fakeBuild('b2', { map: false }), '/src/a'));
    const onDisk = JSON.parse(readFileSync(manifestPath, 'utf8')) as ArtifactManifest;
    expect(onDisk.debug?.elf?.blob).toMatch(/^sha256:/);
    expect(onDisk.debug?.map).toBeUndefined();
  });

  it('rejects an ELF that is not the one the image was made from', () => {
    const db = openDb(':memory:');
    expect(() => ingestBuild(db, input(fakeBuild('b3', { elf: Buffer.from('other elf') }), '/src/a'))).toThrow(/elf_sha256/);
  });

  it('keeps cache_hit per source_dir when two checkouts produce the same build_id', () => {
    const db = openDb(':memory:');
    const a = ingestBuild(db, input(fakeBuild('b4'), '/src/a'));
    const b = ingestBuild(db, input(fakeBuild('b5'), '/src/b'));
    expect(b.manifest.build_id).toBe(a.manifest.build_id);
    expect(lastFwId(db, '/src/a', 'c6-pad', 'debug')).toBe(a.manifest.fw_id);
    expect(lastFwId(db, '/src/b', 'c6-pad', 'debug')).toBe(b.manifest.fw_id);
    expect(lastFwId(db, '/src/c', 'c6-pad', 'debug')).toBeNull();
    const rows = listArtifacts(db, { limit: 10 }) as Array<{ source_dir: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].source_dir).toBe('/src/b');
  });
});

describe('sdkconfig layers', () => {
  function tree(name: string): { src: string; appDir: string; genDir: string } {
    const src = dir(name);
    const appDir = dir(`${name}/firmware/apps/node`);
    const genDir = dir(`${name}/firmware/apps/node/build/c6-pad-debug/fr_gen`);
    dir(`${name}/firmware/config`);
    writeFileSync(join(src, 'firmware/config/sdkconfig.framework'), 'CONFIG_PARTITION_TABLE_CUSTOM=y\n');
    writeFileSync(join(src, 'firmware/config/sdkconfig.build.debug'), 'CONFIG_COMPILER_OPTIMIZATION_DEBUG=y\n');
    writeFileSync(join(appDir, 'sdkconfig.defaults'), '');
    writeFileSync(join(genDir, 'sdkconfig.board'), 'CONFIG_IDF_TARGET="esp32c6"\n');
    return { src, appDir, genDir };
  }

  it('lists the required layers in order and sdkconfig.local only when it exists', () => {
    const t = tree('l1');
    const base = sdkconfigLayers(t.src, t.appDir, t.genDir, 'debug');
    expect(base.map((f) => f.slice(t.src.length + 1))).toEqual([
      'firmware/config/sdkconfig.framework',
      'firmware/apps/node/sdkconfig.defaults',
      'firmware/apps/node/build/c6-pad-debug/fr_gen/sdkconfig.board',
      'firmware/config/sdkconfig.build.debug',
    ]);
    writeFileSync(join(t.src, 'firmware/config/sdkconfig.local'), '');
    expect(sdkconfigLayers(t.src, t.appDir, t.genDir, 'debug').at(-1)).toBe(join(t.src, 'firmware/config/sdkconfig.local'));
  });

  it('fails on a missing required layer', () => {
    const t = tree('l2');
    expect(() => sdkconfigLayers(t.src, t.appDir, t.genDir, 'release')).toThrow(/sdkconfig.build.release/);
  });

  it('hashes the <layer>.<target> files IDF applies', () => {
    const t = tree('l3');
    const layers = sdkconfigLayers(t.src, t.appDir, t.genDir, 'debug');
    const before = layerHash(layers, 'esp32c6');
    writeFileSync(join(t.src, 'firmware/config/sdkconfig.framework.esp32c3'), 'CONFIG_X=y\n');
    expect(layerHash(layers, 'esp32c6')).toBe(before);
    writeFileSync(join(t.src, 'firmware/config/sdkconfig.framework.esp32c6'), 'CONFIG_X=y\n');
    const withTarget = layerHash(layers, 'esp32c6');
    expect(withTarget).not.toBe(before);
    writeFileSync(join(t.src, 'firmware/config/sdkconfig.framework.esp32c6'), 'CONFIG_X=n\n');
    expect(layerHash(layers, 'esp32c6')).not.toBe(withTarget);
  });
});

describe('cachedIdfTarget', () => {
  it('reads IDF_TARGET from CMakeCache.txt', () => {
    const b = dir('cache');
    expect(cachedIdfTarget(b)).toBeNull();
    writeFileSync(join(b, 'CMakeCache.txt'), '# comment\nIDF_PATH:PATH=/idf\nIDF_TARGET:STRING=esp32c3\n');
    expect(cachedIdfTarget(b)).toBe('esp32c3');
  });
});

describe('spawnLogged', () => {
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
  const ctx = (signal: AbortSignal): JobCtx => ({ jobId: 'j_test', signal, log: () => undefined, stage: () => undefined, progress: () => undefined });

  it('passes lines and the exit code through', async () => {
    const lines: string[] = [];
    const code = await spawnLogged('sh', ['-c', 'echo hi; exit 3'], env, tmp, ctx(new AbortController().signal), (l) => lines.push(l));
    expect(code).toBe(3);
    expect(lines).toEqual(['hi']);
  });

  it('does not spawn when the job was cancelled already', async () => {
    const ac = new AbortController();
    ac.abort();
    const marker = join(tmp, 'spawned');
    const code = await spawnLogged('sh', ['-c', `touch '${marker}'`], env, tmp, ctx(ac.signal), () => undefined);
    expect(code).toBe(130);
    expect(existsSync(marker)).toBe(false);
  });

  it('kills the whole process group on cancel and waits for it', async () => {
    // Like idf.py with ninja: the parent dies on SIGTERM and leaves its child running.
    // (macOS sh would take its background job down itself, so it proves nothing here.)
    const parent = "const c = require('node:child_process').spawn('sleep', ['30'], { stdio: 'ignore' }); console.log(c.pid);";
    const ac = new AbortController();
    let bg = 0;
    const code = await spawnLogged(process.execPath, ['-e', parent], env, tmp, ctx(ac.signal), (l) => {
      if (/^\d+$/.test(l)) {
        bg = Number(l);
        ac.abort();
      }
    });
    expect(code).not.toBe(0);
    expect(bg).toBeGreaterThan(0);
    expect(() => process.kill(bg, 0)).toThrow();
  });
});
