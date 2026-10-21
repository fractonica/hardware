// The node HTTP listener on its own (design c4 §4, spec 08 §8.10): `GET /ota/<fw_id>.bin` answers what the
// gate (authorize) allows, with Range (206, Content-Range; 416 for a range outside the image or several
// ranges), streams the file, reports progress offsets; 404 for everything else, 501 for the coredump route.

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { type Authorize, NodeHttpServer, parseRange } from '../src/ota/http.ts';

let dir: string;
let file: string;
const image = randomBytes(10_000);
const FW = 'ab'.repeat(32);
const servers: NodeHttpServer[] = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'fr-ota-http-'));
  file = join(dir, 'app.bin');
  writeFileSync(file, image);
});
afterEach(async () => {
  for (const s of servers.splice(0)) {
    await s.close();
  }
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function serve(authorize: Authorize): Promise<number> {
  const s = new NodeHttpServer({ host: '127.0.0.1', port: 0, authorize });
  servers.push(s);
  return s.listen();
}

interface Got {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

function get(port: number, path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Got> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('parseRange', () => {
  it('takes one byte range, open-ended or a suffix, clamped to the image', () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=40-', 100)).toEqual({ start: 40, end: 99 });
    expect(parseRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 });
    expect(parseRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 });
  });

  it('calls a range outside the image, several ranges or another unit unsatisfiable', () => {
    for (const h of ['bytes=100-', 'bytes=20-10', 'bytes=0-1,5-6', 'items=0-1', 'bytes=-0', 'bytes=-', 'bytes=x-']) {
      expect(parseRange(h, 100), h).toBe('unsatisfiable');
    }
  });
});

describe('NodeHttpServer', () => {
  it('serves the authorized image whole (200) and by Range (206), reporting progress offsets', async () => {
    const asked: [string, string][] = [];
    const sent: number[] = [];
    const port = await serve((fw, ip) => {
      asked.push([fw, ip]);
      return { path: file, size: image.length, onSent: (end) => sent.push(end) };
    });
    const whole = await get(port, `/ota/${FW.toUpperCase()}.bin`);
    expect(whole.status).toBe(200);
    expect(whole.headers['content-length']).toBe(String(image.length));
    expect(whole.headers['accept-ranges']).toBe('bytes');
    expect(whole.body.equals(image)).toBe(true);
    expect(asked[0]).toEqual([FW, '127.0.0.1']); // lower-cased fw_id, the request's IPv4 source
    expect(sent.at(-1)).toBe(image.length);

    sent.length = 0;
    const tail = await get(port, `/ota/${FW}.bin`, { range: 'bytes=4096-' });
    expect(tail.status).toBe(206);
    expect(tail.headers['content-range']).toBe(`bytes 4096-${image.length - 1}/${image.length}`);
    expect(tail.body.equals(image.subarray(4096))).toBe(true);
    expect(sent.at(-1)).toBe(image.length);

    const mid = await get(port, `/ota/${FW}.bin`, { range: 'bytes=100-199' });
    expect(mid.status).toBe(206);
    expect(mid.headers['content-length']).toBe('100');
    expect(mid.body.equals(image.subarray(100, 200))).toBe(true);

    const head = await get(port, `/ota/${FW}.bin`, {}, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.body.length).toBe(0);
  });

  it('answers 416 with the size for a range it cannot serve', async () => {
    const port = await serve(() => ({ path: file, size: image.length }));
    const r = await get(port, `/ota/${FW}.bin`, { range: `bytes=${image.length}-` });
    expect(r.status).toBe(416);
    expect(r.headers['content-range']).toBe(`bytes */${image.length}`);
    expect((await get(port, `/ota/${FW}.bin`, { range: 'bytes=0-1,4-5' })).status).toBe(416);
  });

  it('is 404 when the gate says no, for other paths and methods; 501 for the coredump route', async () => {
    let allow = false;
    const port = await serve(() => (allow ? { path: file, size: image.length } : null));
    expect((await get(port, `/ota/${FW}.bin`)).status).toBe(404);
    allow = true;
    expect((await get(port, `/ota/${FW}.bin`)).status).toBe(200);
    expect((await get(port, `/ota/${FW.slice(2)}.bin`)).status).toBe(404); // not 64 hex
    expect((await get(port, `/ota/${FW}`)).status).toBe(404);
    expect((await get(port, '/')).status).toBe(404);
    expect((await get(port, `/ota/${FW}.bin`, {}, 'POST')).status).toBe(404);
    expect((await get(port, '/node/v1/coredump/aabbccddeeff', {}, 'POST')).status).toBe(501);
  });

  it('is 404 when the gate throws, and drops a download whose file is gone', async () => {
    const port = await serve((fw) => {
      if (fw.startsWith('ab')) {
        throw new Error('gate bug');
      }
      return { path: join(dir, 'missing.bin'), size: 10 };
    });
    expect((await get(port, `/ota/${FW}.bin`)).status).toBe(404);
    await expect(get(port, `/ota/${'cd'.repeat(32)}.bin`)).rejects.toThrow(); // headers, then a reset
  });

  it('closes with downloads open and reports its port only while listening', async () => {
    const s = new NodeHttpServer({ host: '127.0.0.1', port: 0, authorize: () => ({ path: file, size: image.length }) });
    expect(s.port()).toBeNull();
    const port = await s.listen();
    expect(s.port()).toBe(port);
    await s.close();
    expect(s.port()).toBeNull();
    await expect(get(port, `/ota/${FW}.bin`)).rejects.toThrow();
  });
});
