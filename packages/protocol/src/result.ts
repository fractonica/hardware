// Result envelope shared by CLI --json, REST and MCP (spec 09 §9.2-9.3).

export const ERROR_CODES = [
  'NOT_FOUND',
  'AMBIGUOUS_SELECTOR',
  'DEVICE_OFFLINE',
  'LOCKED',
  'DEVICE_BUSY',
  'PORT_BUSY_EXTERNAL',
  'PORT_LEASED',
  'BUILD_FAILED',
  'FLASH_FAILED',
  'TARGET_MISMATCH',
  'INCOMPATIBLE_PROFILE',
  'TIMEOUT',
  'INVALID_ARGS',
  'INVALID_SOURCE',
  'ENV_MISSING',
  'HUB_UNREACHABLE',
  'HUB_RESTARTED',
  'HUB_VERSION_MISMATCH',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface Remediation {
  tool?: string;
  args?: Record<string, unknown>;
  cli?: string;
  human?: string;
}

export interface ToolError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  hint?: string;
  remediation?: Remediation[];
  details?: Record<string, unknown>;
}

export interface Result<T = unknown> {
  ok: boolean;
  data?: T;
  error?: ToolError;
  cursor: string;
  warnings?: string[];
}

const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'DEVICE_OFFLINE',
  'LOCKED',
  'DEVICE_BUSY',
  'PORT_BUSY_EXTERNAL',
  'PORT_LEASED',
  'TIMEOUT',
  'HUB_UNREACHABLE',
]);

/** Thrown by op handlers; converted to a failed Result at the API boundary. */
export class FrError extends Error {
  code: ErrorCode;
  hint?: string;
  remediation?: Remediation[];
  details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    extra: { hint?: string; remediation?: Remediation[]; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = 'FrError';
    this.code = code;
    this.hint = extra.hint;
    this.remediation = extra.remediation;
    this.details = extra.details;
  }

  toToolError(): ToolError {
    return {
      code: this.code,
      message: this.message,
      retryable: RETRYABLE.has(this.code),
      ...(this.hint ? { hint: this.hint } : {}),
      ...(this.remediation ? { remediation: this.remediation } : {}),
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export function okResult<T>(data: T, cursor: string, warnings?: string[]): Result<T> {
  return { ok: true, data, cursor, ...(warnings && warnings.length ? { warnings } : {}) };
}

export function errorResult(err: unknown, cursor: string): Result<never> {
  if (err instanceof FrError) {
    return { ok: false, error: err.toToolError(), cursor };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, error: { code: 'INTERNAL', message, retryable: false }, cursor };
}

/** CLI exit codes (spec 09 §9.3). Exit 2 is avoided because Claude Code hooks treat it as "block". */
export function exitCodeFor(code: ErrorCode | undefined): number {
  switch (code) {
    case undefined:
      return 0;
    case 'NOT_FOUND':
      return 3;
    case 'TIMEOUT':
      return 4;
    case 'LOCKED':
    case 'DEVICE_BUSY':
    case 'PORT_BUSY_EXTERNAL':
    case 'PORT_LEASED':
      return 5;
    case 'BUILD_FAILED':
      return 7;
    case 'FLASH_FAILED':
      return 8;
    case 'HUB_UNREACHABLE':
      return 10;
    case 'INVALID_ARGS':
    case 'INVALID_SOURCE':
      return 64;
    default:
      return 1;
  }
}
