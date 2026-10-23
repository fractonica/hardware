// Handler of the T-LAT probe op (PROBE_OPS in packages/protocol/src/ops/net.ts; design c6 §6 S7, stream
// S7): latency_probe over HubContext.latencyProbe (probe.ts), a job of kind latency, waited for up to
// wait_s like every job op. Spread into HANDLERS (packages/hub/src/ops.ts).

import { MAX_WAIT_S, type ProbeOpName } from '@fractonica/protocol';

import type { Handler } from '../context.ts';
import type { ProbeInput } from './probe.ts';

export const PROBE_HANDLERS: Record<ProbeOpName, Handler> = {
  latency_probe: async (input: ProbeInput, hub) => {
    const job = hub.latencyProbe.probe(input);
    return hub.jobs.wait(job.job_id, Math.min(input.wait_s ?? 0, MAX_WAIT_S));
  },
};
