// Bus events as fr-app/1 frames (design c6 §4.2, D7): a capability EVENT becomes `evt`, a STATE `state`
// (told apart by the router's `part`, design c6 §3.3), device.online|suspect|offline `presence`, a node's
// MSG `msg`. Each event is serialized once, to the bytes every socket that wants it is sent.

import type { EvtFrame, HubFrame, HubMsgFrame, PresenceFrame, StateFrame } from '@fractonica/sdk/wire';

import type { HubEvent } from '../context.ts';

/** One event, framed for apps. */
export interface AppEventFrame {
  kind: 'evt' | 'state' | 'presence' | 'msg';
  /** The device it is about. */
  dev: string;
  /** What `hello.subscribe.types` globs are matched against: `<inst>.<member>`, `presence` or `msg`. */
  match: string;
  frame: EvtFrame | StateFrame | PresenceFrame | HubMsgFrame;
  /** A state frame's coalescing key in a socket's queue (latest wins): `<dev>/<inst>.<prop>`. */
  key?: string;
}

const PRESENCE: Record<string, PresenceFrame['state']> = { 'device.online': 'online', 'device.suspect': 'suspect', 'device.offline': 'offline' };

/** The frame `e` becomes, or null for events apps do not get (hub, job, link and registry events). */
export function appFrame(e: HubEvent): AppEventFrame | null {
  const dev = e.device;
  if (!dev) {
    return null;
  }
  if (e.part === 'event' || e.part === 'state') {
    const dot = e.type.indexOf('.');
    const inst = e.type.slice(0, dot);
    const member = e.member ?? e.type.slice(dot + 1);
    const fields = e.fields ?? {};
    if (e.part === 'event') {
      const frame: EvtFrame = {
        t: 'evt',
        dev,
        inst,
        evt: member,
        t_dev_us: e.t_dev_us ?? null,
        t_hub_us: Math.round(e.t_hub_us),
        cursor: e.cursor,
        late: Boolean(e.late),
        ...(e.epoch !== undefined ? { epoch: e.epoch } : {}),
        ...(e.replayed ? { replayed: true as const } : {}),
        fields,
      };
      return { kind: 'evt', dev, match: e.type, frame };
    }
    // A named property's STATE fields are {<prop>: value}; an unnamed port's are its raw bytes.
    const value = member in fields ? fields[member] : fields;
    return { kind: 'state', dev, match: e.type, frame: { t: 'state', dev, inst, prop: member, value, t_hub_us: Math.round(e.t_hub_us) }, key: `${dev}/${e.type}` };
  }
  const state = PRESENCE[e.type];
  if (state) {
    const f = e.fields ?? {};
    const reason = typeof f.reason === 'string' ? f.reason : typeof f.silent_ms === 'number' ? `silent ${f.silent_ms} ms` : undefined;
    const frame: PresenceFrame = { t: 'presence', dev, state, ...(reason ? { reason } : {}), ...(typeof f.link === 'string' ? { link: f.link } : {}) };
    return { kind: 'presence', dev, match: 'presence', frame };
  }
  if (e.type === 'msg') {
    const f = e.fields ?? {};
    const frame: HubMsgFrame = {
      t: 'msg',
      dev,
      topic: String(f.topic ?? ''),
      data: f.data ?? null,
      dst: typeof f.dst === 'number' ? f.dst : 0,
      t_hub_us: Math.round(e.t_hub_us),
      cursor: e.cursor,
    };
    return { kind: 'msg', dev, match: 'msg', frame };
  }
  return null;
}

/** A frame as the bytes of one text frame. */
export function frameBytes(f: HubFrame): Buffer {
  return Buffer.from(JSON.stringify(f), 'utf8');
}
