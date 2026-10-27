// flash_start (spec 09 §9.4, 06 §6.4 flash plans; design c3 §4): one USB-attached board, named by a
// device selector or a port. Plans that write fr_ident (full for a provisioned device, identity, recover)
// render it from the registry when the job runs, into a temp dir the job deletes; the plan and a dry run
// show only where it goes. Whether full writes or erases fr_ident is decided again once the job holds the
// port: a device_provision queued ahead of it may have registered the board since the request. M2-C1
// (design m2-c1-hil D15; stream S4): once the port's device id is known, the fixture fence's image rules.

import { type ArtifactManifest, FrError, MAX_WAIT_S } from '@fractonica/protocol';

import { loadManifest, newestBuildId } from '../artifacts.ts';
import { profileApp } from '../build.ts';
import type { Device, HubContext } from '../context.ts';
import { assertFixtureImage } from '../fixture/fence.ts';
import { type FlashPlan, flashPlan, hardResetCapturing, type IdentRegion, identRegion, type PlanName, runPytools } from '../flash.ts';
import { readNetwork } from '../network.ts';
import { assertPortFree, nameBusyHolder } from '../ports/holders.ts';
import { identNet, renderIdent, type RenderedIdent } from './ident.ts';
import { attachedPort, isDeviceId, registryOf, resolveOne } from './hub.ts';
import { CHIP_IDS, markIdentWritten, markImageFlashed, prepareIdentity, type ProvisionRecord, provisionOf } from './store.ts';

/**
 * The artifact to flash: `build` if given, else the newest debug artifact of (the profile's app, profile): node, or
 * gateway for c6g-gateway (its `app:` in the hub's checkout; node without one); a release build only by naming it
 * (spec 08 §8.5). NOT_FOUND points at build_start.
 */
export function pickArtifact(hub: Pick<HubContext, 'db'> & Partial<Pick<HubContext, 'hubSourceDir'>>, q: { build?: string; profile?: string | null }): { buildId: string; manifest: ArtifactManifest } {
  if (q.build) {
    return { buildId: q.build, manifest: loadManifest(hub.db, q.build) };
  }
  if (!q.profile) {
    throw new FrError('INVALID_ARGS', 'give --build <build_id> or --profile <profile> (its newest debug artifact is used)', {
      remediation: [{ tool: 'artifact_list', cli: 'fr artifacts ls' }],
    });
  }
  const app = profileApp(hub.hubSourceDir, q.profile);
  const buildId = newestBuildId(hub.db, { app, profile: q.profile, buildType: 'debug' });
  if (!buildId) {
    const release = newestBuildId(hub.db, { app, profile: q.profile, buildType: 'release' });
    throw new FrError('NOT_FOUND', `no debug artifact for profile ${q.profile}`, {
      ...(release ? { hint: `a release build exists; flash it with --build ${release}` } : {}),
      remediation: [{ tool: 'build_start', args: { profile: q.profile } }],
    });
  }
  return { buildId, manifest: loadManifest(hub.db, buildId) };
}

/** The fr_ident region of an artifact; INCOMPATIBLE_PROFILE for a layout without one. */
export function requireIdentRegion(m: ArtifactManifest): IdentRegion {
  const r = identRegion(m);
  if (!r) {
    throw new FrError('INCOMPATIBLE_PROFILE', `artifact ${m.build_id} has no fr_ident partition (part_profile ${m.part_profile})`, {
      hint: 'framework layouts (fr-4mb-v1 and up) end in a 16 KB fr_ident partition',
    });
  }
  return r;
}

/** What a plan does to fr_ident for one device as the registry has it at that moment. */
interface IdentDecision {
  writesIdent: boolean;
  region: IdentRegion | null;
  plan: FlashPlan;
}

function describeTarget(dev: Device | null, portKey: string): string {
  return dev ? `${dev.alias} (${dev.device_id})` : portKey;
}

/** identity and recover restore what the registry holds: NOT_FOUND for a device it never provisioned. */
function requireProvisioned(plan: PlanName, dev: Device | null, portKey: string): void {
  if ((plan === 'identity' || plan === 'recover') && !dev?.provisioned) {
    throw new FrError('NOT_FOUND', `${describeTarget(dev, portKey)} has no identity in the registry, so plan ${plan} has nothing to restore`, {
      hint: 'provision the board first; it writes fr_ident and registers it',
      remediation: [{ tool: 'device_provision', args: { port: portKey }, cli: `fr devices provision --port ${portKey}` }],
    });
  }
}

/**
 * full writes fr_ident for a provisioned device and erases it for any other (it boots UNASSIGNED);
 * identity and recover always write it. `art` is the artifact picked for the request.
 */
function decideIdent(
  hub: Pick<HubContext, 'db'>,
  plan: PlanName,
  dev: Device | null,
  portKey: string,
  art: { buildId: string; manifest: ArtifactManifest } | null,
): IdentDecision {
  requireProvisioned(plan, dev, portKey);
  const who = describeTarget(dev, portKey);
  const writesIdent = plan === 'identity' || plan === 'recover' || (plan === 'full' && dev?.provisioned === true);
  let region: IdentRegion | null = null;
  if (plan === 'identity') {
    // Only fr_ident is written: its place comes from the device's artifact if there is one, else from
    // the record of the last fr_ident write (the layout is frozen per part_profile, 06 §6.2).
    region = art ? requireIdentRegion(art.manifest) : (provisionOf(hub.db, dev!.device_id)?.ident ?? null);
    if (!region) {
      throw new FrError('NOT_FOUND', `no artifact or provisioning record says where ${who} keeps fr_ident`, {
        remediation: [{ tool: 'flash_start', args: { device: dev!.alias, plan: 'identity', profile: '<profile>' } }],
      });
    }
  } else if (writesIdent) {
    region = requireIdentRegion(art!.manifest);
  }
  const manifest = art?.manifest ?? null;
  if (writesIdent && manifest && dev?.chip && CHIP_IDS[dev.chip] !== undefined && CHIP_IDS[dev.chip] !== manifest.chip_id) {
    throw new FrError('TARGET_MISMATCH', `${art!.buildId} is for ${manifest.target}, but ${who} is an ${dev.chip}`, {
      remediation: [{ tool: 'build_start', args: { profile: dev.profile ?? '<profile>' } }],
    });
  }
  return { writesIdent, region, plan: flashPlan(manifest, plan, writesIdent ? { ident: region! } : {}) };
}

export interface FlashStartInput {
  device?: string;
  port?: string;
  build?: string;
  profile?: string;
  plan: PlanName;
  dry_run: boolean;
  wait_s?: number;
}

export async function startFlash(input: FlashStartInput, hub: HubContext): Promise<unknown> {
  if ((input.device === undefined) === (input.port === undefined)) {
    throw new FrError('INVALID_ARGS', input.device === undefined ? 'give device (a selector naming one device) or --port' : 'give device or --port, not both');
  }
  const registry = registryOf(hub);
  let dev: Device | null;
  let entry: { key: string; path: string };
  if (input.device !== undefined) {
    dev = resolveOne(hub, input.device);
    entry = await attachedPort(hub, dev);
  } else {
    entry = await hub.serial.resolveWait(input.port!);
    // With a port and no registry row, no fr_ident is written and the board boots UNASSIGNED (09 §9.4).
    dev = isDeviceId(entry.key) ? registry.get(entry.key) : null;
  }
  // The same row read again when the job runs (by the port's key while there is none yet).
  const deviceId = dev?.device_id ?? (isDeviceId(entry.key) ? entry.key : null);
  const deviceNow = (): Device | null => (deviceId ? registry.get(deviceId) : null);
  requireProvisioned(input.plan, dev, entry.key);

  let art: { buildId: string; manifest: ArtifactManifest } | null = null;
  if (input.plan === 'identity') {
    if (input.build || input.profile) {
      art = pickArtifact(hub, { build: input.build, profile: input.profile });
    } else if (dev!.profile && newestBuildId(hub.db, { app: profileApp(hub.hubSourceDir, dev!.profile), profile: dev!.profile, buildType: 'debug' })) {
      art = pickArtifact(hub, { profile: dev!.profile });
    }
  } else {
    art = pickArtifact(hub, { build: input.build, profile: input.profile ?? dev?.profile });
  }
  const manifest = art?.manifest ?? null;
  // An image goes onto the device (identity writes fr_ident only): a fixture build only onto the bench's
  // fixture, and only the bench fixture's profile onto it (D15), dry run included.
  if (art && input.plan !== 'identity') {
    const role = (art.manifest as { role?: unknown }).role;
    assertFixtureImage(hub, { deviceId, alias: dev?.alias }, { profile: art.manifest.profile, build_id: art.buildId, role }, 'flash_start');
  }
  // At request time for the dry run and to fail early; the job decides again once it holds the port.
  const { writesIdent, plan } = decideIdent(hub, input.plan, dev, entry.key, art);
  // Checked before the job: without a network record a written fr_ident could not reach the hub.
  const network = writesIdent ? readNetwork(hub.db) : null;
  if (writesIdent) {
    identNet(network); // ENV_MISSING now rather than after the lease
  }
  const identity = writesIdent && dev ? { device_id: dev.device_id, addr: dev.addr, alias: dev.alias, net: network!.net_id, hub_host: network!.hub_host } : undefined;
  if (input.dry_run) {
    return {
      dry_run: true,
      port: entry.path,
      device_id: dev?.device_id ?? entry.key,
      ...(dev ? { alias: dev.alias } : {}),
      ...(art ? { build_id: art.buildId, target: art.manifest.target } : {}),
      ...plan,
      ...(identity ? { identity } : {}),
    };
  }

  // A serial lease, or another program (a Web Serial tab), has the port: refused before the job (design c6 D5).
  await assertPortFree(hub, { ...entry, ...(dev ? { alias: dev.alias } : {}) });
  const deviceKey = dev?.device_id ?? entry.key;
  const job = hub.jobs.start('flash', [deviceKey], [`port:${entry.key}`, `device:${deviceKey}`], async (ctx) => {
    // The row as it is now that this job holds the port and the device: a provisioning that ran ahead
    // of it wrote an fr_ident that a full plan decided at request time would erase.
    const cur = deviceNow();
    const who = describeTarget(cur, entry.key);
    const { writesIdent, region, plan } = decideIdent(hub, input.plan, cur, entry.key, art);
    const chipId = manifest?.chip_id ?? (cur?.chip ? CHIP_IDS[cur.chip] : undefined);
    ctx.stage('lease');
    const lease = await hub.serial.lease(entry.key, `job ${ctx.jobId}`);
    let rendered: RenderedIdent | null = null;
    let record: ProvisionRecord | null = null;
    try {
      const files = plan.files.map((f) => ({ offset: f.offset, path: f.path }));
      if (writesIdent && cur) {
        ctx.stage('identity');
        const netRecord = readNetwork(hub.db);
        const net = identNet(netRecord);
        // identity rewrites fr_ident only: the profile and board stay those of the firmware the device runs.
        const imageWritten = input.plan !== 'identity';
        // Same addr and alias; net follows the network record, and epoch_floor moves past the last epoch seen.
        const prep = prepareIdentity(hub.db, {
          deviceId: cur.device_id,
          profile: imageWritten ? manifest!.profile : null,
          board: imageWritten ? manifest!.board : null,
          chip: cur.chip,
          net: netRecord!.net_id,
        });
        const d = prep.device;
        const profile = imageWritten ? manifest!.profile : (d.profile ?? manifest?.profile ?? null);
        const board = imageWritten ? manifest!.board : (d.board ?? manifest?.board ?? null);
        const partProfile = manifest?.part_profile ?? provisionOf(hub.db, d.device_id)?.part_profile ?? null;
        if (!profile || !board || !partProfile) {
          throw new FrError('NOT_FOUND', `the registry does not know ${who}'s profile, board and part_profile; flash it with --build or --profile`);
        }
        const prov_ts = Math.floor(Date.now() / 1000);
        rendered = await renderIdent(
          { device_id: d.device_id, addr: d.addr!, net: d.net!, alias: d.alias, alias_rev: d.alias_rev, epoch_floor: prep.epoch_floor, board, profile, part_profile: partProfile, prov_ts },
          net,
          region!.size,
          ctx,
        );
        ctx.log(`fr_ident for ${d.alias}: addr ${d.addr} net ${d.net} alias_rev ${d.alias_rev} epoch_floor ${prep.epoch_floor} (${rendered.size} B)`, 'event');
        files.push({ offset: plan.ident!.offset, path: rendered.path });
        record = {
          at: new Date().toISOString(),
          via: input.plan === 'identity' ? 'identity' : input.plan === 'recover' ? 'recover' : 'full',
          build_id: imageWritten ? art!.buildId : null,
          fw_id: imageWritten ? manifest!.fw_id : null,
          profile,
          board,
          part_profile: partProfile,
          ident: region!,
          addr: d.addr!,
          alias: d.alias,
          alias_rev: d.alias_rev,
          epoch_floor: prep.epoch_floor,
          net: d.net!,
          hub_host: net.hub_host,
          ssid: net.ssid,
          prov_ts,
        };
      }
      ctx.log(`flashing ${art?.buildId ?? 'fr_ident'} (${plan.plan}${rendered ? ' + fr_ident' : ''}) to ${lease.path}`, 'event');
      const t0 = Date.now();
      // esptool leaves the chip in the stub; the hub resets it after reopening the port so the boot
      // log (and the `fr: ready` banner) is captured.
      const res = await runPytools(
        {
          cmd: 'flash',
          port: lease.path,
          files,
          erase: plan.erase.map((e) => ({ offset: e.offset, size: e.size })),
          after: 'no-reset',
          // The sidecar refuses with TARGET_MISMATCH before writing if the connected chip differs.
          ...(chipId !== undefined ? { expect_chip_id: chipId } : {}),
        },
        ctx,
      ).catch(async (err: unknown) => {
        // The sidecar's "port busy" names nobody: lsof says who.
        throw await nameBusyHolder(hub, { path: lease.path, key: lease.key, ...(cur ? { alias: cur.alias } : {}) }, err);
      });
      rendered?.dispose();
      rendered = null;
      lease.release();
      if (record) {
        markIdentWritten(hub.db, cur!.device_id, record);
      } else if (cur && manifest) {
        markImageFlashed(hub.db, cur.device_id, { fw_id: manifest.fw_id, profile: manifest.profile, board: manifest.board });
      }
      ctx.stage('reset');
      const reset = await hardResetCapturing(hub, lease.key, ctx);
      return {
        device_id: deviceKey,
        ...(cur ? { alias: cur.alias } : {}),
        port: lease.path,
        ...(art && input.plan !== 'identity' ? { build_id: art.buildId, fw_id: art.manifest.fw_id } : {}),
        plan: plan.plan,
        ...(record ? { identity: { addr: record.addr, alias: record.alias, alias_rev: record.alias_rev, net: record.net, epoch_floor: record.epoch_floor } } : {}),
        duration_ms: Date.now() - t0,
        reset,
        sidecar: res,
      };
    } finally {
      rendered?.dispose();
      lease.release();
    }
  });
  return hub.jobs.wait(job.job_id, Math.min(input.wait_s ?? 0, MAX_WAIT_S));
}
