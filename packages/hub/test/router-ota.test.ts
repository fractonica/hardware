// The router's OTA seam (design c4 §3-4), which the OTA orchestrator builds on: sendOta puts OTA-class
// frames on port 240 over the node's TCP session (else serial, and serial while a USB node's Wi-Fi is
// silent), onOta hands the node's OTA frames to listeners (a Q1 one ACKed, a DUP not handed on twice), OTA
// frames over UDP or off port 240 are dropped, tcpAddress names the source IP the 7422 gate checks, and the
// HELLO's ota_state is in the router info, device.online and wait_for_device (valid once RESULT success
// names the running image). FakeNodes over real loopback links.

import { afterEach, describe, expect, it } from 'vitest';

import { CLS, findOp, FLAG } from '@fractonica/protocol';
import { decodeOtaOffer, encodeOtaAccept, encodeOtaOffer, encodeOtaResult, encodeOtaStatus, KIND, PORT } from '@fractonica/protocol/gen';

import type { OtaFrame } from '../src/context.ts';
import { HANDLERS } from '../src/ops.ts';
import { FakeSerial, rig, type Rig, until, waitForEvent } from './fake-node.ts';

const rigs: Rig[] = [];
async function open(): Promise<Rig> {
  const r = await rig();
  rigs.push(r);
  return r;
}
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.close();
  }
});

const MAC = 'aabbccddeeff';
const offer = () => encodeOtaOffer({ job_id: 'ota-0042', fw_id: new Uint8Array(32).fill(0xab), size: 1048576, version: '0.3.1' });

async function online(r: Rig, opts: { serial?: FakeSerial } = {}) {
  r.registry.add({ device_id: MAC, addr: 5, alias: 'pad', provisioned: true });
  const n = r.node({ mac: MAC, addr: 5, alias: 'pad', autoHeartbeat: false, ...opts });
  await n.connected(r.events);
  return n;
}

function listen(r: Rig): OtaFrame[] {
  const got: OtaFrame[] = [];
  r.router.onOta((f) => got.push(f));
  return got;
}

describe('sendOta', () => {
  it('sends an OTA frame on port 240 over the TCP session', async () => {
    const r = await open();
    const n = await online(r);
    const sent = r.router.sendOta(MAC, KIND.OTA.OFFER, offer(), { ackReq: true });
    expect(sent.link).toBe('tcp');
    const f = await until(() => n.received(CLS.OTA, KIND.OTA.OFFER)[0], 3000, 'the OFFER');
    expect(f.via).toBe('tcp');
    expect(f.header).toMatchObject({ src: 0, dst: 5, port: PORT.OTA, seq: sent.seq, epoch: 7 });
    expect(f.header.flags & FLAG.ACK_REQ).toBe(FLAG.ACK_REQ);
    expect(decodeOtaOffer(f.body)).toMatchObject({ ok: true, value: { job_id: 'ota-0042', size: 1048576 } });
    // COMMIT without ACK_REQ.
    r.router.sendOta(MAC, KIND.OTA.COMMIT, new Uint8Array(0));
    const c = await until(() => n.received(CLS.OTA, KIND.OTA.COMMIT)[0], 3000, 'the COMMIT');
    expect(c.header.flags & FLAG.ACK_REQ).toBe(0);
  });

  it('uses the USB line for a node without TCP', async () => {
    const r = await open();
    const n = await online(r, { serial: r.serial });
    expect(r.router.sendOta(MAC, KIND.OTA.ABORT, new Uint8Array(0)).link).toBe('serial');
    await until(() => n.received(CLS.OTA, KIND.OTA.ABORT)[0], 3000, 'the ABORT');
    expect(r.router.tcpAddress(MAC)).toBeNull();
  });

  it('takes the USB line of a node on both links while its Wi-Fi is silent, and TCP again once it carries', async () => {
    const r = await open();
    r.registry.add({ device_id: MAC, addr: 5, alias: 'pad', provisioned: true });
    // hb 100 ms: the USB line after more than 200 ms without a Wi-Fi frame. The node's heartbeats go on
    // every session (fr_net), so USB keeps it online meanwhile.
    const usb = r.node({ mac: MAC, addr: 5, alias: 'pad', hbMs: 100, serial: r.serial });
    await usb.connected(r.events);
    const wifi = r.node({ mac: MAC, addr: 5, alias: 'pad', hbMs: 100, autoHeartbeat: false, seqStart: 100 });
    const tcpUp = waitForEvent(r.events, (e) => e.type === 'device.link' && e.fields?.link === 'tcp');
    await wifi.connect();
    await tcpUp;
    expect(r.router.sendOta(MAC, KIND.OTA.OFFER, offer(), { ackReq: true }).link).toBe('tcp');
    await until(() => wifi.received(CLS.OTA, KIND.OTA.OFFER)[0], 3000, 'the OFFER over TCP');
    wifi.unplug();
    await until(() => r.router.info(MAC)!.links[0] === 'serial', 3000, 'the USB line first');
    expect(r.router.sendOta(MAC, KIND.OTA.ABORT, new Uint8Array(0)).link).toBe('serial');
    await until(() => usb.received(CLS.OTA, KIND.OTA.ABORT)[0], 3000, 'the ABORT over USB');
    expect(r.router.presence(MAC)).toBe('online');
    expect(r.router.tcpAddress(MAC)).toBe('127.0.0.1'); // the TCP session is still there, only silent
    wifi.silent = false;
    wifi.heartbeat();
    await until(() => r.router.info(MAC)!.links[0] === 'tcp', 3000, 'TCP first again');
    expect(r.router.sendOta(MAC, KIND.OTA.COMMIT, new Uint8Array(0)).link).toBe('tcp');
  });

  it('is DEVICE_OFFLINE without a session', async () => {
    const r = await open();
    let err: unknown = null;
    try {
      r.router.sendOta(MAC, KIND.OTA.OFFER, offer());
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code: 'DEVICE_OFFLINE' });
  });
});

describe('onOta', () => {
  it("hands the node's OTA frames to listeners with their link, kind and body", async () => {
    const r = await open();
    const got = listen(r);
    const n = await online(r);
    const accept = encodeOtaAccept({ job_id: 'ota-0042', code: 0 });
    n.raw(n.envelope(CLS.OTA, KIND.OTA.ACCEPT, PORT.OTA, accept).bytes, 'tcp');
    const f = await until(() => got[0], 3000, 'the ACCEPT');
    expect(f).toMatchObject({ device: MAC, alias: 'pad', kind: KIND.OTA.ACCEPT, link: 'tcp', epoch: 1 });
    expect(Buffer.from(f.body).equals(Buffer.from(accept))).toBe(true);
    // ACCEPT answers an OFFER: no ACK for it.
    expect(n.received(CLS.ACK)).toEqual([]);
  });

  it('ACKs a Q1 RESULT, hands a DUP of it on only once, and ACKs the DUP again', async () => {
    const r = await open();
    const got = listen(r);
    const n = await online(r);
    const result = n.envelope(CLS.OTA, KIND.OTA.RESULT, PORT.OTA, encodeOtaResult({ job_id: 'ota-0042', outcome: 2, reason: 1 }), undefined, FLAG.ACK_REQ);
    n.raw(result.bytes, 'tcp');
    n.raw(result.bytes, 'tcp');
    const acks = await until(() => {
      const a = n.received(CLS.ACK).filter((f) => f.prefix.type === 'result' && f.prefix.req_seq === result.seq);
      return a.length === 2 ? a : null;
    }, 3000, 'two ACKs');
    expect(acks[0].header.port).toBe(PORT.OTA);
    expect(got).toHaveLength(1);
  });

  it('drops OTA frames over UDP or off port 240', async () => {
    const r = await open();
    const got = listen(r);
    const n = await online(r);
    const status = encodeOtaStatus({ job_id: 'ota-0042', state: 1, bytes: 4096 });
    n.raw(n.envelope(CLS.OTA, KIND.OTA.STATUS, PORT.OTA, status).bytes, 'udp');
    n.raw(n.envelope(CLS.OTA, KIND.OTA.STATUS, PORT.NODE, status).bytes, 'tcp');
    await until(() => r.router.status().counters.ota_dropped === 2, 3000, 'two drops');
    expect(got).toEqual([]);
    // A good one still arrives.
    n.raw(n.envelope(CLS.OTA, KIND.OTA.STATUS, PORT.OTA, status).bytes, 'tcp');
    await until(() => got[0], 3000, 'the STATUS');
  });

  it('keeps the other listeners when one throws, and unsubscribes', async () => {
    const r = await open();
    const off = r.router.onOta(() => {
      throw new Error('listener bug');
    });
    const got = listen(r);
    const n = await online(r);
    const status = encodeOtaStatus({ job_id: 'ota-0042', state: 1, bytes: 0 });
    n.raw(n.envelope(CLS.OTA, KIND.OTA.STATUS, PORT.OTA, status).bytes, 'tcp');
    await until(() => got.length === 1, 3000, 'the STATUS');
    off();
    n.raw(n.envelope(CLS.OTA, KIND.OTA.STATUS, PORT.OTA, status).bytes, 'tcp');
    await until(() => got.length === 2, 3000, 'the second STATUS');
  });
});

describe('tcpAddress', () => {
  it("is the source IP of the device's live TCP session", async () => {
    const r = await open();
    expect(r.router.tcpAddress(MAC)).toBeNull();
    const n = await online(r);
    expect(r.router.tcpAddress(MAC)).toBe('127.0.0.1');
    n.dropTcp();
    await until(() => r.router.tcpAddress(MAC) === null, 3000, 'the session to end');
  });
});

describe('ota_state', () => {
  it("is the HELLO's in the router info, device.online and wait_for_device; RESULT success for the running image makes it valid", async () => {
    const r = await open();
    r.registry.add({ device_id: MAC, addr: 5, alias: 'pad', provisioned: true });
    const n = r.node({ mac: MAC, addr: 5, alias: 'pad', autoHeartbeat: false });
    n.otaState = 'pending_verify'; // a new OTA image on probation
    const online = waitForEvent(r.events, (e) => e.type === 'device.online' && e.device === MAC, 3000);
    await n.connected(r.events);
    expect((await online).fields).toMatchObject({ fw_id_prefix: n.opts.fwPrefix, ota_state: 'pending_verify' });
    expect(r.router.info(MAC)).toMatchObject({ ota_state: 'pending_verify' });
    const wait = (timeout_s: number) => HANDLERS.wait_for_device(findOp('wait_for_device')!.input.parse({ selector: 'pad', ota_state: 'valid', timeout_s }), r.hub);
    await expect(wait(1)).rejects.toMatchObject({ code: 'TIMEOUT', details: { devices: [{ ota_state: 'pending_verify' }] } });
    // A RESULT success that names another image changes nothing; one for the running image does.
    const result = (prefix: Uint8Array) =>
      n.raw(n.envelope(CLS.OTA, KIND.OTA.RESULT, PORT.OTA, encodeOtaResult({ job_id: 'ota-0042', outcome: 0, fw_id_prefix: prefix }), undefined, FLAG.ACK_REQ).bytes, 'tcp');
    const got = listen(r);
    result(new Uint8Array(8).fill(0xee));
    await until(() => got.length === 1, 3000, 'the first RESULT');
    expect(r.router.info(MAC)!.ota_state).toBe('pending_verify');
    const waiting = wait(5);
    result(Buffer.from(n.opts.fwPrefix, 'hex'));
    expect(await waiting).toMatchObject({ devices: [{ device: MAC, ota_state: 'valid' }] });
    expect(r.router.info(MAC)!.ota_state).toBe('valid');
  });
});
