// The HIL bench reader (design m2-c1-hil D7): readBench loads hardware/bench/<name>.bench.yaml (lab by default)
// with BenchSchema, for the hub's fixture module, and reports a missing or malformed file instead of throwing.
// The exact cases read the lab bench as designed (§2.3), frozen in packages/codegen/test/fixtures; the
// checkout's own hardware/bench/lab.bench.yaml is the rig as wired, so its test checks only what holds for any rig.

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_BENCH, readBench } from '../src/inventory.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

function checkout(files: Record<string, string>): string {
  const src = realpathSync(mkdtempSync(join(tmpdir(), 'fr-bench-')));
  dirs.push(src);
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(src, f)), { recursive: true });
    writeFileSync(join(src, f), text);
  }
  return src;
}

/** The lab bench as designed (§2.3: pad-c3 on ch0/ch4/ch8, pad-c3b on ch1/ch5/ch9, fw_id null), frozen. */
const LAB = readFileSync(join(REPO, 'packages', 'codegen', 'test', 'fixtures', 'lab-design.bench.yaml'), 'utf8');

/** The fixture and the four DUTs of the lab rig (design m2-c1-hil D2, §2.3). */
const FIX_S3 = 'e8f60a81bc48';
const KNOWN_DUTS = ['1cdbd4175cc4', '1cdbd416ba34', '58e6c5d55e64', '94a99015cecc'];

describe('readBench', () => {
  it("reads a checkout's lab bench by default, with the schema's defaults filled in", () => {
    expect(DEFAULT_BENCH).toBe('lab');
    const { bench, errors } = readBench(checkout({ 'hardware/bench/lab.bench.yaml': LAB }));
    expect(errors).toEqual([]);
    expect(bench).toMatchObject({ schema: 'fractonica/bench@1', id: 'lab', fixture: { device: 'e8f60a81bc48', profile: 's3k-fixture', fw_id: null, vdd_mv: 3300 } });
    expect(Object.keys(bench!.duts)).toEqual(['1cdbd4175cc4', '1cdbd416ba34', '58e6c5d55e64', '94a99015cecc']);
    const lines = Object.values(bench!.duts).flatMap((d) => Object.values(d.lines));
    // §2.3: 12 lines wired at C1 and the two analog lines at M2-C3, EN reserved; `wired` defaults to true, `rf_weak` to false.
    expect(lines.filter((l) => l.wired)).toHaveLength(14);
    expect(lines.filter((l) => !l.wired).map((l) => l.channel)).toEqual(['ch14']);
    expect(Object.values(bench!.duts).map((d) => d.rf_weak)).toEqual([true, false, false, false]);
    expect(bench!.duts['94a99015cecc'].lines.en).toMatchObject({ role: 'en', dut_pin: 'EN', via: 'nfet', wired: false });
  });

  it("reads this checkout's lab bench (the rig as wired): the known fixture and DUTs, a pinned fw_id in hex", () => {
    const { bench, errors } = readBench(REPO);
    expect(errors).toEqual([]);
    expect(bench).toMatchObject({ schema: 'fractonica/bench@1', id: 'lab', fixture: { device: FIX_S3, profile: 's3k-fixture' } });
    expect(Object.keys(bench!.duts).filter((id) => !KNOWN_DUTS.includes(id))).toEqual([]);
    const fw = bench!.fixture.fw_id;
    if (fw !== null) {
      expect(fw).toMatch(/^[0-9a-f]{16,64}$/);
    }
  });

  it('reads another bench by name', () => {
    const src = checkout({ 'hardware/bench/desk.bench.yaml': LAB.replace('id: lab', 'id: desk') });
    expect(readBench(src, 'desk').bench?.id).toBe('desk');
    expect(readBench(src).errors).toEqual([{ file: 'hardware/bench/lab.bench.yaml', message: 'not found' }]);
  });

  it('reports a malformed bench instead of throwing', () => {
    const src = checkout({
      'hardware/bench/lab.bench.yaml': LAB.replace('fixture_gpio: 42', 'fixture_gpio: 49').replace('channel: ch4,', 'channel: four,'),
      'hardware/bench/bad.bench.yaml': 'schema: fractonica/bench@1\nid: [unclosed\n',
      'hardware/bench/other.bench.yaml': LAB,
    });
    expect(readBench(src)).toEqual({
      bench: null,
      errors: [
        { file: 'hardware/bench/lab.bench.yaml', message: 'duts.1cdbd4175cc4.lines.boot.fixture_gpio: Too big: expected number to be <=48' },
        { file: 'hardware/bench/lab.bench.yaml', message: 'duts.1cdbd4175cc4.lines.status.channel: expected ch<n>' },
      ],
    });
    const bad = readBench(src, 'bad');
    expect(bad.bench).toBeNull();
    expect(bad.errors).toHaveLength(1);
    expect(bad.errors[0].file).toBe('hardware/bench/bad.bench.yaml');
    // The file name is the bench id.
    expect(readBench(src, 'other')).toEqual({ bench: null, errors: [{ file: 'hardware/bench/other.bench.yaml', message: "id: bench id 'lab' does not match its file name" }] });
    expect(readBench(src, '../boards/x').errors).toEqual([{ file: 'hardware/bench/../boards/x.bench.yaml', message: "'../boards/x' is not a bench name" }]);
  });
});
