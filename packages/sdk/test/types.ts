// Compile-time checks of the SDK's typing (design c6 §4.5), run by `pnpm typecheck` (never executed): a device
// from devices.ts takes only its firmware's event and property types and the generated method signatures;
// one the registry does not type takes anything.

import { connect, type AnyDevice, type CmdResult, type Sent } from '@fractonica/sdk';

// What `fr codegen client` writes (packages/hub/src/apps/client-gen.ts), as const.
const devices = {
  catalogHash: 0xdc34c43b,
  registryRev: '0a1b2c3d',
  devices: {
    'pad-c6': { id: '58e6c5d55e64', profile: 'c6-pad', board: 'esp32c6-supermini', caps: { boot: 'fr.button', status: 'fr.led' } },
    'pad-c3': { id: '1cdbd4175cc4', profile: 'c3o-pad', board: 'esp32c3-oled042', caps: { boot: 'fr.button', status: 'fr.led' } },
  },
} as const;

export async function typed(): Promise<void> {
  const hub = await connect({ registry: devices, token: 't' });
  const pad = hub.devices.byAlias('pad-c6');

  pad.on('boot.down', (e) => {
    const t: number = e.tHubUs;
    const late: boolean = e.late;
    const dev: string | null = e.tDevUs === null ? null : pad.alias;
    void [t, late, dev, e.device.id, e.cursor];
  });
  pad.on('boot.long_press', (e) => {
    const held: number = e.heldMs;
    void held;
  });
  pad.on('boot.pressed', (e) => {
    const v: boolean = e.value;
    void v;
  });
  pad.on('status.effect_done', (e) => void e.effect);
  pad.on('node.boot', (e) => void e.resetReason);
  pad.on('boot.*', (e) => void e.type);
  pad.on('*.down', (e) => void e.part);
  pad.on('*', (e) => void e.device);
  // @ts-expect-error: no such event
  pad.on('boot.dwn', () => undefined);
  // @ts-expect-error: no such instance
  pad.on('led.on', () => undefined);
  pad.on('boot.up', (e) => {
    // @ts-expect-error: up carries heldMs, not count
    void e.count;
  });

  const sent: Sent = await pad.status.set({ on: true, color: 0x00ff00 });
  const r: CmdResult = await pad.status.blink({ onMs: 80, offMs: 80, count: 3 });
  const latency: number = r.tHubUs;
  // @ts-expect-error: blink takes camelCase args
  await pad.status.blink({ on_ms: 80 });
  // @ts-expect-error: no such command
  await pad.status.flash();
  // @ts-expect-error: fr.button has no public commands (inject is test-only: raw.call)
  await pad.boot.inject({ gesture: 'click' });
  await pad.raw.call('boot', 'inject', { gesture: 'click' });
  const fast: Sent = await pad.raw.call('status', 'set', { on: false }, { ack: 'none' });
  const pressed: boolean | undefined = pad.boot.state.pressed;
  const d = await pad.node.describe();
  const descriptor: string = d.fields.descriptor;
  void [sent, latency, fast, pressed, descriptor];

  const b = await hub.broadcast.msg('round.start', { level: 3 });
  void [b.seq, b.sessions, b.seeded];
  hub.on('device.online', (dev) => void dev.alias);
  hub.on('msg', (m) => void [m.device.alias, m.topic, m.data]);
  // @ts-expect-error: no such hub event
  hub.on('device.gone', () => undefined);
  void hub.stats().rttMs;
}

export async function untyped(): Promise<void> {
  const hub = await connect();
  // An alias devices.ts does not have: any instance, any type.
  const other: AnyDevice = hub.devices.byAlias('pad-x');
  other.on('anything.at_all', (e) => void e.type);
  await other.status?.set({ on: false });
  for (const d of hub.devices.withCapability('fr.led')) {
    await d.status?.set({ on: false });
    // @ts-expect-error: an fr.led instance has no such command
    await d.status?.flash();
  }
  hub.devices.on('added', (d) => {
    if (d.has('fr.button')) {
      d.on('*.down', (e) => void e.device.alias);
    }
  });
}
