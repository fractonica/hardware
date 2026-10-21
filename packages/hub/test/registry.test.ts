// The registry (design c3 §4, stream H1): alias and tag rules, addr allocation, HELLO-only rows,
// renames and alias_rev, the 09 §9.2 selector grammar, and the device_list/get/update ops.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { RESERVED_INSTANCE_NAMES as CODEGEN_RESERVED } from '@fractonica/codegen';
import { type ArtifactManifest, boardHash, findOp } from '@fractonica/protocol';

import type { Device, HelloSeen, HubContext, HubEvent, Presence } from '../src/context.ts';
import { type Db, kvGet, openDb } from '../src/db.ts';
import { createEvents } from '../src/events/index.ts';
import { HANDLERS } from '../src/ops.ts';
import { createRegistry } from '../src/registry/index.ts';
import { aliasProblem, checkAlias, defaultAlias, editTags, RESERVED_INSTANCE_NAMES } from '../src/registry/names.ts';
import { parseSelector, selectDevices } from '../src/registry/selector.ts';
import { markIdentWritten, prepareIdentity, type ProvisionRecord, SqliteRegistry } from '../src/registry/store.ts';
import { CursorSeq } from '../src/seq.ts';

let dir = '';
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'fr-registry-test-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const C6 = '1cdbd4d55e64';
const C3 = '1cdbd416ba34';
const S3 = 'f412fa000001';

function hello(over: Partial<HelloSeen> = {}): HelloSeen {
  return {
    device_id: C6,
    addr: 0xfffe,
    net: 0,
    epoch: 3,
    chip: 13,
    chip_rev: 1,
    fw_id_prefix: 'aabbccddeeff0011',
    descriptor_hash: 0,
    board_hash: 0,
    role: 'node',
    caps: 0,
    alias: '',
    alias_rev: 0,
    link: 'serial',
    ...over,
  };
}

/** A provisioned row, as device_provision leaves it. */
function provisioned(db: Db, deviceId: string, profile: string, chip: string, alias?: string): Device {
  const p = prepareIdentity(db, { deviceId, alias, profile, board: `${chip}-board`, chip, net: 41235 });
  const rec = { at: '', via: 'provision', ident: { offset: 0x3fc000, size: 0x4000 }, epoch_floor: p.epoch_floor } as unknown as ProvisionRecord;
  return markIdentWritten(db, deviceId, rec);
}

describe('alias rules', () => {
  it('takes RFC 1123 labels of at most 31 characters, stored in lower case', () => {
    expect(checkAlias('Pad-Red-1')).toBe('pad-red-1');
    expect(checkAlias('a')).toBe('a');
    expect(checkAlias('x'.repeat(31))).toBe('x'.repeat(31));
    for (const bad of ['', '-pad', 'pad-', 'pad_red', 'pad.red', 'päd', 'pad red', 'x'.repeat(32)]) {
      expect(() => checkAlias(bad), bad).toThrow(expect.objectContaining({ code: 'INVALID_ARGS' }));
    }
  });

  it('refuses reserved names, selector keywords and device-id look-alikes', () => {
    for (const r of ['node', 'diag', 'broadcast', 'online', 'offline', 'all', 'registry', 'state']) {
      expect(aliasProblem(r), r).toMatch(/reserved/);
    }
    expect(aliasProblem('1cdbd416ba34')).toMatch(/device id/);
    expect(aliasProblem('1cdbd416ba3')).toBeNull();
  });

  it('keeps its copy of the reserved instance names in step with the generator', () => {
    expect([...RESERVED_INSTANCE_NAMES].sort()).toEqual([...CODEGEN_RESERVED].sort());
  });

  it('defaults to <profile>-<last 6 hex>, cut to 31 characters', () => {
    expect(defaultAlias('c6-pad', C6)).toBe('c6-pad-d55e64');
    expect(defaultAlias('c6-pad', C6, 2)).toBe('c6-pad-d55e64-2');
    expect(defaultAlias('Board_With.Odd', C6)).toBe('board-with-odd-d55e64');
    const long = defaultAlias('a-very-long-profile-name-that-goes-on', C6);
    expect(long.length).toBeLessThanOrEqual(31);
    expect(long).toMatch(/^a-very-long-profile-name-d55e64$/);
    expect(aliasProblem(long)).toBeNull();
  });

  it('edits tags: +t or t adds, -t removes, order kept', () => {
    expect(editTags(['a', 'b'], '+c,-a, b ,POC')).toEqual(['b', 'c', 'poc']);
    expect(() => editTags([], 'x:y')).toThrow(expect.objectContaining({ code: 'INVALID_ARGS' }));
    expect(() => editTags([], Array.from({ length: 33 }, (_, i) => `t${i}`).join(','))).toThrow(/at most 32/);
  });
});

describe('registry store', () => {
  it('allocates addr from 1 and never reuses one, even after a row is gone', () => {
    const db = openDb(':memory:');
    expect(provisioned(db, C6, 'c6-pad', 'esp32c6').addr).toBe(1);
    expect(provisioned(db, C3, 'c3o-pad', 'esp32c3').addr).toBe(2);
    // Reprovisioning keeps the addr.
    expect(provisioned(db, C6, 'c6-pad', 'esp32c6').addr).toBe(1);
    db.prepare('DELETE FROM devices WHERE device_id = ?').run(C3); // device_forget (M2)
    expect(provisioned(db, S3, 's3-pad', 'esp32s3').addr).toBe(3);
    expect(kvGet(db, 'registry.addr_hwm')).toBe('3');
  });

  it('creates an unprovisioned row on a first HELLO, then keeps it current', () => {
    const db = openDb(':memory:');
    const reg = createRegistry(db);
    const d = reg.touchHello(C6, hello());
    expect(d).toMatchObject({ device_id: C6, addr: null, provisioned: false, alias: 'esp32c6-d55e64', chip: 'esp32c6', role: 'node', last_epoch: 3, fw_id: 'aabbccddeeff0011' });
    // A made-up alias outranks the device's own (rev 0), so the router's push wins.
    expect(d.alias_rev).toBe(1);
    expect(d.last_seen).not.toBeNull();
    const again = reg.touchHello(C6, hello({ epoch: 4, role: 'gateway' }));
    expect(again).toMatchObject({ last_epoch: 4, role: 'gateway', alias: 'esp32c6-d55e64', alias_rev: 1 });
    expect(reg.list()).toHaveLength(1);
  });

  it("adopts a first HELLO's alias when it is valid and free", () => {
    const db = openDb(':memory:');
    const reg = createRegistry(db);
    expect(reg.touchHello(C6, hello({ alias: 'Pad-Red-1', alias_rev: 4 }))).toMatchObject({ alias: 'pad-red-1', alias_rev: 4 });
    // Taken (any case) or invalid: made up instead.
    expect(reg.touchHello(C3, hello({ device_id: C3, chip: 5, alias: 'PAD-RED-1', alias_rev: 2 }))).toMatchObject({ alias: 'esp32c3-16ba34', alias_rev: 3 });
    expect(reg.touchHello(S3, hello({ device_id: S3, chip: 9, alias: 'node', alias_rev: 0 }))).toMatchObject({ alias: 'esp32s3-000001' });
  });

  it('moves alias_rev past the rev a HELLO reports, so the registry alias wins the next push', () => {
    const db = openDb(':memory:');
    const reg = createRegistry(db);
    provisioned(db, C6, 'c6-pad', 'esp32c6', 'pad-red-1');
    expect(reg.get(C6)!.alias_rev).toBe(1);
    // A stale fr_ovr from an earlier hub: other alias, higher rev.
    expect(reg.touchHello(C6, hello({ alias: 'old-name', alias_rev: 7 })).alias_rev).toBe(8);
    // Same alias, higher rev: catch up without a push.
    expect(reg.touchHello(C6, hello({ alias: 'pad-red-1', alias_rev: 9 })).alias_rev).toBe(9);
    // Older rev: unchanged; the router re-sends the registry's alias.
    expect(reg.touchHello(C6, hello({ alias: 'old-name', alias_rev: 2 })).alias_rev).toBe(9);
  });

  it('fills fw_id, board and profile from the artifact a HELLO prefix names', () => {
    const db = openDb(':memory:');
    const fw = 'aabbccddeeff0011' + '2'.repeat(48);
    const manifestPath = join(dir, 'hello-artifact.json');
    writeFileSync(manifestPath, JSON.stringify(manifestFor('node/c6-pad/debug/aabbccddeeff', fw)));
    db.prepare('INSERT INTO artifacts (build_id, source_dir, profile, build_type, fw_id, built_at, manifest_path) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      'node/c6-pad/debug/aabbccddeeff', '/src', 'c6-pad', 'debug', fw, '2026-10-21T10:00:00Z', manifestPath,
    );
    const reg = createRegistry(db);
    expect(reg.touchHello(C6, hello({ board_hash: boardHash('esp32c6-supermini') }))).toMatchObject({ fw_id: fw, board: 'esp32c6-supermini', profile: 'c6-pad' });
    // A board_hash that disagrees leaves board and profile alone.
    expect(reg.touchHello(C3, hello({ device_id: C3, board_hash: 1 }))).toMatchObject({ fw_id: fw, board: null, profile: null });
  });

  it('renames: alias_rev + 1, unique without regard to case, tags replaced', () => {
    const db = openDb(':memory:');
    const reg = createRegistry(db);
    provisioned(db, C6, 'c6-pad', 'esp32c6');
    provisioned(db, C3, 'c3o-pad', 'esp32c3', 'pad-blue');
    expect(reg.update(C6, { alias: 'Pad-Red-1' })).toMatchObject({ alias: 'pad-red-1', alias_rev: 2 });
    expect(reg.update(C6, { alias: 'pad-red-1' }).alias_rev).toBe(2); // same name: no bump
    expect(() => reg.update(C6, { alias: 'PAD-BLUE' })).toThrow(expect.objectContaining({ code: 'INVALID_ARGS', details: { alias: 'pad-blue', device_id: C3 } }));
    expect(reg.update(C6, { tags: ['poc'] }).tags).toEqual(['poc']);
    expect(reg.byAlias('PAD-RED-1')?.device_id).toBe(C6);
    expect(reg.byAddr(2)?.device_id).toBe(C3);
    expect(() => reg.update('ffffffffffff', { tags: [] })).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  it("provisioning keeps a chosen alias but replaces a HELLO-only row's made-up one", () => {
    const db = openDb(':memory:');
    const reg = createRegistry(db);
    reg.touchHello(C6, hello({ epoch: 9 }));
    const p = prepareIdentity(db, { deviceId: C6, profile: 'c6-pad', board: 'esp32c6-supermini', chip: 'esp32c6', net: 7 });
    expect(p.device).toMatchObject({ alias: 'c6-pad-d55e64', alias_rev: 2, addr: 1, net: 7, profile: 'c6-pad' });
    expect(p.epoch_floor).toBe(10);
    reg.update(C6, { alias: 'pad-red-1' });
    expect(prepareIdentity(db, { deviceId: C6, profile: 'c6-pad', board: null, chip: null, net: 7 }).device).toMatchObject({ alias: 'pad-red-1', alias_rev: 3 });
    // epoch_floor is a u16 in serial order that never lands on 0.
    db.prepare('UPDATE devices SET last_epoch = 65535 WHERE device_id = ?').run(C6);
    expect(prepareIdentity(db, { deviceId: C6, profile: 'c6-pad', board: null, chip: null, net: 7 }).epoch_floor).toBe(1);
  });

  it("provisioning replaces an UNASSIGNED node's placeholder new-<short id>, but not that spelling chosen by a person", () => {
    const db = openDb(':memory:');
    const reg = createRegistry(db);
    // fr_id_load's alias for a board without fr_ident, adopted on first contact (valid and free).
    expect(reg.touchHello(C6, hello({ alias: 'new-d55e64', alias_rev: 0 }))).toMatchObject({ alias: 'new-d55e64', alias_rev: 0 });
    const p = prepareIdentity(db, { deviceId: C6, profile: 'c6-pad', board: 'esp32c6-supermini', chip: 'esp32c6', net: 7 });
    expect(p.device).toMatchObject({ alias: 'c6-pad-d55e64', alias_rev: 1, addr: 1 });
    // A rename to that spelling carries alias_rev >= 1: kept.
    reg.touchHello(C3, hello({ device_id: C3, chip: 5 }));
    expect(reg.update(C3, { alias: 'new-16ba34' })).toMatchObject({ alias: 'new-16ba34', alias_rev: 2 });
    expect(prepareIdentity(db, { deviceId: C3, profile: 'c3o-pad', board: null, chip: 'esp32c3', net: 7 }).device).toMatchObject({ alias: 'new-16ba34', alias_rev: 2 });
  });

  it("retires the addr a HELLO reports on this hub's net, so provisioning never hands it out again", () => {
    const db = openDb(':memory:');
    const reg = createRegistry(db);
    // Before any network record, and from another net: not counted.
    reg.touchHello(S3, hello({ device_id: S3, chip: 9, addr: 5, net: 100, caps: 0x20 }));
    expect(kvGet(db, 'registry.addr_hwm')).toBeUndefined();
    db.prepare("INSERT INTO networks (id, ssid, bssid, country, updated_at, net_id, hub_host) VALUES (1, 'LabNet', NULL, NULL, '', 100, 'h.local')").run();
    reg.touchHello(C3, hello({ device_id: C3, chip: 5, addr: 9, net: 200, caps: 0x20 }));
    reg.touchHello(C3, hello({ device_id: C3, chip: 5 })); // UNASSIGNED (0xFFFE)
    expect(kvGet(db, 'registry.addr_hwm')).toBeUndefined();
    // A provisioned node on this net that the registry has no record of (a hub.db restored from an older
    // backup): its row stays HELLO-only, but its addr is retired.
    expect(reg.touchHello(S3, hello({ device_id: S3, chip: 9, addr: 5, net: 100, caps: 0x20 }))).toMatchObject({ addr: null, provisioned: false });
    expect(kvGet(db, 'registry.addr_hwm')).toBe('5');
    expect(provisioned(db, C6, 'c6-pad', 'esp32c6').addr).toBe(6);
    // A lower addr never moves the mark back.
    reg.touchHello(S3, hello({ device_id: S3, chip: 9, addr: 2, net: 100, caps: 0x20 }));
    expect(kvGet(db, 'registry.addr_hwm')).toBe('6');
  });
});

describe('selectors (09 §9.2)', () => {
  const devs: Device[] = [
    dev(C6, 'pad-red-1', { tags: ['poc', 'desk'], chip: 'esp32c6', board: 'esp32c6-supermini', profile: 'c6-pad' }),
    dev(C3, 'pad-blue-2', { tags: ['poc'], chip: 'esp32c3', board: 'esp32c3-oled042', profile: 'c3o-pad' }),
    dev(S3, 'gw-1', { chip: 'esp32s3', role: 'gateway', profile: 's3-gw' }),
  ];
  const pres: Record<string, Presence> = { [C6]: 'online', [C3]: 'suspect', [S3]: 'offline' };
  const sel = (s: string) => selectDevices(devs, s, (id) => pres[id] ?? 'unknown').map((d) => d.alias);

  it('reads the spec examples as meant', () => {
    expect(sel('pad-red-1')).toEqual(['pad-red-1']);
    expect(sel('tag:poc,!pad-blue-2')).toEqual(['pad-red-1']);
    expect(sel('chip:esp32c6,online')).toEqual(['pad-red-1']);
  });

  it('unions alternatives of one kind and narrows across kinds', () => {
    expect(sel('pad-red-1,gw-1')).toEqual(['pad-red-1', 'gw-1']);
    expect(sel('chip:esp32c6,chip:esp32s3')).toEqual(['pad-red-1', 'gw-1']);
    expect(sel('tag:poc,chip:esp32c3')).toEqual(['pad-blue-2']);
    expect(sel('tag:desk,tag:poc,role:node')).toEqual(['pad-red-1', 'pad-blue-2']);
    expect(sel('all')).toHaveLength(3);
    expect(sel('all,!gw-1')).toEqual(['pad-red-1', 'pad-blue-2']);
    expect(sel('!tag:poc')).toEqual(['gw-1']);
    expect(sel('role:gateway')).toEqual(['gw-1']);
    expect(sel('profile:c3o-pad')).toEqual(['pad-blue-2']);
    expect(sel('board:ESP32C6-SUPERMINI')).toEqual(['pad-red-1']);
  });

  it('counts a suspect device as online and an unknown one as offline', () => {
    expect(sel('online')).toEqual(['pad-red-1', 'pad-blue-2']);
    expect(sel('offline')).toEqual(['gw-1']);
    expect(selectDevices(devs, 'offline', () => 'unknown')).toHaveLength(3);
  });

  it('names devices by alias (any case), id:, mac: or a bare device id', () => {
    expect(sel('PAD-RED-1')).toEqual(['pad-red-1']);
    expect(sel(`id:${C3}`)).toEqual(['pad-blue-2']);
    expect(sel('mac:1C:DB:D4:16:BA:34')).toEqual(['pad-blue-2']);
    expect(sel(C6.toUpperCase())).toEqual(['pad-red-1']);
  });

  it('fails on a name that matches nothing, but not on an empty facet', () => {
    expect(() => sel('pad-rde-1')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(() => sel('tag:poc,!pad-rde-1')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(sel('tag:nothing')).toEqual([]);
  });

  it('rejects malformed terms', () => {
    for (const bad of ['', 'a,,b', 'id:xyz', 'mac:1c:db', 'chip:esp32', 'role:boss', 'color:red', 'tag:', '!']) {
      expect(() => parseSelector(bad), bad).toThrow(expect.objectContaining({ code: 'INVALID_ARGS' }));
    }
  });
});

describe('device ops', () => {
  function hubFor(db: Db, presence: Record<string, Presence> = {}) {
    const events = createEvents(db, new CursorSeq(db), 1);
    const seen: HubEvent[] = [];
    events.subscribe((e) => seen.push(e));
    const pushAlias = vi.fn();
    const serial = { list: () => [{ path: '/dev/cu.usbmodem1101', device_id: C3, state: 'open', lines: 0 }] };
    const hub = {
      db,
      serial,
      registry: createRegistry(db),
      router: { presence: (id: string) => presence[id] ?? 'unknown', online: () => [], sendCommand: vi.fn(), pushAlias },
      events,
    } as unknown as HubContext;
    return { hub, seen, pushAlias };
  }

  it('device_list returns rows with presence and USB port, filtered by selector', async () => {
    const db = openDb(':memory:');
    provisioned(db, C6, 'c6-pad', 'esp32c6', 'pad-red-1');
    provisioned(db, C3, 'c3o-pad', 'esp32c3', 'pad-blue-2');
    new SqliteRegistry(db).touchHello(S3, hello({ device_id: S3, chip: 9 }));
    const { hub } = hubFor(db, { [C6]: 'online' });
    const all = (await HANDLERS.device_list({}, hub)) as { devices: Array<Record<string, unknown>>; count: number; truncated: boolean };
    expect(all.count).toBe(3);
    expect(all.truncated).toBe(false);
    expect(all.devices.map((d) => d.alias)).toEqual(['esp32s3-000001', 'pad-blue-2', 'pad-red-1']);
    expect(all.devices.find((d) => d.alias === 'pad-blue-2')).toMatchObject({ port: '/dev/cu.usbmodem1101', port_state: 'open', presence: 'unknown', provisioned: true });
    expect(all.devices.find((d) => d.alias === 'esp32s3-000001')).toMatchObject({ provisioned: false, addr: null });
    const online = (await HANDLERS.device_list({ selector: 'online' }, hub)) as { devices: Array<{ alias: string; presence: string }> };
    expect(online.devices).toEqual([expect.objectContaining({ alias: 'pad-red-1', presence: 'online' })]);
  });

  it('device_get takes one device and shows its provisioning record', async () => {
    const db = openDb(':memory:');
    provisioned(db, C6, 'c6-pad', 'esp32c6', 'pad-red-1');
    provisioned(db, C3, 'c3o-pad', 'esp32c3', 'pad-blue-2');
    const { hub } = hubFor(db);
    const got = (await HANDLERS.device_get({ device: 'pad-red-1' }, hub)) as Record<string, unknown>;
    expect(got).toMatchObject({ device_id: C6, addr: 1, provision: { ident: { offset: 0x3fc000, size: 0x4000 } } });
    await expect(Promise.resolve().then(() => HANDLERS.device_get({ device: 'tag:none' }, hub))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(Promise.resolve().then(() => HANDLERS.device_get({ device: 'all' }, hub))).rejects.toMatchObject({
      code: 'AMBIGUOUS_SELECTOR',
      details: { candidates: [{ device_id: C3, alias: 'pad-blue-2' }, { device_id: C6, alias: 'pad-red-1' }] },
    });
  });

  it('device_update renames (push + registry.drift) and edits tags', async () => {
    const db = openDb(':memory:');
    provisioned(db, C6, 'c6-pad', 'esp32c6', 'pad-red-1');
    const { hub, seen, pushAlias } = hubFor(db, { [C6]: 'online' });
    const r = (await HANDLERS.device_update({ device: 'pad-red-1', alias: 'pad-green', tag: '+poc' }, hub)) as Record<string, unknown>;
    expect(r).toMatchObject({ alias: 'pad-green', alias_rev: 2, tags: ['poc'], previous_alias: 'pad-red-1', alias_pushed: true });
    expect(pushAlias).toHaveBeenCalledWith(C6);
    expect(seen).toEqual([expect.objectContaining({ type: 'registry.drift', device: C6, alias: 'pad-green', fields: { alias: 'pad-green', alias_rev: 2, previous_alias: 'pad-red-1' } })]);
    // Tags only: no rename, no push.
    const t = (await HANDLERS.device_update({ device: 'pad-green', tag: '-poc,lab' }, hub)) as Record<string, unknown>;
    expect(t).toMatchObject({ tags: ['lab'], alias_rev: 2 });
    expect(t.previous_alias).toBeUndefined();
    expect(pushAlias).toHaveBeenCalledTimes(1);
    await expect(Promise.resolve().then(() => HANDLERS.device_update({ device: 'pad-green' }, hub))).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(Promise.resolve().then(() => HANDLERS.device_update({ device: 'pad-green', alias: 'online' }, hub))).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  });

  it('are in the op registry with the spec CLI paths', () => {
    expect(findOp('device_list')?.cli).toEqual({ path: ['devices', 'ls'], positional: ['selector'] });
    expect(findOp('device_get')?.cli).toEqual({ path: ['devices', 'get'], positional: ['device'] });
    expect(findOp('device_update')?.cli).toEqual({ path: ['devices', 'set'], positional: ['device'] });
    expect(findOp('device_provision')?.cli).toEqual({ path: ['devices', 'provision'] });
    expect(findOp('flash_start')?.cli).toEqual({ path: ['flash'], positional: ['device'] });
  });
});

function dev(device_id: string, alias: string, over: Partial<Device> = {}): Device {
  return {
    device_id,
    addr: null,
    alias,
    alias_rev: 1,
    net: null,
    board: null,
    profile: null,
    chip: null,
    tags: [],
    role: 'node',
    fw_id: null,
    provisioned: true,
    last_seen: null,
    last_epoch: null,
    created_at: '2026-10-21T00:00:00Z',
    ...over,
  };
}

function manifestFor(buildId: string, fw: string): ArtifactManifest {
  mkdirSync(dir, { recursive: true });
  return {
    schema: 'fractonica.artifact/1',
    build_id: buildId,
    app: 'node',
    profile: 'c6-pad',
    build_type: 'debug',
    board: 'esp32c6-supermini',
    target: 'esp32c6',
    chip_id: 13,
    part_profile: 'fr-4mb-v1',
    version: '0.1.0',
    source_dir: '/src',
    git: { sha: 'abc', dirty: false },
    idf: { version: 'v6.1', commit: 'def' },
    fw_id: fw,
    elf_sha256: '00',
    size: 1,
    built_at: '2026-10-21T10:00:00Z',
    flash: { mode: 'dio', freq: '80m', size: '4MB', files: [] },
    partitions: [],
  };
}
