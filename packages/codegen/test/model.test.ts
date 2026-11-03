import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';

import {
  CLS,
  EXT,
  EXT_VALUE_SIZE,
  FLAG,
  HEADER_SIZE,
  MAGIC_VER,
  RESULT_PREFIX_SIZE,
  SERIAL_MAX_LINE,
  SERIAL_PREFIX,
  SERIAL_TYPE,
  TIME_PREFIX_SIZE,
} from '@fractonica/protocol';

import {
  appCapabilities,
  buildCatalog,
  buildModel,
  canonicalJson,
  catalogHash,
  cppIdent,
  fnv1a32,
  isReservedInstanceName,
  loadModel,
  maxEncodedSize,
  pascalCase,
  readSchemaSources,
  RESERVED_INSTANCE_NAMES,
  SchemaError,
  type Capability,
  type Model,
  type SchemaIssue,
  type SchemaSources,
} from '@fractonica/codegen';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function model(): Model {
  return loadModel(ROOT);
}

function cap(m: Model, name: string): Capability {
  const c = m.capabilities.find((x) => x.name === name);
  if (!c) {
    throw new Error(`no ${name}`);
  }
  return c;
}

type Yaml = Record<string, any>;

/** Real sources with one file's parsed YAML edited. */
function edited(file: string, edit: (y: Yaml) => void): SchemaSources {
  const src = readSchemaSources(ROOT);
  const all = [src.protocol, src.registry, ...src.capabilities];
  const f = all.find((x) => x.path === file);
  if (!f) {
    throw new Error(`no source ${file}`);
  }
  const y = parse(f.text) as Yaml;
  edit(y);
  f.text = stringify(y);
  return src;
}

function issuesOf(sources: SchemaSources): SchemaIssue[] {
  const r = buildModel(sources);
  if (r.ok) {
    throw new Error('expected validation to fail');
  }
  return r.issues;
}

const BUTTON = 'schema/capabilities/button.cap.yaml';
const LED = 'schema/capabilities/led.cap.yaml';
const PROTOCOL = 'schema/protocol.yaml';

describe('loading the committed schema', () => {
  it('builds every capability in id order', () => {
    const m = model();
    expect(m.capabilities.map((c) => [c.id, c.name, c.pascalName, c.section])).toEqual([
      [0x0001, 'fr.button', 'Button', 'standard'],
      [0x0002, 'fr.led', 'Led', 'standard'],
      [0x0003, 'fr.display', 'Display', 'standard'],
      [0x0004, 'fr.audio_out', 'AudioOut', 'standard'],
      [0x0005, 'fr.analog_in', 'AnalogIn', 'standard'],
      [0x0006, 'fr.fixture', 'Fixture', 'standard'],
      [0x0007, 'fr.audio_in', 'AudioIn', 'standard'],
      [0x0008, 'fr.touch', 'Touch', 'standard'],
      [0x0009, 'fr.csi', 'Csi', 'standard'],
      [0x000a, 'fr.radio_tx', 'RadioTx', 'standard'],
      [0x000b, 'fr.camera', 'Camera', 'standard'],
      [0x00f0, 'fr.node', 'Node', 'system'],
      [0x00f1, 'fr.ota', 'Ota', 'system'],
      [0x00f2, 'fr.diag', 'Diag', 'system'],
    ]);
  });

  it('resolves members, types, traits, config and requires', () => {
    const button = cap(model(), 'fr.button');
    expect(button.version).toEqual({ major: 1, minor: 0 });
    expect(button.enums[0]).toMatchObject({ name: 'Gesture', underlying: 'u8', maxValue: 4 });
    expect(button.events.map((e) => [e.name, e.id, e.priority, e.realtime])).toEqual([
      ['down', 1, 'realtime', true],
      ['up', 2, 'realtime', true],
      ['click', 3, 'normal', false],
      ['long_press', 4, 'normal', false],
    ]);
    expect(button.events[3].requires).toEqual({ trait: 'long_press' });
    expect(button.config.map((c) => [c.name, c.default])).toEqual([
      ['debounce_ms', 20],
      ['long_press_ms', 600],
      ['multi_press_gap_ms', 250],
      ['multi_press_max', 2],
    ]);
    const inject = button.commands[0];
    expect(inject).toMatchObject({ name: 'inject', visibility: 'test', delivery: 'reliable', idempotent: false, result: null });
    expect(inject.fields[0].type).toMatchObject({ kind: 'enum' });
    expect(inject.examples).toEqual([{ gesture: 'double_click' }, { gesture: 'press' }]);

    const led = cap(model(), 'fr.led');
    expect(led.properties.find((p) => p.name === 'color')?.requires).toEqual({ trait: 'color', eq: 'rgb' });
    expect(led.commands.map((c) => c.name)).toEqual(['set', 'toggle', 'blink', 'stop']);
  });

  it('derives field presence from optional and defaults', () => {
    const m = model();
    const led = cap(m, 'fr.led');
    const set = led.commands.find((c) => c.name === 'set')!;
    const blink = led.commands.find((c) => c.name === 'blink')!;
    expect(set.fields.map((f) => [f.name, f.presence])).toEqual([
      ['on', 'implicit'],
      ['brightness', 'optional'],
      ['color', 'optional'],
    ]);
    expect(blink.fields.map((f) => [f.name, f.presence])).toEqual([
      ['on_ms', 'always'],
      ['off_ms', 'always'],
      ['count', 'always'],
      ['color', 'optional'],
    ]);
    // Zero defaults (an enum member with value 0, false) stay implicit.
    expect(cap(m, 'fr.button').commands[0].fields[0].presence).toBe('implicit');
    expect(cap(m, 'fr.node').commands.find((c) => c.name === 'reboot')!.fields[0].presence).toBe('implicit');
    expect(cap(m, 'fr.button').traits.map((t) => t.presence)).toEqual(['always', 'always']);
    expect(led.traits.map((t) => t.presence)).toEqual(['implicit', 'implicit']);
  });

  it('computes worst-case sizes from max and range', () => {
    const m = model();
    const button = cap(m, 'fr.button');
    expect(button.events.map((e) => e.maxBody)).toEqual([0, 6, 2, 6]); // up: tag + 5-byte u32; click: range [1, 5]
    expect(button.properties[0].maxBody).toBe(2);
    const led = cap(m, 'fr.led');
    expect(led.commands.map((c) => c.maxArgs)).toEqual([11, 0, 15, 0]); // blink: 3 + 3 + 3 + 6
    const exec = cap(m, 'fr.diag').commands[0];
    expect([exec.maxArgs, exec.maxResult, exec.realtime]).toEqual([203, 1403, false]);
    const msg = (key: string) => m.protocol.messages.find((x) => x.key === key)!;
    // 05 §5.7 sizes a DIRECTORY page at 200 B assuming page/pages < 128; the u8 worst case is 202 B.
    expect([msg('NET.DIRECTORY').maxBody, msg('NET.DIRECTORY').realtime]).toEqual([202, false]);
    expect(m.protocol.types[0]).toMatchObject({ name: 'DirectoryEntry', maxSize: 12 });
    expect(msg('PRESENCE.HELLO').maxBody).toBe(107);
    expect(msg('LOG.LINE')).toMatchObject({ kind: null, realtime: false });
    expect(msg('TIME.SYNC_RES').maxBody).toBe(33);
    expect(maxEncodedSize([])).toBe(0);
  });

  it('lays out the header and class prefixes', () => {
    const p = model().protocol;
    expect(p.headerSize).toBe(18);
    expect(p.header.map((f) => [f.name, f.offset])).toEqual([
      ['magic_ver', 0],
      ['flags', 1],
      ['cls', 2],
      ['kind', 3],
      ['seq', 4],
      ['net', 8],
      ['src', 10],
      ['dst', 12],
      ['epoch', 14],
      ['ttl', 16],
      ['port', 17],
    ]);
    expect(p.classes.find((c) => c.name === 'RESULT')).toMatchObject({ prefixSize: 7, kinds: 'capability' });
    expect(p.classes.find((c) => c.name === 'STATE')).toMatchObject({ prefixSize: 4, alwaysLatest: true });
    expect(p.extTlvs.find((t) => t.type === 0x81)).toMatchObject({ name: 'exec_at_us', critical: true });
  });

  it('agrees with the hand-written wire runtime constants', () => {
    const p = model().protocol;
    expect(Object.fromEntries(p.flags.map((f) => [f.name, f.mask]))).toEqual(FLAG);
    expect(Object.fromEntries(p.classes.map((c) => [c.name, c.code]))).toEqual(CLS);
    expect(p.header[0].value).toBe(MAGIC_VER);
    expect(p.headerSize).toBe(HEADER_SIZE);
    expect(p.classes.find((c) => c.name === 'EVENT')!.prefixSize).toBe(TIME_PREFIX_SIZE);
    expect(p.classes.find((c) => c.name === 'ACK')!.prefixSize).toBe(RESULT_PREFIX_SIZE);
    expect(p.serial.prefix).toBe(SERIAL_PREFIX);
    expect(p.serial.maxLine).toBe(SERIAL_MAX_LINE);
    expect(Object.fromEntries(p.serial.types.map((t) => [t.name, t.value]))).toEqual(SERIAL_TYPE);
    expect(p.serial.crc).toMatchObject({ poly: 0x1021, init: 0xffff, order: 'little-endian' });
    expect(Object.fromEntries(p.extTlvs.map((t) => [t.name.toUpperCase(), t.type]))).toEqual(EXT);
    expect(Object.fromEntries(p.extTlvs.map((t) => [t.type, { u8: 1, u16: 2, u32: 4 }[t.valueType]]))).toEqual(EXT_VALUE_SIZE);
  });

  it('nests protocol types: the descriptor holds an array of DescriptorCap (07 §7.4)', () => {
    const p = model().protocol;
    const desc = p.types.find((t) => t.name === 'Descriptor')!;
    const caps = desc.fields.find((f) => f.name === 'caps')!;
    expect(caps.type).toMatchObject({ kind: 'array', max: 16, element: { kind: 'struct', def: { name: 'DescriptorCap' } } });
    expect(desc.fields.find((f) => f.name === 'frame_version')).toMatchObject({ default: 1, presence: 'always' });
    // fr.node.describe returns it encoded, within the bulk reply.
    expect(desc.maxSize).toBeLessThanOrEqual(1200);
    const describe = cap(model(), 'fr.node').commands.find((c) => c.name === 'describe')!;
    expect(describe.result).toEqual([expect.objectContaining({ name: 'descriptor', type: { kind: 'bytes', max: 1200 } })]);
  });
});

describe('validation errors name the file and path', () => {
  const expectIssue = (issues: SchemaIssue[], file: string, path: string, message: RegExp) => {
    expect(issues).toContainEqual(expect.objectContaining({ file, path, message: expect.stringMatching(message) }));
  };

  it('duplicate member ids', () => {
    const issues = issuesOf(edited(BUTTON, (y) => (y.events.up.id = 1)));
    expectIssue(issues, BUTTON, 'events.up.id', /events id 1 is already used by 'down'/);
  });

  it('member ids outside 1..63', () => {
    const issues = issuesOf(
      edited(LED, (y) => {
        y.commands.stop.id = 64;
        y.properties.on.id = 0;
      }),
    );
    expectIssue(issues, LED, 'commands.stop.id', /outside 1\.\.63/);
    expectIssue(issues, LED, 'properties.on.id', /outside 1\.\.63/);
  });

  it('duplicate field ids', () => {
    const issues = issuesOf(edited(LED, (y) => (y.commands.blink.fields.count.id = 1)));
    expectIssue(issues, LED, 'commands.blink.fields.count.id', /field id 1 is already used by 'on_ms'/);
  });

  it('unknown types and misplaced max', () => {
    const issues = issuesOf(
      edited(BUTTON, (y) => {
        y.events.click.fields.count.type = 'u7';
        y.events.up.fields.held_ms.max = 3;
      }),
    );
    expectIssue(issues, BUTTON, 'events.click.fields.count.type', /unknown type 'u7'/);
    expectIssue(issues, BUTTON, 'events.up.fields.held_ms.max', /max applies only/);
  });

  it('capability ids missing from the registry or allocated to another name', () => {
    expectIssue(issuesOf(edited(BUTTON, (y) => (y.id = 0x000c))), BUTTON, 'id', /0x000C is not allocated in schema\/registry\.yaml/);
    expectIssue(issuesOf(edited(BUTTON, (y) => (y.id = 0x0002))), BUTTON, 'id', /allocates 0x0002 to fr\.led, not fr\.button/);
  });

  it('serial_bodies (design m2-c4-gateway D1)', () => {
    const issues = issuesOf(
      edited(PROTOCOL, (y) => {
        delete y.serial_bodies.GW_RSP;
        y.serial_bodies.ENV = { envelope: true };
        y.serial_bodies.GW_NOPE = { layout: [{ name: 't', type: 'u32' }] };
        y.serial_bodies.GW_TX.layout.push({ name: 'env', type: 'u8' }, { name: 'tx_id', type: 'u8' }, { name: 'speed', type: 'f32' });
        y.serial_bodies.GW_TX_DONE.layout[1].type = 'ChipId';
        y.serial_bodies.GW_CMD = { message: 'GwNope' };
        y.serial_bodies.GW_STATUS = { message: 'GwStatus', layout: [{ name: 't', type: 'u8' }] };
        y.serial_bodies.LINK_PING = { message: 'GwStatus', envelope: true };
      }),
    );
    expectIssue(issues, PROTOCOL, 'serial_bodies', /serial type GW_RSP has no body/);
    expectIssue(issues, PROTOCOL, 'serial_bodies.ENV', /ENV's body is an envelope/);
    expectIssue(issues, PROTOCOL, 'serial_bodies.GW_NOPE', /not a serial_framing type/);
    expectIssue(issues, PROTOCOL, 'serial_bodies.GW_TX.layout.3', /field name 'env' is taken/);
    expectIssue(issues, PROTOCOL, 'serial_bodies.GW_TX.layout.4', /field name 'tx_id' is taken/);
    expectIssue(issues, PROTOCOL, 'serial_bodies.GW_TX.layout.5.type', /unknown layout type 'f32'/);
    expectIssue(issues, PROTOCOL, 'serial_bodies.GW_CMD.message', /unknown protocol type 'GwNope'/);
    expectIssue(issues, PROTOCOL, 'serial_bodies.GW_STATUS', /exactly one of layout and message/);
    expectIssue(issues, PROTOCOL, 'serial_bodies.LINK_PING.envelope', /layout bodies only/);
    // A u8 enum is fine; one that needs a u16 is not (ChipId fits a u8, so widen it).
    const wide = issuesOf(
      edited(PROTOCOL, (y) => {
        y.enums.ChipId.esp32p4 = 300;
        y.serial_bodies.GW_TX_DONE.layout[1].type = 'ChipId';
      }),
    );
    expectIssue(wide, PROTOCOL, 'serial_bodies.GW_TX_DONE.layout.1.type', /does not fit the u8/);
    const named = issuesOf(edited(PROTOCOL, (y) => (y.types.GwRsp.type = { id: 7, type: 'u8' })));
    expectIssue(named, PROTOCOL, 'serial_bodies.GW_RSP.message', /GwRsp\.type: the frame objects use 'type'/);
  });

  it('the committed serial bodies: layouts, offsets and the protobuf types', () => {
    const b = model().protocol.serial.bodies;
    expect(b.map((x) => [x.name, x.kind, x.prefixSize, x.envelope, x.message?.name ?? null])).toEqual([
      ['GW_RX', 'layout', 12, true, null],
      ['GW_TX', 'layout', 9, true, null],
      ['GW_TX_DONE', 'layout', 8, false, null],
      ['GW_STATUS', 'message', 0, false, 'GwStatus'],
      ['GW_CMD', 'message', 0, false, 'GwCmd'],
      ['GW_RSP', 'message', 0, false, 'GwRsp'],
      ['LINK_PING', 'layout', 4, false, null],
      ['LINK_PONG', 'layout', 4, false, null],
    ]);
    expect(b[0].layout.map((f) => [f.name, f.type, f.offset])).toEqual([['src_mac', 'mac', 0], ['rssi', 'i8', 6], ['channel', 'u8', 7], ['rx_ts_us', 'u32', 8]]);
    expect(b[2].layout[1].enum?.name).toBe('GwTxStatus');
    // The gateway-era bodies stay inside the realtime budget (NET.NEIGHBORS 12 entries, OTA.CHUNK 187 data bytes).
    const msgs = model().protocol.messages;
    for (const k of ['NET.BEACON', 'NET.DISCOVER', 'NET.JOIN_REQ', 'NET.JOIN_ACCEPT', 'NET.CHANNEL_SWITCH', 'NET.NEIGHBORS', 'OTA.CHUNK', 'ACK.SACK']) {
      const m = msgs.find((x) => x.key === k)!;
      expect(m.realtime, k).toBe(true);
    }
    expect(msgs.find((x) => x.key === 'OTA.CHUNK')!.maxBody).toBe(200);
    expect(msgs.find((x) => x.key === 'NET.WELCOME')!.fields.find((f) => f.name === 'net_mode')!.typeName).toBe('NetMode');
    expect(model().protocol.extTlvs.find((t) => t.type === 0x82)).toEqual({ type: 0x82, name: 'exec_at_hub_us', valueType: 'u32', critical: true });
  });

  it('the realtime payload budget', () => {
    const big = issuesOf(edited(BUTTON, (y) => (y.events.down.fields = { note: { id: 1, type: 'string', max: 200 } })));
    expectIssue(big, BUTTON, 'events.down', /worst-case EVENT payload 207 B exceeds the 200 B realtime budget/);
    const fast = issuesOf(edited(LED, (y) => (y.commands.set.fields.label = { id: 4, type: 'bytes', max: 190 })));
    expectIssue(fast, LED, 'commands.set', /worst-case CMD payload 204 B/);
    // A normal-priority event may be larger.
    expect(buildModel(edited(BUTTON, (y) => (y.events.click.fields.note = { id: 2, type: 'string', max: 400 }))).ok).toBe(true);
  });

  it('defaults, ranges, requires and examples', () => {
    const issues = issuesOf(
      edited(LED, (y) => {
        y.commands.blink.fields.on_ms.default = 5;
        y.commands.blink.fields.count.range = [10, 2];
        y.properties.brightness.requires = { trait: 'dimable' };
        y.properties.color.requires.eq = 'cmyk';
        y.commands.set.examples = [{ on: 'yes', colour: 1 }];
      }),
    );
    expectIssue(issues, LED, 'commands.blink.fields.on_ms.default', /outside range \[10, 10000\]/);
    expectIssue(issues, LED, 'commands.blink.fields.count.range', /is empty/);
    expectIssue(issues, LED, 'properties.brightness.requires.trait', /unknown trait 'dimable'/);
    expectIssue(issues, LED, 'properties.color.requires.eq', /expected one of mono, rgb/);
    expectIssue(issues, LED, 'commands.set.examples.0.on', /expected a boolean/);
    expectIssue(issues, LED, 'commands.set.examples.0.colour', /'colour' is not a field of set/);
  });

  it('names that would collide in the generated class', () => {
    const issues = issuesOf(
      edited(LED, (y) => {
        y.commands.dispatch = { id: 9, delivery: 'reliable' };
        y.commands.on = { id: 10, delivery: 'reliable' };
      }),
    );
    expectIssue(issues, LED, 'commands.dispatch', /collides with a fr::cap::Capability method/);
    expectIssue(issues, LED, 'commands.on', /also a property/);
  });

  it('unknown keys and wrong shapes', () => {
    const issues = issuesOf(edited(BUTTON, (y) => (y.events.down.prioriy = 'realtime')));
    expectIssue(issues, BUTTON, 'events.down', /prioriy/);
    const shape = issuesOf(edited(LED, (y) => (y.commands.set.delivery = 'eventually')));
    expectIssue(shape, LED, 'commands.set.delivery', /fast|reliable/);
  });

  it('a capability in the wrong file', () => {
    const issues = issuesOf(edited(BUTTON, (y) => (y.capability = 'fr.knob')));
    expectIssue(issues, BUTTON, 'capability', /fr\.knob belongs in knob\.cap\.yaml/);
  });

  it('YAML syntax errors with a line number', () => {
    const src = readSchemaSources(ROOT);
    src.capabilities[0].text += '\nbroken: [\n';
    const issues = issuesOf(src);
    expect(issues[0].file).toBe(src.capabilities[0].path);
    expect(issues[0].message).toMatch(/^YAML line \d+:\d+/);
  });

  it('protocol messages, kinds and struct use', () => {
    const issues = issuesOf(
      edited(PROTOCOL, (y) => {
        y.messages['PRESENCE.HELOO'] = { t: { id: 1, type: 'u8' } };
        y.messages['EVENT.DOWN'] = {};
        y.messages['NET.RESOLVE'].entry = { id: 2, type: 'DirectoryEntry' };
        y.ext_tlv[0x05] = { name: 'oops', type: 'u8', critical: true };
      }),
    );
    expectIssue(issues, PROTOCOL, 'messages.PRESENCE.HELOO', /unknown kind HELOO of PRESENCE/);
    expectIssue(issues, PROTOCOL, 'messages.EVENT.DOWN', /capability members/);
    expectIssue(issues, PROTOCOL, 'messages.NET.RESOLVE.entry.type', /only be used as an array element/);
    expectIssue(issues, PROTOCOL, 'ext_tlv.5', /critical/);
  });

  it('protocol types hold only types declared above them (no recursion)', () => {
    const issues = issuesOf(
      edited(PROTOCOL, (y) => {
        y.types.DirectoryEntry.later = { id: 3, type: 'array<Descriptor>', max: 2 };
        y.types.Descriptor.again = { id: 7, type: 'array<Descriptor>', max: 2 };
      }),
    );
    expectIssue(issues, PROTOCOL, 'types.DirectoryEntry.later.type', /unknown array element type 'Descriptor'/);
    expectIssue(issues, PROTOCOL, 'types.Descriptor.again.type', /unknown array element type 'Descriptor'/);
  });

  it('loadModel throws a SchemaError listing every problem', () => {
    const r = buildModel(edited(BUTTON, (y) => (y.events.up.id = 1)));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const err = new SchemaError(r.issues);
      expect(err.message).toContain('schema/capabilities/button.cap.yaml: events.up.id:');
    }
  });
});

describe('catalog', () => {
  it('serialises canonically', () => {
    expect(canonicalJson({ b: 1, a: [{ d: true, c: null }], e: undefined, f: 'x' })).toBe('{"a":[{"c":null,"d":true}],"b":1,"f":"x"}');
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
  });

  it('hashes deterministically, independent of YAML key order', () => {
    const m = model();
    const h = catalogHash(m);
    expect(h).toBe(catalogHash(model()));
    expect(Number.isInteger(h) && h >= 0 && h <= 0xffffffff).toBe(true);
    const reordered = buildModel(
      edited(LED, (y) => {
        const { stop, blink, toggle, set } = y.commands;
        y.commands = { stop, blink, toggle, set };
        const { summary, id, capability, ...rest } = y;
        for (const k of Object.keys(y)) {
          delete y[k];
        }
        Object.assign(y, rest, { summary, capability, id });
      }),
    );
    expect(reordered.ok && catalogHash(reordered.model)).toBe(h);
    const changed = buildModel(edited(LED, (y) => (y.commands.stop.id = 5)));
    expect(changed.ok && catalogHash(changed.model)).not.toBe(h);
  });

  it('describes members as agents need them', () => {
    const led = (buildCatalog(model()).capabilities as any[]).find((c) => c.name === 'fr.led');
    expect(led.types).toEqual({ ColorMode: { mono: 0, rgb: 1 }, Effect: { none: 0, blink: 1 } });
    expect(led.commands.find((c: any) => c.name === 'blink').fields[0]).toEqual({
      name: 'on_ms',
      id: 1,
      type: 'u16',
      default: 200,
      range: [10, 10000],
      unit: 'ms',
    });
    const exec = (buildCatalog(model()).capabilities as any[]).find((c) => c.name === 'fr.diag').commands[0];
    expect(exec.result).toEqual([{ name: 'json', id: 1, type: 'string', max: 1400 }]);
  });
});

describe('test_only capabilities (design m2-c1-hil D3)', () => {
  const FIXTURE = 'schema/capabilities/fixture.cap.yaml';

  it('keeps fr.fixture in the model and out of the catalog and its hash', () => {
    const m = model();
    expect(cap(m, 'fr.fixture')).toMatchObject({ id: 0x0006, section: 'standard', testOnly: true });
    expect(m.capabilities.filter((c) => c.testOnly).map((c) => c.name)).toEqual(['fr.fixture']);
    expect(appCapabilities(m).map((c) => c.name)).not.toContain('fr.fixture');
    expect((buildCatalog(m).capabilities as any[]).map((c) => c.name)).toEqual(appCapabilities(m).map((c) => c.name));
    // Without the fixture's YAML the catalog and catalog_hash are the same: a test_only capability never moves them.
    const src = readSchemaSources(ROOT);
    src.capabilities = src.capabilities.filter((c) => c.path !== FIXTURE);
    const without = buildModel(src);
    expect(without.ok && catalogHash(without.model)).toBe(catalogHash(m));
    // Dropping the flag puts it into the catalog.
    const shown = buildModel(edited(FIXTURE, (y) => delete y.test_only));
    expect(shown.ok && (buildCatalog(shown.model).capabilities as any[]).some((c) => c.name === 'fr.fixture')).toBe(true);
    expect(shown.ok && catalogHash(shown.model)).not.toBe(catalogHash(m));
  });

  it('refuses test_only on a system capability, and a flag that is not a boolean', () => {
    expect(issuesOf(edited('schema/capabilities/diag.cap.yaml', (y) => (y.test_only = true)))).toEqual([
      { file: 'schema/capabilities/diag.cap.yaml', path: 'test_only', message: 'fr.diag is a system capability (0x00F2); only standard and project capabilities may be test_only' },
    ]);
    expect(issuesOf(edited(FIXTURE, (y) => (y.test_only = 'yes'))).map((i) => i.path)).toEqual(['test_only']);
  });
});

describe('ordered capabilities (design m2-c3-inputs D8)', () => {
  const BUTTON = 'schema/capabilities/button.cap.yaml';

  it('fr.button is ordered, every other capability not; the catalog says so and its hash follows', () => {
    const m = model();
    expect(m.capabilities.filter((c) => c.ordered).map((c) => c.name)).toEqual(['fr.button']);
    expect((buildCatalog(m).capabilities as any[]).find((c) => c.name === 'fr.button').ordered).toBe(true);
    expect((buildCatalog(m).capabilities as any[]).find((c) => c.name === 'fr.led')).not.toHaveProperty('ordered');
    const unordered = buildModel(edited(BUTTON, (y) => delete y.ordered));
    expect(unordered.ok && unordered.model.capabilities.find((c) => c.name === 'fr.button')?.ordered).toBe(false);
    expect(unordered.ok && catalogHash(unordered.model)).not.toBe(catalogHash(m));
  });

  it('refuses ordered on a capability without events, and a flag that is not a boolean', () => {
    expect(issuesOf(edited('schema/capabilities/ota.cap.yaml', (y) => (y.ordered = true)))).toEqual([
      { file: 'schema/capabilities/ota.cap.yaml', path: 'ordered', message: "fr.ota has no events; ordered applies to a capability's events" },
    ]);
    expect(issuesOf(edited(BUTTON, (y) => (y.ordered = 'yes'))).map((i) => i.path)).toEqual(['ordered']);
  });

  it('knows EXT port_seq: a non-critical u16 at 0x05', () => {
    expect(model().protocol.extTlvs.find((t) => t.name === 'port_seq')).toEqual({ type: 0x05, name: 'port_seq', valueType: 'u16', critical: false });
  });
});

describe('names', () => {
  it('lists reserved instance names (spec 03 §3.6)', () => {
    for (const n of ['node', 'ota', 'diag', 'hub', 'registry', 'on', 'state', 'has']) {
      expect(isReservedInstanceName(n)).toBe(true);
    }
    expect(isReservedInstanceName('boot')).toBe(false);
    expect(new Set(RESERVED_INSTANCE_NAMES).size).toBe(RESERVED_INSTANCE_NAMES.length);
  });

  it('maps identifiers for C++', () => {
    expect(pascalCase('analog_in')).toBe('AnalogIn');
    expect(cppIdent('new')).toBe('new_');
    expect(cppIdent('click')).toBe('click');
    expect(model().protocol.enums.find((e) => e.name === 'OtaState')!.members.map((m) => m.name)).toContain('new');
  });
});

// ---- M2-C5: fr.display, fr.touch, message types and bulk commands (design m2-c5-display D1, D2, D4) ----

const DISPLAY = 'schema/capabilities/display.cap.yaml';

describe('capability message types and bulk commands (design m2-c5-display D1, D2)', () => {
  const expectIssue = (issues: SchemaIssue[], file: string, path: string, message: RegExp) => {
    expect(issues).toContainEqual(expect.objectContaining({ file, path, message: expect.stringMatching(message) }));
  };

  it('fr.display: UiWidget, then UiLayout holding array<UiWidget> of 24, which ui_load holds directly', () => {
    const d = cap(model(), 'fr.display');
    expect(d).toMatchObject({ id: 0x0003, section: 'standard', version: { major: 1, minor: 0 }, ordered: false });
    expect(d.types.map((t) => [t.name, t.scope])).toEqual([
      ['UiWidget', 'fr.display'],
      ['UiLayout', 'fr.display'],
    ]);
    const [widget, layout] = d.types;
    expect(widget.fields.map((f) => f.name)).toEqual(['id', 'kind', 'x', 'y', 'w', 'h', 'text', 'value', 'min', 'max', 'color', 'bg', 'font', 'align']);
    expect(widget.maxSize).toBe(120);
    expect(layout.fields[1].type).toMatchObject({ kind: 'array', max: 24, element: { kind: 'struct', def: { name: 'UiWidget' } } });
    expect(layout.maxSize).toBe(6 + 24 * (1 + 1 + 120));
    const load = d.commands.find((c) => c.name === 'ui_load')!;
    expect(load.fields).toEqual([expect.objectContaining({ name: 'layout', presence: 'always', type: { kind: 'struct', def: layout } })]);
    // BULK: the worst case is far over the realtime budget (and over one BULK frame: a layout must fit one).
    expect(load).toMatchObject({ delivery: 'reliable', bulk: true, realtime: false, maxArgs: 1 + 2 + layout.maxSize });
    expect(load.maxArgs).toBeGreaterThan(200);
    expect(d.commands.filter((c) => c.bulk).map((c) => c.name)).toEqual(['ui_load', 'snapshot', 'snapshot_read']);
    expect(d.commands.filter((c) => c.visibility === 'test').map((c) => c.name)).toEqual(['snapshot', 'snapshot_read']);
    expect(d.commands.map((c) => [c.name, c.id])).toEqual([
      ['clear', 1],
      ['text', 2],
      ['fill_rect', 3],
      ['set_brightness', 4],
      ['ui_load', 5],
      ['ui_set', 6],
      ['snapshot', 7],
      ['snapshot_read', 8],
    ]);
    expect(d.traits.map((t) => t.name)).toEqual(['width', 'height', 'color', 'ui', 'touch']);
    expect(d.events).toEqual([expect.objectContaining({ name: 'ui', priority: 'normal', requires: { trait: 'ui' } })]);
    expect(d.properties.map((p) => p.name)).toEqual(['brightness']);
    // Every other command still fits the realtime budget.
    expect(d.commands.filter((c) => c.name !== 'ui_load').every((c) => c.maxArgs <= 200)).toBe(true);
    // The only other bulk command is fr.camera's sd_list (design camera-c1 D7: a page of 64 recordings, over one realtime frame).
    expect(model().capabilities.filter((c) => c.name !== 'fr.display').flatMap((c) => c.commands.filter((x) => x.bulk).map((x) => `${c.name}.${x.name}`))).toEqual(['fr.camera.sd_list']);
  });

  it('fr.touch is 0x0008; its down and up are realtime', () => {
    const m = model();
    const t = cap(m, 'fr.touch');
    expect(t).toMatchObject({ id: 0x0008, section: 'standard' });
    expect(t.events.map((e) => [e.name, e.priority])).toEqual([
      ['down', 'realtime'],
      ['up', 'realtime'],
      ['gesture', 'normal'],
    ]);
    expect(t.traits.map((x) => x.name)).toEqual(['width', 'height', 'display']);
    expect(t.config.map((x) => x.name)).toEqual(['display']);
    expect(t.commands).toEqual([expect.objectContaining({ name: 'inject', visibility: 'test', delivery: 'reliable', bulk: false })]);
    expect(t.enums[0].members.map((x) => x.name)).toEqual(['tap', 'long_press', 'swipe_up', 'swipe_down', 'swipe_left', 'swipe_right']);
  });

  it('checks an example against the message type it holds', () => {
    const issues = issuesOf(
      edited(DISPLAY, (y) => {
        y.commands.ui_load.examples = [{ layout: { bg: 0, widgets: [{ kind: 'dial' }] } }, { layout: { nope: 1 } }, { layout: 3 }];
      }),
    );
    expectIssue(issues, DISPLAY, 'commands.ui_load.examples.0.layout', /widgets: element: kind: expected one of label, .* \(UiWidgetKind\), got "dial"/);
    expectIssue(issues, DISPLAY, 'commands.ui_load.examples.1.layout', /'nope' is not a field of UiLayout/);
    expectIssue(issues, DISPLAY, 'commands.ui_load.examples.2.layout', /expected a UiLayout object, got 3/);
  });

  it('refuses message types in traits, config and properties, an optional or defaulted message field, a later type, and bulk on a fast command', () => {
    const issues = issuesOf(
      edited(DISPLAY, (y) => {
        y.traits.layout = { id: 6, type: 'UiLayout' };
        y.config.widgets = { type: 'array<UiWidget>', max: 2 };
        y.properties.screen = { id: 2, type: 'UiLayout' };
        y.commands.ui_load.fields.layout.optional = true;
        y.commands.ui_set.fields.widget = { id: 7, type: 'UiWidget', default: 1 };
        y.types.UiWidget.fields.inner = { id: 15, type: 'UiLayout' };
        y.types.lower = { fields: { a: { id: 1, type: 'u8' } } };
        y.types.Empty = { fields: {} };
        y.commands.clear.delivery = 'fast';
        y.commands.clear.bulk = true;
      }),
    );
    expectIssue(issues, DISPLAY, 'traits.layout.type', /a trait cannot hold message type 'UiLayout'/);
    expectIssue(issues, DISPLAY, 'config.widgets.type', /a config entry cannot hold message type 'UiWidget'/);
    expectIssue(issues, DISPLAY, 'properties.screen.type', /a property cannot hold message type 'UiLayout'/);
    expectIssue(issues, DISPLAY, 'commands.ui_load.fields.layout.optional', /a UiLayout field cannot be optional/);
    expectIssue(issues, DISPLAY, 'commands.ui_set.fields.widget.default', /struct fields cannot have a default/);
    expectIssue(issues, DISPLAY, 'types.UiWidget.fields.inner.type', /unknown type 'UiLayout'/);
    expectIssue(issues, DISPLAY, 'types.lower', /type name 'lower' must be PascalCase/);
    expectIssue(issues, DISPLAY, 'types.Empty.fields', /a message type needs at least one field/);
    expectIssue(issues, DISPLAY, 'commands.clear.bulk', /a bulk command is delivery: reliable/);
  });

  it('protocol.yaml keeps its rule: a protocol type is an array element only', () => {
    const issues = issuesOf(edited(PROTOCOL, (y) => (y.types.Descriptor.one = { id: 7, type: 'DescriptorCap' })));
    expectIssue(issues, PROTOCOL, 'types.Descriptor.one.type', /may only be used as an array element/);
  });

  it('the catalog carries the message types and bulk', () => {
    const c = buildCatalog(model()).capabilities as Yaml[];
    const d = c.find((x) => x.name === 'fr.display')!;
    expect(Object.keys(d.messages)).toEqual(['UiWidget', 'UiLayout']);
    expect(d.messages.UiLayout.fields).toEqual([
      { name: 'bg', id: 1, type: 'rgb', doc: 'screen background' },
      { name: 'widgets', id: 2, type: 'array<UiWidget>', max: 24 },
    ]);
    const load = d.commands.find((x: Yaml) => x.name === 'ui_load');
    expect(load).toMatchObject({ bulk: true, fields: [{ name: 'layout', id: 1, type: 'UiLayout' }] });
    expect(d.commands.find((x: Yaml) => x.name === 'clear').bulk).toBeUndefined();
    // A capability without message types has no `messages` key, so its catalog entry is as before.
    expect(c.find((x) => x.name === 'fr.led')!.messages).toBeUndefined();
  });
});

describe('audio (design audio-a1 D1, D2)', () => {
  it('fr.audio_in is 0x0007 1.1: level, streaming and monitoring, stream_ended and monitor_ended, five reliable commands', () => {
    const a = cap(model(), 'fr.audio_in');
    // 1.0 (A1), 1.1 (design audio-a2 D3: the on-board monitor, additive).
    expect(a).toMatchObject({ id: 0x0007, section: 'standard', version: { major: 1, minor: 1 }, testOnly: false });
    expect(a.traits.map((t) => [t.name, t.typeName])).toEqual([
      ['max_sample_hz', 'u32'],
      ['bits', 'u8'],
    ]);
    expect(a.config.map((e) => [e.name, e.default])).toEqual([
      ['sample_hz', 16000],
      ['gain_db', 12],
      ['hpf_hz', 20],
      ['level_hz', 5],
    ]);
    expect(a.properties.map((p) => [p.name, p.typeName])).toEqual([
      ['level', 'i16'],
      ['streaming', 'bool'],
      ['monitoring', 'bool'],
    ]);
    expect(a.events.map((e) => [e.name, e.id, e.priority, e.fields.map((f) => f.name)])).toEqual([
      ['stream_ended', 1, 'normal', ['stream_id', 'reason', 'samples', 'dropped_samples']],
      ['monitor_ended', 2, 'normal', ['reason', 'to_port', 'samples']],
    ]);
    expect(a.commands.map((c) => [c.name, c.id, c.delivery, c.bulk])).toEqual([
      ['stream_start', 1, 'reliable', false],
      ['stream_stop', 2, 'reliable', false],
      ['level_get', 3, 'reliable', false],
      ['monitor_start', 4, 'reliable', false],
      ['monitor_stop', 5, 'reliable', false],
    ]);
    expect(a.commands.find((c) => c.name === 'monitor_start')!.fields.map((f) => [f.name, f.typeName])).toEqual([
      ['to_port', 'u8'],
      ['seconds', 'u16'],
      ['volume', 'u8'],
    ]);
    expect(a.enums.map((e) => [e.name, e.members.map((x) => x.name)])).toEqual([
      ['StreamEndReason', ['stopped', 'done', 'net_lost', 'overflow', 'error']],
      ['MonitorEndReason', ['stopped', 'done', 'busy', 'error']],
    ]);
  });

  it('fr.audio_out is 0x0004 1.0: tone, play, stop, set_volume and play_done', () => {
    const a = cap(model(), 'fr.audio_out');
    expect(a).toMatchObject({ id: 0x0004, section: 'standard', version: { major: 1, minor: 0 } });
    expect(a.config.map((e) => [e.name, e.default])).toEqual([
      ['volume', 60],
      ['sample_hz', 16000],
    ]);
    expect(a.properties.map((p) => p.name)).toEqual(['playing', 'volume']);
    expect(a.events.map((e) => [e.name, e.priority])).toEqual([['play_done', 'normal']]);
    expect(a.commands.map((c) => [c.name, c.id, c.delivery, c.idempotent])).toEqual([
      ['tone', 1, 'reliable', false],
      ['play', 2, 'reliable', false],
      ['stop', 3, 'reliable', true],
      ['set_volume', 4, 'reliable', true],
    ]);
    // Every audio command fits the realtime budget: PCM never travels on the hub link (D3).
    expect(a.commands.every((c) => c.maxArgs <= 200)).toBe(true);
  });
});
