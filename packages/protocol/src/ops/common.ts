// Shared pieces of the operation registry (packages/protocol/src/ops.ts and its C3 groups in this
// directory): the op definition shape and the input fields several ops use.

import { z } from 'zod';

export type OpKind = 'query' | 'command' | 'job' | 'wait';

export interface OpDef<I extends z.ZodObject = z.ZodObject> {
  name: string;
  kind: OpKind;
  /** First sentence: what and when. Kept under 1,000 characters (MCP description limits). */
  summary: string;
  input: I;
  /** `variadic`: the last positional takes the remaining words, joined with single spaces. */
  cli: { path: string[]; positional?: string[]; variadic?: boolean };
}

export function op<I extends z.ZodObject>(def: OpDef<I>): OpDef<I> {
  return def;
}

/**
 * CLI option name for an input field (spec 09 §9.5): wait_s is --wait, window_s is --window, timeout_s is
 * --timeout and any `<x>_timeout_s` --<x>-timeout (seconds are the CLI's unit for every timeout and
 * window), else kebab-case.
 */
export function cliFlag(key: string): string {
  if (key === 'wait_s') {
    return 'wait';
  }
  if (key === 'window_s') {
    return 'window'; // latency_stats: `fr latency <sel> --window 60` (09 §9.5)
  }
  return (key.endsWith('timeout_s') ? key.slice(0, -2) : key).replace(/_/g, '-');
}

/** Max server-side wait. Claude Code backgrounds tool calls after 2 minutes. */
export const MAX_WAIT_S = 110;

export const waitS = z.number().int().min(0).max(MAX_WAIT_S).optional().describe('seconds to wait for the job to finish (cap 110)');
export const sourceDir = z
  .string()
  .describe('absolute path of the checkout containing firmware/idf-version.lock (the CLI fills it from its cwd)');
export const portSel = z.string().describe('USB serial (MAC), 12-hex device id, or /dev path');
export const cursor = z.string().regex(/^c:\d+\.\d+$/, 'expected a cursor c:<run>.<seq>');
