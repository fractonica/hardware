// ROUND-1 (design scale-round-c1 D3, D5): gc9a01_spi, a panel on bare pins (no board entry), and fr.display's trait
// round. The profile here is c6w-scale without its scale (the scale's driver is another stream's), in a scratch copy.
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { generateFirmware, loadDriver, type FirmwareResult } from '../src/board.ts';
import { formatIssue, loadModel, SchemaError } from '../src/model.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MODEL = loadModel(ROOT);

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

/** A scratch checkout with the inputs `fr gen firmware` reads and one profile on the scale board. */
function checkout(round: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'fr-round-'));
  temps.push(dir);
  cpSync(join(ROOT, 'hardware'), join(dir, 'hardware'), { recursive: true });
  cpSync(join(ROOT, 'firmware', 'partitions'), join(dir, 'firmware', 'partitions'), { recursive: true });
  for (const app of ['node', 'gateway']) {
    cpSync(join(ROOT, 'firmware', 'apps', app, 'CMakeLists.txt'), join(dir, 'firmware', 'apps', app, 'CMakeLists.txt'));
  }
  mkdirSync(join(dir, 'firmware', 'profiles'), { recursive: true });
  writeFileSync(
    join(dir, 'firmware', 'profiles', 'round-test.profile.yaml'),
    [
      'profile: round-test',
      'board: esp32c6-wroom1-n8',
      'app: node',
      'net: { link_profile: default }',
      'caps:',
      '  boot:   { cap: fr.button,  driver: button_gpio, bind: buttons.boot }',
      '  status: { cap: fr.led,     driver: led_ws2812,  bind: leds.rgb }',
      `  round:  ${round}`,
      '',
    ].join('\n'),
  );
  return dir;
}

function gen(dir: string): FirmwareResult {
  try {
    return generateFirmware({ sourceDir: dir, profile: 'round-test', outDir: join(dir, 'build', 'fr_gen'), write: false, model: MODEL });
  } catch (e) {
    if (e instanceof SchemaError) {
      throw new Error(e.issues.map(formatIssue).join('\n'));
    }
    throw e;
  }
}

function file(r: FirmwareResult, path: string): string {
  const f = r.files.find((x) => x.path === path);
  if (!f) {
    throw new Error(`no ${path}`);
  }
  return f.content;
}

const BENCH = '{ cap: fr.display, driver: gc9a01_spi, bind: { sclk: gpio.6, mosi: gpio.7, cs: gpio.10, dc: gpio.2 } }';

describe('gc9a01_spi (design scale-round-c1 D3, D5)', () => {
  it('its manifest loads: bare pins, cs and rst optional, the round trait', () => {
    const d = loadDriver(ROOT, 'gc9a01_spi');
    expect(d.binds).toBe('gpio');
    expect(d.targets).toEqual(['esp32c6', 'esp32s3', 'esp32c3']);
    expect(d.traits).toEqual({ color: 'rgb565', ui: true, round: true });
    expect(d.config?.cs).toMatchObject({ from: 'bind.cs', optional: true });
    expect(d.config?.rst).toMatchObject({ from: 'bind.rst', optional: true });
  });

  it("the bench's wiring: 240x240, rgb565, LVGL, round, no reset line, the size from the driver", () => {
    const r = gen(checkout(BENCH));
    const round = r.manifest.caps.find((c) => c.name === 'round')!;
    expect(round).toMatchObject({ cap: 'fr.display', driver: 'gc9a01_spi', config: { rotation: 'r0' } });
    expect(round.traits).toEqual({ width: 240, height: 240, color: 'rgb565', ui: true, touch: false, round: true });
    expect(r.instances.round).toEqual({
      bind: '{sclk: gpio.6, mosi: gpio.7, cs: gpio.10, dc: gpio.2}',
      pins: [6, 7, 10, 2],
      driverConfig: { sclk: 6, mosi: 7, cs: 10, dc: 2, rst: -1, width: 240, height: 240, spi_mhz: 40, invert: true, bgr: true },
    });
    const cpp = file(r, 'fr_board/fr_board.cpp');
    expect(cpp).toContain('fr::drv::Gc9a01Spi driver{kDriverConfig};\nfr::ui::LvglBackend backend;\nfr::DisplayService service{driver, backend, kConfig};');
    expect(cpp).toContain('    c.rst = -1;\n');
    expect(file(r, 'fr_board/CMakeLists.txt')).toMatch(/PRIV_REQUIRES .*gc9a01_spi .*fr_ui\)/);
    expect(file(r, 'fr_board/include/fr/board.hpp')).toContain('    {3, "round", 240, 240, 0, true, true, 0},');
    // No PSRAM on this board: the profile does not turn it on (design D4).
    expect(file(r, 'sdkconfig.board')).not.toContain('CONFIG_SPIRAM=y');
  });

  it('without cs, with a reset line, a smaller panel turned a quarter: the traits follow the driver config', () => {
    const r = gen(checkout('{ cap: fr.display, driver: gc9a01_spi, bind: { sclk: gpio.6, mosi: gpio.7, dc: gpio.2, rst: gpio.3 }, config: { width: 200, height: 240, rotation: r90, invert: false } }'));
    const round = r.manifest.caps.find((c) => c.name === 'round')!;
    expect(round.traits).toMatchObject({ width: 240, height: 200, round: true });
    expect(r.instances.round.pins).toEqual([6, 7, 2, 3]);
    expect(r.instances.round.driverConfig).toMatchObject({ cs: -1, rst: 3, width: 200, height: 240, invert: false, bgr: true });
  });

  it('refuses a width beyond the 240 x 240 RAM', () => {
    expect(() => gen(checkout('{ cap: fr.display, driver: gc9a01_spi, bind: { sclk: gpio.6, mosi: gpio.7, dc: gpio.2 }, config: { width: 320 } }'))).toThrow(/width/);
  });
});
