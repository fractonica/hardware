// CAM-1's camera app (design camera-c1 D13), served by the hub at /apps/cam/. `@fractonica/sdk` and
// `@fractonica/protocol` resolve to their TS sources through the private `@fractonica/source` condition (08 §8.12), as
// web/csi's does.

import { defaultClientConditions, defineConfig } from 'vite';

export default defineConfig({
  base: '/apps/cam/',
  resolve: { conditions: ['@fractonica/source', ...defaultClientConditions] },
  build: { outDir: 'dist', emptyOutDir: true },
});
