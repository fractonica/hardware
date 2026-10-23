// Live (`#/live`, spec 08 §8.9): the event stream, newest first, filtered by type globs and a selector,
// with pause (new events wait, counted) and a jump to a cursor (events_read after it, oldest first).
// Rows carry data-type (design c6 §5). The list is virtual; the stream is the live store's ring.

import { useVirtualizer } from '@tanstack/react-virtual';
import { useMemo, useRef, useState, type CSSProperties } from 'react';

import type { HubEvent } from '@fractonica/protocol/browser';

import { OpError } from '../api/rest.ts';
import { Badge, Button, ErrorBox, Input } from '../components/ui.tsx';
import { useLive, useOp } from '../hooks.ts';
import { rest } from '../runtime.ts';
import { brief, clock } from '../state/format.ts';
import { eventFilter } from '../state/match.ts';

interface History {
  from: string;
  events: HubEvent[];
  next: string;
  truncated: boolean;
}

export function EventRow({ e, style }: { e: HubEvent; style?: CSSProperties }) {
  return (
    <div
      className="grid grid-cols-[6.5rem_8rem_minmax(10rem,14rem)_1fr_6rem] items-center gap-3 border-b border-line/60 px-3 font-mono text-xs"
      style={style}
      data-type={e.type}
      data-device={e.alias ?? ''}
      data-cursor={e.cursor}
    >
      <span className="text-muted">{clock(e.t_hub_us)}</span>
      <span className="truncate font-sans font-medium">{e.alias ?? e.device ?? 'hub'}</span>
      <span className="flex items-center gap-1 truncate">
        {e.type}
        {e.late ? <Badge tone="warn">late</Badge> : null}
        {e.replayed ? <Badge>replayed</Badge> : null}
      </span>
      <span className="truncate text-muted" title={brief(e.fields, 2000)}>
        {e.fields && Object.keys(e.fields).length ? brief(e.fields) : ''}
      </span>
      <span className="truncate text-right text-muted">{e.cursor}</span>
    </div>
  );
}

export function LivePage() {
  const ring = useLive((s) => s.events);
  const [draft, setDraft] = useState({ types: '', selector: '' });
  const [filter, setFilter] = useState({ types: '', selector: '' });
  const [pausedAt, setPausedAt] = useState<number | null>(null);
  const [history, setHistory] = useState<History | null>(null);
  const [jump, setJump] = useState('');
  const [jumpError, setJumpError] = useState<unknown>(null);
  // The selector is the hub's grammar (tag:, chip:, ...): it resolves it to devices.
  const sel = useOp('device_list', { selector: filter.selector }, { enabled: filter.selector !== '' });
  const devices = useMemo(() => (filter.selector && sel.data ? new Set(sel.data.devices.map((d) => d.device_id)) : undefined), [filter.selector, sel.data]);
  const keep = useMemo(() => eventFilter({ types: filter.types, devices: filter.selector ? (devices ?? new Set()) : undefined }), [filter, devices]);

  const shown = useMemo(() => {
    if (history) {
      return history.events.filter(keep);
    }
    const out: HubEvent[] = [];
    for (let i = ring.length - 1; i >= 0; i--) {
      const e = ring[i]!;
      if ((pausedAt === null || e.seq <= pausedAt) && keep(e)) {
        out.push(e);
      }
    }
    return out;
  }, [ring, history, keep, pausedAt]);
  const waiting = useMemo(() => (pausedAt === null ? 0 : ring.filter((e) => e.seq > pausedAt && keep(e)).length), [ring, pausedAt, keep]);

  const scroller = useRef<HTMLDivElement>(null);
  const rows = useVirtualizer({ count: shown.length, getScrollElement: () => scroller.current, estimateSize: () => 28, overscan: 20 });

  const readFrom = async (since: string, append: boolean) => {
    setJumpError(null);
    try {
      const page = await rest.op('events_read', {
        since,
        max_events: 1000,
        ...(filter.types ? { types: filter.types } : {}),
        ...(filter.selector ? { selector: filter.selector } : {}),
      });
      setHistory((h) => ({ from: append && h ? h.from : since, events: append && h ? [...h.events, ...page.events] : page.events, next: page.next_cursor, truncated: page.truncated }));
    } catch (err) {
      setJumpError(err instanceof OpError ? err : String(err));
    }
  };

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-lg font-semibold">Live</h1>
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setFilter({ types: draft.types.trim(), selector: draft.selector.trim() });
          }}
        >
          <Input placeholder="types, e.g. boot.*,device.*" value={draft.types} onChange={(e) => setDraft({ ...draft, types: e.target.value })} aria-label="types" className="w-56" />
          <Input placeholder="selector, e.g. pad-c6 or tag:poc" value={draft.selector} onChange={(e) => setDraft({ ...draft, selector: e.target.value })} aria-label="selector" className="w-56" />
          <Button type="submit">Filter</Button>
          {history ? (
            <Button tone="primary" onClick={() => setHistory(null)}>
              Back to live
            </Button>
          ) : (
            <Button tone={pausedAt === null ? 'default' : 'primary'} data-action="pause" onClick={() => setPausedAt((p) => (p === null ? (ring.at(-1)?.seq ?? -1) : null))}>
              {pausedAt === null ? 'Pause' : `Resume${waiting ? ` (${waiting} new)` : ''}`}
            </Button>
          )}
        </form>
      </div>
      <form
        className="flex flex-wrap items-center gap-2 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          if (jump.trim()) {
            void readFrom(jump.trim(), false);
          }
        }}
      >
        <span className="text-muted">Jump to cursor</span>
        <Input placeholder="c:<run>.<seq>" value={jump} onChange={(e) => setJump(e.target.value)} aria-label="cursor" className="w-40" />
        <Button type="submit" disabled={!jump.trim()}>
          Read after it
        </Button>
        {history ? (
          <span className="text-muted">
            {history.events.length} events after {history.from}, oldest first
            {history.truncated ? (
              <>
                {' '}
                ·{' '}
                <button type="button" className="underline" onClick={() => void readFrom(history.next, true)}>
                  load more
                </button>
              </>
            ) : null}
          </span>
        ) : (
          <span className="text-muted">{shown.length} shown · the newest 2,000 are kept</span>
        )}
      </form>
      <ErrorBox error={jumpError} what="events_read" />
      <ErrorBox error={sel.error} what="selector" />
      <div ref={scroller} className="min-h-80 flex-1 overflow-auto rounded-lg border border-line bg-panel" data-list="live">
        <div style={{ height: rows.getTotalSize(), position: 'relative' }}>
          {rows.getVirtualItems().map((v) => (
            <EventRow key={shown[v.index]!.cursor} e={shown[v.index]!} style={{ position: 'absolute', top: 0, left: 0, right: 0, height: v.size, transform: `translateY(${v.start}px)` }} />
          ))}
        </div>
      </div>
    </div>
  );
}
