// The hub's OTA side (design c4 §4, spec 06 §6.7, 08 §8.10; stream H1): the per-device job orchestrator
// (orchestrator.ts) and the node HTTP listener on 7422 (http.ts), behind the OtaService HubContext
// carries. main.ts creates it with createOta; the op handlers (ops.ts, deploy.ts) reach the orchestrator
// through otaOrchestrator(hub).

import { FrError } from '@fractonica/protocol';

import type { HubContext } from '../context.ts';
import { type OtaDeps, OtaOrchestrator } from './orchestrator.ts';

export { NodeHttpServer, parseRange, type NodeHttpCounters, type OtaImage } from './http.ts';
export {
  ACCEPT_CODES,
  FAILED_REASONS,
  isTerminal,
  NODE_HTTP_PORT,
  OFFER_FLAGS,
  OTA_DEFAULTS,
  OTA_JOB_STATE_EVENT,
  OTA_JOB_STATES,
  OtaOrchestrator,
  OUTCOME,
  PHASE,
  REJECT_NAMES,
  ROLLBACK_REASONS,
  statusRow,
  type OtaConfig,
  type OtaDeployInput,
  type OtaDeps,
  type OtaJobState,
  type OtaJobStateFields,
  type OtaPlanDevice,
  type OtaRecord,
  type OtaStatusRow,
  type OtaVia,
} from './orchestrator.ts';

export function createOta(deps: OtaDeps): OtaOrchestrator {
  return new OtaOrchestrator(deps);
}

/** The hub's orchestrator; INTERNAL for a context without one (a test hub built for other ops). */
export function otaOrchestrator(hub: Pick<HubContext, 'ota'>): OtaOrchestrator {
  if (!(hub.ota instanceof OtaOrchestrator)) {
    throw new FrError('INTERNAL', 'this hub has no OTA orchestrator');
  }
  return hub.ota;
}

/** What an op answers until its stream implements it. */
export function notYet(op: string): never {
  throw new FrError('INTERNAL', `${op} is not implemented in this hub yet (checkpoint C4 in progress)`);
}
