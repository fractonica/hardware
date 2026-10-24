// Handlers of the OTA ops (packages/protocol/src/ops/ota.ts; design c4 §4): ota_deploy and ota_status over
// the orchestrator (stream H1), deploy from deploy.ts (stream H2). Spread into HANDLERS (packages/hub/src/ops.ts).
// M2-C1 (design m2-c1-hil D15; stream S4): no OTA to the HIL fixture, which is updated over USB only; deploy
// is refused the same way before it builds anything (I1), as its callOp('ota_deploy') would be after.

import { FrError, MAX_WAIT_S, type OtaOpName } from '@fractonica/protocol';

import type { Device, Handler, HubContext, OpInput } from '../context.ts';
import { fenceOta } from '../fixture/fence.ts';
import { presenceOf, registryOf } from '../registry/hub.ts';
import { deploy } from './deploy.ts';
import { type OtaDeployInput, otaOrchestrator } from './index.ts';

/** The devices ota_deploy's selector names; [] when it names none (the orchestrator's plan says why). */
function selected(hub: HubContext, selector: string): Device[] {
  try {
    return registryOf(hub).resolve(selector, presenceOf(hub));
  } catch (e) {
    if (e instanceof FrError && (e.code === 'NOT_FOUND' || e.code === 'INVALID_ARGS')) {
      return [];
    }
    throw e;
  }
}

export const OTA_HANDLERS: Record<OtaOpName, Handler> = {
  // A dry run answers the plan (devices, artifact, transport, action, locks) and starts nothing (09 §9.2).
  ota_deploy: async (input: OtaDeployInput, hub: HubContext) => {
    const ota = otaOrchestrator(hub);
    fenceOta(hub, selected(hub, input.selector));
    if (input.dry_run) {
      return { dry_run: true, max_parallel: input.max_parallel, on_failure: input.on_failure, devices: ota.plan(input, hub) };
    }
    const job = ota.startRollout(input, hub);
    return hub.jobs.wait(job.job_id, Math.min(input.wait_s ?? 0, MAX_WAIT_S));
  },
  ota_status: (input: { selector?: string; job?: string }, hub: HubContext) => otaOrchestrator(hub).status(input, hub),
  deploy: async (input: OpInput<'deploy'>, hub: HubContext) => {
    fenceOta(hub, selected(hub, input.selector));
    return deploy(input, hub);
  },
};
