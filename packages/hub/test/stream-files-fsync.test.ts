// The stream files' finish (CSI-1 §12's .csi, A1's WAV): the temp is flushed to disk (fsync) before it is closed and
// renamed into place, so a power cut never leaves a renamed file whose bytes never reached the disk.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => [] as string[]);

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    fsyncSync: (fd: number) => {
      calls.push('fsync');
      return fs.fsyncSync(fd);
    },
    closeSync: (fd: number) => {
      calls.push('close');
      return fs.closeSync(fd);
    },
    renameSync: (a: string, b: string) => {
      calls.push('rename');
      return fs.renameSync(a, b);
    },
  };
});

const { CsiFile } = await import('../src/streams/csi-sink.ts');
const { WavWriter } = await import('../src/audio/wav.ts');

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
  calls.length = 0;
});

function dir(): string {
  const d = mkdtempSync(join(tmpdir(), 'fr-fsync-'));
  dirs.push(d);
  return d;
}

describe('stream files are fsynced before the rename', () => {
  it('CsiFile.finish: fsync, close, rename', () => {
    const path = join(dir(), 'run.csi');
    const f = new CsiFile(path);
    f.write(Uint8Array.of(1, 2, 3));
    calls.length = 0;
    f.finish();
    expect(calls).toEqual(['fsync', 'close', 'rename']);
    expect(readFileSync(path).length).toBe(f.bytes);
    f.finish(); // once only
    expect(calls).toEqual(['fsync', 'close', 'rename']);
  });

  it('WavWriter.finish: fsync, close, rename', () => {
    const path = join(dir(), 'rec.wav');
    const w = new WavWriter(path, 16000);
    w.write(new Int16Array(160));
    calls.length = 0;
    expect(w.finish()).toBe(160);
    expect(calls).toEqual(['fsync', 'close', 'rename']);
    expect(readFileSync(path).length).toBe(44 + 320);
  });
});
