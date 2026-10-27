// The agent text of M2-C2 against the code it describes (design m2-c2 D15, D19, D20, D21; the C2 review's
// agents-docs-1, agent-docs-3, agents-docs-5 and agents-docs-2). parity.test.ts keeps the four skills' shared rules
// identical; this file checks what they say about LOG over TCP, the sim tier's verdict and D19's pass rule.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { LAG_P99_LIMIT_MS, PREFLIGHT_LAG_P99_MS, PREFLIGHT_MAX_WAIT_MS } from '../../../tests/sim/lib/verdict.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (p: string) => readFileSync(join(REPO, p), 'utf8');
const SKILLS = ['build-deploy', 'e2e-verify', 'fleet-ops', 'hil-rig'].map((s) => `plugin/skills/${s}/SKILL.md`);
const DOCS = [...SKILLS, 'plugin/AGENTS.md'];
const shared = (p: string) => /^## Shared rules\n[\s\S]*?(?=\n## )/m.exec(read(p))?.[0] ?? '';
const num = (text: string, re: RegExp, what: string) => {
  const m = re.exec(text);
  expect(m, what).not.toBeNull();
  return Number(m![1].replace(/'/g, ''));
};

describe('LOG over TCP in the agent text (design m2-c2 D20, D21)', () => {
  // The firmware's own limits: the level floor (Kconfig), the drain's rate and age (net.hpp), the drop line (log.cpp).
  const level = num(read('firmware/components/fr_net/Kconfig'), /config FR_NET_LOG_LEVEL[\s\S]*?default (\d)/, 'FR_NET_LOG_LEVEL default');
  const perS = num(read('firmware/components/fr_net/include/fr/net/net.hpp'), /kLogPerS = (\d+);/, 'kLogPerS');
  const ageS = num(read('firmware/components/fr_net/include/fr/net/net.hpp'), /kLogMaxAgeMs = ([\d']+);/, 'kLogMaxAgeMs') / 1000;

  it('says which lines Wi-Fi carries, at what rate and age, and that the rest needs USB (agent-docs-3)', () => {
    expect(level).toBe(3); // E, W and I
    expect(read('firmware/components/fr_net/src/core/log.cpp')).toContain('fr_net: %" PRIu32 " log lines dropped"');
    const facts = ['E, W and I `ESP_LOG` lines logged after start-up', `at most ${perS} lines/s`, `none older than ${ageS} s`, '`fr_net: <n> log lines dropped`', 'D and V lines', 'bootloader and early-boot output', 'panic or abort text', 'only over USB'];
    for (const p of SKILLS) {
      for (const f of facts) {
        expect(shared(p), `${p}: ${f}`).toContain(f);
      }
    }
    for (const f of facts) {
      expect(read('plugin/AGENTS.md'), `AGENTS.md: ${f}`).toContain(f);
    }
    // deploy's expectation names it too: a D/V line or boot output never arrives from a Wi-Fi-only device.
    expect(read('plugin/skills/build-deploy/SKILL.md')).toContain('On a Wi-Fi-only device, expect an E, W or I line logged after start-up');
  });

  it('never offers a panic-text forbid without saying it needs USB and how to check a Wi-Fi-only node (agents-docs-1)', () => {
    const resets = new Set([...read('firmware/components/fr_diag/src/diag.cpp').matchAll(/case ESP_RST_\w+:\s*return "([A-Z_]+)";/g)].map((m) => m[1]));
    const crashes = ['PANIC', 'TASK_WDT', 'INT_WDT', 'WDT', 'BROWNOUT'];
    expect(crashes.filter((r) => !resets.has(r))).toEqual([]);
    for (const p of DOCS) {
      const text = read(p);
      if (text.includes('Guru Meditation')) {
        expect(text, p).toMatch(/panic and abort text, ROM and bootloader output reach the hub only over USB|panic or abort text \(`Guru Meditation`, `abort\(\)`\)\s+come only over USB/);
      }
      // Each reset reason a doc forbids is one the banner can print, and the crash ones are all there.
      const named = [...text.matchAll(/reset=([A-Z_]+)/g)].map((m) => m[1]);
      expect(named.filter((r) => !resets.has(r)), p).toEqual([]);
      if (named.length > 0) {
        expect(crashes.filter((r) => !named.includes(r)), p).toEqual([]);
      }
    }
    for (const p of SKILLS) {
      expect(shared(p), p).toContain('forbid: ["reset=PANIC", "reset=TASK_WDT", "reset=INT_WDT", "reset=WDT", "reset=BROWNOUT"]');
    }
    const logs = /^## Logs\n[\s\S]*?(?=\n## )/m.exec(read('plugin/skills/e2e-verify/SKILL.md'))?.[0] ?? '';
    expect(logs).toContain('That crash check needs USB');
    expect(logs).toContain('expect: ["fr: ready"], forbid: ["reset=PANIC"');
    expect(read('plugin/AGENTS.md')).toContain("--expect 'fr: ready' --forbid 'reset=PANIC'");
    // The check works because the banner carries the reset reason and is logged after the net log ring is on, so a
    // Wi-Fi-only node sends it (core.cpp); logs_assert tests forbid first, the banner line too (logs-assert.test.ts).
    const core = read('firmware/components/fr_core/src/core.cpp');
    expect(core).toMatch(/"reset=%s slot=%s[^;]*diag::reset_reason\(\)/);
    const enabled = core.indexOf('serial::enable_net_logs(');
    expect(enabled).toBeGreaterThan(0);
    expect(core.indexOf('"ready id=%s')).toBeGreaterThan(enabled);
  });
});

describe("the sim tier's verdict in e2e-verify (design m2-c2 D15, §5.6; agents-docs-2)", () => {
  const t2 = read('plugin/skills/e2e-verify/SKILL.md')
    .split('\n')
    .find((l) => l.startsWith('- The T2 virtual fleet'));

  it('describes D15 as designed: a loaded Mac is not run, a lagged run is re-run once at half the rates', () => {
    expect(t2).toBeDefined();
    // No gate status `inconclusive` exists (tests/e2e/lib/report.ts), so the text never reports one.
    const statuses = /export type GateStatus = ([^;]+);/.exec(read('tests/e2e/lib/report.ts'))![1];
    expect(statuses).not.toContain('inconclusive');
    expect(t2).not.toMatch(/reports `inconclusive`|status `inconclusive`/);
    // The preflight: its limits and its outcome, never re-run (D15: "That outcome is not a first run").
    expect(t2).toContain(`waits up to ${PREFLIGHT_MAX_WAIT_MS / 60_000} min for a quiet Mac`);
    expect(t2).toContain(`runner lag p99 at most ${PREFLIGHT_LAG_P99_MS} ms`);
    expect(t2).toContain('the scenario is not run and never re-run');
    expect(t2).toContain('`measured.inconclusive.reason: "host_load"`');
    expect(read('tests/sim/lib/runner.ts')).toContain("inconclusive: { reason: 'host_load' }");
    // A lagged run: re-run once at half the rates, a second inconclusive run fails.
    expect(t2).toContain(`lag p99 exceeds ${LAG_P99_LIMIT_MS} ms, or with a stall over 1 s, is inconclusive: it is re-run once at half the rates, and a second inconclusive run fails`);
    const d15 = read('docs/design/m2-c2-t2-fleet.md').split('\n').find((l) => l.startsWith('| D15 |'))!;
    expect(d15).toContain('That outcome is not a first run.');
    expect(d15).toContain('It is re-run once at half the time scale, and a second inconclusive run fails.');
    // §5.6: a gate passes conclusively, so only an entry with status pass counts, whatever the job's pass says.
    expect(t2).toContain("A T2 gate counts only when its own entry's `status` is `pass`");
  });
});

describe("D19's pass rule (design m2-c2 D19, §5.2, §5.4 T2-FLOOD-B-30 (c), §7 item 4; agents-docs-5)", () => {
  const design = read('docs/design/m2-c2-t2-fleet.md');
  const d19 = design.split('\n').find((l) => l.startsWith('| D19 |'))!;
  const floodB = design.split('\n').find((l) => l.startsWith('| T2-FLOOD-B-30 |'))!;
  const cpp = read('firmware/test/host/tests/net_t2_scale_test.cpp');
  const hubRestart = cpp.slice(cpp.indexOf('TEST(net_t2_scale_hub_restart)')).split(/\nTEST\(/)[0];

  it('states one rule in the design, the host case and the epoch scenario', () => {
    const rule = "≥ 99 % of the new run's 200 broadcasts (at most 2 missed";
    expect(d19).toContain(rule);
    expect(d19).not.toMatch(/99\.9 % of the new run/);
    // Proposed by the design; the user has not approved it (design §7 item 4).
    expect(floodB).toContain(`(c) (proposed, §7 item 4): each of the 26 Wi-Fi-only nodes delivers ${rule})`);
    expect(design).toContain("4. **D19's pass rule: ≥ 99 % (proposed by the design, not yet approved by you).**");
    expect(design).not.toMatch(/D19's pass rule: ≥ 99 %, approved/);
    // The host case: 200 broadcasts of the new run, at most 2 missed, gated.
    expect(hubRestart).toContain('constexpr uint32_t kMaxMissed = 2;');
    expect(hubRestart).toContain('constexpr uint32_t kN = 200;');
    expect(hubRestart).toContain('constexpr bool kAdoptionGated = true;');
    // The wall-clock epoch run: --after 200 at --min-delivery 99, i.e. the same 2 of 200.
    const epoch = /- name: epoch\n\s+run: flood-b-epoch\n\s+args: \[([^\]]+)\]/.exec(read('tests/sim/scenarios/t2-flood-b-30.yaml'))![1];
    expect(epoch).toMatch(/--after, '200'/);
    expect(epoch).toMatch(/--min-delivery, '99'/);
    expect(200 - Math.ceil((200 * 99) / 100)).toBe(2);
  });

  it('gates it in every T2-SCALE run, as D19 and §5.2 say, not only under FR_T2_PUBLISH', () => {
    expect(d19).toContain('It is gated in every T2-SCALE run');
    expect(design).toContain("`t2_scale_hub_restart` (30 nodes, 4 on USB) passes D19's rule at each seed");
    expect(hubRestart.includes('publish('), 'net_t2_scale_hub_restart must not return early without FR_T2_PUBLISH').toBe(false);
    // The file's header lists the published cases as never gated: D19's must not be among them.
    const header = cpp.slice(0, cpp.indexOf('#include'));
    const published = /FR_T2_PUBLISH=1:[\s\S]*?never gated\./.exec(header)?.[0] ?? '';
    expect(published.includes('D19'), "the header must not list D19's case as published, never gated").toBe(false);
  });
});
