// A device on the Devices grid, and the actions every device has (spec 08 §8.9): identify (D15:
// node.identify, which every node has), rename (the registry's alias rules, checked as it is typed) and
// tags. The tile carries data-device="<alias>" and, for 900 ms after an input, data-flash (design c6 §5),
// so a headless check can read the page. A tile renders from its device_list row alone (design m2-c2 D16): the
// row's `live` has the links, RSSI and uptime, so 30 tiles cost one device_list, not a device_get each.

import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';

import type { DeviceView } from '@fractonica/protocol/browser';

import { useAct, useLive, useNow } from '../hooks.ts';
import { hubClock } from '../runtime.ts';
import { agoUs, short, span } from '../state/format.ts';
import { aliasError } from '../state/wizard.ts';
import { Badge, Button, Dot, Input, presenceTone } from './ui.tsx';

/** Whether the device's tile flashes now; re-renders when the flash ends. */
export function useFlash(deviceId: string): boolean {
  const until = useLive((s) => s.flashUntil[deviceId] ?? 0);
  const [, tick] = useState(0);
  const left = until - hubClock.hubNow();
  useEffect(() => {
    if (left > 0) {
      const t = setTimeout(() => tick((n) => n + 1), left + 5);
      return () => clearTimeout(t);
    }
  }, [until, left]);
  return left > 0;
}

/** Identify: the node blinks its first LED for 3 s (fr.node.identify, design c6 D15). */
export function IdentifyButton({ device }: { device: Pick<DeviceView, 'device_id' | 'alias'> }) {
  const act = useAct('command_send', {
    done: (r) => {
      const res = r.results[0];
      return res?.status === 'ok'
        ? `${device.alias}: identifying`
        : { tone: 'warn', title: `${device.alias}: identify ${res?.status ?? 'unanswered'}`, ...(res?.error ? { body: res.error } : {}) };
    },
  });
  const status = act.data?.results[0]?.status;
  return (
    <Button
      data-action="identify"
      disabled={act.isPending}
      onClick={() => act.mutate({ selector: `id:${device.device_id}`, command: 'node.identify', args: { ms: 3000 } })}
      aria-label="Identify"
      title={status && status !== 'ok' ? `last answer: ${status}` : 'blink the first LED for 3 s'}
    >
      Identify
    </Button>
  );
}

/** Rename; `onRenamed` gets the new alias (the device page's route is by alias). */
export function RenameForm({ device, onDone, onRenamed }: { device: Pick<DeviceView, 'device_id' | 'alias'>; onDone?: () => void; onRenamed?: (alias: string) => void }) {
  const [alias, setAlias] = useState(device.alias);
  const act = useAct('device_update', { done: (d) => `renamed to ${d.alias}`, refresh: ['device_list', 'device_get'] });
  const problem = alias.trim() === '' ? 'an alias is needed' : aliasError(alias);
  return (
    <form
      className="flex flex-wrap items-start gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!problem) {
          act.mutate(
            { device: `id:${device.device_id}`, alias: alias.trim().toLowerCase() },
            {
              onSuccess: (d) => {
                onRenamed?.(d.alias);
                onDone?.();
              },
            },
          );
        }
      }}
    >
      <div className="flex flex-col">
        <Input value={alias} onChange={(e) => setAlias(e.target.value)} aria-label="alias" maxLength={31} autoFocus />
        {problem && alias !== device.alias ? <span className="text-xs text-bad">{problem}</span> : null}
      </div>
      <Button type="submit" tone="primary" disabled={!!problem || alias.trim().toLowerCase() === device.alias || act.isPending}>
        Rename
      </Button>
      {onDone ? (
        <Button tone="ghost" onClick={onDone}>
          Cancel
        </Button>
      ) : null}
    </form>
  );
}

export function TagsForm({ device }: { device: Pick<DeviceView, 'device_id' | 'tags'> }) {
  const [edit, setEdit] = useState('');
  const act = useAct('device_update', { done: () => 'tags updated', refresh: ['device_list', 'device_get'] });
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (edit.trim()) {
          act.mutate({ device: `id:${device.device_id}`, tag: edit.trim() }, { onSuccess: () => setEdit('') });
        }
      }}
    >
      {device.tags.length ? device.tags.map((t) => <Badge key={t}>{t}</Badge>) : <span className="text-xs text-muted">no tags</span>}
      <Input value={edit} onChange={(e) => setEdit(e.target.value)} placeholder="+tag,-old" aria-label="tag edits" className="w-32" />
      <Button type="submit" disabled={!edit.trim() || act.isPending}>
        Apply
      </Button>
    </form>
  );
}

/** device_list's `live` (hub registry/ops.ts, design m2-c2 D16): this hub run's view of the device's link. */
export interface LiveLink {
  /** Links with a session, best first. */
  links: string[];
  udp_blocked: boolean;
  /** The last HEARTBEAT's RSSI to the AP (0: not on Wi-Fi) and uptime; null before one. */
  rssi_ap: number | null;
  uptime_s: number | null;
  fw_id_prefix: string | null;
}

/** A device_list row's `live`; null before the device's first HELLO this hub run (or from a hub without it). */
export function liveOf(device: DeviceView): LiveLink | null {
  const live = (device as { live?: unknown }).live;
  return live && typeof live === 'object' && Array.isArray((live as LiveLink).links) ? (live as LiveLink) : null;
}

/** One device on the grid, from its device_list row alone. */
export function DeviceTile({ device }: { device: DeviceView }) {
  const now = useNow(1000);
  const flashing = useFlash(device.device_id);
  const last = useLive((s) => s.lastByDevice[device.device_id]);
  // RSSI, uptime and links are this hub run's (the row's `live`), not the registry row's.
  const live = liveOf(device);
  const [renaming, setRenaming] = useState(false);
  return (
    <article
      className="tile flex flex-col gap-2 rounded-lg border border-line bg-panel p-3"
      data-device={device.alias}
      data-device-id={device.device_id}
      data-presence={device.presence}
      {...(flashing ? { 'data-flash': '' } : {})}
    >
      <header className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Dot tone={presenceTone(device.presence)} />
          {renaming ? (
            <RenameForm device={device} onDone={() => setRenaming(false)} />
          ) : (
            <Link to="/device/$alias" params={{ alias: device.alias }} className="truncate font-semibold hover:underline">
              {device.alias}
            </Link>
          )}
        </div>
        <Badge tone={presenceTone(device.presence)}>{device.presence}</Badge>
      </header>
      <p className="text-xs text-muted">
        {[device.board, device.profile, device.chip].filter(Boolean).join(' · ') || 'not provisioned'}
        {device.provisioned ? '' : ' · seen only'}
      </p>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs">
        <dt className="text-muted">firmware</dt>
        <dd className="font-mono">{short(device.fw_id ?? live?.fw_id_prefix)}</dd>
        <dt className="text-muted">RSSI</dt>
        <dd>{live?.rssi_ap != null && live.rssi_ap !== 0 ? `${live.rssi_ap} dBm` : '–'}</dd>
        <dt className="text-muted">uptime</dt>
        <dd>{live?.uptime_s != null ? span(live.uptime_s * 1000) : '–'}</dd>
        <dt className="text-muted">links</dt>
        <dd>
          {live?.links.length ? live.links.join(', ') : '–'}
          {live?.udp_blocked ? <Badge tone="warn">udp blocked</Badge> : null}
        </dd>
        <dt className="text-muted">USB</dt>
        <dd className="truncate" title={device.port}>
          {device.port ? `${device.port.replace('/dev/cu.', '')} (${device.port_state ?? '?'})` : '–'}
        </dd>
      </dl>
      <p className="truncate text-xs" data-last-event={last?.type ?? ''}>
        <span className="text-muted">last </span>
        {last ? (
          <>
            <span className="font-mono">{last.type}</span> <span className="text-muted">{agoUs(last.t_hub_us, now)}</span>
          </>
        ) : (
          '–'
        )}
      </p>
      <footer className="flex flex-wrap gap-2">
        <IdentifyButton device={device} />
        {!renaming ? (
          <Button tone="ghost" onClick={() => setRenaming(true)}>
            Rename
          </Button>
        ) : null}
        {device.tags.map((t) => (
          <Badge key={t}>{t}</Badge>
        ))}
      </footer>
    </article>
  );
}
