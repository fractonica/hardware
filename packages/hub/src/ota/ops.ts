// Handlers of the OTA ops (packages/protocol/src/ops/ota.ts; design c4 §4): ota_deploy and ota_status over
// the orchestrator (stream H1), deploy from deploy.ts (stream H2). Spread into HANDLERS (packages/hub/src/ops.ts).

import { MAX_WAIT_S, type OtaOpName } from '@fractonica/protocol';

import type { Handler, HubContext } from '../context.ts';
import { deploy } from './deploy.ts';
import { type OtaDeployInput, otaOrchestrator } from './index.ts';

export const OTA_HANDLERS: Record<OtaOpName, Handler> = {
  // A dry run answers the plan (devices, artifact, transport, action, locks) and starts nothing (09 §9.2).
  ota_deploy: async (input: OtaDeployInput, hub: HubContext) => {
    const ota = otaOrchestrator(hub);
    if (input.dry_run) {
      return { dry_run: true, max_parallel: input.max_parallel, on_failure: input.on_failure, devices: ota.plan(input, hub) };
    }
    const job = ota.startRollout(input, hub);
    return hub.jobs.wait(job.job_id, Math.min(input.wait_s ?? 0, MAX_WAIT_S));
  },
  ota_status: (input: { selector?: string; job?: string }, hub: HubContext) => otaOrchestrator(hub).status(input, hub),
  deploy,
};
