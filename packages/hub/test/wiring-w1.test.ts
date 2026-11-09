// WIRING-1 (design wiring-w1 §7): the guides and parts loader, the cross-check against the profile, the ops against a
// temp database (progress, stock, shopping), the SVG sanitiser, and every guide in the repo loading and passing.

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { findOp, type PartShow, type WiringCheckResult, type WiringList, type WiringShopping, type WiringShow } from '@fractonica/protocol';

const catalog = await import('../src/wiring/catalog.ts');
const { svgProblem } = catalog;
const LOADER = await catalog.codegenLoader();
const loadCatalog = (dir: string) => catalog.loadCatalog(dir, LOADER);
const { WIRING_HANDLERS } = await import('../src/wiring/ops.ts');
const { HANDLERS } = await import('../src/ops.ts');
const { openDb } = await import('../src/db.ts');
type HubContext = import('../src/context.ts').HubContext;

const FIXTURE = resolve(import.meta.dirname, 'fixtures', 'wiring');
const REPO = resolve(import.meta.dirname, '..', '..', '..');

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) {
    rmSync(t, { recursive: true, force: true });
  }
});

/** A copy of the fixture checkout, to edit. */
function checkout(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fr-wiring-'));
  temps.push(dir);
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

function edit(dir: string, file: string, fn: (s: string) => string): void {
  const p = join(dir, file);
  writeFileSync(p, fn(readFileSync(p, 'utf8')));
}

const GUIDE = 'hardware/wiring/demo-bench/guide.yaml';

/** A hub with just what the wiring ops use: a database, the checkout, an event bus that records. */
function hubFor(dir: string): { hub: HubContext; events: { type: string; fields?: Record<string, unknown> }[] } {
  const events: { type: string; fields?: Record<string, unknown> }[] = [];
  const hub = { db: openDb(':memory:'), hubSourceDir: dir, events: { publish: (e: { type: string; fields?: Record<string, unknown> }) => events.push(e) } } as unknown as HubContext;
  return { hub, events };
}

/** Runs an op as the hub does: the input through its schema (defaults), then the handler. */
async function call<T>(hub: HubContext, name: string, input: Record<string, unknown>): Promise<T> {
  const op = findOp(name)!;
  return (await HANDLERS[name as keyof typeof HANDLERS](op.input.parse(input), hub)) as T;
}

describe('the loader and the cross-check', () => {
  it('loads the fixture: parts, the guide, its check ok with GPIO5 a warning', () => {
    const cat = loadCatalog(FIXTURE);
    expect(cat.refused).toEqual([]);
    expect([...cat.parts.keys()].sort()).toEqual(['resistor', 'tp4056-protected']);
    const g = cat.guides.get('demo-bench')!;
    expect(g.check).toBe('ok');
    expect(g.errors).toEqual([]);
    expect(g.board).toBe('demo-c6');
    expect(g.warnings).toEqual([expect.stringContaining('GPIO5 is a strapping pin (level none')]);
    const kick = g.connections.find((c) => c.pin === 'gpio.5')!;
    expect(kick.check).toBe('warning');
    expect(g.connections.find((c) => c.pin === 'gpio.0')!.check).toBe('ok');
    expect(g.connections.find((c) => c.pin === 'gnd')!.check).toBe('unchecked');
  });

  it('a guide that disagrees with its profile fails with the reason, and is still served', () => {
    const dir = checkout();
    edit(dir, GUIDE, (s) => s.replace('{ pin: gpio.14, instance: buzz', '{ pin: gpio.21, instance: buzz').replace('pins: [gpio.14]', 'pins: [gpio.21]'));
    const g = loadCatalog(dir).guides.get('demo-bench')!;
    expect(g.check).toBe('failed');
    expect(g.errors).toContain('gpio.21: the profile binds buzz.out to gpio.14, not gpio.21');
    // A step naming a pin the table does not list is structural: the guide is refused instead.
    const dir2 = checkout();
    edit(dir2, GUIDE, (s) => s.replace('{ pin: gpio.14, instance: buzz', '{ pin: gpio.21, instance: buzz'));
    const cat2 = loadCatalog(dir2);
    expect(cat2.guides.has('demo-bench')).toBe(false);
    expect(cat2.refused.find((r) => r.file === GUIDE)!.errors).toEqual(['sections.1.steps.1: pin gpio.14 is not in connections']);
  });

  it('a profile change the guide does not follow fails (the profile moved a pin)', () => {
    const dir = checkout();
    edit(dir, 'firmware/profiles/demo-power.profile.yaml', (s) => s.replace('chrg: gpio.19', 'chrg: gpio.21'));
    const g = loadCatalog(dir).guides.get('demo-bench')!;
    expect(g.check).toBe('failed');
    expect(g.errors).toContain('gpio.19: the profile binds battery.chrg to gpio.21, not gpio.19');
  });

  it('a covered bind missing from the pin table fails; an uncovered instance may be left out', () => {
    const dir = checkout();
    edit(dir, GUIDE, (s) => s.replace(/ {2}- \{ pin: gpio\.11[^\n]*\n/, '').replace('pins: [gpio.11]', 'pins: []'));
    const g = loadCatalog(dir).guides.get('demo-bench')!;
    expect(g.errors).toContain('covers: battery.load (gpio.11) is not in the pin table');
  });

  it('a pin not free on the board fails; a strapping pin with a level fails too', () => {
    const dir = checkout();
    edit(dir, GUIDE, (s) => s.replace('  - { pin: gnd, to: "every ground" }', '  - { pin: gnd, to: "every ground" }\n  - { pin: gpio.12, to: "USB D-" }\n  - { pin: gpio.9, to: "BOOT" }'));
    const g = loadCatalog(dir).guides.get('demo-bench')!;
    expect(g.check).toBe('failed');
    expect(g.errors).toContain('gpio.12: GPIO12 is not a free pin on demo-c6');
    expect(g.errors).toContain('gpio.9: GPIO9 is not a free pin on demo-c6 (a strapping pin, level high)');
  });

  it('one pin for two instances fails; a pin the profile binds but the guide does not name is a warning', () => {
    const dir = checkout();
    edit(dir, GUIDE, (s) => s.replace('  - { pin: gnd, to: "every ground" }', '  - { pin: gnd, to: "every ground" }\n  - { pin: gpio.14, instance: kick, bind: out, to: "oops" }'));
    const g = loadCatalog(dir).guides.get('demo-bench')!;
    expect(g.errors).toContain('gpio.14: gpio.14 is listed for buzz and for kick');

    const dir2 = checkout();
    edit(dir2, GUIDE, (s) => s.replace('{ pin: gpio.5, instance: kick, bind: out, to: "solenoid driver" }', '{ pin: gpio.5, to: "solenoid driver" }'));
    const g2 = loadCatalog(dir2).guides.get('demo-bench')!;
    expect(g2.check).toBe('ok');
    expect(g2.warnings).toContain('gpio.5: the profile binds gpio.5 to kick.out: name it (instance, bind)');
  });

  it('structural problems refuse the guide with every reason', () => {
    const dir = checkout();
    edit(dir, GUIDE, (s) =>
      s
        .replace('{ part: resistor, value: 1 MΩ, qty: 2 }', '{ part: resistor, value: 2 MΩ, qty: 2 }')
        .replace('{ part: tp4056-protected, qty: 1 }', '{ part: tp4056-protected, qty: 1 }\n  - { part: no-such-part, qty: 1 }')
        .replace('diagram: divider', 'diagram: nope')
        .replace('id: drive-load', 'id: sense-divider'),
    );
    const cat = loadCatalog(dir);
    expect(cat.guides.has('demo-bench')).toBe(false);
    const r = cat.refused.find((x) => x.file === GUIDE)!;
    expect(r.errors).toEqual(
      expect.arrayContaining([
        'bom.1: no part no-such-part in hardware/parts',
        'bom.2: resistor has no value 2 MΩ (values: 470 Ω, 10 kΩ, 1 MΩ)',
        'sections.0: no diagram nope',
        'sections.1.steps.0: step id sense-divider is used twice in the guide',
      ]),
    );
  });

  it('an unknown field, a bad part and an SVG with a script are refused', () => {
    const dir = checkout();
    edit(dir, GUIDE, (s) => s.replace('safety:', 'colour: red\nsafety:'));
    edit(dir, 'hardware/parts/resistor.part.yaml', (s) => s.replace('inferred: [tolerance]', 'inferred: [weight]'));
    const cat = loadCatalog(dir);
    expect(cat.refused.find((x) => x.file === GUIDE)!.errors.join(' ')).toMatch(/colour/);
    expect(cat.refused.find((x) => x.file === 'hardware/parts/resistor.part.yaml')!.errors).toEqual(['inferred: weight is not a key of specs']);

    const dir2 = checkout();
    edit(dir2, 'hardware/wiring/demo-bench/divider.svg', (s) => s.replace('</svg>', '<script>alert(1)</script></svg>'));
    const r = loadCatalog(dir2).refused.find((x) => x.file === GUIDE)!;
    expect(r.errors).toEqual(['diagrams.0: divider.svg holds a <script>']);
  });

  it('the SVG check: scripts, foreignObject, javascript: and external references; #ids and handlers pass', () => {
    const ok = '<svg viewBox="0 0 1 1"><defs><marker id="a"/></defs><path marker-end="url(#a)"/><use href="#a"/><g onclick="x()"/></svg>';
    expect(svgProblem(ok)).toBeNull();
    expect(svgProblem('<svg><script>x</script></svg>')).toBe('holds a <script>');
    expect(svgProblem('<svg><foreignObject/></svg>')).toBe('holds a <foreignObject>');
    expect(svgProblem('<svg><a href="javascript:x"/></svg>')).toBe('holds a javascript: URL');
    expect(svgProblem('<svg><image href="https://evil.example/x.png"/></svg>')).toBe('refers to https://evil.example/x.png (only #ids inside the file)');
    expect(svgProblem('<svg><rect style="fill:url(http://x/y)"/></svg>')).toBe('refers to url(http://x/y) (only #ids inside the file)');
    expect(svgProblem('<p>no</p>')).toBe('not an SVG (no <svg> element)');
  });
});

describe('the wiring ops', () => {
  it('list, show, steps done and undone (with wiring.step events), reset', async () => {
    const { hub, events } = hubFor(FIXTURE);
    const list = await call<WiringList>(hub, 'wiring_list', {});
    expect(list.guides).toEqual([expect.objectContaining({ id: 'demo-bench', steps: 4, done: 0, check: 'ok', device: 'demo-dev' })]);

    const done = await call(hub, 'wiring_step', { guide: 'demo-bench', steps: 'sense-divider sense-status' });
    expect(done).toMatchObject({ steps: ['sense-divider', 'sense-status'], done: true, total: 4, done_count: 2 });
    expect(events.map((e) => [e.type, e.fields?.step, e.fields?.done])).toEqual([
      ['wiring.step', 'sense-divider', true],
      ['wiring.step', 'sense-status', true],
    ]);
    // Marking a done step done again changes nothing and publishes nothing.
    await call(hub, 'wiring_step', { guide: 'demo-bench', steps: ['sense-divider'] });
    expect(events).toHaveLength(2);

    const show = await call<WiringShow>(hub, 'wiring_show', { guide: 'demo-bench' });
    expect(show.done).toBe(2);
    expect(show.sections[0].steps.map((s) => s.done)).toEqual([true, true]);
    expect(show.sections[0].steps[0].done_at).toEqual(expect.any(String));
    expect(show.sections[1].steps[1]).toMatchObject({ id: 'drive-motor', note: 'Diode stripe to +.', done: false });
    expect(show.diagrams).toEqual([{ id: 'divider', title: 'Sense divider', file: 'divider.svg', url: '/wiring/demo-bench/divider.svg' }]);
    expect(show.connections.find((c) => c.pin === 'gpio.5')).toMatchObject({ check: 'warning' });

    expect(await call(hub, 'wiring_undo', { guide: 'demo-bench', steps: ['sense-status'] })).toMatchObject({ done: false, done_count: 1 });
    expect(await call(hub, 'wiring_reset', { guide: 'demo-bench' })).toMatchObject({ steps: ['sense-divider'], done_count: 0 });
    expect(events.at(-1)).toMatchObject({ type: 'wiring.step', fields: { guide: 'demo-bench', step: 'sense-divider', done: false } });

    await expect(call(hub, 'wiring_step', { guide: 'demo-bench', steps: ['nope'] })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(call(hub, 'wiring_show', { guide: 'no-guide' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('stock, the BOM have/missing, the shopping list over unfinished guides, part_show', async () => {
    const { hub } = hubFor(FIXTURE);
    await expect(call(hub, 'part_stock', { part: 'resistor', qty: 5 })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(call(hub, 'part_stock', { part: 'resistor', value: '2 MΩ', qty: 5 })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(call(hub, 'part_stock', { part: 'tp4056-protected', value: '1 A', qty: 5 })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    expect(await call(hub, 'part_stock', { part: 'resistor', value: '1 MΩ', qty: 10, location: 'drawer 2' })).toMatchObject({ qty: 10, location: 'drawer 2' });
    expect(await call(hub, 'part_stock', { part: 'resistor', value: '1 MΩ', qty: 8 })).toMatchObject({ qty: 8, location: 'drawer 2' });
    await call(hub, 'part_stock', { part: 'resistor', value: '10 kΩ', qty: 1 });

    const show = await call<WiringShow>(hub, 'wiring_show', { guide: 'demo-bench' });
    expect(show.bom).toEqual([
      expect.objectContaining({ part: 'tp4056-protected', qty: 1, have: 0, missing: 1 }),
      expect.objectContaining({ part: 'resistor', value: '1 MΩ', qty: 2, have: 8, missing: 0 }),
      expect.objectContaining({ part: 'resistor', value: '10 kΩ', qty: 2, have: 1, missing: 1 }),
    ]);

    const shop = await call<WiringShopping>(hub, 'wiring_shopping', {});
    expect(shop.guides).toEqual(['demo-bench']);
    expect(shop.lines.map((l) => [l.part, l.value, l.need, l.have, l.missing])).toEqual([
      ['resistor', '10 kΩ', 2, 1, 1],
      ['tp4056-protected', null, 1, 0, 1],
      ['resistor', '1 MΩ', 2, 8, 0],
    ]);
    // A finished guide needs nothing.
    await call(hub, 'wiring_step', { guide: 'demo-bench', steps: ['sense-divider', 'sense-status', 'drive-load', 'drive-motor'] });
    expect((await call<WiringShopping>(hub, 'wiring_shopping', {})).lines).toEqual([]);
    expect((await call<WiringShopping>(hub, 'wiring_shopping', { guide: 'demo-bench' })).lines).toHaveLength(3);

    const part = await call<PartShow>(hub, 'part_show', { part: 'resistor' });
    expect(part).toMatchObject({ have: 9, inferred: ['tolerance'], specs: { power: '0.25 W', tolerance: '1 %' } });
    expect(part.stock.map((s) => [s.value, s.qty])).toEqual([
      ['10 kΩ', 1],
      ['1 MΩ', 8],
    ]);
    expect(part.used_by).toEqual([
      { guide: 'demo-bench', title: 'Demo bench', value: '1 MΩ', qty: 2 },
      { guide: 'demo-bench', title: 'Demo bench', value: '10 kΩ', qty: 2 },
    ]);
    const parts = await call<{ parts: { id: string }[] }>(hub, 'part_list', { category: 'power' });
    expect(parts.parts.map((p) => p.id)).toEqual(['tp4056-protected']);
    expect((await call<{ parts: { id: string }[] }>(hub, 'part_list', { query: 'resist' })).parts.map((p) => p.id)).toEqual(['resistor']);
  });

  it('wiring_check reads the files again; a failed guide makes ok false; reload picks up a fix', async () => {
    const dir = checkout();
    const { hub } = hubFor(dir);
    expect((await call<WiringCheckResult>(hub, 'wiring_check', {})).ok).toBe(true);
    edit(dir, 'firmware/profiles/demo-power.profile.yaml', (s) => s.replace('out: gpio.14', 'out: gpio.21'));
    const bad = await call<WiringCheckResult>(hub, 'wiring_check', {});
    expect(bad.ok).toBe(false);
    expect(bad.guides[0]).toMatchObject({ id: 'demo-bench', check: 'failed' });
    edit(dir, 'firmware/profiles/demo-power.profile.yaml', (s) => s.replace('out: gpio.21', 'out: gpio.14'));
    expect(await call(hub, 'wiring_reload', {})).toMatchObject({ guides: 1, parts: 2, refused: [] });
    expect((await call<WiringList>(hub, 'wiring_list', {})).guides[0].check).toBe('ok');
  });

  it('every wiring op has a handler', () => {
    for (const name of Object.keys(WIRING_HANDLERS)) {
      expect(findOp(name)).toBeDefined();
    }
  });
});

describe('the repo', () => {
  it('every guide and part in hardware/ loads and every guide passes its cross-check', () => {
    const cat = loadCatalog(REPO);
    expect(cat.refused).toEqual([]);
    const failed = [...cat.guides.values()].filter((g) => g.check === 'failed').map((g) => ({ id: g.id, errors: g.errors }));
    expect(failed).toEqual([]);
  });
});
