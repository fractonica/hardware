// SCALE-1's scale app (design scale-round-c1 D12), served by the hub at /apps/scale/: pick a board with fr.scale
// (scale-c6 by default), read its weight in grams with a stability dot, a 30 s plot, the HX711's rate (rate_hz) and the
// rate reports arrive at, the noise (the sd over the plot's window); Tare and Calibrate (scale_tare, scale_calibrate over
// POST /api/v1/op, retried while the board answers BUSY), and "Show on the round display": an fr.display instance (the
// round one by default, from its traits) gets the layout of ./round.ts (ui_load), then ui_set of what changed at most 5
// times a second (./throttle.ts) while the page is open and the toggle is on, hidden or not (a background tab's timers
// still run about once a second); a failed ui_load or ui_set loads the layout again after 2 s, backing off to 30 s.
// "live at 80 Hz" asks the board for every conversion (./live.ts: a 30 s fr.scale watch_start renewed every 20 s while
// it is on; off or the page closed, it stops renewing and the board falls back by itself; never watch_stop, which a hub
// scale_watch job owns). The /app socket (presence, properties, commands) is the SDK's connect(). Outputs carry data-*
// attributes for headless checks.

import { CommandError, connect, type AnyDevice, type AnyEvent, type Hub } from '@fractonica/sdk';

import { formatHz, formatNoise, formatWeight, parseGrams } from './format.ts';
import { LiveWatch, retryDelayMs } from './live.ts';
import { createOps, errText as opErrText, withBusyRetry } from './ops.ts';
import { DEFAULT_CAPACITY_G, displaySize, isRound, pickDisplay, scaleLayout, type Shown, shownFor, takesLayouts, uiSets } from './round.ts';
import { plotPoints, Series, yRange } from './series.ts';
import { LatestThrottle } from './throttle.ts';
import './style.css';

const DEFAULT_ALIAS = 'scale-c6';
const SCALE = 'fr.scale';
const DISPLAY = 'fr.display';
/** The round display's update rate (design D12). */
const ROUND_HZ = 5;
/** live at 80 Hz: each watch_start asks for this long, renewed this often. */
const FAST_WATCH_S = 30;
const FAST_RENEW_MS = 20_000;
const WINDOW_MS = 30_000;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const store = (key: string, value?: string): string | null => {
  try {
    if (value === undefined) {
      return localStorage.getItem(`fr-scale.${key}`);
    }
    localStorage.setItem(`fr-scale.${key}`, value);
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

const errText = (e: unknown) => (e instanceof CommandError ? `${e.status}: ${e.message}` : opErrText(e));
/** The HX711's RATE strap from its measured rate: an "80 Hz" part reads 80-100, a "10 Hz" one 10-12 (its oscillator). */
const rateMode = (hz: number) => (hz >= 70 ? ' (80 Hz mode)' : hz >= 8 && hz <= 15 ? ' (10 Hz mode: RATE pin low)' : '');
const instOf = (d: AnyDevice, cap: string) => d.instances.find((i) => i.cap === cap)?.name;

const THEMES = ['auto', 'light', 'dark'] as const;
function applyTheme(t: string): void {
  if (t === 'light' || t === 'dark') {
    document.documentElement.dataset.theme = t;
  } else {
    delete document.documentElement.dataset.theme;
  }
  $('theme').textContent = t;
}

/** A display a device offers: `<device id>/<instance>`. */
interface DisplayRef {
  device: AnyDevice;
  inst: string;
  traits: Readonly<Record<string, unknown>> | null;
}

async function main(): Promise<void> {
  applyTheme(store('theme') ?? 'auto');
  $('theme').addEventListener('click', () => {
    const t = THEMES[(THEMES.indexOf(($('theme').textContent ?? 'auto') as (typeof THEMES)[number]) + 1) % THEMES.length];
    store('theme', t);
    applyTheme(t);
  });

  const ops = createOps();
  const hub: Hub = await connect({ subscribe: { types: ['*.weight_mg', '*.stable', '*.calibrated', '*.rate_hz', '*.settled', 'presence'] } });
  const setConn = (on: boolean, text: string) => {
    document.body.dataset.connected = String(on);
    $('conn').textContent = text;
  };
  setConn(true, 'connected');
  hub.on('connected', () => {
    setConn(true, 'connected');
    refreshDevices();
    roundReload('reconnected');
  });
  hub.on('disconnected', (d) => setConn(false, `reconnecting (${d.code})`));
  hub.on('error', (e) => console.warn(e));

  const deviceSel = $<HTMLSelectElement>('device');
  const displaySel = $<HTMLSelectElement>('display');
  const tareBtn = $<HTMLButtonElement>('tare');
  const calBtn = $<HTMLButtonElement>('calibrate');
  const resetBtn = $<HTMLButtonElement>('reset');
  const knownIn = $<HTMLInputElement>('known');
  const fastBox = $<HTMLInputElement>('fast');
  const roundBox = $<HTMLInputElement>('round-on');
  const capacityIn = $<HTMLInputElement>('capacity');
  const canvas = $<HTMLCanvasElement>('plot');
  const plotCtx = canvas.getContext('2d')!;

  knownIn.value = store('known') ?? '';
  capacityIn.value = store('capacity') ?? String(DEFAULT_CAPACITY_G);

  // ---- the selected scale ----

  let scaleDev: AnyDevice | null = null;
  let scaleInst = '';
  let scaleOff: (() => void)[] = [];
  const series = new Series(WINDOW_MS);
  const reading: { mg: number | null; stable: boolean | null; calibrated: boolean | null; rateHz: number | null } = { mg: null, stable: null, calibrated: null, rateHz: null };
  let acting = false;

  function fillSelect(sel: HTMLSelectElement, items: { value: string; label: string }[], keep: string | null, fallback: (v: string) => boolean): void {
    const prev = sel.value;
    sel.replaceChildren(
      ...items.map((i) => {
        const o = document.createElement('option');
        o.value = i.value;
        o.textContent = i.label;
        return o;
      }),
    );
    const want = items.find((i) => i.value === prev) ?? items.find((i) => i.value === keep) ?? items.find((i) => fallback(i.value)) ?? items[0];
    if (want) {
      sel.value = want.value;
    }
  }

  function refreshDevices(): void {
    const all = hub.devices.all().sort((a, b) => a.alias.localeCompare(b.alias));
    const scales = all.filter((d) => d.has(SCALE));
    const kept = store('device');
    fillSelect(
      deviceSel,
      scales.map((d) => ({ value: d.id, label: `${d.alias}${d.online ? '' : ` (${d.presence})`}` })),
      scales.find((d) => d.alias === kept)?.id ?? null,
      (id) => hub.devices.byId(id)?.alias === DEFAULT_ALIAS,
    );
    $('hint').textContent = scales.length ? '' : `No device with ${SCALE} yet: provision one with profile c6w-scale (alias ${DEFAULT_ALIAS}).`;
    selectScale(scales.find((d) => d.id === deviceSel.value) ?? null);
    refreshDisplays();
    updateControls();
  }

  function selectScale(d: AnyDevice | null): void {
    if (d === scaleDev) {
      return;
    }
    stopFast();
    for (const off of scaleOff) {
      off();
    }
    scaleOff = [];
    series.clear();
    Object.assign(reading, { mg: null, stable: null, calibrated: null, rateHz: null });
    scaleDev = d;
    scaleInst = d ? (instOf(d, SCALE) ?? '') : '';
    $('device-name').textContent = d ? `${d.alias} ${scaleInst}` : '–';
    if (!d) {
      render();
      return;
    }
    store('device', d.alias);
    const prop = (name: string, fn: (v: unknown) => void) => {
      const v = d.raw.state[scaleInst]?.[name];
      if (v !== undefined) {
        fn(v);
      }
      scaleOff.push(
        d.on(`${scaleInst}.${name}`, (e: AnyEvent) => {
          if (e.part === 'state') {
            fn(e.value);
          }
        }),
      );
    };
    prop('weight_mg', (v) => {
      if (typeof v === 'number') {
        reading.mg = v;
        series.push(performance.now(), v);
        onReading();
      }
    });
    prop('stable', (v) => {
      reading.stable = v === true;
      onReading();
    });
    prop('calibrated', (v) => {
      reading.calibrated = v === true;
      render();
    });
    prop('rate_hz', (v) => {
      if (typeof v === 'number') {
        reading.rateHz = v;
        onReading();
      }
    });
    scaleOff.push(
      d.on(`${scaleInst}.settled`, (e: AnyEvent) => {
        const f = e as unknown as { weightMg?: number; deltaMg?: number };
        $('state').textContent = `settled at ${formatWeight(f.weightMg).text} (${(f.deltaMg ?? 0) >= 0 ? '+' : ''}${formatWeight(f.deltaMg).text})`;
      }),
    );
    if (fastBox.checked) {
      startFast();
    }
    render();
  }

  // ---- the readouts ----

  function onReading(): void {
    render();
    roundOffer();
  }

  function render(): void {
    const w = formatWeight(reading.mg);
    const value = $('value');
    value.textContent = w.value;
    value.dataset.mg = reading.mg === null ? '' : String(reading.mg);
    $('unit').textContent = w.unit;
    const dead = reading.rateHz === 0;
    document.body.dataset.stable = dead ? 'dead' : reading.stable === null ? 'unknown' : String(reading.stable);
    if (dead) {
      $('state').textContent = 'the HX711 does not answer (rate 0): check its wiring and supply';
    } else if (reading.mg === null) {
      $('state').textContent = scaleDev ? 'no reading yet' : 'no scale';
    } else if (!$('state').textContent?.startsWith('settled')) {
      $('state').textContent = reading.stable ? 'stable' : reading.stable === false ? 'settling…' : '';
    }
    const cal = $('calibrated');
    cal.dataset.calibrated = reading.calibrated === null ? 'unknown' : String(reading.calibrated);
    cal.textContent = reading.calibrated === null ? 'calibration –' : reading.calibrated ? 'calibrated' : 'not calibrated';
    const rate = $('rate');
    rate.textContent = reading.rateHz === null ? '–' : `${reading.rateHz} Hz${rateMode(reading.rateHz)}`;
    rate.dataset.hz = reading.rateHz === null ? '' : String(reading.rateHz);
    updateControls();
  }

  /** The window's figures and the plot, 4 times a second. */
  function renderWindow(): void {
    const now = performance.now();
    series.trim(now);
    const s = series.stats();
    const arrivals = series.rate(now);
    $('arrivals').textContent = formatHz(s.n ? arrivals : null);
    $('arrivals').dataset.hz = String(Math.round(arrivals * 10) / 10);
    $('noise').textContent = formatNoise(s.sd);
    $('noise').dataset.mg = s.sd === null ? '' : String(Math.round(s.sd));
    $('minmax').textContent = s.min === null ? '–' : `${formatWeight(s.min).text} … ${formatWeight(s.max).text}`;
    $('samples').textContent = `${s.n} samples`;
    $('samples').dataset.n = String(s.n);
    drawPlot(now, s.min, s.max);
  }

  function drawPlot(now: number, min: number | null, max: number | null): void {
    const dpr = window.devicePixelRatio || 1;
    const cw = canvas.clientWidth || 640;
    const ch = canvas.clientHeight || 220;
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
    }
    const css = getComputedStyle(document.documentElement);
    const g = plotCtx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cw, ch);
    const range = yRange(min, max);
    // Grid: a line every 10 s, and the zero line when it is in range.
    g.strokeStyle = css.getPropertyValue('--grid').trim() || '#ddd';
    g.lineWidth = 1;
    for (let s = 10; s < WINDOW_MS / 1000; s += 10) {
      const x = cw - (s * 1000 * cw) / WINDOW_MS;
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, ch);
      g.stroke();
    }
    if (range.lo < 0 && range.hi > 0) {
      const y = ch - ((0 - range.lo) / (range.hi - range.lo)) * ch;
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(cw, y);
      g.stroke();
    }
    g.fillStyle = css.getPropertyValue('--muted').trim() || '#888';
    g.font = '11px system-ui, sans-serif';
    g.fillText(formatWeight(range.hi).text, 4, 12);
    g.fillText(formatWeight(range.lo).text, 4, ch - 4);
    const pts = plotPoints(series.samples, now, WINDOW_MS, cw, ch, range);
    if (pts.length) {
      g.strokeStyle = css.getPropertyValue('--accent').trim() || '#2f6fde';
      g.lineWidth = 1.5;
      g.beginPath();
      pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.stroke();
    }
  }

  function updateControls(): void {
    const up = !!scaleDev?.online && !acting;
    tareBtn.disabled = !up;
    resetBtn.disabled = !up;
    calBtn.disabled = !up || parseGrams(knownIn.value) === null;
    fastBox.disabled = !scaleDev?.online;
    roundBox.disabled = displaySel.options.length === 0;
  }

  // ---- tare, calibrate, reset ----

  async function act(what: string, fn: () => Promise<string>): Promise<void> {
    if (!scaleDev) {
      return;
    }
    acting = true;
    updateControls();
    const line = $('action-state');
    line.textContent = `${what}…`;
    try {
      line.textContent = await withBusyRetry(fn, { retries: 6, delayMs: 500, onRetry: (n) => (line.textContent = `${what}: not stable yet, trying again (${n})…`) });
      showError(null);
      $('state').textContent = '';
    } catch (e) {
      line.textContent = `${what} failed: ${errText(e)}`;
    } finally {
      acting = false;
      updateControls();
    }
  }

  tareBtn.addEventListener('click', () => {
    const d = scaleDev;
    if (!d) {
      return;
    }
    void act('tare', async () => {
      const r = await ops.op<{ offset: number }>('scale_tare', { device: d.alias, instance: scaleInst });
      series.clear();
      return `tared (offset ${r.offset}), kept across reboots`;
    });
  });

  calBtn.addEventListener('click', () => {
    const d = scaleDev;
    const g = parseGrams(knownIn.value);
    if (!d || g === null) {
      return;
    }
    store('known', knownIn.value);
    void act(`calibrate with ${g} g`, async () => {
      const r = await ops.op<{ counts_per_kg: number }>('scale_calibrate', { device: d.alias, instance: scaleInst, known_g: g });
      series.clear();
      return `calibrated with ${g} g: ${r.counts_per_kg} counts/kg, kept across reboots`;
    });
  });

  resetBtn.addEventListener('click', () => {
    const d = scaleDev;
    if (!d || !confirm(`Forget ${d.alias}'s tare and calibration?`)) {
      return;
    }
    void act('reset calibration', async () => {
      await ops.op('scale_reset_calibration', { device: d.alias, instance: scaleInst });
      series.clear();
      return 'calibration reset: offset 0 and the profile factor';
    });
  });

  knownIn.addEventListener('input', updateControls);

  // ---- live at 80 Hz (a short watch_start renewed while on; never watch_stop) ----

  let fast: LiveWatch | null = null;

  function startFast(): void {
    if (!scaleDev || !scaleInst || fast) {
      return;
    }
    const dev = scaleDev;
    const inst = scaleInst;
    fast = new LiveWatch(
      (args) => dev.raw.call(inst, 'watch_start', args),
      (e) => showError(`${dev.alias} ${inst} watch_start: ${errText(e)}`),
      { seconds: FAST_WATCH_S, renewMs: FAST_RENEW_MS },
    );
    fast.start();
  }

  function stopFast(): void {
    // Nothing is sent: the board's window lapses within FAST_WATCH_S (a hub watch's own window is left alone).
    fast?.stop();
    fast = null;
  }

  fastBox.addEventListener('change', () => (fastBox.checked ? startFast() : stopFast()));

  // ---- the round display ----

  let displays: DisplayRef[] = [];
  const throttle = new LatestThrottle<Shown>(ROUND_HZ, (a, b) => a.value === b.value && a.unit === b.unit && a.gauge === b.gauge && a.color === b.color && a.state === b.state);
  let round: { ref: DisplayRef; loaded: boolean; loading: boolean } | null = null;
  // A failed ui_load or ui_set loads the layout again after retryDelayMs(roundAttempts) while the toggle is on; a
  // ui_set that lands proves the layout and starts the back-off over.
  let roundRetry: ReturnType<typeof setTimeout> | null = null;
  let roundAttempts = 0;

  function cancelRoundRetry(): void {
    if (roundRetry) {
      clearTimeout(roundRetry);
      roundRetry = null;
    }
  }

  function scheduleRoundRetry(): void {
    cancelRoundRetry();
    if (!roundBox.checked) {
      return;
    }
    const delay = retryDelayMs(roundAttempts++);
    roundRetry = setTimeout(() => {
      roundRetry = null;
      if (roundBox.checked) {
        void roundLoad();
      }
    }, delay);
  }

  const capacityG = () => {
    const n = Number(capacityIn.value);
    return n > 0 ? n : DEFAULT_CAPACITY_G;
  };

  function refreshDisplays(): void {
    displays = hub.devices.all().flatMap((d) => d.instances.filter((i) => i.cap === DISPLAY && takesLayouts(i)).map((i) => ({ device: d, inst: i.name, traits: i.traits })));
    // The selected scale's own round display first, then any round one, then the rest.
    const rank = (r: DisplayRef) => (r.device === scaleDev ? 0 : 2) + (isRound({ name: r.inst, cap: DISPLAY, traits: r.traits }) ? 0 : 1);
    displays.sort((a, b) => rank(a) - rank(b) || a.device.alias.localeCompare(b.device.alias));
    const own = scaleDev ? pickDisplay(scaleDev.instances.filter((i) => i.cap === DISPLAY)) : null;
    fillSelect(
      displaySel,
      displays.map((r) => ({ value: `${r.device.id}/${r.inst}`, label: `${r.device.alias} ${r.inst}${isRound({ name: r.inst, cap: DISPLAY, traits: r.traits }) ? ' (round)' : ''}${r.device.online ? '' : ` (${r.device.presence})`}` })),
      store('display'),
      (v) => !!own && !!scaleDev && v === `${scaleDev.id}/${own.name}`,
    );
    updateControls();
  }

  const selectedDisplay = (): DisplayRef | null => displays.find((r) => `${r.device.id}/${r.inst}` === displaySel.value) ?? null;

  function setRoundState(state: 'off' | 'on' | 'error', text: string): void {
    document.body.dataset.round = state;
    $('round-state').textContent = text;
  }

  async function roundLoad(): Promise<void> {
    cancelRoundRetry(); // this load supersedes a retry that was waiting
    const ref = selectedDisplay();
    if (!roundBox.checked || !ref) {
      round = null;
      roundAttempts = 0;
      setRoundState('off', 'off');
      return;
    }
    round = { ref, loaded: false, loading: true };
    throttle.reset();
    setRoundState('on', `loading on ${ref.device.alias} ${ref.inst}…`);
    const mine = round;
    try {
      await ref.device.raw.call(ref.inst, 'ui_load', { layout: scaleLayout(displaySize(ref.traits)) });
      if (round !== mine) {
        return;
      }
      mine.loaded = true;
      setRoundState('on', `on ${ref.device.alias} ${ref.inst}`);
      roundOffer();
    } catch (e) {
      if (round === mine) {
        setRoundState('error', `ui_load: ${errText(e)}; trying again in ${retryDelayMs(roundAttempts) / 1000} s`);
        scheduleRoundRetry();
      }
    } finally {
      mine.loading = false;
    }
  }

  function roundReload(_why: string): void {
    if (roundBox.checked) {
      void roundLoad();
    }
  }

  function roundOffer(): void {
    if (round?.loaded) {
      throttle.offer(shownFor({ mg: reading.mg, stable: reading.stable, rateHz: reading.rateHz }, capacityG()));
    }
  }

  /**
   * The pump: at most ROUND_HZ updates a second, one in flight, only the widgets that changed. It runs while the tab
   * is hidden too (its timers slow to about 1/s there): the panel must not freeze on a stale weight.
   */
  async function roundTick(): Promise<void> {
    const r = round;
    if (!r?.loaded) {
      return;
    }
    const gen = throttle.generation; // a ui_load meanwhile makes this update not the new layout's
    const next = throttle.take(performance.now());
    if (!next) {
      return;
    }
    const prev = throttle.shown ?? null;
    try {
      for (const set of uiSets(prev, next)) {
        await r.ref.device.raw.call(r.ref.inst, 'ui_set', { ...set });
      }
      throttle.done(next, gen);
      if (round === r) {
        roundAttempts = 0;
      }
    } catch (e) {
      throttle.done(undefined, gen);
      if (round === r) {
        r.loaded = false;
        setRoundState('error', `ui_set: ${errText(e)}; loading the layout again in ${retryDelayMs(roundAttempts) / 1000} s`);
        scheduleRoundRetry();
      }
    }
  }

  roundBox.addEventListener('change', () => {
    store('round', roundBox.checked ? '1' : '0');
    void roundLoad();
  });
  displaySel.addEventListener('change', () => {
    const ref = selectedDisplay();
    if (ref) {
      store('display', displaySel.value);
    }
    void roundLoad();
  });
  capacityIn.addEventListener('change', () => {
    store('capacity', String(capacityG()));
    roundOffer();
  });
  roundBox.checked = store('round') === '1';

  // ---- hub events ----

  for (const type of ['device.online', 'device.suspect', 'device.offline'] as const) {
    hub.on(type, (e: unknown) => {
      refreshDevices();
      // A display that rebooted shows its own screen again: the layout goes back on.
      const id = (e as { device?: { id?: string } }).device?.id;
      if (type === 'device.online' && round && (id === undefined || id === round.ref.device.id)) {
        roundReload('online');
      }
    });
  }
  hub.devices.on('added', () => refreshDevices());
  hub.on('registry.drift', () => refreshDevices());
  deviceSel.addEventListener('change', () => {
    selectScale(hub.devices.byId(deviceSel.value) ?? null);
    refreshDisplays();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      roundOffer();
    }
  });
  window.addEventListener('pagehide', () => stopFast());

  refreshDevices();
  render();
  if (roundBox.checked) {
    void roundLoad();
  }
  setInterval(renderWindow, 250);
  setInterval(() => void roundTick(), 50);
}

main().catch((e: unknown) => {
  showError(`The hub socket did not open: ${errText(e)}. Open this page from the hub (http://127.0.0.1:7420/apps/scale/) so it gets its token.`);
  document.body.dataset.connected = 'false';
  $('conn').textContent = 'not connected';
});
