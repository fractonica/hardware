// The T2 scenario files (design m2-c2 D10, D13; stream S6): every tests/sim/scenarios/*.yaml parses with the protocol's
// schema and passes the validator (tests/sim/lib/topology-check.ts): its runs name modules the sim runner knows, every
// alias its args name exists among the started nodes, every --isolate node is on the bridge, and D10's seeder rule (a
// node that can lose its hub link hears at least two nodes that keep theirs). The validator refuses each kind of bad
// layout, and the args' alias ranges are written out as the modules will parse them. Every T-FLOOD and T-FLOOD-B run
// names all its nodes (--devices), so none silently drops out of a verdict. No process is started.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';

import { SimScenarioSchema, simAliases } from '@fractonica/protocol';

import { aliasesOf, checkScenario, expandArgs, expandToken, flagValues, linkPlan, loadScenarios, loadScenarioText, reach, RUN_MODULES } from '../../../tests/sim/lib/topology-check.ts';
import { TIME_SCALE } from '../../../tests/sim/lib/verdict.ts';

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'tests', 'sim', 'scenarios');

const text = (id: string) => readFileSync(join(DIR, `${id}.yaml`), 'utf8');
/** A scenario file with `patch` applied to its parsed YAML, as text again. */
const patched = (id: string, patch: (s: Record<string, any>) => void) => {
  const s = parse(text(id)) as Record<string, any>;
  patch(s);
  return loadScenarioText(`${id}.yaml`, stringify(s));
};

describe('tests/sim/scenarios', () => {
  const all = loadScenarios(DIR);

  it('holds the six gated scenarios and the five published ones, each valid', () => {
    expect(all.map((l) => [l.file, l.problems])).toEqual(all.map((l) => [l.file, []]));
    const gated = all.filter((l) => !l.scenario!.published).map((l) => [l.scenario!.id, l.scenario!.gate]);
    expect(gated).toEqual([
      ['t2-churn-30', 'T2-CHURN-30'],
      ['t2-flood-30', 'T2-FLOOD-30'],
      ['t2-flood-b-30', 'T2-FLOOD-B-30'],
      ['t2-input-30', 'T2-INPUT-30'],
      ['t2-nn-30', 'T2-NN-30'],
      ['t2-ota-30', 'T2-OTA-30'],
    ]);
    expect(all.filter((l) => l.scenario!.published).map((l) => l.scenario!.id)).toEqual(['t2-analog-30', 't2-flood-30-collisions', 't2-flood-30-long-frames', 't2-flood-30-two-rooms', 't2-flood-60']);
    // Every run names a module the runner can run and scale (D15's table has a row for each).
    for (const l of all) {
      for (const r of l.scenario!.runs) {
        expect(RUN_MODULES, `${l.file} ${r.name}`).toContain(r.run);
        expect(TIME_SCALE[r.run], `${l.file} ${r.name}`).toBeDefined();
      }
    }
  });

  it("gives every run args its module parses, at the full and at half the time scale (runner flags aside)", async () => {
    const parsers: Record<string, (a: string[]) => unknown> = {
      't-flood': (await import('../../../tests/e2e/t-flood.ts')).parseArgs,
      't-flood-b': (await import('../../../tests/e2e/t-flood-b.ts')).parseArgs,
      't-nn': (await import('../../../tests/e2e/t-nn.ts')).parseArgs,
      't-input': (await import('../../../tests/e2e/t-input.ts')).parseArgs,
      't-ota': (await import('../../../tests/e2e/t-ota.ts')).parseArgs,
      't2-churn': (await import('../../../tests/sim/t2-churn.ts')).parseArgs,
      't2-analog': (await import('../../../tests/sim/t2-analog.ts')).parseArgs,
      'flood-b-epoch': (await import('../../../tests/sim/lib/runner.ts')).parseEpochArgs,
      storm: () => null,
    };
    const { runnerFlags } = await import('../../../tests/sim/lib/runner.ts');
    const { scaleArgs } = await import('../../../tests/sim/lib/verdict.ts');
    for (const l of all) {
      const total = l.scenario!.nodes.count + l.scenario!.nodes.spares;
      for (const r of l.scenario!.runs) {
        const args = runnerFlags(expandArgs(r.args, total)).args;
        for (const scale of [1, 0.5]) {
          expect(() => parsers[r.run](scaleArgs(r.run, args, scale)), `${l.file} ${r.name} at ${scale}`).not.toThrow();
        }
      }
    }
  });

  it("keeps §2.2's example as t2-flood-30, collision-free with the 8-seed bound, the cut nodes on the bridge", () => {
    const s = all.find((l) => l.scenario?.id === 't2-flood-30')!.scenario!;
    expect(s.medium).toMatchObject({ topology: 'one_room', collisions: false, capture_db: 10, rssi_dbm: [-85, -45], loss: [0.001, 0.015] });
    expect(s.nodes).toMatchObject({ count: 30, usb: ['sim-07', 'sim-18', 'sim-29'] });
    expect(s.runs.map((r) => r.args.slice(0, 4))).toEqual([
      ['--devices', 'sim-01..sim-30', '--cut', 'sim-07'],
      ['--devices', 'sim-01..sim-30', '--cut', 'sim-07,sim-18,sim-29'],
    ]);
    expect(s.runs.every((r) => r.args.join(' ').includes('--max-seeds 8 --min-delivery 99.9'))).toBe(true);
  });

  it('gives each gate what §5.4 names: its nodes on the bridge, spares, the health deadline, the runs', () => {
    const s = (id: string) => all.find((l) => l.scenario?.id === id)!.scenario!;
    expect(s('t2-flood-b-30').nodes.usb).toEqual(['sim-28', 'sim-29', 'sim-30', 'sim-27']);
    expect(s('t2-flood-b-30').runs.map((r) => r.run)).toEqual(['t-flood-b', 't-flood-b', 'flood-b-epoch']);
    expect(s('t2-churn-30').nodes).toMatchObject({ count: 30, spares: 3, usb: ['sim-05', 'sim-15', 'sim-25'] });
    expect(s('t2-input-30').nodes.usb).toHaveLength(30);
    expect(s('t2-ota-30').nodes).toMatchObject({ health_ms: 10_000, usb: ['sim-28', 'sim-29', 'sim-30'] });
    expect(s('t2-ota-30').runs.every((r) => r.args.join(' ').includes('--no-build --max-parallel 16'))).toBe(true);
    expect(s('t2-nn-30').runs.map((r) => [r.name, r.published])).toEqual([
      ['running', false],
      ['stopped', false],
      ['running-under-broadcasts', true],
      ['running-lockstep', true],
    ]);
    // The gated running phase presses as independent users (seeded offsets); only the published stress case is in lockstep.
    expect(s('t2-nn-30').runs.filter((r) => r.args.includes('--lockstep')).map((r) => [r.name, r.published])).toEqual([['running-lockstep', true]]);
    expect(s('t2-flood-60').nodes.count).toBe(60);
  });

  it('keeps T2-ANALOG-30 a published dry run on c3o-analog nodes, at report_hz 20 then 50 (design m2-c3-inputs §8)', () => {
    const s = all.find((l) => l.scenario?.id === 't2-analog-30')!.scenario!;
    expect(s).toMatchObject({ published: true, nodes: { count: 30, profile: 'c3o-analog' } });
    expect(s.gate).toBeUndefined();
    expect(s.runs.map((r) => [r.run, flagValues(r.args, '--report-hz').at(-1)])).toEqual([
      ['t2-analog', '20'],
      ['t2-analog', '50'],
    ]);
    // A 1,000 ms sine: past the 512 deadband in nearly every report period, so the nodes stream near report_hz.
    expect(s.runs.map((r) => flagValues(r.args, '--period-ms').at(-1))).toEqual(['1000', '1000']);
    // A profile the kit cannot play is refused by the schema, before fr_fleet would.
    const bad = patched('t2-analog-30', (x) => (x.nodes.profile = 'c3o-pad'));
    expect(bad.problems.join(' ')).toContain('nodes.profile');
  });

  it('names every node in each T-FLOOD and T-FLOOD-B run, so a node offline at its start fails it rather than dropping out', () => {
    for (const l of all) {
      const s = l.scenario!;
      const total = s.nodes.count + s.nodes.spares;
      for (const r of s.runs.filter((x) => x.run === 't-flood' || x.run === 't-flood-b')) {
        expect(flagValues(expandArgs(r.args, total), '--devices').at(-1)?.split(','), `${l.file} ${r.name}`).toEqual(simAliases(total).slice(0, s.nodes.count));
      }
    }
  });

  it('plans who loses the hub link as the modules do, and each such node keeps two seeders', () => {
    const fb = all.find((l) => l.scenario?.id === 't2-flood-b-30')!.scenario!;
    const [wifiDown, routerOff, epoch] = fb.runs.map((r) => linkPlan(r, fb)!);
    // (a): 27 down, the bridge's sim-27 keeps its serial session, sim-28..30 keep TCP.
    expect(wifiDown.losers).toHaveLength(26);
    expect(wifiDown.keepers).toEqual(['sim-27', 'sim-28', 'sim-29', 'sim-30']);
    // (b): every node down, sim-30 isolated: the three USB keepers seed the flood.
    expect(routerOff.keepers).toEqual(['sim-27', 'sim-28', 'sim-29']);
    expect(routerOff.losers).toHaveLength(27);
    expect(epoch.keepers).toEqual(['sim-27', 'sim-28', 'sim-29', 'sim-30']);
  });
});

describe('the validator (topology-check.ts)', () => {
  it('writes alias ranges out with the fleet\'s padding', () => {
    expect(expandToken('sim-01..sim-03', 30)).toEqual(['sim-01', 'sim-02', 'sim-03']);
    expect(expandToken('sim-8..sim-10', 120)).toEqual(['sim-008', 'sim-009', 'sim-010']);
    expect(expandArgs(['--down', 'sim-01..sim-03,sim-07', '--rate', '1'], 30)).toEqual(['--down', 'sim-01,sim-02,sim-03,sim-07', '--rate', '1']);
    expect(() => expandToken('sim-05..sim-02', 30)).toThrow('bad alias range');
    expect(aliasesOf(['--pair', 'sim-29:sim-30', '--isolate', 'none', '--cut', 'sim-07,sim-18'], 30)).toEqual(
      new Map([
        ['--cut', ['sim-07', 'sim-18']],
        ['--pair', ['sim-29', 'sim-30']],
      ]),
    );
  });

  it('refuses a layout that leaves a cut node with fewer than two seeders (D10)', () => {
    // A matrix with one seeder in reach of the cut node.
    const r = patched('t2-flood-30', (s) => {
      s.nodes.count = 4;
      s.nodes.usb = ['sim-01'];
      s.medium = { topology: 'matrix', pairs: [{ tx: 'sim-02', rx: 'sim-01' }] };
      s.runs = [{ name: 'cut-1', run: 't-flood', args: ['--cut', 'sim-01'] }];
    });
    expect(r.problems).toEqual(['run cut-1 (t-flood): sim-01 can lose its hub link and has 1 seeder(s) in reach (sim-02); D10 needs at least 2']);
    // Three nodes in one room, two cut: each cut node hears one keeper.
    const three = patched('t2-flood-30', (s) => {
      s.nodes.count = 3;
      s.nodes.usb = [];
      s.runs = [{ name: 'cut-2', run: 't-flood', args: ['--cut', 'sim-01,sim-02'] }];
    });
    expect(three.problems).toEqual([
      'run cut-2 (t-flood): sim-01 can lose its hub link and has 1 seeder(s) in reach (sim-03); D10 needs at least 2',
      'run cut-2 (t-flood): sim-02 can lose its hub link and has 1 seeder(s) in reach (sim-03); D10 needs at least 2',
    ]);
    // Two rooms: only same-room pairs count, so a cut node in a room of two has one seeder.
    const rooms = patched('t2-flood-30-two-rooms', (s) => {
      s.nodes.count = 4;
      s.nodes.usb = [];
      s.runs = [{ name: 'cut', run: 't-flood', args: ['--cut', 'sim-01'] }];
    });
    expect(rooms.problems).toEqual(['run cut (t-flood): sim-01 can lose its hub link and has 1 seeder(s) in reach (sim-02); D10 needs at least 2']);
    const s = rooms.scenario!;
    expect(reach(s)('sim-02', 'sim-01')).toBe(true);
    expect(reach(s)('sim-03', 'sim-01')).toBe(false);
  });

  it('refuses unknown aliases, spare rows in a run, an --isolate off the bridge, an unknown module and t-flood without --cut', () => {
    const r = patched('t2-flood-b-30', (s) => {
      s.nodes.spares = 1;
      s.runs = [
        { name: 'a', run: 't-flood-b', args: ['--down', 'sim-01..sim-31', '--isolate', 'sim-05'] },
        { name: 'b', run: 't-blink', args: [] },
        { name: 'c', run: 't-flood', args: ['--count', '10'] },
        { name: 'd', run: 't-nn', args: ['--pair', 'sim-29:sim-40'] },
        { name: 'e', run: 't-nn', args: ['--pairs', '16', '--phase', 'running', '--sim'] },
        { name: 'f', run: 't-nn', args: ['--lockstep', '--phase', 'running', '--sim'] },
      ];
    });
    expect(r.problems).toEqual([
      'run a (t-flood-b): --down names sim-31, a spare row that only a join starts',
      'run a (t-flood-b): --isolate sim-05 is not on the bridge (nodes.usb): t-flood-b refuses to isolate a node the hub holds no port for',
      'run b (t-blink): no module t-blink (one of t-flood, t-flood-b, t-nn, t-input, t-ota, t2-churn, t2-analog, flood-b-epoch, storm)',
      'run c (t-flood): t-flood needs --cut (its default, pad-c3, is a bench board)',
      'run d (t-nn): --pair names sim-40, not a node of this fleet (sim-01 .. sim-31)',
      'run e (t-nn): --pairs 16 needs 32 started nodes; the fleet starts 30',
      'run f (t-nn): --lockstep needs --pairs (it puts several pairs on one press schedule)',
    ]);
  });

  it('refuses a file whose id differs from its name, and reports schema issues by path', () => {
    expect(loadScenarioText('t2-x.yaml', text('t2-flood-30')).problems).toEqual(['id t2-flood-30 differs from the file\'s name (t2-x)']);
    const bad = loadScenarioText('t2-flood-30.yaml', text('t2-flood-30').replace('count: 30 ', 'count: 0 '));
    expect(bad.problems[0]).toMatch(/^nodes\.count: /);
    expect(loadScenarioText('x.yaml', ': : :').problems[0]).toMatch(/^not YAML|^\(root\)/);
    // A scenario the schema takes is checked as parsed.
    expect(checkScenario(SimScenarioSchema.parse(parse(text('t2-churn-30'))))).toEqual([]);
  });
});
