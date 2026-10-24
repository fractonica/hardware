// The HIL bench end to end on a real hub process (design m2-c1-hil §5.1, I1): hil-rig.ts's loopback bench, i.e.
// packages/hub/src/main.ts as real-hub.ts runs it (port 0, loopback, its own FR_HOME), loading this checkout's lab
// bench (hardware/bench/lab.bench.yaml, the default), with four C++ pads (fr_net_node, one per bench DUT, on the
// DUTs' MACs and bench profiles, over TCP/UDP) and the serial-only C++ virtual fixture (fr_net_node --serial 1
// --fixture 1: S1's FixtureService on fake lines), whose USB-Serial/JTAG port reaches the hub through the serial
// bridge (virtual-usb.ts, `--serial-bridge`). The wires are loopback datagrams: each BOOT channel drives a pad's
// --pin-listen, each pad's --led-tap and --test-pin-tap feed the fixture's LED and test_pin channels.
// It checks, through the hub's REST API only:
//   - bench_get: the fixture online over serial with its clock published, every wired line idle, every
//     `wired: false` line reserved, and no problem but the fixture's firmware (the virtual fixture runs no
//     pinned s3k-fixture build: fw_ok false, whether the lab bench pins one or not);
//   - input_simulate {layer: gpio} clicks give down, up and click on each DUT, with op.called {layer: gpio}; a
//     held press and its release return both edges, so the hold is their fixture-time difference;
//   - the press-based fit converges on each DUT;
//   - LED changes come back as hil.edge (C3 led_gpio taps) and hil.frame (C6/S3 WS2812) within 5 ms of their
//     status.on STATE on the fit, and the frame carries the scaled colour;
//   - pin_pulse on two debug pads at once lands on each one's own channel;
//   - command_send (and the rest of the fence) to the fixture is refused;
//   - cancel releases every line: a DUT going offline releases its own, the hub stopping releases the rest,
//     well before the fixture's own 2 s rule would.
// `pnpm test:host` builds the binary; without it the suite is skipped.

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readBench } from '@fractonica/host';
import type { Bench, BenchStatus } from '@fractonica/protocol';

import type { Hub } from '../../../tests/e2e/lib/hub.ts';
import { BIN } from './cpp-node.ts';
import { until } from './fake-node.ts';
import { fixtureLines, type HilRig, startHilRig } from './hil-rig.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BENCH: Bench | null = readBench(REPO, 'lab').bench as Bench | null;

type Ev = { cursor: string; seq: number; type: string; device?: string; alias?: string; t_hub_us: number; t_dev_us?: number; resync?: boolean; fields?: Record<string, unknown> };

const cmp32 = (a: number, b: number) => (a - b) | 0;

/** until() for an async condition: polls every 50 ms. */
async function eventually<T>(cond: () => Promise<T>, timeoutMs: number, what: string): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await cond();
    if (v) {
      return v as NonNullable<T>;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** The events after `since`, every page. */
async function eventsSince(api: Hub, since: string, types: string, selector?: string): Promise<Ev[]> {
  const out: Ev[] = [];
  let cursor = since;
  for (;;) {
    const r = await api.ok<{ events: Ev[]; next_cursor: string; truncated: boolean }>('events_read', { since: cursor, types, ...(selector ? { selector } : {}), max_events: 1000 });
    out.push(...r.events);
    if (!r.truncated) {
      return out;
    }
    cursor = r.next_cursor;
  }
}

async function cursorNow(api: Hub): Promise<string> {
  return (await api.call('hub_status', {})).cursor;
}

const f = (e: Ev) => e.fields ?? {};

describe.skipIf(!existsSync(BIN) || !BENCH)('the HIL bench on a real hub: four C++ pads and the serial-only virtual fixture (M2-C1)', () => {
  let rig: HilRig;
  beforeAll(async () => {
    rig = await startHilRig(BENCH!);
  }, 120_000);
  afterAll(async () => {
    await rig?.stop();
  });

  it('bench_get: the fixture online over serial with its clock, every wired line idle, every wired: false line reserved', async () => {
    const { hub, fix } = rig;
    // The fixture's session is the virtual USB port: the hub lists it as an Espressif port and holds it open.
    const ports = await hub.api.ok<{ ports: { device_id?: string; state: string; path: string }[] }>('port_list', {});
    expect(ports.ports.find((p) => p.device_id === fix)).toMatchObject({ state: 'open', path: `/dev/cu.usbmodem-fr-${fix}` });
    const dev = await hub.api.ok<{ role: string; router: { links: string[] } }>('device_get', { device: 'fix-s3' });
    expect(dev).toMatchObject({ role: 'fixture', router: { links: ['serial'] } });
    // The identify blink at the fixture's WELCOME (D9): status.blink {count: 3} on its own LED.
    await until(() => rig.fixture.of('led').filter((l) => l.on === true).length >= 3, 5000, "the fixture's identify blink");
    // A TIME burst has run on that session by the time every line reads its level.
    const st = await eventually(
      async () => {
        const s = await hub.api.ok<BenchStatus>('bench_get', {});
        return s.clock && s.lines.every((l) => l.state === 'idle' || l.state === 'reserved') ? s : undefined;
      },
      15_000,
      'every line idle',
    );
    // The virtual fixture is no build the bench can pin (D1): fw_ok is false, pinned or not (protocol-gaps-3).
    const pinned = BENCH!.fixture.fw_id !== null;
    expect(st.fixture).toMatchObject({ device: fix, alias: 'fix-s3', presence: 'online', profile: 's3k-fixture', fw_ok: false, fw_pinned: pinned });
    expect(st.fixture.boot_at).toEqual(expect.any(String));
    expect(st.clock).toMatchObject({ uncertainty_us: expect.any(Number), rtt_min_us: expect.any(Number) });
    expect(st.clock!.uncertainty_us).toBeLessThan(5000);
    const wired = st.lines.filter((l) => l.wired);
    const reserved = st.lines.filter((l) => !l.wired);
    // As this checkout's bench file says (the rig as wired, which the rig is built from; §2.3 had 12 wired and
    // ch12-ch14 reserved): never fixed channels, since the file follows the bench.
    const fileLines = Object.values(BENCH!.duts).flatMap((d) => Object.values(d.lines));
    expect(wired).toHaveLength(fileLines.filter((l) => l.wired).length);
    expect(reserved.map((l) => l.channel).sort()).toEqual(fileLines.filter((l) => !l.wired).map((l) => l.channel).sort());
    for (const l of wired) {
      expect(l, `${l.alias} ${l.line}`).toMatchObject({ state: 'idle', problem: null });
    }
    // Released BOOT lines and test_pin pull-ups read high; the active-low LED taps (the C3s') read their off level: high.
    const lowTaps = new Set(fileLines.filter((l) => l.wired && l.role === 'led' && l.active_level === 'low').map((l) => l.channel));
    expect(lowTaps.size).toBeGreaterThan(0);
    for (const l of wired.filter((x) => x.role === 'button' || x.role === 'test_pin' || lowTaps.has(x.channel))) {
      expect(l.level, `${l.alias} ${l.line}`).toBe(true);
    }
    for (const l of reserved) {
      expect(l).toMatchObject({ state: 'reserved', level: null, problem: null });
    }
    expect(st.duts.map((d) => [d.alias, d.presence, d.problem, d.running_profile])).toEqual(
      rig.pads.map((p) => [p.alias, 'online', null, p.profile]),
    );
    expect(st.problems).toEqual([expect.stringMatching(pinned ? /^fix-s3: runs \S+, not the bench's pinned fw_id/ : /^fix-s3: the bench pins no fixture fw_id: pin the build it runs/)]);
    expect(st.stale).toBeNull();
    expect(st.ok).toBe(false);
  }, 30_000);

  it('gpio clicks give down, up and click on every DUT, and op.called says layer gpio and the client', async () => {
    const { mcp, pads, hub } = rig;
    for (const p of pads) {
      const r = await mcp.call<{ results: Record<string, unknown>[]; cursor: string }>('input_simulate', { selector: p.alias, instance: 'boot', gesture: 'click', layer: 'gpio' });
      expect(r.ok, JSON.stringify(r.error)).toBe(true);
      expect(r.data!.results).toEqual([
        expect.objectContaining({ device: p.mac, status: 'ok', layer: 'gpio', fixture: 'fix-s3', channel: p.boot, press: expect.objectContaining({ segments_us: [80_000], total_us: 80_000 }) }),
      ]);
      const since = r.data!.cursor;
      const evs = await eventually(
        async () => {
          const e = (await eventsSince(hub.api, since, 'boot.*', p.alias)).filter((x) => ['boot.down', 'boot.up', 'boot.click'].includes(x.type));
          return e.some((x) => x.type === 'boot.click') ? e : undefined;
        },
        5000,
        `${p.alias} click`,
      );
      expect(evs.map((e) => e.type)).toEqual(['boot.down', 'boot.up', 'boot.click']);
      expect(f(evs[2])).toMatchObject({ count: 1 });
      // up.held_ms is the fixture's 80 ms hold, within the DUT's debounce (20 ms) + 2 ms.
      expect(Math.abs(Number(f(evs[1]).held_ms) - 80)).toBeLessThanOrEqual(22);
      const called = (await eventsSince(hub.api, since, 'op.called', p.alias)).map(f);
      expect(called).toEqual([expect.objectContaining({ op: 'input_simulate', client: 'mcp', instance: 'boot', gesture: 'click', layer: 'gpio' })]);
      // The fixture reads its own press back: hil.edge low then high on the BOOT line, on the DUT.
      const edges = (await eventsSince(hub.api, since, 'hil.edge', p.alias)).filter((e) => f(e).line === 'boot');
      expect(edges.map((e) => f(e).level)).toEqual([false, true]);
      expect(cmp32(Number(f(edges[1]).t_fix_us), Number(f(edges[0]).t_fix_us))).toBeGreaterThanOrEqual(79_000);
    }
  }, 60_000);

  it("returns a held press's edge and its release's edge: the hold is their fixture-time difference", async () => {
    const { mcp, pads } = rig;
    const p = pads[1];
    const held = await mcp.ok<{ results: { status: string; press: { t_fix_us: number } }[] }>('input_simulate', { selector: p.alias, instance: 'boot', gesture: 'press', layer: 'gpio' });
    expect(held.results[0].status).toBe('ok');
    await new Promise((r) => setTimeout(r, 300));
    const rel = await mcp.ok<{ results: { status: string; press?: { t_fix_us: number; segments_us: number[] } }[] }>('input_simulate', { selector: p.alias, instance: 'boot', gesture: 'release', layer: 'gpio' });
    expect(rel.results[0]).toMatchObject({ status: 'ok', press: { t_fix_us: expect.any(Number), segments_us: [] } });
    const holdUs = cmp32(rel.results[0].press!.t_fix_us, held.results[0].press.t_fix_us);
    expect(holdUs, `${p.alias} hold ${holdUs} us`).toBeGreaterThanOrEqual(290_000);
    expect(holdUs, `${p.alias} hold ${holdUs} us`).toBeLessThan(1_000_000);
    // Past the DUT's multi-press gap, so the next test's clicks are their own.
    await new Promise((r) => setTimeout(r, 400));
  }, 30_000);

  it('converges the press-based fit on every DUT: valid, small residuals, wired DUT times on the BOOT edges', async () => {
    const { mcp, pads, hub } = rig;
    const since = await cursorNow(hub.api);
    // All DUTs at once, as T-HIL's fit phase runs them: 8 more clicks each, past each other's multi-press gap
    // (the earlier one counts too). Each pad stamps a press at its datagram's arrival (fr_net_node recv_stamped, as
    // a GPIO ISR stamps the edge), so a pad poll() wakes late on a loaded host stamps it no later. A host process
    // preempted between stamping an edge and sending it can still put a sample off now and then: such a sample is
    // rejected (late_stamps), as an edge stamped late on a DUT would be, and the others still make the fit.
    const CLICKS = 8;
    for (let i = 0; i < CLICKS; i++) {
      const r = await mcp.call('input_simulate', { selector: pads.map((p) => p.alias).join(','), instance: 'boot', gesture: 'click', layer: 'gpio' });
      expect(r.ok, JSON.stringify(r.error)).toBe(true);
      await new Promise((res) => setTimeout(res, 200));
    }
    let last: BenchStatus | null = null;
    const st = await eventually(
      async () => {
        last = await hub.api.ok<BenchStatus>('bench_get', {});
        return last.duts.every((d) => d.fit?.valid) ? last : undefined;
      },
      10_000,
      'every fit valid',
    ).catch((e: Error) => {
      throw new Error(`${e.message}: ${JSON.stringify(last?.duts.map((d) => [d.alias, d.fit]))}`);
    });
    for (const d of st.duts) {
      const fit = d.fit!;
      const why = `${d.alias} ${JSON.stringify(fit)}`;
      // D10: valid with >= 4 accepted samples, the newest <= 10 s old (9 presses were made).
      expect(fit, why).toMatchObject({ valid: true });
      expect(fit.samples, why).toBeGreaterThanOrEqual(4);
      // Two processes on one Mac's clock, a loopback hop apart: residuals of tens of µs (T-HIL's gate on the bench
      // is 500 µs; a process preempted between its stamp and its send on a loaded host, now and then, hence 2 ms
      // here), a late sample rejected at most; the skew (published, not gated) is noise over seconds.
      expect(fit.residual_p99_us, why).toBeLessThan(2000);
      expect(fit.rejected, why).toBeLessThanOrEqual(3);
    }
    // Each DUT's down falls within 2 ms after the fixture's press edge on the fit (§5.2 phase 2): the median of
    // the presses read on the wired fit, so one sample a preempted host process put off does not decide it.
    for (const p of pads) {
      const downs = (await eventsSince(hub.api, since, 'boot.down', p.alias)).filter((e) => !f(e).replayed && e.t_dev_us !== undefined);
      const presses = (await eventsSince(hub.api, since, 'hil.edge', p.alias)).filter((e) => f(e).line === 'boot' && f(e).level === false);
      expect(presses.length, p.alias).toBe(CLICKS);
      expect(f(presses.at(-1)!).sync, p.alias).toBe('wired');
      const lags = presses
        .filter((e) => f(e).sync === 'wired')
        .map((e) => {
          const down = downs.find((d) => Math.abs(cmp32(d.t_dev_us!, Number(f(e).t_dut_us))) < 50_000)!;
          return cmp32(down.t_dev_us!, Number(f(e).t_dut_us));
        })
        .sort((a, b) => a - b);
      const median = lags[Math.floor(lags.length / 2)];
      expect(median, `${p.alias} ${JSON.stringify(lags)}`).toBeGreaterThanOrEqual(-500);
      expect(median, `${p.alias} ${JSON.stringify(lags)}`).toBeLessThanOrEqual(2000);
      expect(lags[0], `${p.alias} ${JSON.stringify(lags)}`).toBeGreaterThanOrEqual(-2000);
      expect(lags.at(-1), `${p.alias} ${JSON.stringify(lags)}`).toBeLessThanOrEqual(10_000);
    }
  }, 60_000);

  it('turns LED changes into hil.edge (C3 taps) and hil.frame (WS2812) within 5 ms of their status.on STATE on the fit', async () => {
    const { mcp, pads, hub } = rig;
    // Red, then green, at brightness 255, capped at max_brightness 64 on the WS2812 pads: GRB 0x004000, 0x400000.
    const sets = [
      { on: true, color: 0xff0000, brightness: 255 },
      { on: false },
      { on: true, color: 0x00ff00, brightness: 255 },
      { on: false },
    ];
    // A click on every DUT first, so the fit is fresh (≤ 10 s old) through the readings, as T-HIL's keepFit does.
    expect((await mcp.call('input_simulate', { selector: pads.map((p) => p.alias).join(','), instance: 'boot', gesture: 'click', layer: 'gpio' })).ok).toBe(true);
    await eventually(async () => (await hub.api.ok<BenchStatus>('bench_get', {})).duts.every((d) => d.fit?.valid), 5000, 'every fit valid');
    for (const p of pads) {
      const since = await cursorNow(hub.api);
      const sent0 = p.node.of('led_sent').length;
      for (const args of sets) {
        await mcp.ok('command_send', { selector: p.alias, command: 'status.set', args });
        await new Promise((res) => setTimeout(res, 30));
      }
      const type = p.status.decode === 'ws2812' ? 'hil.frame' : 'hil.edge';
      const readings = await eventually(
        async () => {
          const r = (await eventsSince(hub.api, since, type, p.alias)).filter((e) => f(e).line === 'status');
          return r.length >= sets.length ? r : undefined;
        },
        5000,
        `${p.alias} LED readings`,
      );
      const states = (await eventsSince(hub.api, since, 'status.on', p.alias)).filter((e) => !e.resync);
      expect(states.map((s) => f(s).value ?? f(s).on), p.alias).toEqual([true, false, true, false]);
      if (p.status.decode === 'ws2812') {
        expect(readings.map((r) => [f(r).grb, f(r).lit, f(r).bits]), p.alias).toEqual([
          [0x004000, true, 24],
          [0, false, 24],
          [0x400000, true, 24],
          [0, false, 24],
        ]);
      } else {
        // led_gpio, active low: lit is a low pin.
        expect(readings.map((r) => [f(r).level, f(r).lit]), p.alias).toEqual([
          [false, true],
          [true, false],
          [false, true],
          [true, false],
        ]);
      }
      // STATE time less reading time on the wired fit: within 5 ms (§5.2 phase 3), every change. The fixture stamps
      // its reading at the tap datagram's arrival and the pad its STATE right after the LED write sent that datagram
      // (line `led_sent`: the pin's change on the pad's clock), so neither moves with a late wake. Only a pad held up
      // between its pin change and its STATE (preempted on a loaded Mac: its own record shows it, > 1 ms) has a
      // STATE that is no stamp of the change; that change is judged on the pad's pin change instead, within 5 ms
      // all the same.
      await until(() => p.node.of('led_sent').length >= sent0 + sets.length, 5000, `${p.alias} led_sent lines`);
      const pins = p.node.of('led_sent').slice(sent0).map((l) => Number(l.at_us));
      expect(pins, p.alias).toHaveLength(sets.length);
      const rows = readings.map((r, i) => {
        expect(f(r).sync, p.alias).toBe('wired');
        const state = states[i].t_dev_us!;
        const reading = Number(f(r).t_dut_us);
        return { held: cmp32(state, pins[i]), state: cmp32(state, reading), pin: cmp32(pins[i], reading) };
      });
      const why = `${p.alias} ${JSON.stringify(rows)} (us; held: STATE - pin change, state: STATE - reading, pin: pin change - reading)`;
      for (const row of rows) {
        expect(row.held, why).toBeGreaterThanOrEqual(0);
        expect(Math.abs(row.held <= 1000 ? row.state : row.pin), why).toBeLessThanOrEqual(5000);
      }
    }
  }, 60_000);

  it('lands pin_pulse on two debug pads at once on their own test_pin channels', async () => {
    const { mcp, pads, hub } = rig;
    const two = pads.filter((p) => p.alias === 'pad-c3' || p.alias === 'pad-c6');
    expect(two).toHaveLength(2);
    const since = await cursorNow(hub.api);
    const res = await Promise.all(two.map((p) => mcp.ok<{ response: Record<string, unknown> }>('diag_exec', { port: p.alias, line: 'pin_pulse 1000' })));
    for (const r of res) {
      expect(r.response).toMatchObject({ ok: true, us: 1000 });
    }
    for (const p of two) {
      const edges = await eventually(
        async () => {
          const e = (await eventsSince(hub.api, since, 'hil.edge', p.alias)).filter((x) => f(x).line === 'test_pin');
          return e.length >= 2 ? e : undefined;
        },
        5000,
        `${p.alias} test_pin edges`,
      );
      expect(edges.map((e) => [f(e).channel, f(e).level]), p.alias).toEqual([
        [p.testPin, false],
        [p.testPin, true],
      ]);
      const width = cmp32(Number(f(edges[1]).t_fix_us), Number(f(edges[0]).t_fix_us));
      expect(width, p.alias).toBeGreaterThanOrEqual(500);
      expect(width, p.alias).toBeLessThanOrEqual(1500);
    }
    // Nothing on the other DUTs' test_pin lines.
    for (const p of pads.filter((x) => !two.includes(x))) {
      expect((await eventsSince(hub.api, since, 'hil.edge', p.alias)).filter((x) => f(x).line === 'test_pin'), p.alias).toEqual([]);
    }
    const st = await hub.api.ok<BenchStatus>('bench_get', {});
    for (const p of two) {
      expect(st.duts.find((d) => d.device === p.mac)!.fit, p.alias).toMatchObject({ pin_samples: 1 });
    }
  }, 30_000);

  it('refuses client commands to the fixture (the fence): command_send, diag_exec beyond info/stats/selftest, binding_set', async () => {
    const { mcp, fixture } = rig;
    const dispatched = fixture.of('dispatch').length;
    const sent = await mcp.call('command_send', { selector: 'fix-s3', command: 'ch0.press', args: { segments_us: [80_000] } });
    expect(sent).toMatchObject({ ok: false, error: { code: 'INVALID_ARGS', details: { reason: 'fixture_internal' } } });
    expect(JSON.stringify(sent.error)).toContain('input_simulate');
    // role:fixture names it explicitly: still refused.
    expect(await mcp.call('command_send', { selector: 'role:fixture', command: 'status.blink', args: { count: 1 } })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGS', details: { reason: 'fixture_internal' } },
    });
    expect(await mcp.call('diag_exec', { port: 'fix-s3', line: 'reboot' })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGS', details: { reason: 'fixture_internal' } } });
    expect(await mcp.call('diag_exec', { port: 'fix-s3', line: 'info' })).toMatchObject({ ok: true, data: { response: { test_pin: -1 } } });
    // By its device id, the port the hub holds open: fr_diag's serial command channel on the virtual USB line.
    expect(await mcp.call('diag_exec', { port: rig.fix, line: 'info' })).toMatchObject({ ok: true, data: { via: 'serial', response: { ok: true, test_pin: -1 } } });
    expect(await mcp.call('diag_exec', { port: rig.fix, line: 'net drop_hub_link 5' })).toMatchObject({ ok: false, error: { details: { reason: 'fixture_internal' } } });
    expect(await mcp.call('binding_set', { from: 'pad-c6.boot.down', to: 'fix-s3.status.blink', args: { count: 1 } })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGS', details: { reason: 'fixture_internal' } },
    });
    // `all` never includes the fixture: a broadcast command reaches the four pads only.
    const all = await mcp.ok<{ results: { device: string }[] }>('command_send', { selector: 'all', command: 'status.set', args: { on: false } });
    expect(all.results.map((x) => x.device).sort()).toEqual(rig.pads.map((p) => p.mac).sort());
    // None of it reached the fixture's firmware.
    expect(fixture.of('dispatch').slice(dispatched).filter((l) => l.port !== 241)).toEqual([]);
  }, 30_000);

  it('releases every line on cancel: a DUT going offline releases its own, the hub stopping releases the rest', async () => {
    const { mcp, pads, hub, fixture } = rig;
    // A held press on every BOOT line (a real hold: down now, long_press at 600 ms).
    const held = await mcp.call<{ results: { status: string; channel: string }[] }>('input_simulate', { selector: pads.map((p) => p.alias).join(','), instance: 'boot', gesture: 'press', layer: 'gpio' });
    expect(held.ok, JSON.stringify(held.error)).toBe(true);
    expect(held.data!.results.map((r) => r.status)).toEqual(pads.map(() => 'ok'));
    const levels = () => fixtureLines(fixture);
    await until(() => pads.every((p) => p.node.of('pin_in').at(-1)?.level === 0), 3000, 'every boot input held');
    const st = await hub.api.ok<BenchStatus>('bench_get', {});
    expect(st.lines.filter((l) => l.role === 'button').map((l) => l.state)).toEqual(pads.map(() => 'active'));
    // A second press on a held line is refused before it reaches the fixture.
    expect(await mcp.call('input_simulate', { selector: pads[0].alias, instance: 'boot', gesture: 'click', layer: 'gpio' })).toMatchObject({ ok: false, error: { code: 'DEVICE_BUSY' } });

    // One DUT loses power (killed: no BYE): the hub releases its line at device.offline; the others stay held.
    const gone = pads[0];
    gone.board.power(false);
    gone.node.stop();
    await eventually(async () => (await levels())[gone.boot].level === true, 30_000, `${gone.boot} released at ${gone.alias}'s device.offline`);
    const now = await levels();
    for (const p of pads.slice(1)) {
      expect(now[p.boot], p.alias).toMatchObject({ level: false, pressing: true });
    }
    // The hub stops (fr hub stop): its fixture module releases every line before the router goes down.
    const t0 = Date.now();
    const lines0 = fixture.of('dispatch').length;
    expect(await hub.stop()).toBe(0);
    const after = await levels();
    for (const p of pads) {
      expect(after[p.boot], p.alias).toMatchObject({ level: true, pressing: false });
    }
    // By the hub's `release` commands, not the fixture's own rule 2 s after its session went.
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(fixture.of('dispatch').slice(lines0).filter((l) => l.cmd === 2).length).toBeGreaterThanOrEqual(pads.length - 1);
    for (const p of pads.slice(1)) {
      expect(p.node.of('pin_in').at(-1), p.alias).toMatchObject({ level: 1 });
    }
  }, 90_000);
});
