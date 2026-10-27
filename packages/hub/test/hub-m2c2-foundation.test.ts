// The M2-C2 foundation as the hub sees it (design m2-c2 §3 item 7): a LOG frame reaches the log ingest decoded (an
// undecodable one counts log_bad), and is dropped as before without one; F's ingest only counts; the scale counters
// start at zero per router; and registerImage (D9) puts an image no IDF build made into the artifact store, which
// fake-node.ts's addArtifact now wraps.

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { CLS } from '@fractonica/protocol';
import { ADDR, encodeLogLine, KIND, PORT } from '@fractonica/protocol/gen';

import { blobPath, listArtifacts, loadManifest, newestBuildId, registerImage } from '../src/artifacts.ts';
import { type Db, openDb } from '../src/db.ts';
import { EventStore } from '../src/events/index.ts';
import { createLogIngest, type LogFrame, type LogIngest } from '../src/logs/ingest.ts';
import { LogStore } from '../src/logstore.ts';
import { createRouter, type HubRouter } from '../src/router/index.ts';
import { createScaleCounters, type ScaleCounters } from '../src/router/scale.ts';
import { CursorSeq } from '../src/seq.ts';
import { BIN, makeImage } from './cpp-node.ts';
import { FakeNode, FakeRegistry, FakeSerial, until } from './fake-node.ts';

const savedHome = process.env.FR_HOME;
let dir = '';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'fr-m2c2-'));
  process.env.FR_HOME = join(dir, 'home');
});
afterAll(() => {
  if (savedHome === undefined) {
    delete process.env.FR_HOME;
  } else {
    process.env.FR_HOME = savedHome;
  }
  rmSync(dir, { recursive: true, force: true });
});

/** A router on loopback as fake-node.ts's rig() builds it, with the M2-C2 deps it does not pass. */
interface LogRig {
  router: HubRouter;
  logs: LogStore;
  node: FakeNode;
  close(): Promise<void>;
}
const open: LogRig[] = [];
afterEach(async () => {
  for (const r of open.splice(0)) {
    await r.close();
  }
});

async function logRig(deps: { logIngest?: LogIngest; scale?: ScaleCounters }): Promise<LogRig> {
  const db = openDb(join(mkdtempSync(join(dir, 'rig-')), 'hub.db'));
  const seq = new CursorSeq(db);
  const logs = new LogStore(db, 1, { retention: false, seq });
  const events = new EventStore(db, seq, 1);
  const router = createRouter({
    db,
    logs,
    serial: new FakeSerial(),
    seq,
    registry: new FakeRegistry(),
    events,
    hubEpoch: 7,
    links: { host: '127.0.0.1', tcpPort: 0, udpPort: 0 },
    config: { timeSampleTimeoutMs: 200 },
    ...deps,
  });
  await router.start();
  const ports = router.ports()!;
  const node = new FakeNode({ mac: 'aabbccdd0c02', addr: 12, alias: 'pad', autoHeartbeat: false, hub: { tcp: ports.tcp, udp: ports.udp } });
  await node.connect();
  await node.connected(events);
  const r: LogRig = {
    router,
    logs,
    node,
    async close() {
      node.close();
      await router.stop();
      events.stop();
      logs.close();
      db.close();
    },
  };
  open.push(r);
  return r;
}

const LINE = { tag: 'fr_core', text: 'I (10234) fr_core: alive fw=3f2a9c01b2d4 up=10' };

describe('LOG frames into the log ingest (design m2-c2 D21)', () => {
  it('hands each one decoded, with the device, link, level and the session clock', async () => {
    const frames: LogFrame[] = [];
    const scale = createScaleCounters();
    const r = await logRig({ logIngest: { frame: (f) => frames.push(f) }, scale });
    const { seq } = r.node.sendTo(ADDR.HUB, CLS.LOG, KIND.LOG.I, PORT.NODE, encodeLogLine(LINE));
    // A tag-only body still decodes; invalid UTF-8 in text does not (log_bad).
    r.node.sendTo(ADDR.HUB, CLS.LOG, KIND.LOG.W, PORT.NODE, new Uint8Array([0x12, 0x02, 0xff, 0xfe]));
    r.node.sendTo(ADDR.HUB, CLS.LOG, KIND.LOG.E, PORT.NODE, encodeLogLine({ tag: 'boot' }));
    await until(() => frames.length === 2 && scale.log_bad === 1, 3000, 'two LOG frames and a bad one');
    expect(frames[0]).toMatchObject({ device: 'aabbccdd0c02', alias: 'pad', link: 'tcp', level: 3, line: LINE, header: { cls: CLS.LOG, seq } });
    // The boot epoch rides in the header: the ingest keys how far that boot's esp_log runs ahead on it (t_log_us).
    expect(frames[0].header.epoch).toBe(r.node.opts.epoch);
    expect(frames[0].rx_us).toBeGreaterThan(0);
    expect(typeof frames[0].clock.synced()).toBe('boolean');
    expect(frames[1]).toMatchObject({ level: 1, line: { tag: 'boot', text: '' } });
    expect(scale.log_frames).toBe(0); // counting them is the ingest's
  });

  it('drops them without an ingest, as before (serial logs only)', async () => {
    const scale = createScaleCounters();
    const r = await logRig({ scale });
    r.node.sendTo(ADDR.HUB, CLS.LOG, KIND.LOG.I, PORT.NODE, encodeLogLine(LINE));
    r.node.sendTo(ADDR.HUB, CLS.LOG, KIND.LOG.I, PORT.NODE, new Uint8Array([0x12, 0x02, 0xff, 0xfe]));
    // A frame after them shows the router got past both.
    r.node.heartbeat();
    await new Promise((res) => setTimeout(res, 200));
    // The router counts its own handshake and DIRECTORY figures into the same object (S3); the LOG ones stay zero.
    expect({ log_frames: scale.log_frames, log_bad: scale.log_bad, log_dropped: scale.log_dropped, logs_dup: scale.logs_dup }).toEqual({
      log_frames: 0,
      log_bad: 0,
      log_dropped: 0,
      logs_dup: 0,
    });
    // Only the hub's own lines about the session (port `hub`).
    expect(r.logs.query({ devices: ['aabbccdd0c02'], limit: 10, direction: 'tail' }).filter((l) => l.port !== 'hub')).toEqual([]);
  });

  it('the ingest counts every frame and stores none that has no line; counters start at zero', () => {
    const scale = createScaleCounters();
    expect(Object.values(scale).every((v) => v === 0)).toBe(true);
    expect(createScaleCounters()).not.toBe(scale);
    const db = openDb(join(mkdtempSync(join(dir, 'ingest-')), 'hub.db'));
    const store = new LogStore(db, 1, { retention: false });
    const ingest = createLogIngest(store, scale);
    ingest.frame({} as LogFrame);
    ingest.frame({} as LogFrame);
    expect(scale.log_frames).toBe(2);
    expect(store.query({ devices: null, limit: 10, direction: 'tail' })).toEqual([]);
    store.close();
    db.close();
  });
});

describe('registerImage (design m2-c2 D9)', () => {
  let db: Db;
  beforeAll(() => {
    db = openDb(join(mkdtempSync(join(dir, 'art-')), 'hub.db'));
  });
  afterAll(() => db.close());

  it('stores raw bytes under their sha256, with a manifest and a row ota_deploy can name', () => {
    const image = randomBytes(4096);
    const r = registerImage(db, { image, raw: true, profile: 'c6-pad', buildType: 'release' });
    expect(r.fw_id).toBe(createHash('sha256').update(image).digest('hex'));
    expect(r.buildId).toBe(`node/c6-pad/release/${r.fw_id.slice(0, 12)}`);
    expect(r.manifestPath).toBe(join(dir, 'home', 'artifacts', 'builds', r.buildId, 'manifest.json'));
    expect(loadManifest(db, r.buildId)).toEqual(r.manifest);
    expect(r.manifest).toMatchObject({ app: 'node', board: 'esp32c6-supermini', target: 'esp32c6', chip_id: 13, part_profile: 'fr-4mb-v1', size: 4096, build_type: 'release' });
    expect(r.manifest.flash.files).toEqual([{ offset: '0x10000', role: 'app', blob: `sha256:${r.fw_id}`, size: 4096 }]);
    expect(readFileSync(blobPath(r.manifest.flash.files[0].blob)).equals(image)).toBe(true);
    expect(newestBuildId(db, { app: 'node', profile: 'c6-pad', buildType: 'release' })).toBe(r.buildId);
    // The same image again (a re-run into the same FR_HOME) replaces its row, as ingestBuild does.
    const again = registerImage(db, { image, raw: true, profile: 'c6-pad', buildType: 'release' });
    expect(again.buildId).toBe(r.buildId);
    expect(db.prepare('SELECT count(*) AS n FROM artifacts WHERE build_id = ?').get(r.buildId)).toEqual({ n: 1 });
  });

  it('keeps a fault build out of the implicit picks', () => {
    const f = registerImage(db, { image: randomBytes(256), raw: true, profile: 'c3o-pad', buildType: 'debug', fault: 'health', manifest: { chip_id: 5 } });
    expect(f.buildId).toMatch(/^node\/c3o-pad\/debug-fault\/[0-9a-f]{12}$/);
    expect(f.manifest).toMatchObject({ fault: 'health', chip_id: 5, target: 'esp32c3' });
    expect(newestBuildId(db, { app: 'node', profile: 'c3o-pad', buildType: 'debug' })).toBeNull();
    expect(listArtifacts(db, { profile: 'c3o-pad', limit: 5 })).toMatchObject([{ build_id: f.buildId, fault: 'health' }]);
  });

  it('refuses bytes that are not an ESP app image unless they are raw', () => {
    expect(() => registerImage(db, { image: Buffer.alloc(512), profile: 'c6-pad', buildType: 'debug' })).toThrow(/ESP image magic/);
  });

  it.skipIf(!existsSync(BIN))("reads fw_id, version and fr_app_desc from fr_net_node's made image", () => {
    const made = makeImage(join(dir, 'made.bin'), { version: '0.2.0', size: 64 * 1024, seed: 3, fault: true });
    const r = registerImage(db, { image: made.image, profile: 'c6-pad', buildType: 'debug', fault: 'health' });
    expect(r.fw_id).toBe(made.fw_id);
    expect(r.manifest).toMatchObject({ version: '0.2.0', chip_id: 13, board: 'esp32c6-supermini', part_profile: 'fr-4mb-v1', app_desc: { profile: 'c6-pad', fault: 1 } });
  });
});
