// fr.display's nested message args (design m2-c5-display D1, D2): UiLayout (a message holding array<UiWidget>, at
// most 24) is encodable on its own and inside ui_load, which agents send as JSON through command_send; ui_load and
// snapshot_read are bulk. The golden vectors (schema/vectors/caps.json) pin the bytes; this checks the TS API.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  CATALOG,
  decodeDisplayUiLayout,
  decodeDisplayUiLoadArgs,
  decodeMember,
  DISPLAY_CAP,
  encodeDisplayUiLayout,
  encodeDisplayUiLoadArgs,
  encodeMember,
  findCap,
  jsonSchema,
  TOUCH_CAP,
  type DisplayUiLayout,
} from '@fractonica/protocol/gen';

const KINDS = ['label', 'button', 'bar', 'slider', 'arc', 'switch', 'rect'] as const;

/** 24 widgets of every kind, as an agent writes them (JSON form: enums by name). */
function layout(n = 24): DisplayUiLayout {
  return {
    bg: 0x101820,
    widgets: Array.from({ length: n }, (_, i) => ({
      id: `w${i}`,
      kind: KINDS[i % KINDS.length],
      x: (i % 4) * 60 - 5,
      y: Math.floor(i / 4) * 52,
      w: 56,
      h: 48,
      text: `widget ${i} ·`,
      value: i * 4,
      min: -100,
      max: 100 + i,
      color: 0xffffff - i,
      bg: 0x2060c0 + i,
      font: i % 3,
      align: i % 2 === 0 ? 'left' : 'center',
    })),
  };
}

describe('fr.display UiLayout (design m2-c5-display D2)', () => {
  it('round-trips a 24-widget layout on its own and inside ui_load', () => {
    const l = layout();
    const bytes = encodeDisplayUiLayout(l);
    expect(decodeDisplayUiLayout(bytes)).toEqual({ ok: true, value: l });
    const args = encodeDisplayUiLoadArgs({ layout: l });
    // ui_load is field 1 (length-delimited) around exactly those bytes.
    expect(Array.from(args.subarray(0, 3))).toEqual([0x0a, (bytes.length & 0x7f) | 0x80, bytes.length >> 7]);
    expect(args.subarray(3)).toEqual(bytes);
    expect(decodeDisplayUiLoadArgs(args)).toEqual({ ok: true, value: { layout: l } });
  });

  it('an absent layout and absent widget fields decode as their defaults (max 100, white text)', () => {
    expect(decodeDisplayUiLoadArgs(new Uint8Array(0))).toEqual({ ok: true, value: { layout: { bg: 0, widgets: [] } } });
    const one = decodeDisplayUiLayout(encodeDisplayUiLayout({ widgets: [{ id: 'a' } as never] }));
    expect(one.ok && one.value.widgets[0]).toMatchObject({ id: 'a', kind: 'label', min: 0, max: 100, color: 0xffffff, bg: 0, font: 0, align: 'left' });
  });

  it('refuses a 25th widget (too_long) and a value its type cannot carry', () => {
    expect(() => encodeDisplayUiLayout(layout(25))).toThrow(RangeError);
    const bad = layout(1);
    (bad.widgets[0] as { x: number }).x = 40000;
    expect(() => encodeDisplayUiLoadArgs({ layout: bad })).toThrow(/layout\.widgets\[0\]\.x/);
  });
});

describe('ui_load as JSON (command_send, design m2-c5-display D5)', () => {
  it('encodes and decodes through the generic accessors, defaults applied', () => {
    const l = layout();
    const enc = encodeMember('fr.display', 'args', 'ui_load', { layout: l });
    expect(enc.ok).toBe(true);
    const dec = decodeMember('fr.display', 'args', 'ui_load', enc.ok ? enc.value : new Uint8Array(0));
    expect(dec).toEqual({ ok: true, value: { layout: l } });
    const small = encodeMember('fr.display', 'args', 'ui_load', { layout: { widgets: [{ id: 'ok', kind: 'button', text: 'OK' }] } });
    expect(small.ok && decodeMember('fr.display', 'args', 'ui_load', small.value)).toEqual({
      ok: true,
      value: { layout: { bg: 0, widgets: [{ id: 'ok', kind: 'button', x: 0, y: 0, w: 0, h: 0, text: 'OK', value: 0, min: 0, max: 100, color: 0xffffff, bg: 0, font: 0, align: 'left' }] } },
    });
  });

  it('refuses what C++ dispatch refuses, naming the nested field', () => {
    const one = (w: Record<string, unknown>) => encodeMember('fr.display', 'args', 'ui_load', { layout: { widgets: [w] } });
    expect(one({ font: 3 })).toMatchObject({ ok: false, error: 'invalid_args', detail: 'layout.widgets[0].font: 3 is outside [0, 2]' });
    expect(one({ kind: 'dial' })).toMatchObject({ ok: false, error: 'invalid_args', detail: expect.stringMatching(/^layout\.widgets\[0\]\.kind: .*label/) });
    expect(one({ colour: 1 })).toMatchObject({ ok: false, error: 'invalid_args', detail: expect.stringMatching(/^layout\.widgets\[0\]\.colour: unknown field/) });
    expect(encodeMember('fr.display', 'args', 'ui_load', { layout: [] })).toMatchObject({ ok: false, error: 'invalid_args' });
    expect(encodeMember('fr.display', 'args', 'ui_load', { layout: { widgets: layout(25).widgets } })).toMatchObject({ ok: false, error: 'invalid_args' });
  });

  it('the generated JSON Schema nests UiLayout and UiWidget, and zod reads it', () => {
    const s = jsonSchema('fr.display', 'args', 'ui_load') as Record<string, any>;
    expect(s.properties.layout.type).toBe('object');
    expect(s.properties.layout.properties.widgets).toMatchObject({ type: 'array', maxItems: 24, items: { type: 'object', additionalProperties: false } });
    expect(s.properties.layout.properties.widgets.items.properties.kind.enum).toEqual([...KINDS]);
    const schema = z.fromJSONSchema(s as Parameters<typeof z.fromJSONSchema>[0]);
    expect(schema.safeParse({ layout: layout() }).success).toBe(true);
    expect(schema.safeParse({ layout: { widgets: [{ font: 3 }] } }).success).toBe(false);
    expect(schema.safeParse({ layout: { widgets: layout(25).widgets } }).success).toBe(false);
  });
});

describe('bulk commands and the catalog (design m2-c5-display D1, D4)', () => {
  it('marks ui_load, snapshot and snapshot_read bulk in CAPS and the catalog, and nothing else', () => {
    expect(DISPLAY_CAP.commands.filter((c) => c.bulk).map((c) => c.name)).toEqual(['ui_load', 'snapshot', 'snapshot_read']);
    expect(findCap('fr.led')!.commands.some((c) => c.bulk)).toBe(false);
    const cat = CATALOG.capabilities.find((c) => c.name === 'fr.display')!;
    expect(cat.commands.filter((c) => c.bulk).map((c) => c.name)).toEqual(['ui_load', 'snapshot', 'snapshot_read']);
    expect(Object.keys(cat.messages ?? {})).toEqual(['UiWidget', 'UiLayout']);
  });

  it('fr.touch is 0x0008 with realtime down/up and a test-only inject', () => {
    expect(TOUCH_CAP).toMatchObject({ id: 0x0008, name: 'fr.touch' });
    expect(TOUCH_CAP.events.map((e) => [e.name, e.priority])).toEqual([
      ['down', 'realtime'],
      ['up', 'realtime'],
      ['gesture', 'normal'],
    ]);
    expect(encodeMember('fr.touch', 'args', 'inject', { x: 120, y: 145, gesture: 'long_press' })).toMatchObject({ ok: true });
  });
});
