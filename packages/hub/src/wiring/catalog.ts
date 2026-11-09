// The wiring guides and the parts catalogue (design wiring-w1 D1, D2), read from a checkout: hardware/parts/*.part.yaml
// and hardware/wiring/<id>/guide.yaml with its SVG diagrams. Pure apart from reading files: no database, no hub, so
// the repo-wide test (every guide loads and passes its cross-check) runs it as the hub does.
// - A part or guide that does not parse or validate is refused (listed with its errors), never served half-valid.
// - A guide with a `profile` is cross-checked against it (and its board): a failure is reported on the guide, which is
//   still served, so an outdated guide says it is outdated. The profile and board are read with codegen's own loaders
//   (passed in: the hub imports @fractonica/codegen on first use, never at startup).

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// Types only: the hub loads @fractonica/codegen lazily (codegenLoader), never at startup (hub-c2-build's rule).
import type { BoardManifest, ProfileManifest } from '@fractonica/codegen';
import { PART_CATEGORIES, WIRING_ID_RE, type ConnectionCheck, type WiringCheck, type WiringLoadError } from '@fractonica/protocol';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export const PARTS_DIR = join('hardware', 'parts');
export const WIRING_DIR = join('hardware', 'wiring');
const PART_SUFFIX = '.part.yaml';
const GUIDE_FILE = 'guide.yaml';
/** Image types a part may show (served from hardware/parts). */
export const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
/** A diagram file name: plain, no directories, .svg. */
const DIAGRAM_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}\.svg$/;
const IMAGE_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}\.(png|jpe?g|webp|svg)$/;
/** A pin in a pin table: a GPIO or a power pin. */
const PIN_RE = /^(gpio\.\d{1,2}|3v3|5v|gnd)$/;
const POWER_PINS = new Set(['3v3', '5v', 'gnd']);
const ID = z.string().regex(WIRING_ID_RE, 'expected a kebab-case id');
const text = z.string().min(1);

// ---- parts (D1) ----

const RawPart = z.strictObject({
  schema: z.literal('fractonica/part@1'),
  id: ID,
  name: text,
  category: z.enum(PART_CATEGORIES),
  summary: text,
  values: z.array(text).optional(),
  specs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  inferred: z.array(z.string()).optional(),
  pins: z.array(z.strictObject({ name: text, desc: z.string().optional() })).optional(),
  pinout: z.string().optional(),
  notes: z.array(text).optional(),
  datasheets: z.array(z.url()).optional(),
  image: z.string().regex(IMAGE_FILE_RE, 'expected a file name next to the part file: .png, .jpg, .webp or .svg').optional(),
});

export interface Part {
  id: string;
  name: string;
  category: (typeof PART_CATEGORIES)[number];
  summary: string;
  values: string[];
  specs: Record<string, string>;
  inferred: string[];
  pins: { name: string; desc: string | null }[];
  pinout: string | null;
  notes: string[];
  datasheets: string[];
  /** The image's file name in hardware/parts, or null. */
  image: string | null;
  file: string;
}

// ---- guides (D2) ----

const RawConnection = z.strictObject({
  pin: z.string().regex(PIN_RE, 'expected gpio.<n>, 3v3, 5v or gnd'),
  instance: z.string().min(1).optional(),
  bind: z.string().min(1).optional(),
  to: text,
  via: z.string().optional(),
});

const RawStep = z.strictObject({
  id: ID,
  text,
  pins: z.array(z.string()).optional(),
  check: z.string().optional(),
  note: z.string().optional(),
  diagram: z.string().optional(),
});

const RawGuide = z.strictObject({
  schema: z.literal('fractonica/wiring@1'),
  id: ID,
  title: text,
  summary: text,
  board: z.string().min(1).optional(),
  profile: z.string().min(1).optional(),
  device: z.string().min(1).optional(),
  design: z.string().min(1).optional(),
  covers: z.array(z.string().min(1)).optional(),
  safety: z.array(text).optional(),
  bom: z.array(z.strictObject({ part: ID, value: z.string().min(1).optional(), qty: z.number().int().min(1).max(100_000), note: z.string().optional() })),
  diagrams: z.array(z.strictObject({ id: ID, title: text, file: z.string().regex(DIAGRAM_FILE_RE, 'expected an .svg file name next to guide.yaml') })).optional(),
  connections: z.array(RawConnection).optional(),
  sections: z.array(z.strictObject({ id: ID, title: text, intro: z.string().optional(), diagram: z.string().optional(), steps: z.array(RawStep).min(1) })).min(1),
});
type RawGuide = z.infer<typeof RawGuide>;

export interface GuideConnection {
  pin: string;
  instance: string | null;
  bind: string | null;
  to: string;
  via: string | null;
  check: ConnectionCheck;
  message: string | null;
}

export interface GuideStep {
  id: string;
  text: string;
  pins: string[];
  check: string | null;
  note: string | null;
  diagram: string | null;
}

export interface Guide {
  id: string;
  title: string;
  summary: string;
  board: string | null;
  profile: string | null;
  device: string | null;
  design: string | null;
  covers: string[];
  safety: string[];
  bom: { part: string; value: string | null; qty: number; note: string | null }[];
  diagrams: { id: string; title: string; file: string }[];
  connections: GuideConnection[];
  sections: { id: string; title: string; intro: string | null; diagram: string | null; steps: GuideStep[] }[];
  /** The cross-check against the profile (none without one). */
  check: WiringCheck;
  errors: string[];
  warnings: string[];
  /** The guide's directory (absolute). */
  dir: string;
  file: string;
}

export interface Catalog {
  parts: Map<string, Part>;
  guides: Map<string, Guide>;
  /** Files that were refused, with why. */
  refused: WiringLoadError[];
  sourceDir: string;
}

const zodErrors = (e: z.ZodError): string[] => e.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message));

function readYaml(file: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: parseYaml(readFileSync(file, 'utf8')) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.split('\n')[0] : String(e) };
  }
}

/**
 * Why an SVG may not be served or inlined, or null when it may (design D2): no script, no foreignObject, no
 * javascript: URL, no external reference (href, xlink:href and url() only to `#id`), no @import. Event-handler
 * attributes (a chat diagram's onclick) are allowed in the file: it is served with script-src 'none', and web/bench
 * strips them before inlining.
 */
export function svgProblem(svg: string): string | null {
  if (!/<svg[\s>]/i.test(svg)) {
    return 'not an SVG (no <svg> element)';
  }
  if (/<script[\s>/]/i.test(svg)) {
    return 'holds a <script>';
  }
  if (/<foreignObject[\s>/]/i.test(svg)) {
    return 'holds a <foreignObject>';
  }
  if (/javascript:/i.test(svg)) {
    return 'holds a javascript: URL';
  }
  if (/@import/i.test(svg)) {
    return 'holds an @import';
  }
  for (const m of svg.matchAll(/(?:xlink:)?href\s*=\s*["']([^"']*)["']/gi)) {
    if (!m[1].startsWith('#')) {
      return `refers to ${m[1]} (only #ids inside the file)`;
    }
  }
  for (const m of svg.matchAll(/url\(\s*['"]?([^'")\s]*)/gi)) {
    if (!m[1].startsWith('#')) {
      return `refers to url(${m[1]}) (only #ids inside the file)`;
    }
  }
  return null;
}

function listDirs(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

function loadParts(sourceDir: string, refused: WiringLoadError[]): Map<string, Part> {
  const dir = join(sourceDir, PARTS_DIR);
  const parts = new Map<string, Part>();
  if (!existsSync(dir)) {
    return parts;
  }
  for (const name of readdirSync(dir).filter((f) => f.endsWith(PART_SUFFIX)).sort()) {
    const file = join(dir, name);
    const rel = relative(sourceDir, file);
    const y = readYaml(file);
    if (!y.ok) {
      refused.push({ file: rel, errors: [y.error] });
      continue;
    }
    const r = RawPart.safeParse(y.value);
    if (!r.success) {
      refused.push({ file: rel, errors: zodErrors(r.error) });
      continue;
    }
    const p = r.data;
    const errors: string[] = [];
    if (`${p.id}${PART_SUFFIX}` !== name) {
      errors.push(`id ${p.id} does not match the file name (expected ${p.id}${PART_SUFFIX})`);
    }
    if (parts.has(p.id)) {
      errors.push(`id ${p.id} is used by another part file`);
    }
    const specs = Object.fromEntries(Object.entries(p.specs ?? {}).map(([k, v]) => [k, String(v)]));
    for (const k of p.inferred ?? []) {
      if (!(k in specs)) {
        errors.push(`inferred: ${k} is not a key of specs`);
      }
    }
    const values = p.values ?? [];
    if (new Set(values).size !== values.length) {
      errors.push('values: a value is listed twice');
    }
    if (p.image && !existsSync(join(dir, p.image))) {
      errors.push(`image: ${p.image} is not next to the part file`);
    }
    if (errors.length) {
      refused.push({ file: rel, errors });
      continue;
    }
    parts.set(p.id, {
      id: p.id,
      name: p.name,
      category: p.category,
      summary: p.summary,
      values,
      specs,
      inferred: p.inferred ?? [],
      pins: (p.pins ?? []).map((x) => ({ name: x.name, desc: x.desc ?? null })),
      pinout: p.pinout ?? null,
      notes: p.notes ?? [],
      datasheets: p.datasheets ?? [],
      image: p.image ?? null,
      file: rel,
    });
  }
  return parts;
}

/** The structural problems of a parsed guide (refused when any). */
function guideProblems(g: RawGuide, dirName: string, dir: string, parts: Map<string, Part>): string[] {
  const errors: string[] = [];
  if (g.id !== dirName) {
    errors.push(`id ${g.id} does not match its directory (hardware/wiring/${dirName})`);
  }
  g.bom.forEach((b, i) => {
    const part = parts.get(b.part);
    if (!part) {
      errors.push(`bom.${i}: no part ${b.part} in hardware/parts`);
      return;
    }
    if (part.values.length && !b.value) {
      errors.push(`bom.${i}: ${b.part} comes in values (${part.values.join(', ')}): say which`);
    } else if (part.values.length && b.value && !part.values.includes(b.value)) {
      errors.push(`bom.${i}: ${b.part} has no value ${b.value} (values: ${part.values.join(', ')})`);
    } else if (!part.values.length && b.value) {
      errors.push(`bom.${i}: ${b.part} has no values; drop value ${b.value}`);
    }
  });
  const bomKeys = g.bom.map((b) => `${b.part}\u0000${b.value ?? ''}`);
  if (new Set(bomKeys).size !== bomKeys.length) {
    errors.push('bom: a part (and value) is listed twice');
  }
  const diagramIds = new Set<string>();
  for (const [i, d] of (g.diagrams ?? []).entries()) {
    if (diagramIds.has(d.id)) {
      errors.push(`diagrams.${i}: id ${d.id} is used twice`);
    }
    diagramIds.add(d.id);
    const file = join(dir, d.file);
    if (!existsSync(file)) {
      errors.push(`diagrams.${i}: ${d.file} is not next to guide.yaml`);
      continue;
    }
    const problem = svgProblem(readFileSync(file, 'utf8'));
    if (problem) {
      errors.push(`diagrams.${i}: ${d.file} ${problem}`);
    }
  }
  const pins = new Set((g.connections ?? []).map((c) => c.pin));
  const stepIds = new Set<string>();
  const sectionIds = new Set<string>();
  g.sections.forEach((s, si) => {
    if (sectionIds.has(s.id)) {
      errors.push(`sections.${si}: id ${s.id} is used twice`);
    }
    sectionIds.add(s.id);
    if (s.diagram && !diagramIds.has(s.diagram)) {
      errors.push(`sections.${si}: no diagram ${s.diagram}`);
    }
    s.steps.forEach((st, ti) => {
      if (stepIds.has(st.id)) {
        errors.push(`sections.${si}.steps.${ti}: step id ${st.id} is used twice in the guide`);
      }
      stepIds.add(st.id);
      if (st.diagram && !diagramIds.has(st.diagram)) {
        errors.push(`sections.${si}.steps.${ti}: no diagram ${st.diagram}`);
      }
      for (const p of st.pins ?? []) {
        if (!pins.has(p)) {
          errors.push(`sections.${si}.steps.${ti}: pin ${p} is not in connections`);
        }
      }
    });
  });
  return errors;
}

const gpioOf = (pin: string): number | null => (pin.startsWith('gpio.') ? Number(pin.slice(5)) : null);

/**
 * The cross-check against the profile and its board (design D2). Fills each connection's check and returns the
 * guide's failures and warnings.
 */
export function crossCheck(
  g: { covers: string[]; connections: GuideConnection[]; board: string | null },
  profile: ProfileManifest,
  board: BoardManifest,
): { errors: string[]; warnings: string[]; board: string } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (g.board && g.board !== profile.board) {
    errors.push(`board ${g.board} is not the profile's (${profile.board})`);
  }
  const caps = profile.caps;
  // The profile's bare-pin binds: pin -> [instance, bind key ('' for a single `bind: gpio.N`)].
  const boundAt = new Map<string, { instance: string; bind: string }>();
  for (const [inst, c] of Object.entries(caps)) {
    if (typeof c.bind === 'string') {
      if (c.bind.startsWith('gpio.')) {
        boundAt.set(c.bind, { instance: inst, bind: '' });
      }
    } else if (c.bind) {
      for (const [k, pin] of Object.entries(c.bind)) {
        boundAt.set(pin, { instance: inst, bind: k });
      }
    }
  }
  const free = new Set(board.pins.free ?? []);
  const strapping = new Set(board.pins.strapping ?? []);
  const levels = board.pins.strapping_levels ?? {};
  const pinOwner = new Map<string, string>();
  const namedPins = new Set(g.connections.filter((c) => c.instance).map((c) => c.pin));
  const fail = (c: GuideConnection, msg: string) => {
    c.check = 'failed';
    c.message = c.message ? `${c.message}; ${msg}` : msg;
    errors.push(`${c.pin}: ${msg}`);
  };
  const warn = (c: GuideConnection, msg: string) => {
    if (c.check !== 'failed') {
      c.check = 'warning';
    }
    c.message = c.message ? `${c.message}; ${msg}` : msg;
    warnings.push(`${c.pin}: ${msg}`);
  };
  for (const c of g.connections) {
    c.check = 'ok';
    c.message = null;
    const n = gpioOf(c.pin);
    // The pin itself: free on the board, or a strapping pin with level none (a warning).
    if (n !== null) {
      if (!free.has(n)) {
        const lvl = (levels as Record<string, string>)[String(n)];
        if (strapping.has(n) && lvl === 'none') {
          warn(c, `GPIO${n} is a strapping pin (level none on ${board.id}): keep it from being pulled at reset`);
        } else {
          fail(c, `GPIO${n} is not a free pin on ${board.id}${strapping.has(n) ? ` (a strapping pin, level ${lvl ?? 'unknown'})` : ''}`);
        }
      }
      // One pin, one instance (rows without an instance on the same pin, a pull-down beside a bind, are fine).
      if (c.instance) {
        const prev = pinOwner.get(c.pin);
        if (prev !== undefined && prev !== c.instance) {
          fail(c, `${c.pin} is listed for ${prev} and for ${c.instance}`);
        } else {
          pinOwner.set(c.pin, c.instance);
        }
      }
    } else if (c.instance) {
      fail(c, `a power pin (${c.pin}) cannot be an instance's bind`);
    }
    // The instance and bind against the profile.
    if (c.instance) {
      const cap = caps[c.instance];
      if (!cap) {
        fail(c, `the profile has no instance ${c.instance}`);
        continue;
      }
      if (typeof cap.bind === 'string') {
        if (!cap.bind.startsWith('gpio.')) {
          if (c.check === 'ok') {
            c.check = 'unchecked';
            c.message = `${c.instance} binds the board entry ${cap.bind}, not checked`;
          }
        } else if (c.bind && c.bind !== 'pin') {
          fail(c, `${c.instance} binds one pin (${cap.bind}); write no bind (or bind: pin)`);
        } else if (cap.bind !== c.pin) {
          fail(c, `the profile binds ${c.instance} to ${cap.bind}, not ${c.pin}`);
        }
      } else if (cap.bind) {
        if (!c.bind) {
          fail(c, `say which bind of ${c.instance} (${Object.keys(cap.bind).join(', ')})`);
        } else if (!(c.bind in cap.bind)) {
          fail(c, `${c.instance} has no bind ${c.bind} (binds: ${Object.keys(cap.bind).join(', ')})`);
        } else if (cap.bind[c.bind] !== c.pin) {
          fail(c, `the profile binds ${c.instance}.${c.bind} to ${cap.bind[c.bind]}, not ${c.pin}`);
        }
      } else {
        fail(c, `${c.instance} binds nothing in the profile`);
      }
    } else if (n !== null && boundAt.has(c.pin) && !namedPins.has(c.pin)) {
      const b = boundAt.get(c.pin)!;
      warn(c, `the profile binds ${c.pin} to ${b.instance}${b.bind ? `.${b.bind}` : ''}: name it (instance, bind)`);
    } else if (c.check === 'ok') {
      c.check = 'unchecked';
    }
  }
  // Every bind of a covered instance is in the pin table.
  for (const inst of g.covers) {
    const cap = caps[inst];
    if (!cap) {
      errors.push(`covers: the profile has no instance ${inst}`);
      continue;
    }
    const listed = g.connections.filter((c) => c.instance === inst);
    if (typeof cap.bind === 'string') {
      if (cap.bind.startsWith('gpio.') && !listed.some((c) => c.pin === cap.bind)) {
        errors.push(`covers: ${inst}'s pin ${cap.bind} is not in the pin table`);
      }
    } else if (cap.bind) {
      for (const [k, pin] of Object.entries(cap.bind)) {
        if (!listed.some((c) => c.bind === k)) {
          errors.push(`covers: ${inst}.${k} (${pin}) is not in the pin table`);
        }
      }
    }
  }
  return { errors, warnings, board: profile.board };
}

/** What the cross-check needs from @fractonica/codegen: its profile and board loaders and its error type. */
export interface ManifestLoader {
  loadProfileManifest(sourceDir: string, name: string): ProfileManifest;
  loadBoardManifest(sourceDir: string, id: string): BoardManifest;
  SchemaError: new (...args: never[]) => Error & { issues: { file: string; path?: string; message: string }[] };
  formatIssue(i: { file: string; path?: string; message: string }): string;
}

/** codegen's loaders, imported on first use. */
export async function codegenLoader(): Promise<ManifestLoader> {
  const m = await import('@fractonica/codegen');
  return { loadProfileManifest: m.loadProfileManifest, loadBoardManifest: m.loadBoardManifest, SchemaError: m.SchemaError as ManifestLoader['SchemaError'], formatIssue: m.formatIssue as ManifestLoader['formatIssue'] };
}

function schemaText(e: unknown, loader: ManifestLoader): string[] {
  if (e instanceof loader.SchemaError) {
    return e.issues.map((i) => loader.formatIssue(i));
  }
  return [e instanceof Error ? e.message : String(e)];
}

function loadGuides(sourceDir: string, parts: Map<string, Part>, refused: WiringLoadError[], loader: ManifestLoader): Map<string, Guide> {
  const root = join(sourceDir, WIRING_DIR);
  const guides = new Map<string, Guide>();
  for (const dirName of listDirs(root)) {
    const dir = join(root, dirName);
    const file = join(dir, GUIDE_FILE);
    const rel = relative(sourceDir, file);
    if (!existsSync(file)) {
      refused.push({ file: relative(sourceDir, dir), errors: [`no ${GUIDE_FILE}`] });
      continue;
    }
    const y = readYaml(file);
    if (!y.ok) {
      refused.push({ file: rel, errors: [y.error] });
      continue;
    }
    const r = RawGuide.safeParse(y.value);
    if (!r.success) {
      refused.push({ file: rel, errors: zodErrors(r.error) });
      continue;
    }
    const g = r.data;
    const problems = guideProblems(g, dirName, dir, parts);
    if (problems.length) {
      refused.push({ file: rel, errors: problems });
      continue;
    }
    const guide: Guide = {
      id: g.id,
      title: g.title,
      summary: g.summary,
      board: g.board ?? null,
      profile: g.profile ?? null,
      device: g.device ?? null,
      design: g.design ?? null,
      covers: g.covers ?? [],
      safety: g.safety ?? [],
      bom: g.bom.map((b) => ({ part: b.part, value: b.value ?? null, qty: b.qty, note: b.note ?? null })),
      diagrams: g.diagrams ?? [],
      connections: (g.connections ?? []).map((c) => ({ pin: c.pin, instance: c.instance ?? null, bind: c.bind ?? null, to: c.to, via: c.via ?? null, check: 'unchecked', message: null })),
      sections: g.sections.map((s) => ({
        id: s.id,
        title: s.title,
        intro: s.intro ?? null,
        diagram: s.diagram ?? null,
        steps: s.steps.map((st) => ({ id: st.id, text: st.text, pins: st.pins ?? [], check: st.check ?? null, note: st.note ?? null, diagram: st.diagram ?? null })),
      })),
      check: 'none',
      errors: [],
      warnings: [],
      dir,
      file: rel,
    };
    if (guide.profile) {
      try {
        const profile = loader.loadProfileManifest(sourceDir, guide.profile);
        const board = loader.loadBoardManifest(sourceDir, profile.board);
        const res = crossCheck(guide, profile, board);
        guide.errors = res.errors;
        guide.warnings = res.warnings;
        guide.board ??= res.board;
        guide.check = res.errors.length ? 'failed' : 'ok';
      } catch (e) {
        guide.check = 'failed';
        guide.errors = schemaText(e, loader).map((m) => `profile ${guide.profile}: ${m}`);
      }
    } else if (guide.covers.length) {
      guide.check = 'failed';
      guide.errors = ['covers needs a profile'];
    } else if (guide.board) {
      // No profile: the GPIOs are still checked against the board's free pins.
      try {
        const board = loader.loadBoardManifest(sourceDir, guide.board);
        const res = crossCheck(guide, { profile: '', board: board.id, app: '', caps: {} } as ProfileManifest, board);
        guide.errors = res.errors;
        guide.warnings = res.warnings;
        guide.check = res.errors.length ? 'failed' : 'ok';
      } catch (e) {
        guide.check = 'failed';
        guide.errors = schemaText(e, loader).map((m) => `board ${guide.board}: ${m}`);
      }
    }
    guides.set(guide.id, guide);
  }
  return guides;
}

/** Reads hardware/parts and hardware/wiring of a checkout (design D3: never throws for a bad file). */
export function loadCatalog(sourceDir: string, loader: ManifestLoader): Catalog {
  const refused: WiringLoadError[] = [];
  const parts = loadParts(sourceDir, refused);
  const guides = loadGuides(sourceDir, parts, refused, loader);
  return { parts, guides, refused, sourceDir };
}

/** A diagram's absolute path when `file` is one of the guide's diagrams (the only files served), else null. */
export function diagramPath(cat: Catalog, guide: string, file: string): string | null {
  const g = cat.guides.get(guide);
  if (!g || !DIAGRAM_FILE_RE.test(file) || !g.diagrams.some((d) => d.file === file)) {
    return null;
  }
  const p = join(g.dir, file);
  return existsSync(p) && statSync(p).isFile() ? p : null;
}

/** A part image's absolute path when `file` is a part's image, else null. */
export function partImagePath(cat: Catalog, file: string): string | null {
  if (!IMAGE_FILE_RE.test(file) || ![...cat.parts.values()].some((p) => p.image === file)) {
    return null;
  }
  const p = join(cat.sourceDir, PARTS_DIR, file);
  return existsSync(p) && statSync(p).isFile() ? p : null;
}

/** Every step id of a guide, in order. */
export function stepIds(g: Guide): string[] {
  return g.sections.flatMap((s) => s.steps.map((st) => st.id));
}
