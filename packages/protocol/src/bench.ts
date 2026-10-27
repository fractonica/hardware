// The HIL bench file (design m2-c1-hil D7, §2.3): hardware/bench/<name>.bench.yaml, schema fractonica/bench@1.
// It says which fixture line is wired to which pin of which device under test, keyed by device id (the
// factory MAC; aliases are only comments). The hub loads it (bench_get, the fixture module) and `fr gen
// --check` validates it against the board manifests and profiles; this schema is only its shape.

import { z } from 'zod';

/** What a bench line is wired to on its DUT. */
export const BENCH_LINE_ROLES = ['button', 'led', 'test_pin', 'analog', 'en'] as const;
export type BenchLineRole = (typeof BENCH_LINE_ROLES)[number];

/** How a button or EN line reaches the DUT: the fixture pin directly (open_drain), or a MOSFET (nfet_gate). */
export const BENCH_VIA = ['direct', 'nfet'] as const;
export type BenchVia = (typeof BENCH_VIA)[number];

const HEX12 = /^[0-9a-f]{12}$/;
const gpio = z.number().int().min(0).max(48);
const name = z.string().regex(/^[a-z][a-z0-9_]*$/, 'expected snake_case');

/** One fixture line and the DUT pin it reaches. `series_ohm` and `rc` are documentation (the validator wants an rc on analog lines). */
export const BenchLineSchema = z
  .strictObject({
    role: z.enum(BENCH_LINE_ROLES),
    /** The DUT's GPIO; or `dut_pin` for a pin that is not one (EN). */
    dut_gpio: gpio.optional(),
    dut_pin: z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'expected a pin name, e.g. EN').optional(),
    /** The fixture profile's instance of this line (fr.fixture), e.g. ch0. */
    channel: z.string().regex(/^ch\d{1,2}$/, 'expected ch<n>'),
    fixture_gpio: gpio,
    /** Button and EN lines: must match the channel's drive (direct: open_drain, nfet: nfet_gate). */
    via: z.enum(BENCH_VIA).optional(),
    /** LED lines on led_gpio: the DUT pin's level when the LED is lit. */
    active_level: z.enum(['low', 'high']).optional(),
    /** LED lines: `ws2812` (a fixture_ws2812_rx channel) for led_ws2812, else `level`. */
    decode: z.enum(['level', 'ws2812']).optional(),
    series_ohm: z.number().int().positive().optional(),
    rc: z.strictObject({ r_ohm: z.number().positive(), c_nf: z.number().positive() }).optional(),
    /** A profile the DUT runs for this line instead of its bench profile (M2-C3: c3o-analog). */
    dut_profile: z.string().min(1).optional(),
    /** false: the line is reserved (its pin and channel), with no profile instance yet; the hub never drives or judges it. */
    wired: z.boolean().default(true),
  })
  .refine((l) => (l.dut_gpio === undefined) !== (l.dut_pin === undefined), { message: 'give exactly one of dut_gpio and dut_pin' });
export type BenchLine = z.infer<typeof BenchLineSchema>;

/** One device under test: the profile it runs on the bench, and its lines by name (boot, status, test_pin...). */
export const BenchDutSchema = z.strictObject({
  profile: z.string().min(1),
  /** T-HIL: accounted RF losses warn instead of failing (a board with a weak radio, design §5.2). */
  rf_weak: z.boolean().default(false),
  lines: z.record(name, BenchLineSchema),
});
export type BenchDut = z.infer<typeof BenchDutSchema>;

/** A parsed bench file. */
export const BenchSchema = z.strictObject({
  schema: z.literal('fractonica/bench@1'),
  id: name,
  fixture: z.strictObject({
    /** The fixture board's device id. */
    device: z.string().regex(HEX12, 'expected a 12-hex device id'),
    /** The only profile the fixture may run (role: fixture). */
    profile: z.string().min(1),
    /** The fixture firmware the bench is pinned to (hex fw_id or a prefix); null until pinned. */
    fw_id: z
      .string()
      .regex(/^[0-9a-f]{16,64}$/, 'expected a hex fw_id (16 to 64 digits)')
      .nullable(),
    /** The fixture's 3V3 rail in mV (M2-C3): a pwm line's duty for a setpoint is round(mv / vdd_mv * 10000). */
    vdd_mv: z.number().int().min(1000).max(5500).default(3300),
  }),
  /** By device id. */
  duts: z.record(z.string().regex(HEX12, 'expected a 12-hex device id'), BenchDutSchema),
});
export type Bench = z.infer<typeof BenchSchema>;
