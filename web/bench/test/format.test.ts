// web/bench's pure helpers (src/format.ts): routes, progress, the SVG sanitiser, the live chips, the next step.

import { describe, expect, it } from 'vitest';

import { instanceLive, liveText, missingText, nextStep, parseRoute, pinInstances, progressPct, routeHash, sanitizeSvg } from '../src/format.ts';

describe('routes', () => {
  it('parses and builds the hash routes; guides by default', () => {
    expect(parseRoute('')).toEqual({ view: 'guides' });
    expect(parseRoute('#/guides')).toEqual({ view: 'guides' });
    expect(parseRoute('#/guide/power-bench-c6')).toEqual({ view: 'guide', id: 'power-bench-c6' });
    expect(parseRoute('#/guide/')).toEqual({ view: 'guides' });
    expect(parseRoute('#/parts')).toEqual({ view: 'parts' });
    expect(parseRoute('#/part/tp4056-protected')).toEqual({ view: 'part', id: 'tp4056-protected' });
    expect(parseRoute('#/shopping')).toEqual({ view: 'shopping' });
    expect(parseRoute('#/nonsense')).toEqual({ view: 'guides' });
    expect(routeHash({ view: 'part', id: 'a b' })).toBe('#/part/a%20b');
    expect(parseRoute(routeHash({ view: 'guide', id: 'x-1' }))).toEqual({ view: 'guide', id: 'x-1' });
  });
});

describe('progress and the next step', () => {
  it('rounds, caps and handles a guide without steps', () => {
    expect(progressPct(0, 0)).toBe(0);
    expect(progressPct(1, 3)).toBe(33);
    expect(progressPct(5, 4)).toBe(100);
  });
  it('the first step not done, or null', () => {
    const g = { sections: [{ id: 'a', steps: [{ id: 'a1', done: true }] }, { id: 'b', steps: [{ id: 'b1', done: true }, { id: 'b2', done: false }] }] };
    expect(nextStep(g as never)).toEqual({ section: 'b', step: 'b2' });
    expect(nextStep({ sections: [{ id: 'a', steps: [{ id: 'a1', done: true }] }] } as never)).toBeNull();
  });
  it('lists the short BOM lines', () => {
    expect(missingText([{ name: 'Resistor', value: '1 MΩ', missing: 2 }, { name: 'TP4056', value: null, missing: 0 }] as never)).toEqual(['2 × Resistor 1 MΩ']);
  });
});

describe('the SVG sanitiser', () => {
  it('drops scripts, foreignObject, handlers, javascript: and the prolog; keeps the drawing', () => {
    const svg = `<?xml version="1.0"?><!DOCTYPE svg><svg viewBox="0 0 1 1"><script>alert(1)</script><script src="x"/><foreignObject><div/></foreignObject><g class="node c-teal" onclick="sendPrompt('x')" onmouseover='y()'><rect x="1"/></g><a href="javascript:alert(1)"/></svg>`;
    const out = sanitizeSvg(svg);
    expect(out).toBe(`<svg viewBox="0 0 1 1"><g class="node c-teal"><rect x="1"/></g><a href="alert(1)"/></svg>`);
    expect(out).not.toMatch(/script|onclick|onmouseover|foreignObject|javascript/i);
  });
});

describe('live chips', () => {
  it('maps pins to instances and shows an instance\'s live values', () => {
    const m = pinInstances([
      { pin: 'gpio.0', instance: 'battery' },
      { pin: 'gpio.5', instance: null },
      { pin: 'gpio.5', instance: 'kick' },
    ] as never);
    expect([...m]).toEqual([
      ['gpio.0', 'battery'],
      ['gpio.5', 'kick'],
    ]);
    const props = { 'battery.mv': 3912, 'battery.charger': 'charging', 'battery.load_on': false, 'battery.level': 'ok', 'cap.mv': 4100 };
    expect(instanceLive(props, 'battery')).toEqual(['mv 3.91 V', 'charger charging', 'load_on off']);
    expect(instanceLive(props, 'cap', 5)).toEqual(['mv 4.10 V']);
    expect(instanceLive(undefined, 'battery')).toEqual([]);
    expect(liveText('percent', 57.123)).toBe('57.12');
    expect(liveText('x', { a: 1 })).toBe('{"a":1}');
  });
});
