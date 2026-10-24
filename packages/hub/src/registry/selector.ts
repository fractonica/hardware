// Device selectors (spec 09 §9.2):
//   selector := term ("," term)*      term := ["!"] atom
//   atom := <alias> | id:<12hex> | mac:<..> | tag:<t> | board:<b> | chip:<esp32c3|esp32c6|esp32s3>
//         | profile:<p> | role:<node|gateway|fixture> | online | offline | all
// The grammar leaves how terms combine open; the registry decides it the way faceted filters work, so
// every example in the spec reads as meant: positive atoms of one facet are alternatives (union), facets
// narrow each other (intersection), and `!` terms are taken away at the end. A selector of `!` terms
// only starts from every device.
//   "pad-red-1,pad-blue-2"   either device (one facet: names)
//   "chip:esp32c6,online"    C6 devices that are online
//   "tag:poc,!pad-blue-2"    the poc devices except pad-blue-2
// The HIL fixture (role fixture, design m2-c1-hil D6) is an instrument, never a target by accident: it is a
// candidate only when a positive alias, id:, mac: or role:fixture atom names it, and the other facets then
// filter it as usual ("role:fixture,online" is an online fixture). So `all`, a selector of `!` terms only
// and every other facet ("chip:esp32s3", "tag:poc", "profile:s3k-fixture") leave it out.
// Names (alias, id, mac) that match no device are NOT_FOUND, so a typo never turns into an empty fan-out
// or a silently wider `!` term; the facets may match nothing.

import { DEVICE_ROLES, FrError } from '@fractonica/protocol';

import type { Device, Presence } from '../context.ts';

export const CHIPS = ['esp32c3', 'esp32c6', 'esp32s3'] as const;
/** The `role:` values: 05 §5.7 Role, as protocol DEVICE_ROLES lists them (`fixture`: design m2-c1-hil D6). */
const ROLES: readonly string[] = DEVICE_ROLES;

/** The fixture candidate-set rule (D6), as the selector hint states it. */
export const FIXTURE_RULE = 'a fixture (role:fixture) is selected only by its alias, id:, mac: or role:fixture; all and !-only selectors leave it out';

type Facet = 'name' | 'tag' | 'board' | 'chip' | 'profile' | 'role' | 'presence' | 'all';

export interface Atom {
  neg: boolean;
  facet: Facet;
  /** name: a device_id or a lower-case alias (`byId` says which); presence: online | offline. */
  value: string;
  byId?: boolean;
  /** The term as written, for errors. */
  text: string;
}

const HEX12 = /^[0-9a-f]{12}$/;

function bad(term: string, why: string): FrError {
  return new FrError('INVALID_ARGS', `bad selector term ${JSON.stringify(term)}: ${why}`, {
    hint: `selector := term ("," term)*, term := ["!"] alias | id:<12hex> | mac:<mac> | tag:<t> | board:<b> | chip:<esp32c3|esp32c6|esp32s3> | profile:<p> | role:<${ROLES.join('|')}> | online | offline | all; ${FIXTURE_RULE}`,
  });
}

/** `aa:bb:cc:dd:ee:ff`, `AA-BB-…` or 12 hex digits -> 12 lower-case hex digits, else null. */
export function macToId(mac: string): string | null {
  const hex = mac.replace(/[:\-.]/g, '').toLowerCase();
  return HEX12.test(hex) ? hex : null;
}

export function parseSelector(selector: string): Atom[] {
  const terms = selector.split(',').map((t) => t.trim());
  if (!selector.trim() || terms.some((t) => !t)) {
    throw bad(selector, 'empty term');
  }
  return terms.map((text): Atom => {
    const neg = text.startsWith('!');
    const body = (neg ? text.slice(1) : text).trim();
    const colon = body.indexOf(':');
    if (colon < 0) {
      const word = body.toLowerCase();
      if (!word) {
        throw bad(text, 'empty term');
      }
      if (word === 'all') {
        return { neg, facet: 'all', value: word, text };
      }
      if (word === 'online' || word === 'offline') {
        return { neg, facet: 'presence', value: word, text };
      }
      // A bare 12-hex word is a device id: aliases may not look like one (registry/names.ts).
      return HEX12.test(word) ? { neg, facet: 'name', value: word, byId: true, text } : { neg, facet: 'name', value: word, text };
    }
    const key = body.slice(0, colon).toLowerCase();
    const value = body.slice(colon + 1).trim();
    if (!value) {
      throw bad(text, `${key}: needs a value`);
    }
    switch (key) {
      case 'id': {
        const id = value.toLowerCase();
        if (!HEX12.test(id)) {
          throw bad(text, 'id: takes 12 hex digits (the factory MAC)');
        }
        return { neg, facet: 'name', value: id, byId: true, text };
      }
      case 'mac': {
        const id = macToId(value);
        if (!id) {
          throw bad(text, 'mac: takes a 48-bit MAC (aa:bb:cc:dd:ee:ff)');
        }
        return { neg, facet: 'name', value: id, byId: true, text };
      }
      case 'chip':
        if (!(CHIPS as readonly string[]).includes(value.toLowerCase())) {
          throw bad(text, `chip: is one of ${CHIPS.join(', ')}`);
        }
        return { neg, facet: 'chip', value: value.toLowerCase(), text };
      case 'role':
        if (!ROLES.includes(value.toLowerCase())) {
          throw bad(text, `role: is one of ${ROLES.join(', ')}`);
        }
        return { neg, facet: 'role', value: value.toLowerCase(), text };
      case 'tag':
      case 'board':
      case 'profile':
        return { neg, facet: key, value: value.toLowerCase(), text };
      default:
        throw bad(text, `unknown atom ${key}:`);
    }
  });
}

/** Presence an `online` / `offline` atom accepts: a suspect device is still online until it times out. */
function presenceMatches(want: string, p: Presence): boolean {
  return want === 'online' ? p === 'online' || p === 'suspect' : p === 'offline' || p === 'unknown';
}

function matches(atom: Atom, d: Device, presence: (id: string) => Presence): boolean {
  switch (atom.facet) {
    case 'all':
      return true;
    case 'name':
      return atom.byId ? d.device_id === atom.value : d.alias.toLowerCase() === atom.value;
    case 'tag':
      return d.tags.includes(atom.value);
    case 'board':
      return d.board?.toLowerCase() === atom.value;
    case 'chip':
      return d.chip === atom.value;
    case 'profile':
      return d.profile?.toLowerCase() === atom.value;
    case 'role':
      return d.role === atom.value;
    case 'presence':
      return presenceMatches(atom.value, presence(d.device_id));
  }
}

/** Whether a positive atom brings a fixture into the candidate set (D6): it names the device, or is role:fixture. */
function namesFixture(atom: Atom, d: Device): boolean {
  return (atom.facet === 'name' || (atom.facet === 'role' && atom.value === 'fixture')) && matches(atom, d, () => 'unknown');
}

/** The devices `selector` picks out of `devices`, in the order given. */
export function selectDevices(devices: readonly Device[], selector: string, presence: (id: string) => Presence): Device[] {
  const atoms = parseSelector(selector);
  for (const a of atoms) {
    if (a.facet === 'name' && !devices.some((d) => matches(a, d, presence))) {
      throw new FrError('NOT_FOUND', `no device ${a.byId ? 'with id' : 'named'} ${a.value} (in selector ${JSON.stringify(selector)})`, {
        remediation: [{ tool: 'device_list', cli: 'fr devices ls' }],
      });
    }
  }
  const positive = atoms.filter((a) => !a.neg);
  const negative = atoms.filter((a) => a.neg);
  const facets = new Map<Facet, Atom[]>();
  for (const a of positive) {
    facets.set(a.facet, [...(facets.get(a.facet) ?? []), a]);
  }
  // Presence is asked once per device, not once per atom: the router's answer can change between calls.
  const cache = new Map<string, Presence>();
  const presenceOnce = (id: string) => {
    let p = cache.get(id);
    if (p === undefined) {
      p = presence(id);
      cache.set(id, p);
    }
    return p;
  };
  // The candidate set: every device except a fixture that no positive alias, id:, mac: or role:fixture names.
  return devices.filter(
    (d) =>
      (d.role !== 'fixture' || positive.some((a) => namesFixture(a, d))) &&
      [...facets.values()].every((alts) => alts.some((a) => matches(a, d, presenceOnce))) &&
      !negative.some((a) => matches(a, d, presenceOnce)),
  );
}
