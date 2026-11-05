// POWER-1's power app (design power-p1 D11), served by the hub at /apps/power/. `@fractonica/sdk` and
// `@fractonica/protocol` resolve to their TS sources through the private `@fractonica/source` condition (08 §8.12), as
// web/csi's does.

import { defaultClientConditions, defineConfig } from 'vite';

export default defineConfig({
  base: '/apps/power/',
  resolve: { conditions: ['@fractonica/source', ...defaultClientConditions] },
  build: { outDir: 'dist', emptyOutDir: true },
});
