// The fixture fence (design m2-c1-hil D15; stream S4) on a scripted fixture with two DUTs: command_send and
// an inject input_simulate to the fixture refused (by alias, id:, a role:fixture selector, in a mixed
// selection, by registry role with no bench), binding_set with the fixture at either end (also through
// presence atoms, `!` terms and other facets: the end's resolved devices count, not its text), diag_exec
// except info, stats and selftest (also on a /dev path that re-enumerates), serial_lease of the fixture's
// port, OTA to the fixture; the image rules of flash_start both ways (only the bench
// fixture's profile onto it, a fixture build onto nothing else, a bridge port that names no chip, a profile
// file that says role: fixture, no bench loaded) and the check provisioning calls; and the router dropping
// node -> node frames addressed to the fixture (forward_fixture).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CLS, findOp, FrError } from '@fractonica/protocol';
import { encodeDiagExecResult, encodeFixturePressArgs, PORT } from '@fractonica/protocol/gen';

import type { HubContext } from '../src/context.ts';
import { assertFixtureImage, fenceCommand, fenceDiag, FIXTURE_DIAG_LINES, fixtureIds, isFixtureBuild, isFixtureDevice } from '../src/fixture/fence.ts';
import { HANDLERS } from '../src/ops.ts';
import { OtaOrchestrator } from '../src/ota/orchestrator.ts';
import { createLeases } from '../src/ports/leases.ts';
import { startFlash } from '../src/registry/flashing.ts';
import { until } from './fake-node.ts';
import { addManifest, benchRig, type BenchRig, C3, C6, FIX, REPO, RUN } from './fixture-fake.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
});

async function rig(): Promise<BenchRig> {
  const b = await benchRig();
  cleanups.push(() => b.close());
  return b;
}

const fenced = { code: 'INVALID_ARGS', details: { reason: 'fixture_internal' } };
/** CMDs on the fixture's capability ports (not the router's own fr.node ones). */
const fixtureCmds = (b: BenchRig) => b.fixture.received(CLS.CMD).filter((f) => f.header.port !== PORT.NODE);

describe('commands to the fixture', () => {
  it('refuses command_send to it, whichever way the selector names it, and sends nothing to anyone', async () => {
    const b = await rig();
    const before = fixtureCmds(b).length;
    for (const selector of ['fix-s3', `id:${FIX.mac}`, 'FIX-S3']) {
      await expect(b.call('command_send', { selector, command: 'ch0.press', args: { segments_us: [80_000] } })).rejects.toMatchObject({
        ...fenced,
        message: expect.stringMatching(/command_send to the HIL fixture fix-s3 is refused/),
        remediation: [{ tool: 'input_simulate', args: { layer: 'gpio' } }, { tool: 'bench_get' }],
      });
    }
    expect(fixtureCmds(b).length).toBe(before);
    // A selection that has the fixture among others is refused whole: nothing goes to the others either.
    expect(() => fenceCommand(b.hub, [b.r.registry.get(C3.mac)!, b.r.registry.get(FIX.mac)!], 'command_send')).toThrow(
      expect.objectContaining({ ...fenced, details: { reason: 'fixture_internal', op: 'command_send', devices: [FIX.mac] } }),
    );
    expect(() => fenceCommand(b.hub, [b.r.registry.get(C3.mac)!], 'command_send')).not.toThrow();
    // The fixture module itself still drives it.
    await b.call('input_simulate', { selector: 'pad-c3', instance: 'boot', gesture: 'click', layer: 'gpio' });
    expect(fixtureCmds(b).length).toBe(before + 1);
  });

  it('refuses an inject input_simulate to it, and knows a fixture by its registry role with no bench', async () => {
    const b = await rig();
    await expect(b.call('input_simulate', { selector: 'fix-s3', instance: 'ch0', gesture: 'click' })).rejects.toMatchObject({ ...fenced, details: { op: 'input_simulate' } });
    const { fixture: _f, ...noBench } = b.hub;
    expect(isFixtureDevice(noBench as HubContext, FIX.mac)).toBe(true);
    expect(isFixtureDevice(noBench as HubContext, C3.mac)).toBe(false);
    // The bench's fixture is one whatever its row says (a fixture still on its CSI firmware: role node).
    b.r.registry.get(FIX.mac)!.role = 'node';
    expect(isFixtureDevice(b.hub, FIX.mac)).toBe(true);
    expect(isFixtureDevice(noBench as HubContext, FIX.mac)).toBe(false);
    await expect(b.call('command_send', { selector: 'fix-s3', command: 'status.blink' })).rejects.toMatchObject(fenced);
  });

  it('refuses binding_set with the fixture at either end', async () => {
    const b = await rig();
    await expect(b.call('binding_set', { from: 'fix-s3.ch0.edges', to: 'pad-c3.status.blink' })).rejects.toMatchObject({ ...fenced, details: { end: 'from', device: FIX.mac } });
    await expect(b.call('binding_set', { from: 'pad-c3.boot.down', to: `id:${FIX.mac}.status.blink` })).rejects.toMatchObject({ ...fenced, details: { end: 'to' } });
    await expect(b.call('binding_set', { from: 'pad-c3.boot.down', to: 'fix-s3.msg:hello' })).rejects.toMatchObject(fenced);
    expect(b.r.bindings.list()).toEqual([]);
    // Between DUTs, and to broadcast, as before.
    await b.call('binding_set', { from: 'pad-c3.boot.down', to: 'pad-c6.status.blink' });
    await b.call('binding_set', { from: 'pad-c3.boot.down', to: 'broadcast.msg:press' });
    expect(b.r.bindings.list()).toHaveLength(2);
  });

  it('refuses binding_set whose end resolves to the fixture through any atom: presence, `!` terms, other facets', async () => {
    const b = await rig();
    /** fr.node CMDs (bind_set, bind_clear) the fixture got: none may come of a refused binding_set. */
    const nodeCmds = () => b.fixture.received(CLS.CMD).filter((f) => f.header.port === PORT.NODE).length;
    const before = nodeCmds();
    const refused: Array<[string, string, 'from' | 'to']> = [
      // The fixture is online over serial: `online` matched nothing under the old fence's 'unknown' presence.
      ['fix-s3,online.msg:go', 'fix-s3,online.ch0.press', 'from'],
      ['role:fixture,online.msg:go', 'role:fixture,online.ch0.press', 'from'],
      ['fix-s3,online.ch2.edges', 'fix-s3,online.ch0.press', 'from'],
      ['pad-c3.boot.click', 'fix-s3,online.ch0.press', 'to'],
      ['pad-c3.boot.click', 'fix-s3,!offline.ch0.press', 'to'],
      [`id:${FIX.mac},online.ch0.edges`, 'pad-c6.status.blink', 'from'],
      // A presence that does not hold now still names the fixture: refused, not left to resolve to nothing.
      ['pad-c3.boot.down', 'role:fixture,offline.msg:x', 'to'],
      // Several devices, the fixture among them.
      ['pad-c3,fix-s3.msg:go', 'pad-c6.status.blink', 'from'],
    ];
    for (const [from, to, end] of refused) {
      await expect(b.call('binding_set', { from, to, args: to.endsWith('.press') ? { segments_us: [15_000_000] } : undefined }), `${from} -> ${to}`).rejects.toMatchObject({
        ...fenced,
        message: expect.stringMatching(new RegExp(`binding_set with the HIL fixture fix-s3 as its ${end} end is refused`)),
        details: { op: 'binding_set', end, device: FIX.mac },
      });
    }
    // The bench's fixture on a registry row that does not say fixture yet (before its first fixture HELLO):
    // a facet the candidate-set rule does not stop picks it, and the fence still refuses.
    b.r.registry.get(FIX.mac)!.role = 'node';
    await expect(b.call('binding_set', { from: 'chip:esp32s3,online.msg:go', to: 'pad-c6.status.blink' })).rejects.toMatchObject({ ...fenced, details: { end: 'from', device: FIX.mac } });
    await expect(b.call('binding_set', { from: 'pad-c3.boot.down', to: '!pad-c3,!pad-c6.msg:x' })).rejects.toMatchObject({ ...fenced, details: { end: 'to', device: FIX.mac } });
    b.r.registry.get(FIX.mac)!.role = 'fixture';
    await new Promise((r) => setTimeout(r, 50));
    expect(b.r.bindings.list()).toEqual([]);
    expect(nodeCmds()).toBe(before);
    // Between DUTs the same atoms still bind.
    await b.call('binding_set', { from: 'pad-c3,online.boot.down', to: 'pad-c6,!offline.status.blink' });
    expect(b.r.bindings.list()).toMatchObject([{ device_id: C3.mac, target_id: C6.mac }]);
  });

  it('lets diag_exec run only info, stats and selftest on it', async () => {
    const b = await rig();
    const lines: string[] = [];
    b.fixture.handlers.set(`${PORT.DIAG}/1`, (args) => {
      lines.push(Buffer.from(args).toString('utf8'));
      return { fields: encodeDiagExecResult({ json: '{"ok":true}' }) };
    });
    expect(FIXTURE_DIAG_LINES).toEqual(['info', 'stats', 'selftest']);
    for (const line of ['info', 'stats', 'selftest', '  info  ']) {
      expect(await b.call('diag_exec', { port: 'fix-s3', line })).toMatchObject({ response: { ok: true }, via: 'serial' });
    }
    for (const [port, line] of [
      ['fix-s3', 'reboot'],
      ['fix-s3', 'call ch0.press {"segments_us":[80000]}'],
      [FIX.mac, 'inject ch0 click'],
      [`mac:e8:f6:0a:81:bc:48`, 'log x'],
      ['fix-s3', 'caps'],
    ]) {
      await expect(b.call('diag_exec', { port, line })).rejects.toMatchObject({ ...fenced, details: { op: 'diag_exec', device: FIX.mac } });
    }
    expect(lines).toHaveLength(4);
  });

  it('fences diag_exec on the device a /dev path resolves to, also while that port re-enumerates', async () => {
    const b = await rig();
    const path = '/dev/cu.usbmodem1101';
    let attached = false;
    const writes: string[] = [];
    // SerialPortManager's semantics: resolve() is NOT_FOUND while the port is gone; resolveWait() waits for a
    // path gone in the last minute to come back and returns its entry (REAPPEAR_WAIT_MS).
    const serial = {
      resolve: (sel: string) => {
        if (attached && (sel === path || sel === FIX.mac)) {
          return { key: FIX.mac, path, state: 'open' };
        }
        throw new FrError('NOT_FOUND', `no port ${sel}`);
      },
      resolveWait: async () => {
        await new Promise((r) => setTimeout(r, 30));
        attached = true;
        return { key: FIX.mac, path, state: 'open' };
      },
      writeLine: async (key: string, line: string) => {
        writes.push(`${key} <- ${line}`);
        return { key, path };
      },
    };
    const hub = { ...b.hub, serial } as unknown as HubContext;
    const diag = (line: string) => HANDLERS.diag_exec(findOp('diag_exec')!.input.parse({ port: path, line, timeout_s: 1 }), hub);
    // With the port absent the path names no device: the text check alone lets it by.
    expect(() => fenceDiag(hub, path, 'call ch0.press {"segments_us":[15000000]}')).not.toThrow();
    await expect(diag('call ch0.press {"segments_us":[15000000]}')).rejects.toMatchObject({ ...fenced, details: { op: 'diag_exec', device: FIX.mac } });
    expect(writes).toEqual([]);
    // A read-only line still goes out once the port is back (this stub never answers it).
    attached = false;
    await expect(diag('info')).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(writes).toEqual([expect.stringMatching(new RegExp(`^${FIX.mac} <- #\\d+ info$`))]);
  });

  it('refuses OTA to it (the fixture is updated over USB only), and passes other selections on', async () => {
    const b = await rig();
    // The fence comes after the orchestrator: give the context one that plans nothing.
    const ota = Object.create(OtaOrchestrator.prototype) as OtaOrchestrator;
    (ota as unknown as { plan: () => unknown[] }).plan = () => [];
    const hub = { ...b.hub, ota } as HubContext;
    const call = (input: Record<string, unknown>) => HANDLERS.ota_deploy(findOp('ota_deploy')!.input.parse({ ...input, dry_run: true }), hub);
    await expect(call({ selector: 'fix-s3' })).rejects.toMatchObject({
      ...fenced,
      message: expect.stringMatching(/updated over USB only/),
      remediation: [{ tool: 'flash_start', args: { device: 'fix-s3', profile: 's3k-fixture' } }],
    });
    expect(await call({ selector: 'pad-c3' })).toMatchObject({ dry_run: true, devices: [] });
    await expect(call({ selector: 'nobody' })).resolves.toMatchObject({ dry_run: true });
    // deploy is refused before it builds anything (I1): its build would only be refused at ota_deploy.
    await expect(HANDLERS.deploy(findOp('deploy')!.input.parse({ selector: 'fix-s3', source_dir: '/nonexistent' }), hub)).rejects.toMatchObject({
      ...fenced,
      message: expect.stringMatching(/updated over USB only/),
    });
  });
});

describe('serial_lease of the fixture port', () => {
  /** serial_lease over the rig, with the USB ports `ports` names (selector -> port key); `leased` records grants. */
  async function leaseRig() {
    const b = await rig();
    const path = (key: string) => `/dev/cu.usbmodem-${key}`;
    const ports: Record<string, string> = {
      [FIX.mac]: FIX.mac,
      [`id:${FIX.mac}`]: FIX.mac,
      'mac:e8:f6:0a:81:bc:48': FIX.mac,
      [path(FIX.mac)]: FIX.mac,
      [C3.mac]: C3.mac,
    };
    const leased: string[] = [];
    const serial = {
      resolveWait: async (sel: string) => {
        const key = ports[sel];
        if (!key) {
          throw new FrError('NOT_FOUND', `no port ${sel}`);
        }
        return { key, path: path(key), state: 'open' };
      },
      lease: async (key: string) => {
        leased.push(key);
        return { path: path(key), release: () => undefined };
      },
      list: () => [],
    };
    const hub = { ...b.hub, serial } as unknown as HubContext;
    const leases = createLeases(() => hub, RUN, { alive: () => true });
    const lease = (device: string) => leases.lease(findOp('serial_lease')!.input.parse({ device, ttl_s: 60 }) as Parameters<typeof leases.lease>[0]);
    return { b, hub, lease, leased };
  }

  it('refuses it however the port is named, with flash_start, logs_read and bench_get as the way instead', async () => {
    const { b, lease, leased } = await leaseRig();
    for (const device of ['fix-s3', FIX.mac, `id:${FIX.mac}`, 'mac:e8:f6:0a:81:bc:48', `/dev/cu.usbmodem-${FIX.mac}`, 'role:fixture']) {
      await expect(lease(device), device).rejects.toMatchObject({
        ...fenced,
        message: expect.stringMatching(/serial_lease of the HIL fixture fix-s3 \(\/dev\/cu\.usbmodem-e8f60a81bc48\) is refused/),
        details: { op: 'serial_lease', device: FIX.mac, port: FIX.mac },
        remediation: [{ tool: 'flash_start', args: { device: 'fix-s3', profile: 's3k-fixture' } }, { tool: 'logs_read', args: { selector: 'fix-s3' } }, { tool: 'bench_get' }],
      });
    }
    // The bench's fixture whatever its row says, and a role:fixture row with no bench loaded.
    b.r.registry.get(FIX.mac)!.role = 'node';
    await expect(lease('fix-s3')).rejects.toMatchObject(fenced);
    b.r.registry.get(FIX.mac)!.role = 'fixture';
    expect(leased).toEqual([]);
    // A DUT's port is lent as before.
    expect(await lease('pad-c3')).toMatchObject({ device_id: C3.mac, alias: 'pad-c3', port: C3.mac });
    expect(leased).toEqual([C3.mac]);
  });

  it('refuses it with no bench loaded, by the registry role', async () => {
    const { hub, leased } = await leaseRig();
    const noBench = { ...hub, fixture: undefined } as HubContext;
    const leases = createLeases(() => noBench, RUN, { alive: () => true });
    await expect(leases.lease(findOp('serial_lease')!.input.parse({ device: 'fix-s3', ttl_s: 60 }) as Parameters<typeof leases.lease>[0])).rejects.toMatchObject({
      ...fenced,
      remediation: [{ tool: 'flash_start', args: { device: 'fix-s3', profile: '<fixture profile>' } }, { tool: 'logs_read' }, { tool: 'bench_get' }],
    });
    expect(leased).toEqual([]);
    expect(fixtureIds(noBench)).toEqual([FIX.mac]);
  });
});

describe('the image rules (flash_start, device_provision)', () => {
  /** flash_start dry runs on the rig, with the USB ports `ports` names (selector -> port key). */
  async function flashRig() {
    const b = await rig();
    const dir = mkdtempSync(join(tmpdir(), 'fr-fence-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    addManifest(b.r.db, dir, { profile: 's3k-fixture' });
    addManifest(b.r.db, dir, { profile: 's3l-pad', board: 'waveshare-esp32s3-lcd19' });
    addManifest(b.r.db, dir, { profile: 'c3o-pad', board: 'esp32c3-oled042', target: 'esp32c3', chipId: 5 });
    b.r.registry.add({ device_id: '94a99015cecc', addr: 0x0074, alias: 'pad-s3', profile: 's3l-pad', chip: 'esp32s3', provisioned: true });
    const ports: Record<string, string> = { [FIX.mac]: FIX.mac, [C3.mac]: C3.mac, '94a99015cecc': '94a99015cecc', '/dev/cu.usbserial-110': '/dev/cu.usbserial-110' };
    const serial = {
      resolveWait: async (sel: string) => {
        const key = ports[sel];
        if (!key) {
          throw new FrError('NOT_FOUND', `no port ${sel}`);
        }
        return { key, path: key.startsWith('/') ? key : `/dev/cu.usbmodem-${key}`, state: 'open' };
      },
    };
    const hub = { ...b.hub, serial } as unknown as HubContext;
    const flash = (input: Record<string, unknown>) => startFlash({ plan: 'app', dry_run: true, ...input } as Parameters<typeof startFlash>[0], hub);
    return { b, hub, flash };
  }

  it('puts only the bench fixture profile onto the fixture, and a fixture build onto nothing else', async () => {
    const { flash } = await flashRig();
    expect(await flash({ device: 'fix-s3', profile: 's3k-fixture' })).toMatchObject({ dry_run: true, device_id: FIX.mac, target: 'esp32s3' });
    // Its registry profile is s3k-fixture: the default pick is too.
    expect(await flash({ device: 'fix-s3' })).toMatchObject({ dry_run: true, build_id: expect.stringMatching(/^node\/s3k-fixture\//) });
    // pad-s3's image on fix-s3 would drive RMT TX into pad-c3's test_pin line.
    await expect(flash({ device: 'fix-s3', profile: 's3l-pad' })).rejects.toMatchObject({
      ...fenced,
      message: expect.stringMatching(/flash_start of s3l-pad onto the HIL fixture fix-s3 \(e8f60a81bc48\) is refused: it runs s3k-fixture only/),
      details: { op: 'flash_start', device: FIX.mac, profile: 's3l-pad', expected: 's3k-fixture' },
    });
    await expect(flash({ port: FIX.mac, profile: 's3l-pad' })).rejects.toMatchObject(fenced);
    // The other way: USB cannot tell fix-s3 from pad-s3.
    await expect(flash({ device: 'pad-s3', profile: 's3k-fixture' })).rejects.toMatchObject({
      ...fenced,
      message: expect.stringMatching(/goes only to the bench's fixture device e8f60a81bc48/),
    });
    await expect(flash({ port: '/dev/cu.usbserial-110', profile: 's3k-fixture' })).rejects.toMatchObject({ ...fenced, details: { device: null } });
    // Everything else as before.
    expect(await flash({ device: 'pad-s3' })).toMatchObject({ dry_run: true, build_id: expect.stringMatching(/s3l-pad/) });
    expect(await flash({ device: 'pad-c3', profile: 'c3o-pad' })).toMatchObject({ dry_run: true, device_id: C3.mac });
  });

  it("takes a build for a fixture one by its profile file's role, or the bench fixture's profile", async () => {
    const { b } = await flashRig();
    const src = mkdtempSync(join(tmpdir(), 'fr-fence-src-'));
    cleanups.push(() => rmSync(src, { recursive: true, force: true }));
    mkdirSync(join(src, 'firmware', 'profiles'), { recursive: true });
    writeFileSync(join(src, 'firmware', 'profiles', 'x-fix.profile.yaml'), 'profile: x-fix\nboard: b\napp: node\nrole: fixture   # a second fixture profile\n');
    writeFileSync(join(src, 'firmware', 'profiles', 'x-pad.profile.yaml'), 'profile: x-pad\nboard: b\napp: node\n# role: fixture would be a comment\n');
    const hub = { ...b.hub, hubSourceDir: src } as HubContext;
    expect(isFixtureBuild(hub, { profile: 'x-fix' })).toBe(true);
    expect(isFixtureBuild(hub, { profile: 'x-pad' })).toBe(false);
    expect(isFixtureBuild(hub, { profile: 's3k-fixture' })).toBe(true); // the bench fixture's
    expect(isFixtureBuild(hub, { profile: 'c3o-pad', role: 'fixture' })).toBe(true); // a manifest that says so
    expect(isFixtureBuild(hub, { profile: '../../etc/passwd' })).toBe(false);
    // This checkout's own s3k-fixture profile says role: fixture.
    const { fixture: _f, ...noBench } = b.hub;
    expect(isFixtureBuild({ ...(noBench as HubContext), hubSourceDir: REPO }, { profile: 's3k-fixture' })).toBe(true);
    expect(() => assertFixtureImage(hub, { deviceId: C3.mac, alias: 'pad-c3' }, { profile: 'x-fix' }, 'flash_start')).toThrow(/fixture build x-fix onto pad-c3/);
    // The bench names s3k-fixture: a second fixture profile does not go onto fix-s3 either.
    expect(() => assertFixtureImage(hub, { deviceId: FIX.mac }, { profile: 'x-fix' }, 'flash_start')).toThrow(/runs s3k-fixture only/);
  });

  it('is the check provisioning calls after its probe, with the probed MAC; with no bench, by registry role', async () => {
    const { b } = await flashRig();
    const check = (hub: HubContext, deviceId: string | null, profile: string) => () => assertFixtureImage(hub, { deviceId }, { profile }, 'device_provision');
    expect(check(b.hub, FIX.mac, 's3k-fixture')).not.toThrow();
    expect(check(b.hub, FIX.mac, 's3l-pad')).toThrow(expect.objectContaining({ ...fenced, details: expect.objectContaining({ op: 'device_provision', device: FIX.mac }) }));
    expect(check(b.hub, '94a99015cecc', 's3k-fixture')).toThrow(/device_provision of the fixture build s3k-fixture onto 94a99015cecc is refused/);
    expect(check(b.hub, 'aabbccddeeff', 'c6-pad')).not.toThrow(); // a new node, not the fixture
    // No bench loaded: a role:fixture row takes only a fixture build, and a fixture build goes nowhere else.
    const noBench = { ...b.hub, fixture: undefined, hubSourceDir: REPO } as HubContext;
    expect(check(noBench, FIX.mac, 's3k-fixture')).not.toThrow();
    expect(check(noBench, FIX.mac, 's3l-pad')).toThrow(/runs a role: fixture profile only/);
    expect(check(noBench, '94a99015cecc', 's3k-fixture')).toThrow(/no bench file is loaded/);
  });
});

describe('the router and a fixture', () => {
  it('drops node -> node frames addressed to the fixture, counted as forward_fixture', async () => {
    const b = await rig();
    const before = b.r.router.status().counters;
    const cmds = b.fixture.received(CLS.CMD).length;
    b.c3.sendTo(FIX.addr, CLS.CMD, 1, 1, encodeFixturePressArgs({ segments_us: [80_000] }), { ackReq: true });
    await until(() => b.r.router.status().counters.forward_fixture === before.forward_fixture + 1, 1000, 'forward_fixture');
    expect(b.r.router.status().counters).toMatchObject({ forwarded: before.forwarded, forward_no_route: before.forward_no_route });
    await new Promise((r) => setTimeout(r, 30));
    expect(b.fixture.received(CLS.CMD)).toHaveLength(cmds);
    expect(b.fixture.presses).toHaveLength(0);
    // Node -> node between DUTs still goes through.
    b.c3.sendTo(0x0072, CLS.CMD, 2, 3, new Uint8Array(0), { ackReq: true });
    await until(() => b.r.router.status().counters.forwarded >= before.forwarded + 1, 1000, 'forwarded');
  });
});
