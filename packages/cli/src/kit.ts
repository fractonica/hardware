// What main.ts hands the hand-written commands (design c6 §3.3: `fr mcp`, `fr serial lease|monitor`,
// `fr codegen client`), so they print and exit as the generated op commands do.

import type { ErrorCode, OpName, Result } from '@fractonica/protocol';

export interface CliKit {
  /** `--json` was given: print one JSON Result envelope on stdout. */
  json(): boolean;
  /**
   * Runs an op as its generated command would: source_dir filled from the cwd, the CLI's job wait, the hub's
   * health and registry hash checked; prints the Result and exits with its code.
   */
  run(op: OpName, input: Record<string, unknown>): Promise<never>;
  /** Prints a Result as op's command would (or as JSON with --json) and exits with its exit code. */
  emit(r: Result, op: string): Promise<never>;
  /** Prints a failed Result and exits with the code's exit status. */
  fail(code: ErrorCode, message: string, op: string, remediation?: { cli?: string; human?: string }[]): Promise<never>;
  /** Exits with `code` once `out` and `err` have drained to stdout and stderr. */
  exit(code: number, out?: string, err?: string): Promise<never>;
}
