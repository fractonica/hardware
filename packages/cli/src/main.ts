#!/usr/bin/env node
// `fr`: the Fractonica CLI. Op commands are generated from the operation registry; `doctor` and
// `hub start|stop|restart` run locally without a hub (spec 09 §9.5).

import { Command, Option } from 'commander';
import { z } from 'zod';

import { findSourceDir, runDoctor } from '@fractonica/host';
import { exitCodeFor, MAX_WAIT_S, OPS, REGISTRY_HASH, type ErrorCode, type OpDef, type Result } from '@fractonica/protocol';

import { hubCall, hubHealth } from './client.ts';
import { startHub, stopHub } from './hub.ts';
import { renderChecks, renderResult } from './render.ts';

const program = new Command('fr')
  .description('Fractonica: build, flash, monitor and drive ESP32 device networks')
  .option('--json', 'print one JSON Result envelope on stdout')
  .showHelpAfterError();

const isJson = () => Boolean(program.opts().json);

function emit(r: Result, op: string): never {
  if (isJson()) {
    process.stdout.write(JSON.stringify(r) + '\n');
  } else {
    const { out, err } = renderResult(op, r);
    if (out) {
      process.stdout.write(out + '\n');
    }
    if (err) {
      process.stderr.write(err + '\n');
    }
  }
  const data = r.data as { status?: string; error?: { code?: ErrorCode } } | undefined;
  if (!r.ok) {
    process.exit(exitCodeFor(r.error?.code));
  }
  if (data?.status === 'failed') {
    process.exit(exitCodeFor(data.error?.code ?? 'INTERNAL'));
  }
  process.exit(data?.status === 'cancelled' ? 1 : 0);
}

function fail(code: ErrorCode, message: string, op: string, remediation?: { cli?: string; human?: string }[]): never {
  emit({ ok: false, cursor: '', error: { code, message, retryable: false, ...(remediation ? { remediation } : {}) } }, op);
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

const flagOf = (key: string) => (key === 'wait_s' ? 'wait' : key.replace(/_/g, '-'));
const attrOf = (flag: string) => flag.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

function group(path: string[]): Command {
  let cmd = program;
  for (const name of path) {
    cmd = cmd.commands.find((c) => c.name() === name) ?? cmd.command(name);
  }
  return cmd;
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
      fail('INVALID_SOURCE', `${process.cwd()} is not inside a Fractonica checkout`, op.name, [{ human: 'cd into the repo or pass --source-dir' }]);
    }
    input.source_dir = src;
  }
  if (op.kind === 'job' && input.wait_s === undefined) {
    input.wait_s = MAX_WAIT_S; // the CLI waits by default; REST/MCP default to 0
  }
  if (input.password === '-') {
    input.password = await readStdin();
  }
  const health = await hubHealth();
  if (!health) {
    fail('HUB_UNREACHABLE', 'the hub is not running', op.name, [{ cli: 'fr hub start' }]);
  }
  if (health.registry_hash !== REGISTRY_HASH && op.name !== 'hub_status') {
    fail('HUB_VERSION_MISMATCH', `hub registry ${health.registry_hash} != CLI ${REGISTRY_HASH}`, op.name, [{ cli: 'fr hub restart' }]);
  }
  const waitS = Number(input.wait_s ?? input.timeout_s ?? 0);
  const r = await hubCall(op.name, input, (waitS + 30) * 1000);
  if (!follow || !r.ok) {
    emit(r, op.name);
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
      emit(next, op.name);
    }
    print(next);
  }
}

function addOp(op: OpDef): void {
  const cmd = group(op.cli.path).description(op.summary);
  const shape = op.input.shape as Record<string, z.ZodType>;
  const positional = op.cli.positional ?? [];
  for (const p of positional) {
    const { optional } = unwrap(shape[p]);
    cmd.argument(optional ? `[${p}]` : `<${p}>`, shape[p].description ?? '');
  }
  for (const [key, field] of Object.entries(shape)) {
    if (positional.includes(key)) {
      continue;
    }
    const { base, optional, def } = unwrap(field);
    const flag = flagOf(key);
    let desc = field.description ?? base.description ?? '';
    if (def !== undefined) {
      desc += `${desc ? ' ' : ''}(default ${JSON.stringify(def)})`;
    }
    if (key === 'wait_s') {
      desc = `seconds to wait for the job (CLI default ${MAX_WAIT_S}, max ${MAX_WAIT_S})`;
    }
    const o =
      base instanceof z.ZodBoolean
        ? new Option(`--${flag}`, desc)
        : new Option(`--${flag} <${base instanceof z.ZodNumber ? 'n' : 'value'}>`, desc);
    if (base instanceof z.ZodNumber) {
      o.argParser((v: string) => Number(v));
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
    positional.forEach((p, i) => {
      if (typeof args[i] === 'string') {
        input[p] = args[i];
      }
    });
    for (const key of Object.keys(shape)) {
      const v = opts[attrOf(flagOf(key))];
      if (!positional.includes(key) && v !== undefined) {
        input[key] = v;
      }
    }
    await invoke(op, input, Boolean(opts.follow));
  });
}

program
  .command('doctor')
  .description('Check the host toolchain (works without a hub); --fix installs the fr shim and the pytools sidecar')
  .option('--fix', 'apply safe fixes')
  .action(async (opts: { fix?: boolean }) => {
    const checks = await runDoctor({ sourceDir: findSourceDir(process.cwd()), fix: Boolean(opts.fix) });
    const ok = !checks.some((c) => c.level === 'error');
    if (isJson()) {
      process.stdout.write(JSON.stringify({ ok, data: { checks }, cursor: '' }) + '\n');
    } else {
      process.stdout.write(renderChecks(checks) + '\n');
    }
    process.exit(ok ? 0 : 1);
  });

const hub = group(['hub']).description('Run and inspect the hub daemon');
hub
  .command('start')
  .description('Start the hub as a detached daemon (or --foreground)')
  .option('--foreground', 'run in this terminal')
  .action(async (opts: { foreground?: boolean }) => {
    const r = await startHub(Boolean(opts.foreground));
    const ok = r.started || Boolean(r.already);
    emit(ok ? { ok, data: r, cursor: '' } : { ok, cursor: '', error: { code: 'HUB_UNREACHABLE', message: `hub did not start; see ${r.log}`, retryable: true } }, 'hub_start');
  });
hub
  .command('stop')
  .description('Stop the hub daemon')
  .action(async () => emit({ ok: true, data: await stopHub(), cursor: '' }, 'hub_stop'));
hub
  .command('restart')
  .description('Restart the hub daemon (picks up new code)')
  .action(async () => {
    await stopHub();
    const r = await startHub(false);
    emit(r.started ? { ok: true, data: r, cursor: '' } : { ok: false, cursor: '', error: { code: 'HUB_UNREACHABLE', message: `hub did not start; see ${r.log}`, retryable: true } }, 'hub_restart');
  });

for (const op of OPS) {
  addOp(op as unknown as OpDef);
}

await program.parseAsync(process.argv);
