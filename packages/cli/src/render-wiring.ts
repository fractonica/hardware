// Human rendering of the wiring ops (design wiring-w1 D4): `fr wiring list|show|done|undo|reset|check|reload|shopping`
// and `fr parts list|show|stock`. render.ts dispatches here. A guide reads top to bottom as at the bench: safety,
// parts, sections with their steps ([x] done) and the check after each, then the pin table and its check.

type Row = Record<string, unknown>;

const arr = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : []);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const s = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const MARK: Record<string, string> = { ok: '✓', warning: '!', failed: '✗', unchecked: '·' };

function checkLine(r: Row): string {
  const errors = strs(r.errors);
  const warnings = strs(r.warnings);
  if (r.check === 'failed') {
    return `check FAILED (${errors.length} problem${errors.length === 1 ? '' : 's'})`;
  }
  if (r.check === 'ok') {
    return warnings.length ? `check ok, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}` : 'check ok';
  }
  return 'not checked (no profile)';
}

function refusedLines(v: unknown): string[] {
  return arr(v).flatMap((r) => [`refused ${s(r.file)}:`, ...strs(r.errors).map((e) => `  ${e}`)]);
}

export function renderWiringList(r: Row): string {
  const guides = arr(r.guides);
  const lines = guides.length
    ? guides.map((g) => `${s(g.id)}  ${s(g.title)}  ${s(g.done)}/${s(g.steps)} steps  ${checkLine(g)}${g.device ? `  (${s(g.device)})` : ''}`)
    : ['no wiring guides in hardware/wiring'];
  return [...lines, ...refusedLines(r.refused)].join('\n');
}

export function renderWiringShow(r: Row): string {
  const out: string[] = [];
  out.push(`${s(r.title)} (${s(r.id)}): ${s(r.done)}/${s(r.steps)} steps done`);
  out.push(s(r.summary));
  const where = [r.board ? `board ${s(r.board)}` : null, r.profile ? `profile ${s(r.profile)}` : null, r.device ? `device ${s(r.device)}` : null, r.design ? `design ${s(r.design)}` : null].filter(Boolean);
  if (where.length) {
    out.push(where.join(', '));
  }
  out.push(checkLine(r));
  for (const e of strs(r.errors)) {
    out.push(`  ✗ ${e}`);
  }
  for (const w of strs(r.warnings)) {
    out.push(`  ! ${w}`);
  }
  const safety = strs(r.safety);
  if (safety.length) {
    out.push('', 'Safety:');
    out.push(...safety.map((x) => `  - ${x}`));
  }
  const bom = arr(r.bom);
  if (bom.length) {
    out.push('', 'Parts:');
    for (const b of bom) {
      const missing = Number(b.missing) > 0 ? `  missing ${s(b.missing)}` : '';
      out.push(`  ${s(b.qty)} × ${s(b.name)}${b.value ? ` ${s(b.value)}` : ''} [${s(b.part)}]  have ${s(b.have)}${missing}${b.note ? `  (${s(b.note)})` : ''}`);
    }
  }
  const diagrams = new Map(arr(r.diagrams).map((d) => [s(d.id), d]));
  for (const sec of arr(r.sections)) {
    out.push('', `${s(sec.title)}:`);
    if (sec.intro) {
      out.push(`  ${s(sec.intro)}`);
    }
    if (sec.diagram && diagrams.has(s(sec.diagram))) {
      const d = diagrams.get(s(sec.diagram))!;
      out.push(`  diagram: ${s(d.title)} (${s(d.url)})`);
    }
    for (const st of arr(sec.steps)) {
      const pins = strs(st.pins);
      out.push(`  [${st.done ? 'x' : ' '}] ${s(st.id)}: ${s(st.text)}${pins.length ? `  {${pins.join(', ')}}` : ''}`);
      if (st.note) {
        out.push(`        note: ${s(st.note)}`);
      }
      if (st.check) {
        out.push(`        check: ${s(st.check)}`);
      }
    }
  }
  const conns = arr(r.connections);
  if (conns.length) {
    out.push('', 'Pin table:');
    for (const c of conns) {
      const who = c.instance ? `${s(c.instance)}${c.bind ? `.${s(c.bind)}` : ''}` : '';
      out.push(`  ${MARK[s(c.check)] ?? '·'} ${s(c.pin).padEnd(8)} ${who.padEnd(14)} ${s(c.to)}${c.via ? ` via ${s(c.via)}` : ''}${c.message ? `  [${s(c.message)}]` : ''}`);
    }
  }
  return out.join('\n');
}

export function renderWiringStep(r: Row): string {
  const steps = strs(r.steps);
  const verb = r.done ? 'done' : 'not done';
  return `${s(r.guide)}: ${steps.length ? `${steps.join(', ')} ${verb}` : 'no step changed'} (${s(r.done_count)}/${s(r.total)} done)`;
}

export function renderWiringCheck(r: Row): string {
  const out: string[] = [];
  for (const g of arr(r.guides)) {
    out.push(`${s(g.id)}: ${checkLine(g)}`);
    out.push(...strs(g.errors).map((e) => `  ✗ ${e}`), ...strs(g.warnings).map((w) => `  ! ${w}`));
  }
  out.push(...refusedLines(r.refused));
  out.push(r.ok ? 'ok' : 'FAILED');
  return out.join('\n');
}

export function renderWiringReload(r: Row): string {
  return [`loaded ${s(r.guides)} guide(s) and ${s(r.parts)} part(s)`, ...refusedLines(r.refused)].join('\n');
}

export function renderWiringShopping(r: Row): string {
  const lines = arr(r.lines);
  if (!lines.length) {
    return 'nothing to buy: no unfinished guide needs parts';
  }
  const missing = lines.filter((l) => Number(l.missing) > 0);
  const out = [`for ${strs(r.guides).join(', ')}:`];
  for (const l of lines) {
    out.push(`  ${Number(l.missing) > 0 ? `buy ${s(l.missing)}` : 'ok    '}  ${s(l.name)}${l.value ? ` ${s(l.value)}` : ''} [${s(l.part)}]  need ${s(l.need)}, have ${s(l.have)}`);
  }
  out.push(missing.length ? `${missing.length} line(s) to buy` : 'everything is on hand');
  return out.join('\n');
}

export function renderPartList(r: Row): string {
  const parts = arr(r.parts);
  const out: string[] = [];
  let cat = '';
  for (const p of parts) {
    if (p.category !== cat) {
      cat = s(p.category);
      out.push(`${cat}:`);
    }
    const values = strs(p.values);
    out.push(`  ${s(p.id).padEnd(24)} ${s(p.name)}${values.length ? ` (${values.join(', ')})` : ''}  have ${s(p.have)}`);
  }
  if (!parts.length) {
    out.push('no parts match');
  }
  return [...out, ...refusedLines(r.refused)].join('\n');
}

export function renderPartShow(r: Row): string {
  const out = [`${s(r.name)} [${s(r.id)}], ${s(r.category)}`, s(r.summary)];
  const specs = (r.specs ?? {}) as Record<string, unknown>;
  const inferred = new Set(strs(r.inferred));
  if (Object.keys(specs).length) {
    out.push('', 'Specs:', ...Object.entries(specs).map(([k, v]) => `  ${k}: ${s(v)}${inferred.has(k) ? ' (inferred)' : ''}`));
  }
  const pins = arr(r.pins);
  if (pins.length) {
    out.push('', 'Pins:', ...pins.map((p) => `  ${s(p.name)}${p.desc ? `: ${s(p.desc)}` : ''}`));
  }
  if (r.pinout) {
    out.push(`Pinout: ${s(r.pinout)}`);
  }
  const notes = strs(r.notes);
  if (notes.length) {
    out.push('', 'Notes:', ...notes.map((n) => `  - ${n}`));
  }
  const ds = strs(r.datasheets);
  if (ds.length) {
    out.push('', 'Datasheets:', ...ds.map((d) => `  ${d}`));
  }
  const stock = arr(r.stock);
  out.push('', stock.length ? 'On hand:' : 'On hand: none recorded');
  out.push(...stock.map((x) => `  ${x.value ? `${s(x.value)}: ` : ''}${s(x.qty)}${x.location ? ` in ${s(x.location)}` : ''}${x.note ? ` (${s(x.note)})` : ''}`));
  const used = arr(r.used_by);
  if (used.length) {
    out.push('', 'Used by:', ...used.map((u) => `  ${s(u.guide)}: ${s(u.qty)}${u.value ? ` × ${s(u.value)}` : ''}`));
  }
  return out.join('\n');
}

export function renderPartStock(r: Row): string {
  return `${s(r.part)}${r.value ? ` ${s(r.value)}` : ''}: ${s(r.qty)} on hand${r.location ? ` in ${s(r.location)}` : ''}`;
}

export function wiringRenderer(op: string): ((r: Row) => string) | null {
  switch (op) {
    case 'wiring_list':
      return renderWiringList;
    case 'wiring_show':
      return renderWiringShow;
    case 'wiring_step':
    case 'wiring_undo':
    case 'wiring_reset':
      return renderWiringStep;
    case 'wiring_check':
      return renderWiringCheck;
    case 'wiring_reload':
      return renderWiringReload;
    case 'wiring_shopping':
      return renderWiringShopping;
    case 'part_list':
      return renderPartList;
    case 'part_show':
      return renderPartShow;
    case 'part_stock':
      return renderPartStock;
    default:
      return null;
  }
}
