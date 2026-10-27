// The Devices grid at 30 devices (design m2-c2 D16, stream S3): the tiles render from one device_list, each row's
// `live` giving the tile its links, RSSI and uptime, with no device_get per tile (before, a device.* event made 30
// tiles each run device_get, each O(N) at the hub). Rendered to a string with the runtime's QueryClient seeded
// with the list: every query a component asks for is in the cache after the render, fetched or not.

import { QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { DeviceView } from '@fractonica/protocol/browser';

// The grid's links need no router here: a plain anchor per tile.
vi.mock('@tanstack/react-router', async () => {
  const react = await import('react');
  return {
    Link: ({ children, params }: { children?: ReactNode; params?: { alias?: string } }) => react.createElement('a', { href: `#/device/${params?.alias ?? ''}` }, children),
  };
});

type Runtime = typeof import('../src/runtime.ts');
type Page = typeof import('../src/pages/devices.tsx');
type Tile = typeof import('../src/components/device.tsx');

let runtime: Runtime;
let page: Page;
let tile: Tile;

beforeAll(async () => {
  // runtime.ts builds its /ws URL from the page's location at import.
  (globalThis as { location?: unknown }).location ??= { protocol: 'http:', host: '127.0.0.1:7420' };
  runtime = await import('../src/runtime.ts');
  page = await import('../src/pages/devices.tsx');
  tile = await import('../src/components/device.tsx');
});

const N = 30;

function row(i: number): DeviceView & { live: unknown } {
  const id = `02f20000${(0x100 + i).toString(16).slice(1).padStart(4, '0')}`;
  return {
    device_id: id,
    addr: i,
    alias: `sim-${String(i).padStart(2, '0')}`,
    alias_rev: 1,
    net: 1,
    board: 'esp32c6-supermini',
    profile: 'c6-pad',
    chip: 'esp32c6',
    tags: [],
    role: 'node',
    fw_id: null,
    provisioned: true,
    last_seen: null,
    last_epoch: null,
    created_at: '2026-10-26T00:00:00.000Z',
    presence: i === N ? 'offline' : 'online',
    ...(i === 7 ? { port: '/dev/cu.sim-07', port_state: 'open' as const } : {}),
    // As the hub's device_list gives it (registry/ops.ts): null before the device's first HELLO this run.
    live:
      i === N
        ? null
        : { links: i === 7 ? ['tcp', 'serial'] : ['tcp'], udp_blocked: i === 3, rssi_ap: -40 - i, uptime_s: 3600 + i, fw_id_prefix: `3f2a9c01b2d4e5${String(i).padStart(2, '0')}` },
  };
}

describe('the Devices grid (design m2-c2 D16)', () => {
  it('renders 30 tiles from one device_list, with no device_get per tile', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { queryClient } = runtime;
    queryClient.clear();
    const devices = Array.from({ length: N }, (_, k) => row(k + 1));
    queryClient.setQueryData(['device_list', {}], { devices, count: N, truncated: false });
    const html = renderToString(createElement(QueryClientProvider, { client: queryClient }, createElement(page.DevicesPage)));
    vi.unstubAllGlobals();

    expect(html.match(/ data-device="/g)).toHaveLength(N);
    expect(html).toContain(`data-count="${N}"`);
    // Each tile's link figures came from its row: RSSI, uptime, links (best first), udp_blocked, firmware.
    expect(html).toContain('-47 dBm');
    expect(html).toContain('tcp, serial');
    expect(html.match(/udp blocked/g)).toHaveLength(1);
    expect(html).toContain('>3f2a9c01<'); // the prefix, shortened as the tile shows a firmware
    // The only query any component asked for: the list. Nothing fetched while rendering.
    const keys = queryClient.getQueryCache().getAll().map((q) => q.queryKey);
    expect(keys).toEqual([['device_list', {}]]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reads a row's live summary, and none from a row without one (a device not seen this run, or an older hub)", () => {
    const seen = row(1);
    expect(tile.liveOf(seen)).toEqual(seen.live);
    expect(tile.liveOf(row(N))).toBeNull();
    const { live: _l, ...older } = seen;
    expect(tile.liveOf(older as DeviceView)).toBeNull();
    expect(tile.liveOf({ ...older, live: { links: 'tcp' } } as unknown as DeviceView)).toBeNull();
  });
});
