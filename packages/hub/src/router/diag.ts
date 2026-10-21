// diag_exec over a hub link (spec 09 §9.4, §9.7; design c3 §4): when the device's USB port is not open by
// the hub (on a charger, leased, unplugged) but the device has a session, the same diag line goes out as
// `fr.diag.exec` (port 241) and its RESULT carries the JSON answer (BULK: up to 1,400 B, TCP or serial).

import { FrError } from '@fractonica/protocol';
import { decodeDiagExecResult, encodeDiagExecArgs, findCap, PORT, STATUS, statusName } from '@fractonica/protocol/gen';

import type { HubContext } from '../context.ts';
import { normalizeMac } from '../serial.ts';

const DIAG_EXEC = findCap('fr.diag')?.commands.find((c) => c.name === 'exec')?.id ?? 1;

const isUp = (p: string) => p === 'online' || p === 'suspect';

/**
 * The device a diag_exec `port` should be reached through a hub link instead of its serial port: one with a
 * session whose USB port the hub does not hold open right now. null means "use the serial path" (which
 * also gives the right error for a device that is reachable neither way).
 */
export function diagLinkTarget(hub: HubContext, port: string): string | null {
  const router = hub.router;
  if (!router) {
    return null;
  }
  let id: string | null = null;
  try {
    const entry = hub.serial.resolve(port);
    if (entry.state === 'open') {
      return null;
    }
    id = entry.key;
  } catch {
    // Not attached (or ambiguous): a device id, MAC or alias may still name a networked device.
  }
  if (id === null) {
    const bare = port.replace(/^(mac|port|id):/, '');
    const mac = normalizeMac(bare);
    if (/^[0-9a-f]{12}$/.test(mac)) {
      id = mac;
    } else {
      try {
        id = hub.registry?.byAlias(bare)?.device_id ?? null;
      } catch {
        id = null;
      }
    }
  }
  return id !== null && isUp(router.presence(id)) ? id : null;
}

/** One diag line as fr.diag.exec; resolves with the parsed JSON answer and the link it went over. */
export async function diagOverLink(hub: HubContext, deviceId: string, line: string, timeoutS: number): Promise<{ response: unknown; link: string }> {
  let args: Uint8Array;
  try {
    args = encodeDiagExecArgs({ line });
  } catch (e) {
    throw new FrError('INVALID_ARGS', `line: ${(e as Error).message}`);
  }
  const r = await hub.router.sendCommand(deviceId, PORT.DIAG, DIAG_EXEC, args, { ack: 'result', timeoutMs: timeoutS * 1000, bulk: true });
  if (r.status !== STATUS.OK) {
    const name = statusName(r.status)?.toLowerCase() ?? String(r.status);
    const details = { status: name, link: r.link };
    if (r.status === STATUS.BUSY) {
      throw new FrError('DEVICE_BUSY', `${deviceId} is busy (fr.diag.exec runs one line at a time)`, { details });
    }
    if (r.status === STATUS.EXPIRED) {
      throw new FrError('TIMEOUT', `${deviceId} received fr.diag.exec after it expired`, { details });
    }
    throw new FrError('INTERNAL', `${deviceId} answered fr.diag.exec with ${name} instead of JSON`, {
      ...(r.status === STATUS.FAILED ? { hint: 'an answer longer than the reply buffer fails; firmware before C3 has only the 200 B reply' } : {}),
      details,
    });
  }
  const d = decodeDiagExecResult(r.fields);
  if (!d.ok) {
    throw new FrError('INTERNAL', `${deviceId}: undecodable fr.diag.exec result (${d.error})`, { details: { link: r.link } });
  }
  try {
    return { response: JSON.parse(d.value.json), link: r.link };
  } catch {
    throw new FrError('INTERNAL', `${deviceId} answered fr.diag.exec with malformed JSON`, { details: { json: d.value.json, link: r.link } });
  }
}
