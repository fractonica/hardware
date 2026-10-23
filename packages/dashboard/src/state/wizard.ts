// The provision wizard (spec 11 §11.3 item 3, 11.5 step 2; design c6 §5): detect -> network -> profile +
// alias -> flash -> join, as a pure reducer. The Ports page runs the calls and dispatches what they return:
// - detect: the port (port_list) and what the registry knows of its board (device_list by device_id).
// - network: network_get; NOT_FOUND asks for the Wi-Fi once (network_set; the password is write-only and
//   never shown again). A stored network skips the step ("set the Wi-Fi network once").
// - profile + alias: profile_list (or the profiles of the debug artifacts) plus "auto" (the hub picks the
//   one built for the probed chip); the alias is checked as it is typed with the registry's own rules
//   (aliasProblem); uniqueness is the hub's, which refuses before the job starts.
// - flash: device_provision {port, profile?, alias?, wait_s: 0} starts a job; its stages (lease .. join)
//   come from `/ws` job frames, with job_get as the fallback. A job frame carries no result or error, so a
//   job that ends by one is read once more with job_get (needsJobDetail).
// - join: the job's result says whether the board joined over Wi-Fi; device.online (or device_get, for a
//   board that came online before the wizard knew its id) confirms it.
// An error shows the hub's message and what a person can do (remediation). INVALID_ARGS with candidate
// profiles (several built for the chip) offers them and retries with the one picked.

import { aliasProblem, BROADCAST_ALIAS, type Prompt, type ToolError } from '@fractonica/protocol/browser';

import { remedies } from '../api/rest.ts';
import { TERMINAL_JOB_STATUSES, type JobStatus, type ProvisionResult } from '../api/types.ts';

/** device_provision's job stages, in order (hub registry/provision.ts). */
export const PROVISION_STAGES = ['lease', 'probe', 'select', 'registry', 'render', 'flash', 'reset', 'hello', 'join'] as const;

export type WizardStep = 'closed' | 'detect' | 'network' | 'profile' | 'flash' | 'done';

export interface WizardPort {
  path: string;
  usb_serial?: string;
  device_id?: string;
  state: string;
  holder?: string;
}

/** What the registry knows of the board on the port. */
export interface WizardKnown {
  device_id: string;
  alias: string;
  profile: string | null;
  presence?: string;
}

export interface ProfileOption {
  profile: string;
  board?: string;
  chip?: string;
  /** A debug artifact exists to flash. */
  built: boolean;
}

export interface WizardError {
  code: string;
  message: string;
  /** What a person can do, from the hint and remediation. */
  human: string[];
  /** INVALID_ARGS for several profiles built for the chip: pick one and retry. */
  candidates: string[];
}

export interface WizardJob {
  job_id: string;
  status: JobStatus;
  stage?: string;
  progress?: { pct?: number; message?: string };
  /** Stages seen, in order. */
  stages: string[];
  /** Ended, and its result or error is known (a job_get answer, or a frame that carried it). */
  detail: boolean;
}

export type NetworkState = { state: 'loading' } | { state: 'missing' } | { state: 'set'; ssid: string } | { state: 'error'; error: string };

export interface WizardState {
  step: WizardStep;
  port: WizardPort | null;
  known: WizardKnown | null;
  network: NetworkState;
  /** null while loading. */
  profiles: ProfileOption[] | null;
  /** '' = auto. */
  profile: string;
  /** '' = the hub's default (the registry alias, else <profile>-<last 6 hex of the MAC>). */
  alias: string;
  aliasError: string | null;
  job: WizardJob | null;
  result: ProvisionResult | null;
  /** device.online seen for the board after the job started. */
  online: boolean;
  error: WizardError | null;
}

export type WizardAction =
  | { type: 'open'; port: WizardPort; known: WizardKnown | null }
  | { type: 'close' }
  | { type: 'next' }
  | { type: 'back' }
  | { type: 'network'; network: NetworkState }
  | { type: 'profiles'; profiles: ProfileOption[] }
  | { type: 'profile'; profile: string }
  | { type: 'alias'; alias: string }
  | { type: 'submitted' }
  /** A job frame, or with `full` the whole job (job_get, device_provision's answer). */
  | { type: 'job'; job: { job_id: string; status: JobStatus; stage?: string; progress?: { pct?: number; message?: string }; result?: unknown; error?: unknown }; full?: boolean }
  | { type: 'failed'; error: ToolError }
  | { type: 'online'; device_id: string }
  | { type: 'pick'; profile: string };

export const WIZARD_CLOSED: WizardState = {
  step: 'closed',
  port: null,
  known: null,
  network: { state: 'loading' },
  profiles: null,
  profile: '',
  alias: '',
  aliasError: null,
  job: null,
  result: null,
  online: false,
  error: null,
};

/** Why `alias` cannot be used (lower-cased, as the registry stores it); null when fine or left empty. */
export function aliasError(alias: string): string | null {
  const a = alias.trim().toLowerCase();
  return a ? aliasProblem(a) : null;
}

function isToolError(v: unknown): v is ToolError {
  const e = v as Partial<ToolError> | undefined;
  return typeof e?.code === 'string' && typeof e.message === 'string';
}

/** How the wizard shows a hub error: its message, what to do, and the profiles to pick from. */
export function wizardError(err: ToolError): WizardError {
  const human = remedies(err);
  const candidates = err.code === 'INVALID_ARGS' && Array.isArray(err.details?.candidates) ? (err.details.candidates as unknown[]).filter((c): c is string => typeof c === 'string') : [];
  if (!human.length) {
    if (err.code === 'PORT_BUSY_EXTERNAL') {
      human.push('Close the program that holds the port (a Web Serial tab in Chrome, a serial monitor), then retry.');
    } else if (err.code === 'PORT_LEASED') {
      human.push('The port is lent out (a serial lease): release it on the Agents page or wait for it to end, then retry.');
    } else if (err.code === 'LOCKED') {
      human.push('Another job is using this port; retry when it ends.');
    }
  }
  return { code: err.code, message: err.message, human, candidates };
}

/** The input of device_provision for the current choices. */
export function provisionInput(s: WizardState): { port: string; profile?: string; alias?: string; wait_s: number } {
  const port = s.port?.usb_serial ?? s.port?.device_id ?? s.port?.path ?? '';
  const alias = s.alias.trim().toLowerCase();
  return { port, ...(s.profile ? { profile: s.profile } : {}), ...(alias ? { alias } : {}), wait_s: 0 };
}

/** Whether the profile step may start the job. */
export function canSubmit(s: WizardState): boolean {
  return s.step === 'profile' && s.port !== null && s.network.state === 'set' && s.aliasError === null && !(s.job && !TERMINAL_JOB_STATUSES.has(s.job.status));
}

export type StageStatus = 'done' | 'current' | 'failed' | 'pending';

/** Each provision stage with its status, for the progress list. */
export function stageView(s: Pick<WizardState, 'job' | 'result'>): { stage: string; status: StageStatus }[] {
  const job = s.job;
  const at = job?.stage ? PROVISION_STAGES.indexOf(job.stage as (typeof PROVISION_STAGES)[number]) : -1;
  return PROVISION_STAGES.map((stage, i) => {
    let status: StageStatus = 'pending';
    if (job?.status === 'completed') {
      status = 'done';
    } else if (i < at) {
      status = 'done';
    } else if (i === at) {
      status = job?.status === 'failed' || job?.status === 'cancelled' ? 'failed' : 'current';
    }
    return { stage, status };
  });
}

/** The device id the job provisions (its result, the port's board, or the registry's). */
export function wizardDeviceId(s: WizardState): string | undefined {
  return s.result?.device_id ?? s.port?.device_id ?? s.known?.device_id;
}

/** Whether a prompt_human request names the board being provisioned (the wizard shows it inline). */
export function promptForWizard(s: WizardState, p: Prompt): boolean {
  const alias = s.result?.alias ?? s.known?.alias;
  return alias !== undefined && p.selector !== undefined && p.selector.split(',').includes(alias);
}

/** The job ended: done with its result, or the hub's error (a generic one until job_get says more). */
function endJob(s: WizardState, job: WizardJob, a: Extract<WizardAction, { type: 'job' }>): WizardState {
  if (a.job.status === 'completed') {
    const result = (a.job.result ?? null) as ProvisionResult | null;
    return { ...s, step: 'done', job: { ...job, detail: a.full === true || result !== null }, result, online: s.online || result?.wifi === 'joined' };
  }
  const known = isToolError(a.job.error);
  const err: ToolError = known ? (a.job.error as ToolError) : { code: 'INTERNAL', message: `the job ${a.job.status}`, retryable: false };
  return { ...s, job: { ...job, detail: a.full === true || known }, error: wizardError(err) };
}

/** The job ended by a frame without its result or error: read it once with job_get. */
export function needsJobDetail(s: Pick<WizardState, 'job'>): boolean {
  return s.job !== null && TERMINAL_JOB_STATUSES.has(s.job.status) && !s.job.detail;
}

function afterNetwork(s: WizardState): WizardStep {
  return s.network.state === 'set' ? 'profile' : 'network';
}

export function wizardReducer(s: WizardState, a: WizardAction): WizardState {
  switch (a.type) {
    case 'open':
      return { ...WIZARD_CLOSED, step: 'detect', port: a.port, known: a.known, alias: a.known?.alias ?? '', profile: a.known?.profile ?? '' };
    case 'close':
      return WIZARD_CLOSED;
    case 'next':
      if (s.step === 'detect') {
        return { ...s, step: afterNetwork(s), error: null };
      }
      if (s.step === 'network' && s.network.state === 'set') {
        return { ...s, step: 'profile', error: null };
      }
      return s;
    case 'back':
      if (s.step === 'profile') {
        return { ...s, step: 'detect', error: null };
      }
      if (s.step === 'network') {
        return { ...s, step: 'detect', error: null };
      }
      if ((s.step === 'flash' || s.step === 'done') && (!s.job || TERMINAL_JOB_STATUSES.has(s.job.status))) {
        return { ...s, step: 'profile', job: null, result: null, online: false, error: null };
      }
      return s;
    case 'network':
      // Stored while on the network step: go on to the profile.
      return { ...s, network: a.network, ...(s.step === 'network' && a.network.state === 'set' ? { step: 'profile' as const, error: null } : {}) };
    case 'profiles':
      return { ...s, profiles: a.profiles };
    case 'profile':
      return { ...s, profile: a.profile };
    case 'alias':
      return { ...s, alias: a.alias, aliasError: aliasError(a.alias) };
    case 'submitted':
      return { ...s, step: 'flash', job: null, result: null, online: false, error: null };
    case 'job': {
      if (s.step !== 'flash' && s.step !== 'done') {
        return s;
      }
      if (s.job && s.job.job_id !== a.job.job_id) {
        return s; // another job's frame
      }
      const ended = TERMINAL_JOB_STATUSES.has(a.job.status);
      if (s.job && TERMINAL_JOB_STATUSES.has(s.job.status)) {
        // Ended: a late frame changes nothing, but the whole job (job_get) fills in the result or error
        // that the ending job frame lacked.
        const fills = !s.job.detail && ended && (a.full === true || a.job.result !== undefined || a.job.error !== undefined);
        return fills ? endJob(s, s.job, a) : s;
      }
      const stages = s.job?.stages.slice() ?? [];
      if (a.job.stage && stages.at(-1) !== a.job.stage) {
        stages.push(a.job.stage);
      }
      const job: WizardJob = {
        job_id: a.job.job_id,
        status: a.job.status,
        stage: a.job.stage ?? s.job?.stage,
        progress: a.job.progress ?? s.job?.progress,
        stages,
        detail: false,
      };
      return ended ? endJob(s, job, a) : { ...s, job };
    }
    case 'failed':
      return { ...s, error: wizardError(a.error) };
    case 'online':
      return s.step !== 'closed' && a.device_id === wizardDeviceId(s) ? { ...s, online: true } : s;
    case 'pick':
      return { ...s, step: 'profile', profile: a.profile, job: null, result: null, error: null };
  }
}

/** The Network page's broadcast button (design c6 D16): one MSG `ping` to every node; count 1 answers at once. */
export const BROADCAST_PING = { to: BROADCAST_ALIAS, topic: 'ping' } as const;

/** Problems of a network_set form (the hub's input rules), or null. */
export function networkProblem(f: { ssid: string; password: string; country: string; bssid: string }): string | null {
  if (f.ssid.length < 1 || f.ssid.length > 32) {
    return 'the SSID must be 1-32 characters';
  }
  if (f.password.length > 64) {
    return 'the password is at most 64 characters';
  }
  if (f.country && !/^[A-Za-z]{2}$/.test(f.country)) {
    return 'the country is a 2-letter code, e.g. US';
  }
  if (f.bssid && !/^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/.test(f.bssid)) {
    return 'the BSSID is a MAC, e.g. 3c:84:6a:12:34:56';
  }
  return null;
}

/** network_set's input from the form: empty optional fields left out, the country upper-cased. */
export function networkInput(f: { ssid: string; password: string; country: string; bssid: string }): {
  ssid: string;
  password?: string;
  country?: string;
  bssid?: string;
} {
  return {
    ssid: f.ssid,
    ...(f.password ? { password: f.password } : {}),
    ...(f.country ? { country: f.country.toUpperCase() } : {}),
    ...(f.bssid ? { bssid: f.bssid.toLowerCase() } : {}),
  };
}
