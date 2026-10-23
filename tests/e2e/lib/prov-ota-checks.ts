// The pure checks of T-PROV and T-OTA (tests/e2e/t-prov.ts, t-ota.ts; spec 10 §10.5, 06 §6.3-6.7): identity
// comparisons, the u16 boot-epoch order, the power-cut timeline of an OTA job (when to ask for the unplug,
// whether it came mid-download or too late), the resume evidence (64 KB stride), deploy row verdicts and the
// small parsers the two harnesses share. Nothing here calls the hub, so packages/hub/test/e2e-gates-b.test.ts
// tests it on its own.

/** The gate's bound from blank to online over Wi-Fi (10 §10.5 T-PROV). */
export const PROV_ONLINE_MAX_MS = 60_000;
/** fr_ota saves its resume offset every 64 KB, after those bytes are in flash (06 §6.6 FR_OTA_RESUME_STRIDE). */
export const RESUME_STRIDE = 65_536;
/** Below this the C3 OLED boards (8.5 dBm TX cap) take an OTA several times longer (C4 finding 1). */
export const RSSI_WARN_DBM = -70;
/** 06 §6.3: an alias is an RFC 1123 label of at most 31 characters. */
export const ALIAS_MAX = 31;

/** Signed order of two u16 boot epochs (RFC 1982, as receivers compare them): > 0 when `a` comes after `b`. */
export function epochDelta(a: number, b: number): number {
  return ((a - b) << 16) >> 16;
}

/** Two fw_ids name the same image: equal over the shorter, at least 12 hex (a HELLO prefix is 16). */
export function sameFw(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) {
    return false;
  }
  const n = Math.min(a.length, b.length);
  return n >= 12 && a.slice(0, n).toLowerCase() === b.slice(0, n).toLowerCase();
}

/** A board's warning for the report, or null when its RSSI is fine or unknown. */
export function rssiWarning(alias: string, rssi: number | null | undefined): string | null {
  return typeof rssi === 'number' && rssi !== 0 && rssi < RSSI_WARN_DBM
    ? `${alias} reports RSSI ${rssi} dBm (below ${RSSI_WARN_DBM}): a marginal C3 link stretches OTA times (C4: 52 s at -76 dBm against 15 s at -65)`
    : null;
}

// ---- identity ----

/** What the registry says of a device (device_get). */
export interface RegIdentity {
  device_id: string;
  addr: number | null;
  alias: string;
  alias_rev: number;
  net: number | null;
  profile: string | null;
  provisioned: boolean;
}

/** What the node says of itself (diag `info`; firmware fr_diag cmd_info). Fields the node does not report are absent. */
export interface NodeInfo {
  id?: string;
  alias?: string;
  addr?: number;
  state?: string;
  epoch?: number;
  fw_id?: string;
  slot?: string;
  reset?: string;
}

/**
 * Where `after` differs from `before` in what must survive an app reflash or an OTA (06 §6.3): the device
 * id, addr, alias, its revision, net and profile, and the device stays provisioned. Empty when it all held.
 */
export function identityChanges(before: RegIdentity, after: RegIdentity, opts: { aliasRev?: boolean } = {}): string[] {
  const out: string[] = [];
  const keys: (keyof RegIdentity)[] = ['device_id', 'addr', 'alias', 'net', 'profile', ...(opts.aliasRev === false ? [] : (['alias_rev'] as const))];
  for (const k of keys) {
    if (before[k] !== after[k]) {
      out.push(`${k} ${JSON.stringify(before[k])} -> ${JSON.stringify(after[k])}`);
    }
  }
  if (!after.provisioned) {
    out.push('no longer provisioned');
  }
  return out;
}

/** Where the node's own word (diag info) disagrees with the registry; only the fields the node reports count. */
export function nodeIdentityChanges(reg: RegIdentity, info: NodeInfo | null | undefined): string[] {
  if (!info) {
    return [];
  }
  const out: string[] = [];
  if (info.id !== undefined && info.id !== reg.device_id) {
    out.push(`node id ${info.id}, registry ${reg.device_id}`);
  }
  if (info.alias !== undefined && info.alias !== reg.alias) {
    out.push(`node alias ${info.alias}, registry ${reg.alias}`);
  }
  if (info.addr !== undefined && reg.addr !== null && info.addr !== reg.addr) {
    out.push(`node addr ${info.addr}, registry ${reg.addr}`);
  }
  if (info.state !== undefined && info.state !== 'PROVISIONED') {
    out.push(`node identity ${info.state}, not PROVISIONED`);
  }
  return out;
}

/** What device_provision answered (packages/hub/src/registry/provision.ts). */
export interface ProvisionResult {
  device_id: string;
  alias: string;
  alias_rev: number;
  addr: number | null;
  net: number | null;
  profile: string;
  epoch_floor: number;
  wifi: 'joined' | 'not_joined';
  duration_ms: number;
  build_id?: string;
  fw_id?: string;
}

export interface ProvisionVerdict {
  pass: boolean;
  /** Each failed check, in words. */
  problems: string[];
}

/**
 * T-PROV from blank (10 §10.5; C4 spike: 12.3 s C3, 14.6 s C6): joined over Wi-Fi within 60 s, the registry
 * identity reused for a known device (same id, addr, alias), the epoch floor above every epoch the device
 * had (so its epoch never moves back), and the new boot past the old one. `before` is null for a board
 * the registry did not know as provisioned (a first provisioning, the S3).
 */
export function provisionVerdict(
  r: ProvisionResult,
  o: { before: RegIdentity | null; beforeEpoch: number | null; alias: string; toOnlineMs: number; newEpoch: number | null; maxMs?: number },
): ProvisionVerdict {
  const problems: string[] = [];
  const max = o.maxMs ?? PROV_ONLINE_MAX_MS;
  if (r.wifi !== 'joined') {
    problems.push(`did not join Wi-Fi (wifi ${r.wifi})`);
  }
  if (o.toOnlineMs > max) {
    problems.push(`online over Wi-Fi after ${o.toOnlineMs} ms (> ${max})`);
  }
  if (r.alias !== o.alias) {
    problems.push(`alias ${r.alias}, asked ${o.alias}`);
  }
  if (o.before) {
    if (r.device_id !== o.before.device_id) {
      problems.push(`device id ${r.device_id}, was ${o.before.device_id}`);
    }
    if (r.addr !== o.before.addr) {
      problems.push(`addr ${r.addr}, was ${o.before.addr}: the registry identity was not reused`);
    }
  } else if (r.addr === null || r.addr === undefined) {
    problems.push('no addr allocated');
  }
  if (o.beforeEpoch !== null && epochDelta(r.epoch_floor, o.beforeEpoch) <= 0) {
    problems.push(`epoch_floor ${r.epoch_floor} not above the last epoch ${o.beforeEpoch}`);
  }
  if (o.beforeEpoch !== null && o.newEpoch !== null && epochDelta(o.newEpoch, o.beforeEpoch) <= 0) {
    problems.push(`boot epoch ${o.newEpoch} not after ${o.beforeEpoch}: the epoch moved back`);
  }
  return { pass: problems.length === 0, problems };
}

/** The temporary alias of the rename check: `<alias><suffix>`, cut to a valid label of at most 31 characters. */
export function renameTarget(alias: string, suffix = '-rn'): string {
  const head = alias.slice(0, Math.max(1, ALIAS_MAX - suffix.length)).replace(/-+$/, '');
  return `${head}${suffix}`.toLowerCase();
}

// ---- the power cut (T-OTA) ----

/** A hub event as events_read returns it, the fields the cut watch reads. */
export interface WatchEvent {
  cursor: string;
  seq: number;
  type: string;
  device?: string;
  fields?: Record<string, unknown>;
}

export const OTA_TERMINAL = ['SUCCEEDED', 'FAILED', 'ROLLED_BACK', 'TIMED_OUT', 'CANCELLED'] as const;

/**
 * What a new event means for a power cut mid-download:
 * - `trigger`: the job is DOWNLOADING with at least `cutAtBytes` (a 64 KB stride is in flash): ask for the unplug now;
 * - `cut`: the device went offline while it downloaded (a USB-attached node goes offline only when it lost power);
 * - `missed`: it installed the image (REBOOTING or later) or ended before it went offline: too late;
 * - `ended`: the job ended before the download reached `cutAtBytes` (a REJECT, a failure).
 */
export type CutSignal = 'trigger' | 'cut' | 'missed' | 'ended';

/**
 * Follows one ota_deploy job (its parent id) through `ota.job.state` and the device's `device.offline`, in
 * hub order, and says when to ask for the power cut and how it went. A DOWNLOADING event comes on ACCEPT and
 * then every 10 % of the image (06 §6.7), so the trigger is the first one at or past `cutAtBytes`.
 */
export class CutWatch {
  readonly parent: string;
  readonly cutAtBytes: number;
  state: string | null = null;
  attempt = 0;
  /** The bytes the hub last published for the job (DOWNLOADING every 10 %). */
  bytes = 0;
  size = 0;
  triggered = false;
  triggerCursor: string | null = null;
  cut = false;
  /** The device.offline that was the power cut, and the bytes the hub had seen by then. */
  offlineCursor: string | null = null;
  cutBytes: number | null = null;
  /** The child job (ota.job.state `job`). */
  child: string | null = null;
  /** Every state change, for the report: state, attempt, bytes, code. */
  readonly history: { state: string; attempt: number; bytes?: number; code?: string }[] = [];
  #done = false;

  constructor(parent: string, cutAtBytes: number) {
    this.parent = parent;
    this.cutAtBytes = cutAtBytes;
  }

  /** The codes the retries were published with (QUEUED {code}): device_offline after a power cut. */
  get retryCodes(): string[] {
    return this.history.filter((h) => h.state === 'QUEUED' && h.code).map((h) => h.code!);
  }

  get terminal(): boolean {
    return this.state !== null && (OTA_TERMINAL as readonly string[]).includes(this.state);
  }

  feed(e: WatchEvent): CutSignal | null {
    if (e.type === 'ota.job.state') {
      const f = e.fields ?? {};
      if (f.parent !== this.parent) {
        return null;
      }
      this.child = typeof f.job === 'string' ? f.job : this.child;
      const state = String(f.state);
      const attempt = Number(f.attempt ?? this.attempt);
      const bytes = typeof f.bytes === 'number' ? f.bytes : undefined;
      if (typeof f.size === 'number') {
        this.size = f.size;
      }
      const last = this.history.at(-1);
      if (!last || last.state !== state || last.attempt !== attempt || (bytes !== undefined && bytes !== last.bytes)) {
        this.history.push({ state, attempt, ...(bytes !== undefined ? { bytes } : {}), ...(typeof f.code === 'string' ? { code: f.code } : {}) });
      }
      this.state = state;
      this.attempt = attempt;
      if (state === 'DOWNLOADING' && bytes !== undefined && !this.cut) {
        this.bytes = Math.max(this.bytes, bytes);
      }
      if (this.cut || this.#done) {
        return null;
      }
      // Installed before the device went away: the power cut came too late.
      if (state === 'REBOOTING' || state === 'VERIFYING' || state === 'SUCCEEDED') {
        this.#done = true;
        return 'missed';
      }
      if (this.terminal) {
        this.#done = true;
        return 'ended';
      }
      if (!this.triggered && state === 'DOWNLOADING' && this.bytes >= this.cutAtBytes) {
        this.triggered = true;
        this.triggerCursor = e.cursor;
        return 'trigger';
      }
      return null;
    }
    // BYE ota is the node's own reboot into the image, never a power cut; `timeout` (its links went silent),
    // `link_lost` or `restarted` (back with a new epoch before the hub timed it out) are.
    if (e.type === 'device.offline' && e.fields?.reason !== 'ota' && !this.cut && !this.#done && (this.state === 'DOWNLOADING' || this.state === 'STAGED')) {
      this.cut = true;
      this.offlineCursor = e.cursor;
      this.cutBytes = this.bytes;
      return 'cut';
    }
    return null;
  }
}

/** `slot ota_1 open for 1204448 B at 589824` (fr_ota esp_flash.cpp, on the node's USB log). */
export function parseSlotOpen(text: string): { slot: string; size: number; offset: number } | null {
  const m = /slot (\S+) open for (\d+) B at (\d+)/.exec(text);
  return m ? { slot: m[1], size: Number(m[2]), offset: Number(m[3]) } : null;
}

export interface ResumeEvidence {
  /** The hub's child job log: `ACCEPT: resuming the download an earlier boot left in the slot`. */
  hub_resumed: boolean;
  /** The node's log: `ota: ACCEPT <job> (resumed)`. */
  node_resumed: boolean;
  /** The node's `slot … open for … at <offset>` line of the resumed attempt (the last one with an offset > 0, else the last). */
  slot: string | null;
  offset: number | null;
  size: number | null;
  /**
   * The hub's child job log: `first GET of this attempt from byte <n>`, the last attempt's with n > 0 (the
   * Range the node resumed from; hubs from M1 step 7 on). Null when no attempt started past byte 0.
   */
  hub_range_from: number | null;
}

/** `first GET of this attempt from byte 589824 of 1204448 (Range: resuming)` (the hub's OTA child job log). */
export function parseFirstGet(text: string): number | null {
  const m = /first GET of this attempt from byte (\d+)/.exec(text);
  return m ? Number(m[1]) : null;
}

/** The resume evidence of a power-cut run, from the child job's log and the node's USB log lines since the cut. */
export function resumeEvidence(jobLog: string[], nodeLog: string[]): ResumeEvidence {
  const opens = nodeLog.map(parseSlotOpen).filter((x) => x !== null);
  const open = opens.filter((o) => o.offset > 0).at(-1) ?? opens.at(-1) ?? null;
  return {
    hub_resumed: jobLog.some((l) => l.includes('ACCEPT: resuming')),
    node_resumed: nodeLog.some((l) => /ota: ACCEPT \S+ \(resumed\)/.test(l)),
    slot: open?.slot ?? null,
    offset: open?.offset ?? null,
    size: open?.size ?? null,
    hub_range_from: jobLog.map(parseFirstGet).filter((n): n is number => n !== null && n > 0).at(-1) ?? null,
  };
}

/**
 * The job resumed from a 64 KB stride (06 §6.6): the hub or the node logged a resumed ACCEPT, and the
 * node's slot offset, when its USB log is there to say (`usbLog`: the hub held its port), is a positive
 * multiple of 64 KB. The Range the hub served the resumed attempt from (its job log) must be one too, and
 * stands in for the node's offset without a USB log; without either, the hub's ACCEPT stands alone.
 */
export function resumeProblems(ev: ResumeEvidence, usbLog: boolean): string[] {
  const out: string[] = [];
  if (!ev.hub_resumed && !ev.node_resumed) {
    out.push('no resumed ACCEPT (hub job log or node log): the retry started over');
  }
  const stride = (at: number, what: string) => {
    if (at <= 0 || at % RESUME_STRIDE !== 0) {
      out.push(`${what} ${at}, not a positive multiple of ${RESUME_STRIDE}`);
    }
  };
  if (ev.offset !== null) {
    stride(ev.offset, 'resumed at');
  } else if (usbLog) {
    out.push('the node logged no `slot … open … at <offset>` line on its USB port');
  }
  if (ev.hub_range_from !== null) {
    stride(ev.hub_range_from, 'the hub served the resumed attempt from byte');
    if (ev.offset !== null && ev.offset > 0 && ev.offset !== ev.hub_range_from) {
      out.push(`the node opened its slot at ${ev.offset} but asked the hub from byte ${ev.hub_range_from}`);
    }
  }
  return out;
}

// ---- deploy rows ----

/** One row of deploy's per-device results (packages/hub/src/ota/deploy.ts DeployDeviceResult). */
export interface DeployRow {
  device: string;
  alias: string;
  profile: string | null;
  build_id: string | null;
  fw_id: string | null;
  via: string | null;
  outcome: 'updated' | 'already_current' | 'rolled_back' | 'failed';
  state: string | null;
  code?: string;
  reason?: string;
  needs_serial_recovery?: boolean;
  duration_ms: number;
  expect: 'matched' | 'timeout' | 'skipped';
  since?: string;
  ota_job?: string;
  error?: string;
}

/**
 * A normal deploy row's verdict: `ok`, `reinstall` (already_current: the image runs already, so the gate
 * reinstalls it with force to get a real OTA), or the problem.
 */
export function wifiRowVerdict(row: DeployRow | undefined, expectWanted: boolean): 'ok' | 'reinstall' | string {
  if (!row) {
    return 'no deploy row';
  }
  if (row.outcome === 'already_current') {
    return 'reinstall';
  }
  if (row.outcome !== 'updated') {
    return `${row.outcome}${row.state ? ` (${row.state}${row.code ? ` ${row.code}` : ''}${row.reason ? ` ${row.reason}` : ''})` : ''}${row.error ? `: ${row.error}` : ''}`;
  }
  if (expectWanted && row.expect !== 'matched') {
    return `expectation ${row.expect}${row.error ? `: ${row.error}` : ''}`;
  }
  return 'ok';
}

/**
 * A fault deploy row's verdict (10 §10.5 T-OTA: automatic rollback with the reason reported): `ok`,
 * `force` (REJECT same_fw: the node remembers this fault image as its last invalid one, so it goes again
 * with force), or the problem.
 */
export function faultRowVerdict(row: { outcome?: string; state?: string | null; code?: string; reason?: string } | undefined): 'ok' | 'force' | string {
  if (!row) {
    return 'no deploy row';
  }
  if (row.code === 'same_fw') {
    return 'force';
  }
  const rolledBack = row.outcome === 'rolled_back' || row.state === 'ROLLED_BACK';
  if (!rolledBack) {
    return `not rolled back: ${row.outcome ?? row.state}${row.code ? ` (${row.code})` : ''}`;
  }
  return row.reason === 'health_timeout' ? 'ok' : `rolled back with reason ${row.reason ?? 'none'}, not health_timeout`;
}

// ---- images ----

/** An artifact as artifact_list answers it. */
export interface Artifact {
  build_id: string;
  profile: string;
  build_type: string;
  fault: string | null;
  fw_id: string;
  built_at: string;
}

/** The artifact a running fw_id (or HELLO prefix) is, if the hub built it. */
export function artifactOf(arts: Artifact[], fw: string | null | undefined): Artifact | undefined {
  return arts.find((a) => sameFw(a.fw_id, fw));
}

/** The newest artifact of a kind (artifact_list is newest first): debug or release, fault or not. */
export function newestOf(arts: Artifact[], kind: { buildType: string; fault?: string | null }): Artifact | undefined {
  return arts.find((a) => a.build_type === kind.buildType && (a.fault ?? null) === (kind.fault ?? null));
}

/**
 * The image a power-cut run sends: one the device does not run (a reinstall of the running image would
 * be confirmed at once on the retry, 06 §6.7 "already installed", and never resume). The device runs its
 * normal image: the alternative; it runs the alternative (an earlier run left it there): the normal one.
 */
export function cutTarget<T extends { fw_id: string }>(running: string | null, normal: T, alt: T): T {
  if (sameFw(running, normal.fw_id)) {
    return alt;
  }
  return sameFw(running, alt.fw_id) ? normal : alt;
}

// ---- arguments ----

/** `alias:port[:profile]`: a board the registry does not know as provisioned (the S3: pad-s3:94a99015cecc:s3l-pad). */
export function parseNewBoard(spec: string): { alias: string; port: string; profile?: string } {
  const [alias, port, profile, ...rest] = spec.split(':');
  if (!alias || !port || rest.length) {
    throw new Error(`--new takes alias:port[:profile] (e.g. pad-s3:94a99015cecc:s3l-pad), not ${JSON.stringify(spec)}`);
  }
  return { alias, port, ...(profile ? { profile } : {}) };
}

/** A comma-separated list of phases, `all` for every one; anything else throws. */
export function parsePhases<P extends string>(gate: string, v: string, all: readonly P[]): P[] {
  const phases = (v === 'all' ? all.join(',') : v).split(',').filter(Boolean) as P[];
  if (!phases.length || phases.some((p) => !all.includes(p))) {
    throw new Error(`${gate}: --phase takes ${all.join('|')} (comma-separated) or all, not ${JSON.stringify(v)}`);
  }
  return phases;
}
