// web/force (design scale-round-c1 §9: the load cell is a tension sensor for a sound instrument), served by the hub at
// /apps/force/: pick a board with fr.scale (scale-c6 by default), and play it. Every weight_mg STATE (the board sends
// each conversion, ~96/s, unfiltered) goes through the force chain (./chain.ts: noise σ, One Euro smoothing, auto-range,
// onsets) and is posted to the synth worklet (./audio.ts, ./worklet.ts) right there, in the socket's message handler:
// no rAF, no timer, no batching between a value and the sound. Everything else (the readout, the 5 s plot, the meter,
// the latency figures) is drawn from the latest state on animation frames and a 4 Hz timer. Zero takes the current
// value as rest; Board tare is the scale app's scale_tare (retried while the board says not stable). Keys: space
// mutes, z zeroes, 1-4 pick the mode. Outputs carry data-* attributes for headless checks.

import { CommandError, connect, type AnyDevice, type AnyEvent, type Hub } from '@fractonica/sdk';

import { Instrument } from './audio.ts';
import { ForceChain, type Frame } from './chain.ts';
import { ENGINE_DEFAULTS, FORCE_SLEW_S, MODES, type EngineParams, type Meter, type Mode } from './dsp/engine.ts';
import { SCALES, type ScaleName } from './dsp/quantize.ts';
import { midiHz } from './dsp/units.ts';
import { formatDb, formatForce, formatMs, formatUnits, fromLogSlider, meterFill, toLogSlider } from './format.ts';
import { LatencyWindow } from './latency.ts';
import { ONE_EURO_DEFAULTS } from './oneeuro.ts';
import { ONSET_DEFAULTS } from './onset.ts';
import { errText as opErrText, op, withBusyRetry } from './ops.ts';
import { DIRECTIONS, RANGE_DEFAULTS, type Direction } from './range.ts';
import { Trace } from './trace.ts';
import './style.css';

const DEFAULT_ALIAS = 'scale-c6';
const SCALE = 'fr.scale';
const PLOT_MS = 5000;
/** Slider ranges (log): the One Euro's min cutoff (Hz) and beta, the manual range (mg). */
const CUTOFF_LO = 0.05;
const CUTOFF_HI = 20;
const BETA_LO = 0.001;
const BETA_HI = 2;
const RANGE_LO = 100;
const RANGE_HI = 1_000_000;
/** A hub clock offset larger than this (ms) means the page runs on another machine: correct for it. */
const CLOCK_CORRECT_MS = 20;

const MODE_HINTS: Record<Mode, string> = {
  bow: 'A bowed tone: the force sets the loudness and the brightness and bends the pitch up a little; silent at rest.',
  string: 'A plucked string: the tension tunes it (up an octave at full), a fast change (either way) plucks it, harder for a faster one.',
  drum: 'A hand drum: each fast rise of the force is a hit, its speed sets the loudness and the tone; pressure held after it bends the drum up.',
  theremin: 'A theremin: the force sets the pitch over two octaves (optionally on a scale), heard above a small force.',
};
const MODE_KEYS: Mode[] = ['bow', 'string', 'drum', 'theremin'];

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const store = (key: string, value?: string): string | null => {
  try {
    if (value === undefined) {
      return localStorage.getItem(`fr-force.${key}`);
    }
    localStorage.setItem(`fr-force.${key}`, value);
  } catch {
    // private window, blocked storage: the defaults then
  }
  return null;
};
const storedNum = (key: string, def: number): number => {
  const v = Number(store(key));
  return store(key) !== null && Number.isFinite(v) ? v : def;
};

function showError(text: string | null): void {
  const p = $('error');
  p.textContent = text ?? '';
  p.hidden = !text;
}

const errText = (e: unknown) => (e instanceof CommandError ? `${e.status}: ${e.message}` : opErrText(e));
const instOf = (d: AnyDevice, cap: string) => d.instances.find((i) => i.cap === cap)?.name;
const noteName = (m: number) => `${['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;

const THEMES = ['auto', 'light', 'dark'] as const;
function applyTheme(t: string): void {
  if (t === 'light' || t === 'dark') {
    document.documentElement.dataset.theme = t;
  } else {
    delete document.documentElement.dataset.theme;
  }
  $('theme').textContent = t;
}

function fillSelect(sel: HTMLSelectElement, items: { value: string; label: string }[], want: string | null): void {
  const prev = sel.value;
  sel.replaceChildren(
    ...items.map((i) => {
      const o = document.createElement('option');
      o.value = i.value;
      o.textContent = i.label;
      return o;
    }),
  );
  const pick = items.find((i) => i.value === prev) ?? items.find((i) => i.value === want) ?? items[0];
  if (pick) {
    sel.value = pick.value;
  }
}

async function main(): Promise<void> {
  applyTheme(store('theme') ?? 'auto');
  $('theme').addEventListener('click', () => {
    const t = THEMES[(THEMES.indexOf(($('theme').textContent ?? 'auto') as (typeof THEMES)[number]) + 1) % THEMES.length];
    store('theme', t);
    applyTheme(t);
  });

  // ---- settings (kept in this browser) ----

  const params: EngineParams = {
    ...ENGINE_DEFAULTS,
    mode: (MODE_KEYS as string[]).includes(store('mode') ?? '') ? (store('mode') as Mode) : ENGINE_DEFAULTS.mode,
    volume: Math.min(1, Math.max(0, storedNum('volume', ENGINE_DEFAULTS.volume))),
    root: storedNum('root', ENGINE_DEFAULTS.root),
    scale: (store('scale') ?? ENGINE_DEFAULTS.scale) in SCALES ? ((store('scale') ?? ENGINE_DEFAULTS.scale) as ScaleName) : ENGINE_DEFAULTS.scale,
    glideS: storedNum('glide', ENGINE_DEFAULTS.glideS),
    room: storedNum('room', ENGINE_DEFAULTS.room),
    muted: false,
  };
  const chain = new ForceChain({
    minCutoff: storedNum('mincutoff', ONE_EURO_DEFAULTS.minCutoff),
    beta: storedNum('beta', ONE_EURO_DEFAULTS.beta),
    raw: store('raw') === '1',
    range: {
      direction: (store('direction') ?? RANGE_DEFAULTS.direction) in DIRECTIONS ? ((store('direction') ?? RANGE_DEFAULTS.direction) as Direction) : RANGE_DEFAULTS.direction,
      auto: store('auto') !== '0',
      manualSpan: storedNum('range', RANGE_DEFAULTS.manualSpan),
    },
    onset: { threshold: storedNum('threshold', ONSET_DEFAULTS.threshold), bipolar: params.mode === 'string' },
  });
  const instrument = new Instrument();
  const latency = new LatencyWindow(5000);
  const trace = new Trace(PLOT_MS);
  // for a look from the devtools or a headless check (read-only use)
  (globalThis as unknown as { __force: unknown }).__force = { chain, latency, trace, params, instrument };

  // ---- the hub ----

  const hub: Hub = await connect({ subscribe: { types: ['*.weight_mg', 'presence'] } });
  const setConn = (on: boolean, text: string) => {
    document.body.dataset.connected = String(on);
    $('conn').textContent = text;
  };
  setConn(true, 'connected');
  hub.on('connected', () => {
    setConn(true, 'connected');
    refreshDevices();
  });
  hub.on('disconnected', (d) => setConn(false, `reconnecting (${d.code})`));
  hub.on('error', (e) => console.warn(e));

  const deviceSel = $<HTMLSelectElement>('device');
  const canvas = $<HTMLCanvasElement>('plot');
  const plotCtx = canvas.getContext('2d')!;

  // ---- the hot path: a value in, the force to the worklet at once ----

  let dev: AnyDevice | null = null;
  let inst = '';
  let off: (() => void) | null = null;
  let last: Frame | null = null;
  let hits = 0;
  /** A board tare in flight: values are not played (the offset is about to jump). */
  let taring = false;
  /** ms to add to the page's clock to read the hub's (0 on the same machine). */
  let clockCorrMs = 0;
  /** The handler's own time, page → worklet (µs, smoothed). */
  let handlerUs = NaN;

  function onWeight(e: AnyEvent): void {
    if (e.part !== 'state' || typeof e.value !== 'number') {
      return;
    }
    const t0 = performance.now();
    if (taring) {
      instrument.send(0, null);
      return;
    }
    const fr = chain.push(e.value, e.tHubUs / 1e6);
    instrument.send(fr.norm, fr.hit);
    const t1 = performance.now();
    // bookkeeping after the value went out
    handlerUs = Number.isFinite(handlerUs) ? handlerUs + 0.05 * ((t1 - t0) * 1000 - handlerUs) : (t1 - t0) * 1000;
    latency.push(performance.timeOrigin + t0 + clockCorrMs, e.tHubUs / 1000);
    const rest = chain.range.rest ?? fr.x;
    trace.push(t0, fr.x - rest, fr.smooth - rest, fr.hit);
    if (fr.hit !== null) {
      hits++;
    }
    last = fr;
  }

  function refreshDevices(): void {
    const scales = hub.devices
      .all()
      .filter((d) => d.has(SCALE))
      .sort((a, b) => a.alias.localeCompare(b.alias));
    const kept = store('device');
    fillSelect(
      deviceSel,
      scales.map((d) => ({ value: d.id, label: `${d.alias}${d.online ? '' : ` (${d.presence})`}` })),
      scales.find((d) => d.alias === kept)?.id ?? scales.find((d) => d.alias === DEFAULT_ALIAS)?.id ?? null,
    );
    $('hint').textContent = scales.length ? '' : `No device with ${SCALE} yet: provision one with profile c6w-scale (alias ${DEFAULT_ALIAS}).`;
    select(scales.find((d) => d.id === deviceSel.value) ?? null);
    updateControls();
  }

  function select(d: AnyDevice | null): void {
    if (d === dev) {
      return;
    }
    off?.();
    off = null;
    dev = d;
    inst = d ? (instOf(d, SCALE) ?? '') : '';
    chain.restart();
    latency.clear();
    trace.clear();
    last = null;
    hits = 0;
    instrument.send(0, null);
    $('device-name').textContent = d ? `${d.alias} ${inst}` : '–';
    if (d) {
      store('device', d.alias);
      off = d.on(`${inst}.weight_mg`, onWeight);
    }
  }

  for (const type of ['device.online', 'device.suspect', 'device.offline'] as const) {
    hub.on(type, () => refreshDevices());
  }
  hub.devices.on('added', () => refreshDevices());
  hub.on('registry.drift', () => refreshDevices());
  deviceSel.addEventListener('change', () => select(hub.devices.byId(deviceSel.value) ?? null));

  // ---- sound ----

  const soundBtn = $<HTMLButtonElement>('sound');
  const muteBtn = $<HTMLButtonElement>('mute');
  const volumeIn = $<HTMLInputElement>('volume');

  function soundState(): void {
    const on = instrument.running;
    document.body.dataset.sound = !on ? 'off' : params.muted ? 'muted' : 'on';
    soundBtn.textContent = on ? 'Sound off' : 'Sound on';
    soundBtn.classList.toggle('primary', !on);
    muteBtn.disabled = !on;
    muteBtn.textContent = params.muted ? 'Unmute' : 'Mute';
    $('sound-state').textContent = !on ? 'off' : params.muted ? 'muted' : 'on';
  }

  async function soundOn(): Promise<void> {
    try {
      await instrument.start(params);
      showError(null);
    } catch (e) {
      showError(`Sound: ${errText(e)}`);
    }
    soundState();
  }

  soundBtn.addEventListener('click', () => {
    const ctx = instrument.context;
    if (instrument.running && ctx) {
      void ctx.suspend().then(soundState);
    } else {
      void soundOn();
    }
  });

  function toggleMute(): void {
    if (!instrument.running) {
      void soundOn();
      return;
    }
    params.muted = !params.muted;
    instrument.set({ muted: params.muted });
    soundState();
  }
  muteBtn.addEventListener('click', toggleMute);

  volumeIn.value = String(Math.round(params.volume * 100));
  const showVolume = () => ($('volume-out').textContent = `${volumeIn.value} %`);
  showVolume();
  volumeIn.addEventListener('input', () => {
    params.volume = Number(volumeIn.value) / 100;
    instrument.set({ volume: params.volume });
    store('volume', String(params.volume));
    showVolume();
  });

  instrument.onMeter = (m: Meter) => {
    meter = m;
  };
  let meter: Meter | null = null;

  // the modes
  const modeBtns = new Map<Mode, HTMLButtonElement>();
  for (const [i, m] of MODE_KEYS.entries()) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.dataset.mode = m;
    b.append(MODES[m]);
    const k = document.createElement('kbd');
    k.textContent = String(i + 1);
    b.append(k);
    b.addEventListener('click', () => setMode(m));
    $('modes').append(b);
    modeBtns.set(m, b);
  }

  function setMode(m: Mode): void {
    params.mode = m;
    store('mode', m);
    chain.onset.bipolar = m === 'string';
    instrument.set({ mode: m });
    document.body.dataset.mode = m;
    for (const [k, b] of modeBtns) {
      b.setAttribute('aria-checked', String(k === m));
    }
    $('mode-hint').textContent = MODE_HINTS[m];
    for (const el of document.querySelectorAll<HTMLElement>('[data-for]')) {
      el.hidden = !(el.dataset.for ?? '').split(' ').includes(m);
    }
  }
  setMode(params.mode);

  const rootSel = $<HTMLSelectElement>('root');
  fillSelect(
    rootSel,
    Array.from({ length: 25 }, (_, i) => 33 + i).map((m) => ({ value: String(m), label: `${noteName(m)} (${Math.round(midiHz(m))} Hz)` })),
    String(params.root),
  );
  rootSel.addEventListener('change', () => {
    params.root = Number(rootSel.value);
    store('root', rootSel.value);
    instrument.set({ root: params.root });
  });

  const scaleSel = $<HTMLSelectElement>('scale');
  fillSelect(
    scaleSel,
    (Object.keys(SCALES) as ScaleName[]).map((s) => ({ value: s, label: SCALES[s].label })),
    params.scale,
  );
  scaleSel.addEventListener('change', () => {
    params.scale = scaleSel.value as ScaleName;
    store('scale', params.scale);
    instrument.set({ scale: params.scale });
  });

  const slider = (id: string, init: number, show: (v: number) => string, apply: (v: number) => void) => {
    const el = $<HTMLInputElement>(id);
    el.value = String(init);
    const out = $(`${id}-out`);
    out.textContent = show(Number(el.value));
    el.addEventListener('input', () => {
      const v = Number(el.value);
      out.textContent = show(v);
      apply(v);
    });
  };
  slider('glide', Math.round(params.glideS * 1000), (v) => `${v} ms`, (v) => {
    params.glideS = v / 1000;
    store('glide', String(params.glideS));
    instrument.set({ glideS: params.glideS });
  });
  slider('room', Math.round(params.room * 100), (v) => `${v} %`, (v) => {
    params.room = v / 100;
    store('room', String(params.room));
    instrument.set({ room: params.room });
  });
  slider('threshold', chain.onset.threshold, (v) => `${v} σ`, (v) => {
    chain.onset.threshold = v;
    store('threshold', String(v));
  });

  // ---- smoothing ----

  const cutIn = $<HTMLInputElement>('mincutoff');
  const betaIn = $<HTMLInputElement>('beta');
  const rawBox = $<HTMLInputElement>('raw-toggle');
  const showSmoothing = () => {
    $('mincutoff-out').textContent = `${chain.euro.minCutoff < 1 ? chain.euro.minCutoff.toFixed(2) : chain.euro.minCutoff.toFixed(1)} Hz`;
    $('beta-out').textContent = chain.euro.beta < 0.01 ? chain.euro.beta.toFixed(4) : chain.euro.beta.toFixed(3);
    cutIn.disabled = betaIn.disabled = chain.raw;
  };
  const setSmoothingInputs = () => {
    cutIn.value = String(toLogSlider(chain.euro.minCutoff, CUTOFF_LO, CUTOFF_HI));
    betaIn.value = String(toLogSlider(Math.max(BETA_LO, chain.euro.beta), BETA_LO, BETA_HI));
    rawBox.checked = chain.raw;
    showSmoothing();
  };
  setSmoothingInputs();
  cutIn.addEventListener('input', () => {
    chain.euro.minCutoff = fromLogSlider(Number(cutIn.value), CUTOFF_LO, CUTOFF_HI);
    store('mincutoff', String(chain.euro.minCutoff));
    showSmoothing();
  });
  betaIn.addEventListener('input', () => {
    chain.euro.beta = fromLogSlider(Number(betaIn.value), BETA_LO, BETA_HI);
    store('beta', String(chain.euro.beta));
    showSmoothing();
  });
  rawBox.addEventListener('change', () => {
    chain.raw = rawBox.checked;
    store('raw', chain.raw ? '1' : '0');
    showSmoothing();
  });
  $('smooth-reset').addEventListener('click', () => {
    chain.euro.minCutoff = ONE_EURO_DEFAULTS.minCutoff;
    chain.euro.beta = ONE_EURO_DEFAULTS.beta;
    chain.raw = false;
    for (const k of ['mincutoff', 'beta', 'raw']) {
      store(k, k === 'raw' ? '0' : String(k === 'beta' ? chain.euro.beta : chain.euro.minCutoff));
    }
    setSmoothingInputs();
  });

  // ---- zero, tare, direction, range ----

  const zeroBtn = $<HTMLButtonElement>('zero');
  const tareBtn = $<HTMLButtonElement>('tare');
  const dirSel = $<HTMLSelectElement>('direction');
  const autoBox = $<HTMLInputElement>('auto');
  const rangeIn = $<HTMLInputElement>('range');

  function zero(): void {
    chain.zero();
    trace.clear();
    $('action-state').textContent = chain.last === null ? 'no value yet: the first ones become the rest' : `zeroed at ${formatForce(chain.range.rest)} g-units`;
  }
  zeroBtn.addEventListener('click', zero);

  tareBtn.addEventListener('click', () => {
    const d = dev;
    if (!d || taring) {
      return;
    }
    const line = $('action-state');
    taring = true;
    updateControls();
    line.textContent = 'board tare…';
    void withBusyRetry(() => op<{ offset: number }>('scale_tare', { device: d.alias, instance: inst }), {
      retries: 6,
      delayMs: 500,
      onRetry: (n) => (line.textContent = `board tare: not stable yet, trying again (${n})…`),
    })
      .then((r) => {
        line.textContent = `board tared (offset ${r.offset}, kept across reboots); the rest is measured again`;
        chain.restart();
        trace.clear();
      })
      .catch((e: unknown) => (line.textContent = `board tare failed: ${errText(e)}`))
      .finally(() => {
        taring = false;
        updateControls();
      });
  });

  fillSelect(
    dirSel,
    (Object.keys(DIRECTIONS) as Direction[]).map((k) => ({ value: k, label: DIRECTIONS[k] })),
    chain.range.direction,
  );
  dirSel.addEventListener('change', () => {
    chain.range.direction = dirSel.value as Direction;
    chain.range.zero(chain.range.rest); // the learned span was the other side's
    store('direction', dirSel.value);
  });

  autoBox.checked = chain.range.auto;
  rangeIn.value = String(toLogSlider(chain.range.manualSpan, RANGE_LO, RANGE_HI));
  autoBox.addEventListener('change', () => {
    chain.range.auto = autoBox.checked;
    if (!autoBox.checked && last) {
      // take over the learned span by hand
      chain.range.manualSpan = last.span;
      rangeIn.value = String(toLogSlider(last.span, RANGE_LO, RANGE_HI));
      store('range', String(chain.range.manualSpan));
    }
    store('auto', autoBox.checked ? '1' : '0');
  });
  rangeIn.addEventListener('input', () => {
    chain.range.auto = false;
    autoBox.checked = false;
    store('auto', '0');
    chain.range.manualSpan = fromLogSlider(Number(rangeIn.value), RANGE_LO, RANGE_HI);
    store('range', String(chain.range.manualSpan));
  });

  function updateControls(): void {
    tareBtn.disabled = !dev?.online || taring;
  }

  // ---- keys ----

  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) {
      return;
    }
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'SELECT' || (t.tagName === 'INPUT' && (t as HTMLInputElement).type !== 'range' && (t as HTMLInputElement).type !== 'checkbox'))) {
      return;
    }
    if (e.key === ' ') {
      e.preventDefault();
      toggleMute();
    } else if (e.key === 'z' || e.key === 'Z') {
      zero();
    } else if (e.key >= '1' && e.key <= '4') {
      setMode(MODE_KEYS[Number(e.key) - 1]);
    }
  });

  // ---- drawing (frames) and figures (4 Hz) ----

  function drawFrame(): void {
    const fr = last;
    const force = $('force');
    force.textContent = fr ? formatForce(fr.excursion) : '–';
    force.dataset.mg = fr ? String(Math.round(fr.excursion)) : '';
    const norm = fr?.norm ?? 0;
    $('bar').style.width = `${(norm * 100).toFixed(1)}%`;
    $('norm').textContent = `${Math.round(norm * 100)} %`;
    $('norm').dataset.norm = norm.toFixed(3);
    $('hits').textContent = `${hits} hit${hits === 1 ? '' : 's'}`;
    $('hits').dataset.n = String(hits);
    if (fr) {
      $('raw').textContent = `${formatForce(fr.x)}`;
      $('cutoff').textContent = Number.isFinite(fr.cutoff) ? `cutoff ${fr.cutoff.toFixed(1)} Hz` : 'raw';
    }
    const m = meter;
    if (m) {
      $('meter-rms').style.width = `${(meterFill(m.rms) * 100).toFixed(1)}%`;
      $('meter-peak').style.left = `calc(${(meterFill(m.peak) * 100).toFixed(1)}% - 2px)`;
      const lo = $('level-out');
      lo.textContent = `${formatDb(m.peak)}${m.grDb < -0.5 ? `, limiting ${m.grDb.toFixed(1)}` : ''}`;
      lo.dataset.peak = m.peak.toFixed(4);
      document.body.dataset.limiting = String(m.grDb < -0.5);
    }
    drawPlot(performance.now());
    requestAnimationFrame(drawFrame);
  }

  function drawPlot(now: number): void {
    const dpr = window.devicePixelRatio || 1;
    const cw = canvas.clientWidth || 640;
    const ch = canvas.clientHeight || 220;
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
    }
    trace.trim(now);
    const css = getComputedStyle(document.documentElement);
    const g = plotCtx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cw, ch);
    const fr = last;
    const dead = fr?.dead ?? 0;
    const span = fr?.span ?? 1;
    const dir = chain.range.direction;
    const r = trace.yRange(dead, span, dir === 'pull' ? 'up' : dir === 'push' ? 'down' : 'both');
    const y = (v: number) => ch - ((v - r.lo) / (r.hi - r.lo)) * ch;
    const x = (t: number) => cw - ((now - t) * cw) / PLOT_MS;
    const muted = css.getPropertyValue('--muted').trim() || '#888';
    const accent = css.getPropertyValue('--accent').trim() || '#2f6fde';
    // the dead zone band, the range line(s), a line a second
    g.fillStyle = css.getPropertyValue('--grid').trim() || '#eee';
    g.fillRect(0, y(dead), cw, y(-dead) - y(dead));
    g.strokeStyle = css.getPropertyValue('--line').trim() || '#ddd';
    g.lineWidth = 1;
    for (let s = 1; s < PLOT_MS / 1000; s++) {
      const xx = cw - (s * 1000 * cw) / PLOT_MS;
      g.beginPath();
      g.moveTo(xx, 0);
      g.lineTo(xx, ch);
      g.stroke();
    }
    g.setLineDash([4, 4]);
    g.strokeStyle = css.getPropertyValue('--ok').trim() || '#1f8a4c';
    for (const v of dir === 'pull' ? [span] : dir === 'push' ? [-span] : [span, -span]) {
      g.beginPath();
      g.moveTo(0, y(v));
      g.lineTo(cw, y(v));
      g.stroke();
    }
    g.setLineDash([]);
    g.fillStyle = muted;
    g.font = '11px system-ui, sans-serif';
    g.fillText(formatForce(r.hi), 4, 12);
    g.fillText(formatForce(r.lo), 4, ch - 4);
    const line = (vals: number[], color: string, width: number, alpha: number) => {
      if (!vals.length) {
        return;
      }
      g.globalAlpha = alpha;
      g.strokeStyle = color;
      g.lineWidth = width;
      g.beginPath();
      vals.forEach((v, i) => (i ? g.lineTo(x(trace.t[i]), y(v)) : g.moveTo(x(trace.t[i]), y(v))));
      g.stroke();
      g.globalAlpha = 1;
    };
    line(trace.raw, muted, 1, 0.5);
    line(trace.smooth, accent, 1.75, 1);
    g.fillStyle = css.getPropertyValue('--warn').trim() || '#b7791f';
    for (const h of trace.hits) {
      const hh = 6 + 18 * h.s;
      g.fillRect(x(h.t) - 1.5, 0, 3, hh);
    }
  }

  function figures(): void {
    const s = latency.stats(performance.timeOrigin + performance.now() + clockCorrMs);
    const set = (id: string, text: string, key?: string, v?: number) => {
      const el = $(id);
      el.textContent = text;
      if (key) {
        el.dataset[key] = v === undefined || !Number.isFinite(v) ? '' : String(Math.round(v * 10) / 10);
      }
    };
    set('net-p50', formatMs(s.p50), 'ms', s.p50);
    set('net-p99', formatMs(s.p99), 'ms', s.p99);
    set('net-spread', formatMs(s.p99 - s.p50), 'ms', s.p99 - s.p50);
    set('rate', s.n ? `${s.rate.toFixed(1)}` : '–', 'hz', s.rate);
    set('gap', s.n ? `${formatMs(s.gapArrival)} (${formatMs(s.gapStamp)})` : '–', 'ms', s.gapArrival);
    set('handler', !Number.isFinite(handlerUs) ? '–' : handlerUs < 1000 ? `${handlerUs.toFixed(0)} µs` : formatMs(handlerUs / 1000));
    const a = instrument.latency();
    const slewMs = FORCE_SLEW_S * 1000;
    if (a) {
      set('quantum', `≤ ${formatMs(a.quantum * 1000)} + ${formatMs(slewMs)}`);
      const outMs = (a.base + (Number.isFinite(a.output) ? a.output : 0)) * 1000;
      set('audio-out', `${formatMs(a.base * 1000)} + ${Number.isFinite(a.output) ? formatMs(a.output * 1000) : '?'}`, 'ms', outMs);
      set('ctx', `${a.sampleRate} Hz, hint ${a.hint}`);
      if (Number.isFinite(s.p50)) {
        // a negative p50 is the clock sync's error: count the network as 0 then (the total is a lower bound)
        const total = Math.max(0, s.p50) + (a.quantum * 1000) / 2 + slewMs + outMs;
        set('total', `${s.p50 < 0 ? '≥' : '≈'} ${formatMs(total)} board → sound`, 'ms', total);
      }
    } else {
      set('quantum', '– (sound off)');
      set('audio-out', '– (sound off)', 'ms', NaN);
      set('total', Number.isFinite(s.p50) ? `${formatMs(s.p50)} board → page` : '–', 'ms', NaN);
    }
    const fr = last;
    if (fr) {
      set('sigma', `${formatUnits(fr.sigma)}${chain.noise.measured ? '' : ' (assumed)'}`);
      set('dead', `± ${formatUnits(fr.dead)}`);
      set('span', `${formatUnits(fr.span)}${chain.range.auto ? ' (auto)' : ''}`);
      $('range-out').textContent = `${formatUnits(fr.span)} g-units`;
      if (chain.range.auto) {
        rangeIn.value = String(toLogSlider(fr.span, RANGE_LO, RANGE_HI));
      }
    }
    const offMs = hub.stats().hubClockOffsetMs;
    clockCorrMs = offMs !== null && Math.abs(offMs) > CLOCK_CORRECT_MS ? offMs : 0;
    set('offset', offMs === null ? '–' : formatMs(offMs), 'ms', offMs ?? NaN);
    $('clock').textContent = clockCorrMs
      ? `This page runs on another clock than the hub's (offset ${Math.round(clockCorrMs)} ms, from the socket's pings): board → page is corrected by it, to within a few ms.`
      : '';
    $('clock').hidden = !clockCorrMs;
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      meter = null;
    }
  });

  refreshDevices();
  soundState();
  requestAnimationFrame(drawFrame);
  figures();
  setInterval(figures, 250);
}

main().catch((e: unknown) => {
  showError(`The hub socket did not open: ${errText(e)}. Open this page from the hub (http://127.0.0.1:7420/apps/force/) so it gets its token.`);
  document.body.dataset.connected = 'false';
  $('conn').textContent = 'not connected';
});
