// CAM-1's camera app (design camera-c1 D13), served by the hub at /apps/cam/: pick a board with fr.camera (cam-esp32 by
// default), watch its live view (a jpeg stream on `/app/stream`, each frame decoded to a canvas), change its settings
// (camera_set, remembered per camera), light its flash LED, take a snapshot the hub saves (camera_snap), record to the
// board's micro-SD card (camera_stream to sd or both) and manage the card's recordings (camera_sd_list, camera_sd_fetch,
// camera_sd_delete). The /app socket (presence, properties, commands) is the SDK's connect(); the binary stream is
// ./stream.ts over the SDK's streams; the hub's ops go over POST /api/v1/op/<name> (./ops.ts). Outputs carry data-*
// attributes for headless checks. A frame that arrives while the previous one decodes is dropped, never queued
// (./frames.ts DecodeGate), so a slow tab shows the newest frame and no backlog.

import { CommandError, connect, type AnyDevice, type AnyEvent, type Hub } from '@fractonica/sdk';
import type { CameraSdList, CameraSnap, CameraStatus, CameraStream, Job } from '@fractonica/protocol/browser';

import { DecodeGate, formatAge, formatBytes, formatFps, frameFileName, FrameStats, RestartBackoff } from './frames.ts';
import { createOps, errText as opErrText, OpError, type JobRun } from './ops.ts';
import { cardText, RecordingsModel } from './recordings.ts';
import {
  type CameraSettings,
  clampLive,
  clampRecord,
  DEFAULT_SETTINGS,
  diffSettings,
  FRAME_SIZES,
  frameSizeLabel,
  type KeyStore,
  liveStartSettings,
  loadLive,
  loadRecord,
  loadSettings,
  type LiveOptions,
  markAccepted,
  markRefused,
  needsLiveRestart,
  NO_REFUSED,
  type RecordOptions,
  recordStreamInput,
  type RefusedSettings,
  revertSettings,
  saveLive,
  saveRecord,
  saveSettings,
  type SettingsPatch,
} from './settings.ts';
import { type JpegBlock, type StreamDescription, type StreamEvent, subscribeLive, type Subscription } from './stream.ts';
import './style.css';

const DEFAULT_ALIAS = 'cam-esp32';
const CAMERA = 'fr.camera';
const LED = 'fr.led';
/** The flash LED's instance name on the e32a-cam profile (§10); any other fr.led but `status` is taken when it is missing. */
const FLASH_INSTANCE = 'flash';
/** camera_status every this often while a camera is selected. */
const STATUS_EVERY_MS = 3000;
/** A snapshot right after the live view stops may find the board still streaming: retried this often, this many times. */
const BUSY_RETRIES = 4;
const BUSY_RETRY_MS = 400;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const nowS = () => performance.now() / 1000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const store: KeyStore = ((key: string, value?: string): string | null => {
  try {
    if (value === undefined) {
      return localStorage.getItem(`fr-cam.${key}`);
    }
    localStorage.setItem(`fr-cam.${key}`, value);
  } catch {
    // private window, blocked storage: the defaults then
  }
  return null;
}) as KeyStore;

function showError(text: string | null): void {
  const p = $('error');
  p.textContent = text ?? '';
  p.hidden = !text;
}

const errText = (e: unknown) => (e instanceof CommandError ? `${e.status}: ${e.message}` : opErrText(e));
const instOf = (d: AnyDevice, cap: string) => d.instances.find((i) => i.cap === cap)?.name;
const flashOf = (d: AnyDevice) => {
  const leds = d.instances.filter((i) => i.cap === LED);
  return (leds.find((i) => i.name === FLASH_INSTANCE) ?? leds.find((i) => i.name !== 'status'))?.name;
};
const isBusy = (e: unknown) => e instanceof OpError && e.code === 'DEVICE_BUSY';

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

async function main(): Promise<void> {
  applyTheme(store('theme') ?? 'auto');
  $('theme').addEventListener('click', () => {
    const t = THEMES[(THEMES.indexOf(($('theme').textContent ?? 'auto') as (typeof THEMES)[number]) + 1) % THEMES.length];
    store('theme', t);
    applyTheme(t);
  });

  const ops = createOps();

  const hub: Hub = await connect({ subscribe: { types: ['*.frames', '*.fps_x10', '*.last_bytes', '*.streaming', '*.sd', '*.sd_free_mb', '*.on', '*.stream_ended', 'presence'] } });
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

  // ---- elements ----

  const deviceSel = $<HTMLSelectElement>('device');
  const liveBtn = $<HTMLButtonElement>('live');
  const liveInterval = $<HTMLInputElement>('live-interval');
  const snapBtn = $<HTMLButtonElement>('snap');
  const snapFlash = $<HTMLInputElement>('snap-flash');
  const flashBtn = $<HTMLButtonElement>('flash');
  const downloadBtn = $<HTMLButtonElement>('download');
  const applyAllBtn = $<HTMLButtonElement>('apply-all');
  const recordBtn = $<HTMLButtonElement>('record');
  const refreshBtn = $<HTMLButtonElement>('refresh');
  const canvas = $<HTMLCanvasElement>('frame');
  const ctx = canvas.getContext('2d')!;
  const settingEls = {
    frame_size: $<HTMLSelectElement>('set-frame-size'),
    quality: $<HTMLInputElement>('set-quality'),
    brightness: $<HTMLInputElement>('set-brightness'),
    contrast: $<HTMLInputElement>('set-contrast'),
    saturation: $<HTMLInputElement>('set-saturation'),
    vflip: $<HTMLInputElement>('set-vflip'),
    hmirror: $<HTMLInputElement>('set-hmirror'),
  };
  settingEls.frame_size.replaceChildren(
    ...FRAME_SIZES.map((s) => {
      const o = document.createElement('option');
      o.value = s;
      o.textContent = frameSizeLabel(s);
      return o;
    }),
  );
  const recEls = { interval: $<HTMLInputElement>('rec-interval'), duration: $<HTMLInputElement>('rec-duration'), live: $<HTMLInputElement>('rec-live') };

  // ---- state ----

  let camera: AnyDevice | null = null;
  let cameraOff: (() => void)[] = [];
  let flashInst: string | undefined;
  let settings: CameraSettings = { ...DEFAULT_SETTINGS };
  /** frame_size and quality values this camera refused (camera_set failed): the live view's start leaves them out. */
  let refused: RefusedSettings = { ...NO_REFUSED };
  let liveOpts: LiveOptions = clampLive(null);
  let recOpts: RecordOptions = clampRecord(null);

  /** The live view's own subscription (it started the stream), or a passive one (joined a recording's or a fetch's). */
  let sub: Subscription | null = null;
  let liveWanted = false;
  /**
   * Bumped by every startLive() and stopLive(): a start the interval change or a snapshot scheduled for later runs only
   * while its generation is current, so a Start pressed meanwhile is not followed by a second start (two leave + start
   * rounds on the hub, and a stream restarted under the viewer).
   */
  let liveGen = 0;
  const stats = new FrameStats(1);
  const gate = new DecodeGate();
  /** The frame on the canvas, for Download. */
  let lastFrame: Blob | null = null;
  const backoff = new RestartBackoff({ minMs: 1500, maxMs: 30_000 });
  let streamFrames = 0;

  let snapping = false;
  let recordRun: JobRun<CameraStream> | null = null;
  let recordJob: Job | null = null;
  const recordings = new RecordingsModel();
  let statusTimer: ReturnType<typeof setInterval> | null = null;
  let statusFailed: string | null = null;
  let lastStatus: CameraStatus | null = null;

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
    const cams = all.filter((d) => d.has(CAMERA));
    fillSelect(deviceSel, cams, store('device') ?? DEFAULT_ALIAS);
    if (cams.length === 0) {
      setHint(`No device with ${CAMERA} yet: provision one with profile e32a-cam (alias ${DEFAULT_ALIAS}).`);
    }
    selectCamera(cams.find((d) => d.id === deviceSel.value) ?? null);
    updateControls();
  }

  function selectCamera(d: AnyDevice | null): void {
    if (d === camera) {
      return;
    }
    for (const off of cameraOff) {
      off();
    }
    cameraOff = [];
    stopLive();
    if (recordRun) {
      void recordRun.cancel().catch(() => undefined);
    }
    camera = d;
    recordings.clear();
    renderRecordings();
    lastStatus = null;
    statusFailed = null;
    if (statusTimer) {
      clearInterval(statusTimer);
      statusTimer = null;
    }
    if (!d) {
      flashInst = undefined;
      return;
    }
    store('device', d.alias);
    flashInst = flashOf(d);
    settings = loadSettings(store, d.alias);
    refused = { ...NO_REFUSED };
    liveOpts = loadLive(store, d.alias);
    recOpts = loadRecord(store, d.alias);
    showSettings();
    liveInterval.value = String(liveOpts.intervalMs);
    recEls.interval.value = String(recOpts.intervalS);
    recEls.duration.value = String(recOpts.durationS);
    recEls.live.checked = recOpts.alsoLive;
    const cam = instOf(d, CAMERA)!;
    const prop = (inst: string, name: string, fn: (v: unknown) => void) => {
      const v = d.raw.state[inst]?.[name];
      if (v !== undefined) {
        fn(v);
      }
      cameraOff.push(
        d.on(`${inst}.${name}`, (e: AnyEvent) => {
          if (e.part === 'state') {
            fn(e.value);
          }
        }),
      );
    };
    prop(cam, 'fps_x10', (v) => {
      if (typeof v === 'number') {
        $('board-fps').textContent = v ? `${(v / 10).toFixed(1)} fps` : 'idle';
      }
    });
    prop(cam, 'sd', (v) => {
      if (typeof v === 'string') {
        onCard(v as RecordingsModel['card']['sd'], recordings.card.freeMb);
      }
    });
    prop(cam, 'sd_free_mb', (v) => {
      if (typeof v === 'number') {
        onCard(recordings.card.sd, v);
      }
    });
    if (flashInst) {
      prop(flashInst, 'on', () => updateControls());
    }
    cameraOff.push(d.on(`${cam}.stream_ended`, () => void refreshRecordingsSoon()));
    void pollStatus();
    statusTimer = setInterval(() => void pollStatus(), STATUS_EVERY_MS);
    // The card's recordings are listed once the card is known to be mounted (the sd property above, or camera_status);
    // with no state yet (a board that has not reported sd), the first list is tried now.
    if (recordings.card.sd === null) {
      void refreshRecordings();
    }
  }

  /** The card's state from a property or camera_status: shown, and the recordings listed when the card just came. */
  function onCard(sd: RecordingsModel['card']['sd'], freeMb: number | null): void {
    const list = recordings.setCard(sd, freeMb);
    renderRecordings();
    if (list) {
      void refreshRecordings();
    }
  }

  const flashOn = () => (camera && flashInst ? camera.raw.state[flashInst]?.on === true : false);

  function setHint(text: string): void {
    $('hint').textContent = text;
  }

  function updateControls(): void {
    const online = camera?.online === true;
    const recording = recordRun !== null;
    liveBtn.disabled = !camera || (!liveWanted && (recording || snapping));
    liveBtn.textContent = liveWanted ? 'Stop' : 'Start';
    liveBtn.classList.toggle('primary', !liveWanted);
    snapBtn.disabled = !online || snapping || recording;
    flashBtn.disabled = !online || !flashInst;
    flashBtn.textContent = flashOn() ? 'Flash off' : 'Flash on';
    const fs = $('flash-state');
    fs.textContent = flashInst ? (flashOn() ? 'flash on' : 'flash off') : 'no flash LED';
    fs.classList.toggle('on', flashOn());
    downloadBtn.disabled = !lastFrame;
    applyAllBtn.disabled = !online;
    for (const el of Object.values(settingEls)) {
      el.disabled = !camera;
    }
    recordBtn.disabled = !online && !recording;
    recordBtn.textContent = recording ? 'Stop recording' : 'Start recording';
    recordBtn.classList.toggle('primary', !recording);
    recordBtn.classList.toggle('danger', recording);
    refreshBtn.disabled = !online;
    document.body.dataset.recording = String(recording);
    if (!camera) {
      return;
    }
    if (!camera.online) {
      setHint(`${camera.alias} is ${camera.presence}.`);
    } else {
      setHint(statusFailed ? `camera_status: ${statusFailed}` : '');
    }
  }

  // ---- the live view ----

  function setStreamState(text: string, streaming: boolean): void {
    $('stream-state').textContent = text;
    document.body.dataset.streaming = String(streaming);
  }

  function describe(s: StreamDescription): string {
    const bits = [`stream ${s.streamId}`];
    if (s.to && s.to !== 'hub') {
      bits.push(`to ${s.to}`);
    }
    if (s.intervalMs) {
      bits.push(`every ${s.intervalMs} ms`);
    }
    if (s.frameSize) {
      bits.push(s.frameSize);
    }
    return bits.join(' · ');
  }

  function onStream(info: StreamDescription | null): void {
    if (!info) {
      setStreamState(liveWanted ? 'waiting for a stream' : recordRun ? 'recording' : 'idle', false);
      $('live-stream').textContent = liveWanted ? 'waiting' : 'no stream';
      return;
    }
    if (info.streamId !== stats.streamId) {
      stats.reset(info.streamId);
      gate.reset();
      streamFrames = 0;
    }
    $('live-stream').textContent = describe(info);
    $('stream-id').textContent = String(info.streamId);
    setStreamState(describe(info), true);
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
        if (e.reason !== 'error' && streamFrames > 0) {
          backoff.succeed();
        }
        setStreamState(`ended: ${e.reason}`, false);
        $('stream-id').textContent = `${e.streamId} ended ${e.reason} (${e.records} frames, ${e.dropped} dropped)`;
        $('live-stream').textContent = `ended ${e.reason}`;
        streamFrames = 0;
        if (liveWanted) {
          retryAfter(`ended ${e.reason}`);
        }
        break;
      }
      case 'gap':
        break;
      case 'error':
        showError(`stream: ${e.code}: ${e.message}`);
        if (liveWanted && sub?.open && !sub.stream) {
          retryAfter(`not started (${e.code})`);
        }
        break;
      case 'closed':
        setStreamState(e.retry ? `reconnecting (${e.code})` : `closed (${e.code})`, false);
        if (!e.retry && liveWanted) {
          liveWanted = false;
          sub = null;
          showError(`The stream socket closed (${e.code} ${e.reason}).${e.code === 4401 ? ' Open this page from the hub so it gets its token.' : ''}`);
          updateControls();
        }
        break;
      default:
        break;
    }
  }

  function onFrame(f: JpegBlock, stream: StreamDescription | null): void {
    if (stats.streamId === null && stream) {
      onStream(stream);
    }
    if (++streamFrames === 1) {
      backoff.succeed();
    }
    const now = nowS();
    stats.add(f, now);
    $('frames').textContent = String(stats.frames);
    $('frames').dataset.n = String(stats.frames);
    void draw(f);
  }

  async function draw(f: JpegBlock): Promise<void> {
    if (!gate.begin()) {
      return; // still decoding the previous frame: this one is dropped, the next newest is drawn
    }
    try {
      // A copy: the block's bytes are a view the socket may reuse, and Blob wants a plain ArrayBuffer-backed view.
      const blob = new Blob([new Uint8Array(f.jpeg)], { type: 'image/jpeg' });
      const bitmap = await createImageBitmap(blob);
      try {
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
        }
        ctx.drawImage(bitmap, 0, 0);
      } finally {
        bitmap.close();
      }
      lastFrame = blob;
      document.body.dataset.frame = 'true';
      const size = $('frame-size');
      size.textContent = `${f.width}×${f.height}${f.frameSize ? ` ${f.frameSize}` : ''} q${f.quality}`;
      size.dataset.w = String(f.width);
      size.dataset.h = String(f.height);
      if (downloadBtn.disabled) {
        updateControls();
      }
    } catch (e) {
      console.warn('frame decode', e);
    } finally {
      gate.end();
    }
  }

  function startLive(): void {
    if (!camera) {
      return;
    }
    liveGen++;
    cancelRestart();
    liveWanted = true;
    sub?.close();
    liveOpts = clampLive({ intervalMs: Number(liveInterval.value) });
    liveInterval.value = String(liveOpts.intervalMs);
    saveLive(store, camera.alias, liveOpts);
    sub = subscribeLive(hub, camera.alias, instOf(camera, CAMERA), onFrame, {
      start: { intervalMs: liveOpts.intervalMs, ...liveStartSettings(settings, refused) },
      onEvent,
    });
    setStreamState('starting…', false);
    updateControls();
  }

  /** startLive() later, unless the live view was started or stopped meanwhile (a Start or Stop pressed by then). */
  function startLiveLater(ms: number): void {
    const gen = liveGen;
    setTimeout(() => {
      if (liveWanted && liveGen === gen) {
        startLive();
      }
    }, ms);
  }

  /** Joins the stream running on the instance (a snapshot's, a recording's), or waits for the next; starts none. */
  function joinLive(): void {
    if (!camera) {
      return;
    }
    cancelRestart();
    sub?.close();
    sub = subscribeLive(hub, camera.alias, instOf(camera, CAMERA), onFrame, { onEvent });
  }

  function stopLive(): void {
    liveGen++;
    cancelRestart();
    liveWanted = false;
    sub?.close();
    sub = null;
    setStreamState(recordRun ? 'recording' : 'idle', false);
    $('live-stream').textContent = 'no stream';
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
  function retryAfter(why: string): void {
    cancelRestart();
    sub?.close();
    sub = null;
    const ms = backoff.fail();
    restartAt = Date.now() + ms;
    restartWhy = why;
    document.body.dataset.retryMs = String(ms);
    showRestart();
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (liveWanted) {
        startLive();
      }
    }, ms);
  }

  liveBtn.addEventListener('click', () => {
    if (liveWanted) {
      stopLive();
    } else {
      backoff.succeed();
      startLive();
    }
  });
  liveInterval.addEventListener('change', () => {
    if (!camera) {
      return;
    }
    liveOpts = clampLive({ intervalMs: Number(liveInterval.value) });
    liveInterval.value = String(liveOpts.intervalMs);
    saveLive(store, camera.alias, liveOpts);
    if (liveWanted) {
      // leave, so the hub ends the stream this page started, then start one with the new interval
      sub?.close();
      sub = null;
      startLiveLater(600);
    }
  });

  downloadBtn.addEventListener('click', () => {
    if (!lastFrame || !camera) {
      return;
    }
    const url = URL.createObjectURL(lastFrame);
    const a = document.createElement('a');
    a.href = url;
    a.download = frameFileName(camera.alias, new Date());
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  // ---- settings ----

  function showSettings(): void {
    settingEls.frame_size.value = settings.frame_size;
    settingEls.quality.value = String(settings.quality);
    settingEls.brightness.value = String(settings.brightness);
    settingEls.contrast.value = String(settings.contrast);
    settingEls.saturation.value = String(settings.saturation);
    settingEls.vflip.checked = settings.vflip;
    settingEls.hmirror.checked = settings.hmirror;
    showSettingOutputs();
  }

  function showSettingOutputs(): void {
    $('quality-out').textContent = settingEls.quality.value;
    $('brightness-out').textContent = settingEls.brightness.value;
    $('contrast-out').textContent = settingEls.contrast.value;
    $('saturation-out').textContent = settingEls.saturation.value;
  }

  function readSettings(): CameraSettings {
    return {
      frame_size: settingEls.frame_size.value as CameraSettings['frame_size'],
      quality: Number(settingEls.quality.value),
      brightness: Number(settingEls.brightness.value),
      contrast: Number(settingEls.contrast.value),
      saturation: Number(settingEls.saturation.value),
      vflip: settingEls.vflip.checked,
      hmirror: settingEls.hmirror.checked,
    };
  }

  /**
   * camera_set with `patch`, which `settings` already holds. Taken: remembered for the camera (and no longer refused).
   * Refused (a frame size past the build's max_frame_size): the fields go back to `previous` in `settings` and the
   * controls, nothing is remembered, and the live view's start leaves the refused values out. Offline: remembered,
   * sent by Apply all later.
   */
  async function applySettings(patch: SettingsPatch, previous: CameraSettings): Promise<void> {
    if (!camera || Object.keys(patch).length === 0) {
      return;
    }
    const cam = camera;
    const state = $('settings-state');
    const what = Object.entries(patch)
      .map(([k, v]) => `${k} ${String(v)}`)
      .join(', ');
    if (!cam.online) {
      saveSettings(store, cam.alias, settings);
      state.textContent = `Remembered (${what}); ${cam.alias} is ${cam.presence}, so it is not sent.`;
      return;
    }
    state.textContent = `sending ${what}…`;
    try {
      await ops.op('camera_set', { device: cam.alias, ...patch });
      if (camera !== cam) {
        return;
      }
      refused = markAccepted(refused, patch);
      saveSettings(store, cam.alias, settings);
      state.textContent = `set ${what}`;
      showError(null);
      if (liveWanted && needsLiveRestart(patch)) {
        // The running view was started with frame_size and quality as the stream's own override, which the board keeps
        // for the stream's length (§10): leave, so the hub ends it, and start one with the new values (as the interval
        // change does; a Start or Stop pressed meanwhile wins through liveGen). The other settings apply to the next frame.
        state.textContent = `set ${what}; restarting the live view`;
        sub?.close();
        sub = null;
        startLiveLater(600);
      }
    } catch (e) {
      if (camera !== cam) {
        return;
      }
      settings = revertSettings(settings, patch, previous);
      refused = markRefused(refused, patch);
      showSettings();
      state.textContent = `camera_set failed: ${errText(e)}`;
    }
  }

  for (const [key, el] of Object.entries(settingEls)) {
    el.addEventListener('input', showSettingOutputs);
    el.addEventListener('change', () => {
      if (!camera) {
        return;
      }
      const previous = settings;
      const next = readSettings();
      const patch = diffSettings(previous, next);
      settings = next;
      void applySettings(key in patch ? patch : { [key]: next[key as keyof CameraSettings] }, previous);
    });
  }
  applyAllBtn.addEventListener('click', () => void applySettings({ ...settings }, settings));

  // ---- the flash LED ----

  flashBtn.addEventListener('click', () => {
    if (!camera || !flashInst) {
      return;
    }
    flashBtn.disabled = true;
    camera.raw
      .call(flashInst, 'set', { on: !flashOn() }, { ack: 'none' })
      .then(
        () => showError(null),
        (e: unknown) => showError(`${camera?.alias} ${flashInst} set: ${errText(e)}`),
      )
      .finally(() => updateControls());
  });

  // ---- snapshot ----

  async function withBusyRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let i = 0; ; i++) {
      try {
        return await fn();
      } catch (e) {
        if (!isBusy(e) || i >= BUSY_RETRIES) {
          throw e;
        }
        await sleep(BUSY_RETRY_MS);
      }
    }
  }

  snapBtn.addEventListener('click', async () => {
    if (!camera || snapping) {
      return;
    }
    const cam = camera;
    const out = $('snap-result');
    snapping = true;
    // The board streams one thing at a time: the live view pauses for the shot (its socket leaves, so the hub ends the
    // stream this page started) and resumes after. The snapshot's own stream is `live: false`, so nothing shows it
    // meanwhile; the Start button is disabled while the shot is taken, and a start scheduled here runs only while no
    // Start or Stop came in between (liveGen).
    const resume = liveWanted;
    if (liveWanted) {
      stopLive();
    }
    const gen = liveGen;
    updateControls();
    out.textContent = 'taking a snapshot…';
    try {
      const r = await withBusyRetry(() => ops.runJob<CameraSnap>('camera_snap', { device: cam.alias, flash: snapFlash.checked }).done);
      out.textContent = `${r.path} · ${formatBytes(r.bytes)} · ${r.width}×${r.height} ${r.frame_size} q${r.quality} · ${Math.round(r.ms)} ms${r.flash ? ' · flash' : ''}`;
      out.dataset.path = r.path;
      showError(null);
    } catch (e) {
      out.textContent = `camera_snap failed: ${errText(e)}`;
      out.dataset.path = '';
    } finally {
      snapping = false;
      updateControls();
      if (resume) {
        await sleep(300);
        if (camera === cam && !recordRun && liveGen === gen) {
          startLive();
        }
      }
    }
  });

  // ---- record to the card ----

  function readRecord(): RecordOptions {
    return clampRecord({ intervalS: Number(recEls.interval.value), durationS: Number(recEls.duration.value), alsoLive: recEls.live.checked });
  }
  for (const el of Object.values(recEls)) {
    el.addEventListener('change', () => {
      recOpts = readRecord();
      recEls.interval.value = String(recOpts.intervalS);
      recEls.duration.value = String(recOpts.durationS);
      if (camera) {
        saveRecord(store, camera.alias, recOpts);
      }
    });
  }

  function showRecordJob(j: Job): void {
    recordJob = j;
    const pill = $('record-state');
    const msg = j.progress?.message ?? j.stage ?? j.status;
    pill.textContent = j.status === 'working' || j.status === 'queued' ? `recording · ${msg}` : j.status;
  }

  async function startRecord(): Promise<void> {
    if (!camera || recordRun) {
      return;
    }
    const cam = camera;
    recOpts = readRecord();
    saveRecord(store, cam.alias, recOpts);
    const input = recordStreamInput(recOpts);
    const result = $('record-result');
    stopLive(); // one stream per instance: the recording is the stream; `also live` joins it below
    result.textContent = `starting a recording to ${input.to} (every ${input.interval_ms} ms, ${input.seconds ? `${input.seconds} s` : 'until stopped'})…`;
    const run = ops.runJob<CameraStream>('camera_stream', { device: cam.alias, ...input }, { onJob: showRecordJob });
    recordRun = run;
    updateControls();
    setStreamState('recording', false);
    if (recOpts.alsoLive) {
      joinLive();
    }
    try {
      const r = await withBusyRetry(() => run.done);
      result.textContent = `recording ${r.stream_id}: ${r.frames} frames, ${r.dropped} dropped, ${formatBytes(r.bytes)}, ${r.fps.toFixed(1)} fps, ${r.seconds.toFixed(1)} s, ended ${r.reason}${r.path ? ` · ${r.path}` : ''}`;
      result.dataset.streamId = String(r.stream_id);
      showError(null);
    } catch (e) {
      result.textContent = `camera_stream failed: ${errText(e)}`;
    } finally {
      if (recordRun === run) {
        recordRun = null;
        recordJob = null;
      }
      $('record-state').textContent = 'idle';
      if (!liveWanted) {
        sub?.close();
        sub = null;
        setStreamState('idle', false);
        $('live-stream').textContent = 'no stream';
      }
      updateControls();
      void refreshRecordingsSoon();
    }
  }

  recordBtn.addEventListener('click', () => {
    if (recordRun) {
      recordBtn.disabled = true;
      $('record-state').textContent = 'stopping…';
      recordRun.cancel().catch((e: unknown) => showError(`job_cancel: ${errText(e)}`));
    } else {
      void startRecord();
    }
  });

  // ---- the card's recordings ----

  function renderCard(): void {
    const el = $('card-state');
    el.textContent = cardText(recordings.card);
    el.dataset.sd = recordings.card.sd ?? '';
  }

  function renderRecordings(): void {
    renderCard();
    const body = $('recordings');
    const count = $('recordings-count');
    count.textContent = String(recordings.count);
    count.dataset.n = String(recordings.count);
    document.querySelector('.card.recordings')!.setAttribute('data-n', String(recordings.count));
    $('recordings-empty').hidden = recordings.count > 0 || recordings.listedAt === null;
    $('recordings-empty').textContent = recordings.listedAt === null ? 'No recordings listed yet.' : 'The card holds no recordings.';
    body.replaceChildren(
      ...recordings.rows.map((r) => {
        const tr = document.createElement('tr');
        tr.dataset.id = String(r.id);
        const id = document.createElement('td');
        id.className = 'id';
        id.textContent = `${r.id} (${r.hex})`;
        const frames = document.createElement('td');
        frames.className = 'num';
        frames.textContent = String(r.frames);
        const bytes = document.createElement('td');
        bytes.className = 'num';
        bytes.textContent = formatBytes(r.bytes);
        bytes.title = `${r.bytes} B, ${formatBytes(r.perFrame)} per frame`;
        const actions = document.createElement('td');
        actions.className = 'actions';
        const fetchBtn = document.createElement('button');
        fetchBtn.type = 'button';
        fetchBtn.textContent = 'Fetch';
        fetchBtn.title = 'camera_sd_fetch: the frames to a directory on the hub';
        fetchBtn.disabled = recordings.busy.has(r.id) || recordRun !== null || !camera?.online;
        fetchBtn.addEventListener('click', () => void fetchRecording(r.id));
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.textContent = 'Delete';
        delBtn.className = 'danger';
        delBtn.disabled = recordings.busy.has(r.id) || !camera?.online;
        delBtn.addEventListener('click', () => void deleteRecording(r.id));
        actions.append(fetchBtn, delBtn);
        tr.append(id, frames, bytes, actions);
        return tr;
      }),
    );
  }

  /** The list's own note under the table ("no card", a failed list); null clears it, a fetch's or delete's text stays. */
  let noted = false;
  function note(text: string | null): void {
    const out = $('recordings-result');
    if (text !== null) {
      out.textContent = text;
      noted = true;
    } else if (noted) {
      out.textContent = '';
      noted = false;
    }
  }

  let listing = false;
  async function refreshRecordings(): Promise<void> {
    if (!camera || !camera.online || listing) {
      return;
    }
    if (!recordings.listable) {
      // camera_status (or the sd property) says there is no card: camera_sd_list would only answer UNSUPPORTED. The
      // header says "no card"; the list is taken when the card state becomes mounted (onCard).
      note('no card: nothing to list');
      return;
    }
    const cam = camera;
    listing = true;
    try {
      const list = await ops.op<CameraSdList>('camera_sd_list', { device: cam.alias });
      if (camera === cam) {
        recordings.set(list, nowS());
        renderRecordings();
        note(null);
      }
    } catch (e) {
      if (camera === cam) {
        note(`camera_sd_list failed: ${errText(e)}`);
      }
    } finally {
      listing = false;
    }
  }
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  function refreshRecordingsSoon(): Promise<void> {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
    }
    return new Promise((resolve) => {
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        void refreshRecordings().finally(resolve);
      }, 800);
    });
  }
  refreshBtn.addEventListener('click', () => void refreshRecordings());

  async function fetchRecording(id: number): Promise<void> {
    if (!camera) {
      return;
    }
    const cam = camera;
    const out = $('recordings-result');
    recordings.busy.add(id);
    renderRecordings();
    noted = false;
    out.textContent = `fetching recording ${id}…`;
    const passive = !liveWanted && !sub;
    if (passive) {
      joinLive(); // the fetched frames are published live when the op says so; a waiting socket shows them
    }
    try {
      const r = await withBusyRetry(() => ops.runJob<CameraStream>('camera_sd_fetch', { device: cam.alias, recording: id, live: true }).done);
      // The hub's directory of JPEGs, from the result's `path` (captures/<alias>/sd-<recording>/ under FR_HOME by default).
      out.textContent = `recording ${id}: ${r.frames} frames, ${formatBytes(r.bytes)} fetched (ended ${r.reason})${r.path ? ` · ${r.path}` : ''}`;
      out.dataset.path = r.path ?? '';
    } catch (e) {
      out.textContent = `camera_sd_fetch ${id} failed: ${errText(e)}`;
      out.dataset.path = '';
    } finally {
      recordings.busy.delete(id);
      renderRecordings();
      if (passive && !liveWanted) {
        sub?.close();
        sub = null;
        setStreamState('idle', false);
      }
    }
  }

  async function deleteRecording(id: number): Promise<void> {
    if (!camera) {
      return;
    }
    const r = recordings.get(id);
    if (!confirm(`Delete recording ${id}${r ? ` (${r.frames} frames, ${formatBytes(r.bytes)})` : ''} from ${camera.alias}'s card? Nothing on the Mac is deleted.`)) {
      return;
    }
    const cam = camera;
    const out = $('recordings-result');
    recordings.busy.add(id);
    renderRecordings();
    try {
      await ops.op('camera_sd_delete', { device: cam.alias, recording: id });
      recordings.remove(id);
      out.textContent = `recording ${id} deleted`;
      renderRecordings();
      void refreshRecordingsSoon();
    } catch (e) {
      recordings.busy.delete(id);
      renderRecordings();
      out.textContent = `camera_sd_delete ${id} failed: ${errText(e)}`;
    }
  }

  // ---- camera_status, every few seconds ----

  async function pollStatus(): Promise<void> {
    if (!camera || !camera.online || document.hidden) {
      return;
    }
    const cam = camera;
    try {
      const s = await ops.op<CameraStatus>('camera_status', { device: cam.alias });
      if (camera !== cam) {
        return;
      }
      lastStatus = s;
      if (statusFailed) {
        statusFailed = null;
        updateControls();
      }
      onCard(s.sd, s.sd_free_mb);
      if (typeof s.fps_x10 === 'number') {
        $('board-fps').textContent = s.fps_x10 ? `${(s.fps_x10 / 10).toFixed(1)} fps` : s.streaming ? 'streaming' : 'idle';
      }
      if (s.stream && !liveWanted && !recordRun && !snapping) {
        // Another client's stream runs on the board (fr camera stream, an agent): say so, the Start button joins it.
        $('live-stream').textContent = `stream ${s.stream.stream_id} to ${s.stream.to} runs (${s.stream.frames} frames, ${s.stream.subscribers} live subscribers)`;
      }
    } catch (e) {
      if (camera === cam) {
        const text = errText(e);
        if (text !== statusFailed) {
          statusFailed = text;
          updateControls();
        }
      }
    }
  }

  // ---- hub events ----

  for (const type of ['device.online', 'device.suspect', 'device.offline'] as const) {
    hub.on(type, () => refreshDevices());
  }
  hub.devices.on('added', () => refreshDevices());
  hub.on('registry.drift', () => refreshDevices());
  deviceSel.addEventListener('change', () => {
    selectCamera(hub.devices.byId(deviceSel.value) ?? null);
    refreshDevices();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      void pollStatus();
    }
  });
  showSettings(); // the defaults until a camera is picked
  refreshDevices();

  // ---- the readouts, 4 times a second ----

  setInterval(() => {
    const now = nowS();
    const set = (id: string, n: number, text = String(n)) => {
      const el = $(id);
      el.textContent = text;
      el.dataset.n = String(n);
    };
    const fps = stats.fps(now);
    const fpsEl = $('fps');
    fpsEl.textContent = `${formatFps(fps)} fps`;
    fpsEl.dataset.fps = fps.toFixed(2);
    const age = stats.age(now);
    const ageEl = $('age');
    ageEl.textContent = formatAge(age);
    ageEl.dataset.s = age === null ? '' : age.toFixed(2);
    ageEl.classList.toggle('stale', age !== null && age > 5 && (liveWanted || recordRun !== null));
    set('bytes', stats.lastBytes, stats.lastBytes ? formatBytes(stats.lastBytes) : '–');
    set('drops', stats.dropped);
    set('gaps', stats.gaps);
    set('skips', gate.dropped);
    set('total-bytes', stats.bytes, formatBytes(stats.bytes));
    if (restartTimer && restartWhy) {
      showRestart();
    }
    if (recordJob && recordRun) {
      showRecordJob(recordJob);
    }
  }, 250);

  void lastStatus;
}

main().catch((e: unknown) => {
  $('conn').textContent = 'not connected';
  showError(`${errText(e)}. Open this page from the hub: http://127.0.0.1:7420/apps/cam/`);
});
