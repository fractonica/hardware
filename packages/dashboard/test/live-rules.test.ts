// The dashboard's small rules: the Live page's client-side filter (the 09 §9.2 type globs as the hub's
// events/match.ts reads them, and a selector resolved to device ids), which caches an event makes stale
// (design c6 §5 live-update rules), what the device page renders of a capability (traits, D13; test
// commands only with inject_enabled), and the display helpers (device output made safe for xterm).

import { describe, expect, it } from 'vitest';

import type { PortInfo } from '@fractonica/protocol/browser';
import { CATALOG } from '@fractonica/protocol/gen';

import { defaultArgs, INJECT_ENABLED, joinCatalog, parseArgs, traitAllows, visibleMembers } from '../src/state/caps.ts';
import { ago, brief, bytes, clock, ms, portHolder, span, termSafe } from '../src/state/format.ts';
import { invalidationsFor, jobInvalidations } from '../src/state/invalidate.ts';
import { eventFilter, parseTypes, typeMatcher } from '../src/state/match.ts';
import { ev } from './fakes.ts';

describe('Live page filter', () => {
  it('reads type globs as the hub does: * spans dots, other characters are literal', () => {
    expect(parseTypes(' boot.*, device.online ,,')).toEqual(['boot.*', 'device.online']);
    const m = typeMatcher(parseTypes('boot.*,*.effect_done,a+b.c'));
    expect(['boot.down', 'boot.x.y', 'status.effect_done', 'a+b.c'].map(m)).toEqual([true, true, true, true]);
    expect(['bootdown', 'xboot.down', 'aab.c', 'status.effect_done2'].map(m)).toEqual([false, false, false, false]);
    expect(typeMatcher([])('anything')).toBe(true);
  });

  it('matches in linear time: a filter of many stars cannot freeze the page (it backtracked as a RegExp)', () => {
    expect(typeMatcher(['a*ab'])('aaab')).toBe(true); // the star gives back characters
    expect(typeMatcher(['.*'])('xboot')).toBe(false); // `.` is literal
    // As a RegExp, 22 stars took about 0.7 s against `boot.down`, per event in the ring (minutes against
    // `boot.long_press`).
    let t0 = performance.now();
    expect(typeMatcher([`${'*'.repeat(22)}x`])('boot.down')).toBe(false);
    expect(performance.now() - t0).toBeLessThan(100);
    t0 = performance.now();
    const m = typeMatcher([`${'*'.repeat(40)}x`, `${'*'.repeat(40)}y`]);
    expect(['boot.long_press', 'status.effect_done', 'hub.prompt_done'].map(m)).toEqual([false, false, false]);
    expect(performance.now() - t0).toBeLessThan(100);
  });

  it('keeps the events of the selected devices only, when there is a selector', () => {
    const f = eventFilter({ types: 'boot.*', devices: new Set(['aabbccddeeff']) });
    expect(f(ev(1, 'boot.down'))).toBe(true);
    expect(f(ev(2, 'boot.down', { device: 'other' }))).toBe(false);
    expect(f(ev(3, 'hub.warning', { device: undefined }))).toBe(false);
    expect(eventFilter({})(ev(4, 'hub.warning', { device: undefined }))).toBe(true);
  });
});

describe('cache invalidation by event', () => {
  it('maps hub events to the ops they make stale', () => {
    expect(invalidationsFor(ev(1, 'device.online'))).toEqual(['device_list', 'device_get', 'latency_stats']);
    expect(invalidationsFor(ev(1, 'device.provisioned'))).toContain('device_list');
    expect(invalidationsFor(ev(1, 'registry.drift'))).toContain('device_get');
    expect(invalidationsFor(ev(1, 'port.leased'))).toEqual(['port_list', 'device_list']);
    expect(invalidationsFor(ev(1, 'ota.job.state'))).toEqual(['ota_status']);
    expect(invalidationsFor(ev(1, 'hub.prompt'))).toEqual(['hub_status']);
    expect(invalidationsFor(ev(1, 'boot.down'))).toEqual([]);
    expect(invalidationsFor(ev(1, 'job.state', { fields: { job_id: 'j', kind: 'build', status: 'working' } }))).toEqual(['job_list', 'job_get', 'hub_status']);
    expect(invalidationsFor(ev(1, 'job.state', { fields: { job_id: 'j', kind: 'build', status: 'completed' } }))).toEqual([
      'job_list',
      'job_get',
      'hub_status',
      'artifact_list',
      'profile_list',
    ]);
    expect(jobInvalidations('provision', 'failed')).toContain('port_list');
  });
});

describe('capabilities on the device page', () => {
  const cap = (name: string) => CATALOG.capabilities.find((c) => c.name === name)!;

  it('gates trait members on the instance traits; unknown traits show everything', () => {
    const led = cap('fr.led');
    const props = (traits: Record<string, unknown> | null) => visibleMembers(led, traits, 0).properties.map((p) => p.name);
    const all = led.properties.map((p) => p.name);
    expect(props(null)).toEqual(all);
    const gated = led.properties.filter((p) => p.requires).map((p) => p.name);
    expect(gated.length).toBeGreaterThan(0);
    expect(props({})).toEqual(all.filter((n) => !gated.includes(n)));
    expect(traitAllows({ trait: 'color', eq: 'rgb' }, { color: 'rgb' })).toBe(true);
    expect(traitAllows({ trait: 'color', eq: 'rgb' }, { color: 'mono' })).toBe(false);
    expect(traitAllows({ trait: 'dimmable' }, { dimmable: true })).toBe(true);
    expect(traitAllows({ trait: 'dimmable' }, { dimmable: false })).toBe(false);
  });

  it('shows test commands (inject) only when HELLO says inject_enabled', () => {
    const button = cap('fr.button');
    expect(visibleMembers(button, null, 0).commands.map((c) => c.name)).not.toContain('inject');
    expect(visibleMembers(button, null, INJECT_ENABLED).commands.map((c) => c.name)).toContain('inject');
  });

  it('starts a command form from its first example or its defaults, and reads typed args', () => {
    const inject = cap('fr.button').commands.find((c) => c.name === 'inject')!;
    expect(defaultArgs(inject)).toEqual({ gesture: 'double_click' });
    const identify = cap('fr.node').commands.find((c) => c.name === 'identify')!;
    expect(defaultArgs(identify)).toMatchObject({ ms: 3000 });
    expect(parseArgs('')).toEqual({ ok: true, args: {} });
    expect(parseArgs('{"count":3}')).toEqual({ ok: true, args: { count: 3 } });
    expect(parseArgs('[1]')).toMatchObject({ ok: false });
    expect(parseArgs('{')).toMatchObject({ ok: false });
  });

  it('joins instances to the catalog by name or id, in port order', () => {
    const rows = joinCatalog(
      [
        { name: 'status', port: 2, cap: 'fr.led', cap_id: 2, v: '1.0', traits: null },
        { name: 'boot', port: 1, cap: 'fr.button', cap_id: 1, v: '1.0', traits: null },
        { name: 'x', port: 3, cap: 'acme.thing', cap_id: 999, v: '', traits: null },
      ],
      CATALOG.capabilities,
    );
    expect(rows.map((r) => [r.inst.name, r.cap?.name])).toEqual([
      ['boot', 'fr.button'],
      ['status', 'fr.led'],
      ['x', undefined],
    ]);
  });
});

describe('display helpers', () => {
  it('formats times, sizes and latencies', () => {
    expect(span(950)).toBe('950 ms');
    expect(span(12_400)).toBe('12 s');
    expect(span(3 * 60_000)).toBe('3 min');
    expect(span(125 * 60_000)).toBe('2 h 5 min');
    expect(span(52 * 3_600_000)).toBe('2 d 4 h');
    expect(ago(1000, 1500)).toBe('now');
    expect(ago(0, 12_000)).toBe('12 s ago');
    expect(ago(5000, 0)).toBe('in 5 s');
    expect(bytes(812)).toBe('812 B');
    expect(bytes(1434)).toBe('1.4 KB');
    expect(bytes(1_258_291)).toBe('1.2 MB');
    expect([ms(null), ms(1.234), ms(12.34), ms(123.4)]).toEqual(['–', '1.23', '12.3', '123']);
    expect(clock(new Date(2026, 9, 22, 9, 5, 7, 42).getTime() * 1000)).toBe('09:05:07.042');
    expect(brief({ a: 'x'.repeat(10) }, 10)).toBe('{"a":"xxx…');
  });

  it('lets only colour sequences of device output reach xterm', () => {
    expect(termSafe('\x1b[0;32mI (12) fr: ready\x1b[0m')).toBe('\x1b[0;32mI (12) fr: ready\x1b[0m');
    expect(termSafe('a\x1b]0;title\x07b')).toBe('a␛]0;titleb');
    expect(termSafe('a\x1b[2Jb\x1b[H')).toBe('a␛[2Jb␛[H');
    expect(termSafe('tab\there\r\n\x00\x7f')).toBe('tab\there');
    expect(termSafe('a\u009b2Jb\u009d0;t\u0007c')).toBe('a2Jb0;tc'); // C1 CSI and OSC
  });

  it('names who holds a port', () => {
    const base: PortInfo = { path: '/dev/cu.usbmodem1', state: 'open', lines: 0 };
    expect(portHolder(base)).toBe('hub');
    expect(portHolder({ ...base, state: 'leased', lease: { lease_id: 'l_0123456789ab', holder_pid: 4242, expires_at: 'x' } })).toBe('lease l_0123456789ab (pid 4242)');
    expect(portHolder({ ...base, state: 'busy_external', external: [{ app: 'Google Chrome', pid: 715 }] })).toBe('Google Chrome (pid 715)');
    expect(portHolder({ ...base, state: 'busy_external', holder: 'job j_1' })).toBe('job j_1');
    expect(portHolder({ ...base, state: 'closed' })).toBe('–');
  });
});
