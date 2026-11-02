// The CSI-1 contract (design csi-c1 D1, D4, D5, D7, D9, D11-D13, §12): the C5's chip id, fr.csi and fr.radio_tx, the
// network names and bands on the network ops, csi_stream and csi_status, the generic stream hub events, and the
// REGISTRY_HASH it all moves once.

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  CSI_END_REASONS,
  CSI_SOURCES,
  CSI_STREAM_MAX_S,
  CsiStatusSchema,
  CsiStreamSchema,
  DEFAULT_NETWORK,
  findOp,
  HUB_EVENT_FIELDS,
  HUB_EVENT_TYPES,
  JOB_KINDS,
  NETWORK_BAND_IDENT,
  NETWORK_BANDS,
  NetworkSchema,
  OPS,
  REGISTRY_HASH,
  STREAM_KINDS,
} from '../src/index.ts';
import { CATALOG_HASH, ChipId, CSI_CAP, CSI_CONFIG_DEFAULTS, CsiStreamEndReason, RADIO_TX_CAP } from '@fractonica/protocol/gen';

const hashOf = (ops: readonly { name: string; input: z.ZodType }[]) =>
  createHash('sha256')
    .update(JSON.stringify(ops.map((o) => [o.name, z.toJSONSchema(o.input)])))
    .digest('hex')
    .slice(0, 12);

describe('CSI-1 ops (design csi-c1 D4, D5, D13)', () => {
  it('adds network_list, csi_stream and csi_status, and moves REGISTRY_HASH once for every op change', () => {
    expect(OPS).toHaveLength(55);
    expect(findOp('network_list')).toMatchObject({ kind: 'query', tier: 'read', cli: { path: ['net', 'ls'] } });
    expect(findOp('csi_stream')).toMatchObject({ kind: 'job', tier: 'mutate', cli: { path: ['csi', 'stream'], positional: ['device'] } });
    expect(findOp('csi_status')).toMatchObject({ kind: 'query', tier: 'read', cli: { path: ['csi', 'status'], positional: ['device'] } });
    for (const name of ['network_set', 'network_list', 'csi_stream', 'csi_status']) {
      expect(findOp(name)!.summary.length, name).toBeLessThan(1000);
      expect(hashOf(OPS.filter((o) => o.name !== name)), name).not.toBe(REGISTRY_HASH);
    }
    expect(hashOf(OPS)).toBe(REGISTRY_HASH);
    expect(REGISTRY_HASH).toBe('6dcd17ef8882');
    expect(REGISTRY_HASH).not.toBe('ee5dc36bb005'); // A2's
    expect(JOB_KINDS).toContain('csi');
  });

  it('names networks and bands: network_set defaults to the default network with band auto, and no op returns a password', () => {
    const set = findOp('network_set')!.input;
    expect(set.parse({ ssid: 'x' })).toEqual({ name: DEFAULT_NETWORK, ssid: 'x', band: 'auto' });
    expect(set.safeParse({ name: '5g', ssid: 'x', band: '5g', country: 'LV' }).success).toBe(true);
    for (const bad of [{ band: '6g' }, { name: '' }, { name: '5G' }, { name: 'a'.repeat(32) }, { name: 'has space' }]) {
      expect(set.safeParse({ ssid: 'x', ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
    expect(findOp('network_get')!.input.parse({})).toEqual({ name: DEFAULT_NETWORK });
    expect(findOp('device_provision')!.input.safeParse({ port: 'aabbccddeeff', network: '5g' }).success).toBe(true);
    expect(findOp('flash_start')!.input.safeParse({ device: 'csi-c5', plan: 'identity', network: '5g' }).success).toBe(true);
    expect(NETWORK_BANDS).toEqual(['auto', '2g', '5g']);
    // fr_ident fr_net `band` (06 §6.3): absent reads as 0, auto.
    expect(NETWORK_BAND_IDENT).toEqual({ auto: 0, '2g': 1, '5g': 2 });
    const net = { name: '5g', ssid: 'x', bssid: null, country: 'LV', band: '5g', net_id: 41235, hub_host: 'mac.local', password_set: true };
    expect(NetworkSchema.safeParse(net).success).toBe(true);
    expect(NetworkSchema.safeParse({ ...net, band: 'any' }).success).toBe(false);
    for (const name of ['network_set', 'network_get', 'network_list']) {
      expect(JSON.stringify(z.toJSONSchema(findOp(name)!.output!, { io: 'output' })), name).not.toContain('"password"');
    }
  });

  it('checks csi_stream: seconds 0..3600 (0 until cancelled), live by default, a source of fr.csi', () => {
    const csi = findOp('csi_stream')!.input;
    expect(csi.parse({ device: 'csi-c5', seconds: 0 })).toEqual({ device: 'csi-c5', seconds: 0, live: true });
    expect(csi.safeParse({ device: 'csi-c5', instance: 'csi', seconds: CSI_STREAM_MAX_S, out: '/fr/run.csi', live: false, source: 'peer', peer: 'pad-c6' }).success).toBe(true);
    for (const bad of [{ seconds: -1 }, { seconds: 3601 }, { seconds: 1.5 }, { source: 'mesh' }, { instance: '' }, { peer: '' }]) {
      expect(csi.safeParse({ device: 'csi-c5', seconds: 10, ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
    expect(csi.safeParse({ device: 'csi-c5' }).success).toBe(false);
    expect(CSI_STREAM_MAX_S).toBe(3600);
    expect(findOp('csi_status')!.input.safeParse({ device: 'csi-c5' }).success).toBe(true);
  });

  it('declares the result schemas', () => {
    const run = { device: 'd0cf13eb7ba0', alias: 'csi-c5', instance: 'csi', stream_id: 7, source: 'router', live: true, seconds: 60, records: 5940, dropped: 12, rate_hz: 99, blocks: 600, reason: 'done' };
    expect(CsiStreamSchema.safeParse(run).success).toBe(true);
    expect(CsiStreamSchema.safeParse({ ...run, path: '/fr/run.csi', peer_mac: 'aabbccddeeff', source: 'peer' }).success).toBe(true);
    expect(CsiStreamSchema.safeParse({ ...run, reason: 'underrun' }).success).toBe(false);
    const status = { device: 'd0cf13eb7ba0', alias: 'csi-c5', instance: 'csi', motion: 1200, rssi: -48, rate: 98, source: 'router', stream: null };
    expect(CsiStatusSchema.safeParse(status).success).toBe(true);
    expect(CsiStatusSchema.safeParse({ ...status, motion: null, rssi: null, rate: null, stream: { stream_id: 7, source: 'router', started_at: null, seconds: 0, records: 0, dropped: 0, blocks: 0, subscribers: 1, gaps: 0 } }).success).toBe(true);
    for (const s of [CsiStreamSchema, CsiStatusSchema, NetworkSchema]) {
      expect(() => z.toJSONSchema(s, { io: 'output' })).not.toThrow();
    }
    // The hub's own `timeout` aside, the op's reasons are the event's.
    expect(Object.keys(CsiStreamEndReason)).toEqual(CSI_END_REASONS.filter((r) => r !== 'timeout'));
    expect(CSI_SOURCES).toEqual(['router', 'peer', 'any']);
  });

  it('adds the hub events stream.started and stream.ended (not csi.*: an instance named csi owns that space)', () => {
    expect(HUB_EVENT_TYPES.slice(-2)).toEqual(['stream.started', 'stream.ended']);
    expect(STREAM_KINDS).toEqual(['csi']);
    const fields = (type: keyof typeof HUB_EVENT_FIELDS, f: unknown) => HUB_EVENT_FIELDS[type].safeParse(f).success;
    expect(fields('stream.started', { kind: 'csi', instance: 'csi', stream_id: 7, format: 'csi1', source: 'router', seconds: 0, live: true })).toBe(true);
    expect(fields('stream.ended', { kind: 'csi', instance: 'csi', stream_id: 7, reason: 'net_lost', records: 100, dropped: 3, blocks: 10, seconds: 1.2 })).toBe(true);
    expect(fields('stream.ended', { kind: 'audio', instance: 'csi', stream_id: 7, reason: 'done', records: 0, dropped: 0, blocks: 0, seconds: 0 })).toBe(false);
  });
});

describe('CSI-1 capabilities and chip (design csi-c1 D1, D7, D9)', () => {
  it('knows the ESP32-C5 by its image chip id', () => {
    expect(ChipId.esp32c5).toBe(23);
  });

  it('fr.csi 1.0 (0x0009): config, properties motion/rssi/rate, stream_ended, three reliable commands', () => {
    expect(CSI_CAP).toMatchObject({ id: 0x0009, name: 'fr.csi', version: { major: 1, minor: 0 } });
    expect(CSI_CONFIG_DEFAULTS).toEqual({ source: 'router', rate_hz: 100, peer_mac: [], format: 'auto', features_hz: 10 });
    expect(CSI_CAP.properties.map((p) => [p.id, p.name])).toEqual([[1, 'motion'], [2, 'rssi'], [3, 'rate']]);
    expect(CSI_CAP.events.map((e) => [e.id, e.name, e.priority, e.codec.fields.map((f) => f.name)])).toEqual([[1, 'stream_ended', 'normal', ['stream_id', 'reason', 'records', 'dropped']]]);
    expect(CSI_CAP.commands.map((c) => [c.id, c.name, c.delivery, c.args.fields.map((f) => f.name)])).toEqual([
      [1, 'stream_start', 'reliable', ['stream_id', 'seconds', 'source', 'peer_mac']],
      [2, 'stream_stop', 'reliable', ['stream_id']],
      [3, 'baseline_reset', 'reliable', []],
    ]);
  });

  it('fr.radio_tx 1.0 (0x000A): start {peer_mac, rate_hz, len, seconds}, stop, property sending', () => {
    expect(RADIO_TX_CAP).toMatchObject({ id: 0x000a, name: 'fr.radio_tx', version: { major: 1, minor: 0 } });
    expect(RADIO_TX_CAP.properties.map((p) => [p.id, p.name])).toEqual([[1, 'sending']]);
    expect(RADIO_TX_CAP.commands.map((c) => [c.id, c.name, c.args.fields.map((f) => f.name)])).toEqual([
      [1, 'start', ['peer_mac', 'rate_hz', 'len', 'seconds']],
      [2, 'stop', []],
    ]);
    expect(RADIO_TX_CAP.commands.find((c) => c.name === 'stop')).toMatchObject({ idempotent: true, result: null });
    expect(CATALOG_HASH).toBe(0xbdb52e7a);
  });
});
