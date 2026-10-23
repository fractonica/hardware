// M1 demo app (spec 08 §8.10 and 11 §11.5, design c6 §4.4), served by the hub at /apps/demo/.
// `@fractonica/sdk` resolves to its TS sources through the private `@fractonica/source`
// condition (08 §8.12).

import { defaultClientConditions, defineConfig } from 'vite';

export default defineConfig({
  base: '/apps/demo/',
  resolve: { conditions: ['@fractonica/source', ...defaultClientConditions] },
  build: { outDir: 'dist', emptyOutDir: true },
});
