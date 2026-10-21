// Test helpers for the hub link (design c3 §5): FakeNode, a TS node speaking the generated codecs to the
// router over real loopback TCP and UDP (or through FakeSerial as `@fr1` lines), with the node-side rules
// the router depends on: HELLO until WELCOME, the hub-frame window reset at WELCOME, the response cache
// (a DUP CMD gets the cached RESULT byte-identical and is not executed again), SYNC_RES, PONG, heartbeats
// over UDP and TCP until a hub echo proves UDP (udp_ok; no UDP at all while UNASSIGNED), BYE, and optional
// UDP blocking. Also a fake
// registry (the Registry contract of context.ts with a small selector grammar) and a router rig.
// OTA (design c4 §3-5, stream H1): a FakeNode with `ota` set answers OFFER with ACCEPT or REJECT, pulls the
// image over real HTTP from the hub's node HTTP port with Range (resuming after a power cut from its stored
// offset), sends STATUS, checks the digest, says BYE ota and comes back on the new fw_id PENDING_VERIFY,
// then confirms (RESULT success) or rolls back (old fw_id, RESULT rolled_back); an ABORT can take a while to
// wind down (REJECT busy meanwhile) or come too late (while the boot partition is set); otaRig() puts it in
// front of a real orchestrator, job runner and artifact store.

import { createHash, randomBytes } from 'node:crypto';
import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { type ClientRequest, get as httpGet } from 'node:http';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  type ArtifactManifest,
  CLS,
  decodeSerialLine,
  encodeSerialLine,
  type Envelope,
  EXT,
  extValue,
  type FaultKind,
  FLAG,
  fnv1a32,
  FrError,
  type Header,
  type PortInfo,
  SERIAL_TYPE,
} from '@fractonica/protocol';
import {
  ADDR,
  decodeEnvelope,
  decodeNetWelcome,
  decodeOtaAbort,
  decodeOtaOffer,
  decodePresencePing,
  decodeTimeSyncReq,
  encodeDescriptor,
  encodeEnvelope,
  encodeNodeDescribeResult,
  encodeOtaAccept,
  encodeOtaReject,
  encodeOtaResult,
  encodeOtaStatus,
  encodePresenceBye,
  encodePresenceHeartbeat,
  encodePresenceHello,
  encodePresencePong,
  encodeTimeSyncRes,
  KIND,
  type NetWelcome,
  type OtaOffer,
  type OtaState,
  PORT,
  STATUS,
} from '@fractonica/protocol/gen';

import { parseAppImage, storeBlob } from '../src/artifacts.ts';
import type { Device, HelloSeen, HubContext, Presence, Registry, Router } from '../src/context.ts';
import { type Db, openDb } from '../src/db.ts';
import { EventStore } from '../src/events/index.ts';
import { JobRunner } from '../src/jobs.ts';
import { LogStore } from '../src/logstore.ts';
import { createOta, type OtaConfig, type OtaDeps, type OtaOrchestrator } from '../src/ota/index.ts';
import { createRouter, type HubRouter, type RouterClock, type RouterConfig } from '../src/router/index.ts';
import { CursorSeq } from '../src/seq.ts';

export { CLS } from '@fractonica/protocol';
export { KIND, PORT, STATUS } from '@fractonica/protocol/gen';

/** A hub frame as the node saw it (body copied). */
export interface Seen {
  header: Header;
  prefix: Envelope['prefix'];
  body: Uint8Array;
  via: 'tcp' | 'serial';
}

export type CmdHandler = (args: Uint8Array, header: Header) => { status?: number; fields?: Uint8Array } | void;

export interface FakeNodeOptions {
  /** 12 lowercase hex. */
  mac: string;
  addr?: number;
  net?: number;
  epoch?: number;
  alias?: string;
  aliasRev?: number;
  /** 16 hex. */
  fwPrefix?: string;
  descriptorHash?: number;
  hbMs?: number;
  /** Heartbeat on a timer after WELCOME (default true); false: call heartbeat() yourself. */
  autoHeartbeat?: boolean;
  /** Node clock = ms since this node was created, in µs, plus this. */
  clockOffsetUs?: number;
  /** Where the hub is (TCP and UDP). */
  hub?: { host?: string; tcp: number; udp: number };
  /** Instead of TCP/UDP: this node is USB-attached through `serial`. */
  serial?: FakeSerial;
  /** HELLO `caps` (default: wifi + inject_enabled; + provisioned when addr is set). */
  caps?: number;
  /** The last seq of the ordinary space already used (a reconnect within one boot continues it). */
  seqStart?: number;
}

/**
 * What a FakeNode does with an OTA OFFER (design c4 §3), like fr_ota over a memory flash. The one-shot
 * faults (stallAt, powerCutAt, corrupt) apply to the next download and are cleared once they fired.
 */
export interface FakeOtaOptions {
  /** The hub's node HTTP port; the host is the one the node's TCP link uses (design c4 §3 URL). */
  httpPort: number;
  /** REJECT OFFERs with this code (1 busy .. 7 bad_image), `rejectTimes` times (default: every one). */
  reject?: number;
  rejectTimes?: number;
  /** Answer no OFFER at all (the hub's ACCEPT timeout). */
  ignoreOffer?: boolean;
  /** Stop reading after this many bytes: no STATUS and no progress until an ABORT drops the download. */
  stallAt?: number;
  /** Power cut after this many bytes: silent until boot(), with the offset (rounded down to 4 KB) kept. */
  powerCutAt?: number;
  /** The image does not hash to the OFFER's fw_id: RESULT failed (digest) instead of the reboot. */
  corrupt?: boolean;
  /** The new image: confirms (RESULT success), fails its health check (rolls back), or never decides. */
  health?: 'ok' | 'fault' | 'silent';
  /** health fault: send RESULT rolled_back after coming back on the old image (default true). */
  rollbackResult?: boolean;
  /**
   * health ok: the RESULT success goes into a TCP session that dies with it (sent once, never again); the
   * node reconnects in the same boot and its HELLO says ota_state valid.
   */
  resultLost?: boolean;
  /** ms from BYE ota to the new image's HELLO, and from the health deadline to the old image's HELLO. */
  rebootMs?: number;
  /** ms the new image takes to pass (or fail) its health check. */
  healthMs?: number;
  /** After BYE ota, never come back (TIMED_OUT, needs_serial_recovery). */
  stayDown?: boolean;
  /** STATUS every this many bytes (default 5 % of the image) and at the end. */
  statusEvery?: number;
  /**
   * Takes the body as fast as the hub serves it, but writes it at this many bytes per ms: STATUS counts
   * what is written, and the image is verified once all of it is. What 7422 served then runs far ahead of
   * the node (a slow link drained from socket buffers). Not with stallAt or powerCutAt.
   */
  writeBytesPerMs?: number;
  /**
   * Install and reboot with the link already dead: no STATUS at the end, no STATUS rebooting, no BYE ota
   * (the hub sees a device go away mid-download, and come back on the new image).
   */
  silentReboot?: boolean;
  /**
   * An ABORTed download winds down this long (fr_worker still blocked in a read): every OFFER meanwhile,
   * its own job's included, gets REJECT busy.
   */
  abortBusyMs?: number;
  /** ms from the last byte (its STATUS) to STATUS rebooting: VERIFY and setting the boot partition. */
  installMs?: number;
  /**
   * An ABORT during installMs comes too late (the boot partition is being set, past fr_ota's last cancel
   * check): the node reboots into the image all the same. Without it the node stops there, silently.
   */
  abortLate?: boolean;
}

const OTA_ALIGN = 4096;

/** The download a FakeNode runs: its job, the ACCEPT code it answered, and how to keep its offset. */
interface OtaRun {
  jobId: string;
  fw: string;
  /** ACCEPT code: 0 fresh, 1 resumed (fr::ota::Accept); a re-sent OFFER of this job gets it again. */
  code: number;
  req: ClientRequest | null;
  done: boolean;
  /** nvs:fr_ota `off`: what is downloaded so far (rounded down to 4 KB) survives into the next OFFER. */
  keep(): void;
  /** Verified, the reboot into it due (installMs). */
  installing: NodeJS.Timeout | null;
}

/**
 * An image's fw_id as the node's VERIFY sees it: the SHA-256 it carries at its end (IDF images, `fr_net_node
 * --make-image`), else, for a test image of random bytes, the SHA-256 of all of it.
 */
function imageDigest(image: Buffer): string {
  if (image.length > 32) {
    const tail = image.subarray(image.length - 32).toString('hex');
    if (createHash('sha256').update(image.subarray(0, image.length - 32)).digest('hex') === tail) {
      return tail;
    }
  }
  return createHash('sha256').update(image).digest('hex');
}

export class FakeNode {
  readonly opts: Required<Omit<FakeNodeOptions, 'hub' | 'serial'>> & Pick<FakeNodeOptions, 'hub' | 'serial'>;
  welcome: NetWelcome | null = null;
  welcomes = 0;
  /** Every hub frame received, in order. */
  frames: Seen[] = [];
  /** Executions per `port/cmd` (the response cache keeps duplicates out). */
  executions = new Map<string, number>();
  handlers = new Map<string, CmdHandler>();
  /** Property values get_state re-sends: `port/prop` -> STATE body. */
  props = new Map<string, Uint8Array>();
  /** Envelopes the node sent, as [via, bytes]. */
  sent: ['tcp' | 'udp' | 'serial', Uint8Array][] = [];
  udpBlocked = false;
  /** UDP datagrams leave this much later (Wi-Fi latency, AWDL), so a TCP or serial frame sent after one can overtake it. */
  udpDelayMs = 0;
  /** Unplugged: sends nothing, ignores everything. */
  silent = false;
  /** Hub frames dropped as DUP / OLD by the node's window. */
  dups = 0;
  olds = 0;
  hubHeartbeats = 0;
  /** Hub BYEs received; like fr_net, a serial node says HELLO again at once (a TCP one reconnects later). */
  hubByes = 0;
  echoes = 0;
  timeSynced = false;
  /** The hub closed (or reset) the TCP connection. */
  tcpClosed = false;
  /** HELLO ota_state (05 §5.7): pending_verify while a new image has not passed its health check. */
  otaState: OtaState = 'valid';
  /** Set: the node takes OTA OFFERs (else they are ignored, like C3 firmware). */
  ota: FakeOtaOptions | null = null;
  /** OFFERs received, in order (duplicates of one are not repeated). */
  otaOffers: OtaOffer[] = [];
  /** The Range header of every image GET (null: from the start), and the HTTP status each got. */
  otaRanges: (string | null)[] = [];
  otaHttpStatus: number[] = [];
  /** ABORTs received. */
  otaAborts = 0;
  /** Reboots into a new image (after BYE ota). */
  otaReboots = 0;
  /** The images this node installed (sha256 hex of each); the last is what it runs after the reboot. */
  otaImages: string[] = [];
  #otaJob: OtaRun | null = null;
  /** performance.now() until which an ABORTed download is still winding down (abortBusyMs). */
  #otaWindingUntil = 0;
  /** nvs:fr_ota: the image being downloaded and how much of it survives a power cut. */
  #otaStored: { fw: string; data: Buffer } | null = null;
  #bootAt = performance.now();
  #seq = 0;
  #latestSeq = 0;
  #stateSeq = 0;
  #floor = 0;
  #seen = new Set<number>();
  #cache = new Map<string, Uint8Array>();
  #udpHeartbeats = new Set<number>();
  #lastEchoAt = -Infinity;
  #tcp: Socket | null = null;
  #udp: UdpSocket | null = null;
  #rx: Buffer = Buffer.alloc(0);
  #hbTimer: NodeJS.Timeout | null = null;
  #helloTimer: NodeJS.Timeout | null = null;
  #onWelcome: (() => void) | null = null;

  constructor(opts: FakeNodeOptions) {
    const addr = opts.addr ?? ADDR.UNASSIGNED;
    this.opts = {
      addr,
      net: 0,
      epoch: 1,
      // What FakeRegistry names a new device, so the hub has no alias to push unless a test sets one.
      alias: `node-${opts.mac.slice(-6)}`,
      aliasRev: 0,
      fwPrefix: '00112233aabbccdd',
      descriptorHash: 0,
      hbMs: 1000,
      autoHeartbeat: true,
      clockOffsetUs: 5_000_000,
      caps: (1 << 1) | (1 << 4) | (addr !== ADDR.UNASSIGNED ? 1 << 5 : 0),
      seqStart: 0,
      ...opts,
    };
    this.#seq = this.opts.seqStart;
  }

  get link(): 'tcp' | 'serial' {
    return this.opts.serial ? 'serial' : 'tcp';
  }

  /** µs since this node "booted" (esp_timer), plus the configured offset. */
  nodeNowUs(): number {
    return Math.round((performance.now() - this.#bootAt) * 1000) + this.opts.clockOffsetUs;
  }

  get udpOk(): boolean {
    return performance.now() - this.#lastEchoAt < 3 * this.opts.hbMs;
  }

  /** Opens the link and says HELLO (again every second) until WELCOME. */
  async connect(timeoutMs = 3000): Promise<NetWelcome> {
    if (this.opts.serial) {
      this.opts.serial.attach(this);
    } else {
      const hub = this.opts.hub!;
      this.#udp = createSocket('udp4');
      await new Promise<void>((r) => this.#udp!.bind(0, '127.0.0.1', () => r()));
      this.#tcp = await new Promise<Socket>((resolve, reject) => {
        const s = createConnection({ host: hub.host ?? '127.0.0.1', port: hub.tcp }, () => resolve(s));
        s.once('error', reject);
      });
      this.#tcp.setNoDelay(true);
      this.#tcp.on('data', (chunk: Buffer) => this.#onTcpData(chunk));
      this.#tcp.on('error', () => undefined);
      this.#tcp.on('close', () => (this.tcpClosed = true));
    }
    const welcomed = new Promise<void>((resolve) => (this.#onWelcome = resolve));
    const before = this.welcomes;
    this.hello();
    this.#helloTimer = setInterval(() => this.welcomes === before && this.hello(), 1000);
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([welcomed, new Promise((_, rej) => (timer = setTimeout(() => rej(new Error(`${this.opts.mac}: no WELCOME`)), timeoutMs)))]);
    } finally {
      clearTimeout(timer);
      clearInterval(this.#helloTimer!);
    }
    return this.welcome!;
  }

  /**
   * Firmware the hub has no manifest for: HELLO carries the hash of this descriptor and fr.node.describe
   * returns it (07 §7.4). Call before connect().
   */
  describeAs(caps: { port: number; cap_id: number; name: string }[]): void {
    const descriptor = encodeDescriptor({ frame_version: 1, fw_id_prefix: Buffer.from(this.opts.fwPrefix, 'hex'), profile: 'fake', board: 'fake-board', caps: caps.map((c) => ({ ...c, version: 0x0100, traits: new Uint8Array(0) })) });
    this.opts.descriptorHash = fnv1a32(descriptor);
    this.handlers.set(`${PORT.NODE}/2`, () => ({ fields: encodeNodeDescribeResult({ descriptor }) }));
  }

  /** Waits until the hub has finished the handshake (get_state answered) and published device.online. */
  async connected(events: EventStore, timeoutMs = 3000): Promise<void> {
    const online = waitForEvent(events, (e) => e.type === 'device.online' && e.device === this.opts.mac, timeoutMs);
    await this.connect(timeoutMs);
    await online;
  }

  hello(): void {
    const o = this.opts;
    const body = encodePresenceHello({
      mac: Buffer.from(o.mac, 'hex'),
      chip: 13,
      chip_rev: 1,
      fw_id_prefix: Buffer.from(o.fwPrefix, 'hex'),
      descriptor_hash: o.descriptorHash,
      board_hash: 0x4088f3ce,
      role: 'node',
      caps: o.caps,
      hb_interval_ms: o.hbMs,
      reset_reason: 1,
      ota_state: this.otaState,
      alias: o.alias,
      alias_rev: o.aliasRev,
      channel: 6,
    });
    this.#emit(CLS.PRESENCE, KIND.PRESENCE.HELLO, PORT.NODE, body, { ackReq: true }, 'session');
  }

  /** One heartbeat: over UDP once udp_ok, before that over UDP and TCP with the same bytes (05 §5.10). */
  heartbeat(): number {
    const body = encodePresenceHeartbeat({
      uptime_s: Math.floor((performance.now() - this.#bootAt) / 1000),
      state: 0b11 | (this.timeSynced ? 0b1000 : 0), // wifi_up, hub_link, time_synced
      state_seq: this.#stateSeq,
    });
    const seq = this.#emit(CLS.PRESENCE, KIND.PRESENCE.HEARTBEAT, PORT.NODE, body, {}, this.udpOk ? 'udp' : 'dual');
    if (this.link === 'tcp') {
      this.#udpHeartbeats.add(seq);
    }
    return seq;
  }

  /** A capability EVENT: realtime is URGENT + Q1, normal is Q1, bulk is Q0 (05 §5.8). */
  event(port: number, id: number, fields: Uint8Array = new Uint8Array(0), opts: { prio?: 'realtime' | 'normal' | 'bulk'; tUs?: number } = {}): number {
    const prio = opts.prio ?? 'normal';
    const prefix = { type: 'time' as const, t_us: (opts.tUs ?? this.nodeNowUs()) >>> 0 };
    const path = prio === 'realtime' ? (this.udpOk ? 'udp' : 'dual') : prio === 'normal' ? (this.udpOk ? 'session' : 'dual') : 'session';
    return this.#emit(CLS.EVENT, id, port, fields, { ackReq: prio !== 'bulk', urgent: prio === 'realtime', prefix }, path);
  }

  /** A STATE (LATEST space); remembered for get_state. */
  state(port: number, id: number, value: Uint8Array, opts: { tUs?: number } = {}): number {
    this.props.set(`${port}/${id}`, value);
    return this.#state(port, id, value, opts.tUs);
  }

  #state(port: number, id: number, value: Uint8Array, tUs?: number): number {
    const prefix = { type: 'time' as const, t_us: (tUs ?? this.nodeNowUs()) >>> 0 };
    const seq = this.#emit(CLS.STATE, id, port, value, { latest: true, prefix }, this.udpOk ? 'udp' : 'session');
    this.#stateSeq = seq;
    return seq;
  }

  bye(reason = 1): void {
    this.#emit(CLS.PRESENCE, KIND.PRESENCE.BYE, PORT.NODE, encodePresenceBye({ reason }), {}, 'session');
  }

  /** Sends raw bytes (tests of malformed or replayed frames). */
  raw(bytes: Uint8Array, via: 'tcp' | 'udp' | 'serial'): void {
    this.#write(via, bytes);
  }

  /** Builds (without sending) an envelope from this node with the next seq of its ordinary space. */
  envelope(cls: number, kind: number, port: number, body: Uint8Array, prefix?: Envelope['prefix'], flags = 0): { seq: number; bytes: Uint8Array } {
    const seq = ++this.#seq;
    return { seq, bytes: this.#encode(seq, cls, kind, port, body, flags, prefix) };
  }

  /** Power cut: nothing goes out, nothing is processed, the TCP connection is left as it is (no FIN). */
  unplug(): void {
    this.silent = true;
    this.#stopHeartbeats();
  }

  stopHeartbeats(): void {
    this.#stopHeartbeats();
  }

  /** Closes the TCP connection (FIN), as a node does when it declares the hub lost. */
  dropTcp(): void {
    this.#tcp?.end();
    this.#tcp = null;
  }

  close(): void {
    this.#stopHeartbeats();
    clearInterval(this.#helloTimer ?? undefined);
    if (this.#otaJob) {
      this.#otaJob.done = true;
      this.#otaJob.req?.destroy();
      clearTimeout(this.#otaJob.installing ?? undefined);
      this.#otaJob = null;
    }
    this.#tcp?.destroy();
    this.#tcp = null;
    try {
      this.#udp?.close();
    } catch {
      // already closed
    }
    this.#udp = null;
    this.opts.serial?.detach(this);
  }

  /** Frames of a class (and kind) the node received. */
  received(cls: number, kind?: number): Seen[] {
    return this.frames.filter((f) => f.header.cls === cls && (kind === undefined || f.header.kind === kind));
  }

  // ---- receive ----

  #onTcpData(chunk: Buffer): void {
    this.#rx = this.#rx.length ? Buffer.concat([this.#rx, chunk]) : chunk;
    while (this.#rx.length >= 2) {
      const n = this.#rx.readUInt16LE(0);
      if (this.#rx.length < n + 2) {
        break;
      }
      const env = Uint8Array.prototype.slice.call(this.#rx, 2, n + 2);
      this.#rx = this.#rx.subarray(n + 2);
      this.receive(env, 'tcp');
    }
  }

  /** One hub envelope (from TCP framing or a serial line). */
  receive(bytes: Uint8Array, via: 'tcp' | 'serial'): void {
    const d = decodeEnvelope(bytes);
    if (!d.ok) {
      throw new Error(`hub sent an undecodable envelope: ${d.error}`);
    }
    const { header: h, prefix } = d.value;
    const body = d.value.body.slice();
    // Recorded even while unplugged: what the hub sent is what the tests look at.
    this.frames.push({ header: h, prefix, body, via });
    if (this.silent) {
      return;
    }
    if (h.cls === CLS.NET && h.kind === KIND.NET.WELCOME) {
      const w = decodeNetWelcome(body);
      if (!w.ok) {
        throw new Error(`bad WELCOME: ${w.error}`);
      }
      // The node's hub windows restart at the floors WELCOME names (05 §5.8).
      this.welcome = w.value;
      this.welcomes++;
      this.#floor = w.value.ucast_floor;
      this.#seen.clear();
      this.#cache.clear();
      this.#onWelcome?.();
      this.#onWelcome = null;
      if (this.opts.autoHeartbeat && !this.#hbTimer) {
        this.#hbTimer = setInterval(() => !this.silent && this.heartbeat(), this.opts.hbMs);
      }
      return;
    }
    if (h.seq <= this.#floor) {
      this.olds++;
      return;
    }
    if (this.#seen.has(h.seq)) {
      this.dups++;
      const cached = this.#cache.get(`${h.src}/${h.epoch}/${h.seq}`);
      if (cached && h.flags & FLAG.ACK_REQ) {
        this.#write(this.link === 'serial' ? 'serial' : this.udpOk ? 'udp' : 'tcp', cached);
      }
      return;
    }
    this.#seen.add(h.seq);
    switch (h.cls) {
      case CLS.TIME:
        if (h.kind === KIND.TIME.SYNC_REQ) {
          const req = decodeTimeSyncReq(body);
          const t2 = BigInt(this.nodeNowUs());
          const t3 = BigInt(this.nodeNowUs());
          this.timeSynced = true;
          this.#emit(CLS.TIME, KIND.TIME.SYNC_RES, PORT.NODE, encodeTimeSyncRes({ t1: req.ok ? req.value.t1 : 0n, t2, t3 }), {}, 'session');
        }
        break;
      case CLS.PRESENCE:
        if (h.kind === KIND.PRESENCE.PING) {
          const ping = decodePresencePing(body);
          this.#emit(CLS.PRESENCE, KIND.PRESENCE.PONG, PORT.NODE, encodePresencePong({ t0: ping.ok ? ping.value.t0 : 0, t1: this.nodeNowUs() >>> 0 }), {}, this.udpOk ? 'udp' : 'session');
        } else if (h.kind === KIND.PRESENCE.HEARTBEAT) {
          this.hubHeartbeats++;
        } else if (h.kind === KIND.PRESENCE.BYE) {
          this.hubByes++;
          if (via === 'serial') {
            this.hello();
          }
        }
        break;
      case CLS.ACK:
        if (prefix.type === 'result' && this.#udpHeartbeats.has(prefix.req_seq)) {
          this.echoes++;
          this.#lastEchoAt = performance.now();
        }
        break;
      case CLS.CMD:
        this.#command(h, body);
        break;
      case CLS.OTA:
        this.#otaFrame(h, body);
        break;
      default:
    }
  }

  // ---- OTA (design c4 §3) ----

  /** Power back after unplug() (or a reboot): a new boot, epoch + 1, the same image; a stored OTA offset survives. */
  async boot(timeoutMs = 3000): Promise<NetWelcome> {
    this.close();
    this.silent = false;
    this.opts.epoch++;
    return this.connect(timeoutMs);
  }

  /** The bytes of the interrupted download the node kept (its nvs:fr_ota offset), or 0. */
  otaStoredBytes(): number {
    return this.#otaStored?.data.length ?? 0;
  }

  /** Verified, and setting the boot partition (installMs): its STATUS with every byte has gone out. */
  otaInstalling(): boolean {
    return Boolean(this.#otaJob?.installing);
  }

  #otaFrame(h: Header, body: Uint8Array): void {
    if (h.port !== PORT.OTA) {
      return;
    }
    if (h.kind === KIND.OTA.OFFER) {
      const d = decodeOtaOffer(body);
      if (d.ok) {
        this.otaOffers.push(d.value);
        this.#offer(h, d.value);
      }
    } else if (h.kind === KIND.OTA.ABORT) {
      const d = decodeOtaAbort(body);
      if (!d.ok) {
        return;
      }
      this.otaAborts++;
      const job = this.#otaJob;
      if (job && d.value.job_id === job.jobId) {
        if (job.installing && this.ota?.abortLate) {
          return; // too late: the boot partition is being set, and the reboot into the image follows
        }
        // fr_ota drops the job without a RESULT and keeps nvs:fr_ota in the download state: the next OFFER
        // of this image resumes from the stored offset.
        clearTimeout(job.installing ?? undefined);
        job.keep();
        job.done = true;
        job.req?.destroy();
        this.#otaJob = null;
        this.#otaWindingUntil = performance.now() + (this.ota?.abortBusyMs ?? 0);
      }
    }
  }

  /** ACCEPT or REJECT: the OFFER's answer is an OTA frame, cached like a RESULT so a DUP OFFER gets it again. */
  #answerOffer(h: Header, kind: number, jobId: string, code: number): void {
    const seq = ++this.#seq;
    const body = kind === KIND.OTA.ACCEPT ? encodeOtaAccept({ job_id: jobId, code }) : encodeOtaReject({ job_id: jobId, code });
    const bytes = this.#encode(seq, CLS.OTA, kind, PORT.OTA, body, 0);
    this.#cache.set(`${h.src}/${h.epoch}/${h.seq}`, bytes);
    this.#write(this.link === 'serial' ? 'serial' : 'tcp', bytes); // OTA frames never ride UDP
  }

  #offer(h: Header, o: OtaOffer): void {
    const ota = this.ota;
    if (!ota || ota.ignoreOffer) {
      return;
    }
    if (ota.reject !== undefined && (ota.rejectTimes ?? Infinity) > 0) {
      if (ota.rejectTimes !== undefined) {
        ota.rejectTimes--;
      }
      this.#answerOffer(h, KIND.OTA.REJECT, o.job_id, ota.reject);
      return;
    }
    if (performance.now() < this.#otaWindingUntil) {
      // fr_ota: an ABORTed job still winding down is busy to every OFFER, its own job_id's included.
      this.#answerOffer(h, KIND.OTA.REJECT, o.job_id, 1);
      return;
    }
    if (this.#otaJob) {
      // fr_ota: this job's OFFER again (its ACCEPT lost) gets the same ACCEPT; any other job REJECT busy.
      if (this.#otaJob.jobId === o.job_id) {
        this.#answerOffer(h, KIND.OTA.ACCEPT, o.job_id, this.#otaJob.code);
      } else {
        this.#answerOffer(h, KIND.OTA.REJECT, o.job_id, 1);
      }
      return;
    }
    // busy too: the running image is on probation, or there is no TCP session to download over.
    if (this.otaState === 'pending_verify' || this.link !== 'tcp') {
      this.#answerOffer(h, KIND.OTA.REJECT, o.job_id, 1);
      return;
    }
    // ACCEPT code 1: resumed from the offset an earlier boot (or an ABORTed attempt) left (fr::ota::Accept).
    const code = this.#otaStored?.fw === Buffer.from(o.fw_id).toString('hex') && this.#otaStored.data.length ? 1 : 0;
    this.#answerOffer(h, KIND.OTA.ACCEPT, o.job_id, code);
    this.#download(o, ota, code);
  }

  #otaSend(kind: number, body: Uint8Array, ackReq = false): void {
    this.#emit(CLS.OTA, kind, PORT.OTA, body, { ackReq }, 'session');
  }

  /** GET /ota/<fw>.bin from the hub, from the stored offset with Range (06 §6.6 resume). */
  #download(o: OtaOffer, ota: FakeOtaOptions, code: number): void {
    const fw = Buffer.from(o.fw_id).toString('hex');
    const stored = this.#otaStored?.fw === fw ? this.#otaStored.data : null;
    this.#otaStored = { fw, data: stored ?? Buffer.alloc(0) };
    const parts: Buffer[] = stored ? [stored] : [];
    let got = stored?.length ?? 0;
    // writeBytesPerMs: what came in; `got` is what is written (and what STATUS reports).
    let received = got;
    const keep = () => {
      // nvs:fr_ota `off`: rounded down to 4 KB (the real node writes it every 64 KB).
      const data = Buffer.concat(parts).subarray(0, got);
      this.#otaStored = { fw, data: data.subarray(0, data.length - (data.length % OTA_ALIGN)) };
    };
    const job: OtaRun = { jobId: o.job_id, fw, code, req: null, done: false, keep, installing: null };
    this.#otaJob = job;
    const every = ota.statusEvery ?? Math.max(1, Math.floor(o.size / 20));
    let nextStatus = got + every;
    const range = got > 0 ? `bytes=${got}-` : null;
    this.otaRanges.push(range);
    // STATUS state (fr::ota::Phase): 1 downloading, 3 rebooting.
    const status = (state = 1) => this.#otaSend(KIND.OTA.STATUS, encodeOtaStatus({ job_id: o.job_id, state, bytes: got }));
    const req = httpGet(
      { host: this.opts.hub?.host ?? '127.0.0.1', port: ota.httpPort, path: `/ota/${fw}.bin`, headers: range ? { range } : {}, agent: false },
      (res) => {
        this.otaHttpStatus.push(res.statusCode ?? 0);
        if (res.statusCode !== 200 && res.statusCode !== 206) {
          res.resume();
          job.done = true;
          this.#otaJob = null;
          this.#otaSend(KIND.OTA.RESULT, encodeOtaResult({ job_id: o.job_id, outcome: 1, fw_id_prefix: o.fw_id.subarray(0, 8), reason: 1 }), true);
          return;
        }
        const rate = ota.writeBytesPerMs;
        let bodyDone = false;
        const writer = rate
          ? setInterval(() => {
              if (job.done || this.silent) {
                clearInterval(writer!);
                return;
              }
              got = Math.min(received, got + rate * 10);
              if (got >= nextStatus) {
                nextStatus = got + every;
                status();
              }
              if (bodyDone && got === received) {
                clearInterval(writer!);
                finish();
              }
            }, 10)
          : null;
        res.on('data', (chunk: Buffer) => {
          if (job.done || this.silent) {
            return;
          }
          if (rate) {
            parts.push(chunk);
            received += chunk.length; // written by `writer`
            return;
          }
          let piece = chunk;
          const limit = ota.stallAt ?? ota.powerCutAt;
          if (limit !== undefined && got + piece.length >= limit) {
            piece = piece.subarray(0, Math.max(0, limit - got));
          }
          parts.push(piece);
          got += piece.length;
          if (ota.stallAt !== undefined && got >= ota.stallAt) {
            ota.stallAt = undefined;
            res.pause(); // the radio is stuck: no bytes, no STATUS, until an ABORT
            return;
          }
          if (ota.powerCutAt !== undefined && got >= ota.powerCutAt) {
            ota.powerCutAt = undefined;
            keep();
            job.done = true;
            this.#otaJob = null;
            req.destroy();
            this.unplug();
            return;
          }
          if (got >= nextStatus) {
            nextStatus = got + every;
            status();
          }
        });
        res.on('end', () => {
          if (job.done || this.silent) {
            return;
          }
          if (writer) {
            bodyDone = true; // `writer` finishes once it has written the rest
          } else {
            finish();
          }
        });
        const finish = () => {
          job.done = true;
          if (!ota.silentReboot) {
            status();
          }
          const image = Buffer.concat(parts);
          if (ota.corrupt) {
            ota.corrupt = false;
            image[0] ^= 0xff;
          }
          const digest = imageDigest(image);
          if (got !== o.size || digest !== fw) {
            this.#otaJob = null;
            this.#otaStored = null;
            this.#otaSend(KIND.OTA.RESULT, encodeOtaResult({ job_id: o.job_id, outcome: 1, fw_id_prefix: o.fw_id.subarray(0, 8), reason: 2 }), true);
            return;
          }
          const install = () => {
            job.installing = null;
            this.#otaJob = null;
            this.#otaStored = null;
            this.otaImages.push(digest);
            if (!ota.silentReboot) {
              status(3);
            }
            void this.#rebootInto(o, ota);
          };
          if (ota.installMs) {
            job.installing = setTimeout(install, ota.installMs); // the job stays: an ABORT meanwhile reaches it
          } else {
            install();
          }
        };
      },
    );
    job.req = req;
    req.on('error', () => undefined); // a power cut or an ABORT destroys it
  }

  /** BYE ota, the reboot into the new image (PENDING_VERIFY), then its health check: confirm or roll back. */
  async #rebootInto(o: OtaOffer, ota: FakeOtaOptions): Promise<void> {
    const prefix = Buffer.from(o.fw_id.subarray(0, 8)).toString('hex');
    const old = this.opts.fwPrefix;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    if (!ota.silentReboot) {
      this.bye(2);
    }
    this.otaReboots++;
    this.dropTcp(); // FIN after the BYE is out
    this.close();
    await sleep(ota.rebootMs ?? 20);
    if (ota.stayDown) {
      return;
    }
    this.opts.epoch++;
    this.opts.fwPrefix = prefix;
    this.otaState = 'pending_verify';
    this.silent = false;
    try {
      await this.connect();
    } catch {
      return; // the test ended (the hub is gone)
    }
    await sleep(ota.healthMs ?? 20);
    if (this.silent || this.opts.fwPrefix !== prefix) {
      return;
    }
    const health = ota.health ?? 'ok';
    if (health === 'ok') {
      this.otaState = 'valid'; // esp_ota_mark_app_valid_cancel_rollback()
      if (ota.resultLost) {
        this.close();
        await sleep(ota.rebootMs ?? 20);
        try {
          await this.connect();
        } catch {
          // the test ended (the hub is gone)
        }
        return;
      }
      this.#otaSend(KIND.OTA.RESULT, encodeOtaResult({ job_id: o.job_id, outcome: 0, fw_id_prefix: o.fw_id.subarray(0, 8) }), true);
    } else if (health === 'fault') {
      // The health deadline: esp_ota_mark_app_invalid_rollback_and_reboot(), no BYE.
      this.close();
      await sleep(ota.rebootMs ?? 20);
      this.opts.epoch++;
      this.opts.fwPrefix = old;
      this.otaState = 'valid';
      try {
        await this.connect();
      } catch {
        return;
      }
      if (ota.rollbackResult ?? true) {
        this.#otaSend(KIND.OTA.RESULT, encodeOtaResult({ job_id: o.job_id, outcome: 2, fw_id_prefix: o.fw_id.subarray(0, 8), reason: 1 }), true);
      }
    }
  }

  #command(h: Header, args: Uint8Array): void {
    const key = `${h.port}/${h.kind}`;
    let status: number = STATUS.OK;
    let fields: Uint8Array = new Uint8Array(0);
    const expire = extValue(h, EXT.EXPIRE_AT_US);
    const late = expire !== undefined ? (this.nodeNowUs() - expire) >>> 0 : 0;
    if (expire !== undefined && this.timeSynced && late !== 0 && late < 0x80000000) {
      status = STATUS.EXPIRED;
    } else {
      this.executions.set(key, (this.executions.get(key) ?? 0) + 1);
      if (h.port === PORT.NODE && h.kind === 7) {
        // get_state: every property again with fresh seqs.
        for (const [k, v] of this.props) {
          const [port, id] = k.split('/').map(Number);
          this.#state(port, id, v);
        }
      }
      const handler = this.handlers.get(key);
      if (handler) {
        const r = handler(args, h) ?? {};
        status = r.status ?? STATUS.OK;
        fields = r.fields ?? fields;
      } else if (!(h.port === PORT.NODE && (h.kind === 7 || h.kind === 4))) {
        status = STATUS.NOT_FOUND;
      }
    }
    if (!(h.flags & FLAG.ACK_REQ)) {
      return; // a fast command: no RESULT
    }
    const seq = ++this.#seq;
    const result = this.#encode(seq, CLS.RESULT, h.kind, h.port, fields, h.flags & FLAG.BULK, { type: 'result', req_epoch: h.epoch, req_seq: h.seq, status });
    this.#cache.set(`${h.src}/${h.epoch}/${h.seq}`, result);
    if (this.#cache.size > 8) {
      this.#cache.delete(this.#cache.keys().next().value!);
    }
    this.#write(this.link === 'serial' ? 'serial' : this.udpOk ? 'udp' : 'tcp', result);
  }

  // ---- send ----

  #encode(seq: number, cls: number, kind: number, port: number, body: Uint8Array, flags: number, prefix?: Envelope['prefix']): Uint8Array {
    const o = this.opts;
    return encodeEnvelope({
      header: { flags, cls, kind, seq, net: o.net, src: o.addr, dst: ADDR.HUB, epoch: o.epoch, ttl: 0x22, port },
      ...(prefix ? { prefix } : {}),
      body,
    });
  }

  #emit(
    cls: number,
    kind: number,
    port: number,
    body: Uint8Array,
    o: { ackReq?: boolean; urgent?: boolean; latest?: boolean; prefix?: Envelope['prefix'] },
    path: 'session' | 'udp' | 'dual',
  ): number {
    const seq = o.latest ? ++this.#latestSeq : ++this.#seq;
    const flags = (o.ackReq ? FLAG.ACK_REQ : 0) | (o.urgent ? FLAG.URGENT : 0) | (o.latest ? FLAG.LATEST : 0);
    const bytes = this.#encode(seq, cls, kind, port, body, flags, o.prefix);
    if (this.link === 'serial') {
      this.#write('serial', bytes);
    } else if (this.opts.addr === ADDR.UNASSIGNED) {
      this.#write('tcp', bytes); // fr_net: an UNASSIGNED node never uses UDP (05 §5.5)
    } else {
      if (path === 'udp' || path === 'dual') {
        this.#write('udp', bytes);
      }
      if (path === 'session' || path === 'dual') {
        this.#write('tcp', bytes);
      }
    }
    return seq;
  }

  #write(via: 'tcp' | 'udp' | 'serial', bytes: Uint8Array): void {
    if (this.silent) {
      return;
    }
    this.sent.push([via, bytes]);
    if (via === 'serial') {
      this.opts.serial!.fromNode(this.opts.mac, encodeSerialLine(SERIAL_TYPE.ENV, bytes));
    } else if (via === 'tcp') {
      if (this.#tcp && !this.#tcp.destroyed) {
        const frame = Buffer.alloc(bytes.length + 2);
        frame.writeUInt16LE(bytes.length, 0);
        frame.set(bytes, 2);
        this.#tcp.write(frame);
      }
    } else if (!this.udpBlocked && this.#udp) {
      const hub = this.opts.hub!;
      const udp = this.#udp;
      const send = () => udp.send(bytes, hub.udp, hub.host ?? '127.0.0.1');
      if (this.udpDelayMs > 0) {
        setTimeout(send, this.udpDelayMs);
      } else {
        send();
      }
    }
  }

  #stopHeartbeats(): void {
    if (this.#hbTimer) {
      clearInterval(this.#hbTimer);
      this.#hbTimer = null;
    }
  }
}

/** The USB side of FakeNodes: lines from nodes go to `deliver` (the router), writeLine reaches the node. */
export class FakeSerial {
  #nodes = new Map<string, FakeNode>();
  #goneListeners = new Set<(key: string) => void>();
  deliver: (device: string, line: string) => void = () => undefined;
  /** Lines the hub wrote, per device key. */
  written: [string, string][] = [];
  /** Make writeLine fail (a leased or stuck port). */
  failWrites = false;
  /** What list() reports, as SerialPortManager.list() would (OTA `auto` picks serial for an open, idle port). */
  ports: PortInfo[] = [];

  list(): PortInfo[] {
    return this.ports.map((p) => ({ ...p }));
  }

  attach(node: FakeNode): void {
    this.#nodes.set(node.opts.mac, node);
  }

  detach(node: FakeNode): void {
    if (this.#nodes.get(node.opts.mac) === node) {
      this.#nodes.delete(node.opts.mac);
    }
  }

  /** SerialPortManager.onPortGone: the router ends a session whose USB port goes away. */
  onPortGone(fn: (key: string) => void): () => void {
    this.#goneListeners.add(fn);
    return () => this.#goneListeners.delete(fn);
  }

  /** The USB cable of `device` is pulled: its node hears nothing more over serial, and the hub is told. */
  unplugPort(device: string): void {
    this.#nodes.delete(device);
    for (const fn of this.#goneListeners) {
      fn(device);
    }
  }

  fromNode(device: string, line: string): void {
    queueMicrotask(() => this.deliver(device, line));
  }

  async writeLine(selector: string, line: string): Promise<{ path: string; key: string }> {
    if (this.failWrites) {
      throw new FrError('DEVICE_OFFLINE', `${selector} is closed`);
    }
    this.written.push([selector, line]);
    const node = this.#nodes.get(selector);
    const d = decodeSerialLine(line);
    if (node && d.ok && d.value.type === SERIAL_TYPE.ENV) {
      const body = d.value.body.slice();
      queueMicrotask(() => node.receive(body, 'serial'));
    }
    return { path: `/dev/cu.fake-${selector}`, key: selector };
  }
}

/** The Registry contract (context.ts) over a Map, with the selector terms the tests use. */
export class FakeRegistry implements Registry {
  devices = new Map<string, Device>();
  hellos: HelloSeen[] = [];

  add(d: Partial<Device> & { device_id: string }): Device {
    const dev: Device = {
      addr: null,
      alias: `dev-${d.device_id.slice(-6)}`,
      alias_rev: 0,
      net: null,
      board: null,
      profile: null,
      chip: null,
      tags: [],
      role: 'node',
      fw_id: null,
      provisioned: false,
      last_seen: null,
      last_epoch: null,
      created_at: new Date().toISOString(),
      ...d,
    };
    this.devices.set(dev.device_id, dev);
    return dev;
  }

  get(id: string): Device | null {
    return this.devices.get(id) ?? null;
  }

  byAddr(addr: number): Device | null {
    return [...this.devices.values()].find((d) => d.addr === addr) ?? null;
  }

  byAlias(alias: string): Device | null {
    return [...this.devices.values()].find((d) => d.alias.toLowerCase() === alias.toLowerCase()) ?? null;
  }

  list(): Device[] {
    return [...this.devices.values()];
  }

  resolve(selector: string, presence: (id: string) => Presence): Device[] {
    const all = this.list();
    const match = (atom: string, d: Device) =>
      atom === 'all' ||
      (atom === 'online' && (presence(d.device_id) === 'online' || presence(d.device_id) === 'suspect')) ||
      (atom === 'offline' && !(presence(d.device_id) === 'online' || presence(d.device_id) === 'suspect')) ||
      atom === `id:${d.device_id}` ||
      (atom.startsWith('tag:') && d.tags.includes(atom.slice(4))) ||
      atom.toLowerCase() === d.alias.toLowerCase();
    const terms = selector.split(',').map((t) => t.trim()).filter(Boolean);
    const pos = terms.filter((t) => !t.startsWith('!'));
    const neg = terms.filter((t) => t.startsWith('!')).map((t) => t.slice(1));
    for (const t of pos) {
      if (!['all', 'online', 'offline'].includes(t) && !t.includes(':') && !this.byAlias(t)) {
        throw new FrError('NOT_FOUND', `no device ${t}`);
      }
    }
    return all.filter((d) => (pos.length ? pos.every((t) => match(t, d)) : true) && !neg.some((t) => match(t, d)));
  }

  /**
   * Like SqliteRegistry: a device first seen through HELLO is a row with addr null and provisioned false,
   * whatever addr its HELLO carries (design c3 §4); only provisioning (add() here) gives it an addr.
   */
  touchHello(id: string, hello: HelloSeen): Device {
    this.hellos.push(hello);
    const known = this.devices.get(id);
    const dev = known ?? this.add({ device_id: id, alias: hello.alias || `node-${id.slice(-6)}`, alias_rev: hello.alias_rev });
    Object.assign(dev, {
      fw_id: dev.fw_id ?? hello.fw_id_prefix,
      last_epoch: hello.epoch,
      last_seen: new Date().toISOString(),
    });
    return dev;
  }

  update(id: string, patch: Partial<Pick<Device, 'alias' | 'tags'>>): Device {
    const dev = this.devices.get(id);
    if (!dev) {
      throw new FrError('NOT_FOUND', id);
    }
    if (patch.alias !== undefined && patch.alias !== dev.alias) {
      dev.alias = patch.alias;
      dev.alias_rev++;
    }
    if (patch.tags) {
      dev.tags = patch.tags;
    }
    return dev;
  }
}

/** A controllable router clock: `now` in ms, `nowUs` derived from it. */
export class ManualClock implements RouterClock {
  ms = 1_000_000;
  baseUs = 1_800_000_000_000_000;
  now(): number {
    return this.ms;
  }
  nowUs(): number {
    return this.baseUs + this.ms * 1000;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

export interface Rig {
  dir: string;
  db: Db;
  logs: LogStore;
  events: EventStore;
  registry: FakeRegistry;
  serial: FakeSerial;
  router: HubRouter;
  hub: HubContext;
  ports: { tcp: number; udp: number };
  sessions: number[];
  node(opts: Omit<FakeNodeOptions, 'hub'>): FakeNode;
  close(): Promise<void>;
}

/** A router on ephemeral loopback ports with a fresh db, a fake registry and a fake serial link. */
export async function rig(
  opts: { config?: Partial<RouterConfig>; clock?: RouterClock; hubEpoch?: number; serialOnly?: boolean; registry?: FakeRegistry } = {},
): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), 'fr-router-'));
  const db = openDb(join(dir, 'hub.db'));
  const seq = new CursorSeq(db);
  const logs = new LogStore(db, 1, { retention: false, seq });
  const events = new EventStore(db, seq, 1);
  const registry = opts.registry ?? new FakeRegistry();
  const serial = new FakeSerial();
  const sessions: number[] = [];
  const router = createRouter({
    db,
    logs,
    serial,
    seq,
    registry,
    events,
    hubEpoch: opts.hubEpoch ?? 7,
    links: opts.serialOnly ? false : { host: '127.0.0.1', tcpPort: 0, udpPort: 0 },
    config: { timeSampleTimeoutMs: 200, ...opts.config },
    ...(opts.clock ? { clock: opts.clock } : {}),
    onSessions: (n) => sessions.push(n),
  });
  serial.deliver = (device, line) => router.serialLine(device, line);
  await router.start();
  const ports = router.ports() ?? { tcp: 0, udp: 0 };
  const nodes: FakeNode[] = [];
  const hub = { db, logs, serial, seq, registry, router, events, hubEpoch: opts.hubEpoch ?? 7 } as unknown as HubContext;
  return {
    dir,
    db,
    logs,
    events,
    registry,
    serial,
    router,
    hub,
    ports,
    sessions,
    node(o) {
      const n = new FakeNode({ ...o, ...(o.serial ? {} : { hub: { tcp: ports.tcp, udp: ports.udp } }) });
      nodes.push(n);
      return n;
    },
    async close() {
      for (const n of nodes) {
        n.close();
      }
      await router.stop();
      events.stop();
      logs.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Test-fast OTA timing (design c4 §7 scaled down). */
export const OTA_TEST_CONFIG: Partial<OtaConfig> = {
  acceptMs: 400,
  stallMs: 400,
  backOnlineMs: 3000,
  confirmMs: 1500,
  retryBackoffMs: [50, 100, 150],
  rollbackGraceMs: 300,
  abortGraceMs: 300,
};

/** An app image in the artifact store (FR_HOME), its manifest and its artifacts row, as ingestBuild leaves them. */
export interface TestArtifact {
  buildId: string;
  fw_id: string;
  image: Buffer;
  manifest: ArtifactManifest;
}

/**
 * Registers an artifact with a random app image of `size` bytes; fw_id is its sha256 (what FakeNode checks).
 * With `image` (an ESP app image, e.g. `fr_net_node --make-image`), the ingest parser reads fw_id (the
 * appended digest), chip id, version and fr_app_desc from it instead. FR_HOME must point at a temp dir: the
 * blob goes into its artifact store.
 */
export function addArtifact(
  db: Db,
  dir: string,
  opts: {
    profile?: string;
    size?: number;
    image?: Buffer;
    fault?: FaultKind;
    chipId?: number;
    target?: string;
    version?: string;
    builtAt?: string;
    buildType?: 'debug' | 'release';
  } = {},
): TestArtifact {
  const profile = opts.profile ?? 'c6-pad';
  const buildType = opts.buildType ?? 'debug';
  const image = opts.image ?? randomBytes(opts.size ?? 96 * 1024);
  const parsed = opts.image ? parseAppImage(opts.image) : null;
  const fw = parsed?.fw_id ?? createHash('sha256').update(image).digest('hex');
  const file = join(dir, `${fw}.bin`);
  writeFileSync(file, image);
  const blob = storeBlob(file);
  const buildId = `node/${profile}/${opts.fault ? `${buildType}-fault` : buildType}/${fw.slice(0, 12)}`;
  const manifest: ArtifactManifest = {
    schema: 'fractonica.artifact/1',
    build_id: buildId,
    app: 'node',
    profile,
    build_type: buildType,
    board: 'esp32c6-supermini',
    target: opts.target ?? 'esp32c6',
    chip_id: opts.chipId ?? parsed?.chip_id ?? 13,
    part_profile: 'fr-4mb-v1',
    version: opts.version ?? parsed?.version ?? `1a2b3c4-dirty.${fw.slice(0, 8)}`,
    source_dir: '/src',
    git: { sha: 'abc', dirty: true },
    idf: { version: 'v6.1', commit: 'def' },
    fw_id: fw,
    elf_sha256: '00',
    size: image.length,
    built_at: opts.builtAt ?? new Date().toISOString(),
    flash: { mode: 'dio', freq: '80m', size: '4MB', files: [{ offset: '0x10000', role: 'app', blob: blob.ref, size: image.length }] },
    partitions: [],
    ...(opts.fault ? { fault: opts.fault } : {}),
    ...(parsed?.app_desc ? { app_desc: parsed.app_desc } : {}),
  };
  const manifestPath = join(dir, `${buildId.replaceAll('/', '_')}.json`);
  writeFileSync(manifestPath, JSON.stringify(manifest));
  db.prepare('INSERT INTO artifacts (build_id, source_dir, profile, build_type, fw_id, built_at, manifest_path, fault) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    buildId,
    '/src',
    profile,
    buildType,
    fw,
    manifest.built_at,
    manifestPath,
    opts.fault ?? null,
  );
  return { buildId, fw_id: fw, image, manifest };
}

export interface OtaRig extends Rig {
  jobs: JobRunner;
  ota: OtaOrchestrator;
  /** The bound node HTTP port. */
  httpPort: number;
  /** onActive calls, in order (SleepGuard's view). */
  activity: boolean[];
  /** A FakeNode that takes OTA OFFERs and downloads from this rig's node HTTP port. */
  otaNode(opts: Omit<FakeNodeOptions, 'hub'> & { ota?: Omit<FakeOtaOptions, 'httpPort'> }): FakeNode;
}

/**
 * rig() plus a job runner and a real OTA orchestrator with its node HTTP listener on 127.0.0.1:0, in the
 * HubContext the op handlers get. `wrapRouter` lets a test stand between the orchestrator and the router.
 */
export async function otaRig(
  opts: {
    config?: Partial<RouterConfig>;
    ota?: Partial<OtaConfig>;
    registry?: FakeRegistry;
    wrapRouter?: (router: Router) => Router;
    flashApp?: OtaDeps['flashApp'];
    http?: { host: string; port: number };
  } = {},
): Promise<OtaRig> {
  const r = await rig({ config: opts.config, registry: opts.registry });
  const jobs = new JobRunner(r.db);
  const activity: boolean[] = [];
  const ota = createOta({
    db: r.db,
    router: opts.wrapRouter ? opts.wrapRouter(r.router) : r.router,
    registry: r.registry,
    events: r.events,
    jobs,
    http: opts.http ?? { host: '127.0.0.1', port: 0 },
    config: { ...OTA_TEST_CONFIG, ...opts.ota },
    onActive: (a) => activity.push(a),
    ...(opts.flashApp ? { flashApp: opts.flashApp } : {}),
  });
  await ota.start();
  const hub = { ...r.hub, jobs, ota } as HubContext;
  const close = r.close;
  return {
    ...r,
    hub,
    jobs,
    ota,
    httpPort: ota.httpPort() ?? 0,
    activity,
    otaNode(o) {
      const { ota: otaOpts, ...rest } = o;
      const n = r.node(rest);
      n.ota = { httpPort: ota.httpPort() ?? 0, ...otaOpts };
      return n;
    },
    async close() {
      jobs.cancelAll();
      await ota.stop();
      await close();
    },
  };
}

/** Resolves with the first event matching `pred` (published from now on). */
export function waitForEvent(events: EventStore, pred: (e: import('../src/context.ts').HubEvent) => boolean, timeoutMs = 3000): Promise<import('../src/context.ts').HubEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error('event did not arrive'));
    }, timeoutMs);
    const off = events.subscribe((e) => {
      if (pred(e)) {
        clearTimeout(timer);
        off();
        resolve(e);
      }
    });
  });
}

/** Polls `cond` until it is truthy. */
export async function until<T>(cond: () => T, timeoutMs = 3000, what = 'condition'): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = cond();
    if (v) {
      return v as NonNullable<T>;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}
