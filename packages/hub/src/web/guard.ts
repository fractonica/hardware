// The web guard (design c6 D9; spec 08 §8.10-8.11), moved here from http.ts: what every request to the
// API port passes before a route sees it. The hub listens on loopback only, but a browser on the same Mac
// sends requests from whatever page it shows, so:
// - Host must name this hub: 127.0.0.1, localhost or [::1] with its port, else 421. A DNS-rebinding page
//   reaches the port under a host name of its own.
// - Origin, when a browser sends one, is checked per route: /api, /ws and the dashboard take the hub's own
//   pages only; /app takes any loopback origin (an app's dev server) or none, and checks its token itself
//   (apps/server.ts); /apps/* is GET (and HEAD) only.
// - Mutations need Content-Type application/json, else 415 (Fastify's text/plain parser is removed): a
//   cross-site form or a no-cors fetch cannot send that type without a CORS preflight, which fails.
// - HTML replies get a Content-Security-Policy and X-Frame-Options DENY, unless the route set its own.
// The CLI, MCP and agents send no Origin and a loopback Host, and pass. Refusals are Result envelopes.
// listenLoopbackV6 adds the [::1] listener, so `localhost` resolving to ::1 first reaches the hub too.

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { errorResult, FrError } from '@fractonica/protocol';

/** The loopback host names the hub answers to (Host and the hub's own origins). */
const HUB_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];

export interface GuardOptions {
  /** The API port as configured; with 0 (a test hub), the port the server bound. */
  port: number;
  /** The cursor a refusal's Result envelope carries (mintCursor). */
  cursor(): string;
}

/** Which rules a path falls under (D9). */
export type RouteClass = 'api' | 'app' | 'apps' | 'site';

export function routeClass(url: string): RouteClass {
  const path = url.split('?', 1)[0];
  if (path === '/app') {
    return 'app';
  }
  if (path === '/apps' || path.startsWith('/apps/')) {
    return 'apps';
  }
  if (path === '/ws' || path === '/api' || path.startsWith('/api/')) {
    return 'api';
  }
  return 'site'; // the dashboard (`/`, its assets) and unknown paths
}

/** The Host values this hub answers to: `127.0.0.1:<port>`, `localhost:<port>`, `[::1]:<port>`. */
export function hubHosts(port: number): string[] {
  return HUB_HOSTS.map((h) => `${h}:${port}`);
}

/** The origins of the hub's own pages (the dashboard and `/apps/*`). */
export function hubOrigins(port: number): string[] {
  return hubHosts(port).map((h) => `http://${h}`);
}

/** An http(s) origin on this Mac's loopback: 127.0.0.0/8, localhost (and *.localhost) or [::1], any port. */
export function isLoopbackOrigin(origin: string): boolean {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false; // `null` (a sandboxed frame, file://) among others
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.origin !== origin.toLowerCase()) {
    return false;
  }
  const host = u.hostname;
  return host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || /^127(\.\d{1,3}){3}$/.test(host);
}

/**
 * CSP and X-Frame-Options for an HTML reply. `inlineScripts`: inline `<script>` bodies the page may run
 * (an app's `window.__FRACTONICA__` injection), allowed by hash. Inline styles are allowed (xterm sets
 * them); WebSockets go to the page's own host ('self') or the hub under its IPv4 and localhost names. CSP
 * host-sources take no IPv6 literal (browsers drop `ws://[::1]:<port>` with a console error), and a page
 * served from [::1] reaches the hub's [::1] listener through 'self'.
 */
export function htmlSecurityHeaders(port: number, opts: { inlineScripts?: string[] } = {}): Record<string, string> {
  const hashes = (opts.inlineScripts ?? []).map((s) => ` 'sha256-${createHash('sha256').update(s).digest('base64')}'`);
  const csp = [
    "default-src 'self'",
    `script-src 'self'${hashes.join('')}`,
    `connect-src 'self' ${hubHosts(port).filter((h) => !h.startsWith('[')).map((h) => `ws://${h}`).join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
  return { 'content-security-policy': csp, 'x-frame-options': 'DENY' };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Installs the guard on the root instance, before any route: the hooks then cover every route and plugin. */
export function installGuard(app: FastifyInstance, opts: GuardOptions): void {
  const boundPort = () => (app.server.address() as AddressInfo | null)?.port;
  const ports = () => [...new Set([opts.port, boundPort()])].filter((p): p is number => typeof p === 'number' && p > 0);
  const refuse = (req: FastifyRequest, reply: FastifyReply, status: number, message: string) => {
    if (req.headers.upgrade !== undefined) {
      // A refused WebSocket upgrade: its socket has left Node's HTTP parser, so nothing would end it after
      // the reply, and a client could send its next request into it.
      reply.header('connection', 'close');
      reply.raw.once('finish', () => req.raw.socket?.end());
    }
    return reply.code(status).send(errorResult(new FrError('INVALID_ARGS', message), opts.cursor()));
  };

  app.removeContentTypeParser('text/plain');

  app.addHook('onRequest', async (req, reply) => {
    const allowed = ports();
    const host = req.headers.host?.toLowerCase();
    if (!host || !allowed.some((p) => hubHosts(p).includes(host))) {
      return refuse(req, reply, 421, `host ${host ?? '(none)'} is not this hub; use http://127.0.0.1:${allowed[0] ?? opts.port}`);
    }
    const cls = routeClass(req.url);
    const origin = req.headers.origin;
    if (origin !== undefined && !(cls === 'app' ? isLoopbackOrigin(origin) : allowed.some((p) => hubOrigins(p).includes(origin)))) {
      return refuse(req, reply, 403, `origin ${origin} not allowed`);
    }
    if (cls === 'apps' && req.method !== 'GET' && req.method !== 'HEAD') {
      reply.header('allow', 'GET, HEAD');
      return refuse(req, reply, 405, `${req.method} ${req.url.split('?', 1)[0]}: apps are served GET only`);
    }
    if (!SAFE_METHODS.has(req.method)) {
      const type = req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
      if (type !== 'application/json') {
        return refuse(req, reply, 415, `${req.method} needs Content-Type application/json (got ${type ?? 'none'})`);
      }
    }
  });

  app.addHook('onSend', async (_req, reply, payload) => {
    const type = reply.getHeader('content-type');
    if (typeof type === 'string' && type.startsWith('text/html')) {
      for (const [name, value] of Object.entries(htmlSecurityHeaders(boundPort() || opts.port))) {
        if (!reply.hasHeader(name)) {
          reply.header(name, value);
        }
      }
    }
    return payload;
  });
}

/**
 * The [::1] listener (D9) on the port the app listens on: requests and upgrades go to the same handlers
 * as the 127.0.0.1 listener's. Single instance stays on 127.0.0.1 (lock.ts). A ::1 that is unavailable
 * (IPv6 off) or taken leaves the hub on 127.0.0.1 alone and returns why. It closes with the app.
 */
export async function listenLoopbackV6(app: FastifyInstance): Promise<{ port: number | null; error: string | null }> {
  const main = app.server;
  const { port } = main.address() as AddressInfo;
  const v6 = createServer();
  v6.on('request', (req, res) => main.emit('request', req, res));
  v6.on('upgrade', (req, socket, head) => main.emit('upgrade', req, socket, head));
  try {
    await new Promise<void>((resolve, reject) => {
      v6.once('error', reject);
      v6.listen({ host: '::1', port, ipv6Only: true }, () => {
        v6.off('error', reject);
        resolve();
      });
    });
  } catch (e) {
    return { port: null, error: (e as Error).message };
  }
  // Like Fastify's own secondary listeners: closed, connections and all, when the main server closes.
  main.once('close', () => {
    v6.close();
    v6.closeAllConnections();
  });
  return { port, error: null };
}
