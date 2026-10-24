// SDK emitter for `fr gen` (design c6 §4.1, spec 07 §7.6 and §7.9): packages/sdk/src/gen/caps.ts, the typed
// facades of @fractonica/sdk. Per capability a client (its public commands as camelCase methods), its events
// (wire name -> camelCase fields) and its property state, gathered in CapClients, CapEvents and CapState keyed
// by capability name; CAP_META (delivery, method and member names) drives the runtime, and CATALOG_HASH is what
// an app's hello carries. Types follow the JSON form the hub speaks on `/app`: bytes as hex, u64 as a decimal
// string, enums by member name. The SDK has no dependencies, so this file imports only the SDK's own types.
//
// The SDK maps names with one generic rule (snake_case on the wire, camelCase in apps; packages/sdk/src/
// case.ts), so the emitter refuses a name that does not survive the round trip or that collides once
// camelCased, a capability field named like an event's own keys, and an event and a property sharing a name
// (both are `<inst>.<name>` events, 09 §9.2).

import { appCapabilities, pascalCase, type Capability, type ElementType, type EnumDef, type Field, type GeneratedFile, type Model, type TypeRef } from '../model.ts';

export const SDK_GEN_DIR = 'packages/sdk/src/gen';

/** Keys every SDK event object has (packages/sdk/src/types.ts DeviceEvent): an event field may not use one. */
export const SDK_EVENT_KEYS: readonly string[] = ['type', 'part', 'device', 'inst', 'tDevUs', 'tHubUs', 'late', 'epoch', 'cursor', 'replayed'];

/** Members of an SDK instance object (packages/sdk/src/devices.ts): a command method may not use one. */
export const SDK_INSTANCE_KEYS: readonly string[] = ['name', 'cap', 'port', 'v', 'traits', 'state', 'device'];

/** snake_case -> camelCase, as packages/sdk/src/case.ts maps names at runtime. */
export function sdkCamel(snake: string): string {
  return snake.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** camelCase -> snake_case, the runtime's way back (args to the wire). */
export function sdkSnake(camel: string): string {
  return camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

// ---- code builder ----

class Code {
  private readonly out: string[] = [];
  private depth = 0;

  line(s = ''): this {
    this.out.push(s === '' ? '' : '  '.repeat(this.depth) + s);
    return this;
  }

  open(s: string): this {
    this.line(s);
    this.depth++;
    return this;
  }

  close(s = '}'): this {
    this.depth--;
    this.line(s);
    return this;
  }

  toString(): string {
    return `${this.out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
  }
}

/** Single-quoted JS string literal. */
function q(s: string): string {
  return `'${JSON.stringify(s).slice(1, -1).replace(/\\"/g, '"').replace(/'/g, "\\'")}'`;
}

/** A property key: bare when it is an identifier, quoted otherwise (`'fr.led'`). */
function key(s: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s) ? s : q(s);
}

function doc(c: Code, text: string | undefined): void {
  const t = text?.trim().replace(/\s+/g, ' ').replace(/\*\//g, '*\\/');
  if (t) {
    c.line(`/** ${t} */`);
  }
}

function fieldDoc(f: Field): string | undefined {
  const facts: string[] = [];
  if (f.unit) {
    facts.push(f.unit);
  }
  if (f.range) {
    facts.push(`${f.range[0]}..${f.range[1]}`);
  }
  if (f.type.kind === 'string' || f.type.kind === 'bytes' || f.type.kind === 'array') {
    facts.push(f.type.kind === 'string' ? `<= ${f.type.max} UTF-8 bytes` : f.type.kind === 'bytes' ? `hex, <= ${f.type.max} bytes` : `<= ${f.type.max} items`);
  }
  if (f.type.kind === 'scalar' && f.type.name === 'u64') {
    facts.push('decimal string');
  }
  if (f.type.kind === 'scalar' && f.type.name === 'duration_ms' && !f.unit) {
    facts.push('ms');
  }
  if (f.type.kind === 'scalar' && f.type.name === 'rgb') {
    facts.push('0xRRGGBB');
  }
  if (f.default !== undefined) {
    facts.push(`default ${typeof f.default === 'string' ? f.default : JSON.stringify(f.default)}`);
  }
  const text = [f.doc?.trim().replace(/\s+/g, ' '), facts.length > 0 ? `(${facts.join('; ')})` : ''].filter((s) => s).join(' ');
  return text || undefined;
}

// ---- names ----

/** Generated identifiers; a second claim of one fails generation (as emitTs does). */
class Names {
  private readonly owners = new Map<string, string>();

  claim(name: string, owner: string): string {
    const prev = this.owners.get(name);
    if (prev !== undefined) {
      throw new Error(`SDK type ${name} (${owner}) collides with ${prev}`);
    }
    this.owners.set(name, owner);
    return name;
  }
}

/**
 * Checks that every name maps to a distinct camelCase name that maps back (the runtime converts both ways
 * by rule, not by table), and returns the camelCase names.
 */
function camelNames(names: readonly string[], where: string): string[] {
  const seen = new Map<string, string>();
  return names.map((n) => {
    const c = sdkCamel(n);
    if (sdkSnake(c) !== n) {
      throw new Error(`${where}: ${n} does not survive the SDK's snake_case <-> camelCase mapping (${n} -> ${c} -> ${sdkSnake(c)}); rename it`);
    }
    const prev = seen.get(c);
    if (prev !== undefined) {
      throw new Error(`${where}: ${n} and ${prev} are both ${c} in the SDK`);
    }
    seen.set(c, n);
    return c;
  });
}

// ---- types ----

type Dir = 'in' | 'out';

interface Ctx {
  enumName(def: EnumDef): string;
}

function tsType(t: TypeRef | ElementType, dir: Dir, ctx: Ctx, where: string): string {
  switch (t.kind) {
    case 'scalar':
      // The JSON form: u64 is a decimal string (the hub also takes a number in args).
      return t.name === 'bool' ? 'boolean' : t.name === 'u64' ? (dir === 'in' ? 'number | string' : 'string') : 'number';
    case 'enum':
      // Enums are open on the wire: a value the schema does not name arrives as its number.
      return dir === 'in' ? ctx.enumName(t.def) : `${ctx.enumName(t.def)} | number`;
    case 'string':
    case 'bytes':
      return 'string';
    case 'struct':
      return objectType(t.def.fields, dir, ctx, `${where}.${t.def.name}`);
    case 'array': {
      const el = tsType(t.element, dir, ctx, where);
      const inner = /[|&]/.test(el) && !el.startsWith('{') ? `(${el})` : el;
      return dir === 'in' ? `readonly ${inner}[]` : `${inner}[]`;
    }
  }
}

/** An inline object type: args are all optional (as their JSON Schemas); results and events as decoded. */
function objectType(fields: readonly Field[], dir: Dir, ctx: Ctx, where: string): string {
  if (fields.length === 0) {
    return '{}';
  }
  const camel = camelNames(
    fields.map((f) => f.name),
    where,
  );
  const parts = fields.map((f, i) => `${camel[i]}${dir === 'in' || f.optional ? '?' : ''}: ${tsType(f.type, dir, ctx, where)}`);
  return `{ ${parts.join('; ')} }`;
}

/** An interface of fields, one documented member per line. */
function emitFields(c: Code, name: string, about: string, fields: readonly Field[], dir: Dir, ctx: Ctx, where: string): void {
  const camel = camelNames(
    fields.map((f) => f.name),
    where,
  );
  doc(c, about);
  if (fields.length === 0) {
    c.line(`export interface ${name} {}`);
    c.line();
    return;
  }
  c.open(`export interface ${name} {`);
  for (const [i, f] of fields.entries()) {
    doc(c, fieldDoc(f));
    c.line(`${camel[i]}${dir === 'in' || f.optional ? '?' : ''}: ${tsType(f.type, dir, ctx, `${where}.${f.name}`)};`);
  }
  c.close();
  c.line();
}

function header(): string {
  return [
    '// GENERATED by fr gen from schema/capabilities/*.cap.yaml. Do not edit; run `fr gen`.',
    '// Typed facades of @fractonica/sdk (design c6 §4.1): per capability its client (public commands as camelCase',
    '// methods), events and property state, keyed by capability name in CapClients, CapEvents and CapState;',
    '// CAP_META drives the runtime. Names are camelCase here and snake_case on the wire (`/app`, fr-app/1).',
  ].join('\n');
}

/** Checks a capability's member names against the SDK's rules (see the file comment). */
function checkCap(cap: Capability): void {
  const where = cap.file;
  camelNames(
    cap.commands.map((x) => x.name),
    `${where}: commands`,
  );
  camelNames(
    cap.properties.map((x) => x.name),
    `${where}: properties`,
  );
  for (const cmd of cap.commands) {
    if (SDK_INSTANCE_KEYS.includes(sdkCamel(cmd.name))) {
      throw new Error(`${where}: command ${cmd.name} would hide the SDK instance member ${sdkCamel(cmd.name)} (${SDK_INSTANCE_KEYS.join(', ')})`);
    }
  }
  for (const ev of cap.events) {
    if (cap.properties.some((p) => p.name === ev.name)) {
      throw new Error(`${where}: event ${ev.name} and property ${ev.name} would both be the SDK event ${'<inst>'}.${ev.name}`);
    }
    for (const f of ev.fields) {
      if (SDK_EVENT_KEYS.includes(sdkCamel(f.name))) {
        throw new Error(`${where}: events.${ev.name} field ${f.name} is ${sdkCamel(f.name)}, a key every SDK event has (${SDK_EVENT_KEYS.join(', ')})`);
      }
    }
  }
}

/**
 * The SDK's typed facades: packages/sdk/src/gen/caps.ts. Throws on a name the SDK cannot carry. A test_only
 * capability (fr.fixture, design m2-c1-hil D3) is left out: the client SDK never exposes a test instrument.
 */
export function emitSdk(model: Model, catalogHash: number): GeneratedFile[] {
  const caps = appCapabilities(model);
  const names = new Names();
  const enumNames = new Map<EnumDef, string>();
  for (const cap of caps) {
    for (const e of cap.enums) {
      enumNames.set(e, names.claim(`${cap.pascalName}${e.name}`, `${cap.file} types.${e.name}`));
    }
  }
  const ctx: Ctx = {
    enumName(def) {
      let n = enumNames.get(def);
      if (n === undefined) {
        n = names.claim(def.name, `enum ${def.scope}.${def.name}`);
        enumNames.set(def, n);
      }
      return n;
    },
  };

  const c = new Code();
  for (const l of header().split('\n')) {
    c.line(l);
  }
  c.line();
  c.line("import type { CallOptions, CapMeta, CmdResult, Sent } from '../types.ts';");
  c.line();
  c.line('/** FNV-1a 32 of the canonical catalog JSON (the hub\'s CATALOG_HASH): what an app\'s hello says it was built against. */');
  c.line(`export const CATALOG_HASH = 0x${catalogHash.toString(16).padStart(8, '0')};`);
  c.line();

  const clients: [string, string][] = [];
  const events: [string, string][] = [];
  const states: [string, string][] = [];
  const props: [string, string][] = [];
  const meta: string[] = [];

  for (const cap of caps) {
    checkCap(cap);
    const P = cap.pascalName;
    c.line(`// ---- ${cap.name} ----`);
    c.line();
    for (const e of cap.enums) {
      c.line(`export type ${enumNames.get(e)} = ${e.members.map((m) => q(m.name)).join(' | ')};`);
      c.line();
    }

    // Commands: args and results as interfaces, then the client.
    const methods: { doc: string; sig: string }[] = [];
    const publicCmds = cap.commands.filter((x) => x.visibility === 'public');
    for (const cmd of publicCmds) {
      const C = `${P}${pascalCase(cmd.name)}`;
      const where = `${cap.file}: commands.${cmd.name}`;
      let args = '';
      if (cmd.fields.length > 0) {
        const n = names.claim(`${C}Args`, where);
        emitFields(c, n, `${cap.name}.${cmd.name} arguments (all optional: the device applies the defaults).`, cmd.fields, 'in', ctx, `${where}.fields`);
        args = `args?: ${n}`;
      }
      const method = sdkCamel(cmd.name);
      const about = (text: string) => [cmd.doc?.trim(), text].filter(Boolean).join(' ');
      if (cmd.delivery === 'fast') {
        methods.push({ doc: about('Fast: resolves once sent (latest wins under back-pressure).'), sig: `${method}(${args}): Promise<Sent>;` });
      } else {
        let result = 'CmdResult';
        if (cmd.result !== null) {
          const n = names.claim(`${C}Result`, `${where}.result`);
          emitFields(c, n, `${cap.name}.${cmd.name} RESULT fields.`, cmd.result, 'out', ctx, `${where}.result`);
          result = `CmdResult<${n}>`;
        }
        methods.push({
          doc: about('Reliable: resolves on the RESULT ok, rejects with CommandError otherwise.'),
          sig: `${method}(${args ? `${args}, ` : ''}opts?: CallOptions): Promise<${result}>;`,
        });
      }
    }
    const client = names.claim(`${P}Client`, cap.file);
    doc(c, `${cap.name} commands, as methods of an instance.`);
    if (methods.length === 0) {
      c.line(`export interface ${client} {}`);
    } else {
      c.open(`export interface ${client} {`);
      for (const m of methods) {
        doc(c, m.doc);
        c.line(m.sig);
      }
      c.close();
    }
    c.line();

    // Events: wire name -> camelCase fields.
    const evs = names.claim(`${P}Events`, cap.file);
    const evRows: string[] = [];
    for (const ev of cap.events) {
      const n = names.claim(`${P}${pascalCase(ev.name)}Fields`, `${cap.file} events.${ev.name}`);
      emitFields(
        c,
        n,
        `${cap.name}.${ev.name} event fields (${ev.priority}${ev.requires ? `; with trait ${ev.requires.trait}` : ''}).${ev.doc ? ` ${ev.doc.trim()}` : ''}`,
        ev.fields,
        'out',
        ctx,
        `${cap.file}: events.${ev.name}.fields`,
      );
      evRows.push(`${key(ev.name)}: ${n};`);
    }
    doc(c, `${cap.name} events by wire name: \`pad.on('<inst>.<event>', e => ...)\`.`);
    if (evRows.length === 0) {
      c.line(`export interface ${evs} {}`);
    } else {
      c.open(`export interface ${evs} {`);
      for (const r of evRows) {
        c.line(r);
      }
      c.close();
    }
    c.line();

    // Property state: camelCase, trait-gated ones optional.
    const st = names.claim(`${P}State`, cap.file);
    doc(c, `${cap.name} properties as the mirror holds them (\`pad.<inst>.state\`); a property a trait gates may be absent.`);
    if (cap.properties.length === 0) {
      c.line(`export interface ${st} {}`);
    } else {
      const camel = camelNames(
        cap.properties.map((p) => p.name),
        `${cap.file}: properties`,
      );
      c.open(`export interface ${st} {`);
      for (const [i, p] of cap.properties.entries()) {
        doc(c, [p.doc?.trim(), p.unit ? `(${p.unit})` : '', p.requires ? `(trait ${p.requires.trait}${p.requires.eq !== undefined ? ` = ${String(p.requires.eq)}` : ''})` : ''].filter(Boolean).join(' '));
        c.line(`${camel[i]}${p.requires ? '?' : ''}: ${tsType(p.type, 'out', ctx, `${cap.file}: properties.${p.name}`)};`);
      }
      c.close();
    }
    c.line();

    // The same properties by wire name: the `<inst>.<prop>` events (`pad.on('boot.pressed', e => e.value)`).
    const pr = names.claim(`${P}Props`, cap.file);
    doc(c, `${cap.name} property values by wire name: what a \`<inst>.<prop>\` event carries as \`value\`.`);
    if (cap.properties.length === 0) {
      c.line(`export interface ${pr} {}`);
    } else {
      c.open(`export interface ${pr} {`);
      for (const p of cap.properties) {
        c.line(`${key(p.name)}: ${tsType(p.type, 'out', ctx, `${cap.file}: properties.${p.name}`)};`);
      }
      c.close();
    }
    c.line();

    clients.push([cap.name, client]);
    props.push([cap.name, pr]);
    events.push([cap.name, evs]);
    states.push([cap.name, st]);
    const cmdMeta = cap.commands.map(
      (x) => `${key(x.name)}: { method: ${q(sdkCamel(x.name))}, delivery: '${x.delivery}'${x.fields.length > 0 ? ', args: true' : ''}${x.visibility === 'test' ? ', test: true' : ''} }`,
    );
    meta.push(
      `${q(cap.name)}: { commands: ${cmdMeta.length ? `{ ${cmdMeta.join(', ')} }` : '{}'}, events: [${cap.events.map((x) => q(x.name)).join(', ')}], props: [${cap.properties.map((x) => q(x.name)).join(', ')}] },`,
    );
  }

  c.line('// ---- by capability ----');
  c.line();
  for (const [name, about, rows] of [
    ['CapClients', 'Command methods of an instance, by capability.', clients],
    ['CapEvents', 'Events of an instance (wire name -> camelCase fields), by capability.', events],
    ['CapState', 'Mirrored properties of an instance (camelCase), by capability.', states],
    ['CapProps', 'Property values of an instance by wire name, by capability.', props],
  ] as const) {
    doc(c, about);
    c.open(`export interface ${name} {`);
    for (const [cap, type] of rows) {
      c.line(`${q(cap)}: ${type};`);
    }
    c.close();
    c.line();
  }
  c.line('/** Capability names of this catalog. */');
  c.line('export type CapName = keyof CapClients;');
  c.line();
  c.line('/** What the runtime needs of each capability: per command its method, delivery, whether it takes args and whether it is test-only (`raw.call`); event and property names. */');
  c.open('export const CAP_META: Readonly<Record<string, CapMeta>> = {');
  for (const m of meta) {
    c.line(m);
  }
  c.close('};');
  return [{ path: `${SDK_GEN_DIR}/caps.ts`, content: c.toString() }];
}
