// What a checkout describes (design c6 D14; spec 04 §4.3, 03 §3.6): its boards (hardware/boards/*.board.yaml)
// and firmware profiles (firmware/profiles/*.profile.yaml), for the hub's board_list and profile_list.
// Read loosely and without the codegen model: a listing shows what is there, and a file that does not
// parse is reported next to the others instead of failing the list (`fr gen firmware` validates).
// M2-C1 (design m2-c1-hil D7) adds the HIL bench (hardware/bench/<name>.bench.yaml), which the hub's fixture
// module loads: checked for its shape only here; `fr gen --check` (@fractonica/codegen checkBench) checks it
// against the boards and profiles.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BenchSchema, type Bench } from '@fractonica/protocol';
import { parseDocument, parse } from 'yaml';

export interface BoardInfo {
  /** The board id (its file name). */
  board: string;
  name?: string;
  /** IDF target: esp32, esp32c3, esp32c5, esp32c6, esp32s3. */
  chip: string;
  /** Flash size, e.g. 4MB. */
  flash: string;
  /** Names of its buttons and LEDs (the sections profiles bind). */
  buttons: string[];
  leds: string[];
  /** The T-LAT test pin (spec 04 §4.6), null without one. */
  test_pin: number | null;
}

export interface ProfileInfo {
  profile: string;
  board: string;
  /** The board's chip; null when the board file is missing or does not parse. */
  chip: string | null;
  app: string;
  /** Capability instances: name -> capability and driver. */
  instances: Record<string, { cap: string; driver: string }>;
}

/** A file that could not be read as a board or profile. */
export interface InventoryError {
  file: string;
  message: string;
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The parsed YAML files `<dir>/*<suffix>`, by file name; unreadable ones go to `errors`. */
function readYamlDir(sourceDir: string, dir: string, suffix: string, errors: InventoryError[]): { file: string; doc: Obj }[] {
  let names: string[];
  try {
    names = readdirSync(join(sourceDir, dir)).filter((n) => n.endsWith(suffix)).sort();
  } catch {
    return [];
  }
  const out: { file: string; doc: Obj }[] = [];
  for (const n of names) {
    const file = `${dir}/${n}`;
    try {
      const doc: unknown = parse(readFileSync(join(sourceDir, file), 'utf8'));
      if (!isObj(doc)) {
        throw new Error('not a YAML mapping');
      }
      out.push({ file, doc });
    } catch (e) {
      errors.push({ file, message: (e as Error).message.split('\n')[0] });
    }
  }
  return out;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

export function readBoards(sourceDir: string): { boards: BoardInfo[]; errors: InventoryError[] } {
  const errors: InventoryError[] = [];
  const boards: BoardInfo[] = [];
  for (const { file, doc } of readYamlDir(sourceDir, 'hardware/boards', '.board.yaml', errors)) {
    const id = str(doc.id);
    const chip = str(doc.idf_target);
    if (!id || !chip) {
      errors.push({ file, message: 'needs id and idf_target' });
      continue;
    }
    const flash = isObj(doc.flash) ? str(doc.flash.size) : undefined;
    boards.push({
      board: id,
      ...(str(doc.name) ? { name: str(doc.name) } : {}),
      chip,
      flash: flash ?? 'unknown',
      buttons: isObj(doc.buttons) ? Object.keys(doc.buttons) : [],
      leds: isObj(doc.leds) ? Object.keys(doc.leds) : [],
      test_pin: typeof doc.test_pin === 'number' && Number.isInteger(doc.test_pin) ? doc.test_pin : null,
    });
  }
  return { boards, errors };
}

export function readProfiles(sourceDir: string): { profiles: ProfileInfo[]; errors: InventoryError[] } {
  const { boards, errors } = readBoards(sourceDir);
  const chips = new Map(boards.map((b) => [b.board, b.chip]));
  const profiles: ProfileInfo[] = [];
  for (const { file, doc } of readYamlDir(sourceDir, 'firmware/profiles', '.profile.yaml', errors)) {
    const profile = str(doc.profile);
    const board = str(doc.board);
    const app = str(doc.app);
    if (!profile || !board || !app) {
      errors.push({ file, message: 'needs profile, board and app' });
      continue;
    }
    const instances: ProfileInfo['instances'] = {};
    for (const [name, c] of Object.entries(isObj(doc.caps) ? doc.caps : {})) {
      if (isObj(c) && str(c.cap) && str(c.driver)) {
        instances[name] = { cap: str(c.cap)!, driver: str(c.driver)! };
      }
    }
    profiles.push({ profile, board, chip: chips.get(board) ?? null, app, instances });
  }
  return { profiles, errors };
}

/** The bench the hub loads unless `--bench` or FR_BENCH names another (design m2-c1-hil D7). */
export const DEFAULT_BENCH = 'lab';

/**
 * hardware/bench/<name>.bench.yaml (default `lab`), parsed with BenchSchema. `bench` is null when the file is
 * missing or is not a valid bench; `errors` then says why, one entry per problem (`<yaml path>: <message>`).
 */
export function readBench(sourceDir: string, name: string = DEFAULT_BENCH): { bench: Bench | null; errors: InventoryError[] } {
  const file = `hardware/bench/${name}.bench.yaml`;
  if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
    return { bench: null, errors: [{ file, message: `'${name}' is not a bench name` }] };
  }
  if (!existsSync(join(sourceDir, file))) {
    return { bench: null, errors: [{ file, message: 'not found' }] };
  }
  const doc = parseDocument(readFileSync(join(sourceDir, file), 'utf8'), { uniqueKeys: true });
  if (doc.errors.length > 0) {
    return { bench: null, errors: doc.errors.map((e) => ({ file, message: e.message.split('\n')[0] })) };
  }
  const parsed = BenchSchema.safeParse(doc.toJS());
  if (!parsed.success) {
    return { bench: null, errors: parsed.error.issues.map((i) => ({ file, message: i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message })) };
  }
  if (parsed.data.id !== name) {
    return { bench: null, errors: [{ file, message: `id: bench id '${parsed.data.id}' does not match its file name` }] };
  }
  return { bench: parsed.data, errors: [] };
}
