// CSI-1's live app (design csi-c1 D14), served by the hub at /apps/csi/: pick a board with fr.csi (csi-c5 by
// default), start a live stream on `/app/stream` with a source (router, or peer: a board with fr.radio_tx aimed at
// the sensor, which this page can start and stop), and watch a subcarrier heatmap, motion (the board's property
// and the app's own), RSSI, records/s, drops and gaps, and a breathing estimate while the room is still; the
// Sound card plays a drone from the subcarriers (./sonify.ts, ./sonify-map.ts; design §14).
// The /app socket (presence, properties, commands) is the SDK's connect(); the binary stream is ./stream.ts (a
// local adapter with the SDK's names, see its head). Outputs carry data-* attributes for headless checks.
// A stream the page wants is started again when it ends, when the hub started none, and when the board comes back
// online, with a backoff (1.5 s doubling to 30 s) while starts keep failing (body data-retry-ms; the state line says
// why and when). Per-block bookkeeping is bounded (./window.ts), so a background tab (no animation frames) neither
// grows nor stalls when it returns.

import { CommandError, connect, type AnyDevice, type AnyEvent, type Hub } from '@fractonica/sdk';

import { estimateBreathing, MotionTracker, median, NullTracker, recordKind, type RecordKind } from './dsp.ts';
import { Heatmap, type HeatmapMode } from './heatmap.ts';
import { drawSignal, TimePlot } from './plot.ts';
import { csiAmplitudes, streams, type CsiBlock, type StreamEvent, type StreamInfo, type StreamSource, type StreamSubscription } from './stream.ts';
import { mountSoundPanel } from './sonify.ts';
import { dropBefore, RateWindow, RestartBackoff } from './window.ts';
import './style.css';

const DEFAULT_ALIAS = 'csi-c5';
const CSI = 'fr.csi';
const RADIO_TX = 'fr.radio_tx';
/** Seconds of amplitudes kept per record kind for the breathing estimate (it uses the newest 30). */
const KEEP_S = 32;
/** Seconds of the app's motion kept (the still check uses the newest 5): trimmed per block, so a background tab stays bounded. */
const MOTION_KEEP_S = 10;
/** A stream that ran this long without an `error` end worked, even with no block (a peer source whose transmitter is off). */
const HEALTHY_S = 10;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const nowS = () => performance.now() / 1000;

function store(key: string, value?: string): string | null {
  try {
    if (value === undefined) {
      return localStorage.getItem(`fr-csi.${key}`);
    }
    localStorage.setItem(`fr-csi.${key}`, value);
  } catch {
    // private window, blocked storage: the defaults then
  }
  return null;
}

function showError(text: string | null): void {
  const p = $('error');
  p.textContent = text ?? '';
  p.hidden = !text;
}

const errText = (e: unknown) => (e instanceof CommandError ? `${e.status}: ${e.message}` : e instanceof Error ? e.message : String(e));
const instOf = (d: AnyDevice, cap: string) => d.instances.find((i) => i.cap === cap)?.name;

// ---- theme ----

const THEMES = ['auto', 'light', 'dark'] as const;
function applyTheme(t: string): void {
  if (t === 'light' || t === 'dark') {
    document.documentElement.dataset.theme = t;
  } else {
    delete document.documentElement.dataset.theme;
  }
  $('theme').textContent = t;
}

// ---- per-kind state ----

interface KindState {
  kind: RecordKind;
  nulls: NullTracker;
  motion: MotionTracker;
  /** The valid subcarriers' amplitudes, reused per record for the motion tracker. */
  sub: Float32Array;
  t: number[];
  amps: Float32Array[];
  /** Records in the last 2 s (receipt time), to pick the current kind: fixed memory, counted per block. */
  recent: RateWindow;
}

/** The stream as this page sees it: counters, the chip clock unwrapped, the record kinds. */
class Session {
  streamId: number | null = null;
  records = 0;
  drops = 0;
  gapBlocks = 0;
  gapRecords = 0;
  kinds = new Map<number, KindState>();
  currentKind: number | null = null;
  lastChannel = 0;
  headS = 0;
  headAt = 0;
  #nextSeq: number | null = null;
  #nextIndex: number | null = null;
  #lastRaw: number | null = null;
  #wraps = 0;
  #t0: number | null = null;

  reset(streamId: number | null): void {
    this.streamId = streamId;
    this.records = this.drops = this.gapBlocks = this.gapRecords = 0;
    this.kinds.clear();
    this.currentKind = null;
    this.#nextSeq = this.#nextIndex = this.#lastRaw = this.#t0 = null;
    this.#wraps = 0;
    this.headS = 0;
  }

  /** Board drops (first_index past the expected one across consecutive blocks) and hub gaps (a seq jump). */
  accountBlock(b: CsiBlock): void {
    if (this.#nextSeq !== null && this.#nextIndex !== null) {
      const missing = (b.firstIndex - this.#nextIndex) >>> 0;
      if (b.seq === this.#nextSeq) {
        this.drops += missing < 0x80000000 ? missing : 0;
      } else {
        this.gapBlocks += Math.max(0, (b.seq - this.#nextSeq) >>> 0);
        this.gapRecords += missing < 0x80000000 ? missing : 0;
      }
    }
    this.#nextSeq = (b.seq + 1) >>> 0;
    this.#nextIndex = (b.firstIndex + b.records.length) >>> 0;
  }

  /** The record's time in seconds since the stream's first record, the u32 µs clock unwrapped. */
  time(tUs: number): number {
    if (this.#lastRaw !== null && tUs < this.#lastRaw && this.#lastRaw - tUs > 0x80000000) {
      this.#wraps++;
    }
    this.#lastRaw = tUs;
    const us = this.#wraps * 4294967296 + tUs;
    if (this.#t0 === null) {
      this.#t0 = us;
    }
    return (us - this.#t0) / 1e6;
  }

  kindState(len: number, bb: number): KindState {
    let k = this.kinds.get(len);
    if (!k) {
      const kind = recordKind(len, bb);
      k = { kind, nulls: new NullTracker(kind.subcarriers), motion: new MotionTracker(), sub: new Float32Array(0), t: [], amps: [], recent: new RateWindow(2, 20) };
      this.kinds.set(len, k);
    }
    return k;
  }

  /** The kind with the most records in the last 2 s. */
  pickKind(now: number): number | null {
    let best: number | null = null;
    let n = 0;
    for (const [key, k] of this.kinds) {
      const c = k.recent.count(now);
      if (c > n) {
        n = c;
        best = key;
      }
    }
    if (best !== null) {
      this.currentKind = best;
    }
    return this.currentKind;
  }
}

async function main(): Promise<void> {
  applyTheme(store('theme') ?? 'auto');
  $('theme').addEventListener('click', () => {
    const t = THEMES[(THEMES.indexOf(($('theme').textContent ?? 'auto') as (typeof THEMES)[number]) + 1) % THEMES.length];
    store('theme', t);
    applyTheme(t);
    heat.theme();
  });

  const heat = new Heatmap($<HTMLCanvasElement>('heatmap'));
  const motionPlot = new TimePlot($<HTMLCanvasElement>('plot-motion'), [{ color: '--c-motion' }, { color: '--c-board', dash: true, ownScale: true }], { windowS: 30, min: 0 });
  const rssiPlot = new TimePlot($<HTMLCanvasElement>('plot-rssi'), [{ color: '--c-rssi' }], { windowS: 30 });
  const ratePlot = new TimePlot($<HTMLCanvasElement>('plot-rate'), [{ color: '--c-rate' }], { windowS: 30, min: 0 });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => heat.theme());
  $('gradient').style.background = heat.legendGradient();
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-mode]')) {
    b.addEventListener('click', () => {
      heat.mode = b.dataset.mode as HeatmapMode;
      for (const o of document.querySelectorAll<HTMLButtonElement>('[data-mode]')) {
        o.setAttribute('aria-pressed', String(o === b));
      }
      $('gradient').style.background = heat.legendGradient();
    });
  }

  // The drone (design csi-c1 §14): records of the current kind feed it while the sound is on.
  const sound = mountSoundPanel(store, nowS);

  const hub: Hub = await connect({ subscribe: { types: ['*.motion', '*.rssi', '*.rate', '*.sending', '*.stream_ended', 'presence'] } });
  document.body.dataset.connected = 'true';
  $('conn').textContent = 'connected';
  hub.on('connected', () => {
    document.body.dataset.connected = 'true';
    $('conn').textContent = 'connected';
    refreshDevices();
  });
  hub.on('disconnected', (d) => {
    document.body.dataset.connected = 'false';
    $('conn').textContent = `reconnecting (${d.code})`;
  });
  hub.on('error', (e) => console.warn(e));

  const deviceSel = $<HTMLSelectElement>('device');
  const txSel = $<HTMLSelectElement>('tx-device');
  const startBtn = $<HTMLButtonElement>('start');
  const txBtn = $<HTMLButtonElement>('tx-toggle');
  const sourceOf = (): StreamSource => (document.querySelector<HTMLInputElement>('input[name=source]:checked')?.value as StreamSource) ?? 'router';

  let sensor: AnyDevice | null = null;
  let sensorOff: (() => void)[] = [];
  let tx: AnyDevice | null = null;
  let txOff: (() => void)[] = [];
  let sub: StreamSubscription | null = null;
  let wanted = false;
  let joinedNote = '';
  const session = new Session();
  /** Restarts after a refused start or a failed stream wait longer each time (1.5 s to 30 s); a stream that works resets it. */
  const backoff = new RestartBackoff({ minMs: 1500, maxMs: 30_000 });
  /** The current stream: when it was first seen (nowS) and its blocks, to tell a stream that worked from one that failed. */
  let streamSince: number | null = null;
  let streamBlocks = 0;
  /** The sensor's presence as last seen, so coming back online retries a stream the page wants. */
  let sensorOnline = false;
  /** The app's motion of the current kind (receipt time), and the records counted this second. */
  const appMotion: { t: number; v: number }[] = [];
  let recordsThisSecond = 0;

  // ---- devices ----

  function fillSelect(sel: HTMLSelectElement, list: AnyDevice[], prefer: string | null): void {
    const keep = sel.value || prefer;
    sel.replaceChildren(
      ...list.map((d) => {
        const o = document.createElement('option');
        o.value = d.id;
        o.textContent = `${d.alias}${d.online ? '' : ` (${d.presence})`}`;
        o.dataset.alias = d.alias;
        return o;
      }),
    );
    const pick = list.find((d) => d.id === keep || d.alias === keep) ?? list.find((d) => d.alias === DEFAULT_ALIAS) ?? list.find((d) => d.online) ?? list[0];
    if (pick) {
      sel.value = pick.id;
    }
  }

  function refreshDevices(): void {
    const all = hub.devices.all().sort((a, b) => a.alias.localeCompare(b.alias));
    const sensors = all.filter((d) => d.has(CSI));
    fillSelect(deviceSel, sensors, store('device') ?? DEFAULT_ALIAS);
    if (sensors.length === 0) {
      setHint(`No device with ${CSI} yet: provision one with profile c5d-csi (alias ${DEFAULT_ALIAS}).`);
    }
    selectSensor(sensors.find((d) => d.id === deviceSel.value) ?? null);
    const online = sensor?.online === true;
    if (online && !sensorOnline && wanted && !sub?.stream) {
      // Back online while the page wants a stream and has none: try now, not at the end of a backoff.
      restartSoon(300, `${sensor!.alias} is online`);
    }
    sensorOnline = online;
    const txs = all.filter((d) => d.has(RADIO_TX) && d.online && d.id !== sensor?.id);
    fillSelect(txSel, txs, store('tx'));
    $('tx').hidden = txs.length === 0;
    selectTx(txs.find((d) => d.id === txSel.value) ?? null);
    updateControls();
  }

  function selectSensor(d: AnyDevice | null): void {
    if (d === sensor) {
      return;
    }
    for (const off of sensorOff) {
      off();
    }
    sensorOff = [];
    const wasRunning = wanted;
    stopStream();
    sensor = d;
    sensorOnline = d?.online === true;
    if (!d) {
      return;
    }
    store('device', d.alias);
    const inst = instOf(d, CSI)!;
    const prop = (name: string, fn: (v: number) => void) => {
      const v = d.raw.state[inst]?.[name];
      if (typeof v === 'number') {
        fn(v);
      }
      sensorOff.push(
        d.on(`${inst}.${name}`, (e: AnyEvent) => {
          if (e.part === 'state' && typeof e.value === 'number') {
            fn(e.value);
          }
        }),
      );
    };
    prop('motion', (v) => {
      motionPlot.push(1, nowS(), v);
      $('motion-board').textContent = String(v);
    });
    prop('rssi', (v) => {
      if (!sub?.stream) {
        rssiPlot.push(0, nowS(), v);
        $('rssi').textContent = `${v} dBm`;
      }
    });
    prop('rate', (v) => {
      $('board-rate').textContent = `${v} /s`;
    });
    if (wasRunning) {
      startStream();
    }
  }

  function selectTx(d: AnyDevice | null): void {
    if (d === tx) {
      return;
    }
    for (const off of txOff) {
      off();
    }
    txOff = [];
    tx = d;
    if (!d) {
      return;
    }
    store('tx', d.alias);
    const inst = instOf(d, RADIO_TX)!;
    txOff.push(d.on(`${inst}.sending`, () => updateControls()));
  }

  const txSending = () => {
    if (!tx) {
      return false;
    }
    return tx.raw.state[instOf(tx, RADIO_TX)!]?.sending === true;
  };

  function setHint(text: string): void {
    $('hint').textContent = text;
  }

  function updateControls(): void {
    const peer = sourceOf() === 'peer';
    startBtn.disabled = !sensor || (peer && !tx && !wanted);
    startBtn.textContent = wanted ? 'Stop' : 'Start';
    startBtn.classList.toggle('primary', !wanted);
    $<HTMLButtonElement>('baseline').disabled = !sensor?.online;
    const sending = txSending();
    txBtn.textContent = sending ? 'Stop transmitter' : 'Start transmitter';
    txBtn.disabled = !tx || !sensor;
    $('tx-state').textContent = sending ? 'sending' : 'off';
    $('tx-state').classList.toggle('on', sending);
    if (!sensor) {
      return;
    }
    if (!sensor.online) {
      setHint(`${sensor.alias} is ${sensor.presence}.`);
    } else if (peer && !tx) {
      setHint(`Source peer needs a board with ${RADIO_TX} online (any pad) as the transmitter.`);
    } else if (peer && !sending) {
      setHint(`Start the transmitter on ${tx!.alias}: it sends ESP-NOW frames to ${sensor.alias} (${sensor.id}). Place the person between the boards.`);
    } else {
      setHint(joinedNote);
    }
  }

  // ---- the stream ----

  function setStreamState(text: string, streaming: boolean): void {
    $('stream-state').textContent = text;
    document.body.dataset.streaming = String(streaming);
  }

  function describe(s: StreamInfo): string {
    return `stream ${s.stream_id} · ${s.source}${s.peer_mac ? ` ${s.peer_mac}` : ''}`;
  }

  function onStream(info: StreamInfo | null): void {
    if (!info) {
      setStreamState(wanted ? 'waiting for a stream' : 'idle', false);
      return;
    }
    if (info.stream_id !== session.streamId) {
      streamSince = nowS();
      streamBlocks = 0;
      session.reset(info.stream_id);
      heat.reset();
      motionPlot.clear();
    }
    const want = sourceOf();
    joinedNote = info.source !== want ? `Joined a running stream with source ${info.source} (another app or csi_stream started it); stop it there to switch.` : '';
    $('stream-id').textContent = describe(info);
    setStreamState(describe(info), true);
    updateControls();
  }

  function onEvent(e: StreamEvent): void {
    switch (e.type) {
      case 'welcome':
        showError(null);
        onStream(e.stream);
        break;
      case 'started':
        onStream(e.stream);
        break;
      case 'ended': {
        // A stream that delivered blocks, or ran a while, worked; one that ended `error` (a board refusing stream_start
        // ends so, its welcome having named the stream already) or at once did not, and the next restart waits longer.
        const ranS = streamSince === null ? 0 : nowS() - streamSince;
        if (e.reason !== 'error' && (streamBlocks > 0 || ranS >= HEALTHY_S)) {
          backoff.succeed();
        }
        streamSince = null;
        streamBlocks = 0;
        setStreamState(`ended: ${e.reason}`, false);
        $('stream-id').textContent = `${e.streamId} ended ${e.reason} (${e.records} records, ${e.dropped} dropped)`;
        if (wanted) {
          // the socket waits for the next stream; reopen it with `start` so one begins
          retryAfter(`ended ${e.reason}`);
        }
        break;
      }
      case 'gap':
        // seq jumps count the same blocks; this frame comes first, so nothing more to add
        break;
      case 'error':
        showError(`stream: ${e.code}: ${e.message}`);
        if (wanted && sub?.open && !sub.stream) {
          // After the welcome (a refused hello closes 4400 instead) the hub started none: the board is offline or
          // busy, or a stream that is not published live runs. Try again later (sooner when the board comes online).
          retryAfter(`not started (${e.code})`);
        }
        break;
      case 'closed':
        setStreamState(e.willReconnect ? `reconnecting (${e.code})` : `closed (${e.code})`, false);
        if (!e.willReconnect && wanted) {
          wanted = false;
          sub = null;
          showError(`The stream socket closed (${e.code} ${e.reason}).${e.code === 4401 ? ' Open this page from the hub so it gets its token.' : ''}`);
          updateControls();
        }
        break;
      default:
        break;
    }
  }

  function onBlock(b: CsiBlock): void {
    if (session.streamId === null && sub?.stream) {
      onStream(sub.stream);
    }
    if (++streamBlocks === 1) {
      backoff.succeed(); // the stream works
    }
    session.accountBlock(b);
    const now = nowS();
    let rssiSum = 0;
    for (const r of b.records) {
      const t = session.time(r.tUs);
      const k = session.kindState(r.len, r.bbFormat);
      const amps = csiAmplitudes(r);
      k.nulls.add(amps);
      const valid = k.nulls.valid;
      if (k.sub.length !== valid.length) {
        k.sub = new Float32Array(valid.length);
      }
      for (let i = 0; i < valid.length; i++) {
        k.sub[i] = amps[valid[i]];
      }
      const m = k.motion.update(t, k.sub);
      k.t.push(t);
      k.amps.push(amps);
      k.recent.add(now);
      heat.push(t, r.len, amps);
      session.headS = t;
      rssiSum += r.rssi;
      session.lastChannel = r.channel;
      if (k.kind.key === session.currentKind || session.currentKind === null) {
        appMotion.push({ t: now, v: m });
      }
      if (sound.on && k.kind.key === session.currentKind) {
        sound.push(now, t, k.kind.key, amps, valid, m);
      }
    }
    // Bounded here, not in a timer or a frame (a background tab throttles the one and pauses the other).
    if (appMotion.length && appMotion[0].t < now - MOTION_KEEP_S - 1) {
      dropBefore(appMotion, now - MOTION_KEEP_S, (x) => x.t);
    }
    session.headAt = now;
    session.records += b.records.length;
    recordsThisSecond += b.records.length;
    if (b.records.length) {
      const rssi = rssiSum / b.records.length;
      rssiPlot.push(0, now, rssi);
      $('rssi').textContent = `${rssi.toFixed(0)} dBm`;
    }
    // keep KEEP_S seconds per kind
    for (const k of session.kinds.values()) {
      const cut = session.headS - KEEP_S;
      let n = 0;
      while (n < k.t.length && k.t[n] < cut) {
        n++;
      }
      if (n > 50) {
        k.t.splice(0, n);
        k.amps.splice(0, n);
      }
    }
  }

  function startStream(): void {
    if (!sensor) {
      return;
    }
    const source = sourceOf();
    const start = source === 'peer' && tx ? { source, peer: tx.alias } : { source: 'router' as const };
    cancelRestart();
    wanted = true;
    joinedNote = '';
    sub?.close();
    sub = streams.subscribe(sensor.alias, instOf(sensor, CSI), onBlock, { start, onEvent });
    setStreamState('starting…', false);
    updateControls();
  }

  function stopStream(): void {
    cancelRestart();
    wanted = false;
    sub?.close();
    sub = null;
    setStreamState('idle', false);
    updateControls();
  }

  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let restartAt = 0;
  let restartWhy = '';
  function cancelRestart(): void {
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    restartWhy = '';
    delete document.body.dataset.retryMs;
  }
  function showRestart(): void {
    const s = Math.max(0, Math.ceil((restartAt - Date.now()) / 1000));
    const attempt = backoff.failures > 1 ? ` (attempt ${backoff.failures})` : '';
    setStreamState(`${restartWhy}: retrying in ${s} s${attempt}`, false);
  }
  /** Leaves the socket and starts again in `ms` (the state line says why and when). */
  function restartSoon(ms: number, why = ''): void {
    cancelRestart();
    sub?.close();
    sub = null;
    restartAt = Date.now() + ms;
    restartWhy = why;
    document.body.dataset.retryMs = String(ms);
    if (why) {
      showRestart();
    }
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (wanted) {
        startStream();
      }
    }, ms);
  }
  /** A restart after a failure or an end: the backoff's delay, which grows while starts keep failing. */
  function retryAfter(why: string): void {
    restartSoon(backoff.fail(), why);
  }

  startBtn.addEventListener('click', () => {
    if (wanted) {
      stopStream();
    } else {
      backoff.succeed(); // the user asked: no backoff left from before
      startStream();
    }
  });
  deviceSel.addEventListener('change', () => {
    selectSensor(hub.devices.byId(deviceSel.value) ?? null);
    refreshDevices();
  });
  txSel.addEventListener('change', () => {
    selectTx(hub.devices.byId(txSel.value) ?? null);
    updateControls();
  });
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name=source]')) {
    r.addEventListener('change', () => {
      store('source', sourceOf());
      if (wanted) {
        // leave, so the hub ends the stream this page started, then start one with the new source
        restartSoon(600);
      }
      updateControls();
    });
  }
  const savedSource = store('source');
  if (savedSource === 'peer' || savedSource === 'router') {
    document.querySelector<HTMLInputElement>(`input[name=source][value=${savedSource}]`)!.checked = true;
  }

  $('baseline').addEventListener('click', () => {
    if (!sensor) {
      return;
    }
    sensor.raw.call(instOf(sensor, CSI)!, 'baseline_reset').then(
      () => {
        showError(null);
        for (const k of session.kinds.values()) {
          k.motion.reset();
        }
      },
      (e: unknown) => showError(`baseline_reset: ${errText(e)}`),
    );
  });

  txBtn.addEventListener('click', () => {
    if (!tx || !sensor) {
      return;
    }
    const inst = instOf(tx, RADIO_TX)!;
    const rate = Math.max(1, Math.min(200, Math.round(Number($<HTMLInputElement>('tx-rate').value) || 100)));
    txBtn.disabled = true;
    const call = txSending() ? tx.raw.call(inst, 'stop') : tx.raw.call(inst, 'start', { peer_mac: sensor.id, rate_hz: rate, len: 32, seconds: 0 });
    call.then(
      () => showError(null),
      (e: unknown) => showError(`${tx?.alias} ${RADIO_TX}: ${errText(e)}`),
    ).finally(() => updateControls());
  });

  for (const type of ['device.online', 'device.suspect', 'device.offline'] as const) {
    hub.on(type, () => refreshDevices());
  }
  hub.devices.on('added', () => refreshDevices());
  hub.on('registry.drift', () => refreshDevices());
  refreshDevices();

  // ---- the loops: draw at ~30 fps, rates every second, breathing every second ----

  let lastDraw = 0;
  const stillInput = $<HTMLInputElement>('still');
  stillInput.value = store('still') ?? stillInput.value;
  stillInput.addEventListener('change', () => store('still', stillInput.value));
  const stillThreshold = () => Number(stillInput.value) || 0.04;

  function frame(): void {
    requestAnimationFrame(frame);
    const now = nowS();
    if (now - lastDraw < 1 / 30) {
      return;
    }
    lastDraw = now;
    const kind = session.pickKind(now);
    if (kind !== null) {
      const head = session.headS + Math.min(0.15, now - session.headAt);
      const range = heat.render(head, kind, (k) => session.kinds.get(k)?.nulls.valid ?? null);
      const ks = session.kinds.get(kind)!;
      const v = ks.nulls.valid;
      const label = `${ks.kind.label} · ${v.length} of ${ks.kind.subcarriers}`;
      const pill = $('kind');
      if (pill.textContent !== label) {
        pill.textContent = label;
        pill.dataset.kind = ks.kind.label;
      }
      $('row-top').textContent = String(v[0] ?? '–');
      $('row-bottom').textContent = String(v[v.length - 1] ?? '–');
      $('kinds-seen').textContent = [...session.kinds.values()].map((k) => `${k.kind.label} ${k.recent.count(now) / 2}/s`).join(' · ');
      if (range) {
        $('lo').textContent = range.lo.toFixed(1);
        $('hi').textContent = range.hi.toFixed(1);
      }
    } else {
      heat.render(0, -1, () => null);
    }
    motionPlot.draw(now, stillThreshold());
    rssiPlot.draw(now);
    ratePlot.draw(now);
  }
  requestAnimationFrame(frame);

  setInterval(() => {
    const now = nowS();
    // records per second, and the app motion trace (10 Hz would be finer; 4 Hz keeps the arrays short)
    ratePlot.push(0, now, recordsThisSecond);
    $('rate').textContent = String(recordsThisSecond);
    recordsThisSecond = 0;
    const set = (id: string, n: number, text = String(n)) => {
      const el = $(id);
      el.textContent = text;
      el.dataset.n = String(n);
    };
    set('records', session.records);
    set('drops', session.drops);
    set('gaps', session.gapBlocks, session.gapBlocks ? `${session.gapBlocks} blocks (${session.gapRecords} rec)` : '0');
    $('channel').textContent = session.lastChannel ? String(session.lastChannel) : '–';
    if (restartTimer && restartWhy) {
      showRestart();
    }
  }, 1000);

  setInterval(() => {
    const now = nowS();
    dropBefore(appMotion, now - MOTION_KEEP_S, (x) => x.t);
    const last = appMotion[appMotion.length - 1];
    if (last && now - last.t < 1) {
      motionPlot.push(0, now, last.v);
      $('motion-app').textContent = last.v.toFixed(3);
    }
  }, 250);

  const breath = document.querySelector<HTMLElement>('.breath')!;
  const bpmOut = $<HTMLOutputElement>('bpm');
  setInterval(() => {
    const now = nowS();
    const setState = (state: string, text: string) => {
      breath.dataset.state = state;
      $('breath-state').textContent = text;
    };
    const kind = session.currentKind;
    const ks = kind !== null ? session.kinds.get(kind) : undefined;
    if (!ks || !sub?.stream || now - session.headAt > 3) {
      setState('waiting', 'waiting for a stream');
      bpmOut.textContent = '–';
      bpmOut.dataset.bpm = '';
      return;
    }
    const recent = appMotion.filter((m) => m.t >= now - 5).map((m) => m.v);
    const motionNow = median(recent);
    const still = Number.isFinite(motionNow) && motionNow < stillThreshold();
    const e = estimateBreathing(ks.t, ks.amps, ks.nulls.valid);
    if (!still) {
      setState('moving', `motion ${Number.isFinite(motionNow) ? motionNow.toFixed(3) : '–'} is above ${stillThreshold()}: breathing shows while the person sits still`);
      bpmOut.textContent = '–';
      bpmOut.dataset.bpm = '';
      bpmOut.dataset.confidence = '';
      $('conf').textContent = '–';
      $('conf-bar').style.width = '0';
      return;
    }
    if (!e.ok) {
      setState('waiting', e.reason ?? 'no estimate');
      bpmOut.textContent = '–';
      bpmOut.dataset.bpm = '';
      bpmOut.dataset.confidence = '';
      $('conf').textContent = '–';
      $('conf-bar').style.width = '0';
      return;
    }
    setState(e.confidence >= 0.3 ? 'ok' : 'weak', `${ks.kind.label}, ${e.spanS.toFixed(0)} s, peak ${e.freqHz.toFixed(3)} Hz holds ${(e.peakShare * 100).toFixed(0)} % of the band${e.confidence < 0.3 ? ' (weak: no clear rhythm)' : ''}`);
    bpmOut.textContent = e.bpm.toFixed(1);
    bpmOut.dataset.bpm = e.bpm.toFixed(2);
    bpmOut.dataset.confidence = e.confidence.toFixed(2);
    $('conf').textContent = `${Math.round(e.confidence * 100)} %`;
    $('conf-bar').style.width = `${Math.round(e.confidence * 100)}%`;
    $('breath-subs').textContent = e.subcarriers.join(', ');
    drawSignal($<HTMLCanvasElement>('plot-breath'), e.signal, '--c-breath');
  }, 1000);
}

main().catch((e: unknown) => {
  $('conn').textContent = 'not connected';
  showError(`${errText(e)}. Open this page from the hub: http://127.0.0.1:7420/apps/csi/`);
});
