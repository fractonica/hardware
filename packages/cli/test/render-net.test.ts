// Human rendering of the node <-> node ops (design c5 §4; stream H1): message_send (one send, unicast
// results, the repeat job), binding_set|list|clear and latency_stats print lines and aligned tables
// instead of the YAML dump.

import { describe, expect, it } from 'vitest';

import { renderResult } from '../src/render.ts';

const ok = (data: unknown) => ({ ok: true, cursor: 'c:1.1', data });

const binding = {
  slot: 0,
  on_port: 1,
  on_cls: 3,
  on_kind: 1,
  on_topic: '',
  to_mac: '112233445566',
  to_addr: 0x34,
  to_port: 2,
  to_cls: 4,
  to_kind: 3,
  to_topic: '',
  payload: '08c80110c8011801',
  reliable: true,
};

describe('message_send rendering', () => {
  it('prints one broadcast, unicast results and the repeat job', () => {
    expect(renderResult('message_send', ok({ to: 'broadcast', topic: 'scene', bytes: 2, seq: 7, sessions: 3, seeded: true })).out).toBe(
      'broadcast scene seq 7 to 3 node(s); nodes flood it over ESP-NOW',
    );
    expect(renderResult('message_send', ok({ to: 'broadcast', topic: 'scene', seq: 8, sessions: 3, seeded: false })).out).toMatch(/TCP only \(over the flood rate\)$/);
    const uni = renderResult(
      'message_send',
      ok({
        to: 'tag:poc',
        topic: 'scene',
        results: [
          { device: 'a0', alias: 'pad-c6', status: 'ok', rtt_ms: 3, link: 'tcp' },
          { device: 'b0', alias: 'pad-c3', status: 'offline', error: 'pad-c3 is offline' },
        ],
      }),
    );
    expect(uni.out.split('\n')).toEqual(['msg scene', 'DEVICE  STATUS   RTT   LINK', 'pad-c6  ok       3 ms  tcp', 'pad-c3  offline  -     -', 'pad-c3: pad-c3 is offline']);
    const job = renderResult(
      'message_send',
      ok({
        job_id: 'j_m1',
        kind: 'msg',
        status: 'completed',
        progress: { pct: 100 },
        targets: ['broadcast'],
        created_at: '2026-10-22T00:00:00Z',
        result: { to: 'broadcast', topic: 'flood', count: 1000, sent: 1000, seeded: 998, tcp_only: 2, no_session: 0, first_seq: 5, last_seq: 1004, sessions_max: 3, duration_ms: 100_200 },
      }),
    );
    expect(job.out.split('\n')).toEqual(['j_m1 msg completed 100%', 'broadcast flood: 1000/1000 sent seq 5..1004, 998 flooded, 2 TCP-only (over the flood rate) in 100.2s']);
  });
});

describe('bindings rendering', () => {
  it('prints binding_set as one line', () => {
    const row = { device: 'a0', alias: 'pad-c6', slot: 0, from: 'pad-c6.boot.down', to: 'pad-c3.status.blink', args: { count: 1 }, pushed: true, replaced: false, binding };
    expect(renderResult('binding_set', ok(row)).out).toBe('pad-c6 slot 0: pad-c6.boot.down -> pad-c3.status.blink {"count":1}  pushed');
    expect(renderResult('binding_set', ok({ ...row, pushed: false, pending: 'pad-c6 is offline: pushed at its next handshake' })).out).toMatch(/pending: pad-c6 is offline/);
  });

  it('prints binding_list as a table, --live per node, and binding_clear as one line', () => {
    expect(renderResult('binding_list', ok({ bindings: [], count: 0, truncated: false })).out).toMatch(/^no bindings; try: fr bind/);
    const table = renderResult(
      'binding_list',
      ok({
        bindings: [{ device: 'a0', alias: 'pad-c6', slot: 0, from: 'pad-c6.boot.down', to: 'pad-c3.status.blink', args: { count: 1 }, pushed: true, binding }],
        count: 1,
        truncated: false,
      }),
    );
    expect(table.out.split('\n')).toEqual(['DEVICE  SLOT  FROM              TO                   ARGS         PUSHED', 'pad-c6  0     pad-c6.boot.down  pad-c3.status.blink  {"count":1}  yes']);
    const live = renderResult(
      'binding_list',
      ok({
        devices: [
          { device: 'a0', alias: 'pad-c6', presence: 'online', bindings: [{ slot: 0, binding, registry: 'same' }], missing: [3] },
          { device: 'b0', alias: 'pad-c3', presence: 'offline', error: 'pad-c3 is offline', registry_slots: [] },
        ],
      }),
    );
    const lines = live.out.split('\n');
    expect(lines[0].split(/\s{2,}/)).toEqual(['DEVICE', 'SLOT', 'ON', 'TO', 'PAYLOAD', 'REGISTRY']);
    expect(lines[1].split(/\s{2,}/)).toEqual(['pad-c6', '0', 'event port 1 id 1', '0x0034 (112233445566) cmd port 2 id 3', '08c80110c8011801', 'same']);
    expect(lines.slice(2)).toEqual(['pad-c6: registry slots not on the node: 3 (pushed at its next handshake)', 'pad-c3: pad-c3 is offline']);
    expect(renderResult('binding_clear', ok({ device: 'a0', alias: 'pad-c6', slot: 'all', cleared: [0, 2], pushed: true })).out).toBe('pad-c6 slot all: cleared slots 0, 2; the node cleared it');
    expect(renderResult('binding_clear', ok({ device: 'a0', alias: 'pad-c6', slot: 1, cleared: [], pushed: false, pending: 'pad-c6 is offline: pushed at its next handshake' })).out).toBe(
      'pad-c6 slot 1: no registry rows there; the node: pad-c6 is offline: pushed at its next handshake',
    );
  });
});

describe('latency_stats rendering', () => {
  it('prints the event loop and one row per device and metric with samples', () => {
    const none = { n: 0, p50_ms: null, p99_ms: null, max_ms: null };
    const out = renderResult(
      'latency_stats',
      ok({
        window_s: 60,
        event_loop: { seconds: 60, p50_ms: 0.01, p99_ms: 0.52, max_ms: 1.3 },
        devices: [
          {
            device: 'a0',
            alias: 'pad-c6',
            presence: 'online',
            ping: { tcp: { n: 8, p50_ms: 0.41, p99_ms: 0.9, max_ms: 1.1 } },
            input: { n: 3, p50_ms: 3.1, p99_ms: 9.8, max_ms: 9.8 },
            bindings: { espnow: { n: 5, p50_ms: 4.2, p99_ms: 8, max_ms: 8, fast: 2, failed: 0 }, hub: { ...none, fast: 0, failed: 0 }, flood: { ...none, fast: 0, failed: 0 } },
          },
          { device: 'b0', alias: 'pad-c3', presence: 'offline', ping: {}, input: none, bindings: {} },
        ],
        count: 2,
        truncated: false,
      }),
    ).out;
    expect(out.split('\n')).toEqual([
      'hub event-loop delay over 60 s: p50 0.01 ms, p99 0.52 ms, max 1.3 ms',
      'DEVICE  METRIC          N  P50      P99     MAX',
      'pad-c6  ping tcp        8  0.41 ms  0.9 ms  1.1 ms',
      'pad-c6  input -> hub    3  3.1 ms   9.8 ms  9.8 ms',
      'pad-c6  binding espnow  5  4.2 ms   8 ms    8 ms    fast 2',
      'no samples in the last 60 s: pad-c3',
    ]);
  });
});
