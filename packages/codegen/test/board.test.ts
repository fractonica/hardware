import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';

import { generateFirmware, listDrivers, loadDriver, resolveProfile, slotsLockFile, type FirmwareResult } from '../src/board.ts';
import { formatIssue, loadModel, SchemaError, type SchemaIssue } from '../src/model.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MODEL = loadModel(ROOT);
const PROFILES = ['c3o-pad', 'c6-pad', 'c6-pad-mono'];

type Yaml = Record<string, any>;

const temps: string[] = [];

afterEach(() => {
  for (const d of temps.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

/** A scratch checkout with the inputs `fr gen firmware` reads; slots.locks are left out unless asked. */
function fixture(opts: { locks?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'fr-board-'));
  temps.push(dir);
  cpSync(join(ROOT, 'hardware'), join(dir, 'hardware'), { recursive: true });
  cpSync(join(ROOT, 'firmware', 'partitions'), join(dir, 'firmware', 'partitions'), { recursive: true });
  cpSync(join(ROOT, 'firmware', 'profiles'), join(dir, 'firmware', 'profiles'), {
    recursive: true,
    filter: (src) => opts.locks === true || !src.endsWith('.slots.lock'),
  });
  cpSync(join(ROOT, 'firmware', 'apps', 'node', 'CMakeLists.txt'), join(dir, 'firmware', 'apps', 'node', 'CMakeLists.txt'));
  return dir;
}

function edit(dir: string, rel: string, fn: (y: Yaml) => void): void {
  const file = join(dir, rel);
  const y = parse(readFileSync(file, 'utf8')) as Yaml;
  fn(y);
  writeFileSync(file, stringify(y));
}

const PROFILE = (p: string) => `firmware/profiles/${p}.profile.yaml`;
const C6 = 'hardware/boards/esp32c6-supermini.board.yaml';

function gen(dir: string, profile: string, write = true): FirmwareResult {
  return generateFirmware({ sourceDir: dir, profile, outDir: join(dir, 'build', profile, 'fr_gen'), write, model: MODEL });
}

function issuesOf(fn: () => unknown): SchemaIssue[] {
  try {
    fn();
  } catch (e) {
    if (e instanceof SchemaError) {
      return e.issues;
    }
    throw e;
  }
  throw new Error('expected a SchemaError');
}

function file(r: FirmwareResult, path: string): string {
  const f = r.files.find((x) => x.path === path);
  if (!f) {
    throw new Error(`no ${path}`);
  }
  return f.content;
}

function locked(dir: string, profile: string): Record<string, number> {
  return parse(readFileSync(join(dir, slotsLockFile(profile)), 'utf8')) as Record<string, number>;
}

describe('the M1 profiles', () => {
  it.each(PROFILES)('%s generates against the committed slots.lock without changing it', (p) => {
    const r = generateFirmware({ sourceDir: ROOT, profile: p, outDir: join(tmpdir(), 'unused'), write: false, model: MODEL });
    expect(r.slotsLockChanged).toBe(false);
    expect(r.slotsLock.content).toBe(readFileSync(join(ROOT, slotsLockFile(p)), 'utf8'));
    expect(r.manifest.caps.map((c) => [c.name, c.port])).toEqual([
      ['boot', 1],
      ['status', 2],
    ]);
    expect(r.files.map((f) => f.path)).toEqual([
      'fr_board/CMakeLists.txt',
      'fr_board/include/fr/board.hpp',
      'fr_board/fr_board.cpp',
      'components.cmake',
      'sdkconfig.board',
      'fr_manifest.json',
    ]);
  });

  it('c6-pad: manifest, driver and service config, bound drivers only', () => {
    const r = gen(fixture({ locks: true }), 'c6-pad', false);
    expect(r.manifest).toEqual({
      schema: 'fractonica/fr-manifest@1',
      profile: 'c6-pad',
      board: 'esp32c6-supermini',
      app: 'node',
      target: 'esp32c6',
      catalog_hash: r.manifest.catalog_hash,
      caps: [
        {
          name: 'boot',
          port: 1,
          cap: 'fr.button',
          cap_id: 1,
          version: '1.0',
          driver: 'button_gpio',
          config: { debounce_ms: 20, long_press_ms: 600, multi_press_gap_ms: 250, multi_press_max: 2 },
        },
        { name: 'status', port: 2, cap: 'fr.led', cap_id: 2, version: '1.0', driver: 'led_ws2812', config: { max_brightness: 64 } },
      ],
    });
    expect(JSON.parse(file(r, 'fr_manifest.json'))).toEqual(r.manifest);
    const cpp = file(r, 'fr_board/fr_board.cpp');
    expect(cpp).toContain('c.pull = fr::drv::ButtonGpio::Pull::external;');
    expect(cpp).toContain('c.color_order = fr::drv::LedWs2812::ColorOrder::GRB;');
    expect(cpp).toContain('c.max_brightness = 64;');
    expect(cpp).toContain('{1, "boot", &inst_boot::service, &s_init[0], [] { return inst_boot::service.selftest(); }},');
    expect(file(r, 'fr_board/CMakeLists.txt')).toContain('PRIV_REQUIRES button_gpio led_ws2812)');
    const hpp = file(r, 'fr_board/include/fr/board.hpp');
    for (const decl of ['std::span<const Instance> instances();', 'void attach(cap::Sink &sink);', 'Status init(Core &core);', 'hal::Selftest selftest(const char *name);']) {
      expect(hpp).toContain(decl);
    }
    expect(hpp).toContain('#include "fr/services/button_service.hpp"\n#include "fr/services/led_service.hpp"');
    const cmake = file(r, 'components.cmake');
    expect(cmake).toContain('"${CMAKE_CURRENT_LIST_DIR}"');
    expect(cmake).toMatch(/hardware\/drivers\/button_gpio"\n.*hardware\/drivers\/led_ws2812"\n\)/);
    expect(cmake).not.toContain('led_gpio');
    expect(cmake).toContain('\nset(FR_PROFILE "c6-pad")\n');
  });

  it('c6-pad-mono swaps the driver and nothing else', () => {
    const r = gen(fixture({ locks: true }), 'c6-pad-mono', false);
    expect(r.manifest.caps[1]).toMatchObject({ name: 'status', port: 2, driver: 'led_gpio', config: { max_brightness: 255 } });
    expect(file(r, 'fr_board/fr_board.cpp')).toContain('c.gpio = 15;');
    expect(file(r, 'fr_board/CMakeLists.txt')).toContain('PRIV_REQUIRES button_gpio led_gpio)');
    expect(file(r, 'components.cmake')).not.toContain('led_ws2812');
  });

  it('c3o-pad: active-low LED and an internal pull-up from the board', () => {
    const cpp = file(gen(fixture({ locks: true }), 'c3o-pad', false), 'fr_board/fr_board.cpp');
    expect(cpp).toContain('c.pull = fr::drv::ButtonGpio::Pull::up;');
    expect(cpp).toMatch(/LedGpio::Config c\{\};\n {4}c\.gpio = 8;\n {4}c\.active_level = fr::drv::LedGpio::ActiveLevel::low;/);
  });

  it('sdkconfig.board has the content the hub rendered before (spec 03 §3.7 layer 3)', () => {
    const dir = fixture({ locks: true });
    const r = gen(dir, 'c6-pad', false);
    expect(file(r, 'sdkconfig.board')).toBe(
      [
        '# GENERATED by `fr gen firmware` from the profile and board manifest. Do not edit.',
        'CONFIG_IDF_TARGET="esp32c6"',
        'CONFIG_ESPTOOLPY_FLASHSIZE_4MB=y',
        `CONFIG_PARTITION_TABLE_CUSTOM_FILENAME="${join(dir, 'firmware', 'partitions', 'fr-4mb-v1.csv')}"`,
        'CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG=y',
        'CONFIG_FR_BOARD="esp32c6-supermini"',
        'CONFIG_FR_PROFILE="c6-pad"',
        'CONFIG_FR_PART_PROFILE="fr-4mb-v1"',
        '',
      ].join('\n'),
    );
    expect(resolveProfile(dir, 'c6-pad')).toEqual({
      profile: 'c6-pad',
      app: 'node',
      board: 'esp32c6-supermini',
      target: 'esp32c6',
      partProfile: 'fr-4mb-v1',
      fragment: file(r, 'sdkconfig.board'),
    });
  });

  it('output is deterministic', () => {
    const a = gen(fixture(), 'c6-pad', false);
    const b = gen(fixture(), 'c6-pad', false);
    // Only the absolute source paths differ between the two checkouts.
    const strip = (r: FirmwareResult) => r.files.map((f) => ({ ...f, content: f.content.replaceAll(/\/[^"\n]*fr-board-[^/]+/g, '<src>') }));
    expect(strip(a)).toEqual(strip(b));
    expect(a.slotsLock).toEqual(b.slotsLock);
    expect(a.warnings).toEqual(b.warnings);
  });
});

describe('writing', () => {
  it('writes the glue and a new slots.lock; a second run rewrites nothing', () => {
    const dir = fixture();
    const out = join(dir, 'build', 'c6-pad', 'fr_gen');
    const first = gen(dir, 'c6-pad');
    expect(first.slotsLockChanged).toBe(true);
    expect(locked(dir, 'c6-pad')).toEqual({ boot: 1, status: 2 });
    for (const f of first.files) {
      expect(readFileSync(join(out, f.path), 'utf8')).toBe(f.content);
    }
    const lockMtime = statSync(join(dir, slotsLockFile('c6-pad'))).mtimeMs;
    const cppMtime = statSync(join(out, 'fr_board/fr_board.cpp')).mtimeMs;
    const second = gen(dir, 'c6-pad');
    expect(second.slotsLockChanged).toBe(false);
    expect(statSync(join(dir, slotsLockFile('c6-pad'))).mtimeMs).toBe(lockMtime);
    // An unchanged file keeps its mtime, so ninja does not rebuild fr_board.
    expect(statSync(join(out, 'fr_board/fr_board.cpp')).mtimeMs).toBe(cppMtime);
  });

  it('write: false writes nothing, not even the slots.lock', () => {
    const dir = fixture();
    const r = gen(dir, 'c6-pad', false);
    expect(r.slotsLockChanged).toBe(true);
    expect(existsSync(join(dir, slotsLockFile('c6-pad')))).toBe(false);
    expect(existsSync(join(dir, 'build'))).toBe(false);
  });
});

describe('slots.lock', () => {
  it('first generation numbers instances in profile order', () => {
    const dir = fixture();
    edit(dir, PROFILE('c6-pad'), (y) => {
      y.caps = { status: y.caps.status, boot: y.caps.boot };
    });
    gen(dir, 'c6-pad');
    expect(locked(dir, 'c6-pad')).toEqual({ status: 1, boot: 2 });
  });

  it('ports survive reordering, additions and removals, and are never reused', () => {
    const dir = fixture();
    gen(dir, 'c6-pad');
    expect(locked(dir, 'c6-pad')).toEqual({ boot: 1, status: 2 });

    edit(dir, PROFILE('c6-pad'), (y) => {
      y.caps = { status: y.caps.status, boot: y.caps.boot };
    });
    const reordered = gen(dir, 'c6-pad');
    expect(reordered.slotsLockChanged).toBe(false);
    expect(reordered.manifest.caps.map((c) => [c.name, c.port])).toEqual([
      ['boot', 1],
      ['status', 2],
    ]);

    edit(dir, PROFILE('c6-pad'), (y) => {
      y.caps.mono = { cap: 'fr.led', driver: 'led_gpio', bind: 'leds.status' };
    });
    const added = gen(dir, 'c6-pad');
    expect(added.slotsLockChanged).toBe(true);
    expect(locked(dir, 'c6-pad')).toEqual({ boot: 1, status: 2, mono: 3 });

    // boot leaves the profile: its port stays taken, so the next newcomer gets 4, not 1.
    edit(dir, PROFILE('c6-pad'), (y) => {
      delete y.caps.boot;
    });
    const removed = gen(dir, 'c6-pad');
    expect(removed.slotsLockChanged).toBe(false);
    expect(removed.manifest.caps.map((c) => [c.name, c.port])).toEqual([
      ['status', 2],
      ['mono', 3],
    ]);
    edit(dir, PROFILE('c6-pad'), (y) => {
      y.caps.key = { cap: 'fr.button', driver: 'button_gpio', bind: 'buttons.boot' };
    });
    gen(dir, 'c6-pad');
    expect(locked(dir, 'c6-pad')).toEqual({ boot: 1, status: 2, mono: 3, key: 4 });
  });

  it('a profile without instances still generates', () => {
    const dir = fixture();
    writeFileSync(join(dir, PROFILE('bare')), 'profile: bare\nboard: esp32c6-supermini\napp: node\ncaps: {}\n');
    const r = gen(dir, 'bare');
    expect(r.manifest.caps).toEqual([]);
    expect(r.slotsLockChanged).toBe(true);
    expect(locked(dir, 'bare')).toBeNull();
    expect(file(r, 'fr_board/CMakeLists.txt')).toContain('REQUIRES fr_core)');
    expect(file(r, 'fr_board/fr_board.cpp')).toContain('std::span<const Instance> instances()\n{\n    return {};\n}');
    expect(gen(dir, 'bare').slotsLockChanged).toBe(false);
  });

  it('a hand-edited lock wins over profile order', () => {
    const dir = fixture();
    writeFileSync(join(dir, slotsLockFile('c6-pad')), 'status: 7\nboot: 9\n');
    const r = gen(dir, 'c6-pad');
    expect(r.slotsLockChanged).toBe(false);
    expect(r.manifest.caps.map((c) => [c.name, c.port])).toEqual([
      ['status', 7],
      ['boot', 9],
    ]);
  });

  it('rejects duplicate and out-of-range ports', () => {
    const dir = fixture();
    writeFileSync(join(dir, slotsLockFile('c6-pad')), 'boot: 1\nstatus: 1\nold: 240\n');
    const msgs = issuesOf(() => gen(dir, 'c6-pad')).map((i) => `${i.path}: ${i.message}`);
    expect(msgs).toEqual(['status: port 1 is already locked to \'boot\'', 'old: port 240 is outside 1..239']);
  });
});

describe('validation', () => {
  const messages = (dir: string, profile = 'c6-pad') => issuesOf(() => gen(dir, profile)).map((i) => i.message);

  it('rejects a reserved pin', () => {
    const dir = fixture();
    edit(dir, C6, (y) => {
      y.buttons.boot.gpio = 12;
    });
    expect(messages(dir)).toEqual(['GPIO12 (buttons.boot) is reserved for usb on esp32c6-supermini']);
  });

  it('rejects two instances on one pin', () => {
    const dir = fixture();
    edit(dir, PROFILE('c6-pad'), (y) => {
      y.caps.mono = { cap: 'fr.led', driver: 'led_gpio', bind: 'leds.status', config: { gpio: 8 } };
    });
    expect(messages(dir)).toEqual(["GPIO8 (leds.status) is already claimed by 'status'"]);
  });

  it('warns about strapping pins with the level they need at reset', () => {
    const dir = fixture();
    expect(gen(dir, 'c6-pad').warnings).toEqual([
      'boot: GPIO9 (buttons.boot) is a strapping pin and must be high at reset; nothing wired to it may pull it low while the chip resets',
      'status: GPIO8 (leds.rgb) is a strapping pin and must be high at reset; nothing wired to it may pull it low while the chip resets',
    ]);
    expect(gen(dir, 'c6-pad-mono').warnings[1]).toBe('status: GPIO15 (leds.status) is a strapping pin; with default eFuses no level is required at reset');
    edit(dir, C6, (y) => {
      delete y.pins.strapping_levels;
    });
    expect(gen(dir, 'c6-pad').warnings[0]).toBe(
      'boot: GPIO9 (buttons.boot) is a strapping pin; the board manifest does not record the level it needs at reset (pins.strapping_levels)',
    );
  });

  it('rejects a peripheral budget overflow', () => {
    const dir = fixture();
    edit(dir, PROFILE('c6-pad'), (y) => {
      y.caps.second = { cap: 'fr.led', driver: 'led_ws2812', bind: 'leds.rgb', config: { gpio: 14 } };
      y.caps.third = { cap: 'fr.led', driver: 'led_ws2812', bind: 'leds.rgb', config: { gpio: 18 } };
    });
    expect(messages(dir)).toEqual(['rmt_tx budget exceeded: 3 needed (status, second, third), board esp32c6-supermini has 2']);
  });

  it("rejects a profile that needs more of fr_core's timers or input slots than it has", () => {
    const dir = fixture();
    const pins = [0, 1, 2, 3, 14, 18, 19, 20];
    const addButtons = (n: number) =>
      edit(dir, PROFILE('c6-pad'), (y) => {
        for (const [i, gpio] of pins.slice(0, n).entries()) {
          y.caps[`b${i}`] = { cap: 'fr.button', driver: 'button_gpio', bind: 'buttons.boot', config: { gpio } };
        }
      });
    // boot and status take 3 + 1 timers; six more buttons fill the 23 fr_core leaves to services.
    addButtons(6);
    expect(() => gen(dir, 'c6-pad', false)).not.toThrow();
    addButtons(7);
    const all = ['boot', 'status', 'b0', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6'];
    expect(messages(dir)).toEqual([`timer budget exceeded: 25 needed (${all.join(', ')}), fr_core has 23`]);
    addButtons(8);
    expect(messages(dir)).toEqual([
      `input_slot budget exceeded: 9 needed (${['boot', ...all.slice(2), 'b7'].join(', ')}), fr_core has 8`,
      `timer budget exceeded: 28 needed (${[...all, 'b7'].join(', ')}), fr_core has 23`,
    ]);
  });

  it('rejects an unknown driver and a board entry of a kind the driver does not accept', () => {
    const dir = fixture();
    edit(dir, PROFILE('c6-pad'), (y) => {
      y.caps.boot.driver = 'button_touch';
      y.caps.status.bind = 'leds.status';
    });
    expect(messages(dir)).toEqual([
      "unknown driver 'button_touch' (known: button_gpio, led_gpio, led_ws2812)",
      "driver led_ws2812 does not accept leds.status of kind 'gpio' (accepts: ws2812)",
    ]);
  });

  it('rejects a driver for the wrong contract, section, or target', () => {
    const dir = fixture();
    edit(dir, PROFILE('c6-pad'), (y) => {
      y.caps.boot.driver = 'led_gpio';
    });
    edit(dir, 'hardware/drivers/led_ws2812/driver.yaml', (y) => {
      y.targets = ['esp32s3'];
    });
    expect(messages(dir)).toEqual([
      'driver led_gpio implements hal.LightOutput, but fr.button needs hal.ButtonSource',
      'driver led_gpio binds board leds entries, not buttons',
      'driver led_ws2812 does not support esp32c6 (targets: esp32s3)',
    ]);
  });

  it('rejects reserved and malformed instance names, unknown capabilities and missing board entries', () => {
    const dir = fixture();
    edit(dir, PROFILE('c6-pad'), (y) => {
      y.caps = { node: y.caps.boot, Status: y.caps.status, x: { cap: 'fr.analog_in', driver: 'led_gpio', bind: 'leds.nope' } };
    });
    expect(messages(dir)).toEqual([
      "instance name 'node' is reserved (spec 03 §3.6)",
      "instance name 'Status' must be snake_case, at most 31 characters",
      'fr.analog_in has no service in this framework yet (services: fr.button, fr.led)',
      'board esp32c6-supermini has no entry leds.nope',
    ]);
  });

  it('applies profile config over driver cap_config over capability defaults, and checks it', () => {
    const dir = fixture();
    edit(dir, PROFILE('c6-pad'), (y) => {
      delete y.caps.status.config;
      y.caps.boot.config = { multi_press_max: 1, active_level: 'high' };
    });
    const r = gen(dir, 'c6-pad');
    expect(r.manifest.caps[0].config.multi_press_max).toBe(1);
    expect(r.manifest.caps[1].config).toEqual({ max_brightness: 64 }); // led_ws2812 cap_config
    expect(file(r, 'fr_board/fr_board.cpp')).toContain('c.active_level = fr::drv::ButtonGpio::ActiveLevel::high;');

    edit(dir, PROFILE('c6-pad'), (y) => {
      y.caps.boot.config = { multi_press_max: 9, colour: 'red' };
      y.caps.status.config = { max_brightness: 300 };
    });
    expect(issuesOf(() => gen(dir, 'c6-pad')).map(formatIssue)).toEqual([
      "firmware/profiles/c6-pad.profile.yaml: caps.boot.config.colour: unknown config 'colour' (fr.button and button_gpio take: debounce_ms, long_press_ms, multi_press_gap_ms, multi_press_max, gpio, active_level, pull)",
      'firmware/profiles/c6-pad.profile.yaml: caps.boot.config.multi_press_max: 9 is outside range [1, 5]',
      'firmware/profiles/c6-pad.profile.yaml: caps.status.config.max_brightness: expected an integer in 0..255 (u8), got 300',
    ]);
  });

  it('rejects a board value the driver does not know', () => {
    const dir = fixture();
    edit(dir, C6, (y) => {
      y.buttons.boot.pull = 'weak';
    });
    expect(issuesOf(() => gen(dir, 'c6-pad')).map(formatIssue)).toEqual(['hardware/boards/esp32c6-supermini.board.yaml: buttons.boot.pull: expected one of up, down, external, none, got "weak"']);
  });

  it('names a missing profile, board or partition table', () => {
    const dir = fixture();
    expect(issuesOf(() => gen(dir, 'nope'))).toEqual([{ file: PROFILE('nope'), path: '', message: 'profile nope not found' }]);
    edit(dir, PROFILE('c6-pad'), (y) => {
      y.board = 'esp32c6-maxi';
    });
    expect(messages(dir)).toEqual(['board esp32c6-maxi (from firmware/profiles/c6-pad.profile.yaml) not found']);
    edit(dir, PROFILE('c6-pad-mono'), (y) => {
      y.app = 'gateway';
    });
    edit(dir, C6, (y) => {
      y.flash.part_profile = 'fr-2mb-v1';
    });
    expect(messages(dir, 'c6-pad-mono')).toEqual(['partition table firmware/partitions/fr-2mb-v1.csv not found', "app 'gateway' not found (firmware/apps/gateway)"]);
  });
});

describe('driver manifests', () => {
  const drivers = listDrivers(ROOT);

  it('lists the M1 drivers', () => {
    expect(drivers).toEqual(['button_gpio', 'led_gpio', 'led_ws2812']);
  });

  it.each(drivers)('%s: driver.yaml matches its header and idf_component.yml', (id) => {
    const d = loadDriver(ROOT, id);
    const dir = join(ROOT, 'hardware', 'drivers', id);
    const hpp = readFileSync(join(dir, 'include', 'fr', 'drv', `${id}.hpp`), 'utf8');
    const cls = d.class.split('::').at(-1)!;
    expect(hpp).toMatch(new RegExp(`class ${cls} final : public ${d.implements.replace('.', '::')}\\b`));
    // Every config field is a Config member, in the same order, and every enum value an enumerator.
    const config = /struct Config \{([^}]*)\}/.exec(hpp)?.[1] ?? '';
    const members = [...config.matchAll(/^\s*\S+ (\w+) = /gm)].map((m) => m[1]);
    expect(members).toEqual(Object.keys(d.config ?? {}));
    for (const [name, f] of Object.entries(d.config ?? {})) {
      if (f.type === 'enum') {
        const enumName = name
          .split('_')
          .map((s) => s[0].toUpperCase() + s.slice(1))
          .join('');
        const body = new RegExp(`enum class ${enumName} : uint8_t \\{([^}]*)\\}`).exec(hpp)?.[1] ?? '';
        expect(body.split(',').map((s) => s.trim())).toEqual(f.values);
      }
    }
    // driver.yaml repeats the exact registry pins of idf_component.yml for the validator.
    const manifest = join(dir, 'idf_component.yml');
    const pinned = existsSync(manifest)
      ? Object.fromEntries(Object.entries((parse(readFileSync(manifest, 'utf8')) as Yaml).dependencies ?? {}).map(([k, v]) => [k, (v as Yaml).version]))
      : {};
    expect(d.dependencies ?? {}).toEqual(pinned);
    for (const v of Object.values(pinned)) {
      expect(v).toMatch(/^==/);
    }
  });

  it('rejects a driver.yaml whose gpio count does not match its pin fields', () => {
    const dir = fixture();
    edit(dir, 'hardware/drivers/led_gpio/driver.yaml', (y) => {
      y.resources.gpio = 2;
    });
    expect(issuesOf(() => loadDriver(dir, 'led_gpio')).map((i) => i.message)).toEqual(['declares 2 gpio but has 1 config field(s) of type gpio']);
  });
});
