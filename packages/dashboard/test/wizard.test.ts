// The provision wizard (design c6 §5, spec 11.5 step 2): detect -> network (only when no network is
// stored) -> profile + alias (checked with the registry's alias rules) -> flash (job stages from job frames)
// -> join; the hub's errors with what a person can do (PORT_BUSY_EXTERNAL, T-PORTS), and INVALID_ARGS
// candidate profiles picked and retried; the network form's checks; and what the wizard and the Network
// page's broadcast button send, against the ops' own input schemas and the hub's provision stages.

import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { OPS, type ToolError } from '@fractonica/protocol/browser';

import {
  BROADCAST_PING,
  canSubmit,
  needsJobDetail,
  networkInput,
  networkProblem,
  PROVISION_STAGES,
  provisionInput,
  stageView,
  WIZARD_CLOSED,
  wizardReducer,
  type WizardAction,
  type WizardState,
} from '../src/state/wizard.ts';

const PORT = { path: '/dev/cu.usbmodem1101', usb_serial: '1C:DB:D4:16:BA:34', device_id: '1cdbd416ba34', state: 'open' };

function run(...actions: WizardAction[]): WizardState {
  return actions.reduce(wizardReducer, WIZARD_CLOSED);
}

/** The op's input schema parses `input` (as the hub's REST route does). */
function accepts(name: (typeof OPS)[number]['name'], input: unknown): { success: boolean; data?: unknown } {
  const def = OPS.find((o) => o.name === name)!;
  return def.input.safeParse(input);
}

describe('dashboard provision wizard', () => {
  it('walks a new board through network, profile and alias, flash and join', () => {
    let s = run({ type: 'open', port: PORT, known: null }, { type: 'network', network: { state: 'missing' } });
    expect(s.step).toBe('detect');
    s = wizardReducer(s, { type: 'next' });
    expect(s.step).toBe('network');
    // The network step cannot be skipped; storing it moves on.
    expect(wizardReducer(s, { type: 'next' }).step).toBe('network');
    s = wizardReducer(s, { type: 'network', network: { state: 'set', ssid: 'lab' } });
    expect(s.step).toBe('profile');

    s = wizardReducer(s, { type: 'profiles', profiles: [{ profile: 'c6-pad', chip: 'esp32c6', built: true }] });
    s = wizardReducer(s, { type: 'alias', alias: 'Pad-C6' });
    expect(s.aliasError).toBeNull();
    expect(canSubmit(s)).toBe(true);
    expect(provisionInput(s)).toEqual({ port: '1C:DB:D4:16:BA:34', alias: 'pad-c6', wait_s: 0 });
    s = wizardReducer(s, { type: 'profile', profile: 'c6-pad' });
    expect(provisionInput(s)).toEqual({ port: '1C:DB:D4:16:BA:34', profile: 'c6-pad', alias: 'pad-c6', wait_s: 0 });

    s = wizardReducer(s, { type: 'submitted' });
    expect(s.step).toBe('flash');
    s = wizardReducer(s, { type: 'job', job: { job_id: 'j_p', status: 'working', stage: 'lease' } });
    s = wizardReducer(s, { type: 'job', job: { job_id: 'j_p', status: 'working', stage: 'flash', progress: { pct: 45 } } });
    s = wizardReducer(s, { type: 'job', job: { job_id: 'j_other', status: 'failed' } }); // another job
    expect(canSubmit(s)).toBe(false);
    expect(s.job).toMatchObject({ status: 'working', stage: 'flash', progress: { pct: 45 }, stages: ['lease', 'flash'] });
    expect(stageView(s).map((x) => x.status)).toEqual(['done', 'done', 'done', 'done', 'done', 'current', 'pending', 'pending', 'pending']);

    s = wizardReducer(s, { type: 'online', device_id: '1cdbd416ba34' });
    s = wizardReducer(s, {
      type: 'job',
      job: { job_id: 'j_p', status: 'completed', stage: 'join', result: { device_id: '1cdbd416ba34', alias: 'pad-c6', profile: 'c6-pad', build_id: 'b', fw_id: 'f', wifi: 'joined' } },
    });
    expect(s.step).toBe('done');
    expect(s.online).toBe(true);
    expect(s.result?.wifi).toBe('joined');
    expect(stageView(s).every((x) => x.status === 'done')).toBe(true);
    // A late frame changes nothing.
    expect(wizardReducer(s, { type: 'job', job: { job_id: 'j_p', status: 'working', stage: 'hello' } })).toBe(s);
  });

  it('skips the network step when one is stored, and starts from what the registry knows', () => {
    let s = run(
      { type: 'open', port: PORT, known: { device_id: '1cdbd416ba34', alias: 'pad-c6', profile: 'c6-pad', presence: 'offline' } },
      { type: 'network', network: { state: 'set', ssid: 'lab' } },
    );
    expect(s).toMatchObject({ alias: 'pad-c6', profile: 'c6-pad' });
    s = wizardReducer(s, { type: 'next' });
    expect(s.step).toBe('profile');
    expect(wizardReducer(s, { type: 'back' }).step).toBe('detect');
  });

  it('checks the alias with the registry rules as it is typed; empty means the hub default', () => {
    let s = run({ type: 'open', port: PORT, known: null }, { type: 'network', network: { state: 'set', ssid: 'lab' } }, { type: 'next' });
    for (const [alias, bad] of [
      ['all', true],
      ['-pad', true],
      ['1cdbd416ba34', true],
      ['a'.repeat(32), true],
      ['pad_c6', true],
      ['pad-red-1', false],
      ['', false],
    ] as const) {
      s = wizardReducer(s, { type: 'alias', alias });
      expect(s.aliasError !== null, alias).toBe(bad);
      expect(canSubmit(s), alias).toBe(!bad);
    }
    expect(provisionInput(s)).toEqual({ port: '1C:DB:D4:16:BA:34', wait_s: 0 });
  });

  it('shows a port held by Chrome with what to do, and retries', () => {
    let s = run({ type: 'open', port: PORT, known: null }, { type: 'network', network: { state: 'set', ssid: 'lab' } }, { type: 'next' }, { type: 'submitted' });
    const busy: ToolError = {
      code: 'PORT_BUSY_EXTERNAL',
      message: '/dev/cu.usbmodem1101 (pad-c3b) is held by Google Chrome (pid 715)',
      retryable: true,
      remediation: [{ human: 'close the Web Serial tab in Google Chrome' }],
    };
    s = wizardReducer(s, { type: 'failed', error: busy });
    expect(s.error).toEqual({ code: 'PORT_BUSY_EXTERNAL', message: busy.message, human: ['close the Web Serial tab in Google Chrome'], candidates: [] });
    // Without the hub's own remediation the wizard says it.
    s = wizardReducer(s, { type: 'failed', error: { ...busy, remediation: undefined } });
    expect(s.error?.human[0]).toMatch(/Web Serial tab in Chrome/);
    s = wizardReducer(s, { type: 'back' });
    expect(s).toMatchObject({ step: 'profile', error: null, job: null });
  });

  it('offers the candidate profiles of an INVALID_ARGS job error and retries with the one picked', () => {
    let s = run({ type: 'open', port: PORT, known: null }, { type: 'network', network: { state: 'set', ssid: 'lab' } }, { type: 'next' }, { type: 'submitted' });
    s = wizardReducer(s, { type: 'job', job: { job_id: 'j_q', status: 'working', stage: 'select' } });
    s = wizardReducer(s, {
      type: 'job',
      job: {
        job_id: 'j_q',
        status: 'failed',
        error: { code: 'INVALID_ARGS', message: 'artifacts for several esp32c6 profiles exist (c6-pad, c6-lamp)', retryable: false, details: { candidates: ['c6-pad', 'c6-lamp'] } },
      },
    });
    expect(s.error?.candidates).toEqual(['c6-pad', 'c6-lamp']);
    expect(stageView(s)[2]).toEqual({ stage: 'select', status: 'failed' });
    s = wizardReducer(s, { type: 'pick', profile: 'c6-lamp' });
    expect(s).toMatchObject({ step: 'profile', profile: 'c6-lamp', error: null, job: null });
    expect(canSubmit(s)).toBe(true);
  });

  it('fills in the result or error of a job that a job frame ended, from job_get', () => {
    const start = () => run({ type: 'open', port: PORT, known: null }, { type: 'network', network: { state: 'set', ssid: 'lab' } }, { type: 'next' }, { type: 'submitted' });
    const result = { device_id: '1cdbd416ba34', alias: 'pad-c6', profile: 'c6-pad', build_id: 'b', fw_id: 'f', wifi: 'joined' };
    // device_provision answers the whole job; a `/ws` job frame then ends it without its result.
    let s = wizardReducer(start(), { type: 'job', job: { job_id: 'j_p', status: 'queued' }, full: true });
    expect(needsJobDetail(s)).toBe(false);
    s = wizardReducer(s, { type: 'job', job: { job_id: 'j_p', status: 'completed', stage: 'join' } });
    expect(s).toMatchObject({ step: 'done', result: null });
    expect(needsJobDetail(s)).toBe(true);
    // A late frame changes nothing; job_get's answer brings the result, once.
    expect(wizardReducer(s, { type: 'job', job: { job_id: 'j_p', status: 'completed' } })).toBe(s);
    s = wizardReducer(s, { type: 'job', job: { job_id: 'j_p', status: 'completed', result }, full: true });
    expect(s).toMatchObject({ step: 'done', result: { wifi: 'joined' }, online: true });
    expect(needsJobDetail(s)).toBe(false);
    expect(wizardReducer(s, { type: 'job', job: { job_id: 'j_p', status: 'completed', result: { ...result, alias: 'x' } }, full: true })).toBe(s);

    // A failure: the generic error until job_get gives the hub's, with what to do.
    s = wizardReducer(start(), { type: 'job', job: { job_id: 'j_f', status: 'working', stage: 'lease' } });
    s = wizardReducer(s, { type: 'job', job: { job_id: 'j_f', status: 'failed', stage: 'lease' } });
    expect(s.error).toMatchObject({ code: 'INTERNAL', message: 'the job failed' });
    expect(needsJobDetail(s)).toBe(true);
    const busy = { code: 'PORT_BUSY_EXTERNAL', message: '/dev/cu.usbmodem1101 is held by Google Chrome (pid 715)', retryable: true, remediation: [{ human: 'close the tab' }] };
    s = wizardReducer(s, { type: 'job', job: { job_id: 'j_f', status: 'failed', error: busy }, full: true });
    expect(s.error).toMatchObject({ code: 'PORT_BUSY_EXTERNAL', human: ['close the tab'] });
    expect(needsJobDetail(s)).toBe(false);
    // A job_get without an error keeps the generic one and asks no more.
    s = wizardReducer(start(), { type: 'job', job: { job_id: 'j_c', status: 'cancelled' } });
    s = wizardReducer(s, { type: 'job', job: { job_id: 'j_c', status: 'cancelled' }, full: true });
    expect([s.error?.code, needsJobDetail(s)]).toEqual(['INTERNAL', false]);
  });

  it('reports a board that did not join over Wi-Fi', () => {
    let s = run({ type: 'open', port: PORT, known: null }, { type: 'network', network: { state: 'set', ssid: 'lab' } }, { type: 'next' }, { type: 'submitted' });
    s = wizardReducer(s, {
      type: 'job',
      job: { job_id: 'j_r', status: 'completed', result: { device_id: '1cdbd416ba34', alias: 'c6-pad-16ba34', profile: 'c6-pad', build_id: 'b', fw_id: 'f', wifi: 'not_joined' } },
    });
    expect(s).toMatchObject({ step: 'done', online: false });
    expect(wizardReducer(s, { type: 'online', device_id: 'ffffffffffff' }).online).toBe(false);
    expect(wizardReducer(s, { type: 'online', device_id: '1cdbd416ba34' }).online).toBe(true);
  });

  it('checks the network form like network_set does', () => {
    const f = { ssid: 'lab', password: 'secret', country: 'us', bssid: '' };
    expect(networkProblem(f)).toBeNull();
    expect(networkInput(f)).toEqual({ ssid: 'lab', password: 'secret', country: 'US' });
    expect(networkProblem({ ...f, ssid: '' })).toMatch(/SSID/);
    expect(networkProblem({ ...f, ssid: 'x'.repeat(33) })).toMatch(/SSID/);
    expect(networkProblem({ ...f, password: 'x'.repeat(65) })).toMatch(/password/);
    expect(networkProblem({ ...f, country: 'USA' })).toMatch(/country/);
    expect(networkProblem({ ...f, bssid: '3c:84:6a:12:34' })).toMatch(/BSSID/);
    expect(networkInput({ ssid: 'open', password: '', country: '', bssid: '3C:84:6A:12:34:56' })).toEqual({ ssid: 'open', bssid: '3c:84:6a:12:34:56' });
  });

  it("sends what the ops' input schemas accept, and knows the hub's provision stages in order", () => {
    // device_provision: an auto profile and the default alias, then both chosen (the alias lower-cased).
    let s = run({ type: 'open', port: PORT, known: null }, { type: 'network', network: { state: 'set', ssid: 'lab' } }, { type: 'next' });
    expect(accepts('device_provision', provisionInput(s)).success).toBe(true);
    s = run({ type: 'open', port: { path: '/dev/cu.usbmodem1101', state: 'free' }, known: null }, { type: 'profile', profile: 'c6-pad' }, { type: 'alias', alias: 'Pad-C6' });
    expect(accepts('device_provision', provisionInput(s))).toMatchObject({ success: true, data: { port: '/dev/cu.usbmodem1101', profile: 'c6-pad', alias: 'pad-c6', wait_s: 0 } });
    // network_set from a form networkProblem passes.
    const form = { ssid: 'lab', password: 'secret', country: 'us', bssid: '3C:84:6A:12:34:56' };
    expect(networkProblem(form)).toBeNull();
    expect(accepts('network_set', networkInput(form)).success).toBe(true);
    expect(accepts('network_set', networkInput({ ssid: 'open', password: '', country: '', bssid: '' })).success).toBe(true);
    // The broadcast button: one MSG to every node, answered at once (count 1, not a repeating job).
    expect(accepts('message_send', BROADCAST_PING)).toMatchObject({ success: true, data: { to: 'broadcast', topic: 'ping', count: 1 } });
    // The stages the hub's device_provision job goes through, in its order (hub registry/provision.ts).
    const src = readFileSync(resolve(import.meta.dirname, '../../hub/src/registry/provision.ts'), 'utf8');
    expect([...src.matchAll(/ctx\.stage\('(\w+)'\)/g)].map((m) => m[1])).toEqual([...PROVISION_STAGES]);
  });
});
