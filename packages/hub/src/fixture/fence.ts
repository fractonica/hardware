// The fixture fence (design m2-c1-hil D15; stream S4): only the hub's fixture module sends CMDs to a
// role:fixture device, so its gating (D8, D11) cannot be bypassed, and M2-C7 can rule that a fixture-made
// BOOT edge is never approval. It guards against accidents, not attacks (09 §9.2).
//
// Refused from clients, INVALID_ARGS with details.reason fixture_internal (POLICY_DENIED from M2-C7):
//   - command_send (and input_simulate's inject layer) to a fixture: presses go through layer gpio;
//   - binding_set with a fixture at either end: each end's device term resolved to devices, under the
//     router's presence and under every device online and every one offline, so no atom (online, `!`
//     terms, tags) slips the fixture past the check;
//   - diag_exec on a fixture, except the read-only lines info, stats and selftest: checked on the port text
//     and again on the device the port resolves to (a re-enumerating port addressed by its path);
//   - serial_lease of a fixture's port: the holder would own its raw diag channel and esptool;
//   - OTA to a fixture (ota_deploy, and deploy through it): the fixture is updated over USB only;
//   - flash_start or device_provision of a role: fixture build to any device but the bench's fixture, and of
//     any profile but the bench fixture's own onto it. USB and esptool detection cannot tell fix-s3 from
//     pad-s3 (D2), and both may sit on one desk hub: this is what keeps them from being swapped.
// A fixture is the bench's `fixture.device`, or any device whose registry role is fixture; for images, the
// bench's fixture device (with no bench loaded, a role:fixture one). flash_start (registry/flashing.ts) and provisioning (registry/provision.ts, stream S5) call
// assertFixtureImage once they know the target's device id.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { FrError, type Remediation } from '@fractonica/protocol';

import type { Device, HubContext, Presence } from '../context.ts';
import { isDeviceId, presenceOf } from '../registry/hub.ts';
import { normalizeMac } from '../serial.ts';

/** details.reason of every fence refusal. */
export const FIXTURE_INTERNAL = 'fixture_internal';
/** The diag lines a client may still run on the fixture: read-only (D15). */
export const FIXTURE_DIAG_LINES: readonly string[] = ['info', 'stats', 'selftest'];

type FenceHub = Pick<HubContext, 'db' | 'hubSourceDir'> & Partial<Pick<HubContext, 'registry' | 'fixture' | 'serial' | 'router'>>;

/** The bench's fixture device id, or null with no bench loaded. */
function benchFixture(hub: FenceHub): { device: string; profile: string } | null {
  const b = hub.fixture?.bench() ?? null;
  return b ? { device: b.fixture.device, profile: b.fixture.profile } : null;
}

/** A HIL fixture: the bench's fixture device, or any device whose registry role is fixture (its HELLO says so). */
export function isFixtureDevice(hub: FenceHub, dev: Pick<Device, 'device_id' | 'role'> | string): boolean {
  const id = typeof dev === 'string' ? dev : dev.device_id;
  if (benchFixture(hub)?.device === id) {
    return true;
  }
  return (typeof dev === 'string' ? safeGet(hub, id)?.role : dev.role) === 'fixture';
}

/**
 * The device a fixture image belongs on: the bench's fixture device; with no bench loaded, a device whose
 * registry role is fixture. (A role:fixture device the bench does not name may take a node image: that
 * retires it.)
 */
function isImageFixture(hub: FenceHub, id: string): boolean {
  const bench = benchFixture(hub);
  return bench ? id === bench.device : safeGet(hub, id)?.role === 'fixture';
}

function safeGet(hub: FenceHub, id: string): Device | null {
  try {
    return hub.registry?.get(id) ?? null;
  } catch {
    return null;
  }
}

/** A fence refusal: INVALID_ARGS, details.reason fixture_internal, remediation input_simulate {layer: gpio}. */
export function fixtureRefusal(message: string, details: Record<string, unknown> = {}, remediation?: Remediation[]): FrError {
  return new FrError('INVALID_ARGS', message, {
    hint: 'only the hub fixture module commands the HIL fixture (design m2-c1-hil D15): press DUT buttons with input_simulate {layer: gpio}, and read the bench with bench_get',
    remediation: remediation ?? [
      { tool: 'input_simulate', args: { selector: '<dut>', instance: 'boot', gesture: 'click', layer: 'gpio' } },
      { tool: 'bench_get' },
    ],
    details: { reason: FIXTURE_INTERNAL, ...details },
  });
}

/** command_send (and an inject input_simulate): refused when any selected device is the fixture. */
export function fenceCommand(hub: FenceHub, devices: readonly Device[], op: string): void {
  const fixtures = devices.filter((d) => isFixtureDevice(hub, d));
  if (fixtures.length) {
    throw fixtureRefusal(`${op} to the HIL fixture ${fixtures.map((d) => d.alias).join(', ')} is refused: it is driven by the hub's fixture module only`, {
      op,
      devices: fixtures.map((d) => d.device_id),
    });
  }
}

/** The device ids that are fixtures: the bench's fixture device and every registry row whose role is fixture. */
export function fixtureIds(hub: FenceHub): string[] {
  const ids = new Set<string>();
  const bench = benchFixture(hub);
  if (bench) {
    ids.add(bench.device);
  }
  try {
    for (const d of hub.registry?.list() ?? []) {
      if (d.role === 'fixture') {
        ids.add(d.device_id);
      }
    }
  } catch {
    // a registry that cannot list: the bench's fixture is still known
  }
  return [...ids];
}

/**
 * The devices a binding end's device term ("<term>.<instance>.<member>", "<term>.msg:<topic>") can resolve
 * to. binding_set resolves the term once, with the router's presence; this takes that answer and also the
 * ones with every device online and every device offline, so a presence atom (`online`, `!offline`) cannot
 * hide the fixture from the fence while the real resolution picks it, and no presence change between the
 * two can either. A term that does not resolve is left to binding_set, which says why.
 */
function endDevices(hub: FenceHub, text: string): Device[] {
  const dot = text.trim().indexOf('.');
  const term = dot > 0 ? text.trim().slice(0, dot) : '';
  if (!term || term.toLowerCase() === 'broadcast' || !hub.registry) {
    return [];
  }
  const found = new Map<string, Device>();
  const presences: ((id: string) => Presence)[] = [presenceOf(hub), () => 'online', () => 'offline'];
  for (const presence of presences) {
    try {
      for (const d of hub.registry.resolve(term, presence)) {
        found.set(d.device_id, d);
      }
    } catch {
      // binding_set says why it does not resolve
    }
  }
  return [...found.values()];
}

/** binding_set: refused when either end can resolve to the fixture, whatever atoms its selector uses. */
export function fenceBinding(hub: FenceHub, input: { from: string; to: string }): void {
  for (const [end, text] of [
    ['from', input.from],
    ['to', input.to],
  ] as const) {
    const fixtures = endDevices(hub, text).filter((d) => isFixtureDevice(hub, d));
    if (fixtures.length) {
      const dev = fixtures[0];
      throw fixtureRefusal(`binding_set with the HIL fixture ${dev.alias} as its ${end} end is refused: the fixture takes no bindings`, { op: 'binding_set', end, device: dev.device_id });
    }
  }
}

/** The device id a diag_exec `port` names: an attached port's key, a MAC or device id, or an alias. */
export function portDevice(hub: FenceHub, port: string): string | null {
  try {
    const key = hub.serial?.resolve(port).key;
    if (key && isDeviceId(key)) {
      return key;
    }
  } catch {
    // not attached: an id, a MAC or an alias may still name the device
  }
  const bare = port.replace(/^(mac|port|id):/, '');
  const mac = normalizeMac(bare);
  if (isDeviceId(mac)) {
    return mac;
  }
  try {
    return hub.registry?.byAlias(bare)?.device_id ?? null;
  } catch {
    return null;
  }
}

/**
 * diag_exec: on the fixture only the read-only lines info, stats and selftest. The fast path, on the `port`
 * text before it is resolved; diag_exec checks again with fenceDiagDevice once it knows the device.
 */
export function fenceDiag(hub: FenceHub, port: string, line: string): void {
  fenceDiagDevice(hub, portDevice(hub, port), line);
}

/**
 * diag_exec, on the device id the port resolved to (the session it goes over, or the attached port's key):
 * a /dev path of a port that is re-enumerating names no device until resolveWait has it back.
 */
export function fenceDiagDevice(hub: FenceHub, id: string | null, line: string): void {
  if (!id || !isFixtureDevice(hub, id)) {
    return;
  }
  const word = line.trim().split(/\s+/)[0] ?? '';
  if (!FIXTURE_DIAG_LINES.includes(word)) {
    throw fixtureRefusal(`diag_exec ${JSON.stringify(word)} on the HIL fixture is refused: only ${FIXTURE_DIAG_LINES.join(', ')} (read-only) are allowed`, {
      op: 'diag_exec',
      device: id,
      allowed: FIXTURE_DIAG_LINES,
    });
  }
}

/**
 * serial_lease: refused for a fixture's port (by the registry device the lease resolved, or the port's key
 * when it is a device id). The holder would own the fixture's USB-Serial/JTAG: raw diag lines past the
 * allowlist (`call chN.press`, `inject`, `reboot bootloader` on a FR_TEST_HOOKS build) and esptool writes
 * past the image rules. The fixture is updated with flash_start (the bench's profile) and read with
 * logs_read, diag_exec (info, stats, selftest) and bench_get. There is no override (D15).
 */
export function fenceLease(hub: FenceHub, port: { key: string; path: string; device?: Pick<Device, 'device_id' | 'alias' | 'role'> }): void {
  const id = port.device && isFixtureDevice(hub, port.device) ? port.device.device_id : isDeviceId(port.key) && isFixtureDevice(hub, port.key) ? port.key : null;
  if (!id) {
    return;
  }
  const alias = port.device?.alias ?? safeGet(hub, id)?.alias ?? id;
  const profile = benchFixture(hub)?.profile ?? '<fixture profile>';
  throw fixtureRefusal(
    `serial_lease of the HIL fixture ${alias} (${port.path}) is refused: a program holding its port would bypass the hub's gating and image rules`,
    { op: 'serial_lease', device: id, port: port.key },
    [
      { tool: 'flash_start', args: { device: alias, profile }, cli: `fr flash ${alias} --profile ${profile}` },
      { tool: 'logs_read', args: { selector: alias } },
      { tool: 'bench_get' },
    ],
  );
}

/** OTA (ota_deploy, and deploy through it): refused when any selected device is the fixture. */
export function fenceOta(hub: FenceHub, devices: readonly Device[]): void {
  const fixtures = devices.filter((d) => isFixtureDevice(hub, d));
  if (fixtures.length) {
    const f = fixtures[0];
    const profile = benchFixture(hub)?.profile ?? '<fixture profile>';
    throw fixtureRefusal(
      `OTA to the HIL fixture ${fixtures.map((d) => d.alias).join(', ')} is refused: the fixture is updated over USB only, with the build the bench pins`,
      { op: 'ota_deploy', devices: fixtures.map((d) => d.device_id) },
      [{ tool: 'flash_start', args: { device: f.alias, profile }, cli: `fr flash ${f.alias} --profile ${profile}` }],
    );
  }
}

/** A profile name that is safe in a path. */
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * A role: fixture build: its manifest says so (a `role` field, if the build manifest carries one), it is the
 * bench fixture's profile, or its profile file declares `role: fixture` (firmware/profiles/<p>.profile.yaml).
 */
export function isFixtureBuild(hub: FenceHub, image: { profile: string; role?: unknown }): boolean {
  if (image.role === 'fixture') {
    return true;
  }
  if (benchFixture(hub)?.profile === image.profile) {
    return true;
  }
  if (!PROFILE_NAME.test(image.profile)) {
    return false;
  }
  const file = join(hub.hubSourceDir ?? '', 'firmware', 'profiles', `${image.profile}.profile.yaml`);
  try {
    return existsSync(file) && /^role:\s*["']?fixture["']?\s*(#.*)?$/m.test(readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * D15 both ways, for an image about to be written to a device (flash_start once the port's device id is
 * known; device_provision after its probe, with the probed MAC): a fixture build only onto the bench's
 * fixture device, and only the bench fixture's profile onto it. `deviceId` null: a port that does not name
 * its chip (a USB-UART bridge), which can take no fixture build. Throws the refusal.
 */
export function assertFixtureImage(
  hub: FenceHub,
  target: { deviceId: string | null; alias?: string },
  image: { profile: string; build_id?: string; role?: unknown },
  op: 'flash_start' | 'device_provision',
): void {
  const bench = benchFixture(hub);
  const fixtureBuild = isFixtureBuild(hub, image);
  const who = target.alias ? `${target.alias} (${target.deviceId ?? 'unknown id'})` : (target.deviceId ?? 'this port');
  const onFixture = target.deviceId !== null && isImageFixture(hub, target.deviceId);
  const details = { op, device: target.deviceId, profile: image.profile, ...(image.build_id ? { build_id: image.build_id } : {}) };
  if (onFixture) {
    const ok = bench ? image.profile === bench.profile : fixtureBuild;
    if (!ok) {
      const want = bench?.profile ?? 'a role: fixture profile';
      throw fixtureRefusal(`${op} of ${image.profile} onto the HIL fixture ${who} is refused: it runs ${want} only (any other image would drive the DUTs' lines)`, { ...details, expected: bench?.profile ?? null }, [
        { tool: op, args: op === 'flash_start' ? { device: target.alias ?? target.deviceId, profile: want } : { profile: want } },
      ]);
    }
    return;
  }
  if (fixtureBuild) {
    const where = bench ? `the bench's fixture device ${bench.device}` : 'a device the bench names as its fixture (no bench file is loaded)';
    throw fixtureRefusal(`${op} of the fixture build ${image.profile} onto ${who} is refused: it goes only to ${where}`, { ...details, fixture: bench?.device ?? null }, [{ tool: 'bench_get' }]);
  }
}
