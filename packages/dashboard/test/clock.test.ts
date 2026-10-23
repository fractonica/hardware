// Hub time in the dashboard (design c6 D30, §5 age rules): HubClock's offset from the `/ws` hello and
// pongs (the sample with the smallest round trip wins; a step or a new hub run starts over), the
// LiveClient's samples (the hello between the connect and its receipt, a pong between its ping and its
// receipt, none from a hub that sends no t_hub_us), and the live store wired to them as runtime.ts wires
// it: a hub whose µs run 12 s off the browser's clock still flashes tiles and toasts job ends.

import { describe, expect, it } from 'vitest';

import { LiveClient } from '../src/api/ws.ts';
import { CLOCK_SAMPLES, CLOCK_STEP_MS, HubClock } from '../src/state/clock.ts';
import { agoIso, agoUs, leftMs } from '../src/state/format.ts';
import { createLiveStore, isFlashing } from '../src/state/live.ts';
import { ev, FakeWs, ManualTimers } from './fakes.ts';

const WALL = 1_700_000_000_000;

/** A browser whose monotonic and wall clocks both read `t` ms (set by hand). */
function browser() {
  const b = { t: WALL };
  const clock = new HubClock({ mono: () => b.t, wall: () => b.t });
  return { b, clock };
}

/** A sample the hub read at `hubMs` (its clock), sent and received at these browser times. */
const at = (hubMs: number, sent: number, received: number, run = 1) => ({ t_hub_us: hubMs * 1000, sent, received, run });

describe('HubClock', () => {
  it('is the wall clock until a sample comes, then hub time at the midpoint of the round trip', () => {
    const { b, clock } = browser();
    expect(clock.estimate).toBeNull();
    expect(clock.now()).toEqual({ hub: WALL, wall: WALL });
    // The hub's µs are 5 s ahead: it read 5 s + 10 ms at the middle of a 20 ms round trip.
    clock.sample(at(WALL + 5010, WALL, WALL + 20));
    expect(clock.estimate).toEqual({ offset_ms: 5000, rtt_ms: 20, samples: 1 });
    b.t = WALL + 60_000;
    expect(clock.now()).toEqual({ hub: WALL + 65_000, wall: WALL + 60_000 });
    expect(clock.hubNow()).toBe(WALL + 65_000);
  });

  it('keeps the sample with the smallest round trip (the newest of equals), of the last CLOCK_SAMPLES', () => {
    const { clock } = browser();
    // The true offset is +5000 ms; each reply sat in a queue for most of its round trip, so the midpoint
    // is off by up to half of it.
    clock.sample(at(WALL + 5000 + 2, WALL, WALL + 200)); // midpoint +100: offset 4902
    clock.sample(at(WALL + 1000 + 5000 + 1, WALL + 1000, WALL + 1004)); // offset 4999, rtt 4
    clock.sample(at(WALL + 2000 + 5000 + 50, WALL + 2000, WALL + 2060)); // offset 5020, rtt 60
    expect(clock.estimate).toMatchObject({ offset_ms: 4999, rtt_ms: 4, samples: 3 });
    clock.sample(at(WALL + 3000 + 5000 + 3, WALL + 3000, WALL + 3004)); // rtt 4 again: newer wins
    expect(clock.estimate).toMatchObject({ offset_ms: 5001, rtt_ms: 4 });
    // CLOCK_SAMPLES later the tight ones have gone: the best of what is left.
    for (let i = 0; i < CLOCK_SAMPLES; i++) {
      const t = WALL + 10_000 + i * 20_000;
      clock.sample(at(t + 5000 + 10 + (i === 7 ? 0 : 5), t, t + (i === 7 ? 6 : 30)));
    }
    expect(clock.estimate).toMatchObject({ offset_ms: 5007, rtt_ms: 6, samples: CLOCK_SAMPLES });
  });

  it('starts over when a sample cannot agree with the best one (a clock stepped), or the hub run changed', () => {
    const { clock } = browser();
    clock.sample(at(WALL + 5000 + 1, WALL, WALL + 2)); // offset 5000 ± 1
    // Within both bounds plus CLOCK_STEP_MS: kept, the tighter one stays.
    clock.sample(at(WALL + 100 + 5000 + 50 + CLOCK_STEP_MS, WALL + 100, WALL + 200)); // offset 5000 + CLOCK_STEP_MS, ± 50
    expect(clock.estimate).toMatchObject({ offset_ms: 5000, samples: 2 });
    // Past them (the Mac slept, the wall clock moved): only the new sample counts, though its round trip is longer.
    clock.sample(at(WALL + 300 + 9000 + 10, WALL + 300, WALL + 320));
    expect(clock.estimate).toEqual({ offset_ms: 9000, rtt_ms: 20, samples: 1 });
    // A new hub run starts its µs from the wall clock again.
    clock.sample(at(WALL + 400 + 9000 + 20, WALL + 400, WALL + 440, 2));
    expect(clock.estimate).toEqual({ offset_ms: 9000, rtt_ms: 40, samples: 1 });
    clock.sample(at(WALL + 500 + 12, WALL + 500, WALL + 524, 3)); // run 3: alone again, at its own offset
    expect(clock.estimate).toEqual({ offset_ms: 0, rtt_ms: 24, samples: 1 });
  });

  it('ignores a sample with no usable round trip or hub time', () => {
    const { clock } = browser();
    clock.sample(at(WALL, WALL + 10, WALL)); // received before sent
    clock.sample({ t_hub_us: Number.NaN, sent: WALL, received: WALL + 1, run: 1 });
    expect(clock.estimate).toBeNull();
  });

  it("labels ISO times by the hub's wall clock and event times by hub time", () => {
    const now = { hub: WALL + 12_000, wall: WALL };
    expect(agoIso(new Date(WALL - 3000).toISOString(), now)).toBe('3 s ago');
    expect(agoUs((WALL + 12_000 - 3000) * 1000, now)).toBe('3 s ago');
    expect(agoUs(WALL * 1000, now)).toBe('12 s ago');
    expect(leftMs(new Date(WALL + 4500).toISOString(), now)).toBe(4500);
    expect(leftMs(new Date(WALL - 1).toISOString(), now)).toBe(0);
  });
});

describe('LiveClient hub-time samples', () => {
  function rig() {
    const timers = new ManualTimers();
    // The browser's clocks follow the manual timers.
    const now = () => WALL + timers.now;
    const clock = new HubClock({ mono: now, wall: now });
    const sockets: FakeWs[] = [];
    const client = new LiveClient({
      url: 'ws://127.0.0.1:7420/ws',
      connect: (url) => {
        const s = new FakeWs(url);
        sockets.push(s);
        return s;
      },
      readEvents: async () => ({ events: [], next_cursor: 'c:1.0', truncated: false }),
      timers,
      clock,
    });
    return { now, clock, client, tick: (ms: number) => timers.advance(ms), ws: () => sockets.at(-1)! };
  }

  /** A hub whose µs are `skew` ms off the browser's clock, at browser time `t`. */
  const hubUs = (t: number, skew: number) => (t + skew) * 1000;
  const hello = (run: number, tHubUs?: number) => ({ t: 'hello', v: 1, run, head: `c:${run}.0`, version: '0.1.0', registry_hash: 'abc123', ...(tHubUs !== undefined ? { t_hub_us: tHubUs } : {}) });

  it('takes the hello between the connect and its receipt, and each pong between its ping and its receipt', () => {
    const r = rig();
    r.client.start(); // connect at WALL
    r.tick(30);
    r.ws().open();
    r.tick(10);
    // The hub read its clock (12 s ahead) at WALL + 20; the hello arrives at WALL + 40.
    r.ws().frame(hello(1, hubUs(WALL + 20, 12_000)));
    expect(r.clock.estimate).toEqual({ offset_ms: 12_000, rtt_ms: 40, samples: 1 });
    // The ping goes 20 s after the hello; the pong comes 2 ms later, read by the hub 1 ms after the ping.
    r.tick(20_000);
    const sent = r.now();
    r.tick(2);
    r.ws().frame({ t: 'pong', n: 1, t_hub_us: hubUs(sent + 1, 12_003) });
    expect(r.clock.estimate).toEqual({ offset_ms: 12_003, rtt_ms: 2, samples: 2 });
    expect(r.clock.hubNow()).toBe(r.now() + 12_003);
  });

  it('takes nothing from a hub that sends no t_hub_us, nor from a pong that answers no current ping', () => {
    const r = rig();
    r.client.start();
    r.ws().open();
    r.ws().frame(hello(1));
    r.ws().frame({ t: 'pong', n: 0, t_hub_us: hubUs(r.now(), 5000) }); // no ping was sent
    expect(r.clock.estimate).toBeNull();
    r.tick(20_000);
    r.ws().frame({ t: 'pong', n: 1 });
    expect(r.clock.estimate).toBeNull();
    expect(r.client.state.badFrames).toBe(0);
    expect(r.clock.now()).toEqual({ hub: r.now(), wall: r.now() });
  });

  it('ages events by the hub time it read: a hub 12 s off the browser still flashes tiles and toasts job ends', () => {
    for (const skew of [12_000, -12_000]) {
      const r = rig();
      const store = createLiveStore();
      // runtime.ts's wiring, minus the batching: the store gets hubClock.now().
      r.client.listen({ events: (batch, info) => store.getState().ingest(batch, info, r.clock.now()) });
      r.client.subscribe('app', { events: {}, jobs: true });
      r.client.start();
      r.tick(2);
      r.ws().open();
      r.ws().frame(hello(1, hubUs(r.now() - 1, skew)));
      r.tick(500);
      // Pressed 300 ms ago by hub time; by the browser's clock 12.3 s ago (or 11.7 s ahead).
      const t = hubUs(r.now() - 300, skew);
      r.ws().frame({ t: 'ev', e: ev(5, 'boot.down', { part: 'event', member: 'down', t_hub_us: t }) });
      r.ws().frame({ t: 'ev', e: ev(6, 'job.state', { device: undefined, t_hub_us: t, fields: { job_id: 'j_1', kind: 'build', status: 'completed' } }) });
      expect(isFlashing(store.getState(), 'aabbccddeeff', r.clock.now())).toBe(true);
      expect(store.getState().toasts.map((x) => x.job_id)).toEqual(['j_1']);
    }
  });
});
