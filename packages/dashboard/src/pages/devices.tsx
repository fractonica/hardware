// Devices (`#/`, spec 08 §8.9): the online/offline grid by alias, with board, firmware, RSSI, uptime and
// the last event of each, and identify / rename. A tile flashes on input (11.5 step 3). device_list is
// refetched on device.*, registry.* and port.* events, and every 10 s; it is the grid's only query (design m2-c2
// D16): each row carries what its tile shows of the link (`live`), so a device.* event at 30 nodes costs one
// device_list, not 30 device_gets.

import { Link } from '@tanstack/react-router';

import type { DeviceView } from '@fractonica/protocol/browser';

import { DeviceTile } from '../components/device.tsx';
import { Empty, ErrorBox } from '../components/ui.tsx';
import { useOp } from '../hooks.ts';

const PRESENCE_ORDER: Record<string, number> = { online: 0, suspect: 1, offline: 2, unknown: 3 };

function byPresenceThenAlias(a: DeviceView, b: DeviceView): number {
  return (PRESENCE_ORDER[a.presence] ?? 9) - (PRESENCE_ORDER[b.presence] ?? 9) || a.alias.localeCompare(b.alias);
}

export function DevicesPage() {
  const q = useOp('device_list', {}, { refetchInterval: 10_000 });
  const devices = (q.data?.devices ?? []).slice().sort(byPresenceThenAlias);
  const online = devices.filter((d) => d.presence === 'online').length;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-lg font-semibold">Devices</h1>
        {q.data ? (
          <p className="text-sm text-muted" data-count={devices.length}>
            {online} of {devices.length} online{q.data.truncated ? ` (first ${devices.length} of ${q.data.count})` : ''}
          </p>
        ) : null}
      </div>
      <ErrorBox error={q.error} what="device_list" />
      {q.data && !devices.length ? (
        <Empty>
          No devices yet. Plug a board in and provision it on the <Link to="/ports" className="underline">Ports</Link> page.
        </Empty>
      ) : null}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-3" data-grid="devices">
        {devices.map((d) => (
          <DeviceTile key={d.device_id} device={d} />
        ))}
      </div>
    </div>
  );
}
