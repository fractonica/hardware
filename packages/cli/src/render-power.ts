// Human rendering of the power ops (design power-p1 D11): `fr battery status` as one line per cell place, `fr battery
// calibrate|reset|load`, `fr cell list|show|add|update|install|uninstall`, `fr cell test` (a cell job) as one summary line
// after the job's head, `fr haptic pulse|play|stop`. render.ts dispatches here.

type Row = Record<string, unknown>;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const who = (r: Row) => `${String(r.alias ?? r.device)} ${String(r.instance ?? '')}`.trim();

/** Millivolts as volts with three decimals, `- V` for none. */
export function formatVolts(mv: unknown): string {
  return isNum(mv) ? `${(mv / 1000).toFixed(3)} V` : '- V';
}

/** A duration in seconds as `1 h 05 min`, `12 min`, `45 s`; `-` for none. */
export function formatDuration(s: unknown): string {
  if (!isNum(s)) {
    return '-';
  }
  const t = Math.round(s);
  if (t < 60) {
    return `${t} s`;
  }
  const m = Math.round(t / 60);
  if (m < 60) {
    return `${m} min`;
  }
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

/** battery_status: one line per instance. */
export function renderBatteryStatus(r: Row): string {
  const rows = Array.isArray(r.batteries) ? (r.batteries as Row[]) : [];
  if (!rows.length) {
    return 'no fr.battery instance on these devices';
  }
  return rows
    .map((b) => {
      const e = (b.estimate ?? {}) as Row;
      const cell = b.cell as Row | null;
      const parts = [
        `${who(b)}${b.online === false ? ' (offline)' : ''}: ${formatVolts(b.mv)}`,
        isNum(e.percent_learned) ? `${e.percent_learned} % (learned)` : isNum(b.percent) ? `${b.percent} %` : null,
        b.charger ? String(b.charger) : null,
        b.level && b.level !== 'ok' ? `level ${String(b.level)}` : null,
        b.load_on ? 'test load on' : null,
        b.gate_open === true ? 'gate open' : null,
        isNum(e.time_to_full_s) && b.charger === 'charging' ? `full in ${formatDuration(e.time_to_full_s)}` : null,
        isNum(e.time_to_low_s) ? `low in ${formatDuration(e.time_to_low_s)}` : null,
        cell ? `cell ${String(cell.name)} (${String(cell.chemistry)})` : b.chemistry ? `${String(b.chemistry)}, no cell registered` : 'no cell registered',
        b.test_job ? `capacity test ${String(b.test_job)}` : null,
      ];
      return parts.filter(Boolean).join(', ');
    })
    .join('\n');
}

export function renderBatteryCalibrate(r: Row): string {
  return `${who(r)} calibrated to ${formatVolts(r.meter_mv)}: divider ${isNum(r.divider_milli) ? (r.divider_milli / 1000).toFixed(3) : '-'} (pin ${formatVolts(r.adc_mv)}), kept across reboots`;
}

export function renderBatteryReset(r: Row): string {
  return `${who(r)}: calibration reset (the profile's divider)`;
}

export function renderBatteryLoad(r: Row): string {
  return r.on ? `${who(r)}: test load on for ${formatDuration(r.seconds)} (off by itself at the end, at the floor and at boot)` : `${who(r)}: test load off`;
}

function learnedText(l: Row | undefined): string {
  if (!l) {
    return '';
  }
  const parts = [
    `${isNum(l.cycles) ? l.cycles : 0} cycles`,
    isNum(l.capacity_mah) ? `${l.capacity_mah} mAh tested` : null,
    isNum(l.health_pct) ? `health ${l.health_pct} %` : null,
    isNum(l.r_int_mohm) ? `R_int ${l.r_int_mohm} mΩ` : null,
    isNum(l.last_charge_s) ? `last charge ${formatDuration(l.last_charge_s)}` : null,
    isNum(l.last_discharge_s) ? `last discharge ${formatDuration(l.last_discharge_s)}` : null,
  ];
  return parts.filter(Boolean).join(', ');
}

function cellLine(c: Row): string {
  const at = c.installed as Row | null;
  return `${String(c.name)}: ${String(c.chemistry)}${isNum(c.nominal_mah) ? ` ${c.nominal_mah} mAh` : ''}, ${at ? `in ${String(at.alias)} ${String(at.instance)}` : 'not installed'}; ${learnedText(c.learned as Row)}`;
}

export function renderCellList(r: Row): string {
  const cells = Array.isArray(r.cells) ? (r.cells as Row[]) : [];
  return cells.length ? cells.map(cellLine).join('\n') : 'no cells registered (fr cell add <name> --chemistry liion|lifepo4|lic)';
}

export function renderCell(r: Row): string {
  return cellLine(r) + (r.notes ? `\n  notes: ${String(r.notes)}` : '');
}

export function renderCellShow(r: Row): string {
  const lines = [renderCell(r)];
  const sessions = Array.isArray(r.sessions) ? (r.sessions as Row[]) : [];
  for (const s of sessions) {
    lines.push(
      `  #${String(s.id)} ${String(s.kind)} ${String(s.started)} ${s.ended ? formatDuration(s.duration_s) : 'running'}: ${formatVolts(s.start_mv)} -> ${formatVolts(s.end_mv)}${s.complete ? ', complete' : ''}${isNum(s.mah) ? `, ${s.mah} mAh` : ''}${isNum(s.r_int_mohm) ? `, R_int ${s.r_int_mohm} mΩ` : ''} (${String(s.alias)} ${String(s.instance)})`,
    );
  }
  if (!sessions.length) {
    lines.push('  no sessions yet');
  }
  return lines.join('\n');
}

export function renderCellInstall(r: Row): string {
  return `cell ${String(r.cell)} installed in ${who(r)}${r.replaced ? ` (replacing ${String(r.replaced)})` : ''}${r.warning ? `\nwarning: ${String(r.warning)}` : ''}`;
}

export function renderCellUninstall(r: Row): string {
  const w = r.was as Row | null;
  return w ? `cell ${String(r.cell)} taken out of ${String(w.alias)} ${String(w.instance)}` : `cell ${String(r.cell)} was not installed`;
}

/** cell_test's result as one summary line. */
export function renderCellTest(r: Row): string {
  const figures = [
    isNum(r.mah) ? `${r.mah} mAh` : null,
    isNum(r.wh) ? `${r.wh} Wh` : null,
    isNum(r.r_int_mohm) ? `R_int ${r.r_int_mohm} mΩ` : null,
    `${formatDuration(r.duration_s)} under load`,
    `${formatVolts(r.rest_mv)} -> ${formatVolts(r.end_mv)}`,
  ];
  return `cell ${String(r.cell)} test (${who(r)} via ${String(r.via)}${isNum(r.load_ohm) ? ` ${r.load_ohm} Ω` : ''}, to ${String(r.target)}): ${String(r.reason)}; ${figures.filter(Boolean).join(', ')}`;
}

export function renderHapticPulse(r: Row): string {
  return `${who(r)}: pulse ${String(r.ms)} ms at ${String(r.level)} %`;
}

export function renderHapticPlay(r: Row): string {
  return `${who(r)}: playing ${Array.isArray(r.steps) ? r.steps.join(',') : ''} at ${String(r.level)} % x${String(r.repeat)} (${String(r.total_ms)} ms)`;
}

export function renderHapticStop(r: Row): string {
  return `${who(r)}: stopped`;
}

/** The power renderer of an op's data, or null for another op. */
export function powerRenderer(op: string): ((r: Row) => string) | null {
  switch (op) {
    case 'battery_status':
      return renderBatteryStatus;
    case 'battery_calibrate':
      return renderBatteryCalibrate;
    case 'battery_reset_calibration':
      return renderBatteryReset;
    case 'battery_load':
      return renderBatteryLoad;
    case 'cell_list':
      return renderCellList;
    case 'cell_show':
      return renderCellShow;
    case 'cell_add':
    case 'cell_update':
      return renderCell;
    case 'cell_install':
      return renderCellInstall;
    case 'cell_uninstall':
      return renderCellUninstall;
    case 'haptic_pulse':
      return renderHapticPulse;
    case 'haptic_play':
      return renderHapticPlay;
    case 'haptic_stop':
      return renderHapticStop;
    default:
      return null;
  }
}
