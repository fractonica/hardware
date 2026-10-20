import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { FrError } from '@fractonica/protocol';

export interface IdfLock {
  schema: string;
  idf: { tag: string; commit: string; install_hint: string };
  targets: string[];
}

const LOCK_REL = join('firmware', 'idf-version.lock');

/** Walks up from `start` to the checkout that contains firmware/idf-version.lock. */
export function findSourceDir(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, LOCK_REL))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/** Validates an explicit source_dir (spec 09 §9.2: absolute and containing the IDF lock). */
export function checkSourceDir(sourceDir: string): string {
  if (!isAbsolute(sourceDir) || !existsSync(join(sourceDir, LOCK_REL))) {
    throw new FrError('INVALID_SOURCE', `${sourceDir} is not a Fractonica checkout (no ${LOCK_REL})`, {
      hint: 'pass the absolute path of your checkout; the fr CLI fills it from its working directory',
    });
  }
  return sourceDir;
}

export function readIdfLock(sourceDir: string): IdfLock {
  return JSON.parse(readFileSync(join(sourceDir, LOCK_REL), 'utf8')) as IdfLock;
}
