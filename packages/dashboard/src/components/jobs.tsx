// Jobs as the pages list them (spec 08 §8.9 Builds and Agents): job_list rows, with the live stage and
// progress of `/ws` job frames over the stored ones, cancel, and the job's output in xterm.

import { useState } from 'react';

import type { Job } from '@fractonica/protocol/browser';

import { TERMINAL_JOB_STATUSES } from '../api/types.ts';
import { useAct, useLive, useNow } from '../hooks.ts';
import { agoIso, brief } from '../state/format.ts';
import { JobLogTerm } from './log-term.tsx';
import { Badge, Button, Empty, Progress, statusTone, Table } from './ui.tsx';

/** A job's status, stage and progress: the live frame's when newer than the stored row. */
export function useJobLive(job: Pick<Job, 'job_id' | 'status' | 'stage' | 'progress'>) {
  const live = useLive((s) => s.jobs[job.job_id]);
  // A stored terminal status wins over a frame that came before it.
  if (!live || TERMINAL_JOB_STATUSES.has(job.status)) {
    return { status: job.status, stage: job.stage, progress: job.progress };
  }
  return { status: live.status, stage: live.stage ?? job.stage, progress: live.progress ?? job.progress };
}

function JobRow({ job, onLogs, open }: { job: Job; onLogs: () => void; open: boolean }) {
  const now = useNow(5000);
  const j = useJobLive(job);
  const cancel = useAct('job_cancel', { done: (r) => `${r.job_id}: ${r.status}`, refresh: ['job_list'] });
  const running = !TERMINAL_JOB_STATUSES.has(j.status);
  const err = job.error as { code?: string; message?: string } | undefined;
  return (
    <tr data-job={job.job_id} data-status={j.status}>
      <td className="font-mono text-xs">{job.job_id}</td>
      <td>{job.kind}</td>
      <td className="max-w-48 truncate" title={job.targets.join(', ')}>
        {job.targets.join(', ')}
      </td>
      <td>
        <Badge tone={statusTone(j.status)}>{j.status}</Badge>
      </td>
      <td className="min-w-40">
        <div className="flex flex-col gap-1">
          <span className="text-xs">
            {j.stage ?? ''}
            {j.progress?.message ? ` · ${j.progress.message}` : ''}
          </span>
          {running ? <Progress pct={j.progress?.pct} /> : null}
          {err?.code ? (
            <span className="text-xs text-bad" title={err.message}>
              {err.code}: {brief(err.message, 80)}
            </span>
          ) : null}
        </div>
      </td>
      <td className="text-xs text-muted">{job.origin ?? '–'}</td>
      <td className="text-xs whitespace-nowrap text-muted">{agoIso(job.created_at, now)}</td>
      <td className="whitespace-nowrap">
        <Button tone="ghost" onClick={onLogs}>
          {open ? 'Hide output' : 'Output'}
        </Button>
        {running ? (
          <Button tone="danger" disabled={cancel.isPending} onClick={() => cancel.mutate({ job_id: job.job_id })}>
            Cancel
          </Button>
        ) : null}
      </td>
    </tr>
  );
}

export function JobTable({ jobs }: { jobs: Job[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!jobs.length) {
    return <Empty>No jobs.</Empty>;
  }
  return (
    <div className="flex flex-col gap-3">
      <Table head={['job', 'kind', 'targets', 'status', 'stage', 'origin', 'created', '']}>
        {jobs.map((j) => (
          <JobRow key={j.job_id} job={j} open={open === j.job_id} onLogs={() => setOpen((o) => (o === j.job_id ? null : j.job_id))} />
        ))}
      </Table>
      {open ? <JobLogTerm key={open} jobId={open} /> : null}
    </div>
  );
}
