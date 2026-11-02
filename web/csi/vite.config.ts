// CSI-1's live app (design csi-c1 D14), served by the hub at /apps/csi/. `@fractonica/sdk` resolves to its TS
// sources through the private `@fractonica/source` condition (08 §8.12), as web/demo's does.

import { defaultClientConditions, defineConfig } from 'vite';

export default defineConfig({
  base: '/apps/csi/',
  resolve: { conditions: ['@fractonica/source', ...defaultClientConditions] },
  build: { outDir: 'dist', emptyOutDir: true },
});
