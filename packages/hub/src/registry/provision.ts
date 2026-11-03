// device_provision (spec 06 §6.4; design c3 §4): one job takes a USB-attached board from blank (or
// foreign) firmware to a registered node:
//   lease -> probe (refuse secure boot / flash encryption) -> select the artifact (the probe's chip must
//   match) -> registry upsert (addr, alias, net, epoch_floor) -> render fr_ident (0700 temp dir) -> one
//   write_flash (full plan + fr_ident) -> hub reset (boot log captured) -> serial HELLO (<= 10 s) ->
//   HELLO over TCP (<= 30 s; reported as wifi joined | not_joined, not a failure). A gateway (role gateway, design
//   m2-c4-gateway D8) never opens TCP: its join is its GW_STATUS showing the AP (ap_channel or ap_rssi), via gateway_status.
// From M2-C1 (design m2-c1-hil D6, D15): the selected build goes through the fixture fence (S4's
// fixture/fence.ts) before anything is written, and a radio-off image (the HIL fixture's) has no join
// stage: its result says wifi off.
// The Wi-Fi password goes into the temp CSV and fr_ident.bin only (ident.ts); every log line, stage,
// result and error here is built from registry and network fields that never include it.

import { DEFAULT_NETWORK, type DeviceRole, FrError, MAX_WAIT_S, type ProvisionWifi } from '@fractonica/protocol';
import { decodePresenceHello } from '@fractonica/protocol/gen';
import { z } from 'zod';

import { loadManifest, newestBuildId } from '../artifacts.ts';
import type { HubContext } from '../context.ts';
import { assertFixtureImage, isFixtureBuild } from '../fixture/fence.ts';
import { flashPlan, hardResetCapturing, runPytools } from '../flash.ts';
import type { JobCtx } from '../jobs.ts';
import { checkBand, listNetworks, requireNetwork } from '../network.ts';
import { assertPortFree, nameBusyHolder } from '../ports/holders.ts';
import { nowUs } from '../ring.ts';
import { helloRole, routerInfo } from '../router/index.ts';
import { normalizeMac } from '../serial.ts';
import { pickArtifact, requireIdentRegion } from './flashing.ts';
import { isDeviceId, registryOf } from './hub.ts';
import { identNet, type PytoolsRunner, renderIdent, type RenderedIdent } from './ident.ts';
import { checkAlias } from './names.ts';
import { aliasTaken, CHIP_IDS, markIdentWritten, prepareIdentity, type ProvisionRecord } from './store.ts';

/** How long the node has to say HELLO on serial after the reset, and to say it over TCP after that (06 §6.4). */
export const SERIAL_HELLO_MS = 10_000;
export const TCP_JOIN_MS = 30_000;

/**
 * A HELLO as the log store keeps a serial frame (frames.ts: `@fr1 PRESENCE kind=1 <hex> (src=...)`). Used
 * next to the router's events so the serial HELLO is seen whether or not a router consumes the frame.
 */
const HELLO_LINE = '@fr1 PRESENCE kind=1 ';

/** What the sidecar's `probe` reports (tools/pytools). */
export const ProbeSchema = z.looseObject({
  chip: z.string(),
  mac: z.string(),
  description: z.string().optional(),
  features: z.array(z.string()).optional(),
  flash_size: z.string().nullable().optional(),
  secure_boot: z.boolean().optional(),
  flash_encryption: z.boolean().optional(),
  /** `read`, or `unsupported` on a ROM without GET_SECURITY_INFO (the classic ESP32): secure_boot and flash_encryption are then false. */
  security_info: z.enum(['read', 'unsupported']).optional(),
});
type Probe = z.infer<typeof ProbeSchema>;

/** esptool's CHIP_NAME (`ESP32-C6`) as the registry spells chips (`esp32c6`). */
export function chipFromProbe(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** `4MB`, `16MB`, `512KB` -> bytes; null for anything else. */
export function flashBytes(size: string | null | undefined): number | null {
  const m = /^(\d+)\s*(KB|MB)$/i.exec(size?.trim() ?? '');
  return m ? Number(m[1]) * (m[2].toUpperCase() === 'MB' ? 1 << 20 : 1 << 10) : null;
}

export interface ProvisionInput {
  port: string;
  profile?: string;
  build?: string;
  alias?: string;
  /** The stored network it joins (design csi-c1 D5); default: the registry row's, else `default`. */
  network?: string;
  wait_s?: number;
}

/**
 * Whether firmware of this HELLO role has its radio off (design m2-c1-hil D6), so it never joins Wi-Fi and
 * never takes an OTA over it. The role is the firmware's own word (CONFIG_FR_ROLE, in every HELLO, kept in
 * the registry from the last one), and codegen refuses a `role: fixture` profile unless it sets
 * `net.radio: off`, and `net.radio: off` on any other role (D5), so radio-off holds exactly for role fixture. Not HELLO `caps` b1 (wifi): the
 * serial session's HELLO goes out before start_wifi() sets it. Not the build manifest: the artifact
 * manifest does not carry the profile's `net` (ingestBuild keeps caps, catalog_hash and test_pin of
 * fr_manifest.json).
 */
export function radioOff(role: DeviceRole | null | undefined): boolean {
  return role === 'fixture';
}

/** What the D15 provisioning rules see: the probed device and the build chosen for it. */
export interface ProvisionTarget {
  /** The probed MAC (the device id): USB detection alone cannot tell fix-s3 from pad-s3 (D2). */
  device_id: string;
  /** The alias it will have, for the refusal's wording. */
  alias?: string;
  profile: string;
  build_id: string;
}

/**
 * The fixture fence's provisioning check (D15): throws when the build may not go on the device (a fixture
 * build on any device but the bench's fixture, or any other profile on the bench's fixture). Runs after the
 * probe and the artifact choice, before anything is written.
 */
export type ProvisionFence = (hub: HubContext, target: ProvisionTarget) => void;

/** S4's fence (fixture/fence.ts), with the probed MAC. */
export const PROVISION_FENCE: ProvisionFence = (hub, t) =>
  assertFixtureImage(hub, { deviceId: t.device_id, alias: t.alias }, { profile: t.profile, build_id: t.build_id }, 'device_provision');

/** What a gateway's last GW_STATUS says of its AP, and how long ago it came (null: none yet). */
export interface GatewayApStatus {
  ap_channel: number;
  ap_rssi: number;
  ms_ago: number | null;
}

/** The gateway's last GW_STATUS as the router holds it (device_get gateway.status); null for none. */
export const GATEWAY_AP_STATUS = (hub: HubContext, deviceId: string): GatewayApStatus | null => {
  const g = routerInfo(hub.router, deviceId)?.gateway;
  return g?.status ? { ap_channel: g.status.ap_channel, ap_rssi: g.status.ap_rssi, ms_ago: g.status_ms_ago } : null;
};

/** The sidecar, the HELLO deadlines and the fixture fence, replaceable in tests. */
export interface ProvisionDeps {
  pytools: PytoolsRunner;
  helloMs?: number;
  joinMs?: number;
  /** Default PROVISION_FENCE. */
  fence?: ProvisionFence;
  /** A gateway's GW_STATUS AP fields (its join); default GATEWAY_AP_STATUS. */
  gatewayStatus?: (hub: HubContext, deviceId: string) => GatewayApStatus | null;
}

/**
 * A gateway's join (design m2-c4-gateway D8: it associates as a STA but opens no TCP session, so no HELLO over TCP
 * ever comes): a GW_STATUS newer than `sinceMs` (Date.now() ms, the reset) whose ap_channel or ap_rssi is not 0.
 * Resolves its AP fields, or null after `ms`; rejects when the job is cancelled.
 */
function gatewayJoin(look: () => GatewayApStatus | null, sinceMs: number, ms: number, signal: AbortSignal): Promise<{ ap_channel: number; ap_rssi: number } | null> {
  return new Promise((resolve, reject) => {
    const done = (v: { ap_channel: number; ap_rssi: number } | null | Error) => {
      clearTimeout(timer);
      clearInterval(poll);
      signal.removeEventListener('abort', onAbort);
      return v instanceof Error ? reject(v) : resolve(v);
    };
    const check = () => {
      const st = look();
      if (st && st.ms_ago !== null && st.ms_ago <= Date.now() - sinceMs && (st.ap_channel !== 0 || st.ap_rssi !== 0)) {
        done({ ap_channel: st.ap_channel, ap_rssi: st.ap_rssi });
      }
    };
    const onAbort = () => done(signal.reason instanceof Error ? signal.reason : new FrError('INTERNAL', 'cancelled'));
    const timer = setTimeout(() => done(null), ms);
    const poll = setInterval(check, 200);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    } else {
      check();
    }
  });
}

export async function startProvision(input: ProvisionInput, hub: HubContext, deps: ProvisionDeps = { pytools: runPytools }): Promise<unknown> {
  // Everything that can fail without touching the board fails before the job starts.
  const alias = input.alias === undefined ? undefined : checkAlias(input.alias);
  // ENV_MISSING with the hint `fr net set` when no network is stored (06 §6.4 step 5); NOT_FOUND for a named one that is not.
  identNet(input.network !== undefined ? requireNetwork(hub.db, input.network) : (listNetworks(hub.db)[0] ?? null));
  if (input.build) {
    loadManifest(hub.db, input.build);
  } else if (input.profile) {
    pickArtifact(hub, { profile: input.profile });
  }
  const entry = await hub.serial.resolveWait(input.port);
  {
    // The network the job will use, as far as it is known before the probe: a missing one fails now.
    const known = isDeviceId(entry.key) ? registryOf(hub).get(entry.key) : null;
    const net = requireNetwork(hub.db, input.network ?? known?.network ?? DEFAULT_NETWORK);
    identNet(net);
    if (known?.chip) {
      checkBand(net, known.chip, known.alias); // design csi-c1 D6: refused before the job (the probe checks again)
    }
  }
  if (alias !== undefined) {
    const holder = registryOf(hub).byAlias(alias);
    if (holder && holder.device_id !== entry.key) {
      throw aliasTaken(alias, holder.device_id);
    }
  }
  // A serial lease, or another program (a Web Serial tab), has the port: refused before the job (design c6 D5).
  await assertPortFree(hub, { ...entry, alias: alias ?? (isDeviceId(entry.key) ? registryOf(hub).get(entry.key)?.alias : undefined) });
  const job = hub.jobs.start('provision', [entry.key], [`port:${entry.key}`, `device:${entry.key}`], (ctx) =>
    provisionJob(hub, ctx, { ...input, alias }, entry.key, deps),
  );
  return hub.jobs.wait(job.job_id, Math.min(input.wait_s ?? 0, MAX_WAIT_S));
}

/**
 * Watches for the device's HELLO per link from the moment it is created. Serial: the router's
 * `device.online` or `device.link {up: true}` events with `fields.link`, or the HELLO frame in the log
 * store (seen whether or not a router consumes it). TCP: those events (a node already online over USB
 * that joins Wi-Fi gets `device.link`, not a second `device.online`), or a TCP session in the router's
 * link info as a backstop. A TCP session from before the flash cannot be mistaken for the join: the chip
 * sat in the loader for the whole flash, far past the 3.5 heartbeat intervals after which the router
 * ends it (05 §5.11).
 */
function watchHello(hub: HubContext, deviceId: string, portKey: string) {
  const seen = { serial: false, tcp: false };
  /** The serial HELLO's role: decoded from the frame, or the registry's once the router has taken it. */
  let serialRole: DeviceRole | null = null;
  const waiters = new Set<() => void>();
  const mark = (link: 'serial' | 'tcp') => {
    if (!seen[link]) {
      seen[link] = true;
      waiters.forEach((w) => w());
    }
  };
  const offEvents = hub.events.subscribe((e) => {
    const link = e.fields?.link;
    const up = e.type === 'device.online' || (e.type === 'device.link' && e.fields?.up === true);
    if (e.device === deviceId && up && (link === 'serial' || link === 'tcp')) {
      // The router records a HELLO in the registry (touchHello) before it says the device is online.
      if (link === 'serial' && serialRole === null) {
        serialRole = registryOf(hub).get(deviceId)?.role ?? null;
      }
      mark(link);
    }
  });
  const offLogs = hub.logs.subscribe((l) => {
    if (l.device === portKey && l.kind === 'frame' && l.text.startsWith(HELLO_LINE)) {
      serialRole ??= helloLineRole(l.text);
      mark('serial');
    }
  });
  const tcpSession = () => routerInfo(hub.router, deviceId)?.links.includes('tcp') === true;
  return {
    /** Resolves true once `link` saw a HELLO, false after `ms`; rejects when the job is cancelled. */
    wait(link: 'serial' | 'tcp', ms: number, signal: AbortSignal): Promise<boolean> {
      return new Promise((resolve, reject) => {
        const done = (v: boolean | Error) => {
          clearTimeout(timer);
          clearInterval(poll);
          waiters.delete(check);
          signal.removeEventListener('abort', onAbort);
          return v instanceof Error ? reject(v) : resolve(v);
        };
        const check = () => {
          if (link === 'tcp' && !seen.tcp && tcpSession()) {
            seen.tcp = true;
          }
          if (seen[link]) {
            done(true);
          }
        };
        const onAbort = () => done(signal.reason instanceof Error ? signal.reason : new FrError('INTERNAL', 'cancelled'));
        const timer = setTimeout(() => done(false), ms);
        const poll = link === 'tcp' ? setInterval(check, 200) : undefined;
        waiters.add(check);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) {
          onAbort();
        } else {
          check();
        }
      });
    },
    /** The role the serial HELLO carried, or null when it was not seen or not readable. */
    serialRole: () => serialRole,
    stop() {
      offEvents();
      offLogs();
    },
  };
}

/** The role in a HELLO as the log store keeps it (`@fr1 PRESENCE kind=1 <body hex> (src=...)`), or null. */
export function helloLineRole(text: string): DeviceRole | null {
  const body = text.slice(HELLO_LINE.length).split(' ')[0];
  if (!/^(?:[0-9a-f]{2})+$/.test(body)) {
    return null;
  }
  const hello = decodePresenceHello(Buffer.from(body, 'hex'));
  return hello.ok ? helloRole(hello.value.role) : null;
}

/** The artifact for the probed board: --build, else --profile or the registry's, else the one profile built for this chip. */
function selectArtifact(hub: HubContext, input: ProvisionInput, chip: string, known: string | null) {
  const profile = input.profile ?? known;
  if (input.build || profile) {
    return { ...pickArtifact(hub, { build: input.build, profile }), from: input.build ? 'build' : input.profile ? 'requested' : 'registry' };
  }
  // Board detection, M1: the profiles with a debug node artifact for this chip (06 §6.4 step 5).
  const profiles = (hub.db.prepare("SELECT DISTINCT profile FROM artifacts WHERE build_type = 'debug' AND substr(build_id, 1, 5) = 'node/'").all() as { profile: string }[]).map(
    (r) => r.profile,
  );
  const fits = profiles
    .map((p) => newestBuildId(hub.db, { app: 'node', profile: p, buildType: 'debug' }))
    .filter((b): b is string => b !== null)
    .map((b) => ({ buildId: b, manifest: loadManifest(hub.db, b) }))
    .filter((a) => a.manifest.target === chip);
  if (fits.length === 1) {
    return { ...fits[0], from: 'detected' };
  }
  if (fits.length === 0) {
    throw new FrError('NOT_FOUND', `no debug artifact is built for an ${chip} board`, {
      hint: 'the hub never builds implicitly',
      remediation: [{ tool: 'build_start', args: { profile: '<profile>' }, cli: 'fr build --profile <profile>' }],
    });
  }
  const candidates = fits.map((a) => a.manifest.profile);
  throw new FrError('INVALID_ARGS', `artifacts for several ${chip} profiles exist (${candidates.join(', ')}); pick one with --profile`, {
    remediation: candidates.map((p) => ({ tool: 'device_provision', args: { port: input.port, profile: p }, cli: `fr devices provision --port ${input.port} --profile ${p}` })),
    details: { candidates },
  });
}

async function provisionJob(hub: HubContext, ctx: JobCtx, input: ProvisionInput, portKey: string, deps: ProvisionDeps): Promise<unknown> {
  const t0 = Date.now();
  const warnings: string[] = [];
  ctx.stage('lease');
  const lease = await hub.serial.lease(portKey, `job ${ctx.jobId}`);
  let rendered: RenderedIdent | null = null;
  let deviceId: string;
  let record: ProvisionRecord;
  let buildId: string;
  let fwId: string;
  try {
    ctx.stage('probe');
    // A USB-UART bridge (design camera-c1 D4): esptool's classic DTR/RTS download sequence puts the chip in its loader
    // (`default-reset`, as on a chip's own USB, where it is the USB-JTAG sequence); said so the sidecar's default never decides.
    const before = lease.bridge ? { before: 'default-reset' } : {};
    const parsed = ProbeSchema.safeParse(await deps.pytools({ cmd: 'probe', port: lease.path, ...before }, ctx));
    if (!parsed.success) {
      throw new FrError('FLASH_FAILED', 'the sidecar probe returned an unexpected result', { details: { issues: parsed.error.issues } });
    }
    const probe: Probe = parsed.data;
    if (probe.secure_boot || probe.flash_encryption) {
      // Lab devices never use either: both burn eFuses for good (06 §6.9, 09 §9.2 forbidden tier).
      throw new FrError('INCOMPATIBLE_PROFILE', `the chip on ${lease.path} has ${probe.secure_boot ? 'secure boot' : 'flash encryption'} enabled; Fractonica does not provision such chips`, {
        hint: 'use another board; these eFuses cannot be undone',
      });
    }
    deviceId = normalizeMac(probe.mac);
    if (!isDeviceId(deviceId)) {
      throw new FrError('FLASH_FAILED', `the probe reported no usable MAC (${probe.mac})`);
    }
    if (isDeviceId(portKey) && portKey !== deviceId) {
      warnings.push(`the port's USB serial ${portKey} differs from the chip MAC ${deviceId}; the MAC is the device id`);
    }
    const chip = chipFromProbe(probe.chip);
    ctx.log(`probe: ${probe.description ?? probe.chip}, flash ${probe.flash_size ?? '?'}, mac ${deviceId}`, 'event');

    ctx.stage('select');
    const registry = registryOf(hub);
    const known = registry.get(deviceId);
    // Design csi-c1 D5, D6: the network it joins, and a 5 GHz-only one only for a chip with 5 GHz, before anything is written.
    const netRecord = requireNetwork(hub.db, input.network ?? known?.network ?? DEFAULT_NETWORK);
    checkBand(netRecord, chip, `the board on ${lease.path}`);
    const art = selectArtifact(hub, input, chip, known?.profile ?? null);
    const m = art.manifest;
    if (m.target !== chip) {
      throw new FrError('TARGET_MISMATCH', `${art.buildId} is for ${m.target}, but the board on ${lease.path} is an ${chip}`, {
        remediation: [{ tool: 'artifact_list', cli: 'fr artifacts ls' }],
      });
    }
    const have = flashBytes(probe.flash_size);
    const need = flashBytes(m.flash.size);
    if (have !== null && need !== null && have < need) {
      throw new FrError('INCOMPATIBLE_PROFILE', `${art.buildId} needs ${m.flash.size} of flash (${m.part_profile}); the board has ${probe.flash_size}`);
    }
    // D15: no fixture build on another device, nothing else on the bench's fixture (S4's fence).
    (deps.fence ?? PROVISION_FENCE)(hub, { device_id: deviceId, alias: input.alias ?? known?.alias, profile: m.profile, build_id: art.buildId });
    const region = requireIdentRegion(m);
    const plan = flashPlan(m, 'full', { ident: region });
    ctx.log(`artifact ${art.buildId} (${art.from})`, 'event');

    ctx.stage('registry');
    const net = identNet(netRecord);
    // A fixture build's row is a fixture from here, not from its first HELLO: apps and registry_rev never count it (D6).
    const role = isFixtureBuild(hub, { profile: m.profile }) ? ('fixture' as const) : undefined;
    const prep = prepareIdentity(hub.db, { deviceId, alias: input.alias, profile: m.profile, board: m.board, chip, net: netRecord.net_id, network: netRecord.name, role });
    const d = prep.device;
    ctx.log(`registry: ${d.alias} addr ${d.addr} net ${d.net} network ${netRecord.name} (band ${netRecord.band}) alias_rev ${d.alias_rev} epoch_floor ${prep.epoch_floor}`, 'event');

    ctx.stage('render');
    const prov_ts = Math.floor(Date.now() / 1000);
    rendered = await renderIdent(
      {
        device_id: deviceId,
        addr: d.addr!,
        net: d.net!,
        alias: d.alias,
        alias_rev: d.alias_rev,
        epoch_floor: prep.epoch_floor,
        board: m.board,
        profile: m.profile,
        part_profile: m.part_profile,
        prov_ts,
      },
      net,
      region.size,
      ctx,
      deps.pytools,
    );
    if (net.pass === undefined) {
      warnings.push(`no Wi-Fi password is stored: ${net.ssid} is treated as an open network`);
    }

    ctx.stage('flash');
    ctx.log(`flashing ${art.buildId} (full + fr_ident) to ${lease.path}`, 'event');
    await deps.pytools(
      {
        cmd: 'flash',
        port: lease.path,
        files: [...plan.files.map((f) => ({ offset: f.offset, path: f.path })), { offset: plan.ident!.offset, path: rendered.path }],
        ...before,
        // The chip stays in the loader; the hub resets it on its own handle below (06 §6.4 step 8).
        after: 'no-reset',
        expect_chip_id: m.chip_id ?? CHIP_IDS[chip],
      },
      ctx,
    );
    buildId = art.buildId;
    fwId = m.fw_id;
    record = {
      at: new Date().toISOString(),
      via: 'provision',
      build_id: art.buildId,
      fw_id: m.fw_id,
      profile: m.profile,
      board: m.board,
      part_profile: m.part_profile,
      ident: region,
      addr: d.addr!,
      alias: d.alias,
      alias_rev: d.alias_rev,
      epoch_floor: prep.epoch_floor,
      net: d.net!,
      hub_host: net.hub_host,
      ssid: net.ssid,
      network: netRecord.name,
      prov_ts,
      probe: { chip: probe.chip, description: probe.description, features: probe.features, flash_size: probe.flash_size, mac: deviceId },
    };
  } catch (err) {
    // The sidecar's "port busy" names nobody: lsof says who (a Web Serial tab opened since the pre-check).
    throw await nameBusyHolder(hub, { path: lease.path, key: portKey }, err);
  } finally {
    // The CSV and image hold the password: gone as soon as the flash is over, whatever happened.
    rendered?.dispose();
    lease.release();
  }

  const device = markIdentWritten(hub.db, deviceId, record);
  hub.events.publish({
    type: 'device.provisioned',
    device: deviceId,
    alias: device.alias,
    t_hub_us: nowUs(),
    fields: { addr: device.addr, net: device.net, alias_rev: device.alias_rev, build_id: buildId, fw_id: fwId },
  });

  // Watched from before the reset, so a quick HELLO is not missed.
  const watch = watchHello(hub, deviceId, lease.key);
  const resetAt = Date.now();
  try {
    ctx.stage('reset');
    const reset = await hardResetCapturing(hub, lease.key, ctx);
    ctx.stage('hello');
    const helloMs = deps.helloMs ?? SERIAL_HELLO_MS;
    const joinMs = deps.joinMs ?? TCP_JOIN_MS;
    if (!(await watch.wait('serial', helloMs, ctx.signal))) {
      const tail = hub.logs.query({ devices: [lease.key], limit: 20, direction: 'tail' }).map((l) => l.text);
      throw new FrError('TIMEOUT', `${device.alias} was flashed and registered, but sent no HELLO on serial within ${helloMs / 1000} s`, {
        hint: 'the boot log tail shows what it did; an image without fr_net (before C3) never says HELLO',
        remediation: [{ tool: 'logs_read', args: { selector: deviceId } }],
        details: { device_id: deviceId, alias: device.alias, flashed: true, build_id: buildId, tail },
      });
    }
    ctx.log(`${device.alias}: HELLO on serial`, 'event');
    let wifi: ProvisionWifi;
    let via: 'tcp' | 'gateway_status' | undefined;
    let ap: { ap_channel: number; ap_rssi: number } | null = null;
    const role = watch.serialRole() ?? registryOf(hub).get(deviceId)?.role;
    if (radioOff(role)) {
      // A radio-off image (the HIL fixture's) has no join stage: it talks to the hub over serial only (D6).
      ctx.log(`${device.alias}: radio-off firmware (HELLO role ${role}): no Wi-Fi join`, 'event');
      wifi = 'off';
    } else {
      ctx.stage('join');
      if (role === 'gateway') {
        // A gateway associates with the AP but never opens TCP (design m2-c4-gateway D8): its GW_STATUS says it joined.
        const look = deps.gatewayStatus ?? GATEWAY_AP_STATUS;
        ap = await gatewayJoin(() => look(hub, deviceId), resetAt, joinMs, ctx.signal);
        ctx.log(
          `${device.alias}: ${ap ? `GW_STATUS shows the AP (channel ${ap.ap_channel}, ${ap.ap_rssi} dBm): joined Wi-Fi` : `no GW_STATUS with an AP channel within ${joinMs / 1000} s`}`,
          'event',
        );
        if (!ap) {
          warnings.push(`${device.alias} (a gateway) reported no AP in its GW_STATUS within ${joinMs / 1000} s; check the network (fr net get) and its serial log`);
        }
        wifi = ap ? 'joined' : 'not_joined';
        via = ap ? 'gateway_status' : undefined;
      } else {
        const joined = await watch.wait('tcp', joinMs, ctx.signal);
        ctx.log(`${device.alias}: ${joined ? 'HELLO over TCP (joined Wi-Fi)' : `no HELLO over TCP within ${joinMs / 1000} s`}`, 'event');
        if (!joined) {
          warnings.push(`${device.alias} did not reach the hub over Wi-Fi within ${joinMs / 1000} s; check the network (fr net get) and its serial log`);
        }
        wifi = joined ? 'joined' : 'not_joined';
        via = joined ? 'tcp' : undefined;
      }
    }
    return {
      device_id: deviceId,
      alias: device.alias,
      alias_rev: device.alias_rev,
      addr: device.addr,
      net: device.net,
      profile: record.profile,
      board: record.board,
      chip: device.chip,
      build_id: buildId,
      fw_id: fwId,
      port: lease.path,
      epoch_floor: record.epoch_floor,
      hub_host: record.hub_host,
      ssid: record.ssid,
      network: record.network ?? DEFAULT_NETWORK,
      reset,
      hello: 'serial',
      wifi,
      ...(via ? { via } : {}),
      ...(ap ? { ap } : {}),
      duration_ms: Date.now() - t0,
      ...(warnings.length ? { warnings } : {}),
    };
  } finally {
    watch.stop();
  }
}
