// Handler of the hub ops (packages/protocol/src/ops/hub.ts; design c6 D14, stream S2): hub_doctor, fr doctor's
// host checks run in the hub process (never --fix: the op is read-only), plus what only the hub knows: its
// Local Network self-test and `_fractonica._tcp` advert (lan/), and its event-loop delay (D29). Spread into
// HANDLERS (packages/hub/src/ops.ts); hub_status stays in ops.ts with the C1 ops.

import { type Check, hubChecks, runDoctor } from '@fractonica/host';
import type { HubOpName } from '@fractonica/protocol';

import type { Handler, HubContext } from '../context.ts';
import { routerLoopDelay } from '../router/index.ts';
import { LOOP_DELAY_WARN_MS } from '../web/feeds.ts';

export async function hubDoctor(hub: HubContext, deps: { runDoctor?: typeof runDoctor } = {}): Promise<{ checks: Check[] }> {
  const checks = await (deps.runDoctor ?? runDoctor)({ sourceDir: hub.hubSourceDir, fix: false });
  const lnp = hub.lnp?.status();
  checks.push(...hubChecks({ lnp: lnp?.lnp, lnp_checked_at: lnp?.checked_at, launched_by: lnp?.launched_by, advert: hub.advert?.status() }));
  const loop = routerLoopDelay(hub.router, 60_000);
  if (loop?.p99_ms != null) {
    const slow = loop.p99_ms > LOOP_DELAY_WARN_MS;
    checks.push({
      id: 'loop_delay',
      level: slow ? 'warn' : 'ok',
      detail: `event loop delay over the last ${loop.seconds} s: p50 ${loop.p50_ms} ms, p99 ${loop.p99_ms} ms${slow ? ` (above ${LOOP_DELAY_WARN_MS} ms)` : ''}`,
      ...(slow ? { fix: 'find what keeps the hub busy (a running build or flash, a large events_read) or what loads the Mac' } : {}),
    });
  }
  return { checks };
}

export const HUB_HANDLERS: Record<HubOpName, Handler> = {
  hub_doctor: (_input: Record<string, never>, hub) => hubDoctor(hub),
};
