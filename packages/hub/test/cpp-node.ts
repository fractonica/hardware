// The C++ fr_net_node for interop tests (design c3 §5, c4 §5, c5 §5): build/host-tests/fr_net_node runs the real
// fr_net core, services and (C4) the real fr_ota core on POSIX links, and (C5) ESP-NOW on a fake air medium. CppNode is one process; CppBoard is
// one board across boots: with --ota-dir an exited process (an OTA restart, a rollback, a crash) is power
// cycled into the next boot, which reads what the last one left in its flash and nvs. C6 (design c6 §6 S6) adds
// fr.diag on port 241, the `net loss` hook and the T-LAT wire between two nodes (--pin-target, --pin-listen).
// M2-C1 (design m2-c1-hil §4 S2) adds the serial-only node, the pads' taps and the virtual fixture.
// `pnpm test:host` builds the binary (run it again after changing C++); without it the suites are skipped.
// FR_NET_NODE_BIN runs another build of it (a stream's own FR_HOST_BUILD_DIR) instead.

import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process';
import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { until } from './fake-node.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const BIN = process.env.FR_NET_NODE_BIN ? resolve(process.env.FR_NET_NODE_BIN) : resolve(REPO, 'build', 'host-tests', 'fr_net_node');

export type Line = { ev: string; [k: string]: unknown };

/** An ESP_LOG line on the USB line (KitLogs with --serial; logstore.ts ESP_LOG_RE's head). */
const ESP_LOG_LINE = /^[EWIDV] \(\d+\) /;

/**
 * One fr_net_node process: its JSON lines, and stdin commands (state, udp_block <s>, drop_hub_link <s>, ip_block <s>,
 * tcp 0|1, usb 0|1, bye, crash, quit). With --air-dir <dir> (design c5 §5) it joins a fake ESP-NOW medium shared by
 * every node registered there (--air-loss <pct>, --air-seed <n>, --air-rssi <dBm>, --air-channel <n>,
 * --air-ack-ms <n>), and takes the C5 commands `wifi_down <s>` (TCP and UDP down, ESP-NOW and serial stay; 0 ends
 * it), `air_loss <pct>`, `inject <gesture>` (the boot button: click, double_click, long_press, press, release),
 * `msg <addr|0|broadcast> <topic> [data]`, `msg_reliable <addr|0> <topic> [data]`, `bind <hex>` (an encoded
 * Binding), `unbind <slot|all>`, `bindings`, `neighbors` and `directory`. Its lines then add `air`, `msg` (src, topic,
 * data or data_hex, len), `msg_sent`, `bind_set`, `bind_clear`, `bind`, `unbind`, `bindings`, `neighbors`,
 * `directory` (items {addr, mac} by addr), `wifi` and `inject`, and `state` the C5 counters (air_*, relay_*,
 * bcast_*, bind_*, `nodes` by path, `medium`, `msgs`).
 * Every node of one medium needs the hub's --net, its own --mac and its own --addr.
 *
 * C6 (design c6 §6 S6): fr.diag on port 241 answers diag_exec over the hub link (`pin_pulse <us>`, `net loss <pct>
 * <s> [both|tx|rx]`, `net drop_hub_link|udp_block|ip_block <s>`, `stats`, `info`), and a CMD with exec_at runs at its
 * time. Stdin `loss <pct> <s> [both|tx|rx]` starts Net's loss hook at once (line `loss` {ok, pct, s, dir}, which a
 * diag `net loss` prints too).
 * `--pin-target <udp port>` is the board's test pin: `pin_pulse` sends one datagram there (line `pin_pulse` {us,
 * at_us}). `--pin-listen <udp port>` (0: any free one, given by the `pin_listen` {port} line, pinListenPort()) is
 * the boot button wired to another node's test pin: a datagram presses it and releases it after the pulse, through
 * the real debounce (line `pin_in` {us, at_us}; boot.down, boot.up and boot.click follow). `state` adds loss_pct,
 * loss_dir, loss_tx, loss_rx, cmds_refused, cmds_scheduled, exec_late, exec_cancelled, exec_late_us_max and
 * rx_queue_us_max.
 *
 * M2-C1 (design m2-c1-hil §4 S2):
 * - Serial only: `--serial 1` without --hub-tcp/--hub-udp is a radio-off node (the HIL fixture's build): no TCP or
 *   UDP link, HELLO without `wifi`, the serial session's WELCOME sets NET (`state` health bit 4). Its USB line goes
 *   to an in-process router with serialToRouter(), or to a real hub process through virtual-usb.ts (I1). `state`
 *   adds `health` (fr_ota's bits) and `hub_session`. Stdin `#<id> <line>` is fr_diag's serial command channel
 *   (the hub's diag_exec on a port it holds open): the answer `#<id> {json}` goes out on the USB line (onSerial).
 *
 * M2-C2 (design m2-c2 D2, D20): the node classes live in the fleet kit (firmware/test/host/sim). `--net-log 1`
 * attaches the kit's log source: HELLO caps net_log, fr_core's `ready id=…` banner at boot and `alive fw=…` every
 * 10 s, fr_ota's `slot … open` line, and stdin `log <E|W|I|D|V> <tag> <text>` (one line; `log_rate <lines/s>` a
 * generator), drained as LOG frames over TCP. With --serial each such line also goes out on the USB line as
 * fr_serial prints it (`I (1234) tag: text`, to onSerial); without --net-log a `log` line goes to the USB line only.
 * diag `info` answers in fr_diag's shape (uptime_ms, epoch, links, hub, wifi).
 * - `--role node|gateway|fixture` (or 0-2), `--board <b>`, `--profile <p>`, `--chip <n>`: what HELLO, the descriptor and the
 *   OTA CHECK say (default esp32c6-supermini, c6-pad, 13). The board picks the test pin pin_pulse and `info` report
 *   (esp32c3-oled042 10, esp32c6-supermini 20, waveshare-esp32s3-lcd19 16, esp32s3-devkitc1-n16r8 none: -1).
 * - The wires are text datagrams on loopback: `level 0|1`, `<us>` (a pulse: low now, released `us` later),
 *   `frame <grb> <bits>` (a WS2812 refresh). WireTap receives them in a test. A node stamps a datagram it takes
 *   (pin_in, a fixture line's capture) at its arrival, the kernel's SO_TIMESTAMP, as a GPIO ISR stamps the pin's
 *   edge: a process poll() wakes late on a loaded host stamps no later for it.
 * - Pads: `--led-kind mono|gpio_low|ws2812` is what drives the status LED's pin (mono active high, the default;
 *   gpio_low the C3 pads' led_gpio; ws2812 the C6/S3 pads', RGB and dimmable, max_brightness 64), and
 *   `--led-tap <port>` gets every LedService write as that pin carries it: a `level` (sent again every 250 ms)
 *   or a `frame` (the `led` line then adds `grb`); line `led_sent` {at_us} says when each write's datagram went
 *   (the pin's change on the pad's clock), printed after its STATE was stamped. `--test-pin-tap <port>` gets each
 *   pin_pulse as `<us>`, beside
 *   --pin-target. `--pin-listen` also takes `level 0|1`, a fixture's open-drain line holding the boot button down
 *   (line `pin_in` {level, at_us}; wired-AND with a pulse).
 * - `--fixture 1`: the virtual fixture (role fixture, board esp32s3-devkitc1-n16r8, profile s3k-fixture, chip 9):
 *   status (fr.led) on port 1 and fr.fixture ch0-ch11 on 2-13 (ch0-ch3 open-drain BOOT lines, ch4-ch5 LED level
 *   taps, ch6-ch7 WS2812 taps, ch8-ch11 test_pin taps), each FixtureService on a fake line, no boot button.
 *   `--line <ch>=<port>` wires a channel: a driving line sends its wire's `level` to a pad's --pin-listen port, an
 *   input line listens on it (0: any free one) for a pad's taps. Lines `line` {name, port, drive, decode, pull}
 *   (linePort()); stdin `line <ch> <port>` rewires a driving line (line `line` {name, port, ok}), `lines` prints
 *   `lines` {items: [{name, level, pressing, port}]}.
 */
export class CppNode {
  readonly lines: Line[] = [];
  readonly proc: ChildProcessWithoutNullStreams;
  exited: number | null = null;
  /** With --serial: the node's `@fr1:` lines, serial command-channel answers and ESP_LOG lines, as its USB port would print them. */
  onSerial: (line: string) => void = () => undefined;
  #buf = '';
  #onExit: Array<(code: number) => void> = [];

  constructor(args: string[]) {
    this.proc = spawn(BIN, args, { env: { ...process.env, ASAN_OPTIONS: 'detect_leaks=0:abort_on_error=1' } });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk: string) => {
      this.#buf += chunk;
      let nl: number;
      while ((nl = this.#buf.indexOf('\n')) >= 0) {
        const text = this.#buf.slice(0, nl);
        this.#buf = this.#buf.slice(nl + 1);
        // The USB line's own output: `@fr1:` envelopes, the serial command channel's `#<id> {json}` answers, and
        // (M2-C2) the node's ESP_LOG lines, `<L> (<ms>) <tag>: <text>`, as fr_serial prints them.
        if (text.startsWith('@fr1:') || /^#\d{1,8} [{]/.test(text) || ESP_LOG_LINE.test(text)) {
          this.onSerial(text);
          continue;
        }
        try {
          this.lines.push(JSON.parse(text) as Line);
        } catch {
          this.lines.push({ ev: 'text', text });
        }
      }
    });
    this.proc.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk));
    this.proc.stdin.on('error', () => undefined); // a line written after the node exited
    // 'close', not 'exit': stdout is drained by then, so every line the process printed is in `lines`.
    this.proc.on('close', (code) => {
      this.exited = code ?? -1;
      for (const fn of this.#onExit.splice(0)) {
        fn(this.exited);
      }
    });
  }

  send(cmd: string): void {
    this.proc.stdin.write(`${cmd}\n`);
  }

  of(ev: string): Line[] {
    return this.lines.filter((l) => l.ev === ev);
  }

  /** Dispatches of `port/cmd` the node ran. */
  ran(port: number, cmd: number): number {
    return this.of('dispatch').filter((l) => l.port === port && l.cmd === cmd).length;
  }

  async state(): Promise<Line> {
    const n = this.of('state').length;
    this.send('state');
    await until(() => this.of('state').length > n, 2000, 'a state line');
    return this.of('state').at(-1)!;
  }

  /** With --pin-listen: the UDP port its boot input listens on (the one the OS gave for `--pin-listen 0`). */
  async pinListenPort(timeoutMs = 5000): Promise<number> {
    await until(() => this.of('pin_listen').length > 0, timeoutMs, 'the pin_listen line');
    return Number(this.of('pin_listen')[0].port);
  }

  /** With --fixture: the UDP port of channel `name` (`--line <name>=0` gets a free one), from its `line` line. */
  async linePort(name: string, timeoutMs = 5000): Promise<number> {
    await until(() => this.of('line').some((l) => l.name === name && l.drive !== undefined), timeoutMs, `the ${name} line`);
    return Number(this.of('line').find((l) => l.name === name && l.drive !== undefined)!.port);
  }

  /** Calls `fn` once the process has exited (at once if it has). */
  onExit(fn: (code: number) => void): void {
    if (this.exited !== null) {
      fn(this.exited);
    } else {
      this.#onExit.push(fn);
    }
  }

  stop(): void {
    if (this.exited === null) {
      this.proc.kill('SIGKILL');
    }
  }
}

/**
 * One board across boots: the same args (so the same --ota-dir: flash, otadata, nvs:fr_ota, boot epoch) for
 * every process. While powered, a process that exits (OTA restart, rollback reboot, `crash`) is followed by
 * the next boot after `bootMs`; `power(false)` holds it off, as a board that lost power.
 */
export class CppBoard {
  readonly boots: CppNode[] = [];
  readonly args: string[];
  #powered = true;
  #stopped = false;
  #bootMs: number;

  constructor(args: string[], opts: { bootMs?: number } = {}) {
    this.args = args;
    this.#bootMs = opts.bootMs ?? 50;
    this.#boot();
  }

  /** The current (or last) boot's process. */
  get node(): CppNode {
    return this.boots.at(-1)!;
  }

  /** Lines of every boot, in order. */
  lines(ev?: string): Line[] {
    const all = this.boots.flatMap((b) => b.lines);
    return ev ? all.filter((l) => l.ev === ev) : all;
  }

  /** Power on (boots now if no process runs) or off (no next boot once the current process ends). */
  power(on: boolean): void {
    this.#powered = on;
    if (on && this.node.exited !== null && !this.#stopped) {
      this.#boot();
    }
  }

  /** Waits until boot number `n` (1 = the first) has started. */
  async booted(n: number, timeoutMs = 10_000): Promise<CppNode> {
    await until(() => this.boots.length >= n && this.boots[n - 1].of('started').length > 0, timeoutMs, `boot ${n}`);
    return this.boots[n - 1];
  }

  stop(): void {
    this.#stopped = true;
    for (const b of this.boots) {
      b.stop();
    }
  }

  #boot(): void {
    const node = new CppNode(this.args);
    this.boots.push(node);
    node.onExit(() => {
      if (this.#stopped || !this.#powered) {
        return;
      }
      setTimeout(() => {
        if (!this.#stopped && this.#powered && this.node === node) {
          this.#boot();
        }
      }, this.#bootMs);
    });
  }
}

/**
 * The USB line of a `--serial 1` node to an in-process router (fake-node.ts rig): its `@fr1:` lines reach the
 * router as the log store's frame tap hands them over, and the hub's writeLine to `mac` goes to its stdin.
 */
export function serialToRouter(
  node: CppNode,
  mac: string,
  r: { router: { serialLine(device: string, line: string): void }; serial: { writeLine(selector: string, line: string): Promise<unknown> } },
): void {
  node.onSerial = (line) => queueMicrotask(() => r.router.serialLine(mac, line));
  const next = r.serial.writeLine.bind(r.serial);
  r.serial.writeLine = async (selector: string, line: string) => {
    if (selector !== mac) {
      return next(selector, line);
    }
    node.send(line);
    return { path: `/dev/cu.fake-${mac}`, key: mac };
  };
}

/** One wire's far end in a test: the datagrams a node sends to `port` (`level 0|1`, `<us>`, `frame <grb> <bits>`). */
export class WireTap {
  readonly messages: { text: string; at: number }[] = [];
  readonly #sock: UdpSocket;
  #port = 0;

  private constructor() {
    this.#sock = createSocket('udp4');
    this.#sock.on('message', (msg) => this.messages.push({ text: msg.toString('utf8'), at: Date.now() }));
  }

  static async open(): Promise<WireTap> {
    const t = new WireTap();
    await new Promise<void>((r) => t.#sock.bind(0, '127.0.0.1', () => r()));
    t.#port = t.#sock.address().port;
    return t;
  }

  get port(): number {
    return this.#port;
  }

  /** The texts so far, repeats of a held level included. */
  texts(): string[] {
    return this.messages.map((m) => m.text);
  }

  /** The texts with consecutive repeats folded: what changed on the wire. */
  changes(): string[] {
    return this.texts().filter((t, i, all) => i === 0 || t !== all[i - 1]);
  }

  /** Sends `text` to a node's port (a pad's --pin-listen, a fixture's input line). */
  send(port: number, text: string): void {
    this.#sock.send(text, port, '127.0.0.1');
  }

  close(): void {
    this.#sock.close();
  }
}

/** `fr_net_node --make-image`: an app image the node's CHECK accepts (06 §6.8 layout, SHA-256 appended). */
export function makeImage(path: string, opts: { version: string; size: number; seed: number; fault?: boolean; profile?: string }): { fw_id: string; image: Buffer } {
  const args = ['--make-image', path, '--version', opts.version, '--size', String(opts.size), '--seed', String(opts.seed)];
  if (opts.fault) {
    args.push('--fault', '1');
  }
  if (opts.profile) {
    args.push('--profile', opts.profile);
  }
  const r = spawnSync(BIN, args, { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`fr_net_node --make-image failed: ${r.stderr}`);
  }
  const line = JSON.parse(r.stdout.trim().split('\n').at(-1)!) as { ev: string; fw_id: string; size: number };
  return { fw_id: line.fw_id, image: readFileSync(path) };
}
