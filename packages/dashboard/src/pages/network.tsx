// Network (`#/network`, spec 08 §8.9): the Wi-Fi the nodes join, the hub broadcast button (design c6
// D16: message_send to every node, topic ping), the hub's LAN state (Local Network permission self-test,
// the _fractonica._tcp advert, udp_blocked links), the flood counters, and the latency panel
// (latency_stats: PING p50/p99 per link, input -> hub, bindings per path, event-loop delay).

import { useState } from 'react';

import type { LatencyStats } from '../api/types.ts';
import { Badge, Button, Empty, ErrorBox, Json, KV, Mono, Panel, Table, type BadgeTone } from '../components/ui.tsx';
import { NetworkForm } from '../components/wizard.tsx';
import { useAct, useNow, useOp } from '../hooks.ts';
import { agoIso, ms } from '../state/format.ts';
import { BROADCAST_PING } from '../state/wizard.ts';

const LNP_TONE: Record<string, BadgeTone> = { allowed: 'ok', denied: 'bad', unknown: 'muted' };
const ADVERT_TONE: Record<string, BadgeTone> = { registered: 'ok', retrying: 'warn', off: 'muted' };

function Wifi() {
  const q = useOp('network_get', {});
  const [editing, setEditing] = useState(false);
  const missing = q.error?.code === 'NOT_FOUND';
  return (
    <Panel title="Wi-Fi for the nodes" actions={q.data && !editing ? <Button onClick={() => setEditing(true)}>Change</Button> : null}>
      {q.error && !missing ? <ErrorBox error={q.error} what="network_get" /> : null}
      {missing ? <p className="mb-3 text-sm">Not set yet: nodes cannot join until it is.</p> : null}
      {q.data && !editing ? (
        <KV
          items={[
            ['SSID', <span key="s" className="font-semibold">{q.data.ssid}</span>],
            ['password', q.data.password_set ? 'stored (never shown)' : 'none (open network)'],
            ['country', q.data.country ?? '–'],
            ['BSSID', q.data.bssid ?? 'any'],
            ['hub host', <Mono key="h">{q.data.hub_host}</Mono>],
            ['net id', <Mono key="n">{q.data.net_id}</Mono>],
          ]}
        />
      ) : null}
      {missing || editing ? <NetworkForm current={q.data ?? null} onSaved={() => setEditing(false)} /> : null}
    </Panel>
  );
}

function Broadcast() {
  const [last, setLast] = useState<unknown>(null);
  const act = useAct('message_send', { done: () => 'ping broadcast' });
  return (
    <Panel title="Hub broadcast">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          tone="primary"
          disabled={act.isPending}
          data-action="broadcast-ping"
          onClick={() => act.mutate(BROADCAST_PING, { onSuccess: (r) => setLast(r) })}
        >
          Broadcast "ping"
        </Button>
        <span className="text-sm text-muted">One MSG to every node (hub broadcast, flooded over ESP-NOW; never acknowledged).</span>
      </div>
      {last !== null ? (
        <div className="mt-3">
          <Json value={last} />
        </div>
      ) : null}
    </Panel>
  );
}

function Lan() {
  const now = useNow(5000);
  const status = useOp('hub_status', {}, { refetchInterval: 5000 });
  const s = status.data;
  const counters = Object.entries(s?.router?.counters ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const flood = counters.filter(([k]) => k.startsWith('bcast') || k === 'fanned_out');
  // The router's `udp_blocked: <alias>: …` warnings: a node whose UDP never reaches the hub (05 §5.10).
  const blocked = (s?.warnings ?? []).filter((w) => w.startsWith('udp_blocked:')).map((w) => w.split(':')[1]?.trim() ?? '?');
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel title="Hub on the LAN">
        <ErrorBox error={status.error} what="hub_status" />
        {s ? (
          <KV
            items={[
              [
                'Local Network',
                <span key="l" className="flex flex-wrap items-center gap-2">
                  <Badge tone={LNP_TONE[s.lnp ?? 'unknown']}>{s.lnp ?? 'unknown'}</Badge>
                  {s.lnp_checked_at ? <span className="text-xs text-muted">checked {agoIso(s.lnp_checked_at, now)}</span> : null}
                </span>,
              ],
              ['launched by', <Mono key="b">{s.launched_by ?? '–'}</Mono>],
              [
                'advert',
                <span key="a" className="flex flex-wrap items-center gap-2">
                  <Badge tone={ADVERT_TONE[s.advert?.state ?? 'off']}>{s.advert?.state ?? 'off'}</Badge>
                  {s.advert?.name ? <Mono>{s.advert.name}</Mono> : null}
                  {s.advert?.error ? <span className="text-xs text-bad">{s.advert.error}</span> : null}
                </span>,
              ],
              [
                'UDP from nodes',
                blocked.length ? (
                  <span key="u" className="flex flex-wrap items-center gap-1" data-udp-blocked={blocked.join(',')}>
                    <Badge tone="warn">blocked</Badge> {blocked.join(', ')}
                  </span>
                ) : (
                  <Badge key="u" tone="ok">
                    no link blocked
                  </Badge>
                ),
              ],
              ['devices', `${s.devices.online} online of ${s.devices.registered}`],
              ['sessions', s.links ? `tcp ${s.links.sessions.tcp} · gateway ${s.links.sessions.gateway ?? 0} · serial ${s.links.sessions.serial}` : '–'],
              // Gateways (design m2-c4-gateway D15): up or down, LINK_PING round trip, node sessions through each.
              [
                'gateways',
                Object.keys(s.links?.gateways ?? {}).length
                  ? Object.entries(s.links!.gateways!)
                      .map(([k, g]) => `${g.alias || k} ${g.up ? `up, rtt ${g.rtt_us ?? '–'} µs` : 'down'}, ${g.sessions} sessions`)
                      .join(' · ')
                  : '–',
              ],
            ]}
          />
        ) : null}
        {s?.lnp === 'denied' ? (
          <p className="mt-3 text-sm text-bad">
            macOS denies the hub Local Network access: approve it for {s.launched_by ?? 'the app that started it'} in System Settings → Privacy &amp; Security → Local Network, or start the hub from
            Terminal.
          </p>
        ) : null}
        {s?.warnings.length ? (
          <ul className="mt-3 list-disc pl-5 text-sm text-warn" data-warnings>
            {s.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        ) : null}
      </Panel>
      <Panel title="Flood and router counters">
        {flood.length ? (
          <KV items={flood.map(([k, v]) => [k, String(v)])} />
        ) : (
          <Empty>No broadcast counters yet.</Empty>
        )}
        {counters.length > flood.length ? (
          <details className="mt-3 text-sm">
            <summary className="cursor-pointer text-muted">all {counters.length} counters</summary>
            <div className="mt-2">
              <KV items={counters.map(([k, v]) => [k, String(v)])} />
            </div>
          </details>
        ) : null}
      </Panel>
    </div>
  );
}

function Pct({ p }: { p: { n: number; p50_ms: number | null; p99_ms: number | null } | undefined }) {
  if (!p || !p.n) {
    return <span className="text-muted">–</span>;
  }
  return (
    <span className="font-mono text-xs" title={`${p.n} samples`}>
      {ms(p.p50_ms)} / {ms(p.p99_ms)}
    </span>
  );
}

function Latency() {
  const q = useOp('latency_stats', { window_s: 60 }, { refetchInterval: 5000 });
  const d: LatencyStats | undefined = q.data;
  const links = [...new Set((d?.devices ?? []).flatMap((x) => Object.keys(x.ping)))].sort();
  const paths = [...new Set((d?.devices ?? []).flatMap((x) => Object.keys(x.bindings)))].sort();
  return (
    <Panel
      title="Latency (last 60 s, p50 / p99 ms)"
      actions={
        d?.event_loop ? (
          <Badge tone={(d.event_loop.p99_ms ?? 0) > 5 ? 'warn' : 'ok'} title="the hub's event-loop delay">
            event loop p99 {ms(d.event_loop.p99_ms)} ms
          </Badge>
        ) : null
      }
    >
      <ErrorBox error={q.error} what="latency_stats" />
      {d && !d.devices.length ? <Empty>No devices.</Empty> : null}
      {d?.devices.length ? (
        <Table head={['device', ...links.map((l) => `PING ${l}`), 'input → hub', ...paths.map((p) => `binding ${p}`)]}>
          {d.devices.map((x) => (
            <tr key={x.device} data-latency={x.alias}>
              <td className="font-medium">
                {x.alias} <Badge tone={x.presence === 'online' ? 'ok' : 'muted'}>{x.presence}</Badge>
              </td>
              {links.map((l) => (
                <td key={l}>
                  <Pct p={x.ping[l]} />
                </td>
              ))}
              <td>
                <Pct p={x.input} />
              </td>
              {paths.map((p) => (
                <td key={p}>
                  <Pct p={x.bindings[p]} />
                </td>
              ))}
            </tr>
          ))}
        </Table>
      ) : null}
    </Panel>
  );
}

export function NetworkPage() {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold">Network</h1>
      <div className="grid gap-4 lg:grid-cols-2">
        <Wifi />
        <Broadcast />
      </div>
      <Lan />
      <Latency />
    </div>
  );
}
