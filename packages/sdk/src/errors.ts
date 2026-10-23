// Errors of @fractonica/sdk: connect() and the socket's own failures (FractonicaError), and a command or MSG
// the device or hub answered with anything but ok (CommandError, carrying the `result` frame).

import type { CommandStatus, ResultFrame } from './wire.ts';

/**
 * Why the SDK could not do something itself:
 * - HUB_UNREACHABLE: no welcome within connectTimeoutMs (no hub, wrong url, no WebSocket in this runtime);
 * - UNAUTHORIZED: the hub closed with 4401 (a missing or wrong token: `fr codegen client`, or the page's injection);
 * - VERSION_MISMATCH: the hub closed with 4409 (another fr-app major);
 * - PROTOCOL: the hub closed with 4400, or sent a frame this SDK cannot read;
 * - CLOSED: hub.close() was called, or the hub sent an `error` frame for a request.
 */
export type FractonicaErrorCode = 'HUB_UNREACHABLE' | 'UNAUTHORIZED' | 'VERSION_MISMATCH' | 'PROTOCOL' | 'CLOSED';

export class FractonicaError extends Error {
  readonly code: FractonicaErrorCode | (string & {});

  constructor(code: FractonicaErrorCode | (string & {}), message: string) {
    super(message);
    this.name = 'FractonicaError';
    this.code = code;
  }
}

/**
 * A command or MSG that did not succeed: `status` is the RESULT's (busy, invalid_args, failed, ...) or the
 * hub's own (offline, timeout, not_found, injection_disabled). While disconnected, reliable commands reject
 * with `offline` at once.
 */
export class CommandError extends Error {
  readonly status: CommandStatus | (string & {});
  /** The hub's `result` frame; absent when the SDK answered itself (disconnected, timed out locally). */
  readonly result?: ResultFrame;

  constructor(status: CommandStatus | (string & {}), message: string, result?: ResultFrame) {
    super(message);
    this.name = 'CommandError';
    this.status = status;
    if (result) {
      this.result = result;
    }
  }
}
