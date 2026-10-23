// Which cached op results an event makes stale (design c6 §5 live-update rules). Query keys start with the
// op name, so the app invalidates by name; it batches the names of one burst (runtime.ts).

import type { HubEvent, OpName } from '@fractonica/protocol/browser';

import { TERMINAL_JOB_STATUSES, type JobKind, type JobStatus } from '../api/types.ts';

const DEVICE: readonly OpName[] = ['device_list', 'device_get', 'latency_stats'];

/** The ops a job's end changes, besides the job ops themselves. */
export function jobEndInvalidations(kind: JobKind | string): readonly OpName[] {
  switch (kind) {
    case 'build':
      return ['artifact_list', 'profile_list'];
    case 'provision':
      return ['device_list', 'device_get', 'port_list'];
    case 'flash':
    case 'reset':
      return ['port_list', 'device_get'];
    case 'ota':
    case 'deploy':
      return ['ota_status', 'device_list', 'device_get', 'artifact_list'];
    default:
      return [];
  }
}

/** A job's status or stage changed. */
export function jobInvalidations(kind: JobKind | string, status: JobStatus | string): readonly OpName[] {
  const base: OpName[] = ['job_list', 'job_get', 'hub_status'];
  return TERMINAL_JOB_STATUSES.has(status as JobStatus) ? [...base, ...jobEndInvalidations(kind)] : base;
}

export function invalidationsFor(e: HubEvent): readonly OpName[] {
  const t = e.type;
  if (t.startsWith('device.') || t.startsWith('registry.')) {
    return DEVICE;
  }
  if (t.startsWith('port.')) {
    return ['port_list', 'device_list'];
  }
  if (t === 'job.state') {
    const f = e.fields ?? {};
    return jobInvalidations(String(f.kind ?? ''), String(f.status ?? ''));
  }
  if (t === 'ota.job.state') {
    return ['ota_status'];
  }
  if (t === 'hub.prompt' || t === 'hub.prompt_done' || t === 'hub.warning') {
    return ['hub_status'];
  }
  if (t === 'node.boot') {
    return ['device_get'];
  }
  return [];
}
