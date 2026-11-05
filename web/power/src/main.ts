// POWER-1's power app (design power-p1 D11), served by the hub at /apps/power/.
// - One card per fr.battery instance of the fleet (battery_status every 10 s and after each charger or level change,
//   for the cell, the build's traits and the learned estimates): the voltage live from its STATEs, the bar (the learned
//   percent when a capacity test exists, else the node's), the charger and level pills, the time to full or to low, a
//   plot of the last hour, Calibrate (a multimeter reading), the test load switch (traits.test_load), and a capacity test
//   (cell_test, a hub job: progress and Cancel).
// - Haptics: every fr.haptic instance (buzz and kick on scale-c6), a level slider, Pulse, Stop, the patterns of
//   ./patterns.ts and a typed one; the supply's voltage while it runs and its lowest during the last pulse.
// - Events: the boards' charge, level_change, protect and cut events as they come.
// - Registered cells: cell_list as a table, Add, Install in a place.
// The /app socket (presence, properties, events) is the SDK's connect(); the ops go over POST /api/v1/op (./ops.ts).

import { connect, type AnyDevice, type AnyEvent, type Hub } from '@fractonica/sdk';
import type { BatteryRow, BatteryStatus, Cell, CellList, CellTest, Job } from '@fractonica/protocol/browser';

import { chargerText, estimateText, fillPercent, formatDuration, formatVolts, jobText, levelText, parseMeterMv } from './format.ts';
import { createOps, errText, TERMINAL_JOB_STATUSES, type JobRun } from './ops.ts';
import { parseSteps, PATTERNS, patternMs } from './patterns.ts';
import { plotPoints, Series, yRange } from './series.ts';
import './style.css';

const BATTERY = 'fr.battery';
const HAPTIC = 'fr.haptic';
const STATUS_EVERY_MS = 10_000;
const WINDOW_MS = 3_600_000;
const EVENTS_KEPT = 40;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') {
      e.className = v;
    } else {
      e.setAttribute(k, v);
    }
  }
  e.append(...children);
  return e;
}

const store = (key: string, value?: string): string | null => {
  try {
    if (value === undefined) {
      return localStorage.getItem(`fr-power.${key}`);
    }
    localStorage.setItem(`fr-power.${key}`, value);
  } catch {
    // private window, blocked storage: the defaults then
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

/** An enum value from the socket (its name; a number from an older catalog) as its name. */
const enumName = (v: unknown, names: readonly string[]): string | null => (typeof v === 'string' ? v : typeof v === 'number' ? (names[v] ?? null) : null);
const CHARGERS = ['none', 'unplugged', 'charging', 'charged', 'no_cell', 'fault'] as const;
const LEVELS = ['ok', 'low', 'critical', 'empty'] as const;

/** One fr.battery place's card. */
interface Card {
  key: string;
  device: AnyDevice;
  inst: string;
  row: BatteryRow | null;
  live: { mv: number | null; charger: string | null; level: string | null; load: boolean | null; percent: number | null };
  series: Series;
  root: HTMLElement;
  els: Record<'title' | 'cell' | 'charger' | 'level' | 'volts' | 'fill' | 'percent' | 'estimate' | 'msg' | 'job', HTMLElement> & {
    canvas: HTMLCanvasElement;
    meter: HTMLInputElement;
    calibrate: HTMLButtonElement;
    load: HTMLButtonElement;
    test: HTMLButtonElement;
    cancel: HTMLButtonElement;
  };
  test: JobRun<CellTest> | null;
  /** A test this page did not start (running when it loaded), followed by job id. */
  follow: string | null;
  off: (() => void)[];
}

async function main(): Promise<void> {
  applyTheme(store('theme') ?? 'auto');
  $('theme').addEventListener('click', () => {
    const t = THEMES[(THEMES.indexOf(($('theme').textContent ?? 'auto') as (typeof THEMES)[number]) + 1) % THEMES.length];
    store('theme', t);
    applyTheme(t);
  });

  const ops = createOps();
  const hub: Hub = await connect({
    subscribe: { types: ['*.mv', '*.percent', '*.charger', '*.level', '*.load_on', '*.gate_open', '*.charge', '*.level_change', '*.protect', '*.active', '*.supply_mv', '*.cut', 'presence'] },
  });
  const setConn = (on: boolean, text: string) => {
    document.body.dataset.connected = String(on);
    $('conn').textContent = text;
  };
  setConn(true, 'connected');
  hub.on('connected', () => {
    setConn(true, 'connected');
    refreshPlaces();
    void refreshStatus();
  });
  hub.on('disconnected', (d) => setConn(false, `reconnecting (${d.code})`));
  hub.on('error', (e) => console.warn(e));

  // ---- events ----

  function logEvent(text: string): void {
    const ul = $('events');
    const at = new Date().toLocaleTimeString();
    ul.prepend(el('li', {}, `${at}  ${text}`));
    while (ul.children.length > EVENTS_KEPT) {
      ul.lastElementChild?.remove();
    }
  }

  // ---- the battery cards ----

  const cards = new Map<string, Card>();

  function makeCard(device: AnyDevice, inst: string): Card {
    const title = el('h2', {});
    const cellName = el('small', {});
    title.append(cellName);
    const charger = el('span', { class: 'pill' }, '–');
    const level = el('span', { class: 'pill' });
    const volts = el('div', { class: 'volts', 'data-mv': '' }, '–');
    const fill = el('span', { style: 'width: 0%' });
    const percent = el('span', { class: 'hint' });
    const estimate = el('p', { class: 'hint' });
    const canvas = el('canvas', { class: 'plot', width: '600', height: '140' });
    const meter = el('input', { type: 'text', inputmode: 'decimal', placeholder: '3.912' });
    const calibrate = el('button', { type: 'button', title: 'battery_calibrate: the divider from a multimeter reading on the cell' }, 'Calibrate');
    const load = el('button', { type: 'button', title: 'battery_load: the test load for 10 min, or off' }, 'Test load on');
    const test = el('button', { type: 'button', class: 'primary', title: 'cell_test: a capacity test through the test load' }, 'Capacity test');
    const cancel = el('button', { type: 'button', class: 'danger', hidden: '' }, 'Cancel test');
    const msg = el('p', { class: 'hint' });
    const job = el('p', { class: 'hint' });
    const root = el(
      'section',
      { class: 'card battery-card', 'data-level': 'ok' },
      el('div', { class: 'card-head' }, title, el('span', {}, charger, ' ', level)),
      volts,
      el('div', { class: 'bar-meter' }, fill),
      percent,
      estimate,
      canvas,
      el('div', { class: 'actions' }, el('label', { class: 'field' }, el('span', {}, 'Meter (V)'), meter), calibrate, load),
      el('div', { class: 'actions' }, test, cancel),
      job,
      msg,
    );
    const c: Card = {
      key: `${device.id}/${inst}`,
      device,
      inst,
      row: null,
      live: { mv: null, charger: null, level: null, load: null, percent: null },
      series: new Series(WINDOW_MS),
      root,
      els: { title, cell: cellName, charger, level, volts, fill, percent, estimate, msg, job, canvas, meter, calibrate, load, test, cancel },
      test: null,
      follow: null,
      off: [],
    };
    calibrate.addEventListener('click', () => void onCalibrate(c));
    load.addEventListener('click', () => void onLoad(c));
    test.addEventListener('click', () => onTest(c));
    cancel.addEventListener('click', () => {
      const job = c.test ? null : (c.follow ?? c.row?.test_job ?? null);
      const p = c.test ? c.test.cancel() : job ? ops.op('job_cancel', { job_id: job }).then(() => undefined) : Promise.resolve();
      void p.catch((e: unknown) => (c.els.msg.textContent = errText(e)));
    });
    subscribeCard(c);
    return c;
  }

  function subscribeCard(c: Card): void {
    const d = c.device;
    const prop = (name: string, fn: (v: unknown) => void) => {
      const v = d.raw.state[c.inst]?.[name];
      if (v !== undefined) {
        fn(v);
      }
      c.off.push(
        d.on(`${c.inst}.${name}`, (e: AnyEvent) => {
          if (e.part === 'state') {
            fn(e.value);
          }
        }),
      );
    };
    prop('mv', (v) => {
      if (typeof v === 'number') {
        c.live.mv = v;
        c.series.push(Date.now(), v);
        renderCard(c);
      }
    });
    prop('percent', (v) => {
      c.live.percent = typeof v === 'number' ? v : null;
      renderCard(c);
    });
    prop('charger', (v) => {
      c.live.charger = enumName(v, CHARGERS);
      renderCard(c);
    });
    prop('level', (v) => {
      c.live.level = enumName(v, LEVELS);
      renderCard(c);
    });
    prop('load_on', (v) => {
      c.live.load = v === true;
      renderCard(c);
    });
    const ev = (name: string, text: (f: Record<string, unknown>) => string) =>
      c.off.push(
        d.on(`${c.inst}.${name}`, (e: AnyEvent) => {
          if (e.part !== 'state') {
            logEvent(`${d.alias} ${c.inst}: ${text(e as unknown as Record<string, unknown>)}`);
            scheduleStatus();
          }
        }),
      );
    ev('charge', (f) => `${chargerText(enumName(f.state, CHARGERS))} at ${formatVolts(f.mv as number)} V`);
    ev('level_change', (f) => `level ${enumName(f.level, LEVELS) ?? '?'} at ${formatVolts(f.mv as number)} V`);
    ev('protect', (f) => `protect (${String(f.reason)}) at ${formatVolts(f.mv as number)} V: loads cut`);
  }

  function renderCard(c: Card): void {
    const r = c.row;
    const e = c.els;
    const mv = c.live.mv ?? r?.mv ?? null;
    const charger = c.live.charger ?? r?.charger ?? null;
    const level = c.live.level ?? r?.level ?? 'ok';
    const load = c.live.load ?? r?.load_on ?? false;
    e.title.firstChild?.remove();
    e.title.prepend(`${c.device.alias} ${c.inst} `);
    e.cell.textContent = r?.cell ? `${r.cell.name} (${r.cell.chemistry})` : r?.chemistry ? `${r.chemistry}, no cell registered` : '';
    e.charger.textContent = chargerText(charger);
    e.charger.dataset.charger = charger ?? '';
    e.level.textContent = levelText(level) || 'ok';
    e.level.dataset.level = level;
    c.root.dataset.level = level;
    e.volts.textContent = '';
    e.volts.append(formatVolts(mv), el('small', {}, ' V'));
    e.volts.dataset.mv = mv === null ? '' : String(mv);
    const learned = r?.estimate.percent_learned ?? null;
    const pct = fillPercent(learned, c.live.percent ?? r?.percent);
    e.fill.style.width = `${pct}%`;
    e.percent.textContent = learned !== null ? `${learned} % (from the cell's capacity test)` : typeof (c.live.percent ?? r?.percent) === 'number' ? `${pct} % (the node's table)` : '';
    e.estimate.textContent = estimateText(r?.estimate, charger, Boolean(r?.cell));
    const testLoad = r?.traits ? r.traits.test_load : true;
    e.load.hidden = !testLoad;
    e.load.textContent = load ? 'Test load off' : 'Test load on';
    e.load.classList.toggle('danger', load);
    const testing = c.test !== null || Boolean(r?.test_job);
    // A capacity test owns the test load (battery_load is refused while it runs).
    e.load.disabled = testing;
    e.load.title = testing ? 'a capacity test owns the test load' : 'battery_load: the test load for 10 min, or off';
    e.test.disabled = !r?.cell || testing;
    e.test.title = r?.cell ? (testLoad ? 'cell_test: a capacity test through the test load' : 'cell_test via a haptic that draws from this cell (no test load wired)') : 'install a registered cell here first';
    e.cancel.hidden = !testing;
    if (c.test === null && r?.test_job && c.follow !== r.test_job) {
      followTest(c, r.test_job);
    }
    drawPlot(c);
  }

  function drawPlot(c: Card): void {
    const cv = c.els.canvas;
    const w = cv.clientWidth || 600;
    const h = cv.clientHeight || 140;
    if (cv.width !== w || cv.height !== h) {
      cv.width = w;
      cv.height = h;
    }
    const ctx = cv.getContext('2d');
    if (!ctx) {
      return;
    }
    ctx.clearRect(0, 0, w, h);
    const now = Date.now();
    c.series.trim(now);
    const s = c.series.samples;
    const range = yRange(s);
    if (!range) {
      return;
    }
    const css = getComputedStyle(document.documentElement);
    const th = c.row?.thresholds;
    if (th) {
      ctx.strokeStyle = css.getPropertyValue('--warn').trim() || '#c80';
      ctx.setLineDash([4, 4]);
      for (const t of [th.low_mv, th.critical_mv]) {
        if (t > range.min && t < range.max) {
          const y = h - ((t - range.min) / (range.max - range.min)) * h;
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(w, y);
          ctx.stroke();
        }
      }
      ctx.setLineDash([]);
    }
    ctx.strokeStyle = css.getPropertyValue('--accent').trim() || '#06c';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    plotPoints(s, now, WINDOW_MS, w, h, range).forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
    ctx.fillStyle = css.getPropertyValue('--muted').trim() || '#888';
    ctx.font = '11px system-ui';
    ctx.fillText(`${formatVolts(range.max)} V`, 4, 12);
    ctx.fillText(`${formatVolts(range.min)} V · last hour`, 4, h - 4);
  }

  async function onCalibrate(c: Card): Promise<void> {
    const mv = parseMeterMv(c.els.meter.value);
    if (mv === null) {
      c.els.msg.textContent = 'Type the multimeter reading on the cell (+ to GND), e.g. 3.912';
      return;
    }
    c.els.calibrate.disabled = true;
    try {
      const r = await ops.op<{ divider_milli: number; adc_mv: number }>('battery_calibrate', { device: c.device.id, instance: c.inst, meter_mv: mv });
      c.els.msg.textContent = `Calibrated to ${formatVolts(mv)} V: divider ${(r.divider_milli / 1000).toFixed(3)} (pin ${formatVolts(r.adc_mv)} V), kept across reboots`;
      c.els.meter.value = '';
    } catch (e) {
      c.els.msg.textContent = errText(e);
    } finally {
      c.els.calibrate.disabled = false;
    }
  }

  async function onLoad(c: Card): Promise<void> {
    const on = !(c.live.load ?? c.row?.load_on ?? false);
    c.els.load.disabled = true;
    try {
      await ops.op('battery_load', on ? { device: c.device.id, instance: c.inst, state: 'on', seconds: 600 } : { device: c.device.id, instance: c.inst, state: 'off' });
      c.els.msg.textContent = on ? 'Test load on for 10 min (the node switches it off at the end and at the floor)' : 'Test load off';
    } catch (e) {
      c.els.msg.textContent = errText(e);
    } finally {
      c.els.load.disabled = false;
    }
  }

  /** Progress and the end of a test this page did not start (job_wait rounds until it ends). */
  function followTest(c: Card, jobId: string): void {
    c.follow = jobId;
    void (async () => {
      try {
        for (;;) {
          const j = await ops.op<Job>('job_wait', { job_id: jobId, timeout_s: 60 });
          if (c.follow !== jobId) {
            return;
          }
          c.els.job.textContent = jobText(j);
          if (TERMINAL_JOB_STATUSES.has(j.status)) {
            break;
          }
        }
      } catch (e) {
        c.els.job.textContent = errText(e);
      }
      if (c.follow === jobId) {
        c.follow = null;
        void refreshCells();
        void refreshStatus();
      }
    })();
  }

  function onTest(c: Card): void {
    const r = c.row;
    if (!r?.cell) {
      return;
    }
    const viaHaptic = r.traits ? !r.traits.test_load : false;
    let via: string | undefined;
    if (viaHaptic) {
      // Only a haptic that draws from this cell discharges it (its build's supply; the hub checks it too).
      via = r.haptics?.[0];
      if (!via) {
        c.els.msg.textContent = 'No test load, and no haptic on this board draws from this cell';
        return;
      }
    }
    const to = r.chemistry === 'lic' || via ? 'low' : 'floor';
    if (!confirm(`Capacity test of ${r.cell.name} on ${c.device.alias} ${c.inst}: ${via ? `through ${via}` : 'through the test load'} down to ${to}. It can take hours; the charger must be unplugged when asked. Start?`)) {
      return;
    }
    c.els.msg.textContent = '';
    const run = ops.runJob<CellTest>('cell_test', { cell: r.cell.name, to, ...(via ? { via } : {}) }, { onJob: (j: Job) => (c.els.job.textContent = jobText(j)) });
    c.test = run;
    renderCard(c);
    run.done
      .then((res) => {
        c.els.job.textContent = `${res.reason}: ${res.mah !== null ? `${res.mah} mAh, ${res.wh} Wh, ` : ''}${res.r_int_mohm !== null ? `R_int ${res.r_int_mohm} mΩ, ` : ''}${formatDuration(res.duration_s)} under load, ${formatVolts(res.rest_mv)} → ${formatVolts(res.end_mv)} V`;
        void refreshCells();
      })
      .catch((e: unknown) => (c.els.job.textContent = errText(e)))
      .finally(() => {
        c.test = null;
        void refreshStatus();
      });
  }

  /** Cards for every fr.battery instance the socket knows; gone ones removed. */
  function refreshPlaces(): void {
    const want = new Set<string>();
    for (const d of hub.devices.all().sort((a, b) => a.alias.localeCompare(b.alias))) {
      for (const i of d.instances) {
        if (i.cap !== BATTERY) {
          continue;
        }
        const key = `${d.id}/${i.name}`;
        want.add(key);
        if (!cards.has(key)) {
          const c = makeCard(d, i.name);
          cards.set(key, c);
          $('cells-grid').append(c.root);
          renderCard(c);
        }
      }
    }
    for (const [key, c] of cards) {
      if (!want.has(key)) {
        c.off.forEach((f) => f());
        c.root.remove();
        cards.delete(key);
      }
    }
    $('no-cells').hidden = cards.size > 0;
    refreshHaptics();
    fillInstallPlaces();
  }

  let statusTimer: ReturnType<typeof setTimeout> | null = null;
  /** battery_status soon (coalesced): after a charger or level event the estimates change. */
  function scheduleStatus(): void {
    if (statusTimer === null) {
      statusTimer = setTimeout(() => {
        statusTimer = null;
        void refreshStatus();
      }, 300);
    }
  }

  async function refreshStatus(): Promise<void> {
    try {
      const s = await ops.op<BatteryStatus>('battery_status', {});
      for (const r of s.batteries) {
        const c = cards.get(`${r.device}/${r.instance}`);
        if (c) {
          c.row = r;
          if (r.mv !== null && c.series.samples.length === 0) {
            c.series.push(Date.now(), r.mv);
          }
          renderCard(c);
        }
      }
      showError(null);
    } catch (e) {
      showError(`battery_status: ${errText(e)}`);
    }
  }

  // ---- haptics ----

  interface HapticRef {
    device: AnyDevice;
    inst: string;
  }
  const hapticSel = $<HTMLSelectElement>('haptic');
  const levelIn = $<HTMLInputElement>('level');
  const pulseMs = $<HTMLInputElement>('pulse-ms');
  const stepsIn = $<HTMLInputElement>('steps');
  let hapticOff: (() => void)[] = [];
  const supply = { now: null as number | null, min: null as number | null, active: false };

  function hapticRefs(): HapticRef[] {
    const out: HapticRef[] = [];
    for (const d of hub.devices.all().sort((a, b) => a.alias.localeCompare(b.alias))) {
      for (const i of d.instances) {
        if (i.cap === HAPTIC) {
          out.push({ device: d, inst: i.name });
        }
      }
    }
    return out;
  }

  function selectedHaptic(): HapticRef | null {
    const [id, inst] = hapticSel.value.split('/');
    return hapticRefs().find((h) => h.device.id === id && h.inst === inst) ?? null;
  }

  function refreshHaptics(): void {
    const refs = hapticRefs();
    const prev = hapticSel.value || store('haptic') || '';
    hapticSel.replaceChildren(...refs.map((h) => el('option', { value: `${h.device.id}/${h.inst}` }, `${h.device.alias} ${h.inst}`)));
    const want = refs.find((h) => `${h.device.id}/${h.inst}` === prev) ?? refs[0];
    if (want) {
      hapticSel.value = `${want.device.id}/${want.inst}`;
    }
    bindHaptic();
  }

  function bindHaptic(): void {
    hapticOff.forEach((f) => f());
    hapticOff = [];
    const h = selectedHaptic();
    $('haptic-name').textContent = h ? `${h.device.alias} ${h.inst}` : '–';
    for (const id of ['pulse', 'stop', 'play']) {
      $<HTMLButtonElement>(id).disabled = !h;
    }
    $('patterns').querySelectorAll('button').forEach((b) => ((b as HTMLButtonElement).disabled = !h));
    if (!h) {
      return;
    }
    store('haptic', `${h.device.id}/${h.inst}`);
    hapticOff.push(
      h.device.on(`${h.inst}.active`, (e: AnyEvent) => {
        if (e.part === 'state') {
          supply.active = e.value === true;
          if (supply.active) {
            supply.min = supply.now;
          }
          renderHaptic();
        }
      }),
      h.device.on(`${h.inst}.supply_mv`, (e: AnyEvent) => {
        if (e.part === 'state' && typeof e.value === 'number') {
          supply.now = e.value;
          if (supply.active) {
            supply.min = supply.min === null ? e.value : Math.min(supply.min, e.value);
          }
          renderHaptic();
        }
      }),
      h.device.on(`${h.inst}.cut`, (e: AnyEvent) => {
        if (e.part !== 'state') {
          const f = e as unknown as Record<string, unknown>;
          const text = `cut (${String(f.reason)}) at ${formatVolts(f.supplyMv as number)} V`;
          $('haptic-msg').textContent = text;
          logEvent(`${h.device.alias} ${h.inst}: ${text}`);
        }
      }),
    );
    // The supply's voltage when idle: the haptic's supply instance is not known to the page; the cap card shows it.
    renderHaptic();
  }

  function renderHaptic(): void {
    const s = $('haptic-state');
    s.textContent = supply.active ? 'active' : 'idle';
    s.classList.toggle('on', supply.active);
    const sp = $('supply');
    sp.textContent = formatVolts(supply.now);
    sp.dataset.mv = supply.now === null ? '' : String(supply.now);
    $('supply-min').textContent = supply.min !== null ? `(lowest during the last run ${formatVolts(supply.min)} V)` : '';
  }

  async function haptic(op: 'haptic_pulse' | 'haptic_play' | 'haptic_stop', args: Record<string, unknown>, text: string): Promise<void> {
    const h = selectedHaptic();
    if (!h) {
      return;
    }
    try {
      await ops.op(op, { device: h.device.id, instance: h.inst, ...args });
      $('haptic-msg').textContent = text;
    } catch (e) {
      $('haptic-msg').textContent = errText(e);
    }
  }

  const level = () => Math.max(1, Math.min(100, Number(levelIn.value) || 100));
  levelIn.value = store('level') ?? '100';
  $('level-out').textContent = `${levelIn.value} %`;
  levelIn.addEventListener('input', () => {
    $('level-out').textContent = `${levelIn.value} %`;
    store('level', levelIn.value);
  });
  hapticSel.addEventListener('change', () => bindHaptic());
  $('pulse').addEventListener('click', () => {
    const ms = Number(pulseMs.value);
    if (!Number.isInteger(ms) || ms < 1 || ms > 60_000) {
      $('haptic-msg').textContent = 'Pulse length: 1-60000 ms';
      return;
    }
    void haptic('haptic_pulse', { ms, level: level() }, `pulse ${ms} ms at ${level()} %`);
  });
  $('stop').addEventListener('click', () => void haptic('haptic_stop', {}, 'stopped'));
  $('play').addEventListener('click', () => {
    const steps = parseSteps(stepsIn.value);
    if (!steps) {
      $('haptic-msg').textContent = 'Steps: on,off,on,... in ms (1-32 of them)';
      return;
    }
    void haptic('haptic_play', { steps, level: level(), repeat: 1 }, `playing ${steps.join(',')}`);
  });
  $('patterns').replaceChildren(
    ...PATTERNS.map((p) => {
      const b = el('button', { type: 'button', title: `${p.steps.join(',')} ×${p.repeat} (${patternMs(p)} ms)` }, p.name);
      b.addEventListener('click', () => void haptic('haptic_play', { steps: p.steps, level: level(), repeat: p.repeat }, `${p.name}: ${patternMs(p)} ms`));
      return b;
    }),
  );

  // ---- the registry ----

  let cellsKnown: Cell[] = [];

  function fillInstallPlaces(): void {
    const sel = $<HTMLSelectElement>('install-place');
    const prev = sel.value;
    sel.replaceChildren(...[...cards.values()].map((c) => el('option', { value: `${c.device.id}/${c.inst}` }, `${c.device.alias} ${c.inst}`)));
    if ([...sel.options].some((o) => o.value === prev)) {
      sel.value = prev;
    }
  }

  async function refreshCells(): Promise<void> {
    try {
      const list = await ops.op<CellList>('cell_list', {});
      cellsKnown = list.cells;
      const tbody = $('cell-rows');
      tbody.replaceChildren(
        ...list.cells.map((c) => {
          const l = c.learned;
          const out = el('button', { type: 'button', class: 'ghost', title: 'cell_uninstall' }, 'take out');
          out.hidden = !c.installed;
          out.addEventListener('click', () => void registry(() => ops.op('cell_uninstall', { cell: c.name }), `${c.name} taken out`));
          return el(
            'tr',
            {},
            el('td', {}, c.name),
            el('td', {}, c.chemistry),
            el('td', {}, c.nominal_mah !== null ? `${c.nominal_mah} mAh` : '–'),
            el('td', {}, c.installed ? `${c.installed.alias} ${c.installed.instance}` : '–'),
            el('td', {}, String(l.cycles)),
            el('td', {}, l.capacity_mah !== null ? `${l.capacity_mah} mAh` : '–'),
            el('td', {}, l.health_pct !== null ? `${l.health_pct} %` : '–'),
            el('td', {}, l.r_int_mohm !== null ? `${l.r_int_mohm} mΩ` : '–'),
            el('td', {}, formatDuration(l.last_charge_s)),
            el('td', {}, formatDuration(l.last_discharge_s)),
            el('td', {}, out),
          );
        }),
      );
      const sel = $<HTMLSelectElement>('install-cell');
      const prev = sel.value;
      sel.replaceChildren(...list.cells.map((c) => el('option', { value: c.name }, c.name)));
      if (cellsKnown.some((c) => c.name === prev)) {
        sel.value = prev;
      }
    } catch (e) {
      $('registry-msg').textContent = errText(e);
    }
  }

  async function registry(act: () => Promise<unknown>, text: string): Promise<void> {
    try {
      const r = (await act()) as { warning?: string | null };
      $('registry-msg').textContent = r?.warning ? `${text}; ${r.warning}` : text;
    } catch (e) {
      $('registry-msg').textContent = errText(e);
    }
    await refreshCells();
    await refreshStatus();
  }

  $('refresh').addEventListener('click', () => {
    void refreshCells();
    void refreshStatus();
  });
  $('add').addEventListener('click', () => {
    const name = $<HTMLInputElement>('new-name').value.trim().toLowerCase();
    const chemistry = $<HTMLSelectElement>('new-chem').value;
    const mahText = $<HTMLInputElement>('new-mah').value.trim();
    const mah = mahText ? Number(mahText) : undefined;
    if (!/^[a-z0-9](?:[a-z0-9_-]{0,29}[a-z0-9])?$/.test(name)) {
      $('registry-msg').textContent = 'A cell name is 1-31 lower-case letters, digits, - or _ (e.g. lipo-a)';
      return;
    }
    if (mah !== undefined && !(mah > 0)) {
      $('registry-msg').textContent = 'mAh: a positive number, or empty';
      return;
    }
    void registry(() => ops.op('cell_add', { name, chemistry, ...(mah !== undefined ? { nominal_mah: mah } : {}) }), `${name} added`).then(() => {
      $<HTMLInputElement>('new-name').value = '';
      $<HTMLInputElement>('new-mah').value = '';
    });
  });
  $('install').addEventListener('click', () => {
    const cell = $<HTMLSelectElement>('install-cell').value;
    const [device, instance] = $<HTMLSelectElement>('install-place').value.split('/');
    if (!cell || !device || !instance) {
      $('registry-msg').textContent = 'Pick a cell and a place';
      return;
    }
    void registry(() => ops.op('cell_install', { cell, device, instance }), `${cell} installed`);
  });

  // ---- presence ----

  for (const type of ['device.online', 'device.suspect', 'device.offline'] as const) {
    hub.on(type, () => refreshPlaces());
  }
  hub.devices.on('added', () => refreshPlaces());
  hub.on('registry.drift', () => refreshPlaces());

  refreshPlaces();
  await Promise.all([refreshStatus(), refreshCells()]);
  setInterval(() => void refreshStatus(), STATUS_EVERY_MS);
  setInterval(() => cards.forEach((c) => drawPlot(c)), 5000);
}

main().catch((e: unknown) => {
  showError(`The hub socket did not open: ${errText(e)}. Open this page from the hub (http://127.0.0.1:7420/apps/power/) so it gets its token.`);
});
