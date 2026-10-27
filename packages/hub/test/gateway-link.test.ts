// The gateway link on its own (links/gateway.ts; design m2-c4-gateway D13-D15), on a manual clock and a recording
// serial writer: what one ESP-NOW frame carries (fitsAir), the unicast in-flight cap below the gateway's 32-deep queue
// with broadcasts and BEACONs never held back by it, no down decision on the tick after an event-loop stall, and
// endpoints made only for a HELLO and pruned once idle.

import { describe, expect, it } from 'vitest';

import { CLS, decodeSerialLine, FLAG, SERIAL_TYPE } from '@fractonica/protocol';
import { ADDR, decodeGwTx, encodeEnvelope, encodeFrameLine, KIND, PORT } from '@fractonica/protocol/gen';

import { fitsAir, Framed, GATEWAY_MAX_IN_FLIGHT, GATEWAY_QUEUE_DEPTH, GatewayLink, SerialLink } from '../src/links/index.ts';
import type { Endpoint, LinkSink, Source } from '../src/links/types.ts';

const GW = 'f0f5bd09fdec';
const NODE = 'aabbccdd0101';

/** A decode that must succeed. */
function ok<T>(d: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!d.ok) {
    throw new Error(`decode failed: ${d.error}`);
  }
  return d.value;
}

/** The body of an `@fr1:` line. */
const bodyOf = (line: string) => ok(decodeSerialLine(line)).body;

function env(opts: { cls?: number; kind?: number; flags?: number; body?: number } = {}): Uint8Array {
  return encodeEnvelope({
    header: { flags: opts.flags ?? 0, cls: opts.cls ?? CLS.MSG, kind: opts.kind ?? KIND.MSG.MSG, seq: 1, net: 0, src: 5, dst: ADDR.HUB, epoch: 1, ttl: 0x22, port: PORT.NODE },
    body: new Uint8Array(opts.body ?? 0),
  });
}

function setup(timing: { endpointIdleMs?: number } = {}) {
  let now = 1000;
  const lines: string[] = [];
  const got: { from: Source; bytes: Uint8Array }[] = [];
  const closed: { ep: Endpoint; why?: string }[] = [];
  const sink: LinkSink = {
    envelope: (from, bytes) => got.push({ from, bytes: bytes.slice() }),
    closed: (ep, why) => closed.push({ ep, why }),
  };
  const serial = new SerialLink(sink, { writeLine: async (_key, line) => void lines.push(line) });
  const link = new GatewayLink(sink, serial, {
    timing: { pingMs: 250, downMs: 1000, txTimeoutMs: 60_000, maxInFlight: GATEWAY_MAX_IN_FLIGHT, ...timing },
    clock: { now: () => now, nowUs: () => now * 1000 },
  });
  serial.gateways = link;
  link.attach(GW);
  const pong = () => link.line(GW, SERIAL_TYPE.LINK_PONG, bodyOf(encodeFrameLine({ type: 'LINK_PONG', t: 0 })));
  const rx = (mac: string, e: Uint8Array) =>
    link.line(GW, SERIAL_TYPE.GW_RX, bodyOf(encodeFrameLine({ type: 'GW_RX', src_mac: Buffer.from(mac, 'hex'), rssi: -50, channel: 6, rx_ts_us: 0, env: e })));
  const advance = (ms: number) => {
    now += ms;
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const gwTx = () =>
    lines
      .map((l) => ok(decodeSerialLine(l)))
      .filter((d) => d.type === SERIAL_TYPE.GW_TX)
      .map((d) => ok(decodeGwTx(d.body)));
  return { link, sink, lines, got, closed, pong, rx, advance, flush, gwTx, view: () => link.view(GW)! };
}

describe('fitsAir: what one ESP-NOW frame carries (design D1, D8)', () => {
  it('takes envelopes up to MTU.REALTIME without BULK, and nothing else', () => {
    expect(fitsAir(env({ body: 250 - 18 }))).toBe(true);
    expect(fitsAir(env({ body: 251 - 18 }))).toBe(false);
    expect(fitsAir(env({ flags: FLAG.BULK }))).toBe(false);
    expect(new Framed(env({ body: 300 })).gwBroadcast).toBeNull();
    expect(new Framed(env({ flags: FLAG.BULK })).gwBroadcast).toBeNull();
    expect(new Framed(env()).gwBroadcast).not.toBeNull();
  });
});

describe('the gateway link', () => {
  it('makes an endpoint only for a HELLO, hands other frames on a stray closed endpoint, and prunes one idle for endpointIdleMs', async () => {
    const g = setup({ endpointIdleMs: 30_000 });
    g.link.tick();
    g.pong();
    expect(g.view().up).toBe(true);
    // A TCP node's air broadcast: to the router, on an endpoint nothing can send on, and in no count of endpoints.
    g.rx('aabbccdd0999', env());
    expect(g.got).toHaveLength(1);
    const stray = g.got[0].from as Endpoint;
    expect(stray).toMatchObject({ kind: 'gateway', remote: 'aabbccdd0999', closed: true, gateway: GW });
    expect(stray.send(env())).toBe(false);
    expect(g.view()).toMatchObject({ endpoints: 0, counters: { rx_stray: 1, rx: 1 } });
    // A HELLO makes one, and later frames from that MAC take it.
    g.rx(NODE, env({ cls: CLS.PRESENCE, kind: KIND.PRESENCE.HELLO }));
    g.rx(NODE, env());
    const ep = g.got[1].from as Endpoint;
    expect(ep.closed).toBe(false);
    expect(g.got[2].from).toBe(ep);
    expect(g.view().endpoints).toBe(1);
    // Kept while frames go either way (a session's hub HEARTBEATs), pruned after 30 s of none.
    for (let i = 0; i < 4; i++) {
      g.advance(10_000);
      expect(ep.send(env())).toBe(true);
      g.pong();
      g.link.tick();
    }
    expect(g.view().endpoints).toBe(1);
    for (let i = 0; i < 3; i++) {
      g.advance(10_000);
      g.pong();
      g.link.tick();
    }
    expect(ep.closed).toBe(true);
    expect(g.closed).toEqual([{ ep, why: 'gateway endpoint idle' }]);
    expect(g.view()).toMatchObject({ up: true, endpoints: 0, counters: { ep_idle: 1 } });
  });

  it('caps unicast GW_TX in flight at 24, never takes a frame the air cannot carry, and leaves broadcasts and BEACONs their room', async () => {
    const g = setup();
    g.link.tick();
    g.pong();
    g.rx(NODE, env({ cls: CLS.PRESENCE, kind: KIND.PRESENCE.HELLO }));
    const ep = g.got[0].from as Endpoint;
    expect(GATEWAY_MAX_IN_FLIGHT).toBe(24);
    expect(GATEWAY_QUEUE_DEPTH - GATEWAY_MAX_IN_FLIGHT).toBe(8);
    expect(ep.send(env({ body: 300 }))).toBe(false);
    expect(ep.send(env({ flags: FLAG.BULK }))).toBe(false);
    expect(g.view().counters).toMatchObject({ tx_too_big: 2, tx_drop: 2, tx: 0 });
    const sent = Array.from({ length: 30 }, () => ep.send(env()));
    expect(sent.filter(Boolean)).toHaveLength(24);
    expect(g.view()).toMatchObject({ in_flight: 24, counters: { tx: 24, tx_drop: 8 } });
    // A hub broadcast (default room) and a BEACON (Infinity) still go; the fan-out's 16 does not.
    expect(g.link.broadcast(GW, new Framed(env()))).toBe(true);
    expect(g.link.broadcast(GW, new Framed(env({ cls: CLS.NET, kind: KIND.NET.BEACON })), Infinity)).toBe(true);
    expect(g.link.broadcast(GW, new Framed(env()), 16)).toBe(false);
    // Nor a broadcast the air cannot carry.
    expect(g.link.broadcast(GW, new Framed(env({ body: 300 })))).toBe(false);
    await g.flush();
    const txs = g.gwTx();
    expect(txs.filter((t) => t.tx_id === 0)).toHaveLength(2);
    expect(txs.filter((t) => t.tx_id !== 0)).toHaveLength(24);
    expect(txs.every((t) => t.env.length <= 250 && !(t.env[1] & FLAG.BULK))).toBe(true);
  });

  it('takes no down decision on the tick after an event-loop stall longer than pingMs, and decides on the next one', () => {
    const g = setup();
    g.link.tick();
    g.pong();
    for (let i = 0; i < 8; i++) {
      g.advance(25);
      g.link.tick();
    }
    g.pong();
    // A 1.5 s stall: the LINK_PONGs the gateway sent meanwhile are still unread when this tick runs.
    g.advance(1500);
    g.link.tick();
    expect(g.view()).toMatchObject({ up: true, counters: { stall_skips: 1, downs: 0 } });
    g.pong(); // read once the tick yields
    g.advance(25);
    g.link.tick();
    expect(g.view().up).toBe(true);
    // The same stall with no LINK_PONG after it (the gateway is really gone): down on the first ordinary tick.
    g.advance(1500);
    g.link.tick();
    expect(g.view()).toMatchObject({ up: true, counters: { stall_skips: 2 } });
    g.advance(25);
    g.link.tick();
    expect(g.view()).toMatchObject({ up: false, counters: { downs: 1 } });
    // Ordinary ticks alone still give the 1 s rule (D15): up again, then 1 s of 25 ms ticks without a LINK_PONG.
    g.pong();
    expect(g.view().up).toBe(true);
    for (let t = 0; t < 975; t += 25) {
      g.advance(25);
      g.link.tick();
    }
    expect(g.view().up).toBe(true);
    g.advance(25);
    g.link.tick();
    expect(g.view()).toMatchObject({ up: false, counters: { downs: 2, stall_skips: 2 } });
  });
});
