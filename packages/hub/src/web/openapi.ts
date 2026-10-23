// The OpenAPI 3.1 document of the REST surface (design c6 D17; spec 09 §9.1), served at
// GET /api/v1/openapi.json (web/static.ts) and built from the op registry, so it cannot drift from it:
// one `POST /api/v1/op/<name>` per op, its request body the op's input JSON Schema (io: input, with
// defaults), its 200 response the Result envelope whose `data` is the op's output schema (a job op's is the
// Job; an op without one is an open object). Every reply is HTTP 200 with ok true or false, except the
// guard's and Fastify's own refusals (09 §9.2). Resource-style routes are deferred (design c6 §1).

import { z } from 'zod';

import { ERROR_CODES, HUB_VERSION, JOB_ORIGINS, JobSchema, OPS, REGISTRY_HASH } from '@fractonica/protocol';

type Schema = Record<string, unknown>;

/** A Zod schema as an OpenAPI 3.1 Schema Object: JSON Schema 2020-12 without its own `$schema`. */
function jsonSchema(s: z.ZodType, io: 'input' | 'output'): Schema {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(s, { io, unrepresentable: 'any' }) as Schema;
  return rest;
}

const ToolError: Schema = {
  type: 'object',
  required: ['code', 'message', 'retryable'],
  properties: {
    code: { type: 'string', enum: [...ERROR_CODES] },
    message: { type: 'string' },
    retryable: { type: 'boolean' },
    hint: { type: 'string' },
    remediation: {
      type: 'array',
      items: {
        type: 'object',
        properties: { tool: { type: 'string' }, args: { type: 'object' }, cli: { type: 'string' }, human: { type: 'string' } },
      },
    },
    details: { type: 'object' },
  },
};

const cursorSchema: Schema = { type: 'string', pattern: '^c:\\d+\\.\\d+$', description: 'c:<run>.<seq>, minted before the side effect' };

/** The Result envelope (09 §9.2) around `data`. */
function result(data: Schema): Schema {
  return {
    oneOf: [
      {
        type: 'object',
        required: ['ok', 'data', 'cursor'],
        properties: { ok: { const: true }, data, cursor: cursorSchema, warnings: { type: 'array', items: { type: 'string' } } },
      },
      { $ref: '#/components/schemas/ErrorResult' },
    ],
  };
}

const refusal = (description: string) => ({ description, content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResult' } } } });

export function openApiDocument(): Schema {
  const paths: Schema = {
    '/api/v1/health': {
      get: {
        operationId: 'health',
        summary: 'Liveness, the hub version and REGISTRY_HASH.',
        responses: {
          200: {
            description: 'the hub answers',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { ok: { const: true }, version: { type: 'string' }, registry_hash: { type: 'string' }, pid: { type: 'integer' } },
                },
              },
            },
          },
        },
      },
    },
    '/api/v1/openapi.json': {
      get: { operationId: 'openapi', summary: 'This document.', responses: { 200: { description: 'OpenAPI 3.1', content: { 'application/json': {} } } } },
    },
  };
  for (const op of OPS) {
    const data = op.output ? jsonSchema(op.output, 'output') : op.kind === 'job' ? { $ref: '#/components/schemas/Job' } : { type: 'object' };
    paths[`/api/v1/op/${op.name}`] = {
      post: {
        operationId: op.name,
        summary: op.summary.split(/(?<=\.)\s/, 1)[0],
        description: op.summary,
        tags: [op.kind],
        'x-fr-kind': op.kind,
        'x-fr-tier': op.tier,
        'x-fr-cli': ['fr', ...op.cli.path, ...(op.cli.positional ?? []).map((p) => `<${p}>`)].join(' '),
        parameters: [
          {
            in: 'header',
            name: 'X-Fr-Client',
            required: false,
            description: 'who calls (design c6 D18): a job it starts records it as its origin',
            schema: { type: 'string', enum: [...JOB_ORIGINS] },
          },
        ],
        requestBody: { required: true, content: { 'application/json': { schema: jsonSchema(op.input, 'input') } } },
        responses: {
          200: { description: 'a Result: ok with data, or not ok with error', content: { 'application/json': { schema: result(data) } } },
          404: refusal('unknown op'),
          415: refusal('the body is not application/json'),
          421: refusal('the Host is not this hub'),
          403: refusal('a browser Origin that is not the hub'),
        },
      },
    };
  }
  return {
    openapi: '3.1.0',
    jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    info: {
      title: 'Fractonica hub',
      version: HUB_VERSION,
      description:
        'The hub API on 127.0.0.1:7420, generated from the operation registry. Events stream over WebSocket /ws (fr-ws/1) and apps connect to /app (fr-app/1); neither is described here.',
      'x-registry-hash': REGISTRY_HASH,
    },
    servers: [{ url: 'http://127.0.0.1:7420' }],
    paths,
    components: {
      schemas: {
        ToolError,
        ErrorResult: {
          type: 'object',
          required: ['ok', 'error', 'cursor'],
          properties: { ok: { const: false }, error: { $ref: '#/components/schemas/ToolError' }, cursor: cursorSchema },
        },
        Job: jsonSchema(JobSchema, 'output'),
      },
    },
  };
}
