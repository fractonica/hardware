// The reorder buffer of ordered ports (design m2-c3-inputs D8, D9): the buffer alone on a manual clock and
// timers (in order, a gap filled, a gap timed out and its straggler, the 8 cap, a reset, the u16 wrap), then the
// router with a FakeNode that stamps EXT port_seq (order, ACK at arrival, late stragglers, a retry DUP, a HELLO
// reset, events without port_seq untouched, hub_status router.reorder).

import { afterEach, describe, expect, it } from 'vitest';

import { CLS, EXT, extValue } from '@fractonica/protocol';
import { decodeEnvelope, encodeButtonClick, findCap } from '@fractonica/protocol/gen';

import type { HubEvent } from '../src/context.ts';
import { REORDER_HOLD_MS, ReorderBuffer, type ReorderTimers } from '../src/router/reorder.ts';
import { type FakeNode, rig, type Rig, until } from './fake-node.ts';

/** setTimeout on a clock the test moves. */
class ManualTimers implements ReorderTimers {
  ms = 0;
  #tasks: { at: number; fn: () => void; id: number }[] = [];
  #id = 0;
  set(fn: () => void, ms: number): unknown {
    const id = ++this.#id;
    this.#tasks.push({ at: this.ms + ms, fn, id });
    return id;
  }
  clear(h: unknown): void {
    this.#tasks = this.#tasks.filter((t) => t.id !== h);
  }
  get pending(): number {
    return this.#tasks.length;
  }
  advance(ms: number): void {
    const end = this.ms + ms;
    for (;;) {
      const due = this.#tasks.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) {
        break;
      }
      this.#tasks = this.#tasks.filter((t) => t !== due);
      this.ms = Math.max(this.ms, due.at);
      due.fn();
    }
    this.ms = end;
  }
}

function buffer() {
  const timers = new ManualTimers();
  const out: number[] = [];
  const b = new ReorderBuffer<number>((n) => out.push(n), { nowUs: () => timers.ms * 1000, timers });
  return { b, out, timers, push: (seq: number, port = 1, dev = 'd') => b.push(dev, port, seq, seq) };
}

describe('ReorderBuffer', () => {
  it('passes events in port_seq order straight through, holding nothing', () => {
    const { b, out, timers, push } = buffer();
    for (const s of [1, 2, 3, 4]) {
      push(s);
    }
    expect(out).toEqual([1, 2, 3, 4]);
    expect(b.counters).toEqual({ held: 0, released_in_order: 0, released_timeout: 0, overflows: 0, hold_us_max: 0 });
    expect(timers.pending).toBe(0);
  });

  it('holds a gap and delivers in order once it fills', () => {
    const { b, out, timers, push } = buffer();
    push(1);
    push(3);
    timers.advance(10);
    push(4);
    expect(out).toEqual([1]);
    expect(b.holding()).toBe(2);
    timers.advance(20);
    push(2);
    expect(out).toEqual([1, 2, 3, 4]);
    expect(b.counters).toMatchObject({ held: 2, released_in_order: 2, released_timeout: 0, hold_us_max: 30_000 });
    expect(timers.pending).toBe(0);
    push(5);
    expect(out).toEqual([1, 2, 3, 4, 5]);
  });

  it('ends a hold 50 ms after the first held event arrived; the predecessor then comes as a straggler', () => {
    const { b, out, timers, push } = buffer();
    push(1);
    push(3);
    timers.advance(30);
    push(5); // a second gap: the hold still ends 50 ms after 3 arrived
    timers.advance(REORDER_HOLD_MS - 30 - 1);
    expect(out).toEqual([1]);
    timers.advance(1);
    expect(out).toEqual([1, 3, 5]);
    expect(b.counters).toMatchObject({ held: 2, released_in_order: 0, released_timeout: 2, hold_us_max: 50_000 });
    push(2); // behind expected (6): delivered at once, the router flags it late
    push(4);
    expect(out).toEqual([1, 3, 5, 2, 4]);
    push(6);
    expect(out).toEqual([1, 3, 5, 2, 4, 6]);
    expect(b.holding()).toBe(0);
  });

  it('keeps the timer on the oldest event still held after a partial fill', () => {
    const { out, timers, push } = buffer();
    push(1);
    push(3); // t 0
    timers.advance(20);
    push(5); // t 20
    push(2); // fills 2..3; 5 still waits, its hold from t 20
    expect(out).toEqual([1, 2, 3]);
    timers.advance(49);
    expect(out).toEqual([1, 2, 3]);
    timers.advance(1);
    expect(out).toEqual([1, 2, 3, 5]);
  });

  it('holds at most 8 per port: a ninth releases them all in order', () => {
    const { b, out, push } = buffer();
    push(1);
    for (const s of [10, 4, 8, 3, 6, 9, 5, 7]) {
      push(s);
    }
    expect(out).toEqual([1]);
    expect(b.holding()).toBe(8);
    push(11);
    expect(out).toEqual([1, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(b.counters).toMatchObject({ held: 9, overflows: 1, released_timeout: 9 });
    push(12);
    expect(out.at(-1)).toBe(12);
  });

  it('keeps ports and devices apart', () => {
    const { out, push } = buffer();
    push(1, 1);
    push(3, 1);
    push(1, 2);
    push(2, 2);
    push(5, 1, 'e');
    expect(out).toEqual([1, 1, 2, 5]);
  });

  it('a same-epoch reset (HELLO) delivers what is held and keeps expected', () => {
    const { b, out, timers, push } = buffer();
    push(1);
    push(3);
    b.reset('d');
    expect(out).toEqual([1, 3]);
    expect(timers.pending).toBe(0);
    push(4); // the node's counter carries on across a reconnect
    expect(out).toEqual([1, 3, 4]);
    push(6); // a gap after the reset is still held
    expect(out).toEqual([1, 3, 4]);
    expect(b.holding()).toBe(1);
  });

  it('a new-epoch reset restarts every port at 1, so a reboot whose first event comes second is held for it', () => {
    const { b, out, push } = buffer();
    push(7);
    b.reset('d', true);
    push(2); // the new boot's port_seq 1 is still on its way
    expect(out).toEqual([7]);
    push(1);
    expect(out).toEqual([7, 1, 2]);
    // A device this run has never heard: its first event sets expected, whatever its port_seq.
    push(40, 1, 'e');
    expect(out).toEqual([7, 1, 2, 40]);
  });

  it('reads the u16 wrap as in order, and never delivers one port_seq twice from the hold', () => {
    const { b, out, push } = buffer();
    push(65534);
    push(0); // a gap of one (65535)
    push(0);
    expect(b.holding()).toBe(1);
    push(65535);
    expect(out).toEqual([65534, 65535, 0]);
    push(1);
    expect(out.at(-1)).toBe(1);
  });
});

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.close();
  }
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BUTTON = findCap('fr.button')!;
const BOOT_BUTTON = { port: 1, cap_id: BUTTON.id, name: 'boot' };
const CLICK = BUTTON.events.find((e) => e.name === 'click')!.id;

/** The bytes of the event this node sent with `seq` (its first copy). */
function sentBytes(n: FakeNode, portSeq: number): Uint8Array {
  const hit = n.sent.find(([, b]) => {
    const d = decodeEnvelope(b);
    return d.ok && d.value.header.cls === CLS.EVENT && extValue(d.value.header, EXT.PORT_SEQ) === portSeq;
  });
  if (!hit) {
    throw new Error(`no event with port_seq ${portSeq} sent`);
  }
  return hit[1];
}

describe('router: ordered ports', () => {
  it('publishes port_seq order with arrival stamps, ACKs at arrival, flags a timed-out straggler late, drops a retry', async () => {
    const r = await rig();
    rigs.push(r);
    const n = r.node({ mac: 'aabbccddee70', addr: 70, alias: 'pad-o', autoHeartbeat: false });
    n.describeAs([BOOT_BUTTON]);
    await n.connected(r.events);
    const seen: HubEvent[] = [];
    r.events.subscribe((e) => e.type === 'boot.click' && seen.push(e));
    const t0 = n.nodeNowUs() >>> 0;
    // Each click is told by its device time: port_seq n is stamped t0 + n ms.
    const order = () => seen.map((e) => ((e.t_dev_us! - t0) >>> 0) / 1000);
    const click = (portSeq: number) => n.event(1, CLICK, encodeButtonClick({ count: 1 }), { portSeq, tUs: t0 + portSeq * 1000 });

    click(1);
    await until(() => seen.length === 1);
    const s3 = click(3);
    await until(() => n.received(CLS.ACK).some((f) => f.prefix.type === 'result' && f.prefix.req_seq === s3), 3000, 'the ACK of a held event');
    expect(order()).toEqual([1]); // ACKed, still held
    n.raw(sentBytes(n, 3), 'tcp'); // its retry: a DUP, not a second copy
    click(2);
    await until(() => seen.length === 3);
    expect(order()).toEqual([1, 2, 3]);
    expect(seen.map((e) => e.late)).toEqual([undefined, undefined, undefined]);

    // A gap that does not fill: released after the hold, and the predecessor comes late.
    click(5);
    await sleep(REORDER_HOLD_MS + 60);
    expect(order()).toEqual([1, 2, 3, 5]);
    click(4);
    await until(() => seen.length === 5);
    expect(order()).toEqual([1, 2, 3, 5, 4]);
    expect(seen[4].late).toBe(true);
    // Stamped from the device time through the TIME offset, not from its release.
    expect(seen[3].t_hub_us - seen[2].t_hub_us).toBeGreaterThan(1500);
    expect(seen[3].t_hub_us - seen[2].t_hub_us).toBeLessThan(2500);
    await sleep(20);
    expect(seen).toHaveLength(5);

    const st = r.router.status();
    expect(st.reorder).toMatchObject({ held: 2, released_in_order: 1, released_timeout: 1, holding: 0 });
    expect(st.reorder.hold_us_max).toBeGreaterThanOrEqual(REORDER_HOLD_MS * 1000 - 5000);
    expect(st.counters.dup).toBeGreaterThanOrEqual(1);
  });

  it('a HELLO releases what is held and keeps the sequence; events without port_seq are never held', async () => {
    const r = await rig();
    rigs.push(r);
    const n = r.node({ mac: 'aabbccddee71', addr: 71, alias: 'pad-p', autoHeartbeat: false });
    n.describeAs([BOOT_BUTTON]);
    await n.connected(r.events);
    const seen: HubEvent[] = [];
    r.events.subscribe((e) => e.type === 'boot.click' && seen.push(e));
    const t0 = n.nodeNowUs();
    n.event(1, CLICK, encodeButtonClick({ count: 1 }), { portSeq: 1, tUs: t0 });
    n.event(1, CLICK, encodeButtonClick({ count: 3 }), { portSeq: 3, tUs: t0 + 2000 });
    await until(() => seen.length === 1 && r.router.status().reorder.holding === 1);
    n.hello();
    await until(() => seen.length === 2, 1000, 'the held event at the HELLO');
    expect(seen[1].fields).toEqual({ count: 3 });
    // A same-epoch HELLO keeps the sequence: port_seq 4 follows on from the released 3.
    n.event(1, CLICK, encodeButtonClick({ count: 1 }), { portSeq: 4, tUs: t0 + 9000 });
    await until(() => seen.length === 3);
    // No port_seq: published as it comes, even out of device-time order (flagged late as before).
    n.event(1, CLICK, encodeButtonClick({ count: 1 }), { tUs: t0 + 20_000 });
    n.event(1, CLICK, encodeButtonClick({ count: 2 }), { tUs: t0 + 19_000 });
    await until(() => seen.length === 5);
    expect(seen.slice(3).map((e) => [e.fields?.count, e.late])).toEqual([
      [1, undefined],
      [2, true],
    ]);
    expect(r.router.status().reorder).toMatchObject({ held: 1, released_timeout: 1, holding: 0 });
  });
});
