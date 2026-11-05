// Human rendering of the LCD-1 / CLOCK-1 ops (design lcd-clock-c1 D9): `fr storage info|ls|rm|mkdir`, the storage jobs
// (`fr storage get|put|bench`) as one summary line after the job's head, `fr clock read|sync|set|aging`, and `fr clock
// drift` (a clock job). render.ts dispatches here.

type Row = Record<string, unknown>;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const who = (r: Row) => `${String(r.alias ?? r.device)} ${String(r.instance ?? '')}`.trim();

/** Bytes as B, KB, MB (1,024-based) with one decimal past a KB. */
export function formatBytes(b: unknown): string {
  if (!isNum(b)) {
    return '-';
  }
  if (b < 1024) {
    return `${b} B`;
  }
  if (b < 1024 * 1024) {
    return `${(b / 1024).toFixed(1)} KB`;
  }
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

const rate = (v: unknown) => (isNum(v) ? `${v.toFixed(1)} KB/s` : '- KB/s');

export function renderStorageInfo(r: Row): string {
  const head = `${who(r)}: ${String(r.state)}`;
  if (r.state !== 'mounted') {
    return `${head}${r.state === 'none' ? ' (no card, or it did not mount: reseat it and run this again)' : ' (the card or its filesystem failed; FAT32 is expected)'}`;
  }
  const used = isNum(r.total_mb) && isNum(r.free_mb) ? r.total_mb - r.free_mb : null;
  return [
    head,
    `${String(r.card_type).toUpperCase()}${r.name ? ` "${String(r.name)}"` : ''}`,
    `${isNum(r.free_mb) ? r.free_mb : '-'} MB free of ${isNum(r.total_mb) ? r.total_mb : '-'} MB${used !== null ? ` (${used} MB used)` : ''}`,
    isNum(r.speed_khz) && r.speed_khz > 0 ? `SPI ${(r.speed_khz / 1000).toFixed(1)} MHz` : null,
    r.card_detect === false ? 'no card detect' : null,
  ]
    .filter(Boolean)
    .join(', ');
}

/** storage_ls: directories first (with a slash), then files with their sizes. */
export function renderStorageLs(r: Row): string {
  const entries = Array.isArray(r.entries) ? (r.entries as Row[]) : [];
  if (!entries.length) {
    return `${who(r)} ${String(r.path)}: empty`;
  }
  const sorted = [...entries].sort((a, b) => Number(b.dir === true) - Number(a.dir === true) || String(a.name).localeCompare(String(b.name)));
  const width = Math.max(...sorted.map((e) => formatBytes(e.size).length));
  const lines = sorted.map((e) => {
    const when = isNum(e.mtime) && e.mtime > 0 ? new Date(e.mtime * 1000).toISOString().slice(0, 16).replace('T', ' ') : '';
    return e.dir === true ? `${''.padStart(width)}  ${String(e.name)}/` : `${formatBytes(e.size).padStart(width)}  ${String(e.name)}${when ? `  ${when}` : ''}`;
  });
  return [`${who(r)} ${String(r.path)} (${entries.length} entr${entries.length === 1 ? 'y' : 'ies'})`, ...lines].join('\n');
}

export function renderStoragePath(op: 'removed' | 'made') {
  return (r: Row) => `${who(r)}: ${op} ${String(r.path)}`;
}

/** A storage job's result (get, put or bench) as one line. */
export function renderStorageJob(r: Row): string {
  const stopped = r.reason === 'stopped' ? ' (stopped)' : '';
  if ('identical' in r) {
    return `${who(r)} bench ${formatBytes(r.bytes)} at ${String(r.card_path)}: write ${rate(r.write_kb_s)}, read ${rate(r.read_kb_s)}, ${
      r.identical === true ? 'identical' : isNum(r.mismatch_at) ? `DIFFERS at byte ${r.mismatch_at}` : 'incomplete'
    }${r.removed === true ? '' : ', file left on the card'}${stopped}`;
  }
  if ('file' in r) {
    return `${who(r)}: put ${String(r.file)} -> ${String(r.card_path)}, ${formatBytes(r.bytes)} in ${isNum(r.ms) ? r.ms : '-'} ms (${rate(r.kb_s)})${stopped}`;
  }
  const short = isNum(r.bytes) && isNum(r.size) && r.bytes < r.size ? `, ${formatBytes(r.bytes)} of ${formatBytes(r.size)}` : '';
  return `${who(r)}: got ${String(r.card_path)} -> ${String(r.path)}, ${formatBytes(r.bytes)} in ${isNum(r.ms) ? r.ms : '-'} ms (${rate(r.kb_s)})${short}${stopped}`;
}

const signedMs = (v: unknown) => (isNum(v) ? `${v > 0 ? '+' : ''}${v} ms` : '-');

export function renderClockRead(r: Row): string {
  const parts = [
    `${who(r)}: ${String(r.iso)}`,
    r.valid === true ? 'valid' : r.osf === true ? 'NOT valid (it lost power: run fr clock sync)' : 'NOT valid (never set: run fr clock sync)',
    isNum(r.error_ms) ? `${signedMs(r.error_ms)} against the Mac${isNum(r.uncertainty_ms) ? ` (±${r.uncertainty_ms} ms)` : ''}` : 'offset unknown (link clock not synced yet)',
    isNum(r.temp_c) ? `${r.temp_c.toFixed(2)} °C` : null,
    isNum(r.aging) && r.aging !== 0 ? `aging ${r.aging}` : null,
    r.injected === true ? 'injected' : null,
  ];
  return parts.filter(Boolean).join(', ');
}

export function renderClockSet(r: Row): string {
  return r.by === 'sync'
    ? `${who(r)} set to ${String(r.iso)} at its second boundary (aimed ${isNum(r.lead_ms) ? r.lead_ms : '-'} ms ahead${isNum(r.uncertainty_ms) ? `, link clock ±${r.uncertainty_ms} ms` : ''})`
    : `${who(r)} set to ${String(r.iso)}`;
}

export function renderClockAging(r: Row): string {
  return `${who(r)} aging offset ${String(r.offset)} (about ${isNum(r.offset) ? (r.offset * 0.1).toFixed(1) : '-'} ppm slower)`;
}

export function renderClockDrift(r: Row): string {
  if (!isNum(r.ppm)) {
    return `${who(r)}: ${String(r.samples)} sample(s) over ${String(r.span_s)} s, too few to fit a drift${r.reason === 'stopped' ? ' (stopped)' : ''}`;
  }
  const fast = r.ppm >= 0 ? 'fast' : 'slow';
  return [
    `${who(r)}: ${Math.abs(r.ppm).toFixed(2)} ppm ${fast} (${isNum(r.s_per_day) ? Math.abs(r.s_per_day).toFixed(3) : '-'} s a day)`,
    `${String(r.samples)} samples over ${String(r.span_s)} s, residual ${isNum(r.residual_ms) ? r.residual_ms : '-'} ms`,
    isNum(r.aging_suggest) && r.aging_suggest !== r.aging ? `fr clock aging ${String(r.alias ?? r.device)} ${r.aging_suggest} would cancel it` : null,
    r.reason === 'stopped' ? 'stopped' : null,
  ]
    .filter(Boolean)
    .join(', ');
}

export function storageClockRenderer(op: string): ((r: Row) => string) | null {
  switch (op) {
    case 'storage_info':
      return renderStorageInfo;
    case 'storage_ls':
      return renderStorageLs;
    case 'storage_rm':
      return renderStoragePath('removed');
    case 'storage_mkdir':
      return renderStoragePath('made');
    case 'clock_read':
      return renderClockRead;
    case 'clock_sync':
    case 'clock_set':
      return renderClockSet;
    case 'clock_aging':
      return renderClockAging;
    default:
      return null;
  }
}
