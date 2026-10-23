// What the dashboard tells a person without being asked (spec 08 §8.9, design c6 D3 and §5): toasts for
// pending prompt_human requests (until the wait ends; the nav's Agents badge counts them) and for job ends,
// and the banners above every page: the hub not answering, `/ws` reconnecting, a dashboard built for
// another op registry, a stale build, the lid warning, and the hub's own warnings.

import { useState, type ReactNode } from 'react';

import type { Prompt } from '@fractonica/protocol/browser';

import type { OpError } from '../api/rest.ts';
import type { HubStatusView } from '../api/types.ts';
import { useLive, useNow } from '../hooks.ts';
import { store } from '../runtime.ts';
import type { Now } from '../state/clock.ts';
import { leftMs, span } from '../state/format.ts';
import { pendingPrompts, type Tone } from '../state/live.ts';

const TOAST_TONE: Record<Tone, string> = {
  ok: 'border-ok/50',
  info: 'border-accent/50',
  warn: 'border-warn/60',
  bad: 'border-bad/60',
};

function PromptToast({ p, now }: { p: Prompt; now: Now }) {
  return (
    <div className="rounded-lg border-2 border-warn bg-panel p-3 shadow-lg" role="alert" data-prompt={p.prompt_id}>
      <p className="text-xs font-semibold tracking-wide text-warn uppercase">Action needed</p>
      <p className="mt-1 text-base font-semibold">{p.text}</p>
      <p className="mt-1 text-xs text-muted">
        waiting for <span className="font-mono">{p.types.join(', ')}</span>
        {p.selector ? (
          <>
            {' '}
            on <span className="font-mono">{p.selector}</span>
          </>
        ) : null}{' '}
        · {span(leftMs(p.expires_at, now))} left
      </p>
    </div>
  );
}

/** The toast stack: prompts first (they stay until answered), then job ends and action results. */
export function Toasts() {
  const now = useNow(1000);
  const prompts = useLive((s) => s.prompts);
  const toasts = useLive((s) => s.toasts);
  const pending = pendingPrompts({ prompts }, now);
  if (!pending.length && !toasts.length) {
    return null;
  }
  return (
    <div className="fixed right-4 bottom-4 z-50 flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2">
      {pending.map((p) => (
        <PromptToast key={p.prompt_id} p={p} now={now} />
      ))}
      {toasts.slice(-5).map((t) => (
        <div key={t.id} className={`flex items-start gap-2 rounded-lg border bg-panel p-3 shadow-lg ${TOAST_TONE[t.tone]}`} data-toast={t.tone} data-job={t.job_id}>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">{t.title}</p>
            {t.body ? <p className="mt-0.5 text-xs break-words text-muted">{t.body}</p> : null}
          </div>
          <button type="button" className="text-muted hover:text-fg" aria-label="dismiss" onClick={() => store.getState().dismiss(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

function Banner({ tone, children, id }: { tone: 'warn' | 'bad' | 'info'; children: ReactNode; id: string }) {
  const c = tone === 'bad' ? 'border-bad/40 bg-bad/10' : tone === 'warn' ? 'border-warn/40 bg-warn/10' : 'border-accent/40 bg-accent/10';
  return (
    <div className={`rounded border px-3 py-2 text-sm ${c}`} data-banner={id}>
      {children}
    </div>
  );
}

/** The dashboard's build-time op registry hash (vite.config.ts), to compare with the hub's hello. */
declare const __FR_REGISTRY_HASH__: string | undefined;
const BUILT_FOR = typeof __FR_REGISTRY_HASH__ === 'string' ? __FR_REGISTRY_HASH__ : undefined;

export function Banners({ status, statusError }: { status: HubStatusView | undefined; statusError: OpError | null }) {
  const conn = useLive((s) => s.conn);
  const [showWarnings, setShowWarnings] = useState(false);
  const out: ReactNode[] = [];
  if (statusError?.code === 'HUB_UNREACHABLE') {
    out.push(
      <Banner key="down" id="hub-down" tone="bad">
        The hub at {location.host} does not answer. Start it with <code className="font-mono">fr hub start</code>; this page reconnects by itself.
      </Banner>,
    );
  } else if (conn.status === 'closed' && conn.attempts > 1) {
    out.push(
      <Banner key="ws" id="ws-down" tone="warn">
        Live updates are reconnecting{conn.retryInMs ? ` (next try in ${span(conn.retryInMs)})` : ''}; what the pages show may be behind.
      </Banner>,
    );
  }
  const hubHash = conn.hello?.registry_hash ?? status?.registry_hash;
  if (BUILT_FOR && hubHash && hubHash !== BUILT_FOR) {
    out.push(
      <Banner key="hash" id="registry-mismatch" tone="warn">
        This dashboard was built for op registry {BUILT_FOR}, the hub runs {hubHash}: rebuild it (<code className="font-mono">fr doctor --fix</code>) or restart the hub.
      </Banner>,
    );
  }
  if (status?.dashboard?.stale) {
    out.push(
      <Banner key="stale" id="dashboard-stale" tone="info">
        The dashboard build is older than its source: <code className="font-mono">fr doctor --fix</code> rebuilds it.
      </Banner>,
    );
  }
  if (status?.sleep_guard?.active) {
    out.push(
      <Banner key="lid" id="lid" tone="info">
        The hub keeps this Mac awake while it works, but closing the lid still puts it to sleep.
      </Banner>,
    );
  }
  const warnings = status?.warnings ?? [];
  if (warnings.length) {
    out.push(
      <Banner key="warnings" id="warnings" tone="warn">
        <button type="button" className="font-medium" onClick={() => setShowWarnings((v) => !v)}>
          {warnings.length} hub warning{warnings.length > 1 ? 's' : ''} {showWarnings ? '▾' : '▸'}
        </button>
        {showWarnings ? (
          <ul className="mt-1 list-disc pl-5">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        ) : (
          <span className="text-muted"> — {warnings[0]}</span>
        )}
      </Banner>,
    );
  }
  return out.length ? <div className="flex flex-col gap-2">{out}</div> : null;
}
