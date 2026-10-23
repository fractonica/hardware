// REGISTRY_HASH: the CLI, `fr mcp` and the hub compare it (GET /api/v1/health), so a client never
// calls a hub whose ops differ. It covers op names and input schemas (field descriptions included), not
// summaries, tier, mcp or output. Kept out of ops.ts so node:crypto never reaches the browser entry
// (design c6 §3.2).

import { createHash } from 'node:crypto';

import { z } from 'zod';

import { OPS } from './ops.ts';

/** Changes whenever an op name or input schema changes; CLI and hub compare it. */
export const REGISTRY_HASH = createHash('sha256')
  .update(JSON.stringify(OPS.map((o) => [o.name, z.toJSONSchema(o.input)])))
  .digest('hex')
  .slice(0, 12);
