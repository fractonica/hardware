// The serial bridge (design m2-c1-hil §5.1, I1): SerialPortManager on links/serial-bridge.ts's binding, against
// virtual-usb.ts, lists, opens, reads and writes a virtual Espressif port as it does a USB one, sees an unplug as
// a port gone, and a bridge that went away as no ports (never a rejected poll). Loopback only. The flag fails
// closed: no value, `--serial-bridge=` or a stray spelling stops the hub before it opens a port, so a test hub
// never falls back to the Mac's real USB ports (main.ts, spawned here with --no-serial as a belt).

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import type { Db } from '../src/db.ts';
import { bridgeBinding, parseBridgeAddress, serialBridgeArg } from '../src/links/serial-bridge.ts';
import type { LogStore } from '../src/logstore.ts';
import { SerialPortManager } from '../src/serial.ts';
import { until } from './fake-node.ts';
import { VirtualUsb } from './virtual-usb.ts';

const MAC = 'aabbccddee01';
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
});

async function rig() {
  const usb = await VirtualUsb.open();
  const appended: { key: string; path: string; text: string }[] = [];
  const logs = { append: (key: string, path: string, text: string) => appended.push({ key, path, text }) } as unknown as LogStore;
  const db = { prepare: () => ({ run: () => undefined }) } as unknown as Db;
  const mgr = new SerialPortManager(logs, db, { binding: bridgeBinding(parseBridgeAddress(usb.address)) });
  const gone: string[] = [];
  mgr.onPortGone((k) => gone.push(k));
  cleanups.push(async () => {
    await mgr.stop();
    await usb.close().catch(() => undefined);
  });
  return { usb, mgr, appended, gone };
}

describe('the serial bridge', () => {
  it('takes loopback addresses only', () => {
    expect(parseBridgeAddress('127.0.0.1:4100')).toEqual({ host: '127.0.0.1', port: 4100 });
    expect(parseBridgeAddress('localhost:4100')).toEqual({ host: '127.0.0.1', port: 4100 });
    for (const bad of ['10.0.0.2:4100', '0.0.0.0:4100', '127.0.0.1:0', '127.0.0.1:70000', '4100', '']) {
      expect(() => parseBridgeAddress(bad), bad).toThrow(/--serial-bridge takes 127\.0\.0\.1:<port>/);
    }
  });

  it('takes the flag strictly: both spellings, and a missing, empty or repeated value throws', () => {
    for (const argv of [[], ['--port', '7420'], ['--no-serial'], ['--bench', 'lab']]) {
      expect(serialBridgeArg(argv), argv.join(' ')).toBeNull();
    }
    expect(serialBridgeArg(['--port', '0', '--serial-bridge', '127.0.0.1:4100'])).toEqual({ host: '127.0.0.1', port: 4100 });
    expect(serialBridgeArg(['--serial-bridge=127.0.0.1:4100', '--no-serial'])).toEqual({ host: '127.0.0.1', port: 4100 });
    expect(serialBridgeArg(['--serial-bridge=localhost:4100'])).toEqual({ host: '127.0.0.1', port: 4100 });
    for (const argv of [['--serial-bridge'], ['--port', '0', '--serial-bridge'], ['--serial-bridge='], ['--serial-bridge', ''], ['--serial-bridge', '  ']]) {
      expect(() => serialBridgeArg(argv), JSON.stringify(argv)).toThrow(/--serial-bridge needs a value, 127\.0\.0\.1:<port>.*does not fall back to the Mac's USB ports/);
    }
    // A following flag is no address; nor is anything off loopback.
    expect(() => serialBridgeArg(['--serial-bridge', '--bench', 'lab'])).toThrow(/--serial-bridge takes 127\.0\.0\.1:<port>/);
    expect(() => serialBridgeArg(['--serial-bridge=10.0.0.2:4100'])).toThrow(/--serial-bridge takes 127\.0\.0\.1:<port>/);
    expect(() => serialBridgeArg(['--serial-bridge', '127.0.0.1:1', '--serial-bridge', '127.0.0.1:2'])).toThrow(/given 2 times/);
    expect(() => serialBridgeArg(['--serial-bridges', '127.0.0.1:4100'])).toThrow(/unknown flag "--serial-bridges"/);
  });

  it('stops a hub whose flag has no value before it opens anything', async () => {
    const home = mkdtempSync(join(tmpdir(), 'fr-bridge-flag-'));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const main = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main.ts');
    // --no-serial first: had the flag been ignored, this hub would still leave the Mac's USB ports alone.
    const args = ['--conditions=@fractonica/source', main, '--port', '0', '--node-host', '127.0.0.1', '--node-port', '0', '--node-http-port', '0', '--no-advert', '--no-serial'];
    for (const flag of [['--serial-bridge='], ['--serial-bridge']]) {
      const proc = spawn(process.execPath, [...args, ...flag], { env: { ...process.env, FR_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      proc.stdout.on('data', (d: Buffer) => (out += d.toString()));
      proc.stderr.on('data', (d: Buffer) => (out += d.toString()));
      const timer = setTimeout(() => proc.kill('SIGKILL'), 20_000);
      const code = await new Promise<number | null>((r) => proc.on('exit', (c) => r(c)));
      clearTimeout(timer);
      expect(code, out).toBe(1);
      expect(out).toMatch(/--serial-bridge needs a value/);
      expect(out).not.toMatch(/"event":"(started|listening|already_running)"/);
    }
  }, 45_000);

  it('lists, opens, reads and writes a virtual port as a USB-Serial/JTAG one, and an unplug is a port gone', async () => {
    const { usb, mgr, appended, gone } = await rig();
    const toDevice: string[] = [];
    const port = usb.attach(MAC, (line) => toDevice.push(line));
    await mgr.poll();
    await until(() => mgr.list().find((p) => p.device_id === MAC)?.state === 'open', 3000, 'the port open');
    expect(mgr.list()).toEqual([expect.objectContaining({ path: `/dev/cu.usbmodem-fr-${MAC}`, device_id: MAC, usb_serial: 'AA:BB:CC:DD:EE:01', vid: '303a', pid: '1001', state: 'open' })]);
    // The device's output, a line at a time into the log store (whose frame tap feeds the router's serial link).
    await until(
      () => {
        port.print('I (12) boot: hello');
        return appended.some((a) => a.text === 'I (12) boot: hello');
      },
      3000,
      'the first line read',
    );
    port.print('@fr1:AAEC');
    await until(() => appended.some((a) => a.text === '@fr1:AAEC'), 2000, 'the frame read');
    expect(appended.find((a) => a.text === '@fr1:AAEC')).toEqual({ key: MAC, path: `/dev/cu.usbmodem-fr-${MAC}`, text: '@fr1:AAEC' });
    // The hub's writes reach the device as lines.
    await mgr.writeLine(MAC, '#7 info');
    await mgr.writeLine(MAC, '@fr1:BBCD');
    await until(() => toDevice.length === 2, 2000, 'the two lines');
    expect(toDevice).toEqual(['#7 info', '@fr1:BBCD']);
    // Unplugged: the open handle sees a disconnect, the next poll no longer lists it, its key is gone.
    port.detach();
    await until(() => gone.includes(MAC), 5000, 'the port gone');
    await expect(mgr.writeLine(MAC, 'x')).rejects.toBeDefined();
  });

  it('takes a bridge that went away for no ports, and a poll never rejects', async () => {
    const { usb, mgr } = await rig();
    usb.attach(MAC, () => undefined);
    await mgr.poll();
    expect(mgr.list().map((p) => p.device_id)).toEqual([MAC]);
    await usb.close();
    await expect(mgr.poll()).resolves.toBeUndefined();
  });
});
