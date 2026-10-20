// REST surface generated from the operation registry: POST /api/v1/op/<name> with the op's JSON
// input returns a Result envelope (spec 09 §9.1-9.2). Loopback only.

import { errorResult, findOp, FrError, HUB_VERSION, okResult, REGISTRY_HASH } from '@fractonica/protocol';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';

import { HANDLERS, type HubContext } from './ops.ts';

export function buildServer(hub: HubContext, port: number): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 1 << 20 });
  const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

  // Localhost CSRF guard (spec 08 §8.11): browsers send Origin; only the hub's own pages may call.
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin)) {
      await reply.code(403).send({ ok: false, error: { code: 'INVALID_ARGS', message: `origin ${origin} not allowed`, retryable: false } });
    }
  });

  app.get('/api/v1/health', async () => ({ ok: true, version: HUB_VERSION, registry_hash: REGISTRY_HASH, pid: process.pid }));

  app.post<{ Params: { name: string }; Body: unknown }>('/api/v1/op/:name', async (req, reply) => {
    const cursor = hub.logs.head(); // taken BEFORE any side effect
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
