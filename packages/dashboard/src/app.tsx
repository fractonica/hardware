// The dashboard's routes and frame (spec 08 §8.9, design c6 §5): TanStack Router on a hash history, so the
// hub serves one index.html and needs no SPA fallback (D10). Every page sits under the shell: the nav, the
// hub's state (polled hub_status every 5 s, the `/ws` connection), the banners and the toasts.

import { createHashHistory, createRootRoute, createRoute, createRouter, Link, Outlet } from '@tanstack/react-router';
import { useEffect } from 'react';

import { Banners, Toasts } from './components/feedback.tsx';
import { Badge, Dot, type BadgeTone } from './components/ui.tsx';
import { useLive, useOp } from './hooks.ts';
import { AgentsPage } from './pages/agents.tsx';
import { BuildsPage } from './pages/builds.tsx';
import { DevicePage } from './pages/device.tsx';
import { DevicesPage } from './pages/devices.tsx';
import { LivePage } from './pages/live.tsx';
import { NetworkPage } from './pages/network.tsx';
import { PortsPage } from './pages/ports.tsx';
import { hubClock, store } from './runtime.ts';
import { span } from './state/format.ts';

const NAV = [
  ['/', 'Devices'],
  ['/live', 'Live'],
  ['/ports', 'Ports'],
  ['/builds', 'Builds'],
  ['/network', 'Network'],
  ['/agents', 'Agents'],
] as const;

const CONN_TONE: Record<string, BadgeTone> = { open: 'ok', connecting: 'warn', closed: 'bad', idle: 'muted', stopped: 'muted' };

function Shell() {
  const status = useOp('hub_status', {}, { refetchInterval: 5000 });
  const conn = useLive((s) => s.conn);
  const prompts = useLive((s) => Object.keys(s.prompts).length);
  // hub_status.prompts is the hub's own list of pending prompts (D3).
  useEffect(() => {
    if (status.data?.prompts) {
      store.getState().reconcilePrompts(status.data.prompts, hubClock.now());
    }
  }, [status.data]);
  const s = status.data;
  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-40 border-b border-line bg-panel/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2">
          <span className="font-semibold tracking-tight">Fractonica</span>
          <nav className="flex flex-wrap gap-1 text-sm">
            {NAV.map(([to, label]) => (
              <Link
                key={to}
                to={to}
                className="rounded px-2 py-1 text-muted hover:bg-sunk hover:text-fg"
                activeProps={{ className: 'bg-sunk !text-fg font-medium' }}
                activeOptions={{ exact: to === '/' }}
              >
                {label}
                {to === '/agents' && prompts ? (
                  <>
                    {' '}
                    <Badge tone="warn">{prompts}</Badge>
                  </>
                ) : null}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex flex-wrap items-center gap-3 text-xs text-muted">
            {s ? (
              <>
                <span title={`registry ${s.registry_hash}, pid ${s.pid}`}>
                  hub {s.version} · run {s.run} · up {span(s.uptime_s * 1000)}
                </span>
                <span>
                  {s.devices.online}/{s.devices.registered} online
                </span>
                {s.lnp && s.lnp !== 'allowed' ? <Badge tone={s.lnp === 'denied' ? 'bad' : 'muted'}>LNP {s.lnp}</Badge> : null}
              </>
            ) : null}
            <span className="flex items-center gap-1" title={`live updates: ${conn.status}`} data-conn={conn.status}>
              <Dot tone={CONN_TONE[conn.status] ?? 'muted'} /> live
            </span>
          </div>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-4 px-4 py-4">
        <Banners status={s} statusError={status.error} />
        <Outlet />
      </main>
      <Toasts />
    </div>
  );
}

const root = createRootRoute({ component: Shell });

const routeTree = root.addChildren([
  createRoute({ getParentRoute: () => root, path: '/', component: DevicesPage }),
  createRoute({ getParentRoute: () => root, path: '/live', component: LivePage }),
  createRoute({ getParentRoute: () => root, path: '/device/$alias', component: DevicePage }),
  createRoute({ getParentRoute: () => root, path: '/ports', component: PortsPage }),
  createRoute({ getParentRoute: () => root, path: '/builds', component: BuildsPage }),
  createRoute({ getParentRoute: () => root, path: '/network', component: NetworkPage }),
  createRoute({ getParentRoute: () => root, path: '/agents', component: AgentsPage }),
]);

export const router = createRouter({ routeTree, history: createHashHistory(), defaultPreload: false });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
