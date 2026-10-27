// The live store (design c6 §5): the bounded event ring, the newest event per device, the property mirror
// from `part:'state'` events and snapshots, tile flashes (900 ms after a new capability EVENT, D-headless
// `data-flash`), prompt_human requests (D3) with hub_status reconciliation, job progress and the toast
// when a job ends (once), and pruning; events aged by hub time, prompts ended by the hub's wall clock (D30).

import { describe, expect, it } from 'vitest';

import type { Prompt } from '@fractonica/protocol/browser';

import type { Now } from '../src/state/clock.ts';
import { createLiveStore, FLASH_MAX_AGE_MS, FLASH_MS, HISTORY_MAX, isFlashing, JOBS_MAX, pendingPrompts, PROMPT_GRACE_MS, RING_MAX } from '../src/state/live.ts';
import { ev } from './fakes.ts';

const NOW = 1_700_000_000_000; // ms; ev() stamps t_hub_us at NOW plus seq µs
const PAD = 'aabbccddeeff';

/** Now at `hub` ms of hub time, the hub's wall clock `wall` (the same unless a test says). */
const T = (hub: number, wall = hub): Now => ({ hub, wall });

function prompt(id: string, expires: number, extra: Partial<Prompt> = {}): Prompt {
  return { prompt_id: id, text: 'Press BOOT on pad-c6', selector: 'pad-c6', types: ['boot.down'], expires_at: new Date(expires).toISOString(), ...extra };
}

describe('dashboard live store', () => {
  it('keeps the newest RING_MAX events, in order, without repeats, and the newest per device', () => {
    const s = createLiveStore();
    const batch = Array.from({ length: RING_MAX + 50 }, (_, i) => ev(i + 1, 'boot.down', { device: i % 2 ? 'dev-b' : PAD }));
    s.getState().ingest(batch.slice(0, 1000), {}, T(NOW));
    s.getState().ingest(batch.slice(900), {}, T(NOW)); // 900..999 again
    const { events, maxSeq, lastByDevice } = s.getState();
    expect(events).toHaveLength(RING_MAX);
    expect(events[0]!.seq).toBe(51);
    expect(events.at(-1)!.seq).toBe(RING_MAX + 50);
    expect(new Set(events.map((e) => e.seq)).size).toBe(RING_MAX);
    expect(maxSeq).toBe(RING_MAX + 50);
    expect(lastByDevice[PAD]!.seq).toBe(RING_MAX + 49);
    expect(lastByDevice['dev-b']!.seq).toBe(RING_MAX + 50);
  });

  it('flashes a device for 900 ms after a new capability event, not after states, snapshots, old or re-read ones', () => {
    const s = createLiveStore();
    const at = NOW * 1000;
    s.getState().ingest([ev(1, 'status.on', { part: 'state', member: 'on', fields: { on: true }, t_hub_us: at })], {}, T(NOW));
    expect(isFlashing(s.getState(), PAD, T(NOW))).toBe(false);
    s.getState().ingest([ev(2, 'boot.down', { part: 'event', member: 'down', t_hub_us: at - 5_000_000 })], {}, T(NOW)); // 5 s old
    expect(isFlashing(s.getState(), PAD, T(NOW))).toBe(false);
    s.getState().ingest([ev(3, 'boot.down', { part: 'event', member: 'down', t_hub_us: at })], { backfill: true }, T(NOW));
    expect(isFlashing(s.getState(), PAD, T(NOW))).toBe(false);
    s.getState().ingest([ev(4, 'device.online', { t_hub_us: at })], {}, T(NOW));
    expect(isFlashing(s.getState(), PAD, T(NOW))).toBe(false);
    s.getState().ingest([ev(5, 'boot.down', { part: 'event', member: 'down', t_hub_us: at - 300_000 })], {}, T(NOW));
    expect(isFlashing(s.getState(), PAD, T(NOW))).toBe(true);
    expect(isFlashing(s.getState(), PAD, T(NOW + FLASH_MS - 1))).toBe(true);
    expect(isFlashing(s.getState(), PAD, T(NOW + FLASH_MS))).toBe(false);
    expect(isFlashing(s.getState(), 'dev-b', T(NOW))).toBe(false);
    s.getState().prune(T(NOW + FLASH_MS));
    expect(s.getState().flashUntil).toEqual({});
  });

  it('ages events by hub time and ends prompts by the hub wall clock, when the two disagree (D30 drift)', () => {
    // Hub µs 12 s ahead of the wall clock, or behind it (a week of hub uptime at 20 ppm). An event 300 ms
    // old by hub time flashes its tile and its job end toasts, though the wall clock calls it 12.3 s old or
    // 11.7 s in the future; a prompt's expires_at is a wall-clock time, so it ends then either way.
    for (const skew of [12_000, -12_000]) {
      const s = createLiveStore();
      const now = T(NOW + skew, NOW);
      const tUs = (NOW + skew - 300) * 1000;
      s.getState().ingest([ev(1, 'boot.down', { part: 'event', member: 'down', t_hub_us: tUs })], {}, now);
      s.getState().ingest([ev(2, 'job.state', { device: undefined, t_hub_us: tUs, fields: { job_id: 'j_x', kind: 'build', status: 'completed' } })], {}, now);
      expect(isFlashing(s.getState(), PAD, now)).toBe(true);
      expect(s.getState().toasts.map((t) => t.job_id)).toEqual(['j_x']);
      // The flash and the toast run on hub time.
      expect(isFlashing(s.getState(), PAD, T(NOW + skew + FLASH_MS - 1, NOW))).toBe(true);
      expect(isFlashing(s.getState(), PAD, T(NOW + skew + FLASH_MS, NOW))).toBe(false);
      s.getState().prune(T(NOW + skew + 6000, NOW));
      expect(s.getState().toasts).toEqual([]);
      // An event FLASH_MAX_AGE_MS + 1 old by hub time does not flash, though the wall clock calls it new.
      const other = createLiveStore();
      other.getState().ingest([ev(3, 'boot.down', { part: 'event', member: 'down', t_hub_us: (NOW + skew - FLASH_MAX_AGE_MS - 1) * 1000 })], {}, now);
      expect(isFlashing(other.getState(), PAD, now)).toBe(false);

      s.getState().ingest([ev(4, 'hub.prompt', { device: undefined, fields: prompt('p_0000000d', NOW + 5000) })], {}, now);
      expect(pendingPrompts(s.getState(), T(NOW + skew + 4999, NOW + 4999)).map((p) => p.prompt_id)).toEqual(['p_0000000d']);
      s.getState().prune(T(NOW + skew + 4999, NOW + 4999));
      expect(Object.keys(s.getState().prompts)).toEqual(['p_0000000d']);
      expect(pendingPrompts(s.getState(), T(NOW + skew + 5000, NOW + 5000))).toEqual([]);
      s.getState().prune(T(NOW + skew + 5000, NOW + 5000));
      expect(s.getState().prompts).toEqual({});
    }
  });

  it('mirrors properties from state events and snapshots; a snapshot is not an event', () => {
    const s = createLiveStore();
    s.getState().ingest([ev(7, 'status.on', { part: 'state', member: 'on', fields: { on: false } })], { snapshot: true }, T(NOW));
    expect(s.getState().events).toEqual([]);
    expect(s.getState().properties[PAD]!['status.on']!.value).toBe(false);
    s.getState().ingest([ev(8, 'status.on', { part: 'state', member: 'on', fields: { on: true } }), ev(9, 'status.brightness', { part: 'state', member: 'brightness', fields: { brightness: 40 } })], {}, T(NOW));
    expect(s.getState().properties[PAD]).toMatchObject({ 'status.on': { value: true }, 'status.brightness': { value: 40 } });
    // STATE stays out of the ring (design m2-c3-inputs D6); it still moves maxSeq, so a re-read is no repeat.
    expect(s.getState().events).toEqual([]);
    expect(s.getState().maxSeq).toBe(9);
    expect(s.getState().lastByDevice[PAD]!.seq).toBe(9);
  });

  it('keeps a streaming STATE out of the event ring, with the last HISTORY_MAX values of each property', () => {
    const s = createLiveStore();
    s.getState().ingest([ev(1, 'boot.down', { part: 'event', member: 'down' })], {}, T(NOW));
    const value = (seq: number) => ev(seq, 'analog.value', { part: 'state', member: 'value', fields: { value: seq * 10 } });
    // 20 Hz for a while, in batches as /ws delivers them, and one value twice (a re-read).
    for (let b = 0; b < 30; b++) {
      s.getState().ingest(Array.from({ length: 10 }, (_, i) => value(2 + b * 10 + i)), {}, T(NOW));
    }
    s.getState().ingest([value(301)], {}, T(NOW));
    const st = s.getState();
    expect(st.events.map((e) => e.type)).toEqual(['boot.down']);
    expect(st.properties[PAD]!['analog.value']!.value).toBe(3010);
    const h = st.history[PAD]!['analog.value']!;
    expect(h).toHaveLength(HISTORY_MAX);
    expect(h.at(-1)).toEqual({ t_hub_us: expect.any(Number), value: 3010 });
    expect(h[0]!.value).toBe((301 - HISTORY_MAX + 1) * 10);
    expect(new Set(h.map((p) => p.t_hub_us)).size).toBe(HISTORY_MAX);
    // Earlier states' arrays are left as they were (the store's updates are pure).
    const before = st.history[PAD]!['analog.value']!;
    s.getState().ingest([value(302)], {}, T(NOW));
    expect(before.at(-1)!.value).toBe(3010);
    expect(s.getState().history[PAD]!['analog.value']!.at(-1)!.value).toBe(3020);
    // A snapshot of the same value adds no point; another property has its own history.
    s.getState().ingest([value(302)], { snapshot: true }, T(NOW));
    s.getState().ingest([ev(303, 'status.on', { part: 'state', member: 'on', fields: { on: true } })], {}, T(NOW));
    expect(s.getState().history[PAD]!['analog.value']).toHaveLength(HISTORY_MAX);
    expect(s.getState().history[PAD]!['status.on']).toEqual([{ t_hub_us: expect.any(Number), value: true }]);
  });

  it('tracks prompt_human requests from hub.prompt / hub.prompt_done and hub_status', () => {
    const s = createLiveStore();
    const p1 = prompt('p_0000000a', NOW + 30_000);
    const p2 = prompt('p_0000000b', NOW + 10_000, { text: 'Press BOOT on pad-c3' });
    s.getState().ingest([ev(1, 'hub.prompt', { device: undefined, fields: p1 }), ev(2, 'hub.prompt', { device: undefined, fields: p2 })], {}, T(NOW));
    expect(pendingPrompts(s.getState(), T(NOW)).map((p) => p.prompt_id)).toEqual(['p_0000000b', 'p_0000000a']);
    s.getState().ingest([ev(3, 'hub.prompt_done', { device: undefined, fields: { prompt_id: 'p_0000000b', outcome: 'matched' } })], {}, T(NOW));
    expect(pendingPrompts(s.getState(), T(NOW)).map((p) => p.prompt_id)).toEqual(['p_0000000a']);
    expect(pendingPrompts(s.getState(), T(NOW + 30_000))).toEqual([]);
    // A hub_status answer made before those events does not undo them for PROMPT_GRACE_MS ...
    s.getState().reconcilePrompts([p2], T(NOW + 1000));
    expect(Object.keys(s.getState().prompts)).toEqual(['p_0000000a']);
    // ... after that, hub_status is the hub's own list.
    s.getState().reconcilePrompts([p2], T(NOW + PROMPT_GRACE_MS));
    expect(Object.keys(s.getState().prompts)).toEqual(['p_0000000b']);
    expect(s.getState().promptSeen).toEqual({});
    s.getState().prune(T(NOW + 10_000));
    expect(s.getState().prompts).toEqual({});
    // A row without the fields the toast shows is not a prompt.
    s.getState().reconcilePrompts([{ ...p1, types: undefined } as unknown as Prompt], T(NOW + 20_000));
    expect(s.getState().prompts).toEqual({});
  });

  it('toasts a job end once, from a job.state event or a job frame, and not for an old or re-read one', () => {
    const s = createLiveStore();
    const at = NOW * 1000;
    const state = (seq: number, job: string, status: string, tUs = at) =>
      ev(seq, 'job.state', { device: undefined, t_hub_us: tUs, fields: { job_id: job, kind: 'build', status, targets: ['c6-pad'] } });
    s.getState().ingest([state(1, 'j_a', 'working')], {}, T(NOW));
    expect(s.getState().jobs.j_a).toMatchObject({ status: 'working', kind: 'build', targets: ['c6-pad'] });
    expect(s.getState().toasts).toEqual([]);
    s.getState().ingest([state(2, 'j_a', 'completed')], {}, T(NOW));
    s.getState().job({ t: 'job', job_id: 'j_a', kind: 'build', status: 'completed' }, T(NOW));
    expect(s.getState().toasts.map((t) => [t.tone, t.title, t.job_id])).toEqual([['ok', 'build c6-pad: completed', 'j_a']]);
    s.getState().ingest([state(3, 'j_old', 'failed', at - 60_000_000)], {}, T(NOW));
    s.getState().ingest([state(4, 'j_bf', 'failed')], { backfill: true }, T(NOW));
    expect(s.getState().toasts).toHaveLength(1);
    // A job frame alone carries progress and ends too.
    s.getState().job({ t: 'job', job_id: 'j_b', kind: 'provision', status: 'working', stage: 'flash', progress: { pct: 30 } }, T(NOW));
    expect(s.getState().jobs.j_b).toMatchObject({ stage: 'flash', progress: { pct: 30 } });
    s.getState().job({ t: 'job', job_id: 'j_b', kind: 'provision', status: 'failed' }, T(NOW));
    expect(s.getState().jobs.j_b).toMatchObject({ status: 'failed', stage: 'flash' });
    expect(s.getState().toasts.map((t) => t.tone)).toEqual(['ok', 'bad']);
    // Toasts end on their own, or when dismissed.
    s.getState().dismiss(s.getState().toasts[1]!.id);
    expect(s.getState().toasts).toHaveLength(1);
    s.getState().prune(T(NOW + 6000));
    expect(s.getState().toasts).toEqual([]);
  });

  it('keeps the JOBS_MAX most recently updated jobs', () => {
    const s = createLiveStore();
    for (let i = 0; i < JOBS_MAX + 5; i++) {
      s.getState().job({ t: 'job', job_id: `j_${i}`, kind: 'msg', status: i < 3 ? 'completed' : 'working' }, T(NOW + i));
    }
    s.getState().prune(T(NOW + 1000));
    const ids = Object.keys(s.getState().jobs);
    expect(ids).toHaveLength(JOBS_MAX);
    expect(ids).not.toContain('j_0');
    expect(ids).toContain(`j_${JOBS_MAX + 4}`);
    expect(s.getState().toasted).toEqual({});
  });

  it('forgets prompts, jobs, flashes and the seq high-water mark when the hub restarts', () => {
    const s = createLiveStore();
    s.getState().ingest([ev(1, 'hub.prompt', { fields: prompt('p_0000000c', NOW + 30_000) }), ev(2, 'boot.down', { part: 'event', t_hub_us: NOW * 1000 })], {}, T(NOW));
    s.getState().job({ t: 'job', job_id: 'j_c', kind: 'build', status: 'working' }, T(NOW));
    s.getState().hubRestarted();
    expect(s.getState()).toMatchObject({ prompts: {}, jobs: {}, flashUntil: {} });
    expect(s.getState().events).toHaveLength(2);
    // A hub on a fresh database counts seq from the start again: its events still arrive.
    s.getState().ingest([ev(1, 'device.online')], {}, T(NOW));
    expect(s.getState().events.map((e) => e.seq)).toEqual([1, 2, 1]);
  });
});
