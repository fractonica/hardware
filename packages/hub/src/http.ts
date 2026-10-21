// REST surface generated from the operation registry: POST /api/v1/op/<name> with the op's JSON
// input returns a Result envelope (spec 09 §9.1-9.2). Loopback only. Every cursor handed out here is
// minted (mintCursor), so a wait since it is dated by when the caller got it (09 §9.2).

import { errorResult, findOp, FrError, HUB_VERSION, okResult, REGISTRY_HASH } from '@fractonica/protocol';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';

import { mintCursor } from './events/index.ts';
import { HANDLERS, type HubContext } from './ops.ts';

export function buildServer(hub: HubContext, port: number): FastifyInstance {
  // job_wait, wait_s and wait_for_log hold a request for up to 110 s; on close, drop them instead of
  // waiting (callers get a retryable HUB_UNREACHABLE), or a restart would find this hub still alive.
  const app = Fastify({ logger: false, bodyLimit: 1 << 20, forceCloseConnections: true });
  const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

  // Localhost CSRF guard (spec 08 §8.11): browsers send Origin; only the hub's own pages may call.
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin)) {
      await reply.code(403).send(errorResult(new FrError('INVALID_ARGS', `origin ${origin} not allowed`), mintCursor(hub)));
    }
  });

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
    try {
      return okResult(await handler(parsed.data, hub), cursor);
    } catch (err) {
      return errorResult(err, cursor);
    }
  });
  return app;
}
