import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { flashPlan, isErrorLine, normalizeMac, parseAppImage, parseDiagnostic, parseLine, parsePartitionTable, resolveProfile } from '@fractonica/hub';
import type { ArtifactManifest } from '@fractonica/protocol';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function fakeImage(version: string): Buffer {
  const body = Buffer.alloc(512);
  body[0] = 0xe9;
  body.writeUInt16LE(5, 12); // ESP32-C3
  body[23] = 1; // hash appended
  body.writeUInt32LE(0xabcd5432, 32);
  body.write(version, 32 + 16);
  body.write('fr_node', 32 + 48);
  body.write('v6.1', 32 + 112);
  const hash = createHash('sha256').update(body).digest();
  return Buffer.concat([body, hash]);
}

function partitionEntry(label: string, type: number, subtype: number, offset: number, size: number, flags = 0): Buffer {
  const b = Buffer.alloc(32);
  b.writeUInt16LE(0x50aa, 0);
  b[2] = type;
  b[3] = subtype;
  b.writeUInt32LE(offset, 4);
  b.writeUInt32LE(size, 8);
  b.write(label, 12);
  b.writeUInt32LE(flags, 28);
  return b;
}

describe('log line parsing', () => {
  it('parses ESP_LOG lines', () => {
    expect(parseLine('I (432) fr: ready id=1cdbd416ba34')).toMatchObject({ level: 'I', tag: 'fr', kind: 'esp_log' });
  });
  it('strips ANSI colours and classifies ROM boot lines', () => {
    expect(parseLine('\x1b[0;32mW (1) wifi: x\x1b[0m')).toMatchObject({ level: 'W', tag: 'wifi', text: 'W (1) wifi: x' });
    expect(parseLine('rst:0x15 (USB_UART_CHIP_RESET),boot:0xc').kind).toBe('boot');
    expect(parseLine('hello').kind).toBe('raw');
  });
});

describe('app image', () => {
  it('reads fw_id from the appended hash and the app descriptor', () => {
    const img = fakeImage('0.1.0');
    const info = parseAppImage(img);
    expect(info.chip_id).toBe(5);
    expect(info.version).toBe('0.1.0');
    expect(info.project_name).toBe('fr_node');
    expect(info.fw_id).toBe(img.subarray(img.length - 32).toString('hex'));
  });
});

describe('partition table', () => {
  it('parses entries and the readonly flag', () => {
    const t = Buffer.concat([
      partitionEntry('ota_0', 0, 0x10, 0x10000, 0x1e0000),
      partitionEntry('fr_ident', 1, 2, 0x3fc000, 0x4000, 0x2),
      Buffer.alloc(32, 0xff),
    ]);
    const parts = parsePartitionTable(t);
    expect(parts).toHaveLength(2);
    expect(parts[1]).toMatchObject({ label: 'fr_ident', offset: 0x3fc000, size: 0x4000, readonly: true });
  });
});

describe('flash plans', () => {
  const manifest = {
    build_id: 'node/c3o-pad/debug/abc',
    flash: {
      mode: 'dio', freq: '80m', size: '4MB',
      files: [
        { offset: '0x0', role: 'bootloader', blob: 'sha256:aa', size: 1 },
        { offset: '0x8000', role: 'partition_table', blob: 'sha256:bb', size: 1 },
        { offset: '0xe000', role: 'ota_data_initial', blob: 'sha256:cc', size: 1 },
        { offset: '0x10000', role: 'app', blob: 'sha256:dd', size: 1 },
      ],
    },
    partitions: [{ label: 'fr_ident', type: 1, subtype: 2, offset: 0x3fc000, size: 0x4000, readonly: true }],
  } as unknown as ArtifactManifest;

  it('full writes four images and erases fr_ident', () => {
    const p = flashPlan(manifest, 'full');
    expect(p.files.map((f) => f.role)).toEqual(['bootloader', 'partition_table', 'ota_data_initial', 'app']);
    expect(p.erase).toEqual([{ offset: '0x3fc000', size: '0x4000', why: expect.any(String) }]);
  });
  it('app always includes otadata and never erases identity', () => {
    const p = flashPlan(manifest, 'app');
    expect(p.files.map((f) => f.role)).toEqual(['ota_data_initial', 'app']);
    expect(p.erase).toEqual([]);
  });
});

describe('misc', () => {
  it('normalizes USB serial MACs', () => {
    expect(normalizeMac('1C:DB:D4:16:BA:34')).toBe('1cdbd416ba34');
    expect(normalizeMac('/dev/cu.usbmodem1101')).toBe('/dev/cu.usbmodem1101');
  });
  it('parses GCC diagnostics', () => {
    expect(parseDiagnostic('/x/main.cpp:12:5: error: expected ;')).toEqual({ file: '/x/main.cpp', line: 12, col: 5, severity: 'error', message: 'expected ;' });
    expect(parseDiagnostic('/x/core.cpp:12:10: fatal error: esp_timer.h: No such file or directory')).toMatchObject({ severity: 'error', message: 'esp_timer.h: No such file or directory' });
    expect(parseDiagnostic('[3/9] Building')).toBeNull();
  });
  it('keeps compiler failures but not Kconfig notes or -Werror command lines in errors-only job logs', () => {
    expect(isErrorLine('/x/core.cpp:12:10: fatal error: esp_timer.h: No such file or directory')).toBe(true);
    expect(isErrorLine('FAILED: esp-idf/fr_core/CMakeFiles/__idf_fr_core.dir/src/core.cpp.obj ')).toBe(true);
    expect(isErrorLine('To fix this, add esp_timer to PRIV_REQUIRES list of idf_component_register call')).toBe(true);
    expect(isErrorLine("NOTE: unknown kconfig symbol 'LWIP_TCP_RTO_TIME' assigned to '300'")).toBe(false);
    expect(isErrorLine('ccache riscv32-esp-elf-g++ -Wall -Werror -Wno-error=unused-function -c core.cpp')).toBe(false);
  });
  it('resolves the c3o-pad profile to an esp32c3 board fragment', () => {
    const p = resolveProfile(REPO, 'c3o-pad');
    expect(p).toMatchObject({ board: 'esp32c3-oled042', target: 'esp32c3', partProfile: 'fr-4mb-v1', app: 'node' });
    expect(p.fragment).toContain('CONFIG_IDF_TARGET="esp32c3"');
    expect(p.fragment).toContain('fr-4mb-v1.csv');
    expect(p.fragment).toContain('CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG=y');
  });
});
