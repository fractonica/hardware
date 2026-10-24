// fr_net_node's M2-C1 modes against the TS router on loopback (design m2-c1-hil §4 S2): the serial-only node a
// radio-off build is (online over USB alone, no `wifi` in HELLO, NET health from the serial WELCOME, so an image on
// probation is marked valid rather than rolled back), the HELLO role, board and profile flags, the pads' taps (the
// LED pin as led_gpio or led_ws2812 drives it, pin_pulse on the test pin) and the boot input a fixture's open-drain
// line holds down; then the virtual fixture (S1's FixtureService on fake lines): its presses drive a pad's boot
// button through the pin wire, and its taps turn the pad's LED and test pin into fr.fixture edges and frames.
// `pnpm test:host` builds the binary; without it the suite is skipped.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { HubEvent } from '../src/context.ts';
import { HANDLERS } from '../src/ops.ts';
import { sendCommandTo } from '../src/router/ops.ts';
import { BIN, CppNode, serialToRouter, WireTap } from './cpp-node.ts';
import { rig, type Rig, until, waitForEvent } from './fake-node.ts';

const rigs: Rig[] = [];
const nodes: CppNode[] = [];
const taps: WireTap[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const n of nodes.splice(0)) {
    n.stop();
  }
  for (const t of taps.splice(0)) {
    t.close();
  }
  for (const r of rigs.splice(0)) {
    await r.close();
  }
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

async function serialRig(): Promise<Rig> {
  const r = await rig({ serialOnly: true });
  rigs.push(r);
  return r;
}

async function tap(): Promise<WireTap> {
  const t = await WireTap.open();
  taps.push(t);
  return t;
}

/** A serial-only node (no --hub-tcp/--hub-udp) on the rig's fake USB line; resolves once it is online. */
async function serialNode(r: Rig, mac: string, addr: number, extra: string[] = [], opts: { online?: boolean } = {}): Promise<CppNode> {
  const online = opts.online === false ? null : waitForEvent(r.events, (e) => e.type === 'device.online' && e.device === mac, 8000);
  const node = new CppNode(['--serial', '1', '--mac', mac, '--addr', String(addr), '--net', '0', '--hb-ms', '200', '--epoch', '3', ...extra]);
  nodes.push(node);
  serialToRouter(node, mac, r);
  await online;
  return node;
}

const send = (r: Rig, mac: string, command: string, args: Record<string, unknown> = {}) =>
  HANDLERS.command_send({ selector: r.registry.get(mac)!.alias, command, args, ack: 'result', timeout_s: 3, duplicate: false }, r.hub) as Promise<{
    results: { status: string; link: string }[];
  }>;

type DiagResult = { response: Record<string, unknown>; via: string };
const diag = (r: Rig, mac: string, line: string) =>
  HANDLERS.diag_exec({ port: r.registry.get(mac)!.alias, line, timeout_s: 3 }, r.hub) as Promise<DiagResult>;

/** Events of `type` on `mac` so far. */
const events = (r: Rig, mac: string, type: string): HubEvent[] => r.events.query({ devices: [mac], types: [type], limit: 1000 });

/** An --ota-dir whose next boot is a new image on probation (PENDING_VERIFY), as an OTA install leaves it. */
function pendingImageDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fr-vfix-'));
  dirs.push(dir);
  const old = '11'.repeat(32);
  const next = '22'.repeat(32);
  writeFileSync(
    join(dir, 'boot.txt'),
    `running=${old}\nversion=0.1.0\nfault=0\npending=0\nprev=-\nprev_version=\nprev_fault=0\nlast_invalid=-\nnext=${next}\nnext_version=0.2.0\nnext_fault=0\nslot=0\ncrashed=0\n`,
  );
  return dir;
}

describe.skipIf(!existsSync(BIN))('fr_net_node serial only, its taps and the boot wire (M2-C1)', () => {
  it('is online over USB alone: no TCP or UDP, no wifi in HELLO, its role, board and profile, NET from the serial WELCOME', async () => {
    const r = await serialRig();
    const mac = '58e6c5d55e41';
    const node = await serialNode(r, mac, 41, ['--board', 'esp32c3-oled042', '--profile', 'c3o-pad', '--chip', '5']);
    const info = r.router.info(mac)!;
    expect(info).toMatchObject({ presence: 'online', links: ['serial'], addr: 41 });
    expect(info.hello_caps! & 0b10).toBe(0); // HELLO caps: no `wifi` (bit 1)
    expect(r.registry.get(mac)!.role).toBe('node');
    const st = await node.state();
    expect(st).toMatchObject({ serial_session: true, session: false, hub_session: true, tcp_tx: 0, udp_tx: 0 });
    // CORE | CAPS | NET | HUB_ACK: NET came from the serial session's WELCOME (there is no TCP link).
    expect(Number(st.health) & 0b1111).toBe(0b1111);
    // HEARTBEATs keep it online over serial; the TIME burst ran on that session too.
    await new Promise((res) => setTimeout(res, 1200));
    expect(r.router.presence(mac)).toBe('online');
    expect(await node.state()).toMatchObject({ time_synced: true, sessions_lost: 0 });
    // Serial only, `net wifi_down` has no Wi-Fi switch.
    expect((await diag(r, mac, 'net wifi_down 5')).response).toMatchObject({ ok: false, error: 'unsupported' });
    // --role: the HELLO role, by name or number (2: fixture).
    const other = '58e6c5d55e47';
    await serialNode(r, other, 47, ['--role', '2']);
    expect(r.registry.get(other)!.role).toBe('fixture');
  }, 30_000);

  it('marks an image on probation valid from the serial WELCOME, and rolls it back without a hub session', async () => {
    const r = await serialRig();
    const mac = '58e6c5d55e42';
    const node = await serialNode(r, mac, 42, ['--ota-dir', pendingImageDir(), '--health-ms', '4000']);
    expect(node.of('started')[0]).toMatchObject({ pending: true });
    await until(() => node.of('ota_valid').length === 1, 5000, 'ota_valid');
    expect(node.of('reboot')).toEqual([]);
    // The same image with nobody on the USB line: no WELCOME, no NET, so its (1.5 s) deadline rolls it back.
    const lonely = new CppNode(['--serial', '1', '--mac', '58e6c5d55e43', '--addr', '43', '--net', '0', '--ota-dir', pendingImageDir(), '--health-ms', '1500']);
    nodes.push(lonely);
    await until(() => lonely.exited !== null, 6000, 'the rollback');
    expect(lonely.of('reboot').at(-1)).toMatchObject({ reason: 'rollback' });
    expect(lonely.of('ota_valid')).toEqual([]);
  }, 30_000);

  it('taps a gpio_low LED as its pin level (held, repeated), and pin_pulse as `<us>` on the test-pin tap', async () => {
    const r = await serialRig();
    const mac = '58e6c5d55e44';
    const [led, pin] = [await tap(), await tap()];
    const node = await serialNode(r, mac, 44, ['--board', 'esp32c3-oled042', '--profile', 'c3o-pad', '--chip', '5', '--led-kind', 'gpio_low', '--led-tap', String(led.port), '--test-pin-tap', String(pin.port)]);
    // Off at boot: an active-low pin reads high, and says so again every 250 ms.
    await until(() => led.texts().length >= 3, 2000, 'the held level, repeated');
    expect(led.changes()).toEqual(['level 1']);
    expect((await send(r, mac, 'status.set', { on: true })).results).toMatchObject([{ status: 'ok', link: 'serial' }]);
    await until(() => led.changes().length === 2, 2000, 'the lit level');
    expect(led.changes()).toEqual(['level 1', 'level 0']);
    expect(node.of('led').at(-1)).toMatchObject({ on: true });
    // pin_pulse over fr.diag.exec on the serial session: the C3 board's GPIO10, as `<us>` on the tap.
    const res = await diag(r, mac, 'pin_pulse 1000');
    expect(res.via).toBe('serial');
    expect(res.response).toMatchObject({ ok: true, pin: 10, us: 1000 });
    await until(() => pin.texts().length === 1, 2000, 'the pulse on the tap');
    expect(pin.texts()).toEqual(['1000']);
    expect((await diag(r, mac, 'info')).response).toMatchObject({ ok: true, test_pin: 10 });
  }, 30_000);

  it('taps a WS2812 LED as the frames led_ws2812 sends: GRB scaled by the capped brightness', async () => {
    const r = await serialRig();
    const mac = '58e6c5d55e45';
    const led = await tap();
    const node = await serialNode(r, mac, 45, ['--board', 'waveshare-esp32s3-lcd19', '--profile', 's3l-pad', '--chip', '9', '--led-kind', 'ws2812', '--led-tap', String(led.port)]);
    await until(() => led.texts().length >= 1, 2000, 'the start-dark frame');
    expect(led.texts()[0]).toBe('frame 0 24');
    // Red at 255 asked, capped at 64: (255 * 64 + 127) / 255 = 64 on R, so GRB 0x004000.
    expect((await send(r, mac, 'status.set', { on: true, color: 0xff0000, brightness: 255 })).results).toMatchObject([{ status: 'ok' }]);
    await until(() => led.texts().length >= 2, 2000, 'the lit frame');
    expect(led.texts().at(-1)).toBe(`frame ${0x004000} 24`);
    expect(node.of('led').at(-1)).toMatchObject({ on: true, grb: 0x004000 });
    expect(r.router.info(mac)!.properties).toMatchObject({ 'status.brightness': 64, 'status.color': 0xff0000 });
    expect((await diag(r, mac, 'info')).response).toMatchObject({ test_pin: -1 }); // no test pin wired
  }, 30_000);

  it('holds the boot button down while a `level 0` holds its wire: down, long_press, up and no click', async () => {
    const r = await serialRig();
    const mac = '58e6c5d55e46';
    const wire = await tap();
    const node = await serialNode(r, mac, 46, ['--pin-listen', '0']);
    const port = await node.pinListenPort();
    const of = (type: string) => waitForEvent(r.events, (e) => e.type === type && e.device === mac, 5000);
    const [down, long] = [of('boot.down'), of('boot.long_press')];
    wire.send(port, 'level 0');
    await down;
    await long; // held past long_press_ms (600)
    const up = of('boot.up');
    wire.send(port, 'level 1');
    expect((await up).fields).toMatchObject({ held_ms: expect.any(Number) });
    await new Promise((res) => setTimeout(res, 400)); // past the 250 ms click gap
    expect(events(r, mac, 'boot.click')).toEqual([]);
    expect(node.of('pin_in').map((l) => l.level)).toEqual([0, 1]);
    // Wired-AND with a pulse: a 2 ms pulse during a hold changes nothing; the hold's end releases it.
    wire.send(port, 'level 0');
    await until(() => events(r, mac, 'boot.down').length === 2, 3000, 'the second down');
    wire.send(port, '2000');
    await new Promise((res) => setTimeout(res, 100));
    expect(events(r, mac, 'boot.up')).toHaveLength(1);
    wire.send(port, 'level 1');
    await until(() => events(r, mac, 'boot.up').length === 2, 3000, 'the second up');
  }, 30_000);
});

const FIXTURE = 'e8f60a81bc48';

describe.skipIf(!existsSync(BIN))('the virtual fixture (M2-C1)', () => {
  /** The fixture (ch4 and ch6 LED taps, ch8 a test_pin tap) and a C3 pad wired to ch0, ch4 and ch8. */
  async function bench(r: Rig) {
    const fixture = await serialNode(r, FIXTURE, 70, ['--fixture', '1', '--line', 'ch4=0', '--line', 'ch6=0', '--line', 'ch8=0']);
    const [ch4, ch6, ch8] = [await fixture.linePort('ch4'), await fixture.linePort('ch6'), await fixture.linePort('ch8')];
    const padMac = '1cdbd4175cc4';
    const pad = await serialNode(r, padMac, 71, [
      '--board', 'esp32c3-oled042', '--profile', 'c3o-pad', '--chip', '5', '--pin-listen', '0',
      '--led-kind', 'gpio_low', '--led-tap', String(ch4), '--test-pin-tap', String(ch8),
    ]);
    fixture.send(`line ch0 ${await pad.pinListenPort()}`);
    await until(() => fixture.of('line').some((l) => l.name === 'ch0' && l.ok === true), 2000, 'ch0 wired');
    const fix = r.registry.get(FIXTURE)!;
    const cmd = (instance: string, command: string, args: Record<string, unknown> = {}) =>
      sendCommandTo(r.hub, fix, instance, command, args, { ack: 'result', timeoutMs: 3000 });
    return { fixture, pad, padMac, ch6, cmd };
  }

  /** The levels of `line`'s edges events on the fixture, in order (bit i of `levels` per edge). */
  const edgeLevels = (r: Rig, line: string): number[] =>
    events(r, FIXTURE, `${line}.edges`).flatMap((e) => {
      const f = e.fields as { n: number; levels: number };
      return Array.from({ length: f.n }, (_, i) => (f.levels >> i) & 1);
    });

  it('says HELLO role fixture with s3k-fixture\'s table: status on 1, ch0-ch11 on 2-13, every line released', async () => {
    const r = await serialRig();
    const { fixture } = await bench(r);
    expect(r.registry.get(FIXTURE)!.role).toBe('fixture');
    const info = r.router.info(FIXTURE)!;
    expect(info.links).toEqual(['serial']);
    expect(info.instances?.map((c) => `${c.port}:${c.name}`)).toEqual(['1:status', ...Array.from({ length: 12 }, (_, i) => `${i + 2}:ch${i}`)]);
    fixture.send('lines');
    await until(() => fixture.of('lines').length === 1, 2000, 'lines');
    const lines = fixture.of('lines')[0].items as { name: string; level: boolean; pressing: boolean }[];
    expect(lines.filter((l) => l.pressing)).toEqual([]);
    expect(lines.filter((l) => !l.level).map((l) => l.name)).toEqual(['ch6', 'ch7']); // WS2812 lines idle low
    expect((await diag(r, FIXTURE, 'info')).response).toMatchObject({ test_pin: -1 });
  }, 30_000);

  it('clicks and long-presses a pad through ch0: the pad\'s debounce yields its events, ch0 reads its own edges back', async () => {
    const r = await serialRig();
    const { padMac, cmd } = await bench(r);
    const of = (type: string) => waitForEvent(r.events, (e) => e.type === type && e.device === padMac, 5000);
    const [down, up, click] = [of('boot.down'), of('boot.up'), of('boot.click')];
    const res = await cmd('ch0', 'press', { segments_us: [80_000] });
    expect(res).toMatchObject({ status: 'ok', fields: { total_us: 80_000 } });
    await down;
    await up;
    expect((await click).fields).toEqual({ count: 1 });
    await until(() => edgeLevels(r, 'ch0').length === 2, 3000, 'the readback edges');
    expect(edgeLevels(r, 'ch0')).toEqual([0, 1]);
    // A press while one runs is BUSY; a tap line cannot drive.
    const long = of('boot.long_press');
    expect(await cmd('ch0', 'press', { segments_us: [800_000] })).toMatchObject({ status: 'ok' });
    expect(await cmd('ch0', 'press', { segments_us: [80_000] })).toMatchObject({ status: 'busy' });
    expect(await cmd('ch4', 'press', { segments_us: [80_000] })).toMatchObject({ status: 'unsupported' });
    await long;
    await until(() => events(r, padMac, 'boot.up').length === 2, 3000, 'the long press released');
    // `release` is idempotent; a held press ends at it.
    expect(await cmd('ch0', 'press', { segments_us: [10_000_000] })).toMatchObject({ status: 'ok' });
    await until(() => events(r, padMac, 'boot.down').length === 3, 3000, 'the held press');
    expect(await cmd('ch0', 'release')).toMatchObject({ status: 'ok' });
    expect(await cmd('ch0', 'release')).toMatchObject({ status: 'ok' });
    await until(() => events(r, padMac, 'boot.up').length === 3, 3000, 'released');
    expect(await cmd('ch0', 'read')).toMatchObject({ status: 'ok', fields: { level: true } });
  }, 30_000);

  it("releases a held line 2 s after the hub's last frame when its USB host leaves, whatever the press asked", async () => {
    const r = await serialRig();
    const { fixture, padMac, cmd } = await bench(r);
    const tCmd = Date.now();
    expect(await cmd('ch0', 'press', { segments_us: [10_000_000] })).toMatchObject({ status: 'ok' });
    await until(() => events(r, padMac, 'boot.down').length === 1, 3000, 'the held press');
    const t0 = Date.now();
    fixture.send('usb 0'); // the serial link goes down, and with it the fixture's only hub session
    await until(() => events(r, padMac, 'boot.up').length === 1, 6000, 'the release');
    // D11 item 3: 2 s after the newest hub frame, which came after the press CMD and before `usb 0` (the hub's
    // keepalive comes every --hb-ms 200 interval).
    expect(Date.now() - tCmd).toBeGreaterThanOrEqual(1900);
    const after = Date.now() - t0;
    expect(after).toBeGreaterThanOrEqual(1700);
    expect(after).toBeLessThan(3000);
    expect(await fixture.state()).toMatchObject({ serial_session: false, hub_session: false });
  }, 30_000);

  it("releases a held line 2 s after the hub's last frame while the USB link stays up (the hub went silent)", async () => {
    const r = await serialRig();
    const { fixture, padMac, cmd } = await bench(r);
    const tCmd = Date.now();
    expect(await cmd('ch0', 'press', { segments_us: [10_000_000] })).toMatchObject({ status: 'ok' });
    await until(() => events(r, padMac, 'boot.down').length === 1, 3000, 'the held press');
    const t0 = Date.now();
    fixture.send('hub_mute 1'); // the hub's lines stop reaching the fixture; the USB host stays
    await until(() => events(r, padMac, 'boot.up').length === 1, 6000, 'the release');
    expect(Date.now() - tCmd).toBeGreaterThanOrEqual(1900);
    const after = Date.now() - t0;
    // The old session-flag rule gave at least 3.5 intervals (700 ms) + 2 s = 2.7 s here.
    expect(after).toBeGreaterThanOrEqual(1700);
    expect(after).toBeLessThan(2600);
    fixture.send('hub_mute 0');
  }, 30_000);

  it('turns the pad\'s LED into ch4 edges and its pin_pulse into a ch8 pulse of the exact width', async () => {
    const r = await serialRig();
    const { padMac } = await bench(r);
    expect((await send(r, padMac, 'status.set', { on: true })).results).toMatchObject([{ status: 'ok' }]);
    await until(() => edgeLevels(r, 'ch4').length === 1, 3000, 'the LED edge');
    expect(edgeLevels(r, 'ch4')).toEqual([0]); // active low: lit is a low pin
    expect((await send(r, padMac, 'status.set', { on: false })).results).toMatchObject([{ status: 'ok' }]);
    await until(() => edgeLevels(r, 'ch4').length === 2, 3000, 'the second LED edge');
    expect(edgeLevels(r, 'ch4')).toEqual([0, 1]);
    expect((await diag(r, padMac, 'pin_pulse 1000')).response).toMatchObject({ ok: true, pin: 10 });
    await until(() => edgeLevels(r, 'ch8').length === 2, 3000, 'the pulse edges');
    expect(edgeLevels(r, 'ch8')).toEqual([0, 1]);
    // One batch (the release comes 1 ms after the press, within flush_us 2 ms), stamped at the pulse's own edges.
    expect(events(r, FIXTURE, 'ch8.edges').map((e) => e.fields)).toEqual([{ n: 2, levels: 0b10, dt_us: [0, 1000], dropped: 0 }]);
  }, 30_000);

  it('turns a WS2812 pad\'s refreshes into ch6 frames', async () => {
    const r = await serialRig();
    const { ch6 } = await bench(r);
    const ws = '58e6c5d55e64';
    await serialNode(r, ws, 72, ['--led-kind', 'ws2812', '--led-tap', String(ch6)]);
    await until(() => events(r, FIXTURE, 'ch6.frame').length >= 1, 3000, 'the start-dark frame');
    expect((await send(r, ws, 'status.set', { on: true, color: 0x00ff00, brightness: 32 })).results).toMatchObject([{ status: 'ok' }]);
    await until(() => events(r, FIXTURE, 'ch6.frame').length >= 2, 3000, 'the lit frame');
    // Green 255 at brightness 32: (255 * 32 + 127) / 255 = 32 on G.
    expect(events(r, FIXTURE, 'ch6.frame').at(-1)!.fields).toEqual({ bits: 24, grb: 32 << 16 });
  }, 30_000);
});
