// Static serving (design c6 D10; stream S2): the dashboard at `/` and web/<name> at `/apps/<name>/` from a
// checkout, the token injected into an app's index.html with a CSP that allows only that script, the
// "not built" page, the staleness behind hub_status.dashboard, and GET /api/v1/openapi.json.

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { sourceHash } from '@fractonica/host';
import { OPS } from '@fractonica/protocol';

import type { HubContext, HubRunOptions } from '../src/context.ts';
import { buildServer } from '../src/http.ts';
import { createStaticSite, injectToken, readAppToken, tokenScript } from '../src/web/static.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
});

const RUN: HubRunOptions = { apiHost: '127.0.0.1', apiPort: 7420, nodeHost: '127.0.0.1', nodePort: 0, nodeHttpPort: 0, noAdvert: true, serial: false };
const HOST = { host: '127.0.0.1:7420' };
const TOKEN = 'dG9rZW4tZm9yLXRlc3RzLW9ubHktMzItYnl0ZXMhIQ';

function put(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** A checkout with the dashboard (built) and web/demo (built) and web/later (not built). */
function checkout(): string {
  const src = mkdtempSync(join(tmpdir(), 'fr-static-'));
  cleanups.push(() => rmSync(src, { recursive: true, force: true }));
  put(join(src, 'packages/protocol/package.json'), JSON.stringify({ name: '@fractonica/protocol' }));
  put(join(src, 'packages/protocol/src/index.ts'), 'export const X = 1;\n');
  put(join(src, 'packages/dashboard/package.json'), JSON.stringify({ name: '@fractonica/dashboard', dependencies: { '@fractonica/protocol': 'workspace:*' } }));
  put(join(src, 'packages/dashboard/src/main.tsx'), 'export {};\n');
  put(join(src, 'packages/dashboard/dist/index.html'), '<!doctype html><html><head><script type="module" src="/assets/index-a1.js"></script></head><body></body></html>');
  put(join(src, 'packages/dashboard/dist/assets/index-a1.js'), 'console.log(1);\n');
  put(join(src, 'packages/dashboard/dist/favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  put(join(src, 'web/demo/package.json'), JSON.stringify({ name: '@fractonica/web-demo' }));
  put(join(src, 'web/demo/dist/index.html'), '<!doctype html><html lang="en"><head data-x="1"><meta charset="utf-8"><script type="module" crossorigin src="/apps/demo/assets/main-b2.js"></script></head><body></body></html>');
  put(join(src, 'web/demo/dist/assets/main-b2.js'), 'export {};\n');
  put(join(src, 'web/demo/dist/notes.txt'), 'hello\n');
  put(join(src, 'web/later/package.json'), JSON.stringify({ name: '@fractonica/web-later' }));
  return src;
}

function site(src: string, token: string | null = TOKEN) {
  const hub = { hubSourceDir: src, logs: { run: 4, headSeq: () => 9 } } as unknown as HubContext;
  const staticSite = createStaticSite(() => hub, RUN, { appToken: () => token });
  Object.assign(hub, { staticSite });
  const app: FastifyInstance = buildServer(hub, 7420);
  cleanups.push(() => app.close());
  cleanups.push(() => staticSite.stop());
  return { app, staticSite };
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('base64');

describe('the dashboard at /', () => {
  it('serves index.html no-cache with the guard CSP, hashed assets immutable, root files, no dotfiles', async () => {
    const { app } = site(checkout());
    const index = await app.inject({ url: '/', headers: HOST });
    expect(index.statusCode).toBe(200);
    expect(index.headers['content-type']).toMatch(/^text\/html/);
    expect(index.headers['cache-control']).toBe('no-cache');
    expect(index.headers['content-security-policy']).toMatch(/script-src 'self';/);
    expect(index.headers['x-frame-options']).toBe('DENY');
    expect(index.body).toContain('/assets/index-a1.js');
    expect((await app.inject({ url: '/index.html', headers: HOST })).statusCode).toBe(200);

    const js = await app.inject({ url: '/assets/index-a1.js', headers: HOST });
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toMatch(/javascript/);
    expect(js.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(js.headers['content-security-policy']).toBeUndefined();
    expect((await app.inject({ url: '/favicon.svg', headers: HOST })).statusCode).toBe(200);

    for (const url of ['/.source-hash', '/missing.js', '/assets/nope.js', '/assets/../../package.json', '/assets', '/api/v1/nothing']) {
      const r = await app.inject({ url, headers: HOST });
      expect(r.statusCode, url).toBeGreaterThanOrEqual(400);
      expect(r.statusCode, url).toBeLessThan(500);
      expect(r.body, url).not.toContain('@fractonica/dashboard');
    }
    // An unknown path is a Result 404, not the SPA (hash history: no fallback).
    expect((await app.inject({ url: '/missing.js', headers: HOST })).json()).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  it('answers 503 with the "not built" page while dist is missing', async () => {
    const src = checkout();
    rmSync(join(src, 'packages/dashboard/dist'), { recursive: true });
    const { app, staticSite } = site(src);
    const r = await app.inject({ url: '/', headers: HOST });
    expect(r.statusCode).toBe(503);
    expect(r.headers['content-type']).toMatch(/^text\/html/);
    expect(r.headers['content-security-policy']).toBeDefined();
    expect(r.body).toContain('fr doctor --fix');
    expect(staticSite.dashboard()).toEqual({ url: 'http://127.0.0.1:7420/', built: false, stale: false });
    expect(staticSite.warnings!()).toEqual([expect.stringMatching(/dashboard is not built.*fr doctor --fix/)]);
  });

  it('reports stale when dist/.source-hash is not the hash of the current sources', async () => {
    const src = checkout();
    const { staticSite } = site(src);
    await staticSite.start();
    staticSite.stop();
    // Built by hand (no .source-hash): stale.
    expect(staticSite.dashboard()).toMatchObject({ built: true, stale: true });
    expect(staticSite.warnings!()).toEqual([expect.stringMatching(/older than its sources/)]);
    put(join(src, 'packages/dashboard/dist/.source-hash'), `${await sourceHash(src, join(src, 'packages/dashboard'))}\n`);
    expect(staticSite.dashboard()).toMatchObject({ built: true, stale: false });
    expect(staticSite.warnings!()).toEqual([]);
    // A source of a bundled workspace package changes: stale again once the hash is recomputed.
    put(join(src, 'packages/protocol/src/index.ts'), 'export const X = 2;\n');
    await staticSite.start();
    staticSite.stop();
    expect(staticSite.dashboard()).toMatchObject({ stale: true });
  });

  it('has no warning and nothing built for a checkout without the dashboard', () => {
    const { staticSite } = site('/nowhere');
    expect(staticSite.dashboard()).toEqual({ url: 'http://127.0.0.1:7420/', built: false, stale: false });
    expect(staticSite.warnings!()).toEqual([]);
  });
});

describe('hosted apps at /apps/<name>/', () => {
  it('injects the token first in <head>, no-store, with a CSP that allows that one inline script', async () => {
    const { app } = site(checkout());
    for (const url of ['/apps/demo/', '/apps/demo/index.html']) {
      const r = await app.inject({ url, headers: HOST });
      expect(r.statusCode, url).toBe(200);
      expect(r.headers['cache-control']).toBe('no-store');
      const script = `window.__FRACTONICA__={token:"${TOKEN}"}`;
      expect(r.body).toContain(`<head data-x="1"><script>${script}</script><meta charset="utf-8">`);
      expect(r.body.indexOf(script)).toBeLessThan(r.body.indexOf('type="module"'));
      const csp = String(r.headers['content-security-policy']);
      expect(csp).toContain(`script-src 'self' 'sha256-${sha256(script)}'`);
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).not.toContain('unsafe-inline\'; connect'); // scripts never unsafe-inline
      expect(r.headers['x-frame-options']).toBe('DENY');
    }
    const asset = await app.inject({ url: '/apps/demo/assets/main-b2.js', headers: HOST });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toContain('immutable');
    const notes = await app.inject({ url: '/apps/demo/notes.txt', headers: HOST });
    expect(notes.statusCode).toBe(200);
    expect(notes.headers['cache-control']).not.toContain('immutable');
  });

  it('redirects /apps/<name>, refuses unknown and odd names, serves "not built" for an app without dist', async () => {
    const { app } = site(checkout());
    const redirect = await app.inject({ url: '/apps/demo', headers: HOST });
    expect(redirect.statusCode).toBe(302);
    expect(redirect.headers.location).toBe('/apps/demo/');
    for (const url of ['/apps/nope/', '/apps/nope', '/apps/De..mo/', '/apps/demo..x/']) {
      expect((await app.inject({ url, headers: HOST })).statusCode, url).toBe(404);
    }
    // Dot segments never leave a dist (here they resolve to the dashboard's root, which has no such file).
    for (const url of ['/apps/demo/%2e%2e/package.json', '/apps/demo/%2e%2e/%2e%2e/web/demo/package.json', '/apps/%2e%2e/web/demo/package.json']) {
      const r = await app.inject({ url, headers: HOST });
      expect(r.body, url).not.toContain('@fractonica/web-');
    }
    const later = await app.inject({ url: '/apps/later/', headers: HOST });
    expect(later.statusCode).toBe(503);
    expect(later.body).toContain('pnpm --filter @fractonica/web-later build');
    expect((await app.inject({ url: '/apps/demo/missing.js', headers: HOST })).statusCode).toBe(404);
    // GET only (the guard).
    expect((await app.inject({ method: 'POST', url: '/apps/demo/', headers: { ...HOST, 'content-type': 'application/json' }, payload: '{}' })).statusCode).toBe(405);
  });

  it('keeps raw dot segments inside the dist over a real socket', async () => {
    const src = checkout();
    put(join(src, 'secret.txt'), 'top secret\n');
    const { app } = site(src);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    const get = (path: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, path, headers: { host: `127.0.0.1:${port}` } }, (res) => {
          let body = '';
          res.on('data', (d) => (body += d));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on('error', reject);
        req.end();
      });
    for (const path of ['/apps/demo/../../../secret.txt', '/apps/demo/%2e%2e/%2e%2e/%2e%2e/secret.txt', '/apps/%2e%2e/secret.txt', '/assets/%2e%2e/%2e%2e/%2e%2e/%2e%2e/secret.txt', '/apps/demo/..%2f..%2f..%2fsecret.txt']) {
      const r = await get(path);
      expect(r.body, path).not.toContain('top secret');
      expect(r.status, path).toBeGreaterThanOrEqual(400);
    }
    expect((await get('/apps/demo/notes.txt')).body).toBe('hello\n');
  });

  it('injects a null token while secrets.json has none', async () => {
    const { app } = site(checkout(), null);
    expect((await app.inject({ url: '/apps/demo/', headers: HOST })).body).toContain('window.__FRACTONICA__={token:null}');
  });

  it('injects the token the AppServer checks by default, and null while it has none', async () => {
    let token: string | null = 'from-the-app-server-0123456789abcdef';
    const appServer = {
      appToken: () => {
        if (token === null) {
          throw new Error('no /app token');
        }
        return token;
      },
      start() {},
      stop() {},
      routes() {},
    };
    const hub = { hubSourceDir: checkout(), logs: { run: 4, headSeq: () => 9 }, appServer } as unknown as HubContext;
    const staticSite = createStaticSite(() => hub, RUN);
    Object.assign(hub, { staticSite });
    const app = buildServer(hub, 7420);
    cleanups.push(() => app.close());
    expect((await app.inject({ url: '/apps/demo/', headers: HOST })).body).toContain(`window.__FRACTONICA__={token:"${token}"}`);
    token = null;
    expect((await app.inject({ url: '/apps/demo/', headers: HOST })).body).toContain('window.__FRACTONICA__={token:null}');
  });

  it('reads app_token from secrets.json, and injects before the first tag without a <head>', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fr-secrets-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, 'secrets.json');
    expect(readAppToken(file)).toBeNull();
    writeFileSync(file, JSON.stringify({ wifi_password: 'x', app_token: TOKEN }));
    expect(readAppToken(file)).toBe(TOKEN);
    writeFileSync(file, '{broken');
    expect(readAppToken(file)).toBeNull();
    expect(injectToken('<p>hi</p>', tokenScript('t'))).toBe('<script>window.__FRACTONICA__={token:"t"}</script><p>hi</p>');
    expect(injectToken('<HEAD><title>x</title>', 'a')).toBe('<HEAD><script>a</script><title>x</title>');
    expect(injectToken('<header>no head</header>', 'a')).toBe('<script>a</script><header>no head</header>');
  });
});

describe('GET /api/v1/openapi.json (D17)', () => {
  it('describes every op as POST /api/v1/op/<name> with its input and output schemas', async () => {
    const { app } = site(checkout());
    const r = await app.inject({ url: '/api/v1/openapi.json', headers: HOST });
    expect(r.statusCode).toBe(200);
    const doc = r.json() as { openapi: string; paths: Record<string, any>; components: { schemas: Record<string, unknown> } };
    expect(doc.openapi).toBe('3.1.0');
    for (const op of OPS) {
      const post = doc.paths[`/api/v1/op/${op.name}`]?.post;
      expect(post, op.name).toBeDefined();
      expect(post.operationId).toBe(op.name);
      expect(post['x-fr-tier']).toBe(op.tier);
      expect(post.requestBody.content['application/json'].schema).toMatchObject({ type: 'object' });
    }
    const events = doc.paths['/api/v1/op/events_read'].post;
    expect(events.requestBody.content['application/json'].schema.properties.max_events).toMatchObject({ default: expect.any(Number) });
    const status = doc.paths['/api/v1/op/hub_status'].post.responses[200].content['application/json'].schema.oneOf[0];
    expect(status.properties.data.properties).toHaveProperty('registry_hash');
    const job = doc.paths['/api/v1/op/build_start'].post.responses[200].content['application/json'].schema.oneOf[0];
    expect(job.properties.data).toEqual({ $ref: '#/components/schemas/Job' });
    // Every $ref resolves: all point into components (no Zod $defs, which would resolve against the document root).
    const refs = [...r.body.matchAll(/"\$ref":"([^"]*)"/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(OPS.length);
    for (const ref of new Set(refs)) {
      expect(ref).toMatch(/^#\/components\/schemas\/\w+$/);
      expect(doc.components.schemas, ref).toHaveProperty(ref.split('/').pop()!);
    }
    expect(r.body).not.toContain('"$schema"');
  });
});
