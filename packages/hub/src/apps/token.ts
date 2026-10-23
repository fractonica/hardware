// The `/app` token (design c6 D11; spec 07 §7.9, 08 §8.8): `secrets.json.app_token`, 32 random bytes as
// base64url, created on first use (written 0600 to a temp file and renamed, the other secrets kept). It
// opens `/app` only, so it may leave the hub: in the pages the hub serves (`window.__FRACTONICA__`) and in
// client_generate's token.ts, unlike the future `api_token` of `--listen-api`, which never appears in a result.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { paths } from '@fractonica/host';
import { FrError } from '@fractonica/protocol';

import type { HubContext } from '../context.ts';

/** A token shorter than this in secrets.json is replaced (a hand edit, an older format). */
const MIN_LENGTH = 32;

/** What the AppServer adds to its part: the token it checks (tests give it one; the hub's comes from secrets.json). */
export interface AppTokenSource {
  appToken(): string;
}

const tokens = new Map<string, string>();

function readSecrets(file: string): Record<string, unknown> {
  if (!existsSync(file)) {
    return {};
  }
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    // Never pass the parse error on: V8 quotes the input, which would put secret bytes in a result.
    throw new FrError('ENV_MISSING', `${file} is not valid JSON, so the /app token cannot be read`, {
      remediation: [{ human: `fix or delete ${file}, then set the network again (fr net set) and restart the hub` }],
    });
  }
}

/** secrets.json's app_token, created (and written) when absent. Cached per file for the process. */
export function loadAppToken(file = paths.secrets()): string {
  const hit = tokens.get(file);
  if (hit) {
    return hit;
  }
  const secrets = readSecrets(file);
  let token = secrets.app_token;
  if (typeof token !== 'string' || token.length < MIN_LENGTH) {
    token = randomBytes(32).toString('base64url');
    const tmp = `${file}.app-token.tmp`;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(tmp, JSON.stringify({ ...secrets, app_token: token }, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  }
  tokens.set(file, token as string);
  return token as string;
}

/** The token `/app` checks: the AppServer's own, else secrets.json's (S2's page injection may use this too). */
export function appTokenOf(hub: Pick<HubContext, 'appServer'>): string {
  const src = hub.appServer as Partial<AppTokenSource> | undefined;
  return typeof src?.appToken === 'function' ? src.appToken() : loadAppToken();
}

/** Constant-time comparison of a hello's token with the hub's. */
export function tokenMatches(expected: string, got: unknown): boolean {
  if (typeof got !== 'string') {
    return false;
  }
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(got, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
