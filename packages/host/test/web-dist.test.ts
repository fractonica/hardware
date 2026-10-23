// The web bundles the hub serves (design c6 D10): the source hash over a package and the workspace packages it
// bundles, dist staleness, `vite build` with dist/.source-hash (a fake vite), `fr doctor --fix` building what
// is missing or stale, the hub self-test checks fr doctor reports, and the checkout inventory readers.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { hubChecks } from '../src/doctor.ts';
import { readBoards, readProfiles } from '../src/inventory.ts';
import { buildDist, bundledPackages, distStatus, SOURCE_HASH_FILE, sourceHash, webChecks, webPackages } from '../src/web.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

function put(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** A checkout: protocol and sdk libraries, the dashboard (bundles protocol), web/demo (bundles sdk). */
function checkout(): string {
  const src = realpathSync(mkdtempSync(join(tmpdir(), 'fr-web-')));
  dirs.push(src);
  put(join(src, 'packages/protocol/package.json'), JSON.stringify({ name: '@fractonica/protocol', dependencies: { zod: '4.6.7' } }));
  put(join(src, 'packages/protocol/src/index.ts'), 'export const A = 1;\n');
  put(join(src, 'packages/protocol/test/x.test.ts'), 'test\n');
  put(join(src, 'packages/sdk/package.json'), JSON.stringify({ name: '@fractonica/sdk' }));
  put(join(src, 'packages/sdk/src/index.ts'), 'export const S = 1;\n');
  put(join(src, 'packages/dashboard/package.json'), JSON.stringify({ name: '@fractonica/dashboard', dependencies: { '@fractonica/protocol': 'workspace:*', react: '19.3.0' } }));
  put(join(src, 'packages/dashboard/index.html'), '<!doctype html>\n');
  put(join(src, 'packages/dashboard/vite.config.ts'), 'export default {};\n');
  put(join(src, 'packages/dashboard/src/main.tsx'), 'export {};\n');
  put(join(src, 'packages/dashboard/src/pages/devices.tsx'), 'export {};\n');
  put(join(src, 'web/demo/package.json'), JSON.stringify({ name: '@fractonica/web-demo', dependencies: { '@fractonica/sdk': 'workspace:*' } }));
  put(join(src, 'web/demo/src/main.ts'), 'export {};\n');
  mkdirSync(join(src, 'web/empty'), { recursive: true }); // no package.json: not an app
  return src;
}

/** A vite that "builds" dist/index.html (or fails with exit 1). */
function fakeVite(pkgDir: string, fail = false): void {
  put(
    join(pkgDir, 'node_modules/vite/bin/vite.js'),
    fail
      ? "console.error('[vite] error during build: boom'); process.exit(1);\n"
      : "const fs = require('node:fs'); fs.mkdirSync('dist', { recursive: true }); fs.writeFileSync('dist/index.html', '<!doctype html>built'); console.log('built in 1ms', process.argv.slice(2).join(' '));\n",
  );
}

describe('web packages and their source hash', () => {
  it('finds the dashboard and web/<name> apps, and what each bundles', () => {
    const src = checkout();
    expect(webPackages(src).map((p) => [p.name, p.kind])).toEqual([
      ['dashboard', 'dashboard'],
      ['demo', 'app'],
    ]);
    expect(bundledPackages(src, join(src, 'packages/dashboard'))).toEqual([join(src, 'packages/dashboard'), join(src, 'packages/protocol')]);
    expect(bundledPackages(src, join(src, 'web/demo'))).toEqual([join(src, 'web/demo'), join(src, 'packages/sdk')]);
  });

  it('changes with the sources and the bundled packages, not with tests, dist or node_modules', async () => {
    const src = checkout();
    const dash = join(src, 'packages/dashboard');
    const h0 = await sourceHash(src, dash);
    expect(h0).toMatch(/^[0-9a-f]{64}$/);
    put(join(src, 'packages/protocol/test/x.test.ts'), 'changed\n');
    put(join(dash, 'dist/index.html'), 'built\n');
    put(join(dash, 'node_modules/react/index.js'), 'x\n');
    put(join(src, 'packages/sdk/src/index.ts'), 'export const S = 2;\n'); // not bundled by the dashboard
    expect(await sourceHash(src, dash)).toBe(h0);
    put(join(src, 'packages/protocol/src/index.ts'), 'export const A = 2;\n');
    const h1 = await sourceHash(src, dash);
    expect(h1).not.toBe(h0);
    put(join(dash, 'src/pages/new.tsx'), 'export {};\n');
    expect(await sourceHash(src, dash)).not.toBe(h1);
  });

  it('says built, and stale unless dist/.source-hash is the current hash', async () => {
    const src = checkout();
    const dash = join(src, 'packages/dashboard');
    expect(await distStatus(src, dash)).toMatchObject({ built: false, stale: false, built_hash: null });
    put(join(dash, 'dist/index.html'), 'built by hand\n');
    expect(await distStatus(src, dash)).toMatchObject({ built: true, stale: true, built_hash: null });
    put(join(dash, 'dist', SOURCE_HASH_FILE), `${await sourceHash(src, dash)}\n`);
    expect(await distStatus(src, dash)).toMatchObject({ built: true, stale: false });
    put(join(dash, 'src/main.tsx'), 'export const changed = 1;\n');
    expect(await distStatus(src, dash)).toMatchObject({ built: true, stale: true });
  });
});

describe('vite build and fr doctor --fix', () => {
  it('builds with the package vite under this Node and records the source hash', async () => {
    const src = checkout();
    const dash = join(src, 'packages/dashboard');
    expect(await buildDist(src, dash)).toMatchObject({ ok: false, output: expect.stringContaining('pnpm install') });
    fakeVite(dash);
    const r = await buildDist(src, dash);
    expect(r).toMatchObject({ ok: true, output: expect.stringContaining('built in 1ms build') });
    expect(readFileSync(join(dash, 'dist', SOURCE_HASH_FILE), 'utf8')).toBe(`${await sourceHash(src, dash)}\n`);
    expect(await distStatus(src, dash)).toMatchObject({ built: true, stale: false });
    fakeVite(dash, true);
    rmSync(join(dash, 'dist'), { recursive: true });
    expect(await buildDist(src, dash)).toMatchObject({ ok: false, output: expect.stringContaining('boom') });
    expect(existsSync(join(dash, 'dist', SOURCE_HASH_FILE))).toBe(false);
  });

  it('checks every web package, and with --fix builds the missing and the stale ones', async () => {
    const src = checkout();
    put(join(src, 'web/demo/dist/index.html'), 'old\n');
    expect(await webChecks(src, { fix: false })).toEqual([
      { id: 'dashboard', level: 'warn', detail: 'packages/dashboard/dist missing (the hub serves a "not built" page)', fix: 'fr doctor --fix' },
      { id: 'web_demo', level: 'warn', detail: 'web/demo/dist is older than its sources', fix: 'fr doctor --fix' },
    ]);
    const built: string[] = [];
    const fixed = await webChecks(src, {
      fix: true,
      build: async (s, dir) => {
        built.push(dir);
        if (dir.endsWith('demo')) {
          return { ok: false, output: 'line 1\n[vite] error: cannot resolve x\n' };
        }
        put(join(dir, 'dist/index.html'), 'new\n');
        put(join(dir, 'dist', SOURCE_HASH_FILE), `${await sourceHash(s, dir)}\n`);
        return { ok: true, output: '' };
      },
    });
    expect(built).toEqual([join(src, 'packages/dashboard'), join(src, 'web/demo')]);
    expect(fixed).toEqual([
      { id: 'dashboard', level: 'ok', detail: 'built packages/dashboard/dist', fixed: true },
      { id: 'web_demo', level: 'error', detail: 'vite build in web/demo failed: line 1 | [vite] error: cannot resolve x' },
    ]);
    expect(await webChecks(src, { fix: true, build: async () => ({ ok: false, output: 'never called for a fresh dist' }) })).toContainEqual({
      id: 'dashboard',
      level: 'ok',
      detail: 'packages/dashboard/dist built from the current sources',
    });
  });
});

describe("the hub's self-tests as fr doctor reports them", () => {
  it('turn hub_status lnp, launched_by and advert into checks', () => {
    expect(hubChecks({ lnp: 'allowed', launched_by: 'Apple_Terminal', advert: { state: 'registered', name: 'Fractonica mac' } })).toEqual([
      { id: 'lnp', level: 'ok', detail: 'the hub has Local Network access (launched by Apple_Terminal)' },
      { id: 'advert', level: 'ok', detail: '_fractonica._tcp advertised as "Fractonica mac"' },
    ]);
    const denied = hubChecks({ lnp: 'denied', launched_by: 'com.anthropic.claudefordesktop', advert: { state: 'retrying', name: 'x', error: 'dns-sd exited with code 1' } });
    expect(denied.map((c) => [c.id, c.level])).toEqual([
      ['lnp', 'error'],
      ['advert', 'warn'],
    ]);
    expect(denied[0].fix).toContain('allow com.anthropic.claudefordesktop');
    expect(denied[1].detail).toContain('dns-sd exited with code 1');
    expect(hubChecks({ lnp: 'unknown', lnp_checked_at: null, advert: { state: 'off' } })).toEqual([
      { id: 'lnp', level: 'warn', detail: "the hub's Local Network self-test has not run yet" },
      { id: 'advert', level: 'ok', detail: '_fractonica._tcp advert off (a test hub, or --no-advert)' },
    ]);
  });
});

describe('the checkout inventory', () => {
  it('reads boards and profiles loosely, listing the files that do not parse', () => {
    const src = realpathSync(mkdtempSync(join(tmpdir(), 'fr-inv-')));
    dirs.push(src);
    put(join(src, 'hardware/boards/b1.board.yaml'), 'id: b1\nname: B One\nidf_target: esp32s3\nflash: { size: 8MB }\nbuttons: { boot: {}, a: {} }\nleds: { status: {} }\ntest_pin: 4\n');
    put(join(src, 'hardware/boards/list.board.yaml'), '- not a mapping\n');
    put(join(src, 'hardware/boards/readme.md'), '# not a board\n');
    put(join(src, 'firmware/profiles/p1.profile.yaml'), 'profile: p1\nboard: b1\napp: node\ncaps:\n  boot: { cap: fr.button, driver: button_gpio, bind: buttons.boot }\n  odd: 3\n');
    expect(readBoards(src)).toEqual({
      boards: [{ board: 'b1', name: 'B One', chip: 'esp32s3', flash: '8MB', buttons: ['boot', 'a'], leds: ['status'], test_pin: 4 }],
      errors: [{ file: 'hardware/boards/list.board.yaml', message: 'not a YAML mapping' }],
    });
    expect(readProfiles(src).profiles).toEqual([{ profile: 'p1', board: 'b1', chip: 'esp32s3', app: 'node', instances: { boot: { cap: 'fr.button', driver: 'button_gpio' } } }]);
    expect(readBoards(join(src, 'nowhere'))).toEqual({ boards: [], errors: [] });
  });
});
