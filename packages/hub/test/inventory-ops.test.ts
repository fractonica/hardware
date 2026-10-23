// The inventory ops and hub_doctor (design c6 D13, D14; stream S2): board_list and profile_list from the
// checkout (the real one, read only, and a broken temp one), capability_list live from the router or from
// the running firmware's manifest (with traits), and hub_doctor adding the hub's own self-tests.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import type { Check } from '@fractonica/host';
import { findOp } from '@fractonica/protocol';
import { CATALOG, CATALOG_HASH } from '@fractonica/protocol/gen';

import type { HubContext, HubRunOptions } from '../src/context.ts';
import { hubDoctor } from '../src/doctor/ops.ts';
import { createLnp } from '../src/lan/lnp.ts';
import { HANDLERS } from '../src/ops.ts';
import { netRig, type NetRig } from './fake-node.ts';
import { device, webRig, type WebRig } from './web-rig.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const output = (name: string) => findOp(name)!.output!;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
});

function openRig(opts: Parameters<typeof webRig>[0] = {}): WebRig {
  const r = webRig(opts);
  cleanups.push(() => r.close());
  return r;
}

/** An artifact row and its manifest (only what manifestCapsByFwPrefix and newest_debug read is real). */
function addArtifact(r: WebRig, o: { profile: string; fw: string; builtAt: string; buildType?: 'debug' | 'release'; fault?: string; caps?: unknown[] }): string {
  const buildType = o.buildType ?? 'debug';
  const buildId = `node/${o.profile}/${o.fault ? `${buildType}-fault` : buildType}/${o.fw.slice(0, 12)}`;
  const manifest = {
    schema: 'fractonica.artifact/1',
    build_id: buildId,
    app: 'node',
    profile: o.profile,
    build_type: buildType,
    board: 'esp32c6-supermini',
    target: 'esp32c6',
    chip_id: 13,
    part_profile: 'fr-4mb-v1',
    version: 'v1',
    source_dir: '/src',
    git: { sha: 'abc', dirty: false },
    idf: { version: 'v6.1', commit: 'def' },
    fw_id: o.fw,
    elf_sha256: '00',
    size: 1,
    built_at: o.builtAt,
    flash: { mode: 'dio', freq: '80m', size: '4MB', files: [] },
    partitions: [],
    ...(o.caps ? { caps: o.caps } : {}),
  };
  const path = join(r.dir, `${buildId.replaceAll('/', '_')}.json`);
  writeFileSync(path, JSON.stringify(manifest));
  r.db
    .prepare('INSERT INTO artifacts (build_id, source_dir, profile, build_type, fw_id, built_at, manifest_path, fault) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(buildId, '/src', o.profile, buildType, o.fw, o.builtAt, path, o.fault ?? null);
  return buildId;
}

describe('board_list and profile_list (D14)', () => {
  it("list the checkout's boards with chip, flash, buttons, LEDs and test_pin", async () => {
    const r = openRig();
    const out = (await HANDLERS.board_list({}, { ...r.hub, hubSourceDir: REPO } as HubContext)) as { boards: Record<string, unknown>[] };
    expect(output('board_list').safeParse(out).success).toBe(true);
    expect(out.boards).toContainEqual({ board: 'esp32c6-supermini', name: 'ESP32-C6 Super Mini', chip: 'esp32c6', flash: '4MB', buttons: ['boot'], leds: ['rgb', 'status'], test_pin: 20 });
    expect(out.boards.map((b) => b.board)).toContain('esp32c3-oled042');
    expect(out).not.toHaveProperty('errors');
  });

  it('list the profiles with their board chip, instances and newest debug build (never a fault or release one)', async () => {
    const r = openRig();
    addArtifact(r, { profile: 'c6-pad', fw: 'aa'.repeat(32), builtAt: '2026-10-01T10:00:00.000Z' });
    const newest = addArtifact(r, { profile: 'c6-pad', fw: 'bb'.repeat(32), builtAt: '2026-10-02T10:00:00.000Z' });
    addArtifact(r, { profile: 'c6-pad', fw: 'cc'.repeat(32), builtAt: '2026-10-03T10:00:00.000Z', fault: 'health' });
    addArtifact(r, { profile: 'c6-pad', fw: 'dd'.repeat(32), builtAt: '2026-10-04T10:00:00.000Z', buildType: 'release' });
    const out = (await HANDLERS.profile_list({}, { ...r.hub, hubSourceDir: REPO } as HubContext)) as { profiles: Record<string, unknown>[] };
    expect(output('profile_list').safeParse(out).success).toBe(true);
    const c6 = out.profiles.find((p) => p.profile === 'c6-pad');
    expect(c6).toEqual({
      profile: 'c6-pad',
      board: 'esp32c6-supermini',
      chip: 'esp32c6',
      app: 'node',
      instances: { boot: { cap: 'fr.button', driver: 'button_gpio' }, status: { cap: 'fr.led', driver: 'led_ws2812' } },
      newest_debug: { build_id: newest, fw_id: 'bb'.repeat(32), built_at: '2026-10-02T10:00:00.000Z' },
    });
    expect(out.profiles.find((p) => p.profile === 'c3o-pad')).toMatchObject({ chip: 'esp32c3' });
    expect(out.profiles.find((p) => p.profile === 'c3o-pad')).not.toHaveProperty('newest_debug');
  });

  it('list what parses and name what does not', async () => {
    const r = openRig();
    const src = mkdtempSync(join(tmpdir(), 'fr-inv-'));
    cleanups.push(() => rmSync(src, { recursive: true, force: true }));
    const put = (f: string, t: string) => {
      mkdirSync(dirname(join(src, f)), { recursive: true });
      writeFileSync(join(src, f), t);
    };
    put('hardware/boards/good.board.yaml', 'id: good\nidf_target: esp32c3\nflash: { size: 4MB }\n');
    put('hardware/boards/bad.board.yaml', 'id: [unclosed\n');
    put('firmware/profiles/p.profile.yaml', 'profile: p\nboard: good\napp: node\ncaps: { boot: { cap: fr.button, driver: button_gpio, bind: buttons.boot } }\n');
    put('firmware/profiles/orphan.profile.yaml', 'profile: orphan\nboard: missing\napp: node\n');
    put('firmware/profiles/empty.profile.yaml', 'profile: empty\n');
    const hub = { ...r.hub, hubSourceDir: src } as HubContext;
    const boards = (await HANDLERS.board_list({}, hub)) as { boards: unknown[]; errors: { file: string }[] };
    expect(boards.boards).toEqual([{ board: 'good', chip: 'esp32c3', flash: '4MB', buttons: [], leds: [], test_pin: null }]);
    expect(boards.errors.map((e) => e.file)).toEqual(['hardware/boards/bad.board.yaml']);
    const profiles = (await HANDLERS.profile_list({}, hub)) as { profiles: Record<string, unknown>[]; errors: { file: string }[] };
    expect(output('profile_list').safeParse(profiles).success).toBe(true);
    expect(profiles.profiles.map((p) => [p.profile, p.chip])).toEqual([
      ['orphan', 'unknown'],
      ['p', 'esp32c3'],
    ]);
    expect(profiles.errors.map((e) => e.file)).toEqual(['hardware/boards/bad.board.yaml', 'firmware/profiles/empty.profile.yaml']);
  });
});

describe('capability_list (D13, D14)', () => {
  it('is the catalog the hub runs', async () => {
    const r = openRig();
    const out = (await HANDLERS.capability_list({}, r.hub)) as { catalog_hash: number; caps: unknown[] };
    expect(output('capability_list').safeParse(out).success).toBe(true);
    expect(out.catalog_hash).toBe(CATALOG_HASH);
    expect(out.caps).toEqual(CATALOG.capabilities);
  });

  it("gives a device's instances from its firmware's manifest, with version, driver and traits (null without)", async () => {
    const fw = 'ab'.repeat(32);
    const r = openRig({ devices: [device('a0b1c2d3e4f5', 'pad-c6', { fw_id: fw }), device('a0b1c2d3e4f6', 'pad-x', { fw_id: 'ee'.repeat(32) })] });
    addArtifact(r, {
      profile: 'c6-pad',
      fw,
      builtAt: '2026-10-02T10:00:00.000Z',
      caps: [
        { name: 'boot', port: 1, cap: 'fr.button', cap_id: 1, version: '1.0', driver: 'button_gpio', config: {}, traits: { long_press: true, multi_press_max: 2 } },
        { name: 'status', port: 2, cap: 'fr.led', cap_id: 2, version: '1.0', driver: 'led_ws2812', config: { max_brightness: 64 } },
      ],
    });
    const out = (await HANDLERS.capability_list({ device: 'pad-c6' }, r.hub)) as { device: Record<string, unknown> };
    expect(output('capability_list').safeParse(out).success).toBe(true);
    expect(out.device).toEqual({
      device_id: 'a0b1c2d3e4f5',
      alias: 'pad-c6',
      source: 'manifest',
      fw_id: fw,
      instances: [
        { name: 'boot', port: 1, cap: 'fr.button', cap_id: 1, v: '1.0', traits: { long_press: true, multi_press_max: 2 }, driver: 'button_gpio' },
        { name: 'status', port: 2, cap: 'fr.led', cap_id: 2, v: '1.0', traits: null, driver: 'led_ws2812' },
      ],
    });
    // Firmware the hub did not build: nothing known yet.
    const unknown = (await HANDLERS.capability_list({ device: 'pad-x' }, r.hub)) as { device: Record<string, unknown> };
    expect(unknown.device).toMatchObject({ source: 'none', instances: [] });
    await expect(Promise.resolve().then(() => HANDLERS.capability_list({ device: 'pad-nope' }, r.hub))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('prefers what the router knows this run (the descriptor), versions from the catalog', async () => {
    const r: NetRig = await netRig();
    cleanups.push(() => r.close());
    const pad = r.pad({ mac: 'a0b1c2d3e4f5', addr: 0x0012, alias: 'pad-c6' });
    await pad.connected(r.events);
    const out = (await HANDLERS.capability_list({ device: 'pad-c6' }, r.hub)) as { device: { source: string; instances: Record<string, unknown>[] } };
    expect(out.device.source).toBe('router');
    expect(out.device.instances).toEqual([
      { name: 'boot', port: 1, cap: 'fr.button', cap_id: 1, v: '1.0', traits: null },
      { name: 'status', port: 2, cap: 'fr.led', cap_id: 2, v: '1.0', traits: null },
    ]);
  });
});

describe('hub_doctor', () => {
  const RUN: HubRunOptions = { apiHost: '127.0.0.1', apiPort: 7420, nodeHost: '127.0.0.1', nodePort: 0, nodeHttpPort: 0, noAdvert: true, serial: false };

  it("is fr doctor's checks run in the hub, read only, plus its Local Network self-test and advert", async () => {
    const r = openRig();
    const calls: unknown[] = [];
    const lnp = createLnp(() => r.hub, RUN, { probe: async () => ({ state: 'denied' }), env: { TERM_PROGRAM: 'Apple_Terminal' } });
    await lnp.check();
    const hub = { ...r.hub, lnp, advert: { start() {}, stop() {}, status: () => ({ state: 'off' as const }) } } as HubContext;
    const out = await hubDoctor(hub, {
      runDoctor: async (opts) => {
        calls.push(opts);
        return [{ id: 'node', level: 'ok', detail: 'v24.22.0' } as Check];
      },
    });
    expect(calls).toEqual([{ sourceDir: r.dir, fix: false }]);
    expect(output('hub_doctor').safeParse(out).success).toBe(true);
    expect(out.checks.map((c) => [c.id, c.level])).toEqual([
      ['node', 'ok'],
      ['lnp', 'error'],
      ['advert', 'ok'],
    ]);
    expect(out.checks[1]).toMatchObject({ detail: expect.stringContaining('Apple_Terminal'), fix: expect.stringContaining('Local Network') });
  });
});
