// App ops (design c6 §4, spec 09 §9.4 Codegen; stream S1): client_generate. Spread into OPS
// (packages/protocol/src/ops.ts); the handler is in packages/hub/src/apps/ops.ts. `fr codegen client
// --out <dir>` (packages/cli/src/codegen-client.ts) writes the files.

import { z } from 'zod';

import { op, selector } from './common.ts';

/**
 * One generated file, its path relative to the output directory. A `secret` file (token.ts, design c6
 * D11) is written with mode 0600 and never printed; `fr mcp` replaces its content with a note.
 */
export const GeneratedFileSchema = z.object({ path: z.string(), content: z.string(), secret: z.literal(true).optional() });
export type GeneratedFile = z.infer<typeof GeneratedFileSchema>;

export const APPS_OPS = [
  op({
    name: 'client_generate',
    kind: 'query',
    tier: 'read',
    summary:
      "Generate an app project's typed device registry for @fractonica/sdk: devices.ts (id, alias, profile, board and capability instances of each provisioned device; no secrets, commit it), token.ts (the /app token; secret: git-ignored, written 0600, never printed) and a .gitignore. Returns the file contents and registry_rev; `fr codegen client --out ./fractonica` writes them. Example: selector tag:game.",
    input: z.object({
      selector: selector.optional().describe('device selector (alias, id:<12hex>, tag:<t>, ...; default: every provisioned device)'),
      token: z.boolean().default(true).describe('also generate token.ts'),
    }),
    output: z.looseObject({
      files: z.array(GeneratedFileSchema),
      /** FNV-1a 32 of the provisioned devices (design c6 D12), 8 hex; /app compares it. */
      registry_rev: z.string().regex(/^[0-9a-f]{8}$/),
      catalog_hash: z.number().int(),
      devices: z.number().int(),
      warnings: z.array(z.string()),
    }),
    cli: { path: ['codegen', 'client'] },
  }),
] as const;

export type AppsOpName = (typeof APPS_OPS)[number]['name'];
