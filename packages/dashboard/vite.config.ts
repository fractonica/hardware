// Dashboard build (spec 08 §8.9, design c6 §5): a static SPA in dist/, served by the hub at `/`.
// Workspace packages resolve to their TS sources through the private `@fractonica/source` condition
// (08 §8.12), so the dashboard needs no prebuilt protocol package.

import { writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig, type Plugin } from 'vite';

// The op registry hash this build was made against (the config runs in Node, which may hash it). The
// page compares it with the hub's (`/ws` hello) and says to rebuild when they differ.
import { REGISTRY_HASH } from '../protocol/src/registry-hash.ts';
// The hash `fr doctor --fix` stamps a dist with, and the hub compares (hub_status.dashboard.stale).
import { SOURCE_HASH_FILE, sourceHash } from '../host/src/web.ts';

const PKG = fileURLToPath(new URL('.', import.meta.url));
const REPO = resolve(PKG, '../..');

const BUILTINS = new Set(builtinModules);
const isBuiltin = (id: string) => id.startsWith('node:') || BUILTINS.has(id.split('/')[0]!);

// The bundle runs in a browser. Vite would swap a Node builtin for an empty stub and the page would fail
// at runtime, so any import of one (say, the protocol root, which hashes the registry with node:crypto at
// load) fails the build instead. A bare name such as `events` passes when an installed package of that
// name resolves it. After bundling, no chunk may still import a builtin (an external that slipped by).
function noNodeBuiltins(): Plugin {
  return {
    name: 'fractonica:no-node-builtins',
    enforce: 'pre',
    async resolveId(id, importer, options) {
      if (!id.startsWith('node:')) {
        if (!BUILTINS.has(id.split('/')[0]!)) {
          return null;
        }
        const r = await this.resolve(id, importer, { ...options, skipSelf: true });
        if (r && !r.external && !r.id.includes('__vite-browser-external')) {
          return r;
        }
      }
      this.error(`${id} (imported by ${importer ?? 'the entry'}) is a Node builtin; the dashboard bundle must stay browser-safe`);
    },
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type === 'chunk') {
          const bad = [...chunk.imports, ...chunk.dynamicImports].filter(isBuiltin);
          if (bad.length) {
            this.error(`${chunk.fileName} imports the Node builtin ${bad.join(', ')}; the dashboard bundle must stay browser-safe`);
          }
        }
      }
    },
  };
}

// dist/.source-hash, as `fr doctor --fix` writes it (@fractonica/host web.ts buildDist): the hash of the
// sources this build is made from, taken when it starts (a source edited meanwhile leaves the dist stale).
// Without it the hub calls any dist stale, so a plain `vite build` (or `--watch`) would keep its banner.
function sourceHashFile(): Plugin {
  let hash: Promise<string> | null = null;
  let outDir = '';
  return {
    name: 'fractonica:source-hash',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    buildStart() {
      hash = sourceHash(REPO, PKG);
      hash.catch(() => {}); // reported where it is awaited
    },
    async writeBundle() {
      if (hash) {
        writeFileSync(join(outDir, SOURCE_HASH_FILE), `${await hash}\n`);
      }
    },
  };
}

export default defineConfig({
  base: '/',
  plugins: [noNodeBuiltins(), react(), tailwindcss(), sourceHashFile()],
  resolve: { conditions: ['@fractonica/source', ...defaultClientConditions] },
  define: { __FR_REGISTRY_HASH__: JSON.stringify(REGISTRY_HASH) },
  // Served from loopback by the hub, so size costs no download time; xterm is a chunk of its own.
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1024 },
});
