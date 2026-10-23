// Agents (`#/agents`, spec 08 §8.9): what agents are doing on the bench — the prompt_human requests
// waiting for a person (design c6 D3), the active serial leases (D4), and the jobs started through
// `fr mcp` (job origin mcp, D18). Confirmations of destructive ops come in M2.

import type { Prompt } from '@fractonica/protocol/browser';

import { JobTable } from '../components/jobs.tsx';
import { Empty, ErrorBox, Mono, Panel, Table } from '../components/ui.tsx';
import { useLive, useNow, useOp } from '../hooks.ts';
import { agoIso, leftMs, span } from '../state/format.ts';
import { pendingPrompts } from '../state/live.ts';
import { ReleaseButton } from './ports.tsx';

export function AgentsPage() {
  const now = useNow(1000);
  const ports = useOp('port_list', {}, { refetchInterval: 2000 });
  const jobs = useOp('job_list', { origin: 'mcp', limit: 50 }, { refetchInterval: 10_000 });
  // The live store's prompts: hub.prompt events, reconciled with hub_status by the shell.
  const prompts: Prompt[] = pendingPrompts({ prompts: useLive((s) => s.prompts) }, now);
  const leased = (ports.data?.ports ?? []).filter((p) => p.lease);
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold">Agents</h1>
      <Panel title="Waiting for a person">
        {prompts.length ? (
          <ul className="flex flex-col gap-2">
            {prompts.map((p) => (
              <li key={p.prompt_id} className="rounded border border-warn/60 bg-warn/10 px-3 py-2" data-prompt={p.prompt_id}>
                <p className="font-semibold">{p.text}</p>
                <p className="text-xs text-muted">
                  waiting for <Mono>{p.types.join(', ')}</Mono>
                  {p.selector ? (
                    <>
                      {' '}
                      on <Mono>{p.selector}</Mono>
                    </>
                  ) : null}{' '}
                  · {span(leftMs(p.expires_at, now))} left · <Mono>{p.prompt_id}</Mono>
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>No agent is waiting for a person.</Empty>
        )}
      </Panel>
      <Panel title="Serial leases">
        <ErrorBox error={ports.error} what="port_list" />
        {leased.length ? (
          <Table head={['lease', 'port', 'device', 'holder pid', 'ends', '']}>
            {leased.map((p) => (
              <tr key={p.lease!.lease_id} data-lease={p.lease!.lease_id}>
                <td>
                  <Mono>{p.lease!.lease_id}</Mono>
                </td>
                <td>
                  <Mono>{p.path}</Mono>
                </td>
                <td>{p.device_id ? <Mono>{p.device_id}</Mono> : '–'}</td>
                <td>{p.lease!.holder_pid ?? '–'}</td>
                <td className="text-xs text-muted">{agoIso(p.lease!.expires_at, now)}</td>
                <td>
                  <ReleaseButton leaseId={p.lease!.lease_id} />
                </td>
              </tr>
            ))}
          </Table>
        ) : ports.data ? (
          <Empty>No port is lent out.</Empty>
        ) : null}
      </Panel>
      <Panel title="Jobs started by agents (fr mcp)">
        <ErrorBox error={jobs.error} what="job_list" />
        {jobs.data ? <JobTable jobs={jobs.data.jobs} /> : null}
      </Panel>
      <Panel title="Confirmations">
        <Empty>Confirmations of destructive ops come in M2.</Empty>
      </Panel>
    </div>
  );
}
