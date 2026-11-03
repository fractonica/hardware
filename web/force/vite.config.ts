// web/force (design scale-round-c1 §9: the load cell as a sound instrument), served by the hub at /apps/force/.
// `@fractonica/sdk` and `@fractonica/protocol` resolve to their TS sources through the private `@fractonica/source`
// condition (08 §8.12), as web/scale's do. The synth's AudioWorklet (src/worklet.ts) is bundled as its own file
// through `?worker&url` (an ES module: audioWorklet.addModule loads it as one).

import { defaultClientConditions, defineConfig } from 'vite';

export default defineConfig({
  base: '/apps/force/',
  resolve: { conditions: ['@fractonica/source', ...defaultClientConditions] },
  worker: { format: 'es' },
  build: { outDir: 'dist', emptyOutDir: true },
});
