// The HIL bench on loopback (design m2-c1-hil §5.1, I1), for interop-hil.test.ts and e2e-gates-e's dry run: a
// real hub process (real-hub.ts: port 0, its own FR_HOME, this checkout's bench file) whose serial ports are a
// VirtualUsb (virtual-usb.ts, the hub's --serial-bridge), one C++ pad per bench DUT (fr_net_node on the DUT's MAC,
// alias and bench profile, over TCP/UDP, a CppBoard with its own --ota-dir so fr.node.reboot boots it again with
// a new epoch) and the serial-only C++ virtual fixture (fr_net_node --serial 1 --fixture 1) on that virtual USB.
// The wires are loopback datagrams: each BOOT channel drives its pad's --pin-listen port (rewired at each of the
// pad's boots, since every boot binds a new one), each pad's --led-tap and --test-pin-tap feed the fixture's LED
// and test_pin channels.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Bench } from '@fractonica/protocol';

import { Hub } from '../../../tests/e2e/lib/hub.ts';
import { CppBoard, CppNode } from './cpp-node.ts';
import { until } from './fake-node.ts';
import { type RealHub, startRealHub } from './real-hub.ts';
import { VirtualUsb } from './virtual-usb.ts';

/** What fr_net_node says for each bench profile (board, chip id), the registry's chip name, and its LED pin. */
export const PAD_PROFILES: Record<string, { board: string; chip: number; chipName: string; led: 'gpio_low' | 'ws2812' }> = {
  'c3o-pad': { board: 'esp32c3-oled042', chip: 5, chipName: 'esp32c3', led: 'gpio_low' },
  'c6-pad': { board: 'esp32c6-supermini', chip: 13, chipName: 'esp32c6', led: 'ws2812' },
  's3l-pad': { board: 'waveshare-esp32s3-lcd19', chip: 9, chipName: 'esp32s3', led: 'ws2812' },
};

/** The lab bench's DUT aliases (the registry's, the gates' defaults). */
export const LAB_ALIASES: Record<string, string> = { '1cdbd4175cc4': 'pad-c3', '1cdbd416ba34': 'pad-c3b', '58e6c5d55e64': 'pad-c6', '94a99015cecc': 'pad-s3' };

export interface HilPad {
  mac: string;
  alias: string;
  profile: string;
  board: CppBoard;
  /** The current boot's process. */
  readonly node: CppNode;
  boot: string;
  status: { channel: string; decode: 'level' | 'ws2812'; active_level?: 'high' | 'low' };
  testPin: string;
}

export interface HilRig {
  hub: RealHub;
  /** REST as an agent calls it (X-Fr-Client: mcp). */
  mcp: Hub;
  usb: VirtualUsb;
  fixture: CppNode;
  /** The fixture's device id (bench fixture.device). */
  fix: string;
  pads: HilPad[];
  stop(): Promise<void>;
}

export async function startHilRig(bench: Bench, opts: { aliases?: Record<string, string>; fixtureAlias?: string } = {}): Promise<HilRig> {
  const aliases = opts.aliases ?? LAB_ALIASES;
  const fixAlias = opts.fixtureAlias ?? 'fix-s3';
  const usb = await VirtualUsb.open();
  const fix = bench.fixture.device;
  const duts = Object.entries(bench.duts);
  const alias = (mac: string) => aliases[mac] ?? `pad-${mac.slice(-4)}`;
  const devices = [
    ...duts.map(([mac, d]) => ({ mac, alias: alias(mac), profile: d.profile, board: PAD_PROFILES[d.profile].board, chip: PAD_PROFILES[d.profile].chipName })),
    { mac: fix, alias: fixAlias, profile: bench.fixture.profile, board: 'esp32s3-devkitc1-n16r8', chip: 'esp32s3', role: 'fixture' as const },
  ];
  const hub = await startRealHub({ devices, serialBridge: usb.address });
  const boards: CppBoard[] = [];
  const dirs: string[] = [];
  let fixture: CppNode | null = null;
  let rewire: NodeJS.Timeout | undefined;
  const stop = async () => {
    clearInterval(rewire);
    boards.forEach((b) => b.stop());
    fixture?.stop();
    await hub.stop().catch(() => undefined);
    await usb.close();
    for (const d of dirs) {
      rmSync(d, { recursive: true, force: true });
    }
  };
  try {
    const net = ['--net', '42', '--hb-ms', '300'];
    // The fixture first: its input channels get free ports for the pads' taps.
    const inputs = duts.flatMap(([, d]) => [d.lines.status, d.lines.test_pin].filter((l) => l?.wired).map((l) => l!.channel));
    fixture = new CppNode(['--serial', '1', '--fixture', '1', '--mac', fix, '--addr', String(hub.addrs.get(fix)), ...net, ...inputs.flatMap((c) => ['--line', `${c}=0`])]);
    usb.attachNode(fixture, fix);
    const pads: HilPad[] = [];
    for (const [mac, d] of duts) {
      const p = PAD_PROFILES[d.profile];
      const status = d.lines.status!;
      const dir = mkdtempSync(join(tmpdir(), 'fr-hil-pad-'));
      dirs.push(dir);
      const board = new CppBoard([
        '--mac', mac, '--addr', String(hub.addrs.get(mac)), '--alias', alias(mac), ...net,
        '--hub-tcp', String(hub.node.tcp), '--hub-udp', String(hub.node.udp), '--ota-dir', dir,
        '--board', p.board, '--profile', d.profile, '--chip', String(p.chip),
        '--pin-listen', '0', '--led-kind', p.led,
        '--led-tap', String(await fixture.linePort(status.channel)),
        '--test-pin-tap', String(await fixture.linePort(d.lines.test_pin!.channel)),
      ]);
      boards.push(board);
      pads.push({
        mac,
        alias: alias(mac),
        profile: d.profile,
        board,
        get node() {
          return board.node;
        },
        boot: d.lines.boot!.channel,
        status: { channel: status.channel, decode: status.decode === 'ws2812' ? 'ws2812' : 'level', active_level: status.active_level },
        testPin: d.lines.test_pin!.channel,
      });
    }
    // Each BOOT channel's wire to its pad's boot input, and again at each later boot of the pad (fr.node.reboot).
    const wiredBoot = new Map<HilPad, number>();
    for (const p of pads) {
      fixture.send(`line ${p.boot} ${await p.node.pinListenPort()}`);
      await until(() => fixture!.of('line').some((l) => l.name === p.boot && l.ok === true), 5000, `${p.boot} wired to ${p.alias}`);
      wiredBoot.set(p, p.board.boots.length);
    }
    rewire = setInterval(() => {
      for (const p of pads) {
        const port = p.node.of('pin_listen')[0]?.port;
        if (p.board.boots.length > wiredBoot.get(p)! && port !== undefined) {
          fixture!.send(`line ${p.boot} ${String(port)}`);
          wiredBoot.set(p, p.board.boots.length);
        }
      }
    }, 10);
    await hub.api.ok('wait_for_device', { selector: [...pads.map((p) => p.alias), fixAlias].join(','), timeout_s: 60 }, 70_000);
    return { hub, mcp: new Hub(hub.url, 'mcp'), usb, fixture, fix, pads, stop };
  } catch (e) {
    await stop();
    throw e;
  }
}

/** The fixture's line states (stdin `lines`), by channel. */
export async function fixtureLines(fixture: CppNode): Promise<Record<string, { level: boolean; pressing: boolean; port: number }>> {
  const n = fixture.of('lines').length;
  fixture.send('lines');
  await until(() => fixture.of('lines').length > n, 2000, 'lines');
  return Object.fromEntries((fixture.of('lines').at(-1)!.items as { name: string; level: boolean; pressing: boolean; port: number }[]).map((l) => [l.name, l]));
}
