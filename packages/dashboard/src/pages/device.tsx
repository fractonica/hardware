// A device (`#/device/<alias>`, spec 08 §8.9): what the registry and this hub run know of it, its
// capabilities rendered from the catalog (command buttons, live properties from `part:'state'` events with a
// sparkline of numeric ones, gestures through input_simulate on a debug build for fr.button instances, and for
// fr.analog_in a value form, design m2-c3-inputs D7), its recent events, bindings, logs (xterm), the
// node's own diagnostics (diag_exec info and stats), OTA history, and crashes ("not built": crash_list is
// open after C4, design c6 §1).

import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useMemo, useState } from 'react';

import { CATALOG, type CatalogCapability, type CatalogCommand } from '@fractonica/protocol/gen';

import { opMissing } from '../api/rest.ts';
import type { CommandOutcome, DeviceDetail } from '../api/types.ts';
import { IdentifyButton, RenameForm, TagsForm, useFlash } from '../components/device.tsx';
import { LogTerm } from '../components/log-term.tsx';
import { Badge, Button, Empty, ErrorBox, Input, Json, KV, Mono, Panel, presenceTone, Table } from '../components/ui.tsx';
import { useAct, useLive, useNow, useOp } from '../hooks.ts';
import { agoIso, brief, short, span } from '../state/format.ts';
import { defaultArgs, joinCatalog, parseArgs, visibleMembers, type InstanceView } from '../state/caps.ts';
import type { PropPoint } from '../state/live.ts';
import { EventRow } from './live.tsx';

const GESTURES = ['press', 'release', 'click', 'double_click', 'long_press'] as const;

function CommandForm({ deviceId, inst, cmd }: { deviceId: string; inst: string; cmd: CatalogCommand }) {
  const [text, setText] = useState(() => (cmd.fields.length ? JSON.stringify(defaultArgs(cmd)) : ''));
  const act = useAct('command_send');
  const parsed = parseArgs(text);
  const res: CommandOutcome | undefined = act.data?.results[0];
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      data-command={`${inst}.${cmd.name}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (parsed.ok) {
          act.mutate({ selector: `id:${deviceId}`, command: `${inst}.${cmd.name}`, args: parsed.args });
        }
      }}
    >
      <Button type="submit" disabled={!parsed.ok || act.isPending} aria-label={cmd.name} title={cmd.doc}>
        {cmd.name}
      </Button>
      {cmd.fields.length ? (
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label={`${cmd.name} args`}
          className="min-w-48 flex-1"
          title={cmd.fields.map((f) => `${f.name}: ${f.type}${f.default !== undefined ? ` = ${String(f.default)}` : ''}`).join(', ')}
        />
      ) : null}
      {!parsed.ok ? <span className="text-xs text-bad">{parsed.error}</span> : null}
      {res ? (
        <span className="text-xs" data-result={res.status}>
          <Badge tone={res.status === 'ok' || res.status === 'sent' ? 'ok' : 'warn'}>{res.status}</Badge>
          {res.rtt_ms !== undefined ? <span className="text-muted"> {res.rtt_ms} ms</span> : null}
          {res.fields && Object.keys(res.fields).length ? <Mono className="text-muted"> {brief(res.fields, 80)}</Mono> : null}
          {res.error ? <span className="text-bad"> {res.error}</span> : null}
        </span>
      ) : null}
    </form>
  );
}

function Gestures({ deviceId, inst }: { deviceId: string; inst: string }) {
  const act = useAct('input_simulate', { done: (r) => ({ tone: r.results[0]?.status === 'ok' ? 'ok' : 'warn', title: `${inst}: ${r.results[0]?.status ?? 'no answer'}` }) });
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="text-xs text-muted">simulate</span>
      {GESTURES.map((g) => (
        <Button key={g} tone="ghost" disabled={act.isPending} onClick={() => act.mutate({ selector: `id:${deviceId}`, instance: inst, gesture: g })}>
          {g}
        </Button>
      ))}
    </div>
  );
}

/** fr.analog_in's value range (07 §7.3): 0..65535 over the instance's min_mv..max_mv. */
const ANALOG_MAX = 65535;

/** input_simulate {value} on an fr.analog_in instance (layer inject, debug builds): a slider and its number. */
function AnalogForm({ deviceId, inst }: { deviceId: string; inst: string }) {
  const [value, setValue] = useState(32768);
  const act = useAct('input_simulate', { done: (r) => ({ tone: r.results[0]?.status === 'ok' ? 'ok' : 'warn', title: `${inst}: ${r.results[0]?.status ?? 'no answer'}` }) });
  const set = (v: number) => setValue(Number.isFinite(v) ? Math.min(ANALOG_MAX, Math.max(0, Math.round(v))) : 0);
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      data-analog={inst}
      onSubmit={(e) => {
        e.preventDefault();
        act.mutate({ selector: `id:${deviceId}`, instance: inst, value, layer: 'inject' });
      }}
    >
      <span className="text-xs text-muted">simulate</span>
      <input type="range" min={0} max={ANALOG_MAX} value={value} onChange={(e) => set(Number(e.target.value))} aria-label={`${inst} value`} className="min-w-32 flex-1 accent-accent" />
      <Input type="number" min={0} max={ANALOG_MAX} value={value} onChange={(e) => set(Number(e.target.value))} aria-label={`${inst} value number`} className="w-24" />
      <Button type="submit" tone="ghost" disabled={act.isPending} title="hold the value for 1 s (fr.analog_in inject)">
        inject
      </Button>
    </form>
  );
}

/** A property's recent numeric values (the live store's history) as a line; nothing with fewer than two. */
function Sparkline({ points, max }: { points: readonly PropPoint[] | undefined; max?: number }) {
  const nums = (points ?? []).map((p) => (typeof p.value === 'boolean' ? Number(p.value) : p.value)).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (nums.length < 2) {
    return null;
  }
  const lo = max !== undefined ? 0 : Math.min(...nums);
  const hi = max !== undefined ? max : Math.max(...nums);
  const range = hi - lo || 1;
  const w = 120;
  const h = 20;
  const d = nums.map((v, i) => `${((i / (nums.length - 1)) * w).toFixed(1)},${(h - ((v - lo) / range) * h).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} className="ml-2 inline-block align-middle text-accent" aria-hidden="true" data-sparkline>
      <polyline points={d} fill="none" stroke="currentColor" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function InstanceCard({ deviceId, inst, cap, mirror, helloCaps }: { deviceId: string; inst: InstanceView; cap: CatalogCapability | undefined; mirror: Record<string, unknown>; helloCaps: number | null }) {
  const live = useLive((s) => s.properties[deviceId]);
  const history = useLive((s) => s.history[deviceId]);
  const m = cap ? visibleMembers(cap, inst.traits, helloCaps) : null;
  // The gesture row is fr.button's, the value form fr.analog_in's (D7); any other inject is a plain command form.
  const hasInject = m?.commands.some((c) => c.name === 'inject') ?? false;
  const button = hasInject && inst.cap === 'fr.button';
  const analog = hasInject && inst.cap === 'fr.analog_in';
  const injectable = button || analog;
  return (
    <div className="rounded border border-line p-3" data-instance={inst.name}>
      <div className="mb-2 flex flex-wrap items-baseline gap-2">
        <span className="font-semibold">{inst.name}</span>
        <Mono className="text-muted">
          {inst.cap}
          {inst.v ? ` ${inst.v}` : ''} · port {inst.port}
          {inst.driver ? ` · ${inst.driver}` : ''}
        </Mono>
        {inst.traits ? <Mono className="text-muted">traits {brief(inst.traits, 80)}</Mono> : null}
      </div>
      {!m ? <p className="text-xs text-muted">Not in the catalog this dashboard has.</p> : null}
      {m?.properties.length ? (
        <dl className="mb-2 grid grid-cols-[max-content_1fr] gap-x-4 text-sm">
          {m.properties.map((p) => {
            const key = `${inst.name}.${p.name}`;
            const v = live?.[key]?.value ?? mirror[key];
            return (
              <div key={p.name} className="contents" data-property={key}>
                <dt className="text-muted">{p.name}</dt>
                <dd className="font-mono">
                  {v === undefined ? '–' : brief(v, 60)}
                  <Sparkline points={history?.[key]} {...(analog && p.name === 'value' ? { max: ANALOG_MAX } : {})} />
                </dd>
              </div>
            );
          })}
        </dl>
      ) : null}
      <div className="flex flex-col gap-1.5">
        {m?.commands
          .filter((c) => !(c.name === 'inject' && injectable))
          .map((c) => (
            <CommandForm key={c.name} deviceId={deviceId} inst={inst.name} cmd={c} />
          ))}
        {button ? <Gestures deviceId={deviceId} inst={inst.name} /> : null}
        {analog ? <AnalogForm deviceId={deviceId} inst={inst.name} /> : null}
      </div>
      {m?.events.length ? <p className="mt-2 text-xs text-muted">events: {m.events.map((e) => e.name).join(', ')}</p> : null}
    </div>
  );
}

function Capabilities({ detail }: { detail: DeviceDetail }) {
  const id = detail.device_id;
  const q = useOp('capability_list', { device: `id:${id}` });
  // capability_list (D14) first; without it (or when it knows no instance yet), the router's instances
  // from device_get and the catalog this build has.
  const listed = q.data?.device?.instances;
  const instances: InstanceView[] = listed?.length
    ? listed
    : (detail.router?.instances?.map((i) => ({ name: i.name, port: i.port, cap: i.cap, cap_id: i.cap_id, v: '', traits: null })) ?? []);
  const caps = (q.data?.caps as unknown as CatalogCapability[] | undefined) ?? CATALOG.capabilities;
  const rows = joinCatalog(instances, caps);
  const mirror = (detail.router?.properties ?? {}) as Record<string, unknown>;
  return (
    <Panel title="Capabilities" actions={q.error && !opMissing(q.error) ? <Badge tone="warn">catalog from this dashboard</Badge> : null}>
      {q.error && !opMissing(q.error) ? <ErrorBox error={q.error} what="capability_list" /> : null}
      {!rows.length ? <Empty>No capability instances known yet (the device has not said HELLO this hub run).</Empty> : null}
      <div className="grid gap-3 lg:grid-cols-2">
        {rows.map(({ inst, cap }) => (
          <InstanceCard key={inst.name} deviceId={id} inst={inst} cap={cap} mirror={mirror} helloCaps={detail.router?.hello_caps ?? null} />
        ))}
      </div>
    </Panel>
  );
}

function Bindings({ deviceId, alias }: { deviceId: string; alias: string }) {
  const [liveRead, setLiveRead] = useState(false);
  const q = useOp('binding_list', { selector: `id:${deviceId}`, live: liveRead });
  const [form, setForm] = useState({ from: `${alias}.`, to: '', args: '' });
  const set = useAct('binding_set', { done: (b) => `bound slot ${b.slot}`, refresh: ['binding_list'] });
  const clear = useAct('binding_clear', { done: () => 'binding removed', refresh: ['binding_list'] });
  const rows = q.data?.bindings ?? [];
  return (
    <Panel
      title="Bindings"
      actions={
        <label className="flex items-center gap-1 text-xs">
          <input type="checkbox" checked={liveRead} onChange={(e) => setLiveRead(e.target.checked)} /> read the node's own table
        </label>
      }
    >
      <ErrorBox error={q.error} what="binding_list" />
      {liveRead && q.data?.devices ? (
        <pre className="max-h-60 overflow-auto rounded bg-sunk p-2 font-mono text-xs">{JSON.stringify(q.data.devices, null, 2)}</pre>
      ) : rows.length ? (
        <Table head={['slot', 'from', 'to', 'args', 'pushed', '']}>
          {rows.map((b) => (
            <tr key={b.slot} data-binding={b.slot}>
              <td>{b.slot}</td>
              <td className="font-mono text-xs">{b.from}</td>
              <td className="font-mono text-xs">{b.to}</td>
              <td className="font-mono text-xs">{brief(b.args, 60)}</td>
              <td>{b.pushed ? <Badge tone="ok">pushed</Badge> : <Badge tone="warn">pending</Badge>}</td>
              <td>
                <Button tone="danger" disabled={clear.isPending} onClick={() => clear.mutate({ device: `id:${deviceId}`, slot: b.slot })}>
                  Remove
                </Button>
              </td>
            </tr>
          ))}
        </Table>
      ) : q.data ? (
        <Empty>No bindings.</Empty>
      ) : null}
      <form
        className="mt-3 flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const args = form.args.trim() ? parseArgs(form.args) : null;
          if (args && !args.ok) {
            return;
          }
          set.mutate({ from: form.from.trim(), to: form.to.trim(), ...(args?.ok ? { args: args.args } : {}) });
        }}
      >
        <Input value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} placeholder={`${alias}.boot.down`} aria-label="from" />
        <span className="text-muted">→</span>
        <Input value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} placeholder="pad-c3.status.blink" aria-label="to" />
        <Input value={form.args} onChange={(e) => setForm({ ...form, args: e.target.value })} placeholder='{"count":1}' aria-label="args" className="w-36" />
        <Button type="submit" disabled={!form.from.trim() || !form.to.trim() || set.isPending}>
          Bind
        </Button>
      </form>
    </Panel>
  );
}

/** The fr_diag lines that only read (diag_exec over USB, or fr.diag.exec over the hub link). */
const DIAG_LINES = ['info', 'stats'] as const;

function Diagnostics({ deviceId }: { deviceId: string }) {
  const [line, setLine] = useState<string | null>(null);
  const act = useAct('diag_exec');
  return (
    <Panel
      title="Diagnostics"
      actions={DIAG_LINES.map((l) => (
        <Button
          key={l}
          disabled={act.isPending}
          data-action={`diag-${l}`}
          onClick={() => {
            setLine(l);
            act.mutate({ port: deviceId, line: l });
          }}
        >
          {l}
        </Button>
      ))}
    >
      {act.isPending ? <p className="text-sm text-muted">Asking the node ({line})…</p> : null}
      <ErrorBox error={act.error} what={`diag ${line ?? ''}`} />
      {act.data && !act.isPending ? (
        <div className="flex flex-col gap-1" data-diag={line ?? ''}>
          <p className="text-xs text-muted">
            {line} via {act.data.via}
          </p>
          <Json value={act.data.response} />
        </div>
      ) : null}
      {!act.data && !act.error && !act.isPending ? <Empty>The node's own counters and build info (fr_diag), read over USB or its hub link.</Empty> : null}
    </Panel>
  );
}

function OtaHistory({ deviceId }: { deviceId: string }) {
  const now = useNow(10_000);
  const q = useOp('ota_status', { selector: `id:${deviceId}` });
  const rows = q.data?.devices ?? [];
  return (
    <Panel title="OTA">
      <ErrorBox error={q.error} what="ota_status" />
      {rows.length ? (
        <Table head={['job', 'state', 'build', 'via', 'bytes', 'updated', 'message']}>
          {rows.map((r) => (
            <tr key={r.job}>
              <td className="font-mono text-xs">{r.job}</td>
              <td>
                <Badge tone={r.state === 'SUCCEEDED' ? 'ok' : r.state === 'FAILED' || r.state === 'ROLLED_BACK' || r.state === 'TIMED_OUT' ? 'bad' : 'info'}>{r.state}</Badge>
              </td>
              <td className="font-mono text-xs">{short(r.fw_id)}</td>
              <td>{r.via}</td>
              <td className="text-xs">
                {r.bytes}/{r.size}
              </td>
              <td className="text-xs text-muted">{agoIso(r.updated_at, now)}</td>
              <td className="text-xs">{r.message ?? r.reason ?? r.code ?? ''}</td>
            </tr>
          ))}
        </Table>
      ) : q.data ? (
        <Empty>No OTA jobs for this device.</Empty>
      ) : null}
    </Panel>
  );
}

interface Heartbeat {
  uptime_s?: number;
  rssi_ap?: number;
  free_heap_kb?: number;
  vbat_mv?: number;
  tx_fail?: number;
  rx_drop?: number;
}

export function DevicePage() {
  const { alias } = useParams({ from: '/device/$alias' });
  const navigate = useNavigate();
  const now = useNow(2000);
  const q = useOp('device_get', { device: alias }, { refetchInterval: 10_000 });
  const d = q.data;
  const ring = useLive((s) => s.events);
  const recent = useMemo(() => (d ? ring.filter((e) => e.device === d.device_id).slice(-30).reverse() : []), [ring, d]);
  const flashing = useFlash(d?.device_id ?? '');
  const [renaming, setRenaming] = useState(false);
  if (q.error) {
    return (
      <div className="flex flex-col gap-3">
        <Link to="/" className="text-sm text-muted hover:underline">
          ← Devices
        </Link>
        <ErrorBox error={q.error} what={alias} />
      </div>
    );
  }
  if (!d) {
    return <p className="text-muted">Loading {alias}…</p>;
  }
  const r = d.router;
  const hb = (r?.heartbeat ?? null) as Heartbeat | null;
  return (
    <div className="flex flex-col gap-4" data-device-page={d.alias}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Link to="/" className="text-sm text-muted hover:underline">
            ← Devices
          </Link>
          {renaming ? (
            <RenameForm device={d} onDone={() => setRenaming(false)} onRenamed={(a) => void navigate({ to: '/device/$alias', params: { alias: a }, replace: true })} />
          ) : (
            <h1 className="text-lg font-semibold">{d.alias}</h1>
          )}
          <Badge tone={presenceTone(d.presence)}>{d.presence}</Badge>
          {flashing ? <Badge tone="info">input</Badge> : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <IdentifyButton device={d} />
          {!renaming ? <Button onClick={() => setRenaming(true)}>Rename</Button> : null}
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Device">
          <KV
            items={[
              ['id', <Mono key="id">{d.device_id}</Mono>],
              ['board · profile · chip', [d.board, d.profile, d.chip].filter(Boolean).join(' · ') || '–'],
              ['firmware', <Mono key="fw">{d.fw_id ?? r?.fw_id_prefix ?? '–'}</Mono>],
              ['addr · net', `${d.addr ?? '–'} · ${d.net ?? '–'}`],
              ['tags', <TagsForm key="tags" device={d} />],
              ['USB', d.port ? `${d.port} (${d.port_state ?? '?'})` : '–'],
              ['last seen', d.last_seen ? agoIso(d.last_seen, now) : '–'],
            ]}
          />
        </Panel>
        <Panel title="This hub run">
          {r ? (
            <KV
              items={[
                ['links', r.links.length ? r.links.map((l) => (l === 'gateway' && r.gw ? `gateway (${r.gw})` : l)).join(', ') : '–'],
                ['UDP', r.udp_blocked ? <Badge key="u" tone="warn">blocked</Badge> : r.udp_ms_ago !== null ? `${span(r.udp_ms_ago)} ago` : '–'],
                ['last heard', r.last_rx_ms_ago !== null ? `${span(r.last_rx_ms_ago)} ago` : '–'],
                ['RSSI', hb?.rssi_ap ? `${hb.rssi_ap} dBm` : '–'],
                ['uptime', hb?.uptime_s !== undefined ? span(hb.uptime_s * 1000) : '–'],
                ['heap', hb?.free_heap_kb !== undefined ? `${hb.free_heap_kb} KB free` : '–'],
                ['tx fail · rx drop', hb ? `${hb.tx_fail ?? 0} · ${hb.rx_drop ?? 0}` : '–'],
                ['clock', r.clock ? `±${Math.round(r.clock.uncertainty_us)} µs, rtt ${Math.round(r.clock.rtt_us)} µs` : 'not synced'],
                ['epoch · OTA state', `${r.epoch ?? '–'} · ${r.ota_state ?? '–'}`],
              ]}
            />
          ) : (
            <Empty>No HELLO from it this hub run.</Empty>
          )}
        </Panel>
      </div>
      <Capabilities detail={d} />
      <Panel title="Recent events">
        {recent.length ? (
          <div className="overflow-x-auto">
            {recent.map((e) => (
              <EventRow key={e.cursor} e={e} style={{ height: 28 }} />
            ))}
          </div>
        ) : (
          <Empty>No events from it since this page opened the stream.</Empty>
        )}
      </Panel>
      <Bindings deviceId={d.device_id} alias={d.alias} />
      <Panel title="Logs">
        <LogTerm selector={`id:${d.device_id}`} device={d.device_id} />
        <p className="mt-2 text-xs text-muted">The hub reads logs from a USB port it holds open; a node on Wi-Fi alone sends none (C6).</p>
      </Panel>
      {d.port || d.presence === 'online' || d.presence === 'suspect' ? <Diagnostics deviceId={d.device_id} /> : null}
      <OtaHistory deviceId={d.device_id} />
      <Panel title="Crashes">
        <Empty>Not built: crash reports (crash_list, crash_get) come after C6.</Empty>
      </Panel>
    </div>
  );
}
