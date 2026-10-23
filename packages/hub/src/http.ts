// REST surface generated from the operation registry: POST /api/v1/op/<name> with the op's JSON
// input returns a Result envelope (spec 09 §9.1-9.2). Loopback only, behind the web guard (web/guard.ts,
// design c6 D9). Every cursor handed out here is minted (mintCursor), so a wait since it is dated by when
// the caller got it (09 §9.2). The C6 web parts (/app, /ws, static serving) add their routes here once.

import websocket from '@fastify/websocket';
import { CLIENT_HEADER, errorResult, findOp, FrError, HUB_VERSION, JOB_ORIGINS, okResult, REGISTRY_HASH, type JobOrigin } from '@fractonica/protocol';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';

import { mintCursor } from './events/index.ts';
import { requestClient } from './jobs.ts';
import { HANDLERS, type HubContext } from './ops.ts';
import { requestSignal } from './prompts.ts';
import { installGuard } from './web/guard.ts';

/**
 * WebSocket server options for `/app` and `/ws`: client frames are small (fr-app/1 commands at most 16 KiB,
 * design c6 §4; fr-ws/1 subscriptions far less), and no permessage-deflate, which costs latency.
 */
const WS_OPTIONS = { maxPayload: 16 * 1024, perMessageDeflate: false };

/** The X-Fr-Client header's client (design c6 D18), or undefined when absent or not one of JOB_ORIGINS. */
function clientOf(header: string | string[] | undefined): JobOrigin | undefined {
  const v = typeof header === 'string' ? header.trim().toLowerCase() : undefined;
  return (JOB_ORIGINS as readonly string[]).includes(v ?? '') ? (v as JobOrigin) : undefined;
}

export function buildServer(hub: HubContext, port: number): FastifyInstance {
  // job_wait, wait_s and wait_for_log hold a request for up to 110 s; on close, drop them instead of
  // waiting (callers get a retryable HUB_UNREACHABLE), or a restart would find this hub still alive.
  const app = Fastify({ logger: false, bodyLimit: 1 << 20, forceCloseConnections: true });

  // Host, Origin per route, JSON-only mutations and HTML headers (design c6 D9), before every route.
  installGuard(app, { port, cursor: () => mintCursor(hub) });

  // Every reply is a Result envelope (spec 09 §9.2), Fastify's own included: unknown routes, and
  // malformed JSON (400), a body over 1 MB (413) or a wrong content type (415).
  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send(errorResult(new FrError('NOT_FOUND', `no route ${req.method} ${req.url}`), mintCursor(hub))),
  );
  app.setErrorHandler((err, _req, reply) => {
    const code = (err as { statusCode?: unknown } | null)?.statusCode;
    const status = typeof code === 'number' && code >= 400 ? code : 500;
    const message = err instanceof Error ? err.message : String(err);
    return reply.code(status).send(errorResult(status < 500 ? new FrError('INVALID_ARGS', message) : err, mintCursor(hub)));
  });

  app.get('/api/v1/health', async () => ({ ok: true, version: HUB_VERSION, registry_hash: REGISTRY_HASH, pid: process.pid }));

  app.post<{ Params: { name: string }; Body: unknown }>('/api/v1/op/:name', async (req, reply) => {
    const cursor = mintCursor(hub); // taken BEFORE any side effect
    const op = findOp(req.params.name);
    const handler = op ? HANDLERS[op.name as keyof typeof HANDLERS] : undefined;
    if (!op || !handler) {
      return reply.code(404).send(errorResult(new FrError('NOT_FOUND', `unknown op ${req.params.name}`), cursor));
    }
    const parsed = op.input.safeParse(req.body ?? {});
    if (!parsed.success) {
      return errorResult(
        new FrError('INVALID_ARGS', z.prettifyError(parsed.error), { details: { issues: parsed.error.issues } }),
        cursor,
      );
    }
    // A job the op starts records the calling client as its origin (design c6 D18).
    const client = clientOf(req.headers[CLIENT_HEADER]);
    // The op runs inside the request's abort signal (prompts.ts requestSignal), aborted when the client
    // goes away before the reply (an `fr mcp` cancel, a killed `fr wait`): a prompt_human wait then ends
    // at once and its prompt as cancelled (design c6 D3).
    const gone = new AbortController();
    reply.raw.once('close', () => {
      if (!reply.raw.writableFinished) {
        gone.abort();
      }
    });
    const call = () => requestSignal.run(gone.signal, () => handler(parsed.data, hub));
    try {
      return okResult(await (client ? requestClient.run(client, call) : call()), cursor);
    } catch (err) {
      return errorResult(err, cursor);
    }
  });

  // The C6 web parts (design c6 §3.3): /app (S1), /ws and static serving (S2), registered once, after
  // @fastify/websocket so their routes may upgrade.
  void app.register(websocket, { options: WS_OPTIONS });
  const parts = [hub.appServer, hub.wsServer, hub.staticSite].filter((p) => p !== undefined);
  if (parts.length) {
    void app.register(async (scope) => {
      for (const part of parts) {
        await part.routes(scope);
      }
    });
  }
  return app;
}
