// Handler of the app ops (packages/protocol/src/ops/apps.ts; design c6 §4, stream S1): client_generate,
// spread into HANDLERS (packages/hub/src/ops.ts). The files are rendered in client-gen.ts.

import type { AppsOpName } from '@fractonica/protocol';

import type { Handler, HubContext, OpInput } from '../context.ts';
import { clientGenerate } from './client-gen.ts';

export const APPS_HANDLERS: Record<AppsOpName, Handler> = {
  client_generate: (input: OpInput<'client_generate'>, hub: HubContext) => clientGenerate(hub, input),
};
