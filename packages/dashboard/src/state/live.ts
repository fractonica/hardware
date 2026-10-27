// The live store (design c6 §5): what `/ws` delivers, kept for the pages. A Zustand vanilla store with
// pure updates, so it is tested in node; React reads it through useStore (hooks.ts). Logs never come
// here: they go straight into xterm (log-term.tsx).
// - A ring of the newest RING_MAX events (no snapshots, no STATE), the newest event per device, and the
//   property mirror per device from `part:'state'` events (snapshots included, 08 §8.7 state class) with the
//   last HISTORY_MAX values of each property for a sparkline. A streaming STATE (fr.analog_in at 20 Hz, design
//   m2-c3-inputs D6) updates the mirror and its history only, so it never pushes events out of the ring.
// - A device "flashes" for FLASH_MS after a capability EVENT (`part:'event'`) that is new: not a snapshot,
//   not a re-read backlog, at most FLASH_MAX_AGE_MS old. Its tile carries `data-flash` meanwhile.
// - Time (clock.ts): events are aged by hub time (`now.hub` against t_hub_us), and the store's own timers
//   (flashes, toasts, the prompt grace, job updates) run on it too; prompts expire by the hub's wall clock
//   (`now.wall` against expires_at), which is the clock the hub writes ISO times with.
// - Pending prompt_human requests (D3) from hub.prompt / hub.prompt_done, reconciled with
//   hub_status.prompts; each shows a toast until it ends or expires. A hub_status answer may predate an
//   event that just came, so for PROMPT_GRACE_MS the event wins over it.
// - Jobs as job.state events and `job` frames report them, and a toast when one ends (once per job).

import { createStore, type StoreApi } from 'zustand/vanilla';

import type { HubEvent, Prompt } from '@fractonica/protocol/browser';

import { TERMINAL_JOB_STATUSES, type JobKind, type JobStatus } from '../api/types.ts';
import type { ConnState, WsJob } from '../api/ws.ts';
import type { Now } from './clock.ts';

export const RING_MAX = 2000;
/** Values kept per property (device, `<instance>.<property>`) for its sparkline. */
export const HISTORY_MAX = 120;
export const FLASH_MS = 900;
/** A capability event older than this by hub time (a reconnect's backlog) flashes nothing. */
export const FLASH_MAX_AGE_MS = 2000;
/** A job.state event older than this by hub time (a re-read, a reconnect's backlog) toasts nothing. */
export const JOB_TOAST_MAX_AGE_MS = 10_000;
export const TOAST_MS = { ok: 6000, info: 6000, warn: 10_000, bad: 12_000 } as const;
/** Jobs kept for their live progress; the oldest updated go first (job_list has the rest). */
export const JOBS_MAX = 200;
/** How long a hub.prompt or hub.prompt_done event outranks hub_status.prompts (longer than its 5 s poll). */
export const PROMPT_GRACE_MS = 8000;

export type Tone = keyof typeof TOAST_MS;

export interface Toast {
  id: string;
  tone: Tone;
  title: string;
  body?: string;
  /** Hub ms (Now.hub): shown at, dropped after. */
  at: number;
  until: number;
  job_id?: string;
}

export interface JobLive {
  job_id: string;
  kind: JobKind | string;
  status: JobStatus;
  stage?: string;
  progress?: { pct?: number; message?: string };
  targets?: string[];
  origin?: string;
  /** Hub ms (Now.hub) of the last update. */
  at: number;
}

export interface PropValue {
  value: unknown;
  t_hub_us: number;
}

/** One past value of a property. */
export interface PropPoint {
  t_hub_us: number;
  value: unknown;
}

export interface LiveData {
  conn: ConnState;
  /** Newest last, at most RING_MAX. */
  events: readonly HubEvent[];
  /** The highest seq in the ring (seq is hub-wide and monotonic across runs). */
  maxSeq: number;
  lastByDevice: Readonly<Record<string, HubEvent>>;
  /** Device id -> hub ms (Now.hub) until which its tile flashes. */
  flashUntil: Readonly<Record<string, number>>;
  /** Device id -> `<instance>.<property>` -> value. */
  properties: Readonly<Record<string, Readonly<Record<string, PropValue>>>>;
  /** Device id -> `<instance>.<property>` -> its last HISTORY_MAX values, oldest first. */
  history: Readonly<Record<string, Readonly<Record<string, readonly PropPoint[]>>>>;
  prompts: Readonly<Record<string, Prompt>>;
  /** Prompt id -> when an event last said it began or ended (hub ms), for reconcilePrompts. */
  promptSeen: Readonly<Record<string, { at: number; done: boolean }>>;
  jobs: Readonly<Record<string, JobLive>>;
  toasts: readonly Toast[];
  /** Jobs whose end was toasted. */
  toasted: Readonly<Record<string, true>>;
}

export interface LiveActions {
  setConn(c: ConnState): void;
  ingest(batch: readonly HubEvent[], info: { snapshot?: boolean; backfill?: boolean }, now: Now): void;
  job(frame: WsJob, now: Now): void;
  /** hub_status.prompts is the hub's own list: it replaces the store's, except what events said lately. */
  reconcilePrompts(list: readonly Prompt[], now: Now): void;
  toast(t: { tone: Tone; title: string; body?: string; job_id?: string; ttlMs?: number }, now: Now): void;
  dismiss(id: string): void;
  /** Drops ended flashes, toasts and expired prompts. */
  prune(now: Now): void;
  /** A new hub run: its prompts, jobs and flashes are gone, and seq may start again (a fresh database). */
  hubRestarted(): void;
}

export type LiveState = LiveData & LiveActions;
export type LiveStore = StoreApi<LiveState>;

const IDLE: ConnState = { status: 'idle', hello: null, attempts: 0, retryInMs: null, badFrames: 0 };

function isPrompt(v: unknown): v is Prompt {
  const p = v as Partial<Prompt> | undefined;
  return typeof p?.prompt_id === 'string' && typeof p.text === 'string' && typeof p.expires_at === 'string' && Array.isArray(p.types);
}

/** The prompts after a hub_status list (pure): the list, but an event within PROMPT_GRACE_MS wins. */
export function reconcile(s: Pick<LiveData, 'prompts' | 'promptSeen'>, list: readonly Prompt[], now: Now): Pick<LiveData, 'prompts' | 'promptSeen'> {
  const recent = Object.fromEntries(Object.entries(s.promptSeen).filter(([, v]) => now.hub - v.at < PROMPT_GRACE_MS));
  const prompts: Record<string, Prompt> = {};
  for (const p of list.filter(isPrompt)) {
    if (!recent[p.prompt_id]?.done) {
      prompts[p.prompt_id] = p; // unless it ended after the list was made
    }
  }
  for (const [id, p] of Object.entries(s.prompts)) {
    if (!prompts[id] && recent[id] && !recent[id].done) {
      prompts[id] = p; // began after the list was made
    }
  }
  return { prompts, promptSeen: recent };
}

let toastSeq = 0;

/** The state itself when nothing changed, so the store notifies no one (it runs every 250 ms). */
function same(s: LiveState, patch: Partial<LiveData>): Partial<LiveState> {
  return Object.keys(patch).length ? patch : s;
}

function jobToast(j: JobLive, now: number): Toast {
  const tone: Tone = j.status === 'completed' ? 'ok' : j.status === 'failed' ? 'bad' : 'warn';
  const targets = j.targets?.length ? ` ${j.targets.join(', ')}` : '';
  return { id: `t${++toastSeq}`, tone, title: `${j.kind}${targets}: ${j.status}`, body: j.job_id, at: now, until: now + TOAST_MS[tone], job_id: j.job_id };
}

/** The data part of a store after `events` (pure; the store's ingest). Events are aged by hub time. */
export function applyEvents(s: LiveData, batch: readonly HubEvent[], info: { snapshot?: boolean; backfill?: boolean }, time: Now): Partial<LiveData> {
  const now = time.hub;
  let events: HubEvent[] | null = null;
  let maxSeq = s.maxSeq;
  let lastByDevice: Record<string, HubEvent> | null = null;
  let flashUntil: Record<string, number> | null = null;
  let properties: Record<string, Record<string, PropValue>> | null = null;
  let history: Record<string, Record<string, readonly PropPoint[]>> | null = null;
  /** History arrays this batch made (appended to in place after that; the store's own are never touched). */
  const fresh = new Set<readonly PropPoint[]>();
  let prompts: Record<string, Prompt> | null = null;
  let promptSeen: Record<string, { at: number; done: boolean }> | null = null;
  let jobs: Record<string, JobLive> | null = null;
  let toasted: Record<string, true> | null = null;
  const toasts: Toast[] = [];

  for (const e of batch) {
    if (!info.snapshot && e.seq <= maxSeq) {
      continue; // already in the ring
    }
    if (e.part === 'state' && e.device) {
      properties ??= { ...s.properties };
      const member = e.member ?? e.type.slice(e.type.indexOf('.') + 1);
      const value = e.fields && member in e.fields ? e.fields[member] : e.fields;
      properties[e.device] = { ...properties[e.device], [e.type]: { value, t_hub_us: e.t_hub_us } };
      history ??= { ...s.history };
      const byKey = history[e.device] === s.history[e.device] ? { ...s.history[e.device] } : (history[e.device] as Record<string, readonly PropPoint[]>);
      history[e.device] = byKey;
      const prev = byKey[e.type] ?? [];
      if (prev.at(-1)?.t_hub_us !== e.t_hub_us) {
        // A copy once per batch, trimmed to HISTORY_MAX with the new point.
        const points = (fresh.has(prev) ? prev : prev.slice(-(HISTORY_MAX - 1))) as PropPoint[];
        if (points.length >= HISTORY_MAX) {
          points.shift();
        }
        points.push({ t_hub_us: e.t_hub_us, value });
        fresh.add(points);
        byKey[e.type] = points;
      }
    }
    if (info.snapshot) {
      continue; // a current value, not a new event
    }
    maxSeq = e.seq;
    if (e.device) {
      (lastByDevice ??= { ...s.lastByDevice })[e.device] = e;
    }
    if (e.part === 'state') {
      continue; // the mirror and its history only, never the ring
    }
    (events ??= [...s.events]).push(e);
    const ageMs = now - e.t_hub_us / 1000;
    if (e.part === 'event' && e.device && !info.backfill && Math.abs(ageMs) <= FLASH_MAX_AGE_MS) {
      (flashUntil ??= { ...s.flashUntil })[e.device] = now + FLASH_MS;
    }
    if (e.type === 'hub.prompt' && isPrompt(e.fields)) {
      (prompts ??= { ...s.prompts })[e.fields.prompt_id] = e.fields;
      (promptSeen ??= { ...s.promptSeen })[e.fields.prompt_id] = { at: now, done: false };
    } else if (e.type === 'hub.prompt_done' && typeof e.fields?.prompt_id === 'string') {
      prompts ??= { ...s.prompts };
      delete prompts[e.fields.prompt_id];
      (promptSeen ??= { ...s.promptSeen })[e.fields.prompt_id] = { at: now, done: true };
    } else if (e.type === 'job.state' && typeof e.fields?.job_id === 'string') {
      const f = e.fields as Record<string, unknown>;
      const j: JobLive = {
        ...(jobs ?? s.jobs)[f.job_id as string],
        job_id: f.job_id as string,
        kind: String(f.kind ?? ''),
        status: f.status as JobStatus,
        ...(typeof f.stage === 'string' ? { stage: f.stage } : {}),
        ...(Array.isArray(f.targets) ? { targets: f.targets as string[] } : {}),
        ...(typeof f.origin === 'string' ? { origin: f.origin } : {}),
        at: now,
      };
      (jobs ??= { ...s.jobs })[j.job_id] = j;
      const known = toasted ?? s.toasted;
      if (TERMINAL_JOB_STATUSES.has(j.status) && !known[j.job_id] && !info.backfill && ageMs <= JOB_TOAST_MAX_AGE_MS) {
        (toasted ??= { ...s.toasted })[j.job_id] = true;
        toasts.push(jobToast(j, now));
      }
    }
  }

  const out: Partial<LiveData> = {};
  if (events) {
    out.events = events.length > RING_MAX ? events.slice(-RING_MAX) : events;
  }
  if (maxSeq !== s.maxSeq) {
    out.maxSeq = maxSeq;
  }
  Object.assign(out, {
    ...(lastByDevice ? { lastByDevice } : {}),
    ...(flashUntil ? { flashUntil } : {}),
    ...(properties ? { properties } : {}),
    ...(history ? { history } : {}),
    ...(prompts ? { prompts } : {}),
    ...(promptSeen ? { promptSeen } : {}),
    ...(jobs ? { jobs } : {}),
    ...(toasted ? { toasted } : {}),
    ...(toasts.length ? { toasts: [...s.toasts, ...toasts] } : {}),
  });
  return out;
}

/** The data part after a `job` frame (pure). */
export function applyJobFrame(s: LiveData, f: WsJob, time: Now): Partial<LiveData> {
  const now = time.hub;
  const prev = s.jobs[f.job_id];
  const j: JobLive = {
    ...prev,
    job_id: f.job_id,
    kind: f.kind,
    status: f.status,
    ...(f.stage !== undefined ? { stage: f.stage } : {}),
    ...(f.progress !== undefined ? { progress: f.progress } : {}),
    at: now,
  };
  const out: Partial<LiveData> = { jobs: { ...s.jobs, [f.job_id]: j } };
  if (TERMINAL_JOB_STATUSES.has(f.status) && !s.toasted[f.job_id]) {
    out.toasted = { ...s.toasted, [f.job_id]: true };
    out.toasts = [...s.toasts, jobToast(j, now)];
  }
  return out;
}

export function createLiveStore(): LiveStore {
  return createStore<LiveState>()((set) => ({
    conn: IDLE,
    events: [],
    maxSeq: -1,
    lastByDevice: {},
    flashUntil: {},
    properties: {},
    history: {},
    prompts: {},
    promptSeen: {},
    jobs: {},
    toasts: [],
    toasted: {},

    setConn: (conn) => set({ conn }),
    ingest: (batch, info, now) => set((s) => same(s, applyEvents(s, batch, info, now))),
    job: (frame, now) => set((s) => applyJobFrame(s, frame, now)),
    reconcilePrompts: (list, now) => set((s) => reconcile(s, list, now)),
    toast: (t, { hub }) =>
      set((s) => ({
        toasts: [
          ...s.toasts,
          { id: `t${++toastSeq}`, tone: t.tone, title: t.title, ...(t.body ? { body: t.body } : {}), ...(t.job_id ? { job_id: t.job_id } : {}), at: hub, until: hub + (t.ttlMs ?? TOAST_MS[t.tone]) },
        ],
      })),
    dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
    prune: ({ hub, wall }) =>
      set((s) => {
        const out: Partial<LiveData> = {};
        if (s.toasts.some((t) => t.until <= hub)) {
          out.toasts = s.toasts.filter((t) => t.until > hub);
        }
        if (Object.values(s.flashUntil).some((u) => u <= hub)) {
          out.flashUntil = Object.fromEntries(Object.entries(s.flashUntil).filter(([, u]) => u > hub));
        }
        if (Object.values(s.prompts).some((p) => Date.parse(p.expires_at) <= wall)) {
          out.prompts = Object.fromEntries(Object.entries(s.prompts).filter(([, p]) => Date.parse(p.expires_at) > wall));
        }
        const jobs = Object.values(s.jobs);
        if (jobs.length > JOBS_MAX) {
          const keep = jobs.sort((a, b) => b.at - a.at).slice(0, JOBS_MAX);
          out.jobs = Object.fromEntries(keep.map((j) => [j.job_id, j]));
          out.toasted = Object.fromEntries(keep.filter((j) => s.toasted[j.job_id]).map((j) => [j.job_id, true as const]));
        }
        return same(s, out);
      }),
    hubRestarted: () => set({ prompts: {}, promptSeen: {}, jobs: {}, flashUntil: {}, maxSeq: -1 }),
  }));
}

/** Whether the device's tile flashes at `now`. */
export function isFlashing(s: Pick<LiveData, 'flashUntil'>, device: string, now: Now): boolean {
  return (s.flashUntil[device] ?? 0) > now.hub;
}

/** Pending prompts, oldest first by expiry (the hub's wall clock). */
export function pendingPrompts(s: Pick<LiveData, 'prompts'>, now: Now): Prompt[] {
  return Object.values(s.prompts)
    .filter((p) => Date.parse(p.expires_at) > now.wall)
    .sort((a, b) => a.expires_at.localeCompare(b.expires_at));
}
