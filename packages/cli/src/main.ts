#!/usr/bin/env node
// `fr`: the Fractonica CLI. Op commands are generated from the operation registry; `doctor`, `gen`
// and `hub start|stop|restart` run locally without a hub (spec 09 §9.5). `fr mcp`, `fr serial lease|monitor`,
// `fr codegen client` and `fr display window` (design m2-c5-display D6) are hand-written in their own modules
// (design c6 §3.3).

import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import { z } from 'zod';

import { findSourceDir, runDoctor, type HubSelfTests } from '@fractonica/host';
import { cliFlag, findOp, MAX_WAIT_S, OPS, REGISTRY_HASH, type ErrorCode, type OpDef, type Result } from '@fractonica/protocol';

import { callTimeoutMs, hubCall, hubHealth } from './client.ts';
import { addCodegenClientCommand, CODEGEN_CLIENT_OPS } from './codegen-client.ts';
import { addDisplayWindowCommand } from './display.ts';
import { genAll, genFirmware } from './gen.ts';
import { restartHub, startHub, stopHub } from './hub.ts';
import type { CliKit } from './kit.ts';
import { addMcpCommand } from './mcp.ts';
import { cliExitCode, renderChecks, renderResult } from './render.ts';
import { addSerialCommands, SERIAL_OPS } from './serial.ts';

const program = new Command('fr')
  .description('Fractonica: build, flash, monitor and drive ESP32 device networks')
  .option('--json', 'print one JSON Result envelope on stdout')
  .showHelpAfterError()
  // Usage errors throw instead of exiting 1, and the catch at the bottom turns them into an
  // INVALID_ARGS Result (exit 64). Set before any command(): subcommands copy these when created.
  .exitOverride()
  .configureOutput({ outputError: () => {} });

const isJson = () => Boolean(program.opts().json);

// A reader that stops early (`fr logs | head`) closes the pipe; that ends output, not an error.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (e: NodeJS.ErrnoException) => process.exit(e.code === 'EPIPE' ? (process.exitCode ?? 0) : 1));
}

/** Exits once stdout and stderr have drained: process.exit() drops what a pipe has not taken yet (past 64 KB on macOS). */
async function exit(code: number, out = '', err = ''): Promise<never> {
  process.exitCode = code;
  await new Promise((res) => process.stderr.write(err, res));
  await new Promise((res) => process.stdout.write(out, res));
  process.exit(code);
}

async function emit(r: Result, op: string): Promise<never> {
  if (isJson()) {
    return exit(cliExitCode(op, r), JSON.stringify(r) + '\n');
  }
  const { out, err } = renderResult(op, r);
  return exit(cliExitCode(op, r), out && out + '\n', err && err + '\n');
}

function fail(code: ErrorCode, message: string, op: string, remediation?: { cli?: string; human?: string }[]): Promise<never> {
  return emit({ ok: false, cursor: '', error: { code, message, retryable: false, ...(remediation ? { remediation } : {}) } }, op);
}

function unwrap(schema: z.ZodType): { base: z.ZodType; optional: boolean; def: unknown } {
  let s: z.ZodType = schema;
  let optional = false;
  let def: unknown;
  while (s instanceof z.ZodOptional || s instanceof z.ZodDefault) {
    if (s instanceof z.ZodDefault) {
      def = s.def.defaultValue;
    }
    optional = true;
    s = s.unwrap() as z.ZodType;
  }
  return { base: s, optional, def };
}

const attrOf = (flag: string) => flag.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

function group(path: string[]): Command {
  let cmd = program;
  for (const name of path) {
    cmd = cmd.commands.find((c) => c.name() === name) ?? cmd.command(name);
  }
  return cmd;
}

function parseNumber(v: string): number {
  const n = Number(v);
  if (!v.trim() || !Number.isFinite(n)) {
    throw new InvalidArgumentError('not a number');
  }
  return n;
}

async function readStdin(): Promise<string> {
  let s = '';
  for await (const chunk of process.stdin) {
    s += chunk;
  }
  return s.replace(/\r?\n$/, '');
}

async function invoke(op: OpDef, input: Record<string, unknown>, follow: boolean): Promise<never> {
  const shape = op.input.shape as Record<string, z.ZodType>;
  if ('source_dir' in shape && input.source_dir === undefined) {
    const src = findSourceDir(process.cwd());
    if (!src) {
      return fail('INVALID_SOURCE', `${process.cwd()} is not inside a Fractonica checkout`, op.name, [{ human: 'cd into the repo or pass --source-dir' }]);
    }
    input.source_dir = src;
  }
  if (op.kind === 'job' && input.wait_s === undefined) {
    input.wait_s = MAX_WAIT_S; // the CLI waits by default; REST/MCP default to 0
  }
  const health = await hubHealth();
  if (!health) {
    return fail('HUB_UNREACHABLE', 'the hub is not running', op.name, [{ cli: 'fr hub start' }]);
  }
  if (health.registry_hash !== REGISTRY_HASH && op.name !== 'hub_status') {
    return fail('HUB_VERSION_MISMATCH', `hub registry ${health.registry_hash} != CLI ${REGISTRY_HASH}`, op.name, [{ cli: 'fr hub restart' }]);
  }
  const r = await hubCall(op.name, input, callTimeoutMs(op, input));
  if (!follow || !r.ok) {
    return emit(r, op.name);
  }
  // `fr logs --follow`: print, then poll forward from the last cursor until interrupted.
  let since = (r.data as { next_cursor: string }).next_cursor;
  const print = (res: Result) => {
    const lines = (res.data as { lines: { cursor: string; device: string; text: string }[] }).lines;
    for (const l of lines) {
      process.stdout.write(isJson() ? JSON.stringify(l) + '\n' : `${l.cursor} ${l.device} ${l.text}\n`);
    }
    since = (res.data as { next_cursor: string }).next_cursor;
  };
  print(r);
  for (;;) {
    await new Promise((res) => setTimeout(res, 300));
    const next = await hubCall(op.name, { ...input, since, direction: 'forward' }, 10_000);
    if (!next.ok) {
      return emit(next, op.name);
    }
    print(next);
  }
}

function addOp(op: OpDef): void {
  const cmd = group(op.cli.path).description(op.summary);
  const shape = op.input.shape as Record<string, z.ZodType>;
  const positional = op.cli.positional ?? [];
  const isOptional = (p: string) => unwrap(shape[p]).optional;
  // Commander fills positionals left to right, so an optional one before a required one
  // (`wait log [selector] <pattern>`) would take a lone word. Such commands declare every
  // positional optional to commander and place the words in the action instead.
  const optionalFirst = positional.some((p, i) => isOptional(p) && positional.slice(i + 1).some((q) => !isOptional(q)));
  positional.forEach((p, i) => {
    const name = op.cli.variadic && i === positional.length - 1 ? `${p}...` : p;
    cmd.argument(optionalFirst || isOptional(p) ? `[${name}]` : `<${name}>`, shape[p].description ?? '');
  });
  if (optionalFirst) {
    cmd.usage(`[options] ${positional.map((p) => (isOptional(p) ? `[${p}]` : `<${p}>`)).join(' ')}`);
  }
  for (const [key, field] of Object.entries(shape)) {
    if (positional.includes(key)) {
      continue;
    }
    if (key === 'password') {
      // Write-only secret: never accepted on argv, where ps and shell history would keep it.
      cmd.addOption(new Option('--password-stdin', 'read the Wi-Fi password from stdin'));
      continue;
    }
    const { base, optional, def } = unwrap(field);
    const flag = cliFlag(key);
    let desc = field.description ?? base.description ?? '';
    if (def !== undefined) {
      desc += `${desc ? ' ' : ''}(default ${JSON.stringify(def)})`;
    }
    if (key === 'wait_s') {
      desc = `seconds to wait for the job (CLI default ${MAX_WAIT_S}, max ${MAX_WAIT_S})`;
    }
    if (base instanceof z.ZodArray) {
      desc += `${desc ? ' ' : ''}(repeat for more)`;
    }
    const o =
      base instanceof z.ZodBoolean
        ? new Option(`--${flag}`, desc)
        : new Option(`--${flag} <${base instanceof z.ZodNumber ? 'n' : 'value'}>`, desc);
    if (base instanceof z.ZodNumber) {
      o.argParser(parseNumber);
    }
    if (base instanceof z.ZodArray) {
      // A list field (logs_assert --expect A --expect B): each use adds one item, in order.
      o.argParser((v: string, prev: string[] | undefined) => [...(prev ?? []), v]);
    }
    if (base instanceof z.ZodEnum) {
      o.choices(base.options as string[]);
    }
    if (!optional && key !== 'source_dir') {
      o.makeOptionMandatory(true);
    }
    cmd.addOption(o);
  }
  if (op.name === 'logs_read') {
    cmd.option('--follow', 'keep printing new lines until interrupted');
  }
  cmd.action(async (...args: unknown[]) => {
    const opts = cmd.opts() as Record<string, unknown>;
    const input: Record<string, unknown> = {};
    // A variadic positional arrives as an array; its words are joined back into one value.
    const words = positional
      .map((_, i) => (Array.isArray(args[i]) && args[i].length ? args[i].join(' ') : args[i]))
      .filter((a): a is string => typeof a === 'string');
    let slots = positional;
    for (const p of positional) {
      if (slots.length > words.length && isOptional(p)) {
        slots = slots.filter((q) => q !== p);
      }
    }
    slots.forEach((p, i) => {
      if (words[i] !== undefined) {
        input[p] = words[i];
      }
    });
    const missing = positional.find((p) => !isOptional(p) && input[p] === undefined);
    if (missing) {
      return fail('INVALID_ARGS', `missing required argument '${missing}'`, op.name);
    }
    for (const key of Object.keys(shape)) {
      const v = opts[attrOf(cliFlag(key))];
      if (!positional.includes(key) && key !== 'password' && v !== undefined) {
        input[key] = v;
      }
    }
    if (opts.passwordStdin) {
      input.password = await readStdin();
    }
    await invoke(op, input, Boolean(opts.follow));
  });
}

program
  .command('doctor')
  .description('Check the host toolchain (works without a hub); --fix installs the fr shim and the pytools sidecar')
  .option('--fix', 'apply safe fixes')
  .action(async (opts: { fix?: boolean }) => {
    // The running hub's own LNP self-test and advert (08 §8.11): read from hub_status, never probed here,
    // since macOS attributes Local Network access to the app that launched the probing process.
    const hubSelfTests = async () => {
      const r = await hubCall('hub_status', {}, 3000);
      return r.ok ? ((r.data ?? null) as HubSelfTests | null) : null;
    };
    const checks = await runDoctor({ sourceDir: findSourceDir(process.cwd()), fix: Boolean(opts.fix), hub: hubSelfTests });
    const ok = !checks.some((c) => c.level === 'error');
    await exit(ok ? 0 : 1, (isJson() ? JSON.stringify({ ok, data: { checks }, cursor: '' }) : renderChecks(checks)) + '\n');
  });

const gen = program
  .command('gen')
  .description('Regenerate the committed codec, catalog and golden-vector outputs from schema/ (works without a hub)')
  .option('--check', 'only compare; list stale files and exit 1 if any')
  .action(async (opts: { check?: boolean }) => emit(await genAll({ check: Boolean(opts.check), cwd: process.cwd() }), 'gen'));
gen
  .command('firmware')
  .description("Generate a profile's firmware composition (fr_board, components.cmake, sdkconfig.board, fr_manifest.json; sdkconfig.fault with --fault)")
  .requiredOption('--profile <name>', 'profile name, e.g. c6-pad')
  .option('--out <dir>', 'output directory (default: firmware/apps/<app>/build/<profile>-debug/fr_gen, as fr build uses)')
  .addOption(new Option('--fault <kind>', 'a fault build: also write the sdkconfig.fault layer (default out dir <profile>-debug-fault)').choices(['health']))
  .action(async (opts: { profile: string; out?: string; fault?: 'health' }) =>
    emit(await genFirmware({ profile: opts.profile, out: opts.out, fault: opts.fault, cwd: process.cwd() }), 'gen_firmware'),
  );

const hub = group(['hub']).description('Run and inspect the hub daemon');
hub
  .command('start')
  .description('Start the hub as a detached daemon (or --foreground)')
  .option('--foreground', 'run in this terminal')
  .action(async (opts: { foreground?: boolean }) => {
    const r = await startHub(Boolean(opts.foreground));
    const ok = r.started || Boolean(r.already);
    await emit(ok ? { ok, data: r, cursor: '' } : { ok, cursor: '', error: { code: 'HUB_UNREACHABLE', message: `hub did not start; see ${r.log}`, retryable: true } }, 'hub_start');
  });
// Both refuse with LOCKED (exit 5) while jobs are queued or working, unless --force.
hub
  .command('stop')
  .description('Stop the hub daemon (refuses while jobs are queued or working)')
  .option('--force', 'stop even if that aborts queued or working jobs')
  .action(async (opts: { force?: boolean }) => emit(await stopHub(Boolean(opts.force)), 'hub_stop'));
hub
  .command('restart')
  .description('Restart the hub daemon (picks up new code; refuses while jobs are queued or working)')
  .option('--force', 'restart even if that aborts queued or working jobs')
  .action(async (opts: { force?: boolean }) => emit(await restartHub(Boolean(opts.force)), 'hub_restart'));

// Ops whose commands are hand-written (design c6 §3.3) get none generated.
const handWritten = new Set<string>([...SERIAL_OPS, ...CODEGEN_CLIENT_OPS]);
for (const op of OPS) {
  if (!handWritten.has(op.name)) {
    addOp(op as unknown as OpDef);
  }
}

const kit: CliKit = {
  json: isJson,
  run: (name, input) => invoke(findOp(name)!, input, false),
  emit,
  fail,
  exit,
};
addSerialCommands(group(['serial']), kit);
addCodegenClientCommand(group(['codegen']), kit);
addDisplayWindowCommand(group(['display']), kit);
addMcpCommand(program, kit);

try {
  await program.parseAsync(process.argv);
} catch (e) {
  if (!(e instanceof CommanderError)) {
    await fail('INTERNAL', e instanceof Error ? e.message : String(e), 'cli');
  } else if (e.exitCode === 0 && ['commander.helpDisplayed', 'commander.help', 'commander.version'].includes(e.code)) {
    await exit(0);
  } else {
    // A group run without a subcommand prints its help and lands here too (code commander.help, exit 1).
    await fail('INVALID_ARGS', e.code === 'commander.help' ? 'missing subcommand' : e.message.replace(/^error: /, ''), 'cli');
  }
}
