// Ports (`#/ports`, spec 08 §8.9): the USB serial ports and who holds each — the hub, a serial lease
// with its pid (design c6 D4), or another program such as Chrome (D5) — and the provision wizard. port_list
// is refetched on port.* events and every 2 s while the page is open: an lsof holder change has no event.

import { useState } from 'react';

import type { PortInfo } from '@fractonica/protocol/browser';

import { Badge, Button, Empty, ErrorBox, Mono, Table, type BadgeTone } from '../components/ui.tsx';
import { ProvisionWizard } from '../components/wizard.tsx';
import { useAct, useNow, useOp } from '../hooks.ts';
import { agoIso, portHolder } from '../state/format.ts';
import type { WizardKnown } from '../state/wizard.ts';

const STATE_TONE: Record<string, BadgeTone> = { open: 'ok', closed: 'muted', leased: 'info', busy_external: 'warn', error: 'bad' };

export function ReleaseButton({ leaseId }: { leaseId: string }) {
  const act = useAct('serial_release', { done: (r) => `${r.lease_id} released`, refresh: ['port_list'] });
  return (
    <Button tone="danger" disabled={act.isPending} onClick={() => act.mutate({ lease_id: leaseId })} data-action="release">
      Release
    </Button>
  );
}

export function PortsPage() {
  const now = useNow(5000);
  const ports = useOp('port_list', {}, { refetchInterval: 2000 });
  const devices = useOp('device_list', {});
  const [wizard, setWizard] = useState<{ port: PortInfo; known: WizardKnown | null } | null>(null);
  const byId = new Map((devices.data?.devices ?? []).map((d) => [d.device_id, d]));
  const rows = ports.data?.ports ?? [];
  const knownOf = (p: PortInfo): WizardKnown | null => {
    const d = p.device_id ? byId.get(p.device_id) : undefined;
    return d ? { device_id: d.device_id, alias: d.alias, profile: d.profile, presence: d.presence } : null;
  };
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold">Ports</h1>
      <ErrorBox error={ports.error} what="port_list" />
      {wizard ? <ProvisionWizard key={wizard.port.path} port={wizard.port} known={wizard.known} onClose={() => setWizard(null)} /> : null}
      <section className="rounded-lg border border-line bg-panel p-4">
        {ports.data && !rows.length ? <Empty>No USB serial port. Plug a board in; it shows here within a second.</Empty> : null}
        {rows.length ? (
          <Table head={['port', 'USB serial', 'board', 'state', 'held by', 'lines', '']}>
            {rows.map((p) => {
              const known = knownOf(p);
              return (
                <tr key={p.path} data-port={p.path} data-port-state={p.state}>
                  <td>
                    <Mono>{p.path}</Mono>
                  </td>
                  <td>
                    <Mono>{p.usb_serial ?? '–'}</Mono>
                  </td>
                  <td>{known ? <span className="font-medium">{known.alias}</span> : p.device_id ? <Mono>{p.device_id}</Mono> : <Badge>new</Badge>}</td>
                  <td>
                    <Badge tone={STATE_TONE[p.state] ?? 'muted'}>{p.state}</Badge>
                  </td>
                  <td className="text-sm">
                    {portHolder(p)}
                    {p.lease ? <span className="block text-xs text-muted">ends {agoIso(p.lease.expires_at, now)}</span> : null}
                  </td>
                  <td className="text-xs text-muted">{p.lines}</td>
                  <td className="whitespace-nowrap">
                    {p.lease ? <ReleaseButton leaseId={p.lease.lease_id} /> : null}
                    <Button tone={known ? 'default' : 'primary'} onClick={() => setWizard({ port: p, known })} data-action="provision">
                      Provision
                    </Button>
                  </td>
                </tr>
              );
            })}
          </Table>
        ) : null}
      </section>
      <p className="text-xs text-muted">
        The dashboard never opens a port itself (no Web Serial). To use a port from another program, lend it: <Mono>fr serial lease &lt;device&gt; -- &lt;command&gt;</Mono>.
      </p>
    </div>
  );
}
