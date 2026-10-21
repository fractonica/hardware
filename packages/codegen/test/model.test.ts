import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';

import {
  CLS,
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
      [0x0005, 'fr.analog_in', 'AnalogIn', 'standard'],
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
    expectIssue(issuesOf(edited(BUTTON, (y) => (y.id = 0x0009))), BUTTON, 'id', /0x0009 is not allocated in schema\/registry\.yaml/);
    expectIssue(issuesOf(edited(BUTTON, (y) => (y.id = 0x0002))), BUTTON, 'id', /allocates 0x0002 to fr\.led, not fr\.button/);
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
