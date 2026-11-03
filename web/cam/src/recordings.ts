// The card's recordings as the page shows them (design camera-c1 D13): camera_sd_list's rows (id, frames, bytes) kept in
// a model with the card's state and free space, newest first, with the totals and the per-row text the table renders.
// DOM-free; main.ts renders it.

import type { CameraRecording, CameraSdList, CameraSdState } from '@fractonica/protocol/browser';

export type { CameraRecording, CameraSdState };

export interface RecordingRow {
  id: number;
  frames: number;
  bytes: number;
  /** `0x0000002a`: the recording's directory name on the card (`/sdcard/fr/<id 8 hex>/`). */
  hex: string;
  /** Bytes per frame, 0 for an empty recording. */
  perFrame: number;
}

export interface CardInfo {
  sd: CameraSdState | null;
  freeMb: number | null;
}

/** The card's state in words. */
export function cardText(c: CardInfo): string {
  switch (c.sd) {
    case 'mounted':
      return c.freeMb === null ? 'card mounted' : `card mounted · ${formatMb(c.freeMb)} free`;
    case 'none':
      return 'no card';
    case 'error':
      return 'card error';
    default:
      return 'card: unknown';
  }
}

/** `512 MB`, `29.3 GB`. */
export function formatMb(mb: number): string {
  if (!Number.isFinite(mb) || mb < 0) {
    return '–';
  }
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

export const recordingHex = (id: number) => `0x${(id >>> 0).toString(16).padStart(8, '0')}`;

export class RecordingsModel {
  #rows: RecordingRow[] = [];
  card: CardInfo = { sd: null, freeMb: null };
  /** When the list was last taken (the page's clock, seconds), null before the first. */
  listedAt: number | null = null;
  /** The ids of recordings a fetch or delete is in flight for (their buttons are disabled). */
  readonly busy = new Set<number>();

  /** Replaces the rows with camera_sd_list's answer (oldest first on the wire; newest first here). */
  set(list: Pick<CameraSdList, 'recordings' | 'sd' | 'sd_free_mb'>, now: number): void {
    this.#rows = [...list.recordings].map(toRow).sort((a, b) => b.id - a.id);
    this.card = { sd: list.sd, freeMb: list.sd_free_mb };
    this.listedAt = now;
  }

  /**
   * The card's figures from camera_status or the sd / sd_free_mb properties, without a new list. Returns whether the
   * list should be taken now: the card is mounted and was not (or was never listed). A card that went (`none`, `error`)
   * takes its recordings off the table; the page shows "no card" and lists again once it is mounted.
   */
  setCard(sd: CameraSdState | null, freeMb: number | null): boolean {
    const was = this.card.sd;
    this.card = { sd, freeMb };
    if (sd !== 'mounted') {
      if (sd !== null) {
        this.#rows = [];
        this.listedAt = null;
      }
      return false;
    }
    return was !== 'mounted' || this.listedAt === null;
  }

  /** Whether camera_sd_list is worth a call: never while the board says there is no card (UNSUPPORTED then). */
  get listable(): boolean {
    return this.card.sd !== 'none';
  }

  /** A recording the card no longer has (after camera_sd_delete). */
  remove(id: number): void {
    this.#rows = this.#rows.filter((r) => r.id !== id);
    this.busy.delete(id);
  }

  /** The newest recording's row, or null. */
  get(id: number): RecordingRow | undefined {
    return this.#rows.find((r) => r.id === id);
  }

  get rows(): readonly RecordingRow[] {
    return this.#rows;
  }

  get count(): number {
    return this.#rows.length;
  }

  /** Frames and bytes over every recording. */
  get totals(): { frames: number; bytes: number } {
    let frames = 0;
    let bytes = 0;
    for (const r of this.#rows) {
      frames += r.frames;
      bytes += r.bytes;
    }
    return { frames, bytes };
  }

  clear(): void {
    this.#rows = [];
    this.card = { sd: null, freeMb: null };
    this.listedAt = null;
    this.busy.clear();
  }
}

function toRow(r: CameraRecording): RecordingRow {
  return { id: r.id, frames: r.frames, bytes: r.bytes, hex: recordingHex(r.id), perFrame: r.frames > 0 ? Math.round(r.bytes / r.frames) : 0 };
}
