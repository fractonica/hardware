// Builds and OTA (`#/builds`, spec 08 §8.9): the profiles and a build of each (build_start from the hub's
// own checkout, hub_status.source_dir), the artifacts, a deploy to a selector (ota_deploy, previewed with
// dry_run first), the OTA state per device, and the jobs with their progress and output.

import { useState } from 'react';

import { JobTable } from '../components/jobs.tsx';
import { Badge, Button, Empty, ErrorBox, Field, Input, Json, Mono, Panel, Select, Table } from '../components/ui.tsx';
import { useAct, useNow, useOp } from '../hooks.ts';
import { agoIso, bytes, short } from '../state/format.ts';

function Profiles({ sourceDir }: { sourceDir: string | undefined }) {
  const now = useNow(10_000);
  const profiles = useOp('profile_list', {});
  const build = useAct('build_start', { done: (j) => `build ${j.targets.join(', ')} started (${j.job_id})`, refresh: ['job_list'] });
  return (
    <Panel title="Profiles" actions={sourceDir ? <Mono className="text-muted">{sourceDir}</Mono> : null}>
      <ErrorBox error={profiles.error} what="profile_list" />
      {profiles.data && !profiles.data.profiles.length ? <Empty>No profiles in the hub's checkout.</Empty> : null}
      {profiles.data?.profiles.length ? (
        <Table head={['profile', 'board', 'chip', 'instances', 'newest debug build', '']}>
          {profiles.data.profiles.map((p) => (
            <tr key={p.profile} data-profile={p.profile}>
              <td className="font-medium">{p.profile}</td>
              <td>{p.board}</td>
              <td>{p.chip}</td>
              <td className="text-xs">
                {Object.entries(p.instances)
                  .map(([inst, x]) => `${inst}: ${x.cap.replace(/^fr\./, '')}`)
                  .join(', ')}
              </td>
              <td className="text-xs">{p.newest_debug ? `${short(p.newest_debug.fw_id)} · ${agoIso(p.newest_debug.built_at, now)}` : <Badge tone="warn">none</Badge>}</td>
              <td>
                <Button disabled={!sourceDir || build.isPending} onClick={() => sourceDir && build.mutate({ source_dir: sourceDir, profile: p.profile })} data-action="build">
                  Build
                </Button>
              </td>
            </tr>
          ))}
        </Table>
      ) : null}
    </Panel>
  );
}

function Artifacts() {
  const now = useNow(10_000);
  const q = useOp('artifact_list', { limit: 30 });
  const rows = q.data?.artifacts ?? [];
  return (
    <Panel title="Artifacts">
      <ErrorBox error={q.error} what="artifact_list" />
      {q.data && !rows.length ? <Empty>No artifacts built yet.</Empty> : null}
      {rows.length ? (
        <Table head={['build', 'profile', 'type', 'fw_id', 'built']}>
          {rows.map((a) => (
            <tr key={a.build_id}>
              <td className="font-mono text-xs">{a.build_id}</td>
              <td>{a.profile}</td>
              <td>
                {a.build_type}
                {a.fault ? (
                  <>
                    {' '}
                    <Badge tone="warn">fault {a.fault}</Badge>
                  </>
                ) : null}
              </td>
              <td className="font-mono text-xs">{short(a.fw_id, 12)}</td>
              <td className="text-xs text-muted">{agoIso(a.built_at, now)}</td>
            </tr>
          ))}
        </Table>
      ) : null}
    </Panel>
  );
}

function Deploy() {
  const [f, setF] = useState({ selector: '', profile: '', via: 'auto' });
  // The plan shown, and the input it was made for: Deploy sends only what was previewed.
  const [preview, setPreview] = useState<{ key: string; plan: unknown } | null>(null);
  const dry = useAct('ota_deploy');
  const go = useAct('ota_deploy', { done: () => 'deploy started', refresh: ['job_list', 'ota_status'] });
  const input = { selector: f.selector.trim(), ...(f.profile.trim() ? { profile: f.profile.trim() } : {}), via: f.via as 'auto' | 'serial' | 'wifi' };
  const key = JSON.stringify(input);
  const previewed = preview?.key === key;
  return (
    <Panel title="Deploy over the air">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (input.selector) {
            dry.mutate({ ...input, dry_run: true }, { onSuccess: (r) => setPreview({ key, plan: r }) });
          }
        }}
      >
        <Field label="Devices" hint="a selector: alias, tag:<t>, chip:<c>, all">
          <Input value={f.selector} onChange={(e) => setF({ ...f, selector: e.target.value })} placeholder="tag:poc" />
        </Field>
        <Field label="Profile" hint="empty: each device's own">
          <Input value={f.profile} onChange={(e) => setF({ ...f, profile: e.target.value })} placeholder="c6-pad" />
        </Field>
        <Field label="Via">
          <Select value={f.via} onChange={(v) => setF({ ...f, via: v })} options={['auto', 'wifi', 'serial'].map((v) => ({ value: v, label: v }))} />
        </Field>
        <Button type="submit" disabled={!input.selector || dry.isPending}>
          Preview
        </Button>
        <Button
          tone="primary"
          disabled={!input.selector || !previewed || go.isPending}
          title={previewed ? undefined : 'preview the plan for these devices first'}
          onClick={() => go.mutate({ ...input, dry_run: false }, { onSuccess: () => setPreview(null) })}
          data-action="deploy"
        >
          Deploy
        </Button>
      </form>
      {preview !== null ? (
        <div className="mt-3">
          <p className="mb-1 text-xs text-muted">{previewed ? 'The plan (nothing sent yet):' : 'The plan for the previous choices (preview again):'}</p>
          <Json value={preview.plan} />
        </div>
      ) : null}
    </Panel>
  );
}

function OtaState() {
  const now = useNow(5000);
  const q = useOp('ota_status', {});
  const rows = q.data?.devices ?? [];
  return (
    <Panel title="OTA state" actions={q.data?.active ? <Badge tone="info">{q.data.active} active</Badge> : null}>
      <ErrorBox error={q.error} what="ota_status" />
      {q.data && !rows.length ? <Empty>No OTA job yet.</Empty> : null}
      {rows.length ? (
        <Table head={['device', 'state', 'firmware', 'via', 'progress', 'attempt', 'updated', 'message']}>
          {rows.map((r) => (
            <tr key={r.job} data-ota={r.alias} data-ota-state={r.state}>
              <td className="font-medium">{r.alias}</td>
              <td>
                <Badge tone={r.state === 'SUCCEEDED' ? 'ok' : ['FAILED', 'ROLLED_BACK', 'TIMED_OUT'].includes(r.state) ? 'bad' : 'info'}>{r.state}</Badge>
              </td>
              <td className="font-mono text-xs">{short(r.fw_id)}</td>
              <td>{r.via}</td>
              <td className="text-xs">
                {bytes(r.bytes)} / {bytes(r.size)}
              </td>
              <td>{r.attempt}</td>
              <td className="text-xs text-muted">{agoIso(r.updated_at, now)}</td>
              <td className="text-xs">{r.message ?? r.reason ?? r.code ?? ''}</td>
            </tr>
          ))}
        </Table>
      ) : null}
    </Panel>
  );
}

export function BuildsPage() {
  const status = useOp('hub_status', {});
  const jobs = useOp('job_list', { limit: 20 }, { refetchInterval: 10_000 });
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold">Builds and OTA</h1>
      <Profiles sourceDir={status.data?.source_dir} />
      <Artifacts />
      <Deploy />
      <OtaState />
      <Panel title="Jobs">
        <ErrorBox error={jobs.error} what="job_list" />
        {jobs.data ? <JobTable jobs={jobs.data.jobs} /> : null}
      </Panel>
    </div>
  );
}
