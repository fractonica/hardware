// Display helpers shared by the pages: times, durations, sizes and the short forms of ids.

import type { PortInfo } from '@fractonica/protocol/browser';

import type { Now } from './clock.ts';

/** "12 s ago", "3 min ago", "2 h ago"; "now" under a second; "in 5 s" for a future time. */
export function ago(ms: number, now: number): string {
  const d = now - ms;
  if (d < 0) {
    return `in ${span(-d)}`;
  }
  return d < 1000 ? 'now' : `${span(d)} ago`;
}

/** ago() of an ISO time the hub answered (its wall clock: created_at, built_at, expires_at, …). */
export function agoIso(iso: string, now: Now): string {
  return ago(Date.parse(iso), now.wall);
}

/** ago() of a hub µs time (an event's t_hub_us), by hub time. */
export function agoUs(tHubUs: number, now: Now): string {
  return ago(tHubUs / 1000, now.hub);
}

/** ms left until an ISO time the hub answered (an expires_at), 0 once it passed. */
export function leftMs(iso: string, now: Now): number {
  return Math.max(0, Date.parse(iso) - now.wall);
}

/** 950 ms, 12 s, 3 min, 2 h 5 min, 3 d 4 h. */
export function span(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)} ms`;
  }
  const s = Math.floor(ms / 1000);
  if (s < 60) {
    return `${s} s`;
  }
  const m = Math.floor(s / 60);
  if (m < 60) {
    return `${m} min`;
  }
  const h = Math.floor(m / 60);
  if (h < 24) {
    return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  }
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

/** An event's hub time (µs since the epoch) as local HH:MM:SS.mmm. */
export function clock(tHubUs: number): string {
  const d = new Date(tHubUs / 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** 812 B, 1.4 KB, 1.2 MB. */
export function bytes(n: number): string {
  if (n < 1024) {
    return `${n} B`;
  }
  return n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** A latency in ms with sensible precision; "–" for none. */
export function ms(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) {
    return '–';
  }
  return v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : String(Math.round(v));
}

/** The first `n` characters of a fw_id or hash. */
export function short(id: string | null | undefined, n = 8): string {
  return id ? id.slice(0, n) : '–';
}

/** Who holds a port, for people: the hub, a lease (with its pid), a job, or the external programs. */
export function portHolder(p: PortInfo): string {
  if (p.lease) {
    const pid = p.lease.holder_pid !== undefined ? ` (pid ${p.lease.holder_pid})` : '';
    return `lease ${p.lease.lease_id}${pid}`;
  }
  if (p.external?.length) {
    return p.external.map((h) => `${h.app} (pid ${h.pid})`).join(', ');
  }
  if (p.holder) {
    return p.holder;
  }
  return p.state === 'open' ? 'hub' : '–';
}

/**
 * Device output made safe for xterm: colour (SGR) sequences pass, a lone ESC shows as ␛ (no cursor moves,
 * titles or other terminal commands), other control characters go, C1 ones too (xterm reads U+009B as
 * CSI); each line is written with writeln.
 */
export function termSafe(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m|[\x00-\x08\x0a-\x1f\x7f-\x9f]/g, (m) => (m.length > 1 ? m : m === '\x1b' ? '␛' : ''));
}

/** The JSON of event fields or a result on one line, cut at `max` characters. */
export function brief(v: unknown, max = 160): string {
  if (v === undefined) {
    return '';
  }
  let s: string;
  try {
    s = JSON.stringify(v) ?? '';
  } catch {
    s = String(v);
  }
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
