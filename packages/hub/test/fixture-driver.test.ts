// The fixture driver (design m2-c1-hil D8, D9, D11, §2.1; stream S4) on a scripted fixture with two DUTs:
// the gesture segments (long_press from the DUT firmware's long_press_ms), a gpio click seen by the DUT and
// returned after the gesture, a press held until release (whose result carries the release edge), every
// refusal in its order (not wired, offline, a fixture build that drives the channel otherwise than the bench
// line, profile_mismatch, LOCKED by a job or a declared power-cut window, DEVICE_BUSY by readback, while a
// press runs, and when the fixture itself says busy), the releases at a DUT's
// offline, boot and USB detach, at a declared power cut, and on the module's stop; a gesture such a release
// cuts short (status interrupted); a press or release whose RESULT is lost (let go, retried, the line pressing
// until it reads released); and a fixture session that drops without a reboot (tracking kept, every driven line
// released at its WELCOME, before the identify blink). M2-C3 (design m2-c3-inputs D5, D7): an analog line's PWM
// setpoint (duty, at_hub_us), its gates, duty 0 at the release paths, and input_simulate value/mv on both layers.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CLS } from '@fractonica/protocol';
import { decodeAnalogInInjectArgs, findCap, PORT } from '@fractonica/protocol/gen';

import { dutyFor, gestureSegments } from '../src/fixture/driver.ts';
import { lineDrive } from '../src/fixture/timeline.ts';
import { mvToValue, valueToMv } from '../src/router/ops.ts';
import { PAD_CAPS, until } from './fake-node.ts';
import { addManifest, benchRig, type BenchRig, C3, C6, FIX, FIX_FW, member, testBench } from './fixture-fake.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
});

async function rig(opts: Parameters<typeof benchRig>[0] = {}): Promise<BenchRig> {
  const b = await benchRig(opts);
  cleanups.push(() => b.close());
  return b;
}

const gpio = (selector: string, gesture: string, instance = 'boot') => ({ selector, instance, gesture, layer: 'gpio' });

/** The DUT's events of `type` since the cursor. */
function since(b: BenchRig, cursor: string, device: string, type: string) {
  const seq = Number(cursor.split('.')[1]);
  return b.r.events.query({ afterSeq: seq, devices: [device], types: [type], limit: 100 });
}

describe('gestures as fixture segments (§2.1)', () => {
  it('press first, µs: click, double_click, long_press past long_press_ms, press up to cap_ms, bounce', () => {
    expect(gestureSegments('click')).toEqual([80_000]);
    expect(gestureSegments('double_click')).toEqual([80_000, 100_000, 80_000]);
    expect(gestureSegments('long_press')).toEqual([800_000]); // fr.button's 600 ms default + 200 ms
    expect(gestureSegments('long_press', { longPressMs: 1000 })).toEqual([1_200_000]);
    // long_press_ms 0 (disabled on the DUT): still the default's long hold, as the harness's segmentsFor.
    expect(gestureSegments('long_press', { longPressMs: 0 })).toEqual([800_000]);
    expect(gestureSegments('press')).toEqual([15_000_000]);
    expect(gestureSegments('press', { capMs: 2000 })).toEqual([2_000_000]);
    expect(gestureSegments('bounce')).toEqual([600, 400, 600, 400, 80_000]);
    expect(gestureSegments('release')).toEqual([]);
  });
});

describe('input_simulate {layer: gpio}', () => {
  it('clicks: the fixture presses the BOOT line 80 ms, the DUT sees down then up, the op returns after the gesture', async () => {
    const b = await rig();
    const t0 = Date.now();
    const res = await b.call('input_simulate', gpio('pad-c3', 'click'));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(80);
    expect(res.cursor).toMatch(/^c:\d+\.\d+$/);
    expect(res.results).toEqual([
      expect.objectContaining({
        device: C3.mac,
        alias: 'pad-c3',
        status: 'ok',
        layer: 'gpio',
        fixture: 'fix-s3',
        channel: 'ch0',
        link: 'serial',
        fields: { at_us: expect.any(Number), total_us: 80_000 },
        press: { t_fix_us: expect.any(Number), t_hub_us: expect.any(Number), segments_us: [80_000], total_us: 80_000 },
      }),
    ]);
    // t_fix_us is the full fixture time (77 s since its boot on the FakeNode's clock); t_hub_us is now-ish.
    const press = res.results[0].press;
    expect(press.t_fix_us).toBeGreaterThan(77_000_000);
    expect(Math.abs(press.t_hub_us / 1000 - Date.now())).toBeLessThan(1000);
    expect(b.fixture.presses).toEqual([{ channel: 'ch0', segments: [80_000], at: expect.any(Number) }]);
    await until(() => since(b, res.cursor, C3.mac, 'boot.up').length === 1, 1000, 'up');
    expect(since(b, res.cursor, C3.mac, 'boot.down')).toHaveLength(1);
    // pad-c6 was not touched.
    expect(since(b, res.cursor, C6.mac, 'boot.down')).toHaveLength(0);
  });

  it('presses all selected DUTs at once, each on its own line', async () => {
    const b = await rig();
    const res = await b.call('input_simulate', gpio('pad-c3,pad-c6', 'double_click'));
    expect(res.results.map((r: any) => [r.alias, r.channel, r.press.segments_us])).toEqual([
      ['pad-c3', 'ch0', [80_000, 100_000, 80_000]],
      ['pad-c6', 'ch2', [80_000, 100_000, 80_000]],
    ]);
    await until(() => since(b, res.cursor, C3.mac, 'boot.down').length === 2 && since(b, res.cursor, C6.mac, 'boot.down').length === 2, 1000, 'two downs each');
  });

  it("takes long_press from the DUT firmware's fr.button long_press_ms, and bounce as its own segments", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fr-fix-art-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const fw = 'c3c3c3c3aabbccdd';
    const b = await rig({ c3: { fwPrefix: fw } });
    addManifest(b.r.db, dir, {
      profile: 'c3o-pad',
      fw,
      target: 'esp32c3',
      caps: [
        { name: 'boot', port: 1, cap: 'fr.button', cap_id: 1, version: '0.1', driver: 'button_gpio', config: { debounce_ms: 20, long_press_ms: 300 } },
        { name: 'status', port: 2, cap: 'fr.led', cap_id: 2, version: '0.1', driver: 'led_gpio', config: {} },
      ],
    });
    const res = await b.call('input_simulate', gpio('pad-c3', 'long_press'));
    expect(res.results[0].press).toMatchObject({ segments_us: [500_000], total_us: 500_000 });
    const bounce = await b.call('input_simulate', gpio('pad-c3', 'bounce'));
    expect(bounce.results[0].press.segments_us).toEqual([600, 400, 600, 400, 80_000]);
    // The DUT's debounce makes it one down and one up.
    await until(() => since(b, bounce.cursor, C3.mac, 'boot.up').length === 1, 1000, 'bounce up');
    expect(since(b, bounce.cursor, C3.mac, 'boot.down')).toHaveLength(1);
  });

  it('holds a press until release: it returns at the press edge, the line is busy until then, and the release returns its edge', async () => {
    const b = await rig();
    const t0 = Date.now();
    const held = await b.call('input_simulate', gpio('pad-c3', 'press'));
    expect(Date.now() - t0).toBeLessThan(500);
    expect(held.results[0].press).toMatchObject({ segments_us: [15_000_000], total_us: 15_000_000 });
    await until(() => since(b, held.cursor, C3.mac, 'boot.down').length === 1, 1000, 'down');
    await expect(b.call('input_simulate', gpio('pad-c3', 'click'))).rejects.toMatchObject({ code: 'DEVICE_BUSY', details: { channel: 'ch0' } });
    await new Promise((r) => setTimeout(r, 300));
    const tRel = Date.now();
    const rel = await b.call('input_simulate', gpio('pad-c3', 'release'));
    expect(rel.results[0]).toMatchObject({ status: 'ok', layer: 'gpio', channel: 'ch0' });
    // The release edge, read back: the hold is its fixture time less the press edge's (protocol-gaps-7).
    expect(rel.results[0].press).toMatchObject({ t_fix_us: expect.any(Number), t_hub_us: expect.any(Number), segments_us: [], total_us: 0 });
    const holdUs = rel.results[0].press.t_fix_us - held.results[0].press.t_fix_us;
    expect(holdUs).toBeGreaterThanOrEqual(300_000);
    expect(holdUs).toBeLessThan((Date.now() - t0) * 1000);
    expect(Date.now() - tRel).toBeLessThan(200);
    expect(b.fixture.releases).toEqual(['ch0']);
    await until(() => since(b, held.cursor, C3.mac, 'boot.up').length === 1, 1000, 'up');
    // Free again; a release of a line that is not pressed returns at once, with no edge.
    await b.call('input_simulate', gpio('pad-c3', 'click'));
    expect(b.fixture.presses.map((p) => p.segments)).toEqual([[15_000_000], [80_000]]);
    const idle = await b.call('input_simulate', gpio('pad-c3', 'release'));
    expect(idle.results[0]).toMatchObject({ status: 'ok', channel: 'ch0' });
    expect(idle.results[0].press).toBeUndefined();
  });

  it('keeps the inject layer as it was: the default, a raw inject command; bounce is gpio-only', async () => {
    const b = await rig();
    let injected: Uint8Array | null = null;
    b.c3.handlers.set(`1/1`, (args) => {
      injected = args;
    });
    const res = await b.call('input_simulate', { selector: 'pad-c3', instance: 'boot', gesture: 'press' });
    expect(res.results).toEqual([expect.objectContaining({ alias: 'pad-c3', status: 'ok' })]);
    expect(res.results[0].layer).toBeUndefined();
    expect(Buffer.from(injected!).equals(Buffer.from(member('fr.button', 'args', 'inject', { gesture: 'press' })))).toBe(true);
    expect(b.fixture.presses).toHaveLength(0);
    await expect(b.call('input_simulate', { selector: 'pad-c3', instance: 'boot', gesture: 'bounce' })).rejects.toMatchObject({
      code: 'INVALID_ARGS',
      remediation: [{ tool: 'input_simulate', args: { gesture: 'bounce', layer: 'gpio' } }],
    });
  });
});

describe('gating (D8, D11)', () => {
  it('refuses a line that is not wired: reserved, not a button, not a bench DUT', async () => {
    const b = await rig();
    await expect(b.call('input_simulate', gpio('pad-c3', 'click', 'analog'))).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: expect.stringMatching(/pad-c3 analog is reserved \(wired: false\)/),
      details: { not_wired: true, channel: 'ch12', wired: false },
    });
    // An LED instance takes no gesture at all (m2-c3-inputs D7): invalid_input, before any bench line is looked at.
    await expect(b.call('input_simulate', gpio('pad-c3', 'click', 'status'))).rejects.toMatchObject({ code: 'INVALID_ARGS', details: { reason: 'invalid_input' } });
    await expect(b.call('input_simulate', gpio('pad-c3', 'click', 'aux'))).rejects.toMatchObject({ code: 'NOT_FOUND', message: expect.stringMatching(/no aux line/) });
    const other = b.r.pad({ mac: 'a0b1c2d3e4f5', addr: 0x0090, alias: 'pad-x' });
    await other.connected(b.r.events);
    await expect(b.call('input_simulate', gpio('pad-x', 'click'))).rejects.toMatchObject({ code: 'NOT_FOUND', message: expect.stringMatching(/pad-x is not a DUT of bench lab/) });
    // Nothing was refused by pressing: the fixture never heard of it.
    expect(b.fixture.presses).toHaveLength(0);
  });

  it('refuses an offline DUT, an offline fixture, and a DUT on a profile that is not its bench one', async () => {
    const b = await rig();
    b.r.registry.get(C6.mac)!.profile = 'c6-pad-mono';
    await expect(b.call('input_simulate', gpio('pad-c6', 'click'))).rejects.toMatchObject({
      code: 'INCOMPATIBLE_PROFILE',
      details: { problem: 'profile_mismatch', profile: 'c6-pad-mono', bench_profile: 'c6-pad' },
    });
    // A line's dut_profile is a bench profile too (pad-c3's analog line names c3o-analog).
    b.r.registry.get(C3.mac)!.profile = 'c3o-analog';
    await b.call('input_simulate', gpio('pad-c3', 'click'));
    b.c3.close();
    await until(() => b.r.router.presence(C3.mac) === 'offline', 5000, 'pad-c3 offline');
    await expect(b.call('input_simulate', gpio('pad-c3', 'click'))).rejects.toMatchObject({ code: 'DEVICE_OFFLINE', message: 'pad-c3 is offline' });
    // A release always goes: letting a line go is safe whatever the DUT is doing.
    expect((await b.call('input_simulate', gpio('pad-c3', 'release'))).results[0]).toMatchObject({ status: 'ok', channel: 'ch0' });
    b.fixture.close();
    await until(() => b.r.router.presence(FIX.mac) === 'offline', 5000, 'fixture offline');
    await expect(b.call('input_simulate', gpio('pad-c3', 'click'))).rejects.toMatchObject({ code: 'DEVICE_OFFLINE', message: expect.stringMatching(/the bench fixture fix-s3 is offline/) });
  });

  it('refuses a DUT with a flash, provision, OTA or reset job, and one in a declared power-cut window (LOCKED)', async () => {
    const b = await rig();
    let finish = () => {};
    const job = b.r.jobs.start('flash', [C3.mac], [], () => new Promise<void>((r) => (finish = r)));
    await until(() => b.r.jobs.get(job.job_id).status === 'working', 1000, 'flash working');
    await expect(b.call('input_simulate', gpio('pad-c3', 'click'))).rejects.toMatchObject({ code: 'LOCKED', details: { job: job.job_id }, message: expect.stringMatching(/flash job/) });
    // pad-c6 is not its target.
    await b.call('input_simulate', gpio('pad-c6', 'click'));
    finish();
    await until(() => b.r.jobs.get(job.job_id).status === 'completed', 1000, 'flash done');
    await b.call('input_simulate', gpio('pad-c3', 'click'));
    const end = b.module.declarePowerCut([C3.mac], 60_000);
    await expect(b.call('input_simulate', gpio('pad-c3', 'click'))).rejects.toMatchObject({ code: 'LOCKED', details: { power_cut: true } });
    end();
    await b.call('input_simulate', gpio('pad-c3', 'click'));
    // A window ends by itself too.
    b.module.declarePowerCut([C3.mac], 400);
    await expect(b.call('input_simulate', gpio('pad-c3', 'click'))).rejects.toMatchObject({ code: 'LOCKED' });
    await new Promise((r) => setTimeout(r, 420));
    await b.call('input_simulate', gpio('pad-c3', 'click'));
  });

  it("refuses a line the fixture's running build does not drive as the bench says (its artifact manifest), and bench_get names it", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fr-fix-art-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const b = await rig();
    const ch = (name: string, port: number, config: Record<string, string>) => ({ name, port, cap: 'fr.fixture', cap_id: 6, version: '0.1', driver: 'fixture_gpio', config });
    // A build whose ch0 is an input (a profile edit the bench file never followed), and with no ch2 at all.
    addManifest(b.r.db, dir, { profile: 's3k-fixture', fw: FIX_FW, caps: [ch('ch0', 1, { drive: 'none', decode: 'level' }), ch('ch4', 5, { drive: 'none', decode: 'level' })] });
    await expect(b.call('input_simulate', gpio('pad-c3', 'click'))).rejects.toMatchObject({
      code: 'INCOMPATIBLE_PROFILE',
      message: expect.stringMatching(/^fix-s3 ch0: its firmware \(00112233aabbccdd\) drives ch0 none, the bench line needs open_drain/),
      details: { problem: 'fixture_mismatch', channel: 'ch0' },
    });
    await expect(b.call('input_simulate', gpio('pad-c6', 'click'))).rejects.toMatchObject({ code: 'INCOMPATIBLE_PROFILE', message: expect.stringMatching(/has no fr\.fixture instance ch2/) });
    // Letting go is still safe.
    expect((await b.call('input_simulate', gpio('pad-c3', 'release'))).results[0]).toMatchObject({ status: 'ok' });
    const st = await b.call('bench_get', {});
    expect(st.lines.find((l: any) => l.channel === 'ch0')).toMatchObject({ problem: 'fixture_mismatch' });
    expect(st.lines.find((l: any) => l.channel === 'ch4')).toMatchObject({ problem: null });
    expect(st.problems).toContain('pad-c3 boot: fix-s3 ch0: its firmware (00112233aabbccdd) drives ch0 none, the bench line needs open_drain');
    expect(b.fixture.presses).toHaveLength(0);
  });

  it('refuses a line that does not read released: by readback, and when the fixture says busy', async () => {
    const b = await rig();
    b.fixture.hold('ch0', true);
    await until(() => b.module.driver.lineLevel('ch0') === false, 2000, 'readback low');
    await expect(b.call('input_simulate', gpio('pad-c3', 'click'))).rejects.toMatchObject({
      code: 'DEVICE_BUSY',
      message: expect.stringMatching(/fix-s3 ch0 reads pressed at idle/),
    });
    b.fixture.hold('ch0', false);
    await until(() => b.module.driver.lineLevel('ch0') === true, 2000, 'readback high');
    // Held again where the hub has not heard of it yet: the fixture's own readback check answers BUSY.
    b.fixture.lines.get('ch0')!.held = true;
    await expect(b.call('input_simulate', gpio('pad-c3', 'click'))).rejects.toMatchObject({ code: 'DEVICE_BUSY', message: expect.stringMatching(/answered busy/) });
    expect(b.fixture.busyAnswers).toBe(1);
    b.fixture.lines.get('ch0')!.held = false;
    await b.call('input_simulate', gpio('pad-c3', 'click'));
  });
});

describe('releases (D11 item 2)', () => {
  const pressed = async (b: BenchRig) => {
    await b.call('input_simulate', gpio('pad-c3', 'press'));
    expect(b.module.driver.running('ch0')).toBe(true);
  };

  it("releases a DUT's lines at its node.boot and its USB port's detach", async () => {
    const b = await rig();
    await pressed(b);
    b.c3.event(PORT.NODE, 1, member('fr.node', 'event', 'boot', { reset_reason: 1 }));
    await until(() => b.fixture.releases.length === 1, 2000, 'release at node.boot');
    expect(b.fixture.releases).toEqual(['ch0']);
    // Pressing until the fixture reads it released (its level STATE follows the RESULT).
    await until(() => !b.module.driver.running('ch0'), 1000, 'ch0 reads released');
    expect(b.fixture.lines.get('ch0')!.pressing).toBe(false);
    await pressed(b);
    b.r.events.publish({ type: 'port.detached', device: C3.mac, t_hub_us: Date.now() * 1000, fields: { path: '/dev/cu.usbmodem1', usb_serial: C3.mac } });
    await until(() => b.fixture.releases.length === 2, 2000, 'release at port.detached');
  });

  it("releases a DUT's lines when it goes offline, and every line when the module stops", async () => {
    const b = await rig();
    const mark = b.fixture.frames.length;
    await b.call('input_simulate', gpio('pad-c6', 'press'));
    await pressed(b);
    b.c3.close();
    await until(() => b.fixture.releases.includes('ch0'), 5000, 'release at offline');
    expect(b.fixture.releases).toEqual(['ch0']);
    b.module.stop();
    await until(() => b.fixture.releases.includes('ch2'), 2000, 'release at stop');
    // Only driven lines: LED and test_pin taps get none.
    const releases = b.fixture.frames.slice(mark).filter((f) => f.header.cls === CLS.CMD && f.header.port !== PORT.NODE && f.header.kind === 2);
    expect(releases.map((f) => f.header.port).sort()).toEqual([1, 1, 3]);
  });

  it('releases the lines of a DUT a power-cut window is declared on, before it refuses presses there (§6 rule 3)', async () => {
    const b = await rig();
    await pressed(b);
    const end = b.module.declarePowerCut([C3.mac], 60_000);
    await until(() => b.fixture.releases.includes('ch0'), 2000, 'release at the cut');
    await until(() => !b.fixture.lines.get('ch0')!.pressing, 1000, 'ch0 let go');
    await expect(b.call('input_simulate', gpio('pad-c3', 'click'))).rejects.toMatchObject({ code: 'LOCKED', details: { power_cut: true } });
    // pad-c6 is not in it.
    expect(b.fixture.releases).toEqual(['ch0']);
    end();
  });

  it('a gesture that a release at a DUT event cuts short returns interrupted, with when and why, not ok', async () => {
    const b = await rig();
    const p = b.call('input_simulate', gpio('pad-c3', 'long_press'));
    await new Promise((r) => setTimeout(r, 200));
    // pad-c3 is marked offline for a moment (weak Wi-Fi): D11's release goes out mid-gesture.
    b.r.events.publish({ type: 'device.offline', device: C3.mac, t_hub_us: Date.now() * 1000, fields: { reason: 'timeout' } });
    const res = await p;
    expect(b.fixture.releases).toEqual(['ch0']);
    expect(res.results[0]).toMatchObject({
      status: 'interrupted',
      channel: 'ch0',
      error: expect.stringMatching(/^cut short \d+ ms into the gesture by a release \(device\.offline\)$/),
      interrupted: { reason: 'device.offline', at_hub_us: expect.any(Number), after_us: expect.any(Number) },
      press: { segments_us: [800_000] },
    });
    const after = res.results[0].interrupted.after_us;
    expect(after).toBeGreaterThan(100_000);
    expect(after).toBeLessThan(600_000);
    // An explicit release cuts one short the same way; an uncut gesture stays ok.
    const q = b.call('input_simulate', gpio('pad-c6', 'long_press'));
    await new Promise((r) => setTimeout(r, 150));
    await b.call('input_simulate', gpio('pad-c6', 'release'));
    expect((await q).results[0]).toMatchObject({ status: 'interrupted', interrupted: { reason: 'release' } });
    await until(() => !b.module.driver.running('ch2'), 1000, 'ch2 released');
    expect((await b.call('input_simulate', gpio('pad-c6', 'click'))).results[0]).toMatchObject({ status: 'ok' });
  });
});

/** Drops the fixture's next `n` lines toward the hub (a RESULT lost on the serial line, or late past its time limit). */
function dropFromFixture(b: BenchRig): { drop(n: number): void } {
  const serial = b.r.serial as unknown as { fromNode(device: string, line: string): void };
  const orig = serial.fromNode.bind(serial);
  let left = 0;
  serial.fromNode = (device, line) => {
    if (device === FIX.mac && left > 0) {
      left--;
      return;
    }
    orig(device, line);
  };
  return { drop: (n) => (left = n) };
}

describe('lost answers and dropped sessions (D11 item 2)', () => {
  it('lets a press go whose RESULT never came: a release follows, and the line is pressing until it reads released', async () => {
    const b = await rig();
    const lose = dropFromFixture(b);
    const press = b.fixture.handlers.get('1/1')!;
    b.fixture.handlers.set('1/1', (args, h) => {
      const r = press(args, h);
      lose.drop(1); // the press runs on the fixture; its RESULT is lost
      return r;
    });
    const res = await b.call('input_simulate', { ...gpio('pad-c3', 'press'), timeout_s: 1 });
    expect(res.results[0]).toMatchObject({ status: 'timeout', released: true, channel: 'ch0' });
    // The release reaches the fixture: BOOT is not left held for cap_ms.
    await until(() => b.fixture.releases.includes('ch0'), 3000, 'release after the timeout');
    await until(() => !b.fixture.lines.get('ch0')!.pressing, 1000, 'ch0 let go');
    await until(() => !b.module.driver.running('ch0'), 2000, 'ch0 reads released');
    const st = await b.call('bench_get', {});
    expect(st.lines.find((l: any) => l.channel === 'ch0')).toMatchObject({ state: 'idle', problem: null });
    b.fixture.handlers.set('1/1', press);
    await b.call('input_simulate', gpio('pad-c3', 'click'));
  });

  it('a timed-out release goes once more, and the line stays pressing until it reads released', async () => {
    const b = await rig();
    await b.call('input_simulate', gpio('pad-c3', 'press'));
    const lose = dropFromFixture(b);
    const release = b.fixture.handlers.get('1/2')!;
    let n = 0;
    b.fixture.handlers.set('1/2', (args, h) => {
      const r = release(args, h);
      if (n++ === 0) {
        lose.drop(1); // the first release's RESULT is lost
      }
      return r;
    });
    const rel = await b.call('input_simulate', { ...gpio('pad-c3', 'release'), timeout_s: 1 });
    expect(rel.results[0]).toMatchObject({ status: 'ok', channel: 'ch0' });
    expect(b.fixture.releases).toEqual(['ch0', 'ch0']);
    await until(() => !b.module.driver.running('ch0'), 1000, 'ch0 reads released');
  });

  it('keeps what is pressed across a fixture session that drops without a reboot, and releases every driven line at its WELCOME, before the blink', async () => {
    const b = await rig();
    await b.call('input_simulate', gpio('pad-c3', 'press'));
    await until(() => b.fixture.blinks.length === 1, 2000, 'first blink');
    // The hub loses the fixture's session; the fixture itself keeps running (and holding).
    b.r.serial.unplugPort(FIX.mac);
    await until(() => b.r.router.presence(FIX.mac) === 'offline', 5000, 'fixture offline');
    expect(b.module.driver.running('ch0')).toBe(true);
    const mark = b.fixture.frames.length;
    b.r.serial.attach(b.fixture);
    await b.fixture.connected(b.r.events);
    await until(() => b.fixture.releases.includes('ch0') && b.fixture.releases.includes('ch2') && b.fixture.blinks.length === 2, 3000, 'releases and blink at WELCOME');
    expect(b.fixture.lines.get('ch0')!.pressing).toBe(false);
    // In that order on the line: the releases first, then the identify blink.
    const cmds = b.fixture.frames.slice(mark).filter((f) => f.header.cls === CLS.CMD && f.header.port !== PORT.NODE);
    const firstBlink = cmds.findIndex((f) => f.header.port === 20);
    expect(cmds.slice(0, firstBlink).map((f) => [f.header.port, f.header.kind]).sort()).toEqual([
      [1, 2],
      [3, 2],
    ]);
    await until(() => !b.module.driver.running('ch0'), 1000, 'ch0 reads released');
    const st = await b.call('bench_get', {});
    expect(st.lines.find((l: any) => l.channel === 'ch0')).toMatchObject({ state: 'idle', problem: null });
  });

  it("forgets what is pressed at the fixture's own boot (a reboot releases every line)", async () => {
    const b = await rig();
    await b.call('input_simulate', gpio('pad-c3', 'press'));
    expect(b.module.driver.running('ch0')).toBe(true);
    b.fixture.event(PORT.NODE, 1, member('fr.node', 'event', 'boot', { reset_reason: 1 }));
    await until(() => !b.module.driver.running('ch0'), 2000, 'tracking cleared at the fixture boot');
  });
});

describe('analog lines and input_simulate value/mv (design m2-c3-inputs D5, D7)', () => {
  const ANALOG_IN = findCap('fr.analog_in')!;
  const INJECT = ANALOG_IN.commands.find((c) => c.name === 'inject')!.id;
  const C3_ANALOG = [...PAD_CAPS, { port: 3, cap_id: ANALOG_IN.id, name: 'analog' }];
  /** The bench with pad-c3's analog line wired (ch12, pwm), pad-c3 on c3o-analog with an analog instance on port 3. */
  async function analogRig(patch: (b: Record<string, any>) => void = () => undefined): Promise<BenchRig> {
    const b = await rig({
      bench: testBench((x) => {
        x.duts[C3.mac].lines.analog.wired = true;
        patch(x);
      }),
      c3Caps: C3_ANALOG,
    });
    b.r.registry.get(C3.mac)!.profile = 'c3o-analog';
    return b;
  }
  const set = (selector: string, v: { mv?: number; value?: number }, instance = 'analog') => ({ selector, instance, ...v, layer: 'gpio' });

  it('maps a setpoint to a duty over vdd_mv (rounded, clamped), and lineDrive says pwm for an analog line', () => {
    expect(dutyFor(1650, 3300)).toBe(5000);
    expect(dutyFor(1, 3300)).toBe(3);
    expect(dutyFor(4000, 3300)).toBe(10_000);
    expect(dutyFor(-5, 3300)).toBe(0);
    expect(lineDrive({ role: 'analog', channel: 'ch12', fixture_gpio: 11, dut_gpio: 3, wired: true } as never)).toBe('pwm');
    expect(mvToValue(1250, { min_mv: 0, max_mv: 2500 })).toBe(32768);
    expect(mvToValue(3000, { min_mv: 0, max_mv: 2500 })).toBe(65535);
    expect(valueToMv(65535, { min_mv: 500, max_mv: 1500 })).toBe(1500);
  });

  it('sets the PWM setpoint of the bench line: the duty, and when it was applied in fixture and hub time', async () => {
    const b = await analogRig((x) => {
      x.fixture.vdd_mv = 3300;
    });
    const t0 = Date.now();
    const res = await b.call('input_simulate', set('pad-c3', { mv: 1650 }));
    expect(res.cursor).toMatch(/^c:\d+\.\d+$/);
    expect(res.results).toEqual([
      expect.objectContaining({
        device: C3.mac,
        alias: 'pad-c3',
        status: 'ok',
        layer: 'gpio',
        fixture: 'fix-s3',
        channel: 'ch12',
        fields: { at_us: expect.any(Number) },
        setpoint: { mv: 1650, duty: 5000, vdd_mv: 3300, applied_mv: 1650, at_fix_us: expect.any(Number), at_hub_us: expect.any(Number) },
      }),
    ]);
    const sp = res.results[0].setpoint;
    expect(sp.at_fix_us).toBeGreaterThan(77_000_000); // the full fixture time, unwrapped on its clock
    expect(sp.at_hub_us / 1000).toBeGreaterThanOrEqual(t0 - 50);
    expect(sp.at_hub_us / 1000).toBeLessThanOrEqual(Date.now() + 50);
    expect(b.fixture.duties.map((d) => [d.channel, d.duty])).toEqual([['ch12', 5000]]);
    // A value maps to mV over the instance's range (the capability's 0..2,500 mV without a manifest), then to a duty.
    const full = await b.call('input_simulate', set('pad-c3', { value: 65535 }));
    expect(full.results[0].setpoint).toMatchObject({ mv: 2500, duty: 7576 });
    const top = await b.call('input_simulate', set('pad-c3', { mv: 5500 }));
    expect(top.results[0].setpoint).toMatchObject({ duty: 10_000, applied_mv: 3300 });
    // bench_get: the line drives pwm, its last duty, active while above 0.
    await until(() => b.module.driver.lineLevel('ch12') === true, 1000, 'ch12 level');
    let st = await b.call('bench_get', {});
    expect(st.lines.find((l: any) => l.channel === 'ch12')).toMatchObject({ role: 'analog', drive: 'pwm', duty: 10_000, state: 'active', problem: null });
    // The module's own entry (T-ANALOG's setpoints): mv 0 is duty 0.
    const zero = (await b.module.setMv(b.r.registry.get(C3.mac)!, 'analog', 0)) as any;
    expect(zero.setpoint).toMatchObject({ mv: 0, duty: 0 });
    await until(() => b.module.driver.lineLevel('ch12') === false, 1000, 'ch12 level low');
    st = await b.call('bench_get', {});
    expect(st.lines.find((l: any) => l.channel === 'ch12')).toMatchObject({ duty: 0, state: 'idle' });
    expect(b.fixture.presses).toHaveLength(0);
  });

  it('gates a setpoint: an analog line only, the DUT on its line profile; mv 0 always', async () => {
    const b = await analogRig();
    // A gesture on the analog line, a setpoint on the BOOT line: each is the other capability (invalid_input).
    await expect(b.call('input_simulate', gpio('pad-c3', 'click', 'analog'))).rejects.toMatchObject({
      code: 'INVALID_ARGS',
      details: { reason: 'invalid_input', results: [{ alias: 'pad-c3', status: 'invalid_input' }] },
    });
    await expect(b.call('input_simulate', set('pad-c3', { mv: 100 }, 'boot'))).rejects.toMatchObject({ code: 'INVALID_ARGS', details: { reason: 'invalid_input' } });
    // pad-c6 has no analog line on the bench.
    await expect(b.call('input_simulate', set('pad-c6', { mv: 100 }))).rejects.toMatchObject({ code: 'NOT_FOUND', details: { not_wired: true } });
    // On its bench profile (c3o-pad) the DUT's pin is no ADC input: refused, but letting go is not.
    b.r.registry.get(C3.mac)!.profile = 'c3o-pad';
    await expect(b.call('input_simulate', set('pad-c3', { mv: 100 }))).rejects.toMatchObject({
      code: 'INCOMPATIBLE_PROFILE',
      details: { problem: 'profile_mismatch', profile: 'c3o-pad', bench_profile: 'c3o-analog' },
    });
    expect((await b.call('input_simulate', set('pad-c3', { mv: 0 }))).results[0]).toMatchObject({ status: 'ok', setpoint: { duty: 0 } });
    b.r.registry.get(C3.mac)!.profile = 'c3o-analog';
    // No gesture reaches an analog line, and no setpoint a button line (even past the capability check).
    expect(() => b.module.driver.gate(b.r.registry.get(C3.mac)!, 'analog', 'release')).toThrow(/analog line, not a button/);
    expect(() => b.module.driver.gateAnalog(b.r.registry.get(C3.mac)!, 'boot', 100)).toThrow(/button line, not an analog one/);
    expect(b.fixture.presses).toHaveLength(0);
  });

  it("refuses a fixture build that does not drive the line's channel pwm (its artifact manifest), and takes one that does", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fr-fix-art-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const ch = (name: string, port: number, config: Record<string, string>) => ({ name, port, cap: 'fr.fixture', cap_id: 6, version: '0.2', driver: 'fixture_gpio', config });
    const caps = [ch('ch0', 1, { drive: 'open_drain' }), ch('ch2', 3, { drive: 'open_drain' })];
    const none = await analogRig();
    addManifest(none.r.db, dir, { profile: 's3k-fixture', fw: FIX_FW, caps: [...caps, ch('ch12', 13, { drive: 'none', decode: 'level' })] });
    await expect(none.call('input_simulate', set('pad-c3', { mv: 100 }))).rejects.toMatchObject({
      code: 'INCOMPATIBLE_PROFILE',
      message: expect.stringMatching(/drives ch12 none, the bench line needs pwm/),
      details: { problem: 'fixture_mismatch', channel: 'ch12' },
    });
    const st = await none.call('bench_get', {});
    expect(st.lines.find((l: any) => l.channel === 'ch12')).toMatchObject({ problem: 'fixture_mismatch', drive: 'pwm' });
    const dir2 = mkdtempSync(join(tmpdir(), 'fr-fix-art-'));
    cleanups.push(() => rmSync(dir2, { recursive: true, force: true }));
    const pwm = await analogRig();
    addManifest(pwm.r.db, dir2, { profile: 's3k-fixture', fw: FIX_FW, caps: [...caps, ch('ch12', 13, { drive: 'pwm' })] });
    expect((await pwm.call('input_simulate', set('pad-c3', { mv: 100 }))).results[0]).toMatchObject({ status: 'ok', setpoint: { duty: 303 } });
  });

  it('sets every pwm line to duty 0 at the release paths (DUT boot or offline, module stop), never with `release`', async () => {
    const b = await analogRig();
    await b.call('input_simulate', set('pad-c3', { mv: 1000 }));
    b.c3.event(PORT.NODE, 1, member('fr.node', 'event', 'boot', { reset_reason: 1 }));
    await until(() => b.fixture.duties.at(-1)?.duty === 0, 2000, 'duty 0 at node.boot');
    expect(b.module.driver.duty('ch12')).toBe(0);
    await b.call('input_simulate', set('pad-c3', { mv: 1000 }));
    b.module.stop();
    await until(() => b.fixture.duties.at(-1)?.duty === 0 && b.fixture.duties.length === 4, 2000, 'duty 0 at stop'); // 1000, 0, 1000, 0
    expect(b.fixture.releases).not.toContain('ch12');
    expect(b.fixture.lines.get('ch12')!.duty).toBe(0);
  });

  it('inject: value or mv over the manifest range, hold_ms passed on, per-device invalid_input, and the input rules', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fr-fix-art-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const fw = 'c3c3c3c3aabbccdd';
    const b = await rig({ c3: { fwPrefix: fw }, c3Caps: C3_ANALOG });
    const got: unknown[] = [];
    b.c3.handlers.set(`3/${INJECT}`, (args) => {
      const d = decodeAnalogInInjectArgs(args);
      got.push(d.ok ? d.value : d.error);
    });
    const res = await b.call('input_simulate', { selector: 'pad-c3', instance: 'analog', mv: 1250, hold_ms: 5000 });
    expect(res.results).toEqual([expect.objectContaining({ alias: 'pad-c3', status: 'ok', value: 32768 })]);
    await b.call('input_simulate', { selector: 'pad-c3', instance: 'analog', value: 50_000 });
    expect(got).toEqual([
      { value: 32768, hold_ms: 5000 },
      { value: 50_000, hold_ms: 0 },
    ]);
    // The running firmware's manifest range: 500..1,500 mV.
    addManifest(b.r.db, dir, {
      profile: 'c3o-analog',
      fw,
      target: 'esp32c3',
      caps: [{ name: 'analog', port: 3, cap: 'fr.analog_in', cap_id: ANALOG_IN.id, version: '1.0', driver: 'adc_oneshot', config: { min_mv: 500, max_mv: 1500, thresholds: [16384] } }],
    });
    expect((await b.call('input_simulate', { selector: 'pad-c3', instance: 'analog', mv: 1000 })).results[0].value).toBe(32768);
    expect((await b.call('input_simulate', { selector: 'pad-c3', instance: 'analog', mv: 100 })).results[0].value).toBe(0);
    // A device whose `analog` is a button is invalid_input; the others still get theirs, in selection order.
    const x = b.r.pad({ mac: 'a0b1c2d3e4f6', addr: 0x0091, alias: 'pad-x', caps: [{ port: 3, cap_id: findCap('fr.button')!.id, name: 'analog' }] });
    await x.connected(b.r.events);
    const mixed = await b.call('input_simulate', { selector: 'pad-c3,pad-x', instance: 'analog', value: 1 });
    expect(mixed.results.map((r: any) => `${r.alias} ${r.status}`)).toEqual(['pad-c3 ok', 'pad-x invalid_input']);
    expect(x.received(CLS.CMD).filter((f) => f.header.port === 3)).toEqual([]);
    // Exactly one of gesture, value, mv; hold_ms only with a value on inject.
    for (const bad of [
      { instance: 'analog' },
      { instance: 'analog', value: 1, mv: 1 },
      { instance: 'boot', gesture: 'click', hold_ms: 100 },
      { instance: 'analog', mv: 100, hold_ms: 100, layer: 'gpio' },
    ]) {
      await expect(b.call('input_simulate', { selector: 'pad-c3', ...bad })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    }
    await expect(b.call('input_simulate', { selector: 'pad-c3', instance: 'analog', value: 65536 })).rejects.toThrow();
    // The fixture stays fenced: no client command_send reaches its pwm channel.
    await expect(b.call('command_send', { selector: 'fix-s3', command: 'ch12.set_duty', args: { duty: 5000 } })).rejects.toMatchObject({
      code: 'INVALID_ARGS',
      details: { reason: 'fixture_internal' },
    });
    expect(b.fixture.duties).toEqual([]);
  });
});
