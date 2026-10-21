// The hub's OTA wire values against the node's (design c4 §3, §8 item 5): fr::ota's enums and constants
// in firmware/components/fr_ota/include/fr/ota/defs.hpp are what fr_ota sends and expects; the orchestrator
// reads and writes OTA frames with the tables below. A drift on either side fails here, without a C++ build.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ACCEPT_CODES, FAILED_REASONS, NODE_HTTP_PORT, OFFER_FLAGS, OUTCOME, PHASE, REJECT_NAMES, ROLLBACK_REASONS } from '../src/ota/index.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DEFS = readFileSync(resolve(REPO, 'firmware', 'components', 'fr_ota', 'include', 'fr', 'ota', 'defs.hpp'), 'utf8');

/** `enum class <name> : uint8_t { a = 1, ... }` of defs.hpp as {a: 1, ...} (comments dropped). */
function cppEnum(name: string): Record<string, number> {
  const m = new RegExp(`enum class ${name}\\s*:\\s*uint8_t\\s*\\{([^}]*)\\}`).exec(DEFS);
  if (!m) {
    throw new Error(`enum class ${name} is not in defs.hpp`);
  }
  const body = m[1].replace(/\/\/[^\n]*/g, '');
  return Object.fromEntries([...body.matchAll(/(\w+)\s*=\s*(\d+)/g)].map(([, k, v]) => [k, Number(v)]));
}

/** A code -> name table of the hub turned around: name -> code. */
const byName = (t: Readonly<Record<number, string>>) => Object.fromEntries(Object.entries(t).map(([code, name]) => [name, Number(code)]));

describe('OTA wire values: hub and fr_ota agree', () => {
  it('REJECT codes', () => {
    expect(byName(REJECT_NAMES)).toEqual(cppEnum('Reject'));
  });

  it('STATUS states and ACCEPT codes', () => {
    expect(PHASE).toEqual(cppEnum('Phase'));
    expect(ACCEPT_CODES).toEqual(cppEnum('Accept'));
  });

  it('RESULT outcomes and reasons', () => {
    expect(OUTCOME).toEqual(cppEnum('Outcome'));
    expect(byName(ROLLBACK_REASONS)).toEqual(cppEnum('RollbackReason'));
    expect(byName(FAILED_REASONS)).toEqual(cppEnum('FailReason'));
  });

  it('OFFER flags and the node HTTP port', () => {
    const flags = Object.fromEntries(
      [...DEFS.matchAll(/constexpr uint32_t kOffer(\w+) = 1u << (\d+);/g)].map(([, k, bit]) => [k.replace(/(?<=.)([A-Z])/g, '_$1').toLowerCase(), 1 << Number(bit)]),
    );
    expect(flags).toEqual(OFFER_FLAGS);
    expect(Number(/constexpr uint16_t kHttpPort = (\d+);/.exec(DEFS)?.[1])).toBe(NODE_HTTP_PORT);
  });
});
