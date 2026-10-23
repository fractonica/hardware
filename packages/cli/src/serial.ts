// `fr serial lease <dev> [--ttl] [-- <cmd…>]` and `fr serial monitor <dev>` (design c6 D4, stream S5).
// With a command, the lease names this process as its holder (holder_pid), runs the command with FR_PORT,
// FR_LEASE and FR_DEVICE, renews the lease every ttl/2, passes SIGTERM and SIGHUP on (and SIGINT when no
// terminal sent it to the whole group), releases on exit and exits with the command's code (128 + signal
// number for a signal). The variables are also replaced in its arguments where they appear literally
// (single-quoted, so the shell left them alone): `fr serial lease pad-c6 -- idf.py -p '$FR_PORT' monitor`.
// Should this process die, the hub's sweeper releases the lease within 2 s (holder_gone). Without a
// command it is a TTL-only lease, for `fr serial renew` and `fr serial release`, which stay generated
// from their ops. `fr serial monitor` is `fr logs <dev> --follow`. Also here: the `--prompt-human`
// notice of `fr wait event` (design c6 D3).

import { spawn } from 'node:child_process';
import { constants } from 'node:os';

import { type Command, InvalidArgumentError } from 'commander';

import { type Lease, type LogLine, type OpName, REGISTRY_HASH, type Result } from '@fractonica/protocol';

import { hubCall, hubHealth } from './client.ts';
import type { CliKit } from './kit.ts';

/** The ops whose commands are written here: main.ts generates none for them. */
export const SERIAL_OPS: readonly OpName[] = ['serial_lease'];

/** Release and renew are quick ops; a hub that does not answer in this long is not coming back for them. */
const CALL_MS = 10_000;
/** `fr serial monitor`: the tail it starts with, and how often it asks for more. */
const MONITOR_TAIL = 50;
const MONITOR_POLL_MS = 300;

function parseTtl(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 1800) {
    throw new InvalidArgumentError('an integer number of seconds, 1..1800');
  }
  return n;
}

/** Exits with HUB_UNREACHABLE or HUB_VERSION_MISMATCH as the generated commands do, unless the hub is fine. */
async function checkHub(kit: CliKit, op: string): Promise<void> {
  const health = await hubHealth();
  if (!health) {
    await kit.fail('HUB_UNREACHABLE', 'the hub is not running', op, [{ cli: 'fr hub start' }]);
  } else if (health.registry_hash !== REGISTRY_HASH) {
    await kit.fail('HUB_VERSION_MISMATCH', `hub registry ${health.registry_hash} != CLI ${REGISTRY_HASH}`, op, [{ cli: 'fr hub restart' }]);
  }
}

/** `$FR_PORT`, `${FR_PORT}` (and FR_LEASE, FR_DEVICE) written literally in an argument, replaced. */
export function substituteVars(args: string[], vars: Record<string, string>): string[] {
  return args.map((a) => a.replace(/\$\{?(FR_PORT|FR_LEASE|FR_DEVICE)\}?/g, (m, name: string) => vars[name] ?? m));
}

/** The exit status of a command that ended with `code` or by `signal`, as a shell reports it. */
export function exitStatus(code: number | null, signal: NodeJS.Signals | null): number {
  if (signal) {
    return 128 + (constants.signals[signal] ?? 0);
  }
  return code ?? 1;
}

async function leaseAndRun(kit: CliKit, input: { device: string; ttl_s?: number }, cmd: string[]): Promise<never> {
  await checkHub(kit, 'serial_lease');
  const r = await hubCall('serial_lease', { ...input, holder_pid: process.pid }, CALL_MS);
  if (!r.ok) {
    return kit.emit(r, 'serial_lease');
  }
  const lease = r.data as Lease;
  const warn = (text: string) => process.stderr.write(`fr: ${text}\n`);
  warn(`${lease.path} leased (${lease.lease_id}) to: ${cmd.join(' ')}; released when it exits`);

  const vars = { FR_PORT: lease.path, FR_LEASE: lease.lease_id, FR_DEVICE: lease.alias ?? lease.device_id ?? input.device };
  const argv = substituteVars(cmd, vars);
  const child = spawn(argv[0], argv.slice(1), { stdio: 'inherit', env: { ...process.env, ...vars } });
  const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolve) => {
    child.on('error', (error) => resolve({ code: 127, signal: null, error }));
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });

  // Renewed at half its ttl, so one lost renewal still leaves time for the next. A lease the hub no longer
  // has (NOT_FOUND: it expired, its port went away, the hub restarted) is not renewed again: the hub takes
  // the port back, and the command may now share it.
  let renewing = false;
  const renew = setInterval(() => {
    if (renewing) {
      return;
    }
    renewing = true;
    void hubCall('serial_lease_renew', { lease_id: lease.lease_id }, CALL_MS)
      .then((rr) => {
        if (rr.ok) {
          return;
        }
        if (rr.error?.code === 'NOT_FOUND') {
          clearInterval(renew);
          warn(`${lease.lease_id} ended (${rr.error.message}): the hub takes ${lease.path} back while ${cmd[0]} still runs`);
        } else {
          warn(`renewing ${lease.lease_id} failed: ${rr.error?.code} ${rr.error?.message ?? ''}`);
        }
      })
      .finally(() => (renewing = false));
  }, lease.ttl_s * 500);

  // A terminal's Ctrl-C reaches the whole foreground group, the command included: only a SIGINT sent to
  // this process alone (no terminal on stdin) is passed on. This process waits for the command either way.
  const forward = (sig: NodeJS.Signals) => () => {
    if (child.exitCode === null && child.signalCode === null && (sig !== 'SIGINT' || !process.stdin.isTTY)) {
      child.kill(sig);
    }
  };
  const handlers = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((sig) => [sig, forward(sig)] as const);
  for (const [sig, fn] of handlers) {
    process.on(sig, fn);
  }

  const end = await ended;
  clearInterval(renew);
  for (const [sig, fn] of handlers) {
    process.off(sig, fn);
  }
  if (end.error) {
    warn(`cannot run ${cmd[0]}: ${end.error.message}`);
  }
  const rel = await hubCall('serial_release', { lease_id: lease.lease_id }, CALL_MS);
  // NOT_FOUND: the lease already ended (expired, port gone); the hub has the port back either way.
  if (!rel.ok && rel.error?.code !== 'NOT_FOUND') {
    warn(`releasing ${lease.lease_id} failed: ${rel.error?.code} ${rel.error?.message ?? ''} (the hub releases it within 2 s of this process exiting)`);
  }
  const status = exitStatus(end.code, end.signal);
  const result: Result = {
    ok: true,
    cursor: r.cursor,
    data: { ...lease, exit_code: status, ...(end.signal ? { signal: end.signal } : {}), released: rel.ok || rel.error?.code === 'NOT_FOUND' },
  };
  return kit.exit(status, kit.json() ? JSON.stringify(result) + '\n' : '');
}

/** `fr serial monitor <dev>`: the device's log tail, then new lines until interrupted (`fr logs <dev> --follow`). */
async function monitor(kit: CliKit, device: string): Promise<never> {
  await checkHub(kit, 'logs_read');
  const print = (res: Result) => {
    const data = res.data as { lines: LogLine[]; next_cursor: string };
    for (const l of data.lines) {
      process.stdout.write(kit.json() ? JSON.stringify(l) + '\n' : `${l.cursor} ${l.device} ${l.text}\n`);
    }
    return data.next_cursor;
  };
  let r = await hubCall('logs_read', { selector: device, max_lines: MONITOR_TAIL }, CALL_MS);
  for (;;) {
    if (!r.ok) {
      return kit.emit(r, 'logs_read');
    }
    const since = print(r);
    await new Promise((res) => setTimeout(res, MONITOR_POLL_MS));
    r = await hubCall('logs_read', { selector: device, since, direction: 'forward' }, CALL_MS);
  }
}

/**
 * `fr wait event … --prompt-human <text>` (design c6 D3) tells the person running it what the hub asks
 * (the dashboard shows it as a toast) before the wait starts; the result carries the prompt_id.
 */
export function addPromptHumanNotice(program: Command): void {
  const wait = program.commands.find((c) => c.name() === 'wait');
  const event = wait?.commands.find((c) => c.name() === 'event');
  event?.hook('preAction', (cmd) => {
    const { promptHuman, timeout } = cmd.opts() as { promptHuman?: string; timeout?: number };
    if (promptHuman) {
      process.stderr.write(`fr: asking a person at the bench: "${promptHuman}" (shown on the dashboard; waiting up to ${timeout ?? 30} s)\n`);
    }
  });
}

export function addSerialCommands(serial: Command, kit: CliKit): void {
  serial
    .command('lease')
    .description(
      "Lend a USB serial port the hub holds to another program: the hub ends the device's serial session and closes the port until the lease ends. With -- <cmd…>, run the command with FR_PORT, FR_LEASE and FR_DEVICE, renew the lease while it runs and release it when it exits (with its exit code)",
    )
    .argument('<device>', 'the device or port: alias, id:<12hex>, MAC, USB serial or /dev path')
    .argument('[cmd...]', 'the command to run while the port is leased (after --)')
    .option('--ttl <s>', 'seconds until the lease ends unless renewed (default 120, max 1800)', parseTtl)
    .action(async (device: string, cmd: string[], opts: { ttl?: number }) => {
      const input = { device, ...(opts.ttl !== undefined ? { ttl_s: opts.ttl } : {}) };
      return cmd.length ? leaseAndRun(kit, input, cmd) : kit.run('serial_lease', input);
    });
  serial
    .command('monitor')
    .description("Follow a device's serial log (fr logs <device> --follow); the hub keeps the port")
    .argument('<device>', 'the device or port')
    .action(async (device: string) => monitor(kit, device));
  // main.ts hands this module the `serial` group; the program it belongs to has `wait event` by now.
  if (serial.parent) {
    addPromptHumanNotice(serial.parent);
  }
}
