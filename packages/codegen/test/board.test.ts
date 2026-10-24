import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';

import {
  generateFirmware,
  headerPositions,
  listDrivers,
  loadBoardManifest,
  loadDriver,
  MAX_INSTANCES,
  PROFILE_ROLES,
  resolveProfile,
  slotsLockFile,
  type FirmwareResult,
} from '../src/board.ts';
import { formatIssue, loadModel, SchemaError, type SchemaIssue } from '../src/model.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MODEL = loadModel(ROOT);
const PROFILES = ['c3o-pad', 'c6-pad', 'c6-pad-mono', 's3l-pad'];

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
      test_pin: 20,
      caps: [
        {
          name: 'boot',
          port: 1,
          cap: 'fr.button',
          cap_id: 1,
          version: '1.0',
          driver: 'button_gpio',
          config: { debounce_ms: 20, long_press_ms: 600, multi_press_gap_ms: 250, multi_press_max: 2 },
          traits: { long_press: true, multi_press_max: 2 },
        },
        {
          name: 'status',
          port: 2,
          cap: 'fr.led',
          cap_id: 2,
          version: '1.0',
          driver: 'led_ws2812',
          config: { max_brightness: 64 },
          traits: { color: 'rgb', dimmable: true },
        },
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
    expect(r.manifest.caps[1]).toMatchObject({
      name: 'status',
      port: 2,
      driver: 'led_gpio',
      config: { max_brightness: 255 },
      traits: { color: 'mono', dimmable: false },
    });
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
        'CONFIG_FR_TEST_PIN=20',
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

  it('a fault build also gets sdkconfig.fault; a normal one removes a stale one (spec 03 §3.8)', () => {
    const dir = fixture({ locks: true });
    const out = join(dir, 'build', 'c6-pad', 'fr_gen');
    const r = generateFirmware({ sourceDir: dir, profile: 'c6-pad', outDir: out, model: MODEL, fault: 'health' });
    expect(r.files.map((f) => f.path)).toContain('sdkconfig.fault');
    expect(readFileSync(join(out, 'sdkconfig.fault'), 'utf8')).toBe(
      '# GENERATED by `fr gen firmware` --fault health (spec 03 §3.8). Do not edit.\nCONFIG_FR_TEST_FAULT_HEALTH=y\n',
    );
    const normal = generateFirmware({ sourceDir: dir, profile: 'c6-pad', outDir: out, model: MODEL });
    expect(normal.files.map((f) => f.path)).not.toContain('sdkconfig.fault');
    expect(existsSync(join(out, 'sdkconfig.fault'))).toBe(false);
    // The rest of the glue is the same either way.
    expect(normal.files).toEqual(r.files.filter((f) => f.path !== 'sdkconfig.fault'));
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
    const pins = [0, 1, 2, 3, 14, 18, 19, 21]; // free pins but the test_pin (20)
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
      "unknown driver 'button_touch' (known: button_gpio, fixture_gpio, fixture_ws2812_rx, led_gpio, led_ws2812)",
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
      'fr.analog_in has no service in this framework yet (services: fr.button, fr.led, fr.fixture)',
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

  it('derives the button traits from config and takes the LED traits from the driver (design c6 D13)', () => {
    const dir = fixture();
    edit(dir, PROFILE('c6-pad'), (y) => {
      y.caps.boot.config = { multi_press_max: 3, long_press_ms: 0 };
    });
    expect(gen(dir, 'c6-pad').manifest.caps.map((c) => c.traits)).toEqual([
      { long_press: false, multi_press_max: 3 },
      { color: 'rgb', dimmable: true },
    ]);
    // A driver that declares nothing leaves the capability's defaults.
    edit(dir, 'hardware/drivers/led_ws2812/driver.yaml', (y) => {
      delete y.traits;
    });
    expect(gen(dir, 'c6-pad').manifest.caps[1].traits).toEqual({ color: 'mono', dimmable: false });
  });

  it("rejects driver traits the capability does not have or cannot hold", () => {
    const dir = fixture();
    edit(dir, 'hardware/drivers/led_ws2812/driver.yaml', (y) => {
      y.traits = { color: 'cmyk', dimmable: true, glow: 1 };
    });
    expect(issuesOf(() => gen(dir, 'c6-pad')).map(formatIssue)).toEqual([
      'hardware/drivers/led_ws2812/driver.yaml: traits.color: expected one of mono, rgb, got "cmyk"',
      "hardware/drivers/led_ws2812/driver.yaml: traits.glow: fr.led has no trait 'glow'",
    ]);
  });

  it('writes test_pin and checks it is a free, unclaimed, unreserved pin (design c6 D24)', () => {
    const dir = fixture();
    const C3 = 'hardware/boards/esp32c3-oled042.board.yaml';
    const c3 = gen(dir, 'c3o-pad');
    expect(c3.manifest.test_pin).toBe(10);
    expect(file(c3, 'sdkconfig.board')).toContain('\nCONFIG_FR_WIFI_MAX_TX_POWER_QDBM=34\nCONFIG_FR_TEST_PIN=10\n');
    edit(dir, C6, (y) => {
      y.test_pin = 12;
    });
    expect(messages(dir)).toEqual(['test_pin GPIO12 is reserved for usb on esp32c6-supermini', 'test_pin GPIO12 is not in pins.free of esp32c6-supermini']);
    edit(dir, C6, (y) => {
      y.test_pin = 15;
    });
    expect(messages(dir, 'c6-pad-mono')).toEqual(["test_pin GPIO15 is claimed by 'status' (leds.status)", 'test_pin GPIO15 is not in pins.free of esp32c6-supermini']);
    edit(dir, C3, (y) => {
      y.test_pin = 2;
    });
    expect(gen(dir, 'c3o-pad').warnings).toContain(
      'test_pin: GPIO2 (board test_pin) is a strapping pin and must be high at reset; nothing wired to it may pull it low while the chip resets',
    );
    edit(dir, C6, (y) => {
      delete y.test_pin;
    });
    const none = gen(dir, 'c6-pad');
    expect(none.manifest.test_pin).toBeNull();
    expect(file(none, 'sdkconfig.board')).not.toContain('CONFIG_FR_TEST_PIN');
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

  it('lists the M1 drivers and the M2-C1 fixture drivers', () => {
    expect(drivers).toEqual(['button_gpio', 'fixture_gpio', 'fixture_ws2812_rx', 'led_gpio', 'led_ws2812']);
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
    // design c6 D13: an LED driver's `traits:` say what its features() returns, which LedService reports.
    if (d.implements === 'hal.LightOutput') {
      const features = /LightFeatures features\(\) const override \{ return \{([^}]*)\}; \}/.exec(hpp)?.[1];
      expect(features).toBeDefined();
      expect(d.traits).toEqual({ color: /\.rgb = true/.test(features!) ? 'rgb' : 'mono', dimmable: /\.dimmable = true/.test(features!) });
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

// ---- M2-C1: the HIL fixture (design m2-c1-hil D5) ----

const FIXTURE = 's3k-fixture';
const FIX_BOARD = 'hardware/boards/esp32s3-devkitc1-n16r8.board.yaml';

describe('the HIL fixture profile (design m2-c1-hil D5)', () => {
  it('s3k-fixture generates against the committed slots.lock without changing it', () => {
    const r = generateFirmware({ sourceDir: ROOT, profile: FIXTURE, outDir: join(tmpdir(), 'unused'), write: false, model: MODEL });
    expect(r.slotsLockChanged).toBe(false);
    expect(r.slotsLock.content).toBe(readFileSync(join(ROOT, slotsLockFile(FIXTURE)), 'utf8'));
    expect(r.manifest.caps.map((c) => [c.name, c.port])).toEqual([['status', 1], ...Array.from({ length: 12 }, (_, i) => [`ch${i}`, i + 2])]);
    expect(r.warnings).toEqual([]);
  });

  it('s3k-fixture: no CONFIG_FR_TEST_PIN, its role, the radio off and the ISR-dispatch and watchdog-panic lines from fixture_gpio', () => {
    const dir = fixture({ locks: true });
    const r = gen(dir, FIXTURE, false);
    expect(file(r, 'sdkconfig.board')).toBe(
      [
        '# GENERATED by `fr gen firmware` from the profile and board manifest. Do not edit.',
        'CONFIG_IDF_TARGET="esp32s3"',
        'CONFIG_ESPTOOLPY_FLASHSIZE_16MB=y',
        `CONFIG_PARTITION_TABLE_CUSTOM_FILENAME="${join(dir, 'firmware', 'partitions', 'fr-4mb-v1.csv')}"`,
        'CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG=y',
        'CONFIG_FR_BOARD="esp32s3-devkitc1-n16r8"',
        'CONFIG_FR_PROFILE="s3k-fixture"',
        'CONFIG_FR_PART_PROFILE="fr-4mb-v1"',
        'CONFIG_FR_ROLE=2',
        'CONFIG_FR_NET_RADIO=n',
        "# From the bound drivers' driver.yaml `sdkconfig` (design m2-c1-hil D5).",
        'CONFIG_ESP_TIMER_SUPPORTS_ISR_DISPATCH_METHOD=y',
        'CONFIG_ESP_TASK_WDT_PANIC=y',
        '',
      ].join('\n'),
    );
    expect(resolveProfile(dir, FIXTURE).fragment).toBe(file(r, 'sdkconfig.board'));
    expect(r.manifest.test_pin).toBeNull();
  });

  it('fills each line from its gpio.<n> bind, with FixtureService and the traits it derives', () => {
    const r = gen(fixture({ locks: true }), FIXTURE, false);
    expect(r.manifest.caps.find((c) => c.name === 'ch0')).toEqual({
      name: 'ch0',
      port: 2,
      cap: 'fr.fixture',
      cap_id: 6,
      version: '0.1',
      driver: 'fixture_gpio',
      config: { drive: 'open_drain', decode: 'level', pull: 'none', cap_ms: 15000, flush_us: 2000 },
      traits: { drive: 'open_drain', decode: 'level' },
    });
    expect(r.manifest.caps.find((c) => c.name === 'ch6')).toMatchObject({ driver: 'fixture_ws2812_rx', traits: { drive: 'none', decode: 'ws2812' } });
    expect(r.manifest.caps.find((c) => c.name === 'ch8')?.config.pull).toBe('up');
    expect(r.instances.ch0).toEqual({ bind: 'gpio.42', pins: [42], driverConfig: { gpio: 42 } });
    expect(r.instances.status).toEqual({ bind: 'leds.rgb', pins: [48], driverConfig: { gpio: 48, color_order: 'GRB' } });
    const cpp = file(r, 'fr_board/fr_board.cpp');
    expect(cpp).toContain('// ch0: fr.fixture on port 2, driver fixture_gpio on gpio.42');
    expect(cpp).toMatch(/FixtureGpio::Config c\{\};\n {4}c\.gpio = 42;\n {4}return c;/);
    expect(cpp).toContain('c.drive = fr::cap::FixtureDrive::open_drain;');
    expect(cpp).toContain('fr::drv::FixtureWs2812Rx driver{kDriverConfig};\nfr::FixtureService service{driver, kConfig};');
    expect(file(r, 'fr_board/include/fr/board.hpp')).toContain('#include "fr/services/fixture_service.hpp"\n#include "fr/services/led_service.hpp"');
    expect(file(r, 'fr_board/CMakeLists.txt')).toContain('PRIV_REQUIRES fixture_gpio fixture_ws2812_rx led_ws2812)');
  });

  it('the M1 profiles get none of it', () => {
    for (const p of PROFILES) {
      const frag = resolveProfile(ROOT, p).fragment;
      for (const key of ['CONFIG_FR_ROLE', 'CONFIG_FR_NET_RADIO', 'CONFIG_ESP_TIMER_SUPPORTS_ISR_DISPATCH_METHOD', 'CONFIG_ESP_TASK_WDT_PANIC', '# From the bound drivers']) {
        expect(frag).not.toContain(key);
      }
      expect(frag).toContain('CONFIG_FR_TEST_PIN=');
    }
  });
});

describe('gpio.<n> binds, test_pin: none, role and radio (design m2-c1-hil D5)', () => {
  const messages = (dir: string, profile = FIXTURE) => issuesOf(() => gen(dir, profile, false)).map((i) => i.message);
  const caps = (dir: string, fn: (c: Yaml) => void) => edit(dir, PROFILE(FIXTURE), (y) => fn(y.caps));

  it('a bare pin must be in pins.free, unreserved, unclaimed and not a strapping pin', () => {
    const dir = fixture();
    caps(dir, (c) => {
      c.ch4.bind = 'gpio.38'; // rgb_alt
      c.ch5.bind = 'gpio.0'; // a strap, and the BOOT button
      c.ch8.bind = 'gpio.22'; // no such pin on the S3
      c.ch9.bind = 'gpio.42'; // ch0's
    });
    expect(messages(dir)).toEqual([
      'GPIO38 (gpio.38) is reserved for rgb_alt on esp32s3-devkitc1-n16r8',
      'GPIO0 (gpio.0) is a strapping pin; a gpio.<n> bind may not use one',
      'GPIO22 (gpio.22) is not in pins.free of esp32s3-devkitc1-n16r8',
      "GPIO42 (gpio.42) is already claimed by 'ch0'",
    ]);
  });

  it('the pin comes from the bind: it cannot be set, and a board entry does not give one', () => {
    const dir = fixture();
    caps(dir, (c) => {
      c.ch4.config = { gpio: 8 };
      c.ch5.bind = 'leds.rgb';
    });
    expect(messages(dir)).toEqual([
      "'gpio' is the pin of the bind (gpio.4) and cannot be set",
      'driver fixture_gpio binds board gpio entries, not leds',
      "driver fixture_gpio does not accept leds.rgb of kind 'ws2812' (accepts: gpio)",
      "driver fixture_gpio takes 'gpio' from a gpio.<n> bind",
    ]);
  });

  it('refuses a BOOT line (open_drain or nfet_gate) on a pin that glitches at power-up; an input tap there is fine', () => {
    const dir = fixture();
    caps(dir, (c) => {
      c.ch0.bind = 'gpio.8'; // open_drain on a glitch pin
      c.ch1.config = { drive: 'nfet_gate' }; // GPIO41: no glitch
      c.ch4.config = { drive: 'nfet_gate' }; // GPIO4 glitches
    });
    expect(messages(dir)).toEqual([
      'GPIO8 (gpio.8) drives a level at power-up (pins.power_up_glitch), so no line with drive open_drain may use it',
      'GPIO4 (gpio.4) drives a level at power-up (pins.power_up_glitch), so no line with drive nfet_gate may use it',
    ]);
    // ch4 (GPIO4) and ch8 (GPIO15) are input taps on glitch pins in the committed profile, which generates.
    expect(gen(fixture(), FIXTURE, false).instances.ch8.pins).toEqual([15]);
  });

  it("refuses a fixture line's drive, decode or pull that its driver refuses at init (design m2-c1-hil D4)", () => {
    const dir = fixture();
    caps(dir, (c) => {
      c.ch0.config = { drive: 'open_drain', pull: 'up' }; // fixture_gpio: a driving line has no pulls (invalid_args)
      c.ch1.config = { drive: 'nfet_gate', pull: 'up' };
      c.ch4.config = { decode: 'ws2812' }; // fixture_gpio decodes level only (unsupported)
      c.ch5.driver = 'fixture_ws2812_rx'; // decode level, the default: RMT RX decodes WS2812 only
      c.ch6.config = { decode: 'ws2812', drive: 'open_drain' }; // RMT RX is input only
      c.ch7.config = { decode: 'ws2812', pull: 'up' }; // and takes no pull
    });
    expect(issuesOf(() => gen(dir, FIXTURE, false)).map((i) => `${i.path}: ${i.message}`)).toEqual([
      'caps.ch0.config.pull: pull: up is only for an input line (drive: none); a line with drive open_drain has no pulls',
      'caps.ch1.config.pull: pull: up is only for an input line (drive: none); a line with drive nfet_gate has no pulls',
      'caps.ch4.config.decode: decode: ws2812 needs driver fixture_ws2812_rx (RMT RX); fixture_gpio refuses it at init',
      'caps.ch5.driver: fixture_ws2812_rx decodes WS2812 only: it needs decode: ws2812, not level',
      'caps.ch6.config.drive: fixture_ws2812_rx is input only: it needs drive: none, not open_drain',
      'caps.ch7.config.pull: fixture_ws2812_rx takes no pull: the DUT drives its WS2812 data line push-pull',
      // The instance is still checked pin by pin: ch6 drives on a glitch pin.
      'caps.ch6.bind: GPIO6 (gpio.6) drives a level at power-up (pins.power_up_glitch), so no line with drive open_drain may use it',
    ]);
    // What the committed profile has passes: drive none with pull: up (ch8-ch11), level and ws2812 inputs.
    expect(() => gen(fixture(), FIXTURE, false)).not.toThrow();
  });

  it('refuses a board test pin on a strapping pin that must be low at reset, since its line pulls it up (D7, D12)', () => {
    const dir = fixture();
    edit(dir, 'hardware/boards/waveshare-esp32s3-lcd19.board.yaml', (y) => {
      y.test_pin = 45;
      y.pins.free.push(45);
    });
    expect(issuesOf(() => gen(dir, 's3l-pad', false)).map(formatIssue)).toEqual([
      "hardware/boards/waveshare-esp32s3-lcd19.board.yaml: test_pin: test_pin GPIO45 is a strapping pin that must be low at reset, and a test pin's line pulls it up",
    ]);
    // GPIO46 too: download mode needs it low (S3 Table 3-3), as the C3s' GPIO8 needs high.
    edit(dir, 'hardware/boards/waveshare-esp32s3-lcd19.board.yaml', (y) => {
      y.test_pin = 46;
      y.pins.free.push(46);
    });
    expect(issuesOf(() => gen(dir, 's3l-pad', false)).map((i) => i.message)).toEqual([
      "test_pin GPIO46 is a strapping pin that must be low at reset, and a test pin's line pulls it up",
    ]);
    // A strap that needs no level keeps the warning.
    edit(dir, 'hardware/boards/waveshare-esp32s3-lcd19.board.yaml', (y) => {
      y.test_pin = 3;
      y.pins.free.push(3);
    });
    expect(gen(dir, 's3l-pad', false).warnings).toContain('test_pin: GPIO3 (board test_pin) is a strapping pin; with default eFuses no level is required at reset');
  });

  it('test_pin: none drops the board test pin from sdkconfig.board and the manifest, and frees it, on any board', () => {
    const dir = fixture();
    edit(dir, PROFILE('c6-pad'), (y) => {
      y.test_pin = 'none';
      y.caps.tap = { cap: 'fr.button', driver: 'button_gpio', bind: 'buttons.boot', config: { gpio: 20 } };
    });
    const r = gen(dir, 'c6-pad', false);
    expect(r.manifest.test_pin).toBeNull();
    expect(file(r, 'sdkconfig.board')).not.toContain('CONFIG_FR_TEST_PIN');
    // Without it GPIO20 is the board's test pin again, which no instance may claim.
    edit(dir, PROFILE('c6-pad'), (y) => {
      delete y.test_pin;
    });
    expect(messages(dir, 'c6-pad')).toEqual(["test_pin GPIO20 is claimed by 'tap' (buttons.boot)"]);
    edit(dir, PROFILE('c6-pad'), (y) => {
      y.test_pin = 7;
    });
    expect(issuesOf(() => gen(dir, 'c6-pad', false)).map((i) => i.path)).toEqual(['test_pin']);
  });

  it('a role: fixture profile needs test_pin: none and the radio off, and only it may have the radio off; the role renders on any profile', () => {
    const dir = fixture();
    edit(dir, PROFILE(FIXTURE), (y) => {
      delete y.test_pin;
      y.net = { link_profile: 'default' };
    });
    expect(issuesOf(() => gen(dir, FIXTURE, false)).map(formatIssue)).toEqual([
      'firmware/profiles/s3k-fixture.profile.yaml: test_pin: a role: fixture profile needs test_pin: none',
      'firmware/profiles/s3k-fixture.profile.yaml: net.radio: a role: fixture profile needs net: { radio: off }',
    ]);
    edit(dir, PROFILE('c6-pad'), (y) => {
      y.role = 'gateway';
    });
    expect(file(gen(dir, 'c6-pad', false), 'sdkconfig.board')).toContain('CONFIG_FR_PART_PROFILE="fr-4mb-v1"\nCONFIG_FR_ROLE=1\nCONFIG_FR_TEST_PIN=20\n');
    // The hub knows a radio-off device by its HELLO role alone (provision.ts radioOff): a node or gateway with
    // the radio off would get a Wi-Fi join stage and Wi-Fi OTAs it can never take.
    for (const role of [undefined, 'node', 'gateway']) {
      edit(dir, PROFILE('c6-pad'), (y) => {
        if (role === undefined) {
          delete y.role;
        } else {
          y.role = role;
        }
        y.net.radio = 'off';
      });
      expect(issuesOf(() => gen(dir, 'c6-pad', false)).map(formatIssue)).toEqual([
        `firmware/profiles/c6-pad.profile.yaml: net.radio: net: { radio: off } is only for a role: fixture profile, not role ${role ?? 'node'}: the hub knows a radio-off device by its HELLO role`,
      ]);
    }
    edit(dir, PROFILE('c6-pad'), (y) => {
      y.net.radio = 'on';
    });
    expect(file(gen(dir, 'c6-pad', false), 'sdkconfig.board')).not.toContain('CONFIG_FR_NET_RADIO');
    edit(dir, PROFILE('c6-pad'), (y) => {
      y.role = 'hub';
      y.net.radio = 'maybe';
    });
    expect(issuesOf(() => gen(dir, 'c6-pad', false)).map((i) => i.path)).toEqual(['role', 'net.radio']);
  });

  it('CONFIG_FR_ROLE is the schema/protocol.yaml Role value', () => {
    const role = MODEL.protocol.enums.find((e) => e.name === 'Role')!;
    expect(role.members.map((m) => m.name)).toEqual([...PROFILE_ROLES]);
    const dir = fixture();
    for (const m of role.members) {
      edit(dir, PROFILE('c6-pad'), (y) => {
        y.role = m.name;
      });
      expect(resolveProfile(dir, 'c6-pad').fragment).toContain(`\nCONFIG_FR_ROLE=${m.value}\n`);
    }
  });

  it(`refuses more than fr_core's ${MAX_INSTANCES} instances (kMaxInstances)`, () => {
    const core = readFileSync(join(ROOT, 'firmware', 'components', 'fr_core', 'include', 'fr', 'core.hpp'), 'utf8');
    expect(MAX_INSTANCES).toBe(Number(/kMaxInstances = (\d+);/.exec(core)?.[1]));
    const dir = fixture();
    const add = (pins: number[]) =>
      caps(dir, (c) => {
        for (const [i, p] of pins.entries()) {
          c[`ch${12 + i}`] = { cap: 'fr.fixture', driver: 'fixture_gpio', bind: `gpio.${p}` };
        }
      });
    add([8, 9, 10]); // 16, the most fr_core runs
    expect(() => gen(dir, FIXTURE, false)).not.toThrow();
    add([8, 9, 10, 13]);
    expect(messages(dir)).toEqual(['17 instances, but fr_core runs at most 16 (kMaxInstances)']);
  });

  it('budgets RMT RX channels against the board (resources.rmt_rx)', () => {
    const dir = fixture();
    const add = (pins: number[]) =>
      caps(dir, (c) => {
        for (const [i, p] of pins.entries()) {
          c[`ch${12 + i}`] = { cap: 'fr.fixture', driver: 'fixture_ws2812_rx', bind: `gpio.${p}`, config: { decode: 'ws2812' } };
        }
      });
    add([8, 9]); // 4 of the S3's 4
    expect(() => gen(dir, FIXTURE, false)).not.toThrow();
    add([8, 9, 10]);
    expect(messages(dir)).toEqual(['rmt_rx budget exceeded: 5 needed (ch6, ch7, ch12, ch13, ch14), board esp32s3-devkitc1-n16r8 has 4']);
    edit(dir, FIX_BOARD, (y) => {
      delete y.resources.rmt_rx;
    });
    expect(messages(dir)).toEqual(['rmt_rx budget exceeded: 5 needed (ch6, ch7, ch12, ch13, ch14), board esp32s3-devkitc1-n16r8 has 0']);
  });
});

describe('driver sdkconfig (design m2-c1-hil D5)', () => {
  const RX = 'hardware/drivers/fixture_ws2812_rx/driver.yaml';

  it('fixture_gpio lists the ISR-dispatch and task-watchdog panic lines', () => {
    expect(loadDriver(ROOT, 'fixture_gpio').sdkconfig).toEqual(['CONFIG_ESP_TIMER_SUPPORTS_ISR_DISPATCH_METHOD=y', 'CONFIG_ESP_TASK_WDT_PANIC=y']);
  });

  it("renders each bound driver's lines once, and refuses two drivers that set one symbol differently", () => {
    const dir = fixture();
    edit(dir, RX, (y) => {
      y.sdkconfig = ['CONFIG_ESP_TIMER_SUPPORTS_ISR_DISPATCH_METHOD=y', 'CONFIG_RMT_ISR_IRAM_SAFE=y'];
    });
    const r = gen(dir, FIXTURE, false);
    expect(file(r, 'sdkconfig.board')).toMatch(/D5\)\.\nCONFIG_ESP_TIMER_SUPPORTS_ISR_DISPATCH_METHOD=y\nCONFIG_ESP_TASK_WDT_PANIC=y\nCONFIG_RMT_ISR_IRAM_SAFE=y\n$/);
    expect(resolveProfile(dir, FIXTURE).fragment).toBe(file(r, 'sdkconfig.board'));
    edit(dir, RX, (y) => {
      y.sdkconfig = ['CONFIG_ESP_TIMER_SUPPORTS_ISR_DISPATCH_METHOD=n'];
    });
    expect(issuesOf(() => gen(dir, FIXTURE, false)).map(formatIssue)).toEqual([
      `${RX}: sdkconfig.0: CONFIG_ESP_TIMER_SUPPORTS_ISR_DISPATCH_METHOD=n conflicts with CONFIG_ESP_TIMER_SUPPORTS_ISR_DISPATCH_METHOD=y from driver fixture_gpio`,
    ]);
  });

  it('refuses framework symbols, a symbol twice, a line that is not Kconfig, and from: bind outside binds: gpio', () => {
    const dir = fixture();
    edit(dir, RX, (y) => {
      y.sdkconfig = ['CONFIG_FR_TEST_PIN=3', 'CONFIG_A=y', 'CONFIG_A=n'];
    });
    expect(issuesOf(() => loadDriver(dir, 'fixture_ws2812_rx')).map((i) => `${i.path}: ${i.message}`)).toEqual([
      'sdkconfig.0: CONFIG_FR_TEST_PIN comes from the profile and board manifest, not a driver',
      'sdkconfig.2: CONFIG_A is listed twice',
    ]);
    edit(dir, RX, (y) => {
      y.sdkconfig = ['ESP_TIMER=y'];
    });
    expect(issuesOf(() => loadDriver(dir, 'fixture_ws2812_rx')).map((i) => `${i.path}: ${i.message}`)).toEqual(['sdkconfig.0: expected CONFIG_<NAME>=<value>']);
    edit(dir, 'hardware/drivers/led_gpio/driver.yaml', (y) => {
      y.config.gpio.from = 'bind';
    });
    expect(issuesOf(() => loadDriver(dir, 'led_gpio')).map((i) => `${i.path}: ${i.message}`)).toEqual([
      'config.gpio.from: from: bind is the pin of a gpio.<n> bind: it needs binds: gpio and type: gpio',
    ]);
  });
});

describe('board manifest facts (design m2-c1-hil D5)', () => {
  const FACTS: Record<string, { uart: number; rmtRx: number; en: string | null }> = {
    'esp32c3-oled042': { uart: 21, rmtRx: 2, en: null },
    'esp32c6-supermini': { uart: 16, rmtRx: 2, en: null },
    'waveshare-esp32s3-lcd19': { uart: 43, rmtRx: 4, en: 'J6-11' },
    'esp32s3-devkitc1-n16r8': { uart: 43, rmtRx: 4, en: 'J1-3' },
  };

  it.each(Object.keys(FACTS))('%s: headers, boot_uart_tx, en_access and rmt_rx', (id) => {
    const b = loadBoardManifest(ROOT, id);
    const f = FACTS[id];
    expect(b.boot_uart_tx).toBe(f.uart);
    expect(b.resources?.rmt_rx).toBe(f.rmtRx);
    expect(b.en_access ?? null).toBe(f.en);
    expect(headerPositions(b, 'EN')).toEqual(f.en ? [f.en] : []);
    // The BOOT button, the ROM log's TX and the T-LAT test pin are on a header, once.
    for (const pin of [b.buttons && (b.buttons as Yaml).boot.gpio, b.boot_uart_tx, b.test_pin].filter((p) => typeof p === 'number')) {
      expect(headerPositions(b, pin)).toHaveLength(1);
    }
  });

  it('the fixture board: its pin plan positions (§2.2) and the glitch pins of S3 Table 2-2', () => {
    const b = loadBoardManifest(ROOT, 'esp32s3-devkitc1-n16r8');
    expect([42, 41, 40, 39, 4, 5, 6, 7, 15, 16, 17, 18, 11, 12, 21].map((p) => headerPositions(b, p)[0])).toEqual([
      'J3-6', 'J3-7', 'J3-8', 'J3-9', 'J1-4', 'J1-5', 'J1-6', 'J1-7', 'J1-8', 'J1-9', 'J1-10', 'J1-11', 'J1-17', 'J1-18', 'J3-18',
    ]);
    expect(b.pins.power_up_glitch).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(b.test_pin).toBeNull();
  });

  it('refuses a GPIO on two header positions and an en_access that is not EN', () => {
    const dir = fixture();
    edit(dir, FIX_BOARD, (y) => {
      y.en_access = 'J1-4';
      y.headers.J3[0] = 4;
    });
    expect(issuesOf(() => gen(dir, FIXTURE, false)).map(formatIssue)).toEqual([
      `${FIX_BOARD}: headers.J3.0: GPIO4 is already at J1-4`,
      `${FIX_BOARD}: en_access: J1-4 is not an EN position in headers`,
    ]);
  });
});
