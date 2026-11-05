// WIRING-1's bench app (design wiring-w1 D4), served by the hub at /apps/bench/.
// - Guides: the list with progress; a guide's page: safety first, the check banner when its pin table disagrees with
//   the profile, the parts (have / missing), each section with its diagram beside its steps (a checkbox per step, saved
//   at once: wiring_step / wiring_undo), the pins as chips with the device's live values when it is online
//   (device_get every 5 s), the full pin table.
// - Parts: the catalogue by category with a search; a part's page with specs, pins, notes, datasheets, stock (edit:
//   part_stock) and the guides that use it.
// - Shopping: what the unfinished guides need, minus what is on hand.
// Everything goes over POST /api/v1/op (./ops.ts); diagrams are fetched from the hub and inlined, sanitised.

import type { PartList, PartShow, WiringList, WiringShopping, WiringShow } from '@fractonica/protocol/browser';

import { instanceLive, missingText, nextStep, parseRoute, pinInstances, progressPct, routeHash, sanitizeSvg, type Route } from './format.ts';
import { createOps, errText } from './ops.ts';
import './style.css';

const LIVE_EVERY_MS = 5000;
const ops = createOps();
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: (Node | string | null)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') {
      e.className = v;
    } else {
      e.setAttribute(k, v);
    }
  }
  e.append(...children.filter((c): c is Node | string => c !== null));
  return e;
}

const store = (key: string, value?: string): string | null => {
  try {
    if (value === undefined) {
      return localStorage.getItem(`fr-bench.${key}`);
    }
    localStorage.setItem(`fr-bench.${key}`, value);
  } catch {
    // private window, blocked storage
  }
  return null;
};

function showError(text: string | null): void {
  const p = $('error');
  p.textContent = text ?? '';
  p.hidden = !text;
}

const THEMES = ['auto', 'light', 'dark'] as const;
function applyTheme(t: string): void {
  if (t === 'light' || t === 'dark') {
    document.documentElement.dataset.theme = t;
  } else {
    delete document.documentElement.dataset.theme;
  }
  $('theme').textContent = t;
}

/** Diagram SVG text by URL (a guide's page re-renders on every tick). */
const svgCache = new Map<string, Promise<string>>();
function diagramSvg(url: string): Promise<string> {
  let p = svgCache.get(url);
  if (!p) {
    p = fetch(url).then(async (r) => {
      if (!r.ok) {
        throw new Error(`HTTP ${r.status}`);
      }
      return sanitizeSvg(await r.text());
    });
    p.catch(() => svgCache.delete(url));
    svgCache.set(url, p);
  }
  return p;
}

function diagramFigure(d: { title: string; url: string }): HTMLElement {
  const box = el('div', { class: 'diagram', title: 'click to enlarge' });
  const fig = el('figure', { class: 'figure' }, box, el('figcaption', {}, d.title));
  diagramSvg(d.url)
    .then((svg) => {
      box.innerHTML = svg;
    })
    .catch((e: unknown) => {
      box.textContent = `diagram not loaded: ${errText(e)}`;
    });
  fig.addEventListener('click', () => fig.classList.toggle('big'));
  return fig;
}

// ---- views ----

let liveTimer: ReturnType<typeof setInterval> | null = null;
let renderSeq = 0;

function setNav(route: Route): void {
  const v = route.view === 'guide' ? 'guides' : route.view === 'part' ? 'parts' : route.view;
  for (const a of document.querySelectorAll<HTMLAnchorElement>('.nav a')) {
    a.classList.toggle('active', a.dataset.view === v);
  }
}

async function renderGuides(main: HTMLElement): Promise<void> {
  const r = await ops.op<WiringList>('wiring_list', {});
  const list = el('section', { class: 'cards' });
  for (const g of r.guides) {
    const pct = progressPct(g.done, g.steps);
    list.append(
      el(
        'a',
        { class: `card guide-card${g.check === 'failed' ? ' failed' : ''}`, href: routeHash({ view: 'guide', id: g.id }) },
        el('h2', {}, g.title),
        el('p', { class: 'hint' }, g.summary),
        el('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': String(pct), 'aria-valuemin': '0', 'aria-valuemax': '100' }, el('span', { style: `width:${pct}%` })),
        el(
          'p',
          { class: 'meta' },
          `${g.done} / ${g.steps} steps`,
          g.device ? el('span', { class: 'pill' }, g.device) : null,
          el('span', { class: `pill ${g.check === 'failed' ? 'bad' : g.check === 'ok' ? 'on' : ''}` }, g.check === 'failed' ? 'pin table disagrees' : g.check === 'ok' ? (g.warnings.length ? `checked, ${g.warnings.length} warning(s)` : 'checked') : 'not checked'),
        ),
      ),
    );
  }
  if (!r.guides.length) {
    list.append(el('p', { class: 'hint' }, 'No wiring guides yet: they live in hardware/wiring/<id>/guide.yaml (design wiring-w1).'));
  }
  main.append(el('h2', { class: 'page-title' }, 'Wiring guides'), list, refusedBox(r.refused));
}

function refusedBox(refused: { file: string; errors: string[] }[]): HTMLElement {
  const box = el('section', { class: 'refused' });
  if (!refused.length) {
    box.hidden = true;
    return box;
  }
  box.append(el('h3', {}, 'Files the hub refused'));
  for (const r of refused) {
    box.append(el('p', {}, el('code', {}, r.file)), el('ul', {}, ...r.errors.map((e) => el('li', {}, e))));
  }
  return box;
}

async function renderGuide(main: HTMLElement, id: string, seq: number): Promise<void> {
  const g = await ops.op<WiringShow>('wiring_show', { guide: id });
  if (seq !== renderSeq) {
    return;
  }
  const pinInst = pinInstances(g.connections);
  const liveChips = new Map<string, HTMLElement[]>(); // instance -> chips to fill
  const pct = progressPct(g.done, g.steps);

  const head = el(
    'section',
    { class: 'guide-head' },
    el('p', {}, el('a', { href: '#/guides' }, '← all guides')),
    el('h2', { class: 'page-title' }, g.title),
    el('p', {}, g.summary),
    el(
      'p',
      { class: 'meta' },
      g.board ? el('span', { class: 'pill' }, `board ${g.board}`) : null,
      g.profile ? el('span', { class: 'pill' }, `profile ${g.profile}`) : null,
      g.device ? el('span', { class: 'pill', id: 'device-pill' }, `${g.device}: …`) : null,
      g.design ? el('span', { class: 'pill' }, g.design) : null,
    ),
    el('div', { class: 'progress big', role: 'progressbar', 'aria-valuenow': String(pct), 'aria-valuemin': '0', 'aria-valuemax': '100' }, el('span', { style: `width:${pct}%` })),
    el('p', { class: 'meta' }, `${g.done} / ${g.steps} steps done`),
  );
  const next = nextStep(g);
  if (next) {
    const a = el('a', { href: `#step-${next.step}` }, 'next step');
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      document.getElementById(`step-${next.step}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    head.querySelector('.meta:last-child')?.append(' · ', a);
  }
  const reset = el('button', { type: 'button', class: 'ghost' }, 'start over');
  reset.addEventListener('click', async () => {
    if (!confirm(`Clear every step of ${g.title}?`)) {
      return;
    }
    await act(() => ops.op('wiring_reset', { guide: g.id }));
  });
  head.append(reset);
  main.append(head);

  if (g.check === 'failed' || g.warnings.length) {
    main.append(
      el(
        'section',
        { class: `banner ${g.check === 'failed' ? 'bad' : 'warn'}` },
        el('strong', {}, g.check === 'failed' ? 'This guide disagrees with its firmware profile: fix the guide or the profile before wiring.' : 'Check the warnings below.'),
        el('ul', {}, ...g.errors.map((e) => el('li', {}, e)), ...g.warnings.map((w) => el('li', { class: 'warn-item' }, w))),
      ),
    );
  }
  if (g.safety.length) {
    main.append(el('section', { class: 'safety' }, el('h3', {}, 'Safety'), el('ul', {}, ...g.safety.map((s) => el('li', {}, s)))));
  }

  if (g.bom.length) {
    const short = missingText(g.bom);
    const rows = g.bom.map((b) =>
      el(
        'tr',
        { class: b.missing > 0 ? 'short' : '' },
        el('td', {}, String(b.qty)),
        el('td', {}, el('a', { href: routeHash({ view: 'part', id: b.part }) }, b.name), b.value ? ` ${b.value}` : ''),
        el('td', {}, String(b.have)),
        el('td', {}, b.missing > 0 ? String(b.missing) : '–'),
        el('td', { class: 'hint' }, b.note ?? ''),
      ),
    );
    main.append(
      el(
        'section',
        { class: 'card' },
        el('h3', {}, 'Parts', el('small', {}, short.length ? ` · short: ${short.join(', ')}` : ' · all on hand (as recorded)')),
        el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Qty'), el('th', {}, 'Part'), el('th', {}, 'Have'), el('th', {}, 'Missing'), el('th', {}, ''))), el('tbody', {}, ...rows)),
      ),
    );
  }

  const diagrams = new Map(g.diagrams.map((d) => [d.id, d]));
  for (const s of g.sections) {
    const done = s.steps.filter((st) => st.done).length;
    const steps = el('ol', { class: 'steps' });
    for (const st of s.steps) {
      const box = el('input', { type: 'checkbox', id: `cb-${st.id}` });
      box.checked = st.done;
      box.addEventListener('change', async () => {
        box.disabled = true;
        await act(() => ops.op(box.checked ? 'wiring_step' : 'wiring_undo', { guide: g.id, steps: [st.id] }));
      });
      const pins = el('span', { class: 'pins' });
      for (const p of st.pins) {
        const chip = el('span', { class: 'chip' }, p);
        const inst = pinInst.get(p);
        if (inst) {
          chip.title = inst;
          liveChips.set(inst, [...(liveChips.get(inst) ?? []), chip]);
        }
        pins.append(chip);
      }
      steps.append(
        el(
          'li',
          { id: `step-${st.id}`, class: st.done ? 'done' : '' },
          el('label', { for: `cb-${st.id}` }, box, el('span', { class: 'step-text' }, st.text)),
          st.pins.length ? pins : null,
          st.note ? el('p', { class: 'note' }, st.note) : null,
          st.check ? el('p', { class: 'check' }, el('strong', {}, 'Check: '), st.check) : null,
          st.diagram && diagrams.has(st.diagram) ? diagramFigure(diagrams.get(st.diagram)!) : null,
        ),
      );
    }
    const body = el('div', { class: `section-body${s.diagram ? ' with-diagram' : ''}` });
    if (s.diagram && diagrams.has(s.diagram)) {
      body.append(diagramFigure(diagrams.get(s.diagram)!));
    }
    body.append(el('div', {}, s.intro ? el('p', { class: 'intro' }, s.intro) : null, steps));
    main.append(el('section', { class: `card section${done === s.steps.length ? ' complete' : ''}`, id: `sec-${s.id}` }, el('h3', {}, s.title, el('small', {}, ` · ${done} / ${s.steps.length}`)), body));
  }

  if (g.connections.length) {
    const MARK: Record<string, string> = { ok: '✓', warning: '!', failed: '✗', unchecked: '·' };
    const rows = g.connections.map((c) =>
      el(
        'tr',
        { class: `conn-${c.check}` },
        el('td', { class: 'mark', title: c.check }, MARK[c.check] ?? '·'),
        el('td', {}, el('code', {}, c.pin)),
        el('td', {}, c.instance ? `${c.instance}${c.bind ? `.${c.bind}` : ''}` : ''),
        el('td', {}, c.to, c.via ? el('span', { class: 'hint' }, ` via ${c.via}`) : null),
        el('td', { class: 'hint' }, c.message ?? ''),
      ),
    );
    main.append(
      el(
        'section',
        { class: 'card' },
        el('h3', {}, 'Pin table', el('small', {}, g.profile ? ` · checked against ${g.profile}` : ' · no profile to check against')),
        el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, ''), el('th', {}, 'Pin'), el('th', {}, 'Instance'), el('th', {}, 'Goes to'), el('th', {}, ''))), el('tbody', {}, ...rows)),
      ),
    );
  }

  // The device's live state beside the pins (device_get; a guide without a device has none).
  if (g.device) {
    const tick = async () => {
      try {
        const d = await ops.op<{ alias: string; presence: string; router: { properties: Record<string, unknown> } | null }>('device_get', { device: g.device });
        const pill = document.getElementById('device-pill');
        if (pill) {
          pill.textContent = `${d.alias}: ${d.presence}`;
          pill.className = `pill ${d.presence === 'online' ? 'on' : d.presence === 'suspect' ? 'warn' : ''}`;
        }
        for (const [inst, chips] of liveChips) {
          const live = instanceLive(d.router?.properties, inst);
          for (const c of chips) {
            c.dataset.live = live.length ? `${inst}: ${live.join(', ')}` : inst;
            c.title = c.dataset.live;
            c.classList.toggle('live', d.presence === 'online' && live.length > 0);
          }
        }
      } catch {
        const pill = document.getElementById('device-pill');
        if (pill) {
          pill.textContent = `${g.device}: unknown`;
        }
      }
    };
    void tick();
    liveTimer = setInterval(() => void tick(), LIVE_EVERY_MS);
  }
}

async function renderParts(main: HTMLElement, seq: number): Promise<void> {
  const r = await ops.op<PartList>('part_list', {});
  if (seq !== renderSeq) {
    return;
  }
  const search = el('input', { type: 'search', placeholder: 'search parts', value: store('q') ?? '', 'aria-label': 'Search parts' });
  const grid = el('div', {});
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    store('q', search.value);
    grid.replaceChildren();
    const shown = r.parts.filter((p) => !q || p.id.includes(q) || p.name.toLowerCase().includes(q) || p.summary.toLowerCase().includes(q));
    const cats = [...new Set(shown.map((p) => p.category))];
    for (const c of cats) {
      grid.append(
        el('h3', { class: 'cat' }, c),
        el(
          'div',
          { class: 'cards' },
          ...shown
            .filter((p) => p.category === c)
            .map((p) =>
              el(
                'a',
                { class: 'card part-card', href: routeHash({ view: 'part', id: p.id }) },
                p.image ? el('img', { src: p.image, alt: '', loading: 'lazy' }) : null,
                el('h2', {}, p.name),
                el('p', { class: 'hint' }, p.summary),
                el('p', { class: 'meta' }, el('span', { class: `pill ${p.have > 0 ? 'on' : ''}` }, `have ${p.have}`), p.values.length ? el('span', { class: 'hint' }, ` ${p.values.join(', ')}`) : null),
              ),
            ),
        ),
      );
    }
    if (!shown.length) {
      grid.append(el('p', { class: 'hint' }, r.parts.length ? 'No part matches.' : 'No parts yet: they live in hardware/parts/<id>.part.yaml (design wiring-w1).'));
    }
  };
  search.addEventListener('input', draw);
  draw();
  main.append(el('h2', { class: 'page-title' }, 'Parts'), el('p', {}, search), grid, refusedBox(r.refused));
}

async function renderPart(main: HTMLElement, id: string, seq: number): Promise<void> {
  const p = await ops.op<PartShow>('part_show', { part: id });
  if (seq !== renderSeq) {
    return;
  }
  const inferred = new Set(p.inferred);
  main.append(
    el('p', {}, el('a', { href: '#/parts' }, '← all parts')),
    el('h2', { class: 'page-title' }, p.name, el('small', {}, ` · ${p.category} · ${p.id}`)),
    el('p', {}, p.summary),
  );
  if (p.image) {
    main.append(el('img', { class: 'part-image', src: p.image, alt: p.name }));
  }
  const specs = Object.entries(p.specs);
  if (specs.length) {
    main.append(
      el(
        'section',
        { class: 'card' },
        el('h3', {}, 'Specs'),
        el('table', {}, el('tbody', {}, ...specs.map(([k, v]) => el('tr', {}, el('th', {}, k), el('td', {}, v, inferred.has(k) ? el('span', { class: 'pill warn', title: 'not read in a datasheet or on the bench' }, 'inferred') : null))))),
      ),
    );
  }
  if (p.pins.length || p.pinout) {
    main.append(
      el(
        'section',
        { class: 'card' },
        el('h3', {}, 'Pins'),
        p.pinout ? el('p', { class: 'check' }, el('strong', {}, 'Pinout: '), p.pinout) : null,
        p.pins.length ? el('table', {}, el('tbody', {}, ...p.pins.map((x) => el('tr', {}, el('th', {}, x.name), el('td', {}, x.desc ?? ''))))) : null,
      ),
    );
  }
  if (p.notes.length) {
    main.append(el('section', { class: 'card' }, el('h3', {}, 'Notes'), el('ul', {}, ...p.notes.map((n) => el('li', {}, n)))));
  }
  if (p.datasheets.length) {
    main.append(el('section', { class: 'card' }, el('h3', {}, 'Datasheets'), el('ul', {}, ...p.datasheets.map((d) => el('li', {}, el('a', { href: d, target: '_blank', rel: 'noopener noreferrer' }, d))))));
  }

  // Stock: the rows, and a form to set one.
  const qty = el('input', { type: 'number', min: '0', step: '1', value: '0', 'aria-label': 'Quantity' });
  const loc = el('input', { type: 'text', placeholder: 'where (drawer, box)', 'aria-label': 'Location' });
  const value = el('select', { 'aria-label': 'Value' }, ...p.values.map((v) => el('option', { value: v }, v)));
  const fill = () => {
    const row = p.stock.find((s) => (s.value ?? '') === (p.values.length ? value.value : ''));
    qty.value = String(row?.qty ?? 0);
    loc.value = row?.location ?? '';
  };
  value.addEventListener('change', fill);
  fill();
  const save = el('button', { type: 'button', class: 'primary' }, 'Save');
  save.addEventListener('click', async () => {
    const n = Number(qty.value);
    if (!Number.isInteger(n) || n < 0) {
      showError('Enter a whole number of parts, 0 or more.');
      return;
    }
    await act(() => ops.op('part_stock', { part: p.id, qty: n, ...(p.values.length ? { value: value.value } : {}), ...(loc.value.trim() ? { location: loc.value.trim() } : {}) }));
  });
  main.append(
    el(
      'section',
      { class: 'card' },
      el('h3', {}, 'On hand'),
      p.stock.length
        ? el('ul', {}, ...p.stock.map((s) => el('li', {}, `${s.value ? `${s.value}: ` : ''}${s.qty}${s.location ? ` in ${s.location}` : ''}${s.note ? ` (${s.note})` : ''}`)))
        : el('p', { class: 'hint' }, 'None recorded.'),
      el('div', { class: 'actions' }, p.values.length ? value : null, qty, loc, save),
    ),
  );
  if (p.used_by.length) {
    main.append(
      el(
        'section',
        { class: 'card' },
        el('h3', {}, 'Used by'),
        el('ul', {}, ...p.used_by.map((u) => el('li', {}, el('a', { href: routeHash({ view: 'guide', id: u.guide }) }, u.title), ` · ${u.qty}${u.value ? ` × ${u.value}` : ''}`))),
      ),
    );
  }
}

async function renderShopping(main: HTMLElement, seq: number): Promise<void> {
  const r = await ops.op<WiringShopping>('wiring_shopping', {});
  if (seq !== renderSeq) {
    return;
  }
  main.append(el('h2', { class: 'page-title' }, 'Shopping list'), el('p', { class: 'hint' }, r.guides.length ? `For the unfinished guides: ${r.guides.join(', ')}.` : 'Every guide is finished.'));
  if (!r.lines.length) {
    return;
  }
  const rows = r.lines.map((l) =>
    el(
      'tr',
      { class: l.missing > 0 ? 'short' : '' },
      el('td', {}, l.missing > 0 ? String(l.missing) : '–'),
      el('td', {}, el('a', { href: routeHash({ view: 'part', id: l.part }) }, l.name), l.value ? ` ${l.value}` : ''),
      el('td', {}, String(l.need)),
      el('td', {}, String(l.have)),
      el('td', { class: 'hint' }, l.guides.join(', ')),
    ),
  );
  main.append(el('section', { class: 'card' }, el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Buy'), el('th', {}, 'Part'), el('th', {}, 'Need'), el('th', {}, 'Have'), el('th', {}, 'For'))), el('tbody', {}, ...rows))));
}

/** Runs an action, shows its error, then draws the view again (the hub has the state). */
async function act(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    showError(null);
  } catch (e) {
    showError(errText(e));
  }
  await render(false);
}

async function render(top = true): Promise<void> {
  if (liveTimer) {
    clearInterval(liveTimer);
    liveTimer = null;
  }
  const seq = ++renderSeq;
  const route = parseRoute(location.hash);
  setNav(route);
  const main = $('main');
  const y = window.scrollY;
  const next = el('div', {});
  try {
    switch (route.view) {
      case 'guides':
        await renderGuides(next);
        break;
      case 'guide':
        await renderGuide(next, route.id, seq);
        break;
      case 'parts':
        await renderParts(next, seq);
        break;
      case 'part':
        await renderPart(next, route.id, seq);
        break;
      case 'shopping':
        await renderShopping(next, seq);
        break;
    }
    if (seq === renderSeq) {
      showError(null);
    }
  } catch (e) {
    if (seq === renderSeq) {
      showError(errText(e));
    }
  }
  if (seq !== renderSeq) {
    return;
  }
  main.replaceChildren(...next.childNodes);
  window.scrollTo(0, top ? 0 : y);
}

function boot(): void {
  applyTheme(store('theme') ?? 'auto');
  $('theme').addEventListener('click', () => {
    const t = THEMES[(THEMES.indexOf(($('theme').textContent ?? 'auto') as (typeof THEMES)[number]) + 1) % THEMES.length];
    store('theme', t);
    applyTheme(t);
  });
  $('reload').addEventListener('click', async () => {
    svgCache.clear();
    await act(() => ops.op('wiring_reload', {}));
  });
  window.addEventListener('hashchange', () => void render());
  if (!location.hash) {
    history.replaceState(null, '', routeHash({ view: 'guides' }));
  }
  void render();
}

boot();
