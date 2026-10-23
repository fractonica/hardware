// The M1 demo page (spec 11 §11.5 steps 3-5, design c6 §4.4, D16), served by the hub at /apps/demo/: an
// @fractonica/sdk app typed by devices.ts (`fr codegen client --out web/demo/src/fractonica`); the hub
// injects the token. It shows the boot.* events of both pads, relays pad-c6's press to pad-c3's LED at app
// level with the press -> RESULT latency and its rolling p50/p99, broadcasts "ping", and shows presence and
// the socket's round trip. Every received event and relay is a row with data-* attributes, so a headless
// check can read the page.

import { connect, type AnyEvent, type Hub, type InstanceMap } from '@fractonica/sdk';

import { devices } from './fractonica/devices.ts';
import { Relay } from './relay.ts';
import './style.css';

/** Rows kept per list. */
const MAX_ROWS = 50;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function row(list: HTMLElement, cells: string[], data: Record<string, string>): void {
  const li = document.createElement('li');
  for (const [k, v] of Object.entries(data)) {
    li.dataset[k] = v;
  }
  for (const c of cells) {
    const span = document.createElement('span');
    span.textContent = c;
    li.append(span);
  }
  li.className = 'flash';
  list.prepend(li);
  while (list.children.length > MAX_ROWS) {
    list.lastElementChild!.remove();
  }
}

const clock = () => new Date().toLocaleTimeString([], { hour12: false });
const ms = (v: number) => `${v.toFixed(1)} ms`;

function setOutput(id: string, value: number | null): void {
  const o = $<HTMLOutputElement>(id);
  o.textContent = value === null ? '–' : ms(value);
  o.dataset.ms = value === null ? '' : value.toFixed(2);
}

function showError(text: string): void {
  const p = $('error');
  p.textContent = text;
  p.hidden = false;
}

function renderChips(hub: Hub<typeof devices>): void {
  const chips = $('chips');
  chips.replaceChildren(
    ...hub.devices
      .all()
      .sort((a, b) => a.alias.localeCompare(b.alias))
      .map((d) => {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.dataset.device = d.alias;
        chip.dataset.presence = d.presence;
        chip.title = `${d.id} · ${d.profile ?? 'unknown profile'} · ${d.presence}`;
        chip.textContent = d.alias;
        return chip;
      }),
  );
}

async function main(): Promise<void> {
  const hub = await connect({ registry: devices });
  const padC6 = hub.devices.byAlias('pad-c6');
  const padC3 = hub.devices.byAlias('pad-c3');
  document.body.dataset.connected = 'true';
  $('conn').textContent = 'connected';
  hub.on('connected', () => {
    document.body.dataset.connected = 'true';
    $('conn').textContent = 'connected';
    renderChips(hub);
  });
  hub.on('disconnected', (d) => {
    document.body.dataset.connected = 'false';
    $('conn').textContent = `reconnecting (${d.code})`;
  });
  hub.on('error', (e) => console.warn(e));

  // Presence.
  renderChips(hub);
  for (const type of ['device.online', 'device.suspect', 'device.offline'] as const) {
    hub.on(type, () => renderChips(hub));
  }
  hub.devices.on('added', () => renderChips(hub));
  hub.on('registry.drift', () => renderChips(hub));

  // Step 3: boot.down, then boot.click, from either pad.
  const events = $('events');
  const log = <M extends InstanceMap>(e: AnyEvent<M>) => {
    const d = e.device;
    if (e.part !== 'event') {
      return; // boot.pressed changes: the mirror, not the log
    }
    const extra = Object.entries(e)
      .filter(([k]) => !['part', 'type', 'device', 'inst', 'tDevUs', 'tHubUs', 'late', 'epoch', 'cursor', 'replayed'].includes(k))
      .map(([k, v]) => `${k}=${String(v)}`);
    row(events, [clock(), d.alias, e.type, ...extra, e.late ? 'late' : '', e.replayed ? 'replayed' : ''].filter(Boolean), {
      type: e.type,
      device: d.alias,
      late: String(e.late),
      cursor: e.cursor,
      tHubUs: String(e.tHubUs),
    });
  };
  padC6.on('boot.*', log);
  padC3.on('boot.*', log);

  // Step 4: the relay at app level, press -> RESULT on the hub's clock. Replayed presses (missed while the
  // socket was down) are in the event log, tagged, but neither blink nor count (relay.ts).
  const list = $('relay');
  const relay = new Relay(
    () => padC3.status.blink({ count: 1 }),
    (o) => {
      if (!o.ok) {
        row(list, [clock(), o.status, o.message], { ok: 'false', status: o.status, cursor: o.cursor });
        return;
      }
      setOutput('relay-last', o.ms);
      setOutput('relay-p50', o.p50);
      setOutput('relay-p99', o.p99);
      $('relay-n').textContent = String(o.n);
      row(list, [clock(), ms(o.ms), o.link ?? ''], { relayMs: o.ms.toFixed(2), ok: 'true', cursor: o.cursor });
    },
  );
  padC6.on('boot.down', (e) => relay.press(e));

  // Step 5: broadcast "ping" (pads bound to msg:ping blink; ESP-NOW carries it to one without a hub link).
  const button = $<HTMLButtonElement>('broadcast');
  const result = $<HTMLOutputElement>('broadcast-result');
  button.disabled = false;
  button.addEventListener('click', () => {
    button.disabled = true;
    hub.broadcast.msg('ping').then(
      (b) => {
        result.textContent = `seq ${b.seq} → ${b.sessions} node session${b.sessions === 1 ? '' : 's'}, ${b.seeded ? 'ESP-NOW flood seeded' : 'hub links only (over the flood rate)'}`;
        Object.assign(result.dataset, { seq: String(b.seq), sessions: String(b.sessions), seeded: String(b.seeded), ok: 'true' });
      },
      (err: unknown) => {
        result.textContent = `failed: ${err instanceof Error ? err.message : String(err)}`;
        Object.assign(result.dataset, { ok: 'false' });
      },
    ).finally(() => (button.disabled = false));
  });

  // The socket's own round trip (hub.stats), once a second.
  setInterval(() => {
    const rtt = hub.stats().rttMs;
    const o = $<HTMLOutputElement>('rtt');
    o.textContent = rtt === null ? '–' : ms(rtt);
    o.dataset.rttMs = rtt === null ? '' : rtt.toFixed(2);
  }, 1000);
}

main().catch((e: unknown) => {
  $('conn').textContent = 'not connected';
  showError(`${e instanceof Error ? e.message : String(e)}. Open this page from the hub: http://127.0.0.1:7420/apps/demo/`);
});
