// prompt_human (design c6 D3; stream S5): a wait_for_event asks a person at the bench for a real action
// ("Press BOOT on pad-c6") while it waits. The prompt is published as hub.prompt {prompt_id, text,
// selector?, types, expires_at} (stored, so the dashboard's toast and Agents list and `fr` can see it),
// listed in hub_status.prompts while pending, and ended once by hub.prompt_done {prompt_id, outcome}:
// matched, timeout, or cancelled when the waiting client goes away or the hub stops.

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

import type { Prompt, PromptOutcome } from '@fractonica/protocol';

import type { HubContext, HubRunOptions, PromptHandle, Prompts } from './context.ts';
import { nowUs } from './ring.ts';

/**
 * The calling request's abort signal, aborted when its client disconnects (http.ts runs each op inside it):
 * a wait whose client is gone ends its prompt as cancelled at once instead of at its timeout.
 */
export const requestSignal = new AsyncLocalStorage<AbortSignal>();

/** A prompt whose wait never ended it (a handler that died) is dropped this long after its expires_at, as timeout. */
const EXPIRY_GRACE_MS = 5000;

export function createPrompts(hub: () => HubContext, _run: HubRunOptions): Prompts {
  const pending = new Map<string, { prompt: Prompt; timer: NodeJS.Timeout }>();

  const finish = (id: string, outcome: PromptOutcome): void => {
    const p = pending.get(id);
    if (!p) {
      return;
    }
    pending.delete(id);
    clearTimeout(p.timer);
    hub().events.publish({ type: 'hub.prompt_done', t_hub_us: nowUs(), fields: { prompt_id: id, outcome } });
  };

  return {
    start() {},

    stop() {
      // The bus still runs (main.ts stops the C6 parts first): every pending prompt ends as cancelled.
      for (const id of [...pending.keys()]) {
        finish(id, 'cancelled');
      }
    },

    open(p): PromptHandle {
      const prompt: Prompt = {
        prompt_id: `p_${randomBytes(4).toString('hex')}`,
        text: p.text,
        ...(p.selector !== undefined ? { selector: p.selector } : {}),
        types: [...p.types],
        expires_at: p.expires_at,
      };
      const timer = setTimeout(() => finish(prompt.prompt_id, 'timeout'), Math.max(0, Date.parse(p.expires_at) - Date.now()) + EXPIRY_GRACE_MS);
      timer.unref();
      pending.set(prompt.prompt_id, { prompt, timer });
      hub().events.publish({ type: 'hub.prompt', t_hub_us: nowUs(), fields: { ...prompt, types: [...prompt.types] } });
      return {
        prompt,
        done: (outcome) => finish(prompt.prompt_id, outcome),
      };
    },

    pending: () => [...pending.values()].map(({ prompt }) => ({ ...prompt, types: [...prompt.types] })),
  };
}

/** A wait's prompt (humanPrompt): its id for the result, and how the wait ended it. */
export interface WaitPrompt {
  readonly prompt_id: string;
  /** The waiting client went away (its request was aborted): the wait stops. */
  cancelled(): boolean;
  /** Ends the prompt with the wait: matched, else cancelled or timeout. Once. */
  end(matched: boolean): void;
}

/**
 * Opens the prompt_human of a wait (design c6 D3) once it is registered and its backlog did not already
 * satisfy it, for the wait's timeout. `wake` stops the wait early when the client goes away (the request
 * signal in requestSignal aborts), and the prompt then ends as cancelled.
 */
export function humanPrompt(
  hub: Pick<HubContext, 'prompts'>,
  p: { text: string; selector?: string; types: string[]; timeoutS: number },
  wake: () => void,
): WaitPrompt {
  const handle = hub.prompts.open({
    text: p.text,
    ...(p.selector !== undefined ? { selector: p.selector } : {}),
    types: p.types,
    expires_at: new Date(Date.now() + p.timeoutS * 1000).toISOString(),
  });
  const signal = requestSignal.getStore();
  let gone = signal?.aborted ?? false;
  const onAbort = () => {
    gone = true;
    wake();
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (gone) {
    queueMicrotask(wake);
  }
  let ended = false;
  return {
    prompt_id: handle.prompt.prompt_id,
    cancelled: () => gone,
    end(matched) {
      if (ended) {
        return;
      }
      ended = true;
      signal?.removeEventListener('abort', onAbort);
      handle.done(matched ? 'matched' : gone ? 'cancelled' : 'timeout');
    },
  };
}
