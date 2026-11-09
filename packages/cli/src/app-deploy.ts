// `fr app deploy [dir]` (design uno-q-services, UNOQ-2): an app folder to a Linux hub (the UNO Q). It reads and checks
// fractonica.app.json here, packs the folder (a gzipped tar without node_modules and .git), sends it in app_upload
// chunks (each request under the hub's 1 MiB body limit) and runs app_deploy, whose job installs and starts it.
// Hand-written because it reads a local folder; app_upload and app_deploy keep their generated commands
// (`fr app upload`, `fr app install`) for scripts and agents.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { Command } from 'commander';

import { APP_BUNDLE_MAX_BYTES, APP_CHUNK_MAX_BYTES, AppManifestSchema, REGISTRY_HASH } from '@fractonica/protocol';

import { hubCall, hubHealth, hubUrl } from './client.ts';
import type { CliKit } from './kit.ts';

const OP = 'app_deploy';

export function addAppDeployCommand(app: Command, kit: CliKit): void {
  app
    .command('deploy')
    .description(
      'Deploy a folder as an app on a Linux hub (the UNO Q): checks its fractonica.app.json, packs it without node_modules and .git, uploads it, then installs and starts it (app_deploy) and waits until it runs. FR_HUB names the hub (make hub-tunnel: http://127.0.0.1:7520).',
    )
    .argument('[dir]', 'the app folder, holding fractonica.app.json', '.')
    .action(async (dirArg: string) => {
      const dir = resolve(dirArg);
      const say = (line: string) => {
        if (!kit.json()) {
          process.stderr.write(`${line}\n`);
        }
      };
      const manifestFile = join(dir, 'fractonica.app.json');
      if (!existsSync(manifestFile)) {
        return kit.fail('INVALID_SOURCE', `${manifestFile} is missing: an app folder needs a fractonica.app.json`, OP);
      }
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(manifestFile, 'utf8'));
      } catch (e) {
        return kit.fail('INVALID_SOURCE', `fractonica.app.json is not JSON: ${e instanceof Error ? e.message : String(e)}`, OP);
      }
      const parsed = AppManifestSchema.safeParse(raw);
      if (!parsed.success) {
        return kit.fail('INVALID_SOURCE', `fractonica.app.json: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'manifest'}: ${i.message}`).join('; ')}`, OP);
      }
      const manifest = parsed.data;

      const health = await hubHealth();
      if (!health) {
        return kit.fail('HUB_UNREACHABLE', `no hub at ${hubUrl()}`, OP, [{ human: 'for the UNO Q: make hub-tunnel, then FR_HUB=http://127.0.0.1:7520' }]);
      }
      if (health.registry_hash !== REGISTRY_HASH) {
        return kit.fail('HUB_VERSION_MISMATCH', `hub registry ${health.registry_hash} != CLI ${REGISTRY_HASH}`, OP, [{ human: 'update the hub (on the UNO Q: make hub-push)' }]);
      }

      // Plain ustar (no pax headers, no macOS metadata, no ._ files: COPYFILE_DISABLE), which BusyBox's tar on the
      // board reads.
      const macOnly = process.platform === 'darwin' ? ['--no-mac-metadata', '--no-xattrs'] : [];
      const tar = spawnSync('tar', ['--format=ustar', ...macOnly, '-czf', '-', '--exclude', './node_modules', '--exclude', './.git', '-C', dir, '.'], {
        env: { ...process.env, COPYFILE_DISABLE: '1' },
        maxBuffer: APP_BUNDLE_MAX_BYTES + 1,
      });
      if (tar.status !== 0 || !tar.stdout) {
        return kit.fail('INVALID_SOURCE', `tar failed: ${tar.stderr?.toString().trim() || tar.error?.message || 'no output'}`, OP);
      }
      const bundle: Buffer = tar.stdout;
      if (bundle.length > APP_BUNDLE_MAX_BYTES) {
        return kit.fail('INVALID_SOURCE', `the packed folder is ${bundle.length} B; the most is ${APP_BUNDLE_MAX_BYTES} (leave build output and data out)`, OP);
      }
      const sha256 = createHash('sha256').update(bundle).digest('hex');
      const uploadId = randomBytes(8).toString('hex');
      say(`${manifest.name}: ${manifest.kind}, ${(bundle.length / 1024).toFixed(1)} KB packed, uploading to ${hubUrl()}`);
      for (let offset = 0; offset < bundle.length; offset += APP_CHUNK_MAX_BYTES) {
        const chunk = bundle.subarray(offset, offset + APP_CHUNK_MAX_BYTES);
        const r = await hubCall(
          'app_upload',
          { name: manifest.name, upload_id: uploadId, offset, total_bytes: bundle.length, data_b64: chunk.toString('base64') },
          60_000,
        );
        if (!r.ok) {
          return kit.emit(r, 'app_upload');
        }
      }
      say('installing and starting it on the hub (npm install, unit, start, check)');
      return kit.run(OP, { name: manifest.name, upload_id: uploadId, sha256 });
    });
}
