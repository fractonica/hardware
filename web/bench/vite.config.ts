// WIRING-1's bench app (design wiring-w1 D4), served by the hub at /apps/bench/. `@fractonica/protocol` resolves to its
// TS sources through the private `@fractonica/source` condition (08 §8.12), as web/power's does.

import { defaultClientConditions, defineConfig } from 'vite';

export default defineConfig({
  base: '/apps/bench/',
  resolve: { conditions: ['@fractonica/source', ...defaultClientConditions] },
  build: { outDir: 'dist', emptyOutDir: true },
});
