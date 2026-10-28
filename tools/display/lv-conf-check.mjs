#!/usr/bin/env node
// LVGL configuration parity (design m2-c5-display D5): the board's LVGL and the Mac's must see the same effective
// LV_* options, or the desktop render stops predicting the board's pixels. fr_ui's lv_conf.h is the one file both
// builds include, but LV_KCONFIG_IGNORE does not keep menuconfig out on IDF 6.1: picolibc's <stdint.h> pulls in
// sdkconfig.h, and lv_conf_internal.h then takes CONFIG_LV_* for every option lv_conf.h leaves unset (it even turns
// LV_KCONFIG_PRESENT on, from CONFIG_LV_STDLIB_BUILTIN). This script preprocesses LVGL's lv_obj.c both ways:
//   - board: the exact compile command of an IDF build (compile_commands.json of an s3t-pad or s3l-pad build dir);
//   - Mac:   Homebrew clang with tools/display's flags (LV_CONF_PATH, LV_KCONFIG_IGNORE, LVGL from build/_deps);
// collects every object-like LV_* macro, expands each one fully, evaluates the integer ones, and prints the options
// whose effective values differ or that the board defines from a CONFIG_LV_* (equal today, but menuconfig's to
// change). Exit 0: the same; 1: differences (each needs an explicit value in lv_conf.h); 2: it could not run.
//   node tools/display/lv-conf-check.mjs [--board-build <idf build dir>]
// Without --board-build it takes the newest build/idf-*/{s3t,s3l}-pad-* directory with a compile_commands.json, and
// LVGL for the Mac from build/_deps (node tools/display-build.mjs fetches it).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const lvConf = join(root, 'firmware', 'components', 'fr_ui', 'config', 'lv_conf.h');
const macLvgl = join(root, 'build', '_deps', 'lvgl-v9.6.0');
const clang = existsSync('/opt/homebrew/opt/llvm/bin/clang') ? '/opt/homebrew/opt/llvm/bin/clang' : 'clang';

/**
 * Expected platform differences, not options of the renderer: the pool's size and place (lv_conf.h: 64-bit pointers
 * on the Mac, PSRAM on the board), the pointer width itself, and how each build names lv_conf.h.
 */
const PLATFORM = new Set(['LV_MEM_SIZE', 'LV_MEM_POOL_INCLUDE', 'LV_MEM_POOL_ALLOC', 'LV_ARCH_64', 'LV_CONF_INCLUDE_SIMPLE']);
/** printf length modifiers of the platform's int32_t and uintptr_t (lv_types.h), not options. */
const PLATFORM_PATTERN = /^LV_PRI[diuxX](32|PTR)$/;

function die(msg) {
  console.error(`lv-conf-check: ${msg}`);
  process.exit(2);
}

function newestBoardBuild() {
  const buildDir = join(root, 'build');
  const found = [];
  for (const d of existsSync(buildDir) ? readdirSync(buildDir) : []) {
    if (!d.startsWith('idf-')) {
      continue;
    }
    for (const p of readdirSync(join(buildDir, d))) {
      const cc = join(buildDir, d, p, 'compile_commands.json');
      if (/^s3[tl]-pad-/.test(p) && existsSync(cc)) {
        found.push({ dir: join(buildDir, d, p), at: statSync(cc).mtimeMs });
      }
    }
  }
  found.sort((a, b) => b.at - a.at);
  return found[0]?.dir;
}

/** Splits a compile command line as a POSIX shell would (quotes and backslashes; no expansions). */
function shellSplit(cmd) {
  const out = [];
  let cur = '';
  let quote = null;
  let any = false;
  for (let i = 0; i < cmd.length; ++i) {
    const ch = cmd[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else cur += ch;
    } else if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === '\\' && i + 1 < cmd.length && '"\\$`'.includes(cmd[i + 1])) cur += cmd[++i];
      else cur += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      any = true;
    } else if (ch === '\\' && i + 1 < cmd.length) {
      cur += cmd[++i];
      any = true;
    } else if (/\s/.test(ch)) {
      if (any || cur) out.push(cur);
      cur = '';
      any = false;
    } else {
      cur += ch;
    }
  }
  if (any || cur) out.push(cur);
  return out;
}

/** The board's command for lv_obj.c, without its -o/-c, as [argv, cwd]. */
function boardCommand(buildDir) {
  const cc = JSON.parse(readFileSync(join(buildDir, 'compile_commands.json'), 'utf8'));
  const e = cc.find((x) => /lvgl__lvgl[\\/]src[\\/]core[\\/]lv_obj\.c$/.test(x.file));
  if (!e) {
    die(`${buildDir}: no LVGL in compile_commands.json (a profile with a ui panel: s3t-pad or s3l-pad)`);
  }
  const args = e.arguments ?? shellSplit(e.command);
  const argv = [];
  for (let i = 0; i < args.length; ++i) {
    if (args[i] === '-o' || args[i] === '-c') {
      ++i;
      continue;
    }
    argv.push(args[i]);
  }
  return [argv, e.directory, e.file];
}

function macCommand() {
  const src = join(macLvgl, 'src', 'core', 'lv_obj.c');
  if (!existsSync(src)) {
    die(`${macLvgl}: LVGL not fetched (run node tools/display-build.mjs first)`);
  }
  // -Werror=macro-redefined: lv_conf.h may not set what lv_conf_internal.h derives itself (fr_ui's sources include
  // lvgl.h under -Werror on both platforms).
  return [[clang, '-std=gnu11', '-Werror=macro-redefined', `-DLV_CONF_PATH="${lvConf}"`, '-DLV_KCONFIG_IGNORE', '-I', macLvgl], root, src];
}

function run(argv, cwd, extra) {
  const r = spawnSync(argv[0], [...argv.slice(1), ...extra], { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) {
    die(`${argv[0]} failed (${r.status}): ${(r.stderr || '').slice(0, 2000)}`);
  }
  return r.stdout;
}

/** Object-like LV_* macros the TU defines (include guards excluded), with their definitions as written. */
function definitions(argv, cwd, src) {
  const out = new Map();
  for (const line of run(argv, cwd, ['-E', '-dM', src]).split('\n')) {
    const m = /^#define (LV_[A-Za-z0-9_]+)(?:\s(.*))?$/.exec(line);
    if (m && !m[1].endsWith('_H')) {
      out.set(m[1], m[2] ?? '');
    }
  }
  return out;
}

/** Each name fully expanded after lv_obj.c's own includes (the source is included, then a probe line per name). */
function expansions(argv, cwd, src, list, scratch, tag) {
  const probe = join(scratch, `probe-${tag}.c`);
  const lines = [`#include "${src}"`, ...list.map((n) => `FRCHK_${n} = ${n} ;FRCHK_END`)];
  writeFileSync(probe, lines.join('\n') + '\n');
  const out = new Map();
  for (const line of run(argv, cwd, ['-E', '-P', probe]).split('\n')) {
    const m = /^\s*FRCHK_(LV_[A-Za-z0-9_]+) = (.*) ;FRCHK_END\s*$/.exec(line);
    if (m) {
      out.set(m[1], m[2].trim());
    }
  }
  return out;
}

/** An integer constant expression's value, or null when the text is anything else (a string, a pointer...). */
function evaluate(text) {
  if (!/^([\s0-9xXa-fA-FuUlL()+\-*/%<>=!&|^~?:]|\btrue\b|\bfalse\b)*$/.test(text) || !/[0-9]|true|false/.test(text)) {
    return null;
  }
  const js = text
    .replace(/\btrue\b/g, '1')
    .replace(/\bfalse\b/g, '0')
    .replace(/\b(0[xX][0-9a-fA-F]+|\d+)[uUlL]+\b/g, '$1')
    .replace(/&&/g, ' && ')
    .replace(/\|\|/g, ' || ');
  try {
    // C's logical and comparison operators give 0 or 1; JS's give booleans: Number() at the end, and the
    // operators coerce booleans back to numbers in between.
    const v = Function(`"use strict"; return Number(${js});`)();
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

function norm(text) {
  return text.replace(/\s+/g, ' ').replace(/\s*##\s*/g, '##').trim();
}

const argBuild = process.argv.indexOf('--board-build');
const buildDir = argBuild >= 0 ? resolve(process.argv[argBuild + 1] ?? '') : newestBoardBuild();
if (!buildDir || !existsSync(join(buildDir, 'compile_commands.json'))) {
  die('no IDF build of s3t-pad or s3l-pad found (build one, or pass --board-build <dir>)');
}
const [bArgv, bCwd, bSrc] = boardCommand(buildDir);
const [mArgv, mCwd, mSrc] = macCommand();
const scratch = mkdtempSync(join(tmpdir(), 'lv-conf-check-'));
try {
  const boardDefs = definitions(bArgv, bCwd, bSrc);
  const macDefs = definitions(mArgv, mCwd, mSrc);
  const all = [...new Set([...boardDefs.keys(), ...macDefs.keys()])].filter((n) => !PLATFORM.has(n) && !PLATFORM_PATTERN.test(n)).sort();
  const board = expansions(bArgv, bCwd, bSrc, all, scratch, 'board');
  const mac = expansions(mArgv, mCwd, mSrc, all, scratch, 'mac');
  const diffs = [];
  for (const n of all) {
    // Taken from menuconfig on the board: wrong even while the value happens to match LVGL's default.
    if (/\bCONFIG_LV_/.test(boardDefs.get(n) ?? '')) {
      diffs.push(`${n}: the board takes ${boardDefs.get(n)} (menuconfig) | mac ${mac.get(n) ?? '(undefined)'}`);
      continue;
    }
    const b = board.get(n);
    const m = mac.get(n);
    // An undefined macro expands to its own name.
    const bv = b === undefined || b === n ? undefined : b;
    const mv = m === undefined || m === n ? undefined : m;
    if (bv === undefined && mv === undefined) {
      continue;
    }
    if (bv !== undefined && mv !== undefined) {
      const be = evaluate(bv);
      const me = evaluate(mv);
      if (be !== null && me !== null ? be === me : norm(bv) === norm(mv)) {
        continue;
      }
    }
    diffs.push(`${n}: board ${bv ?? '(undefined)'} | mac ${mv ?? '(undefined)'}`);
  }
  console.log(`lv-conf-check: ${all.length} LV_* options compared; board build ${buildDir}`);
  if (diffs.length > 0) {
    console.log(`${diffs.length} differ (set each in firmware/components/fr_ui/config/lv_conf.h to LVGL's default, the Mac's value):`);
    for (const d of diffs) {
      console.log(`  ${d}`);
    }
    process.exit(1);
  }
  console.log('the same on the board and the Mac');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
