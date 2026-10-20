import { defineConfig } from 'vitest/config';

// Workspace packages export their TS sources under the private "@fractonica/source" condition.
export default defineConfig({
  resolve: { conditions: ['@fractonica/source'] },
  ssr: { resolve: { conditions: ['@fractonica/source'], externalConditions: ['@fractonica/source'] } },
  test: { include: ['packages/*/test/**/*.test.ts'] },
});
