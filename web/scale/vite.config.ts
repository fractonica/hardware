// SCALE-1's scale app (design scale-round-c1 D12), served by the hub at /apps/scale/. `@fractonica/sdk` and
// `@fractonica/protocol` resolve to their TS sources through the private `@fractonica/source` condition (08 §8.12), as
// web/csi's does.

import { defaultClientConditions, defineConfig } from 'vite';

export default defineConfig({
  base: '/apps/scale/',
  resolve: { conditions: ['@fractonica/source', ...defaultClientConditions] },
  build: { outDir: 'dist', emptyOutDir: true },
});
