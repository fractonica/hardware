// Small building blocks shared by the pages: panels, badges, buttons, form fields, key/value lists and the
// error box that shows a hub error with what to do.

import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

import { OpError, opMissing, remedies } from '../api/rest.ts';

export type BadgeTone = 'ok' | 'warn' | 'bad' | 'info' | 'muted';

const BADGE: Record<BadgeTone, string> = {
  ok: 'bg-ok/15 text-ok',
  warn: 'bg-warn/15 text-warn',
  bad: 'bg-bad/15 text-bad',
  info: 'bg-accent/15 text-accent',
  muted: 'bg-sunk text-muted',
};

export function Badge({ tone = 'muted', children, title }: { tone?: BadgeTone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium whitespace-nowrap ${BADGE[tone]}`}>
      {children}
    </span>
  );
}

/** A presence (online, suspect, offline, unknown) as a badge tone. */
export function presenceTone(p: string | undefined): BadgeTone {
  return p === 'online' ? 'ok' : p === 'suspect' ? 'warn' : p === 'offline' ? 'bad' : 'muted';
}

/** A job status as a badge tone. */
export function statusTone(s: string | undefined): BadgeTone {
  return s === 'completed' ? 'ok' : s === 'failed' ? 'bad' : s === 'cancelled' ? 'warn' : s === 'working' ? 'info' : 'muted';
}

export function Dot({ tone }: { tone: BadgeTone }) {
  const c = { ok: 'bg-ok', warn: 'bg-warn', bad: 'bg-bad', info: 'bg-accent', muted: 'bg-muted' }[tone];
  return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${c}`} />;
}

type ButtonTone = 'default' | 'primary' | 'danger' | 'ghost';

const BUTTON: Record<ButtonTone, string> = {
  default: 'border-line bg-panel hover:bg-sunk',
  primary: 'border-accent bg-accent text-white hover:brightness-110',
  danger: 'border-bad/50 bg-panel text-bad hover:bg-bad/10',
  ghost: 'border-transparent hover:bg-sunk',
};

export function Button({ tone = 'default', className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: ButtonTone }) {
  return (
    <button
      type="button"
      className={`inline-flex items-center gap-1 rounded border px-2.5 py-1 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${BUTTON[tone]} ${className}`}
      {...props}
    />
  );
}

export function Panel({ title, actions, children, className = '' }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg border border-line bg-panel ${className}`}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5">
          <h2 className="text-sm font-semibold">{title}</h2>
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium">{label}</span>
      {children}
      {error ? <span className="text-xs text-bad">{error}</span> : hint ? <span className="text-xs text-muted">{hint}</span> : null}
    </label>
  );
}

export function Input({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`rounded border border-line bg-bg px-2 py-1 font-mono text-sm outline-none focus:border-accent ${className}`} {...props} />;
}

export function Select({ value, onChange, options, className = '' }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; className?: string }) {
  return (
    <select className={`rounded border border-line bg-bg px-2 py-1 text-sm outline-none focus:border-accent ${className}`} value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function KV({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
      {items.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-3 text-sm text-muted">{children}</p>;
}

export function Mono({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <span className={`font-mono text-xs ${className}`}>{children}</span>;
}

export function Json({ value }: { value: unknown }) {
  return <pre className="max-h-80 overflow-auto rounded bg-sunk p-2 font-mono text-xs">{JSON.stringify(value, null, 2)}</pre>;
}

/** A failed op: its code and message, what to do, or that this hub does not have the op yet. */
export function ErrorBox({ error, what }: { error: unknown; what?: string }) {
  if (!error) {
    return null;
  }
  const e = error instanceof OpError ? error : new OpError({ code: 'INTERNAL', message: String(error), retryable: false });
  if (opMissing(e)) {
    return <p className="rounded border border-line bg-sunk px-3 py-2 text-sm text-muted">{what ? `${what} is not` : 'Not'} available on this hub yet.</p>;
  }
  const steps = remedies(e);
  return (
    <div className="rounded border border-bad/40 bg-bad/5 px-3 py-2 text-sm" role="alert" data-error={e.code}>
      <p>
        <span className="font-semibold text-bad">{e.code}</span> {what ? `${what}: ` : ''}
        {e.message}
      </p>
      {steps.length > 0 && (
        <ul className="mt-1 list-disc pl-5 text-muted">
          {steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A thin progress bar; an unknown percentage pulses. */
export function Progress({ pct }: { pct?: number }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded bg-sunk">
      <div className={`h-full bg-accent ${pct === undefined ? 'w-1/3 animate-pulse' : ''}`} style={pct === undefined ? undefined : { width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </div>
  );
}

export function Table({ head, children }: { head: ReactNode[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-muted">
          <tr>
            {head.map((h, i) => (
              <th key={i} className="border-b border-line px-2 py-1.5 font-medium whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="[&>tr]:border-b [&>tr]:border-line/60 [&_td]:px-2 [&_td]:py-1.5 [&_td]:align-top">{children}</tbody>
      </table>
    </div>
  );
}
