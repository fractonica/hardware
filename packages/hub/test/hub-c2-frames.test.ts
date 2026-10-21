import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  type ArtifactManifest,
  CLS,
  decodeFail,
  decodeOk,
  encodeSerialLine,
  type ManifestCap,
  packEnvelope,
  Reader,
  SERIAL_TYPE,
  unpackEnvelope,
} from '@fractonica/protocol';

import { encodeDiagMark, encodeNodeBoot } from '@fractonica/protocol/gen';

import { type Db, openDb } from '../src/db.ts';
import { type CapInfo, type FrameCodec, FrameDecoder, formatFrame, GENERATED_CODEC, type PortCap } from '../src/frames.ts';
import { LogStore, parseLine } from '../src/logstore.ts';

const DEV = '1cdbd416ba34';
const FW = '3f2a9c01b2d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e';

// Pinned vector lines (header from 05 §5.6, CRC checked independently): an EVENT fr.button.click
// {count: 1} on port 1, a STATE fr.button.pressed = true on port 1 (LATEST), and an ok RESULT for
// fr.led.blink on port 2 answering req_seq 4. All from src 0xFFFE (unassigned), epoch 3.
const CLICK = '@fr1:AaEAAwMMAAAAAAD-_wAAAwAiAYfWEgAIAQZD';
const PRESSED = '@fr1:AaEQBgEFAAAAAAD-_wAAAwAiAVDUEgAIAVii';
const BLINK_OK = '@fr1:AaEABQMNAAAAAAD-_wAAAwAiAgcABAAAAADc_A';

const CAPS: PortCap[] = [
  { name: 'boot', port: 1, cap: 'fr.button', cap_id: 1 },
  { name: 'status', port: 2, cap: 'fr.led', cap_id: 2 },
];

const CATALOG: CapInfo[] = [
  {
    id: 1,
    name: 'fr.button',
    commands: [{ id: 1, name: 'inject' }],
    events: [
      { id: 1, name: 'down' },
      { id: 2, name: 'up' },
      { id: 3, name: 'click' },
      { id: 4, name: 'long_press' },
    ],
    properties: [{ id: 1, name: 'pressed' }],
  },
  {
    id: 2,
    name: 'fr.led',
    commands: [
      { id: 1, name: 'set' },
      { id: 3, name: 'blink' },
    ],
    events: [{ id: 1, name: 'effect_done' }],
    properties: [{ id: 1, name: 'on' }],
  },
];

/** Stands in for the generated codecs: field 1 of every member is a varint named per member. */
const FAKE: FrameCodec = {
  decodeEnvelope: unpackEnvelope,
  findCap: (idOrName) => CATALOG.find((c) => c.id === idOrName || c.name === idOrName),
  decodeMember: (capId, part, memberId, bytes) => {
    const name = capId === 1 && part === 'event' && memberId === 3 ? 'count' : part === 'state' ? 'value' : 'x';
    const r = new Reader(bytes);
    const out: Record<string, unknown> = {};
    while (r.next()) {
      if (r.field === 1) {
        out[name] = part === 'state' ? r.readBool() : r.readUint(0xffffffff);
      } else {
        r.skip();
      }
    }
    return r.error ? decodeFail(r.error) : decodeOk(out);
  },
};

const header = (cls: number, kind: number, port: number) => ({ flags: 0, cls, kind, seq: 7, net: 0, src: 0x0102, dst: 0, epoch: 1, ttl: 0x22, port });

describe('formatFrame', () => {
  it('names instance and member from the manifest caps', () => {
    expect(formatFrame(CLICK, FAKE, CAPS)).toEqual({ kind: 'frame', text: '@fr1 EVENT boot.click {"count":1} (src=fffe seq=12 epoch=3 port=1)' });
    expect(formatFrame(PRESSED, FAKE, CAPS)).toEqual({ kind: 'frame', text: '@fr1 STATE boot.pressed {"value":true} (src=fffe seq=5 epoch=3 port=1)' });
    expect(formatFrame(BLINK_OK, FAKE, CAPS)).toEqual({ kind: 'frame', text: '@fr1 RESULT status.blink {} (src=fffe seq=13 epoch=3 port=2 status=ok req_seq=4)' });
  });

  it('falls back to port and kind with a hex body when names are unknown', () => {
    expect(formatFrame(CLICK, FAKE, null).text).toBe('@fr1 EVENT port=1 kind=3 0801 (src=fffe seq=12 epoch=3 port=1)');
    // A port the manifest does not list, and a member id the catalog does not know.
    expect(formatFrame(CLICK, FAKE, [{ name: 'x', port: 9, cap: 'fr.button', cap_id: 1 }]).text).toContain(' port=1 kind=3 0801 ');
    const odd = encodeSerialLine(SERIAL_TYPE.ENV, packEnvelope({ header: header(CLS.EVENT, 42, 1), prefix: { type: 'time', t_us: 0 }, body: new Uint8Array() }));
    expect(formatFrame(odd, FAKE, CAPS)).toEqual({ kind: 'frame', text: '@fr1 EVENT port=1 kind=42 (src=0102 seq=7 epoch=1 port=1)' });
  });

  it('shows system classes and other serial types by number', () => {
    const hello = encodeSerialLine(SERIAL_TYPE.ENV, packEnvelope({ header: header(CLS.PRESENCE, 1, 0), prefix: { type: 'none' }, body: new Uint8Array([0x10, 0x0d]) }));
    expect(formatFrame(hello, FAKE, CAPS).text).toBe('@fr1 PRESENCE kind=1 100d (src=0102 seq=7 epoch=1 port=0)');
    expect(formatFrame(encodeSerialLine(SERIAL_TYPE.LINK_PING, new Uint8Array([1, 2, 3, 4])), FAKE, CAPS)).toEqual({ kind: 'frame', text: '@fr1 LINK_PING 01020304' });
  });

  it('keeps an undecodable line verbatim as raw, with the error', () => {
    const badCrc = CLICK.slice(0, -1) + 'E';
    expect(formatFrame(badCrc, FAKE, CAPS)).toEqual({ kind: 'raw', text: `${badCrc} (decode error: line bad_crc)` });
    const badMagic = encodeSerialLine(SERIAL_TYPE.ENV, new Uint8Array(18).fill(0xa2));
    expect(formatFrame(badMagic, FAKE, CAPS)).toEqual({ kind: 'raw', text: `${badMagic} (decode error: envelope bad_magic)` });
    const truncated = encodeSerialLine(SERIAL_TYPE.ENV, packEnvelope({ header: header(CLS.EVENT, 3, 1), prefix: { type: 'time', t_us: 0 }, body: new Uint8Array([0x08]) }));
    expect(formatFrame(truncated, FAKE, CAPS)).toEqual({ kind: 'raw', text: `${truncated} (decode error: fr.button.click event truncated)` });
    const throwing: FrameCodec = { ...FAKE, decodeMember: () => { throw new Error('codec bug'); } };
    expect(formatFrame(CLICK, throwing, CAPS)).toEqual({ kind: 'raw', text: `${CLICK} (decode error: codec bug)` });
  });

  it('shows an empty body as no fields even when the member has no struct for it', () => {
    // fr.led.blink has no result fields; a codec may have no RESULT decoder for it at all.
    const noResult: FrameCodec = { ...FAKE, decodeMember: () => decodeFail('unsupported') };
    expect(formatFrame(BLINK_OK, noResult, CAPS).text).toBe('@fr1 RESULT status.blink {} (src=fffe seq=13 epoch=3 port=2 status=ok req_seq=4)');
  });
});

describe('log store frames and diag lines', () => {
  let dir: string;
  const dbs: Db[] = [];
  const stores: LogStore[] = [];
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'fr-frames-test-'));
  });
  afterAll(() => {
    for (const logs of stores) {
      logs.close(); // writes pending lines before the db closes under the flush timer
    }
    for (const db of dbs) {
      db.close();
    }
    rmSync(dir, { recursive: true, force: true });
  });

  function freshDb(): Db {
    const db = openDb(join(dir, `hub-${dbs.length}.db`));
    dbs.push(db);
    return db;
  }

  function store(db: Db, run: number, frames?: FrameDecoder): LogStore {
    const logs = new LogStore(db, run, { retention: false, frames });
    stores.push(logs);
    return logs;
  }

  /** An ingested artifact for FW with `caps` in its manifest. */
  function ingested(db: Db, caps: PortCap[] | undefined): void {
    const manifest: ArtifactManifest = {
      schema: 'fractonica.artifact/1',
      build_id: `node/c6-pad/debug/${FW.slice(0, 12)}`,
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
      fw_id: FW,
      elf_sha256: '00',
      size: 1,
      built_at: '2026-10-21T00:00:00.000Z',
      flash: { mode: 'dio', freq: '80m', size: '4MB', files: [] },
      partitions: [],
      ...(caps ? { caps: caps.map((c): ManifestCap => ({ ...c, version: '1.0', driver: 'gpio', config: {} })), catalog_hash: 0x1234abcd } : {}),
    };
    const file = join(dir, `manifest-${dbs.length}.json`);
    writeFileSync(file, JSON.stringify(manifest));
    db.prepare('INSERT INTO artifacts (build_id, source_dir, profile, build_type, fw_id, built_at, manifest_path) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      manifest.build_id, '/src', 'c6-pad', 'debug', FW, manifest.built_at, file,
    );
  }

  const banner = `I (312) fr: ready id=${DEV} fw=${FW.slice(0, 12)} state=unassigned addr=fffe alias= board=esp32c6-supermini`;

  it('names frames after the boot banner, through a hub restart', () => {
    const db = freshDb();
    ingested(db, CAPS);
    const logs = store(db, 1, new FrameDecoder(db, FAKE));
    expect(logs.append(DEV, '/dev/cu.usbmodem1', CLICK)).toMatchObject({ kind: 'frame', text: '@fr1 EVENT port=1 kind=3 0801 (src=fffe seq=12 epoch=3 port=1)' });
    expect(logs.append(DEV, '/dev/cu.usbmodem1', banner)).toMatchObject({ kind: 'esp_log', tag: 'fr' });
    expect(logs.append(DEV, '/dev/cu.usbmodem1', CLICK)).toMatchObject({ kind: 'frame', text: '@fr1 EVENT boot.click {"count":1} (src=fffe seq=12 epoch=3 port=1)' });
    // Another device on the same hub has not announced a firmware.
    expect(logs.append('aabbccddeeff', '/dev/cu.usbmodem2', CLICK).text).toContain('port=1 kind=3');

    logs.close(); // the hub stops
    const restarted = store(db, 2, new FrameDecoder(db, FAKE));
    expect(restarted.append(DEV, '/dev/cu.usbmodem1', CLICK).text).toContain('boot.click');
  });

  it('decodes without names when the firmware has no artifact or no caps', () => {
    const db = freshDb();
    ingested(db, undefined);
    const logs = store(db, 1, new FrameDecoder(db, FAKE));
    logs.append(DEV, 'p', banner);
    expect(logs.append(DEV, 'p', CLICK)).toMatchObject({ kind: 'frame', text: expect.stringContaining('port=1 kind=3 0801') });
    logs.append(DEV, 'p', 'I (300) fr: ready id=x fw=0000aaaa0000 state=unassigned');
    expect(logs.append(DEV, 'p', CLICK).text).toContain('port=1 kind=3');
  });

  it('stores raw `@fr1:` lines when the store has no decoder', () => {
    const logs = store(freshDb(), 1);
    expect(logs.append(DEV, 'p', CLICK)).toMatchObject({ kind: 'raw', text: CLICK });
  });

  it('classifies serial command channel responses as diag', () => {
    expect(parseLine('#12 {"ok":true}\r')).toMatchObject({ kind: 'diag', text: '#12 {"ok":true}' });
    expect(parseLine('#12345678 {"ok":false,"error":"unknown_command"}').kind).toBe('diag');
    expect(parseLine('#123456789 {"ok":true}').kind).toBe('raw');
    expect(parseLine('#12 ok').kind).toBe('raw');
    expect(parseLine('# {"ok":true}').kind).toBe('raw');
  });
});

// The real generated codecs (packages/protocol/src/gen), once the TS emitter has produced them.
describe.skipIf(typeof GENERATED_CODEC.findCap !== 'function')('formatFrame with the generated codecs', () => {
  it('decodes the vector lines', () => {
    expect(formatFrame(CLICK, GENERATED_CODEC, CAPS)).toEqual({ kind: 'frame', text: '@fr1 EVENT boot.click {"count":1} (src=fffe seq=12 epoch=3 port=1)' });
    expect(formatFrame(PRESSED, GENERATED_CODEC, CAPS)).toEqual({ kind: 'frame', text: '@fr1 STATE boot.pressed {"pressed":true} (src=fffe seq=5 epoch=3 port=1)' });
    expect(formatFrame(BLINK_OK, GENERATED_CODEC, CAPS)).toEqual({ kind: 'frame', text: '@fr1 RESULT status.blink {} (src=fffe seq=13 epoch=3 port=2 status=ok req_seq=4)' });
  });

  it('names the system endpoints from the protocol ports, with or without manifest caps', () => {
    // `fr diag <dev> mark step1` emits fr.diag.mark on port 241; fr_manifest.json never lists it.
    const mark = encodeSerialLine(SERIAL_TYPE.ENV, packEnvelope({ header: header(CLS.EVENT, 1, 241), prefix: { type: 'time', t_us: 0 }, body: encodeDiagMark({ token: 'step1' }) }));
    const text = '@fr1 EVENT diag.mark {"token":"step1"} (src=0102 seq=7 epoch=1 port=241)';
    expect(formatFrame(mark, GENERATED_CODEC, null)).toEqual({ kind: 'frame', text });
    expect(formatFrame(mark, GENERATED_CODEC, CAPS)).toEqual({ kind: 'frame', text });
    // A manifest cannot rename a system port.
    expect(formatFrame(mark, GENERATED_CODEC, [...CAPS, { name: 'boot', port: 241, cap: 'fr.button', cap_id: 1 }]).text).toBe(text);
    const boot = encodeSerialLine(SERIAL_TYPE.ENV, packEnvelope({ header: header(CLS.EVENT, 1, 0), prefix: { type: 'time', t_us: 0 }, body: encodeNodeBoot({ reset_reason: 3 }) }));
    expect(formatFrame(boot, GENERATED_CODEC, null).text).toBe('@fr1 EVENT node.boot {"reset_reason":3} (src=0102 seq=7 epoch=1 port=0)');
  });
});
