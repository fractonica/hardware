// Human rendering of `fr csi stream`, `fr csi status` and `fr net ls` (design csi-c1 D4, D13): a csi_stream job prints
// one summary line, csi_status two lines, network_list a table that never shows a password (only whether one is set).

import { describe, expect, it } from 'vitest';

import type { Job } from '@fractonica/protocol';

import { renderResult } from '../src/render.ts';

describe('fr csi output', () => {
  it('prints a csi_stream job as one summary line', () => {
    const job = {
      job_id: 'j_0123456789ab',
      kind: 'csi',
      status: 'completed',
      targets: ['a0b1c2d3e4f5'],
      created_at: '2026-11-02T00:00:00Z',
      result: { device: 'a0b1c2d3e4f5', alias: 'csi-c5', instance: 'csi', stream_id: 7, source: 'peer', peer_mac: 'b0c1d2e3f4a5', path: '/h/run.csi', live: true, seconds: 60.02, records: 5940, dropped: 12, rate_hz: 98.97, blocks: 600, reason: 'done' },
    } as Job;
    expect(renderResult('csi_stream', { ok: true, cursor: '', data: job }).out).toBe(
      'j_0123456789ab csi completed\ncsi-c5 csi stream 7 (peer from b0c1d2e3f4a5): 5940 records in 60.0 s (99.0/s), 12 dropped, 600 blocks, done; file /h/run.csi, live',
    );
  });

  it('prints csi_status with and without a stream', () => {
    const base = { device: 'a0b1c2d3e4f5', alias: 'csi-c5', instance: 'csi', motion: 812, rssi: -51, rate: 97, source: 'router' };
    expect(renderResult('csi_status', { ok: true, cursor: '', data: { ...base, stream: null } }).out).toBe('csi-c5 csi: motion 812, rssi -51 dBm, rate 97/s, source router\nno stream');
    const s = { stream_id: 9, source: 'router', started_at: 't', seconds: 0, records: 100, dropped: 1, blocks: 10, subscribers: 2, gaps: 3, job_id: 'j_1' };
    expect(renderResult('csi_status', { ok: true, cursor: '', data: { ...base, motion: null, stream: s } }).out.split('\n')[1]).toBe(
      'stream 9 (router, job j_1): 100 records, 1 dropped, 10 blocks, 2 subscribers, 3 gaps',
    );
  });

  it('prints network_list as a table, a password only as set or none', () => {
    const networks = [
      { name: 'default', ssid: 'lab-2g', bssid: null, country: 'LV', band: 'auto', net_id: 4242, hub_host: 'm.local', password_set: true, devices: 5 },
      { name: '5g', ssid: 'lab-5g', bssid: null, country: null, band: '5g', net_id: 4242, hub_host: 'm.local', password_set: false, devices: 0 },
    ];
    expect(renderResult('network_list', { ok: true, cursor: '', data: { networks } }).out.split('\n')).toEqual([
      'NAME     SSID    BAND  COUNTRY  PASSWORD  DEVICES  NET_ID',
      'default  lab-2g  auto  LV       set       5        4242',
      '5g       lab-5g  5g    -        none      0        4242',
    ]);
  });
});
