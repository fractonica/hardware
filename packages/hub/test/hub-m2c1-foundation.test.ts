// The M2-C1 foundation as the hub sees it (design m2-c1-hil §3): what a hub without a fixture module answers
// for the new ops (S4 and S5 replaced F's placeholders, fixture/stubs.ts, which I1 deleted), the `fixture` role
// through selectors, and `fr codegen client` leaving a test_only capability out.

import { describe, expect, it } from 'vitest';

import { findOp, type FrError, type OpName } from '@fractonica/protocol';
import { findCap } from '@fractonica/protocol/gen';

import { clientCaps } from '../src/apps/client-gen.ts';
import type { Device, HubContext } from '../src/context.ts';
import { HANDLERS } from '../src/ops.ts';
import { parseSelector, selectDevices } from '../src/registry/selector.ts';

const HUB = {} as HubContext;

async function refusal(name: OpName, input: Record<string, unknown>): Promise<FrError> {
  const parsed = findOp(name)!.input.parse(input);
  try {
    await HANDLERS[name](parsed, HUB);
  } catch (e) {
    return e as FrError;
  }
  throw new Error(`${name} did not refuse ${JSON.stringify(input)}`);
}

describe('M2-C1 ops on a hub without a fixture module', () => {
  it('answers bench_get NOT_FOUND: no fixture module, no bench', async () => {
    expect(await refusal('bench_get', {})).toMatchObject({ code: 'NOT_FOUND', message: expect.stringMatching(/no fixture module/) });
  });

  it('refuses input_simulate layer gpio, and bounce on the inject layer, before reaching a device', async () => {
    expect(await refusal('input_simulate', { selector: 'pad-c6', instance: 'boot', gesture: 'click', layer: 'gpio' })).toMatchObject({
      code: 'NOT_FOUND',
      message: expect.stringMatching(/no fixture module/),
    });
    expect(await refusal('input_simulate', { selector: 'pad-c6', instance: 'boot', gesture: 'bounce' })).toMatchObject({
      code: 'INVALID_ARGS',
      message: expect.stringMatching(/gpio-only/),
    });
  });

  it('keeps test_run tier sim reserved (NOT_FOUND until M2-C2); hil and args reach the runner', async () => {
    expect(await refusal('test_run', { source_dir: '/x', tier: 'sim' })).toMatchObject({ code: 'NOT_FOUND', details: { not_implemented: 'test_run tier sim' } });
    // Past the tier gate: the refusal is the runner's own (a source_dir that is no checkout), not a placeholder's.
    for (const input of [
      { source_dir: '/x', tier: 'hil' },
      { source_dir: '/x', tier: 'target', suite: 't-lat', args: ['--rounds', '3'] },
    ]) {
      const e = await refusal('test_run', input);
      expect(e.details?.not_implemented).toBeUndefined();
    }
  });
});

describe('the fixture role in selectors', () => {
  const dev = (device_id: string, alias: string, role: Device['role']): Device => ({
    device_id,
    addr: null,
    alias,
    alias_rev: 1,
    net: null,
    board: null,
    profile: null,
    chip: 'esp32s3',
    tags: [],
    role,
    fw_id: null,
    provisioned: true,
    last_seen: null,
    last_epoch: null,
    created_at: '',
  });
  const devices = [dev('94a99015cecc', 'pad-s3', 'node'), dev('e8f60a81bc48', 'fix-s3', 'fixture')];

  it('is a role: value (the candidate-set rule is the selector change of stream S5)', () => {
    expect(parseSelector('role:fixture')).toEqual([{ neg: false, facet: 'role', value: 'fixture', text: 'role:fixture' }]);
    expect(selectDevices(devices, 'role:fixture', () => 'online').map((d) => d.alias)).toEqual(['fix-s3']);
    expect(() => parseSelector('role:hub')).toThrow(/role: is one of node, gateway, fixture/);
  });
});

describe('fr codegen client (design m2-c1-hil D3)', () => {
  it('leaves out the instances of a test_only capability', () => {
    expect(findCap('fr.fixture')?.testOnly).toBe(true);
    expect(findCap('fr.led')?.testOnly).toBeUndefined();
    expect(
      clientCaps([
        { name: 'status', cap: 'fr.led' },
        { name: 'ch0', cap: 'fr.fixture' },
        { name: 'boot', cap: 'fr.button' },
        { name: 'mystery', cap: 'x.unknown' },
      ]),
    ).toEqual([
      { name: 'status', cap: 'fr.led' },
      { name: 'boot', cap: 'fr.button' },
      { name: 'mystery', cap: 'x.unknown' },
    ]);
  });
});
