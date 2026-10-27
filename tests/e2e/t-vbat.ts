// The vbat_mv check (spec 10 §10.5; design m2-c3-inputs D11, §8): pad-s3's HEARTBEAT vbat_mv (BAT_ADC on GPIO4
// through the board's divider, 8 conversions averaged per heartbeat by core.cpp) against a multimeter reading on
// its battery (or on the charger's output, with no battery). A person reads the meter; the harness reads the
// heartbeats:
//
//   node --conditions=@fractonica/source tests/e2e/t-vbat.ts --meter-mv 3987
//   node --conditions=@fractonica/source tests/e2e/t-vbat.ts                    (reports; fails: needs a meter reading)
//
// It takes the last HEARTBEAT the hub kept for the board (device_get router.heartbeat, the decoded PRESENCE.HEARTBEAT:
// vbat_mv, uptime_s), polled at a quarter of its heartbeat interval, each new heartbeat (a new uptime_s) one sample,
// until --heartbeats (10) are in. Pass (proposed): every sample measured (> 0: 0 means the board has no battery
// section), |median − meter| <= 150 mV, max − min <= 50 mV. Without --meter-mv it reports the samples and fails as
// "needs a meter reading": the ×3 divider is inferred, so only the meter can confirm it. The reading is a person's, so a
// run without --meter-mv needs one at the bench (needsFor: test_run without allow_human skips it); with it, nobody.
//
// Run on its own (lib/runner.ts runStandalone; --hub URL, --json); under tests/e2e/run.ts (test_run tier target)
// FR_T_VBAT_ARGS holds the same flags. The check is exported for the unit tests (packages/hub/test/e2e-gates-g.test.ts).

import { runStandalone } from './lib/runner.ts';
import { defineScenario, type Needs, type Outcome, type ScenarioCtx } from './lib/scenario.ts';
import { sleep } from './lib/tasks.ts';

/** The pass numbers (proposed, design m2-c3-inputs §8). */
export const VBAT = { heartbeats: 10, tolMv: 150, spreadMv: 50 } as const;

export interface TVbatOptions {
  device: string;
  meterMv: number | null;
  heartbeats: number;
}

export const DEFAULTS: TVbatOptions = { device: 'pad-s3', meterMv: null, heartbeats: VBAT.heartbeats };

export function parseArgs(argv: readonly string[]): TVbatOptions {
  const o: TVbatOptions = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i + 1] ?? '';
    const num = (min: number, max: number) => {
      const n = Number(v);
      if (v === '' || !Number.isInteger(n) || n < min || n > max) {
        throw new Error(`t-vbat: ${argv[i]} takes an integer ${min}..${max}, not ${JSON.stringify(v)}`);
      }
      i++;
      return n;
    };
    switch (argv[i]) {
      case '--device':
        if (!v) {
          throw new Error('t-vbat: --device takes an alias');
        }
        o.device = v;
        i++;
        break;
      case '--meter-mv':
        o.meterMv = num(1, 20_000);
        break;
      case '--heartbeats':
        o.heartbeats = num(1, 100);
        break;
      default:
        throw new Error(`t-vbat: unknown option ${argv[i]} (--device, --meter-mv, --heartbeats)`);
    }
  }
  return o;
}

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** The check on the heartbeats' vbat_mv against the meter (null: none given). */
export function vbatVerdict(i: { samples: readonly number[]; meterMv: number | null; want?: number; tolMv?: number; spreadMv?: number }) {
  const want = i.want ?? VBAT.heartbeats;
  const tol = i.tolMv ?? VBAT.tolMv;
  const spreadMax = i.spreadMv ?? VBAT.spreadMv;
  const n = i.samples.length;
  const med = n ? median(i.samples) : null;
  const spread = n ? Math.max(...i.samples) - Math.min(...i.samples) : null;
  const reasons: string[] = [];
  if (n < want) {
    reasons.push(`${n} of ${want} heartbeats`);
  }
  const unmeasured = i.samples.filter((v) => v <= 0).length;
  if (unmeasured) {
    reasons.push(`${unmeasured} heartbeat(s) with vbat_mv 0 (not measured: no battery section in this build)`);
  }
  if (spread !== null && spread > spreadMax) {
    reasons.push(`spread ${spread} mV over ${spreadMax} mV`);
  }
  const diff = med !== null && i.meterMv !== null ? med - i.meterMv : null;
  if (i.meterMv === null) {
    reasons.push('needs a meter reading (--meter-mv)');
  } else if (diff !== null && Math.abs(diff) > tol) {
    reasons.push(`median ${med} mV is ${diff > 0 ? '+' : ''}${diff} mV from the meter's ${i.meterMv} mV (±${tol})`);
  }
  return {
    pass: reasons.length === 0,
    samples: n,
    median_mv: med,
    min_mv: n ? Math.min(...i.samples) : null,
    max_mv: n ? Math.max(...i.samples) : null,
    spread_mv: spread,
    meter_mv: i.meterMv,
    diff_mv: diff,
    bounds: { tol_mv: tol, spread_mv: spreadMax },
    ...(reasons.length ? { reasons } : {}),
  };
}

interface Heartbeat {
  uptime_s?: number;
  vbat_mv?: number;
  free_heap_kb?: number;
}

export async function runTVbat(ctx: ScenarioCtx, o: TVbatOptions): Promise<Outcome> {
  const first = await ctx.hub.ok<{ alias: string; presence?: string; router?: { hb_interval_ms?: number; heartbeat?: Heartbeat | null } | null }>('device_get', { device: o.device }, undefined, ctx.signal);
  const hbMs = first.router?.hb_interval_ms ?? 1000;
  const samples: number[] = [];
  const uptimes: number[] = [];
  let last: number | undefined = first.router?.heartbeat?.uptime_s;
  const end = Date.now() + (o.heartbeats + 2) * hbMs * 2 + 10_000;
  ctx.log(`${o.device}: ${o.heartbeats} heartbeats (${hbMs} ms apart)${o.meterMv === null ? '; no --meter-mv: reported, not judged' : ` against the meter's ${o.meterMv} mV`}`);
  while (samples.length < o.heartbeats && Date.now() < end) {
    await sleep(Math.max(50, hbMs / 4), ctx.signal);
    const d = await ctx.hub.ok<{ router?: { heartbeat?: Heartbeat | null } | null }>('device_get', { device: o.device }, undefined, ctx.signal);
    const hb = d.router?.heartbeat;
    if (hb && typeof hb.uptime_s === 'number' && hb.uptime_s !== last && typeof hb.vbat_mv === 'number') {
      last = hb.uptime_s;
      samples.push(hb.vbat_mv);
      uptimes.push(hb.uptime_s);
    }
  }
  const v = vbatVerdict({ samples, meterMv: o.meterMv, want: o.heartbeats });
  for (const r of v.reasons ?? []) {
    ctx.log(r);
  }
  return {
    pass: v.pass,
    measured: { device: o.device, hb_interval_ms: hbMs, ...v, vbat_mv: samples, pass_numbers: 'proposed (design m2-c3-inputs §8)' },
    evidence: { uptime_s: uptimes },
  };
}

/** The flags of a run: its own (ctx.args, standalone or test_run's `args`), else FR_T_VBAT_ARGS. */
function runArgs(args: readonly string[] | undefined): string[] {
  return args?.length ? [...args] : (process.env.FR_T_VBAT_ARGS ?? '').split(/\s+/).filter(Boolean);
}

/**
 * A meter reading is a person's: without --meter-mv the run needs one at the bench (so a tier-wide test_run without
 * allow_human skips it rather than failing it); with it, nobody.
 */
export function needsFor(o: Pick<TVbatOptions, 'meterMv'>): Needs {
  return o.meterMv === null ? { human: true } : {};
}

const scenario = defineScenario({
  gate: 'T-VBAT',
  title: "pad-s3's HEARTBEAT vbat_mv against a multimeter: median within ±150 mV, spread ≤ 50 mV over 10 heartbeats",
  needs: { human: true },
  needsFor: (args) => needsFor(parseArgs(runArgs(args))),
  usage: `--meter-mv <n>               the multimeter on the battery (or the charger's output), in mV; without it the run reports and fails
--device pad-s3              the board with a battery section (waveshare-esp32s3-lcd19)
--heartbeats 10              how many heartbeats to take
under tests/e2e/run.ts (test_run), FR_T_VBAT_ARGS holds these`,
  run: (ctx) => runTVbat(ctx, parseArgs(runArgs(ctx.args))),
});
export default scenario;

if (import.meta.main) {
  await runStandalone(scenario, import.meta.dirname);
}
