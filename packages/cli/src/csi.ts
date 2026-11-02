// `fr csi stream <device> [--seconds 10] [--out run.csi] [--source router|peer|any] [--peer <dev|mac>]` (design csi-c1
// D13): the op csi_stream, written here so --out may be relative to the shell's directory (the hub needs it absolute)
// and so a stream longer than the CLI's job wait still ends with its summary: the job starts, a progress line is
// printed on stderr while it runs (records, drops, rate), Ctrl-C cancels it (the board is told to stop and the job
// answers what came), and the result is printed as one summary line. `fr csi status` stays generated.

import { resolve } from 'node:path';

import { type Command, InvalidArgumentError, Option } from 'commander';

import { CSI_SOURCES, CSI_STREAM_MAX_S, type Job, type OpName, REGISTRY_HASH, type Result } from '@fractonica/protocol';

import { hubCall, hubHealth } from './client.ts';
import type { CliKit } from './kit.ts';

/** The ops whose commands are written here: main.ts generates none for them. */
export const CSI_CLI_OPS: readonly OpName[] = ['csi_stream'];

/** `fr csi stream`'s default length. */
const STREAM_SECONDS = 10;

function int(lo: number, hi: number) {
  return (v: string): number => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < lo || n > hi) {
      throw new InvalidArgumentError(`an integer, ${lo}..${hi}`);
    }
    return n;
  };
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

export function addCsiCommands(csi: Command, kit: CliKit): void {
  csi.description("Stream a board's Wi-Fi channel state information (fr.csi) to a .csi file and live to apps, read its motion and RSSI");
  csi
    .command('stream')
    .description(`Stream a board's CSI records (csi_stream) for --seconds (0: until Ctrl-C), to --out (a .csi file under FR_HOME; relative to this directory) and live on /app/stream`)
    .argument('<device>', 'the device: an alias, id:<12hex> or any selector that matches exactly one device')
    .option('--seconds <n>', `seconds to stream, 0..${CSI_STREAM_MAX_S} (0: until Ctrl-C)`, int(0, CSI_STREAM_MAX_S), STREAM_SECONDS)
    .option('--out <file>', '.csi path under FR_HOME (default: no file)')
    .addOption(new Option('--source <source>', "router | peer | any (default: the instance's config)").choices([...CSI_SOURCES]))
    .option('--peer <device>', 'source peer: the transmitter, a device selector or its MAC')
    .option('--instance <name>', "the fr.csi instance (default: the device's only one)")
    .option('--no-live', 'do not publish the blocks on /app/stream')
    .action(async (device: string, opts: { seconds: number; out?: string; source?: string; peer?: string; instance?: string; live: boolean }) => {
      const input: Record<string, unknown> = {
        device,
        seconds: opts.seconds,
        live: opts.live,
        ...(opts.out !== undefined ? { out: resolve(opts.out) } : {}),
        ...(opts.source !== undefined ? { source: opts.source } : {}),
        ...(opts.peer !== undefined ? { peer: opts.peer } : {}),
        ...(opts.instance !== undefined ? { instance: opts.instance } : {}),
        wait_s: 0,
      };
      const health = await hubHealth();
      if (!health) {
        return kit.fail('HUB_UNREACHABLE', 'the hub is not running', 'csi_stream', [{ cli: 'fr hub start' }]);
      }
      if (health.registry_hash !== REGISTRY_HASH) {
        return kit.fail('HUB_VERSION_MISMATCH', `hub registry ${health.registry_hash} != CLI ${REGISTRY_HASH}`, 'csi_stream', [{ cli: 'fr hub restart' }]);
      }
      const started = await hubCall('csi_stream', input, 30_000);
      if (!started.ok) {
        return kit.emit(started, 'csi_stream');
      }
      let job = started.data as Job;
      const tty = process.stderr.isTTY && !kit.json();
      let cancelled = false;
      const onSigint = () => {
        if (cancelled) {
          process.exit(130); // a second Ctrl-C: leave now (the hub still ends the stream)
        }
        cancelled = true;
        void hubCall('job_cancel', { job_id: job.job_id }, 10_000);
      };
      process.on('SIGINT', onSigint);
      let last: Result = started;
      try {
        while (!TERMINAL.has(job.status)) {
          last = await hubCall('job_wait', { job_id: job.job_id, timeout_s: 1 }, 15_000);
          if (!last.ok) {
            return kit.emit(last, 'csi_stream');
          }
          job = last.data as Job;
          const msg = job.progress?.message;
          if (tty && msg && !TERMINAL.has(job.status)) {
            process.stderr.write(`\r\x1b[K${job.job_id} ${job.stage ?? job.status}: ${msg}${cancelled ? ' (stopping)' : ''}`);
          }
        }
      } finally {
        process.off('SIGINT', onSigint);
        if (tty) {
          process.stderr.write('\r\x1b[K');
        }
      }
      return kit.emit(last, 'csi_stream');
    });
}
