// Golden vector emitter (design c2 §8): coverage against the model, well-formed and deterministic
// cases, and a set of vectors whose bytes are computed by hand here, independently of the emitter.
// packages/protocol/test/gen.test.ts runs every vector through the generated TS codecs.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { decodeSerialLine, DECODE_ERRORS } from '@fractonica/protocol';

import { emitVectors, loadModel, VECTORS_DIR, type GoldenVector } from '@fractonica/codegen';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const model = loadModel(ROOT);
const { cases, files } = emitVectors(model);

function byName(name: string): GoldenVector {
  const c = cases.find((x) => x.name === name);
  if (!c) {
    throw new Error(`no vector ${name}`);
  }
  return c;
}

function bodyTypes(): Set<string> {
  const out = new Set<string>([
    ...model.protocol.messages.map((m) => m.key),
    ...model.protocol.types.map((t) => t.name),
    // Layout serial bodies (design m2-c4-gateway D1); the protobuf ones are protocol types.
    ...model.protocol.serial.bodies.filter((b) => b.kind === 'layout').map((b) => b.name),
  ]);
  for (const cap of model.capabilities) {
    if (cap.traits.length > 0) {
      out.add(`${cap.name}.traits`);
    }
    for (const cmd of cap.commands) {
      out.add(`${cap.name}.${cmd.name}.args`);
      if (cmd.result) {
        out.add(`${cap.name}.${cmd.name}.result`);
      }
    }
    for (const ev of cap.events) {
      out.add(`${cap.name}.${ev.name}.event`);
    }
    for (const p of cap.properties) {
      out.add(`${cap.name}.${p.name}.state`);
    }
  }
  return out;
}

describe('golden vectors', () => {
  it('are well-formed and uniquely named', () => {
    expect(new Set(cases.map((c) => c.name)).size).toBe(cases.length);
    const types = bodyTypes();
    for (const c of cases) {
      expect(c.name, c.name).toMatch(/^[A-Za-z0-9_.]+$/);
      expect(c.hex, c.name).toMatch(/^([0-9a-f]{2})*$/);
      if (c.error) {
        expect(DECODE_ERRORS, c.name).toContain(c.error);
        expect([c.value, c.decodeOnly], c.name).toEqual([null, true]);
      }
      if (c.kind === 'message' || c.kind === 'cap') {
        expect(types.has(c.type), c.name).toBe(true);
      }
    }
  });

  it('cover every class, system message, protocol type, member and the serial link frames', () => {
    const canonical = new Set(cases.filter((c) => !c.decodeOnly).map((c) => c.type));
    const want = [...bodyTypes(), ...model.protocol.classes.map((c) => `envelope.${c.name}`), ...model.protocol.serial.types.map((t) => `serial.${t.name}`)];
    expect(want.filter((t) => !canonical.has(t))).toEqual([]);
    // Serial lines both ways; every DecodeError a valid C2 input can hit has a case.
    expect(cases.filter((c) => c.kind === 'serial' && /host_to_node/.test(c.name)).length).toBeGreaterThan(0);
    expect(cases.filter((c) => c.kind === 'serial' && /node_to_host/.test(c.name)).length).toBeGreaterThan(0);
    const errors = new Set(cases.map((c) => c.error).filter((e) => e !== undefined));
    expect(DECODE_ERRORS.filter((e) => !errors.has(e))).toEqual([]);
  });

  it('are deterministic and written one file per kind', () => {
    expect(emitVectors(loadModel(ROOT))).toEqual({ cases, files });
    expect(files.map((f) => f.path)).toEqual(['header', 'envelope', 'messages', 'caps', 'serial'].map((n) => `${VECTORS_DIR}/${n}.json`));
    const fromFiles = files.flatMap((f) => JSON.parse(f.content).cases as GoldenVector[]);
    expect(fromFiles).toEqual(cases);
  });

  it('match bytes computed by hand', () => {
    const hand: [string, string][] = [
      // magic a1, flags URGENT, EVENT, kind 1, seq 12, net 0x0102, src fffe, dst 0, epoch 3, ttl 0x22, port 1
      ['header.button_down', 'a1 20 03 01 0c000000 0201 feff 0000 0300 22 01'],
      ['envelope.event.button_down', 'a1 20 03 01 0c000000 0201 feff 0000 0300 22 01 e8030000'],
      // EXT (flags a0): block len 4, port_seq (05) len 2 = 1 (design m2-c3-inputs D8)
      ['header.ext_port_seq', 'a1 a0 03 01 0c000000 0201 feff 0000 0300 22 01 04 0502 0100'],
      // button.up with port_seq 2, then the time prefix 81000 (0x00013c68) and held_ms 80
      ['envelope.event.button_up_port_seq', 'a1 a0 03 02 0d000000 0201 feff 0000 0300 22 01 04 0502 0200 683c0100 08 50'],
      ['fr.fixture.set_duty.args.full_scale', '08 904e'],
      // RESULT prefix: req_epoch 9, req_seq 5, status 0; no body
      ['envelope.result.led_blink_ok', 'a1 00 05 03 0f000000 0201 1200 0000 0300 22 02 0900 05000000 00'],
      // 200 = c8 01; blink fields have non-zero defaults and are always written
      ['fr.led.blink.args.defaults', '08 c801 10 c801 18 03'],
      ['fr.led.blink.args.example_0', '08 64 10 64 18 03 20 8080fc07'],
      ['fr.led.blink.args.count_zero', '08 c801 10 c801 18 00'],
      // optional fields set to zero are written; an implicit false is not
      ['fr.led.set.args.optional_zero', '10 00 18 00'],
      ['fr.led.set.args.example_0', '08 01 18 80fe03'],
      ['fr.node.identify.args.defaults', '08 b817'],
      ['fr.button.up.event.held_1500', '08 dc0b'],
      ['fr.button.traits.defaults', '08 01 10 02'],
      ['fr.button.inject.args.lenient_gesture_5', '08 05'],
      // count 0 is the absent field, exempt from 1..5 (design c2 §3): not lenient.
      ['fr.button.click.event.defaults', ''],
      ['fr.button.click.event.zero_on_wire', '08 00'],
      // i8 zigzag: -128 -> 255, -1 -> 1
      ['PRESENCE.HEARTBEAT.min', '18 ff01'],
      ['PRESENCE.HEARTBEAT.rssi_minus_one', '18 01'],
      ['TIME.SYNC_REQ.max', '08 ffffffffffffffffff01'],
      ['NET.DIRECTORY.one_entry', '10 01 1a0a 08 12 12 06 a0b1c2d3e4f5'],
      ['NET.RESOLVE.max', '08 ffff03'],
      // EXT 0x82 exec_at_hub_us (design m2-c4-gateway D4): block len 6, 82 04 then 0x80000001 LE
      ['header.ext_exec_at_hub', 'a1 82 04 01 07000000 0201 0000 1200 0900 22 02 06 8204 01000080'],
      // NET.WELCOME net_mode gateway (NetMode 1): field 5 varint
      ['NET.WELCOME.gateway_mode', '08 09 28 01 30 01'],
      // Serial bodies, little-endian (design m2-c4-gateway D1). GW_RX: mac, rssi -61 (c3), channel 6, rx_ts_us
      // 123456789 (075bcd15), then the button.down envelope.
      ['GW_RX.typical', 'a0b1c2d3e4f5 c3 06 15cd5b07 a1 20 03 01 0c000000 0201 feff 0000 0300 22 01 e8030000'],
      ['GW_TX_DONE.typical', '0102 01 07 34080000'],
      ['GW_TX_DONE.defaults', '0000 00 00 00000000'],
      ['LINK_PING.typical', '90d00300'],
      // GW_TX broadcast: tx_id 0, FF x6, tx_opts 0, then the BEACON envelope.
      ['GW_TX.broadcast_beacon', `0000 ffffffffffff 00 ${byName('envelope.net.beacon').hex}`],
    ];
    for (const [name, hex] of hand) {
      expect(byName(name).hex, name).toBe(hex.replace(/\s+/g, ''));
    }
    // The ENV line of the button.down envelope, as in packages/protocol/test/wire.test.ts.
    expect(byName('serial.env.node_to_host.event_button_down').value).toMatchObject({ line: '@fr1:AaEgAwEMAAAAAgH-_wAAAwAiAegDAAA8Ig' });
    expect(Buffer.from(byName('serial.env.crlf').hex, 'hex').toString('latin1').endsWith('Ig\r\n')).toBe(true);
    const long = (byName('serial.gw_rx.max_line').value as { line: string }).line;
    expect(long.length).toBe(model.protocol.serial.maxLine);
    expect(decodeSerialLine(long).ok).toBe(true);
  });

  it('hold the decoded value: defaults filled in, u64 as decimal strings, bytes as hex', () => {
    expect(byName('fr.led.blink.args.example_0').value).toEqual({ on_ms: 100, off_ms: 100, count: 3, color: 0xff0000 });
    expect(byName('fr.button.inject.args.defaults').value).toEqual({ gesture: 'click' });
    expect(byName('fr.button.click.event.defaults').value).toEqual({ count: 0 });
    // Every body type has an empty-body case: implicit zeros are exempt from range, other defaults inside it.
    const empty = new Set(cases.filter((c) => /\.(defaults|empty)$/.test(c.name)).map((c) => c.type));
    expect([...bodyTypes()].filter((t) => !empty.has(t))).toEqual([]);
    expect(byName('TIME.SYNC_REQ.max').value).toEqual({ t1: '18446744073709551615' });
    expect(byName('NET.DIRECTORY.zero_entry').value).toEqual({ page: 0, pages: 1, entries: [{ addr: 0, mac: '' }] });
    expect(byName('PRESENCE.HELLO.lenient_ota_state_5').value).toMatchObject({ ota_state: 5, role: 'node' });
    expect(byName('envelope.cmd.led_blink').value).toMatchObject({ body_type: 'fr.led.blink.args', body_value: { on_ms: 100, off_ms: 100, count: 3, color: 0xff0000 } });
  });

  it('match the committed files and carry placeholder credentials only', () => {
    const text = files.map((f) => f.content).join('\n');
    expect(text).toContain('not-a-secret');
    expect(readFileSync(join(ROOT, VECTORS_DIR, 'caps.json'), 'utf8')).toBe(files.find((f) => f.path.endsWith('caps.json'))!.content);
  });
});
