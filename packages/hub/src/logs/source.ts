// Where a device's log lines reach the hub from (design m2-c2 D21): a USB port the hub holds open, or LOG frames
// over TCP from a node whose HELLO says net_log. deploy's expect_log rule (ota/deploy.ts), and the hints of
// wait_for_log (ops.ts) and logs_assert (logs/ops.ts), read it.
//
// The two are not equal. The TCP copy is fed by fr_serial's esp_log hook once fr_core enables it, floored at
// FR_NET_LOG_LEVEL (I), in a RAM ring a reboot loses (design m2-c2 D20). The ROM, the bootloader and early start-up
// print before the hook is in; the panic handler prints `Guru Meditation`, `abort()` and assert output straight to
// the console; D and V lines are floored out. None of those ever arrive over TCP, so a `forbid` on them checks
// nothing on a node the hub hears only over Wi-Fi, and an expectation on them can only time out.

import type { HubContext } from '../context.ts';
import { type DeviceLinkInfo, routerInfo } from '../router/index.ts';

/** HELLO caps b6 net_log (05 §5.7, design m2-c2 D20): the node sends its log lines as LOG frames over TCP. */
export const CAP_NET_LOG = 1 << 6;

/** What the log-source rule reads of a device's links: the router's device info, or a test's stand-in. */
export type LogSourceInfo = (hub: HubContext, deviceId: string) => Pick<DeviceLinkInfo, 'presence' | 'links' | 'hello_caps'> | null;

/** The router's device info: what the rule reads outside tests. */
export const routerLinks: LogSourceInfo = (hub, deviceId) => routerInfo(hub.router, deviceId);

/**
 * Where a device's log lines reach the hub from now (design m2-c2 D21): `usb`, a port the hub holds open (not
 * closed, leased to a flash, or held by another program); `tcp`, online with a TCP session whose last HELLO said
 * net_log; else null. The TCP rule reads the running image's HELLO, not the one being deployed.
 */
export function logSourceOf(hub: HubContext, deviceId: string, info: LogSourceInfo = routerLinks): 'usb' | 'tcp' | null {
  if (hub.serial.list().some((p) => p.device_id === deviceId && p.state === 'open')) {
    return 'usb';
  }
  const li = info(hub, deviceId);
  const up = li?.presence === 'online' || li?.presence === 'suspect';
  return up && li!.links.includes('tcp') && ((li!.hello_caps ?? 0) & CAP_NET_LOG) !== 0 ? 'tcp' : null;
}

/** What never arrives over TCP, for a hint or a warning about a device whose only log source is `tcp`. */
export const TCP_LOG_LIMITS =
  'over Wi-Fi (net_log) only esp_log lines at E, W and I logged after start-up arrive, at most 30 s late, while ' +
  'panic, abort and assert output, ROM and bootloader lines and D/V lines come only over USB';

/** How to check a Wi-Fi-only node for a crash instead of forbidding the panic text (the ready banner's reset=). */
export const TCP_CRASH_CHECK =
  'to catch a crash there, forbid the ready banner\'s reset field ("reset=PANIC", "reset=TASK_WDT", "reset=INT_WDT", "reset=WDT", "reset=BROWNOUT") or wait for node.boot';

/** The aliases-or-ids of `devices` (null: every device with lines) whose only log source now is TCP. */
export function tcpOnlyDevices(hub: HubContext, devices: string[] | null, info: LogSourceInfo = routerLinks): string[] {
  if (!devices) {
    return [];
  }
  let all: string[] = [];
  try {
    all = devices.filter((d) => logSourceOf(hub, d, info) === 'tcp');
  } catch {
    return []; // a hint, never a failure of the op it is for
  }
  return all.map((d) => {
    try {
      return hub.registry?.get(d)?.alias ?? d;
    } catch {
      return d;
    }
  });
}
