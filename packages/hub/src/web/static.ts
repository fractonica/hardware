// Static serving (design c6 D10; spec 08 §8.9-8.10; stream S2), on @fastify/static, from the hub's checkout:
// - `/` is the dashboard, packages/dashboard/dist: index.html with no-cache, Vite's hashed /assets/*
//   immutable, the other files at the dist root (favicon) as they are. The dashboard routes with a hash
//   history, so there is no SPA fallback: an unknown path is a 404.
// - `/apps/<name>/` is web/<name>/dist: index.html gets `window.__FRACTONICA__={token:"…"}` (the /app
//   token, design c6 D11) in an inline script the page's CSP allows by its hash, and no-store, so the token
//   is never cached. `/apps/<name>` redirects there.
// - A package without a dist answers 503 with the "not built" page; `fr doctor --fix` builds it.
// - dist/.source-hash against the sources (@fractonica/host web.ts) says whether the dashboard is stale:
//   hub_status.dashboard and a warning. The source hash is recomputed every 30 s, off the request path.
// - GET /api/v1/openapi.json, the op registry as OpenAPI 3.1 (web/openapi.ts).
// The guard (web/guard.ts) has checked Host, Origin and the method before any of these routes runs, and
// gives HTML its CSP and X-Frame-Options unless a route sets its own (the app index does).

import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply } from 'fastify';

import { appDir, dashboardDir, distStatus, paths, SOURCE_HASH_FILE } from '@fractonica/host';
import { errorResult, FrError } from '@fractonica/protocol';

import type { HubContext, HubRunOptions, StaticSite } from '../context.ts';
import { mintCursor } from '../events/index.ts';
import { htmlSecurityHeaders } from './guard.ts';
import { openApiDocument } from './openapi.ts';

/** How often the dashboard's source hash is recomputed for hub_status. */
const STALE_CHECK_MS = 30_000;
/** Vite's content-hashed output: cached for a year. */
const IMMUTABLE = { immutable: true, maxAge: 365 * 24 * 3600 * 1000 };
/** An app's directory name under web/. */
const APP_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface StaticOptions {
  /**
   * The `/app` token injected into an app's index.html (design c6 D11). Default: the AppServer's own (the
   * one `/app` checks; apps/, S1, creates it when it starts), else `app_token` from secrets.json, read only.
   */
  appToken?: () => string | null;
}

/** The token `/app` checks: the AppServer's appToken() when it has one, else secrets.json's; null without one. */
function hubAppToken(hub: HubContext): string | null {
  const server = hub.appServer as { appToken?: () => string } | undefined;
  if (typeof server?.appToken === 'function') {
    try {
      return server.appToken();
    } catch {
      return null; // its warning in hub_status says why
    }
  }
  return readAppToken(paths.secrets());
}

/** secrets.json's app_token, or null. Read on every app page, so a token created later is picked up. */
export function readAppToken(file: string): string | null {
  try {
    const t = (JSON.parse(readFileSync(file, 'utf8')) as { app_token?: unknown }).app_token;
    return typeof t === 'string' && t ? t : null;
  } catch {
    return null;
  }
}

/** The inline script an app's index.html gets: the token the SDK reads at connect. */
export function tokenScript(token: string | null): string {
  return `window.__FRACTONICA__={token:${JSON.stringify(token)}}`;
}

/** index.html with the token script first in <head> (before any module script), or first in the file. */
export function injectToken(html: string, script: string): string {
  const tag = `<script>${script}</script>`;
  const head = /<head(\s[^>]*)?>/i.exec(html);
  return head ? html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length) : tag + html;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The page for a package without a build (503): what it is, where its dist would be, how to build it. */
export function notBuiltPage(what: string, dist: string, build: string): string {
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8"><title>Fractonica: not built</title></head>',
    '<body style="font: 16px/1.5 system-ui, sans-serif; max-width: 42rem; margin: 3rem auto; padding: 0 1rem">',
    `<h1>${escapeHtml(what)} is not built</h1>`,
    `<p>The hub serves it from <code>${escapeHtml(dist)}</code>, which has no <code>index.html</code>.</p>`,
    `<p>Build it with <code>fr doctor --fix</code> (or <code>${escapeHtml(build)}</code>), then reload this page.</p>`,
    '</body></html>',
    '',
  ].join('\n');
}

export function createStaticSite(hub: () => HubContext, run: HubRunOptions, opts: StaticOptions = {}): StaticSite {
  const appToken = opts.appToken ?? (() => hubAppToken(hub()));
  /** The dashboard sources' hash, as last computed (null before the first). */
  let sourceHash: { dir: string; hash: string } | null = null;
  let timer: NodeJS.Timeout | null = null;
  let checking = false;
  let boundPort: () => number = () => run.apiPort;

  const dashDir = () => dashboardDir(hub().hubSourceDir);
  const refresh = async () => {
    if (checking) {
      return;
    }
    checking = true;
    try {
      const dir = dashDir();
      if (existsSync(join(dir, 'package.json'))) {
        sourceHash = { dir, hash: (await distStatus(hub().hubSourceDir, dir)).hash };
      }
    } catch {
      // a checkout that cannot be read: staleness stays unknown, which reads as fresh
    } finally {
      checking = false;
    }
  };

  const dashboard = () => {
    const dir = dashDir();
    const dist = join(dir, 'dist');
    const built = existsSync(join(dist, 'index.html'));
    let stale = false;
    if (built && sourceHash?.dir === dir) {
      let builtFrom: string | null = null;
      try {
        builtFrom = readFileSync(join(dist, SOURCE_HASH_FILE), 'utf8').trim();
      } catch {
        // built without fr doctor --fix: no record of its sources
      }
      stale = builtFrom !== sourceHash.hash;
    }
    return { url: `http://127.0.0.1:${boundPort()}/`, built, stale };
  };

  const notFound = (reply: FastifyReply, message: string) =>
    reply.code(404).send(errorResult(new FrError('NOT_FOUND', message), mintCursor(hub())));

  const notBuilt = (reply: FastifyReply, what: string, dist: string, build: string) =>
    reply.code(503).header('cache-control', 'no-store').type('text/html; charset=utf-8').send(notBuiltPage(what, dist, build));

  return {
    async start() {
      await refresh();
      timer = setInterval(() => void refresh(), STALE_CHECK_MS);
      timer.unref();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    warnings() {
      if (!existsSync(join(dashDir(), 'package.json'))) {
        return []; // a checkout without the dashboard (an older one, a test hub)
      }
      const d = dashboard();
      if (!d.built) {
        return [`the dashboard is not built (${d.url} shows a "not built" page): run \`fr doctor --fix\``];
      }
      return d.stale ? ['the dashboard is older than its sources: run `fr doctor --fix` to rebuild it'] : [];
    },
    dashboard,

    async routes(app: FastifyInstance) {
      // The port the server bound (a test hub asks for 0), for the app pages' CSP and hub_status.dashboard.
      boundPort = () => (app.server.address() as AddressInfo | null)?.port || run.apiPort;
      // Only reply.sendFile: the routes below choose the root per request (the dashboard or an app).
      await app.register(fastifyStatic, { serve: false, index: false, redirect: false, list: false, dotfiles: 'ignore' });

      let openapi: string | null = null;
      app.get('/api/v1/openapi.json', (_req, reply) => {
        openapi ??= JSON.stringify(openApiDocument());
        return reply.type('application/json; charset=utf-8').send(openapi);
      });

      // ---- the dashboard ----
      const index = (reply: FastifyReply) => {
        const dist = join(dashDir(), 'dist');
        if (!existsSync(join(dist, 'index.html'))) {
          return notBuilt(reply, 'The dashboard', dist, 'pnpm --filter @fractonica/dashboard build');
        }
        return reply.header('cache-control', 'no-cache').sendFile('index.html', dist, { cacheControl: false });
      };
      app.get('/', (_req, reply) => index(reply));
      app.get('/index.html', (_req, reply) => index(reply));
      app.get<{ Params: { '*': string } }>('/assets/*', (req, reply) => reply.sendFile(req.params['*'], join(dashDir(), 'dist', 'assets'), IMMUTABLE));
      app.get<{ Params: { file: string } }>('/:file', (req, reply) => reply.sendFile(req.params.file, join(dashDir(), 'dist')));

      // ---- hosted apps ----
      const appRoot = (name: string) => (APP_NAME.test(name) ? appDir(hub().hubSourceDir, name) : null);
      app.get<{ Params: { name: string } }>('/apps/:name', (req, reply) => {
        const dir = appRoot(req.params.name);
        return dir && existsSync(dir) ? reply.redirect(`/apps/${req.params.name}/`) : notFound(reply, `no app ${req.params.name} (web/${req.params.name})`);
      });
      app.get<{ Params: { name: string; '*': string } }>('/apps/:name/*', async (req, reply) => {
        const { name } = req.params;
        const rest = req.params['*'];
        const dir = appRoot(name);
        if (!dir || !existsSync(dir)) {
          return notFound(reply, `no app ${name} (web/${name})`);
        }
        const dist = join(dir, 'dist');
        if (rest === '' || rest === 'index.html') {
          let html: string;
          try {
            html = await readFile(join(dist, 'index.html'), 'utf8');
          } catch {
            return notBuilt(reply, `The app ${name}`, dist, `pnpm --filter @fractonica/web-${name} build`);
          }
          const script = tokenScript(appToken());
          return reply
            .headers({ 'cache-control': 'no-store', ...htmlSecurityHeaders(boundPort(), { inlineScripts: [script] }) })
            .type('text/html; charset=utf-8')
            .send(injectToken(html, script));
        }
        return rest.startsWith('assets/') ? reply.sendFile(rest, dist, IMMUTABLE) : reply.sendFile(rest, dist);
      });
    },
  };
}
