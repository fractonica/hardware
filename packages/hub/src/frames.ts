// Readable log text for `@fr1:` serial frames (design c2 §7). A node's EVENT, STATE and RESULT
// envelopes arrive on the same USB line as its logs; the log store keeps them as one line each:
//   @fr1 EVENT boot.click {"count":1} (src=fffe seq=12 epoch=3 port=1)
// Instance and member names come from the fr_manifest caps of the firmware the device announced in
// its boot banner; without them the frame is shown by number (`port=1 kind=3`) with the body in hex.
// The system endpoints (node 0, ota 240, diag 241) sit on the same ports on every node, so they are
// named from the protocol constants whatever the manifest says (`@fr1 EVENT diag.mark {...}`).

import {
  CLS,
  decodeSerialLine,
  SERIAL_TYPE,
  type Decoded,
  type Envelope,
  type ManifestCap,
} from '@fractonica/protocol';
import { decodeEnvelope, decodeMember, findCap, PORT } from '@fractonica/protocol/gen';

import { manifestCapsByFwPrefix } from './artifacts.ts';
import { type Db, kvGet, kvSet } from './db.ts';

export interface MemberInfo {
  id: number;
  name: string;
}

export interface CapInfo {
  id: number;
  name: string;
  commands: readonly MemberInfo[];
  events: readonly MemberInfo[];
  properties: readonly MemberInfo[];
}

/** The struct of a member a body holds, by envelope class: CMD args, RESULT fields, EVENT fields, STATE value. */
export type MemberPart = 'args' | 'result' | 'event' | 'state';

/** The generated TS codecs (packages/protocol/src/gen) frame decoding uses; tests pass fakes. */
export interface FrameCodec {
  decodeEnvelope(bytes: Uint8Array): Decoded<Envelope>;
  findCap(idOrName: number | string): CapInfo | undefined;
  decodeMember(capId: number, part: MemberPart, memberId: number, bytes: Uint8Array): Decoded<unknown>;
}

export const GENERATED_CODEC: FrameCodec = { decodeEnvelope, findCap, decodeMember };

/** What frame naming needs of a manifest cap: which capability serves which port, under what name. */
export type PortCap = Pick<ManifestCap, 'name' | 'port' | 'cap' | 'cap_id'>;

export interface FrameText {
  kind: 'frame' | 'raw';
  text: string;
}

const MEMBER_CLASSES = new Map<number, { part: MemberPart; list: 'commands' | 'events' | 'properties' }>([
  [CLS.CMD, { part: 'args', list: 'commands' }],
  [CLS.RESULT, { part: 'result', list: 'commands' }],
  [CLS.EVENT, { part: 'event', list: 'events' }],
  [CLS.STATE, { part: 'state', list: 'properties' }],
]);

const CLS_NAMES = new Map<number, string>(Object.entries(CLS).map(([name, code]) => [code, name]));
const SERIAL_NAMES = new Map<number, string>(Object.entries(SERIAL_TYPE).map(([name, code]) => [code, name]));
/** RESULT/ACK status codes (05 §5.7), as fr::Err names them. */
const STATUS_NAMES = ['ok', 'unsupported', 'invalid_args', 'busy', 'failed', 'not_provisioned', 'late', 'expired', 'not_found'];

/** Fixed system instances (protocol.yaml `ports`, 05 §5.5); fr_manifest.json lists board instances only. */
const SYSTEM_PORTS: readonly Omit<PortCap, 'cap_id'>[] = [
  { name: 'node', port: PORT.NODE, cap: 'fr.node' },
  { name: 'ota', port: PORT.OTA, cap: 'fr.ota' },
  { name: 'diag', port: PORT.DIAG, cap: 'fr.diag' },
];

/** The instance serving `port`: a system endpoint, else the manifest's board instance. */
function instanceAt(port: number, codec: FrameCodec, caps: readonly PortCap[] | null): PortCap | undefined {
  const sys = SYSTEM_PORTS.find((s) => s.port === port);
  if (sys) {
    const id = codec.findCap(sys.cap)?.id;
    return id === undefined ? undefined : { ...sys, cap_id: id };
  }
  return caps?.find((c) => c.port === port);
}

const hex = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('hex');
const hex4 = (n: number) => n.toString(16).padStart(4, '0');

/** Field values as JSON: u64 (bigint) as a decimal string, bytes as hex. */
function fieldsJson(v: unknown): string {
  return JSON.stringify(v ?? {}, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x instanceof Uint8Array ? hex(x) : x));
}

/** Decodes one `@fr1:` line. Never throws: anything undecodable is kept verbatim as a raw line with the error. */
export function formatFrame(line: string, codec: FrameCodec, caps: readonly PortCap[] | null): FrameText {
  const raw = (error: string): FrameText => ({ kind: 'raw', text: `${line} (decode error: ${error})` });
  try {
    const frame = decodeSerialLine(line);
    if (!frame.ok) {
      return raw(`line ${frame.error}`);
    }
    const { type, body } = frame.value;
    if (type !== SERIAL_TYPE.ENV) {
      return { kind: 'frame', text: `@fr1 ${SERIAL_NAMES.get(type) ?? `type=0x${type.toString(16).padStart(2, '0')}`} ${hex(body)}`.trimEnd() };
    }
    const env = codec.decodeEnvelope(body);
    if (!env.ok) {
      return raw(`envelope ${env.error}`);
    }
    const { header: h, prefix } = env.value;
    const trailer = [`src=${hex4(h.src)}`, `seq=${h.seq}`, `epoch=${h.epoch}`, `port=${h.port}`];
    if (prefix.type === 'result') {
      trailer.push(`status=${STATUS_NAMES[prefix.status] ?? prefix.status}`, `req_seq=${prefix.req_seq}`);
    }
    const head = [`@fr1 ${CLS_NAMES.get(h.cls) ?? `cls=0x${h.cls.toString(16).padStart(2, '0')}`}`];
    const member = MEMBER_CLASSES.get(h.cls);
    const inst = member && instanceAt(h.port, codec, caps);
    const name = member && inst && codec.findCap(inst.cap_id)?.[member.list].find((m) => m.id === h.kind)?.name;
    if (member && inst && name !== undefined) {
      const fields = codec.decodeMember(inst.cap_id, member.part, h.kind, env.value.body);
      // An empty body is "no fields" whatever the struct; a command without result fields has none.
      if (!fields.ok && env.value.body.length) {
        return raw(`${inst.cap}.${name} ${member.part} ${fields.error}`);
      }
      head.push(`${inst.name}.${name}`, fields.ok ? fieldsJson(fields.value) : '{}');
    } else {
      head.push(...(member ? [`port=${h.port}`] : []), `kind=${h.kind}`, ...(env.value.body.length ? [hex(env.value.body)] : []));
    }
    return { kind: 'frame', text: `${head.join(' ')} (${trailer.join(' ')})` };
  } catch (e) {
    return raw(e instanceof Error ? e.message : String(e));
  }
}

// The boot banner, `I (312) fr: ready id=1cdbd416ba34 fw=3f2a9c01b2d4 state=...`: fw is a fw_id prefix.
const BANNER_RE = /\bfr: ready id=\S+ fw=([0-9a-f]{8,64})\b/;
/** A firmware with no artifact (built elsewhere, or not ingested yet) is looked up again after this. */
const MISS_RETRY_MS = 10_000;

/**
 * Per-device frame decoding for the log store. The firmware a device runs is taken from its boot
 * banner and kept in kv, so frames still get names after a hub restart; the caps of a firmware come
 * from the artifact whose fw_id starts with that prefix.
 */
export class FrameDecoder {
  #db: Db;
  #codec: FrameCodec;
  /** device -> fw_id prefix ('' = none known). */
  #fw = new Map<string, string>();
  #caps = new Map<string, { caps: readonly PortCap[] | null; at: number }>();

  constructor(db: Db, codec: FrameCodec = GENERATED_CODEC) {
    this.#db = db;
    this.#codec = codec;
  }

  /** Notes the firmware a device announces in its boot banner (a flash changes it). */
  observe(device: string, text: string): void {
    const fw = BANNER_RE.exec(text)?.[1];
    if (fw && this.#fw.get(device) !== fw) {
      this.#fw.set(device, fw);
      kvSet(this.#db, fwKey(device), fw);
    }
  }

  format(device: string, line: string): FrameText {
    return formatFrame(line, this.#codec, this.#capsOf(device));
  }

  #capsOf(device: string): readonly PortCap[] | null {
    let fw = this.#fw.get(device);
    if (fw === undefined) {
      fw = kvGet(this.#db, fwKey(device)) ?? '';
      this.#fw.set(device, fw);
    }
    if (!fw) {
      return null;
    }
    const hit = this.#caps.get(fw);
    if (hit && (hit.caps || Date.now() - hit.at < MISS_RETRY_MS)) {
      return hit.caps;
    }
    let caps: readonly PortCap[] | null = null;
    try {
      caps = manifestCapsByFwPrefix(this.#db, fw);
    } catch {
      // A missing or unreadable manifest only costs the names; the frame is still stored.
    }
    this.#caps.set(fw, { caps, at: Date.now() });
    return caps;
  }
}

const fwKey = (device: string) => `device_fw:${device}`;
