import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadManifest } from '../src/artifacts.ts';
import { CmakeErrors, type Diagnostic, genFirmwareFromSource, genHash, runBuild } from '../src/build.ts';
import { openDb } from '../src/db.ts';
import type { JobCtx } from '../src/jobs.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// runBuild end to end without IDF. The checkout's own `fr` is a fake packages/cli/src/main.ts that
// plays `fr --json gen firmware` from gen-spec.json (writes the files, prints the envelope), the IDF
// environment is stubbed, and `idf.py` is a shell script that records its arguments and copies
// prebuilt outputs into the build dir (or prints a CMake error and fails).
const h = vi.hoisted(() => ({ env: {} as Record<string, string> }));

vi.mock('@fractonica/host', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@fractonica/host')>()),
  idfStatus: async () => ({ ok: true, path: '/idf', expected_commit: 'c0ffee', actual_commit: 'c0ffee' }),
  idfEnv: async () => h.env,
}));

/** What the fake `fr gen firmware` does on its next run. */
interface GenSpec {
  files: Record<string, string>;
  warnings: string[];
  slotsLockChanged: boolean;
  app: string;
  target: string;
  /** A failed envelope instead of files. */
  error?: Record<string, unknown>;
  /** Printed instead of any envelope (a CLI that did not start), with this exit code. */
  raw?: { stdout: string; stderr: string; exit: number };
}

const FAKE_FR = `// Fake \`fr\` for runBuild tests: plays \`fr --json gen firmware\` from <checkout>/gen-spec.json.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const spec = JSON.parse(readFileSync(join(root, 'gen-spec.json'), 'utf8'));
const argv = process.argv.slice(2);
appendFileSync(join(root, 'gen-calls.jsonl'), JSON.stringify({ argv, cwd: process.cwd() }) + '\\n');
if (spec.raw) {
  process.stdout.write(spec.raw.stdout);
  process.stderr.write(spec.raw.stderr);
  process.exit(spec.raw.exit);
}
if (spec.error) {
  console.log(JSON.stringify({ ok: false, cursor: '', error: spec.error }));
  process.exit(64);
}
const out = argv[argv.indexOf('--out') + 1];
const profile = argv[argv.indexOf('--profile') + 1];
const fault = argv.includes('--fault') ? argv[argv.indexOf('--fault') + 1] : null;
const files = { ...spec.files, ...(fault ? { 'sdkconfig.fault': 'CONFIG_FR_TEST_FAULT_HEALTH=y\\n' } : {}) };
for (const [rel, content] of Object.entries(files)) {
  mkdirSync(dirname(join(out, rel)), { recursive: true });
  writeFileSync(join(out, rel), content);
}
const manifest = { schema: 'fractonica/fr-manifest@1', profile, board: 'test-board', app: spec.app, target: spec.target, catalog_hash: 1, caps: [] };
console.log(JSON.stringify({
  ok: true,
  cursor: '',
  data: { source_dir: process.cwd(), profile, out_dir: out, files: Object.keys(files), slots_lock: 'firmware/profiles/' + profile + '.slots.lock', slots_lock_changed: spec.slotsLockChanged, warnings: spec.warnings, manifest, part_profile: 'fr-4mb-v1', fault },
}));
`;

const PROFILE = 'c6-test';

let tmp = '';
let src = '';
let buildDir = '';
let outputs = '';
let faultOutputs = '';
let argsFile = '';
let cmakeFail = '';
let spec: GenSpec;
const savedHome = process.env.FR_HOME;

/** The fake generator's invocations: its argv (after the script) and working directory. */
function genCalls(): { argv: string[]; cwd: string }[] {
  const f = join(src, 'gen-calls.jsonl');
  return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { argv: string[]; cwd: string }) : [];
}

function write(file: string, content: string | Buffer): void {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, content);
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest();

/** The catalog_hash fr_manifest.json reports in these tests; the image's fr_app_desc must carry it. */
const CATALOG = 0x1234abcd;

/**
 * An unsigned app image as esptool lays it out (header, segments, checksum, digest), its first segment
 * holding esp_app_desc_t and fr_app_desc_t for test-board/c6-test (see build.test.ts).
 */
function appImage(elfSha: Buffer, fault = 0): Buffer {
  const esp = Buffer.alloc(256);
  esp.writeUInt32LE(0xabcd5432, 0);
  esp.write('0.1.0', 16);
  esp.write('fr_node', 48);
  esp.write('v6.1', 112);
  elfSha.copy(esp, 144);
  const fr = Buffer.alloc(112);
  fr.writeUInt32LE(0x46524144, 0);
  fr[4] = 1;
  fr.writeUInt32LE(CATALOG, 8);
  fr.write('test-board', 12);
  fr.write(PROFILE, 44);
  fr.write('fr-4mb-v1', 76);
  fr[92] = fault;
  const desc = Buffer.concat([esp, fr]);
  const header = Buffer.alloc(24);
  header[0] = 0xe9;
  header[1] = 1;
  header.writeUInt16LE(13, 12);
  header[23] = 1;
  const seg = Buffer.alloc(8);
  seg.writeUInt32LE(0x42000020, 0);
  seg.writeUInt32LE(desc.length, 4);
  let body = Buffer.concat([header, seg, desc]);
  body = Buffer.concat([body, Buffer.alloc(15 - (body.length % 16)), Buffer.from([0xef])]);
  return Buffer.concat([body, sha256(body)]);
}

/** What a finished idf.py build leaves for ingest (`fault`: the image of a fault build). */
function fixture(dir: string, fault = 0): void {
  const elf = Buffer.from('\x7fELF fake fr_node');
  write(join(dir, 'fr_node.elf'), elf);
  write(join(dir, 'fr_node.bin'), appImage(sha256(elf), fault));
  write(join(dir, 'bootloader.bin'), Buffer.alloc(64, 0xe9));
  const entry = Buffer.alloc(32);
  entry.writeUInt16LE(0x50aa, 0);
  entry[3] = 0x10;
  entry.writeUInt32LE(0x20000, 4);
  entry.writeUInt32LE(0x1e0000, 8);
  entry.write('ota_0', 12);
  write(join(dir, 'partition-table.bin'), entry);
  write(join(dir, 'project_description.json'), JSON.stringify({ app_elf: 'fr_node.elf' }));
  write(
    join(dir, 'flasher_args.json'),
    JSON.stringify({
      flash_settings: { flash_mode: 'dio', flash_size: '4MB', flash_freq: '80m' },
      bootloader: { offset: '0x0', file: 'bootloader.bin' },
      'partition-table': { offset: '0x8000', file: 'partition-table.bin' },
      app: { offset: '0x20000', file: 'fr_node.bin' },
    }),
  );
}

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'fr-c2-build-')));
  process.env.FR_HOME = join(tmp, 'home');
  src = join(tmp, 'src');
  write(join(src, 'firmware/idf-version.lock'), JSON.stringify({ schema: 'x', idf: { tag: 'v6.1', commit: 'c0ffee', install_hint: '' }, targets: ['esp32c6'] }));
  write(join(src, `firmware/profiles/${PROFILE}.profile.yaml`), `profile: ${PROFILE}\nboard: test-board\napp: node\n`);
  write(join(src, 'hardware/boards/test-board.board.yaml'), 'id: test-board\nidf_target: esp32c6\nflash: { size: 4MB, part_profile: fr-4mb-v1 }\n');
  write(join(src, 'firmware/partitions/fr-4mb-v1.csv'), 'nvs, data, nvs, , 0x6000\n');
  write(join(src, 'firmware/config/sdkconfig.framework'), 'CONFIG_PARTITION_TABLE_CUSTOM=y\n');
  write(join(src, 'firmware/config/sdkconfig.build.debug'), 'CONFIG_FR_TEST_HOOKS=y\n');
  write(join(src, 'firmware/apps/node/sdkconfig.defaults'), '');
  write(join(src, 'packages/cli/package.json'), JSON.stringify({ type: 'module' }));
  write(join(src, 'packages/cli/src/main.ts'), FAKE_FR);
  buildDir = join(src, 'firmware/apps/node/build', `${PROFILE}-debug`);
  outputs = join(tmp, 'outputs');
  fixture(outputs);
  faultOutputs = join(tmp, 'outputs-fault');
  fixture(faultOutputs, 1);
  const bin = join(tmp, 'bin');
  argsFile = join(tmp, 'idf-args.txt');
  cmakeFail = join(tmp, 'cmake-error.txt');
  write(
    join(bin, 'idf.py'),
    [
      '#!/bin/sh',
      'printf \'%s\\n\' "$@" > "$FR_TEST_ARGS"',
      'if [ -f "$FR_TEST_CMAKE_FAIL" ]; then cat "$FR_TEST_CMAKE_FAIL" >&2; echo "-- Configuring incomplete, errors occurred!"; exit 2; fi',
      'while [ $# -gt 0 ]; do [ "$1" = -B ] && b="$2"; shift; done',
      'mkdir -p "$b" && cp -R "$FR_TEST_OUTPUTS"/. "$b"/',
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'idf.py'), 0o755);
  h.env = { PATH: `${bin}:/usr/bin:/bin`, FR_TEST_ARGS: argsFile, FR_TEST_OUTPUTS: outputs, FR_TEST_CMAKE_FAIL: cmakeFail };
});

afterAll(() => {
  if (savedHome === undefined) {
    delete process.env.FR_HOME;
  } else {
    process.env.FR_HOME = savedHome;
  }
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  h.env.FR_TEST_OUTPUTS = outputs;
  spec = {
    files: {
      'sdkconfig.board': 'CONFIG_IDF_TARGET="esp32c6"\n',
      'components.cmake': 'list(APPEND EXTRA_COMPONENT_DIRS "${CMAKE_CURRENT_LIST_DIR}")\n',
      'fr_board/fr_board.cpp': '// generated\n',
      'fr_manifest.json': JSON.stringify({
        schema: 'fractonica/fr-manifest@1',
        profile: PROFILE,
        catalog_hash: CATALOG,
        caps: [{ name: 'boot', port: 1, cap: 'fr.button', cap_id: 1, version: '1.0', driver: 'button_gpio', config: { debounce_ms: 20 } }],
      }),
    },
    warnings: [],
    slotsLockChanged: false,
    app: 'node',
    target: 'esp32c6',
  };
  rmSync(argsFile, { force: true });
  rmSync(cmakeFail, { force: true });
  rmSync(join(src, 'gen-calls.jsonl'), { force: true });
});

function build(events: string[] = [], profile = PROFILE) {
  writeFileSync(join(src, 'gen-spec.json'), JSON.stringify(spec));
  const ctx: JobCtx = {
    jobId: 'j_test',
    signal: new AbortController().signal,
    log: (text, stream) => stream === 'event' && events.push(text),
    stage: () => undefined,
    progress: () => undefined,
  };
  return runBuild(openDb(':memory:'), ctx, { sourceDir: src, profile, buildType: 'debug', app: 'node', clean: false });
}

// Captured from `cmake -S . -B build` (CMake 4) on a CMakeLists that includes a missing file and
// calls a function whose message(FATAL_ERROR) spans lines, as IDF's component.cmake checks do.
const CMAKE_ERROR = [
  'CMake Error at CMakeLists.txt:6 (include):',
  '  include could not find requested file:',
  '',
  '    /nonexistent/fr_gen/components.cmake',
  '',
  '',
  'CMake Error at /Users/dev/esp/esp-idf/tools/cmake/component.cmake:470 (message):',
  '  Include directory',
  '',
  "    '/x/fr_core/include2'",
  '',
  '  is not a directory.',
  'Call Stack (most recent call first):',
  '  sub/CMakeLists.txt:1 (fr_register)',
  '',
  '',
].join('\n');
const CMAKE_DIAGNOSTICS: Diagnostic[] = [
  { file: 'CMakeLists.txt', line: 6, col: 0, severity: 'error', message: 'include could not find requested file: /nonexistent/fr_gen/components.cmake' },
  { file: '/Users/dev/esp/esp-idf/tools/cmake/component.cmake', line: 470, col: 0, severity: 'error', message: "Include directory '/x/fr_core/include2' is not a directory." },
];

// These run fake generator and idf.py children (node, type stripping): seconds apiece while the whole
// suite runs in parallel, so they get more than vitest's 5 s.
describe('fr build with fr gen firmware', { timeout: 20_000 }, () => {
  it("runs the checkout's own fr gen firmware into <build>/fr_gen, passes FR_GEN_DIR to idf.py and surfaces warnings", async () => {
    spec.warnings = ['GPIO9 is a strapping pin: it must read high at reset'];
    spec.slotsLockChanged = true;
    const events: string[] = [];
    const r = await build(events);
    const genDir = join(buildDir, 'fr_gen');
    expect(genCalls()).toEqual([{ argv: ['--json', 'gen', 'firmware', '--profile', PROFILE, '--out', genDir], cwd: src }]);
    // The job log names the child it ran, so a build shows which checkout's generator made its glue.
    expect(events).toContain(
      `generate: ${[process.execPath, '--conditions=@fractonica/source', join(src, 'packages', 'cli', 'src', 'main.ts'), '--json', 'gen', 'firmware', '--profile', PROFILE, '--out', genDir].join(' ')} (cwd ${src})`,
    );
    expect(readFileSync(join(genDir, 'fr_board/fr_board.cpp'), 'utf8')).toBe('// generated\n');
    const args = readFileSync(argsFile, 'utf8').trim().split('\n');
    expect(args).toContain(`-DFR_GEN_DIR=${genDir}`);
    expect(args).toContain('-DIDF_TARGET=esp32c6');
    expect(args.find((a) => a.startsWith('-DSDKCONFIG_DEFAULTS='))).toContain(join(genDir, 'sdkconfig.board'));
    expect(r.warnings).toEqual(['GPIO9 is a strapping pin: it must read high at reset', 'firmware/profiles/c6-test.slots.lock: ports allocated for new instances; commit it']);
    expect(events).toContain('fr gen firmware: GPIO9 is a strapping pin: it must read high at reset');
    expect(r).toMatchObject({ target: 'esp32c6', board: 'test-board' });
  });

  it('ingests the caps and catalog_hash of fr_manifest.json into the artifact manifest', async () => {
    writeFileSync(join(src, 'gen-spec.json'), JSON.stringify(spec));
    const db = openDb(':memory:');
    const ctx: JobCtx = { jobId: 'j', signal: new AbortController().signal, log: () => undefined, stage: () => undefined, progress: () => undefined };
    const r = await runBuild(db, ctx, { sourceDir: src, profile: PROFILE, buildType: 'debug', app: 'node', clean: false });
    const m = loadManifest(db, r.build_id);
    expect(m.catalog_hash).toBe(0x1234abcd);
    expect(m.caps).toEqual([{ name: 'boot', port: 1, cap: 'fr.button', cap_id: 1, version: '1.0', driver: 'button_gpio', config: { debounce_ms: 20 } }]);
    expect(m).toMatchObject({ board: 'test-board', target: 'esp32c6', part_profile: 'fr-4mb-v1' });
    expect(m).not.toHaveProperty('test_pin'); // a pre-C6 fr_manifest.json has none
  });

  it("ingests C6's traits per instance and the board's test_pin (design c6 D13, D24)", async () => {
    const traits = { long_press: true, multi_press_max: 3, color: 'mono' };
    spec.files['fr_manifest.json'] = JSON.stringify({
      ...JSON.parse(spec.files['fr_manifest.json']),
      test_pin: 20,
      caps: [{ name: 'boot', port: 1, cap: 'fr.button', cap_id: 1, version: '1.0', driver: 'button_gpio', config: { debounce_ms: 20 }, traits }],
    });
    writeFileSync(join(src, 'gen-spec.json'), JSON.stringify(spec));
    const db = openDb(':memory:');
    const ctx: JobCtx = { jobId: 'j', signal: new AbortController().signal, log: () => undefined, stage: () => undefined, progress: () => undefined };
    const r = await runBuild(db, ctx, { sourceDir: src, profile: PROFILE, buildType: 'debug', app: 'node', clean: false });
    const m = loadManifest(db, r.build_id);
    expect(m.test_pin).toBe(20);
    expect(m.caps?.[0].traits).toEqual(traits);
  });

  it('regenerates sdkconfig when the generated firmware changes, not when only fr_manifest.json does', async () => {
    const changed = 'sdkconfig layers or generated firmware changed: regenerating sdkconfig';
    await build();
    const steady: string[] = [];
    await build(steady);
    expect(steady).not.toContain(changed);

    spec.files['fr_manifest.json'] = JSON.stringify({ schema: 'fractonica/fr-manifest@1', catalog_hash: CATALOG, caps: [] });
    const manifestOnly: string[] = [];
    await build(manifestOnly);
    expect(manifestOnly).not.toContain(changed);

    spec.files['fr_board/fr_board.cpp'] = '// generated, LED on another pin\n';
    const board: string[] = [];
    await build(board);
    expect(board).toContain(changed);
  });

  it('fails as BUILD_FAILED with the schema issues, before idf.py runs', async () => {
    const issue = 'firmware/profiles/c6-test.profile.yaml caps.boot.bind: GPIO12 is reserved (usb)';
    spec.error = { code: 'INVALID_SOURCE', message: `1 schema problem(s), first: ${issue}`, retryable: false, details: { issues: [issue] } };
    await expect(build()).rejects.toMatchObject({
      code: 'BUILD_FAILED',
      details: { stage: 'generate', issues: [expect.stringContaining('GPIO12 is reserved (usb)')] },
    });
    expect(existsSync(argsFile)).toBe(false);
  });

  it('is NOT_FOUND for a profile that does not exist', async () => {
    spec.error = { code: 'NOT_FOUND', message: 'no profile nope in /src/firmware/profiles', retryable: false, details: { profiles: ['c6-test'] } };
    await expect(build([], 'nope')).rejects.toMatchObject({ code: 'NOT_FOUND', details: { profiles: ['c6-test'] } });
    expect(existsSync(argsFile)).toBe(false);
  });

  it('is BUILD_FAILED with the stderr tail when the checkout cannot run fr at all', async () => {
    spec.raw = { stdout: '', stderr: "node:internal/modules/package_json_reader:255\nError [ERR_MODULE_NOT_FOUND]: Cannot find package 'commander'\n", exit: 1 };
    await expect(build()).rejects.toMatchObject({
      code: 'BUILD_FAILED',
      hint: expect.stringContaining('pnpm install'),
      details: { stage: 'generate', exit: 1, stderr: expect.arrayContaining([expect.stringContaining("Cannot find package 'commander'")]) },
    });
    expect(existsSync(argsFile)).toBe(false);
  });

  it('refuses a profile of another app, leaving no build dir behind', async () => {
    spec.app = 'bridge';
    const profile = 'c6-other';
    await expect(build([], profile)).rejects.toMatchObject({ code: 'INCOMPATIBLE_PROFILE' });
    expect(existsSync(join(src, 'firmware/apps/node/build', `${profile}-debug`))).toBe(false);
  });

  it('cleans a build dir configured for another target, keeping the glue just generated', async () => {
    await build();
    write(join(buildDir, 'CMakeCache.txt'), 'IDF_TARGET:STRING=esp32c3\n');
    write(join(buildDir, 'esp-idf/stale.o'), 'old');
    const events: string[] = [];
    await build(events);
    expect(events).toContain('build dir was configured for esp32c3, profile now targets esp32c6: cleaning it');
    expect(existsSync(join(buildDir, 'esp-idf/stale.o'))).toBe(false);
    expect(readFileSync(join(buildDir, 'fr_gen/fr_board/fr_board.cpp'), 'utf8')).toBe('// generated\n');
  });

  it('reports CMake configure errors as BUILD_FAILED diagnostics', async () => {
    writeFileSync(cmakeFail, CMAKE_ERROR);
    await expect(build()).rejects.toMatchObject({ code: 'BUILD_FAILED', details: { diagnostics: CMAKE_DIAGNOSTICS } });
  });
});

describe('fault builds (spec 03 §3.8)', { timeout: 20_000 }, () => {
  const ctx = (): JobCtx => ({ jobId: 'j_fault', signal: new AbortController().signal, log: () => undefined, stage: () => undefined, progress: () => undefined });

  it('build into <profile>-debug-fault with sdkconfig.fault after the build layer, and ingest as fault: health', async () => {
    writeFileSync(join(src, 'gen-spec.json'), JSON.stringify(spec));
    h.env.FR_TEST_OUTPUTS = faultOutputs;
    const db = openDb(':memory:');
    const r = await runBuild(db, ctx(), { sourceDir: src, profile: PROFILE, buildType: 'debug', app: 'node', clean: false, fault: 'health' });
    const faultDir = join(src, 'firmware/apps/node/build', `${PROFILE}-debug-fault`);
    const genDir = join(faultDir, 'fr_gen');
    expect(genCalls().at(-1)?.argv).toEqual(['--json', 'gen', 'firmware', '--profile', PROFILE, '--out', genDir, '--fault', 'health']);
    const args = readFileSync(argsFile, 'utf8').trim().split('\n');
    expect(args).toContain('-B');
    expect(args[args.indexOf('-B') + 1]).toBe(faultDir);
    const layers = args.find((a) => a.startsWith('-DSDKCONFIG_DEFAULTS='))!.slice('-DSDKCONFIG_DEFAULTS='.length).split(';');
    expect(layers.slice(-2)).toEqual([join(src, 'firmware/config/sdkconfig.build.debug'), join(genDir, 'sdkconfig.fault')]);
    expect(r).toMatchObject({ fault: 'health', build_id: `node/${PROFILE}/debug-fault/${r.fw_id.slice(0, 12)}` });
    expect(loadManifest(db, r.build_id)).toMatchObject({ build_type: 'debug', fault: 'health', app_desc: { fault: 1 } });
  });

  it('fails the build when the image does not say fault (the layer did not take effect)', async () => {
    writeFileSync(join(src, 'gen-spec.json'), JSON.stringify(spec));
    await expect(
      runBuild(openDb(':memory:'), ctx(), { sourceDir: src, profile: PROFILE, buildType: 'debug', app: 'node', clean: false, fault: 'health' }),
    ).rejects.toMatchObject({ code: 'BUILD_FAILED', message: expect.stringContaining('fault 0 != 1') });
  });

  it('is debug only', async () => {
    await expect(
      runBuild(openDb(':memory:'), ctx(), { sourceDir: src, profile: PROFILE, buildType: 'release', app: 'node', clean: false, fault: 'health' }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  });
});

describe('CmakeErrors', () => {
  it('takes the file, line and indented message of each `CMake Error at` block', () => {
    const found: Diagnostic[] = [];
    const p = new CmakeErrors((d) => found.push(d));
    for (const line of CMAKE_ERROR.split('\n')) {
      p.push(line);
    }
    p.end();
    expect(found).toEqual(CMAKE_DIAGNOSTICS);
  });

  it('ends a block at the end of output and ignores everything else', () => {
    const found: Diagnostic[] = [];
    const p = new CmakeErrors((d) => found.push(d));
    for (const line of ['-- Configuring done', 'CMake Warning at CMakeLists.txt:3 (message):', '  only a warning', 'CMake Error at main/CMakeLists.txt:2 (idf_component_register):', '  bad']) {
      p.push(line);
    }
    expect(found).toEqual([]);
    p.end();
    p.end();
    expect(found).toEqual([{ file: 'main/CMakeLists.txt', line: 2, col: 0, severity: 'error', message: 'bad' }]);
  });
});

describe('genFirmwareFromSource with this checkout', () => {
  it("returns what fr build needs from this repo's own fr gen firmware", async () => {
    const out = join(tmp, 'real-gen');
    const r = await genFirmwareFromSource(REPO, 'c6-pad', out);
    expect(r.manifest).toMatchObject({ app: 'node', target: 'esp32c6' });
    expect(r.part_profile).toMatch(/^fr-/);
    expect(r.files).toContain('fr_board/fr_board.cpp');
    expect(existsSync(join(out, 'fr_manifest.json'))).toBe(true);
    expect(existsSync(join(out, 'sdkconfig.fault'))).toBe(false);
  }, 30_000);

  it('writes the fault layer with --fault, and removes it again without', async () => {
    const out = join(tmp, 'real-gen-fault');
    const r = await genFirmwareFromSource(REPO, 'c6-pad', out, undefined, undefined, 'health');
    expect(r.fault).toBe('health');
    expect(r.files).toContain('sdkconfig.fault');
    expect(readFileSync(join(out, 'sdkconfig.fault'), 'utf8')).toContain('\nCONFIG_FR_TEST_FAULT_HEALTH=y\n');
    await genFirmwareFromSource(REPO, 'c6-pad', out);
    expect(existsSync(join(out, 'sdkconfig.fault'))).toBe(false);
  }, 30_000);
});

describe('hub startup', () => {
  it('loads no @fractonica/codegen: builds run the generator of the checkout they build', () => {
    // Resolve hooks record every module the hub's server and frame decoder pull in.
    const probe = [
      "import { registerHooks } from 'node:module';",
      'const seen = [];',
      'registerHooks({ resolve(spec, ctx, next) { const r = next(spec, ctx); seen.push(r.url); return r; } });',
      `await import(${JSON.stringify(pathToFileURL(join(REPO, 'packages/hub/src/http.ts')).href)});`,
      `await import(${JSON.stringify(pathToFileURL(join(REPO, 'packages/hub/src/frames.ts')).href)});`,
      'console.log(JSON.stringify(seen));',
    ].join('\n');
    const r = spawnSync(process.execPath, ['--conditions=@fractonica/source', '--input-type=module', '-e', probe], { cwd: REPO, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    const seen = JSON.parse(r.stdout.trim().split('\n').at(-1)!) as string[];
    expect(seen.some((u) => u.includes('/packages/hub/src/build.ts'))).toBe(true);
    expect(seen.filter((u) => u.includes('/packages/codegen/'))).toEqual([]);
  }, 30_000);
});

describe('genHash', () => {
  it('covers every generated file but the top-level fr_manifest.json', () => {
    const d = join(tmp, 'gen-hash');
    write(join(d, 'b/x.cpp'), '1');
    write(join(d, 'a.cmake'), '2');
    const base = genHash(d);
    write(join(d, 'fr_manifest.json'), '{}');
    expect(genHash(d)).toBe(base);
    write(join(d, 'b/fr_manifest.json'), '{}'); // only the top-level manifest is metadata
    expect(genHash(d)).not.toBe(base);
  });
});
