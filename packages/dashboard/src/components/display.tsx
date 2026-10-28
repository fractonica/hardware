// The display card of an fr.display instance on the device page (design m2-c5-display D10): the panel's last
// snapshot (display_snapshot, a debug build's framebuffer read back as a PNG), a click on it a touch on the panel
// (input_simulate {x, y} on the fr.touch instance bound to it, scaled to panel pixels, then a fresh snapshot),
// and for a ui panel a layout preview (display_render of a ui_load on the desktop renderer, no board needed).
// Images arrive inline (inline: true, base64): the dashboard cannot read the hub's files.

import { type MouseEvent, useState } from 'react';

import { useAct } from '../hooks.ts';
import { Badge, Button, Mono } from './ui.tsx';

/** A starter layout for the preview (D2: UiLayout JSON, as command_send's ui_load takes it). */
const SAMPLE_LAYOUT = {
  bg: 0x101820,
  widgets: [
    { id: 'title', kind: 'label', x: 10, y: 10, text: 'Fractonica', font: 1 },
    { id: 'level', kind: 'bar', x: 10, y: 50, w: 150, h: 14, value: 60 },
    { id: 'ok', kind: 'button', x: 10, y: 80, w: 90, h: 40, text: 'OK', bg: 0x2060c0, align: 'center' },
  ],
};

/** The panel drawn at a whole-pixel scale near 240 px wide (the 72x40 OLED at 3x). */
function scaleOf(width: number): number {
  return width > 0 ? Math.max(1, Math.floor(240 / width)) : 1;
}

/** A PNG the hub sent inline, at the panel's scale, pixels kept sharp; `onPoint` gets panel coordinates. */
function PanelImage({ png, width, height, label, onPoint }: { png: string; width: number; height: number; label: string; onPoint?: (x: number, y: number) => void }) {
  const scale = scaleOf(width);
  const click = (e: MouseEvent<HTMLImageElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = Math.min(width - 1, Math.max(0, Math.floor(((e.clientX - r.left) * width) / r.width)));
    const y = Math.min(height - 1, Math.max(0, Math.floor(((e.clientY - r.top) * height) / r.height)));
    onPoint?.(x, y);
  };
  return (
    <img
      src={`data:image/png;base64,${png}`}
      alt={label}
      width={width * scale}
      height={height * scale}
      onClick={onPoint ? click : undefined}
      title={onPoint ? 'click: a tap here (input_simulate on the touch instance)' : undefined}
      className={`rounded border border-line bg-black ${onPoint ? 'cursor-crosshair' : ''}`}
      style={{ imageRendering: 'pixelated' }}
    />
  );
}

export function DisplayCard({ deviceId, inst, traits, touch, profile }: { deviceId: string; inst: string; traits: Record<string, unknown> | null; touch: string | null; profile: string | null }) {
  const selector = `id:${deviceId}`;
  const ui = traits?.ui === true;
  const snap = useAct('display_snapshot');
  const tap = useAct('input_simulate', { done: (r) => (r.results[0]?.status === 'ok' ? undefined : { tone: 'warn', title: `${touch ?? 'touch'}: ${r.results[0]?.status ?? 'no answer'}` }) });
  const render = useAct('display_render');
  const [text, setText] = useState(() => JSON.stringify(SAMPLE_LAYOUT, null, 2));
  const [last, setLast] = useState<{ x: number; y: number } | null>(null);
  const row = snap.data?.results[0];
  const shoot = () => snap.mutate({ selector, instance: inst, inline: true });
  const onPoint =
    touch && row?.status === 'ok'
      ? (x: number, y: number) => {
          setLast({ x, y });
          // The panel redraws on its flush period (~20 ms) after the touch: then the next snapshot shows it.
          tap.mutate({ selector, instance: touch, x, y, gesture: 'tap' }, { onSuccess: () => setTimeout(shoot, 250) });
        }
      : undefined;
  let layout: unknown = null;
  let parseError: string | null = null;
  try {
    layout = JSON.parse(text);
  } catch (e) {
    parseError = (e as Error).message;
  }
  const preview = render.data;
  return (
    <div className="mt-2 flex flex-col gap-2 border-t border-line pt-2" data-display={inst}>
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={snap.isPending} onClick={shoot} title="read the framebuffer back (display_snapshot; debug builds)" data-action="snapshot">
          {snap.isPending ? 'Reading…' : 'Snapshot'}
        </Button>
        {row ? (
          <span className="text-xs" data-snapshot={row.status}>
            <Badge tone={row.status === 'ok' ? 'ok' : 'warn'}>{row.status}</Badge>
            {row.status === 'ok' ? (
              <Mono className="text-muted">
                {' '}
                {row.width}x{row.height} {row.format} · crc {row.crc?.toString(16)} · {row.ms} ms{row.link ? ` · ${row.link}` : ''}
              </Mono>
            ) : (
              <span className="text-bad"> {row.error}</span>
            )}
          </span>
        ) : null}
        {touch && row?.status === 'ok' ? <span className="text-xs text-muted">click the image to tap {touch}{last ? ` (last ${last.x}, ${last.y})` : ''}</span> : null}
      </div>
      {row?.status === 'ok' && row.png_base64 && row.width && row.height ? (
        <PanelImage png={row.png_base64} width={row.width} height={row.height} label={`${inst} snapshot`} onPoint={onPoint} />
      ) : null}
      {ui && profile ? (
        <form
          className="flex flex-col gap-1.5"
          data-preview={inst}
          onSubmit={(e) => {
            e.preventDefault();
            if (!parseError) {
              render.mutate({ profile, instance: inst, commands: [{ cmd: 'ui_load', args: { layout: layout as Record<string, unknown> } }], inline: true });
            }
          }}
        >
          <label className="text-xs text-muted" htmlFor={`layout-${deviceId}-${inst}`}>
            Layout (UiLayout JSON) previewed on the desktop renderer for {profile}
          </label>
          <textarea
            id={`layout-${deviceId}-${inst}`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={8}
            spellCheck={false}
            aria-label={`${inst} layout`}
            className="rounded border border-line bg-bg px-2 py-1 font-mono text-xs outline-none focus:border-accent"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" tone="ghost" disabled={Boolean(parseError) || render.isPending} data-action="preview">
              {render.isPending ? 'Rendering…' : 'Preview layout'}
            </Button>
            {parseError ? <span className="text-xs text-bad">{parseError}</span> : null}
            {preview && !render.isPending ? (
              <Mono className="text-xs text-muted">
                {preview.width}x{preview.height} {preview.format} · crc {preview.crc.toString(16)} · {preview.ms} ms
                {preview.events.length ? ` · ${preview.events.length} ui events` : ''}
              </Mono>
            ) : null}
          </div>
          {preview?.png_base64 ? <PanelImage png={preview.png_base64} width={preview.width} height={preview.height} label={`${inst} layout preview`} /> : null}
        </form>
      ) : null}
    </div>
  );
}
