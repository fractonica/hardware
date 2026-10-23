// Shared pieces of the operation registry (packages/protocol/src/ops.ts and its C3 groups in this
// directory): the op definition shape and the input fields several ops use.

import { z } from 'zod';

export type OpKind = 'query' | 'command' | 'job' | 'wait';

/**
 * Safety tier (09 §9.2, design c6 D17): `read` changes nothing (MCP readOnlyHint), `mutate` acts on the
 * hub or devices. Every command and job is `mutate`, and so are diag_exec, job_cancel and network_set.
 * `destructive` comes in M2.
 */
export type OpTier = 'read' | 'mutate';

export interface OpDef<I extends z.ZodObject = z.ZodObject, O extends z.ZodType = z.ZodType> {
  name: string;
  kind: OpKind;
  tier: OpTier;
  /** MCP tool metadata: `alwaysLoad` sets `_meta["anthropic/alwaysLoad"]` (09 §9.6; hub_status, device_list). */
  mcp?: { alwaysLoad?: boolean };
  /** First sentence: what and when. Kept under 1,000 characters (MCP description limits). */
  summary: string;
  input: I;
  /**
   * The `data` of an ok Result, for OpenAPI and typed clients (design c6 D17). Objects are loose, so a
   * field a handler adds does not break a client. Neither tier, mcp nor output is in REGISTRY_HASH.
   */
  output?: O;
  /** `variadic`: the last positional takes the remaining words, joined with single spaces. */
  cli: { path: string[]; positional?: string[]; variadic?: boolean };
}

/**
 * Keeps the literal op name (design c6 §3.2), so OpName is the union of names: HANDLERS must cover each
 * one, and a typed client finds an op's input and output schemas by name.
 */
export function op<const N extends string, I extends z.ZodObject, O extends z.ZodType = z.ZodType>(def: OpDef<I, O> & { name: N }): OpDef<I, O> & { name: N } {
  return def;
}

/**
 * CLI option name for an input field (spec 09 §9.5): wait_s is --wait, window_s is --window, ttl_s is
 * --ttl, timeout_s is --timeout and any `<x>_timeout_s` --<x>-timeout (seconds are the CLI's unit for
 * every timeout, window and lease), else kebab-case.
 */
export function cliFlag(key: string): string {
  if (key === 'wait_s') {
    return 'wait';
  }
  if (key === 'window_s') {
    return 'window'; // latency_stats: `fr latency <sel> --window 60` (09 §9.5)
  }
  if (key === 'ttl_s') {
    return 'ttl'; // serial_lease: `fr serial lease <dev> --ttl 120` (09 §9.5)
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
/** The device selector of most ops (09 §9.2), as agents read it in a field description. */
export const selector = z.string().min(1).describe('device selector (alias, id:<12hex>, tag:<t>, chip:<c>, online, all; comma-separated, ! negates)');
/** A selector that must name exactly one device. */
export const deviceSel = z.string().min(1).describe('the device: an alias, id:<12hex> or any selector that matches exactly one device');
