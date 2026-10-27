// The bench modules' diag on the fleet (design m2-c2 D11): as e2e-gates-c's loopbackDiag. A line goes through the
// private hub's diag_exec while the node has a hub link (by device id: the hub finds the node's bridge port when it
// holds one, as for a board on the Mac's USB, else sends fr.diag.exec over the node's hub link), and through fr_fleet's
// `diag <line>` control command while it has none, as a board's USB carries it on the bench. A node has no hub link
// while a hook that takes it away is armed (`net drop_hub_link <s>`, `net wifi_down <s>`, until the same hook with 0),
// while the AP is off (the person bot's `fleet ap off`; a node on the bridge keeps its serial session) or while it is
// powered off. A hub answer DEVICE_OFFLINE sends the line to the fleet too.
//
// A cancelled run (the signal) refuses every line at once: the fleet and the hub are thrown away, so a gate's
// per-node restores must not each wait out a 5 s diag timeout (D14).

import type { FleetAnswer } from '@fractonica/protocol';

import { type Hub, HubError } from '../../e2e/lib/hub.ts';
import type { Diag, DiagAnswer, DiagTarget } from '../../e2e/lib/nn-flood-common.ts';

/** What the runner, the person bot and the fleet diag need of fr_fleet's control channel (tests/sim/lib/fleet.ts). */
export interface FleetControl {
  /**
   * One control line `<target> <command>` (target an alias, `*` or `fleet`); resolves with the answers (one per node:
   * every started node's for `*`, and `fleet`'s own one).
   */
  command(target: string, line: string, timeoutMs?: number): Promise<FleetAnswer[]>;
}

/** What the run did to the fleet that decides which way a diag line goes. */
export class FleetState {
  /** fleet ap off, and not yet on. */
  apOff = false;
  /** Nodes powered off (power off, not yet on). */
  readonly off = new Set<string>();
  /** Hooks armed per node that take its hub link away (drop_hub_link, wifi_down). */
  readonly hooks = new Map<string, Set<string>>();
  /** Nodes on the fleet's bridge (a serial session the AP does not touch). */
  readonly usb: Set<string>;

  constructor(usb: Iterable<string> = []) {
    this.usb = new Set(usb);
  }

  /** Whether the node has a hub link the hub can reach it over. */
  linked(alias: string): boolean {
    if (this.off.has(alias)) {
      return false;
    }
    const hooks = this.hooks.get(alias);
    if (hooks?.has('drop_hub_link')) {
      return false;
    }
    // Wi-Fi gone (its hook or the AP): only the bridge carries the hub's lines.
    return this.usb.has(alias) || (!this.apOff && !hooks?.has('wifi_down'));
  }

  /** Records a diag line's effect on the node's links (after the node took it). */
  noteLine(alias: string, line: string): void {
    const hook = /^net (drop_hub_link|wifi_down) (\d+)/.exec(line);
    if (!hook) {
      return;
    }
    const set = this.hooks.get(alias) ?? new Set<string>();
    if (hook[2] === '0') {
      set.delete(hook[1]);
    } else {
      set.add(hook[1]);
    }
    this.hooks.set(alias, set);
  }
}

/** The diag answer a fleet node's `diag <line>` carries: `response`, `diag` or `json`, else the answer itself. */
export function diagResponseOf(a: FleetAnswer): Record<string, unknown> {
  for (const k of ['response', 'diag', 'json']) {
    const v = (a as Record<string, unknown>)[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
    if (typeof v === 'string') {
      try {
        return JSON.parse(v) as Record<string, unknown>;
      } catch {
        // not JSON: fall through
      }
    }
  }
  const { rid: _rid, node: _node, ...rest } = a as Record<string, unknown>;
  return rest;
}

/** fr_fleet's control channel as one diag line (via `fleet`). */
export async function fleetLine(fleet: FleetControl, dev: DiagTarget, line: string, timeoutS: number): Promise<DiagAnswer> {
  const answers = await fleet.command(dev.alias, `diag ${line}`, timeoutS * 1000 + 2000);
  const a = answers.find((x) => x.node === dev.alias) ?? answers[0];
  if (!a) {
    throw new Error(`${dev.alias}: fr_fleet gave no answer to diag ${line}`);
  }
  return { response: diagResponseOf(a), via: 'fleet' };
}

export interface FleetDiagOptions {
  hub: Hub;
  fleet: FleetControl;
  state: FleetState;
  /** The run's signal: a cancelled run refuses every line at once (D14). */
  signal?: AbortSignal;
  /** Each line and where it went, for the evidence. */
  onLine?(alias: string, line: string, via: string): void;
}

/** The bench modules' Diag (runTFlood, runTFloodB, runTNn deps.diag) on the fleet. */
export function fleetDiag(o: FleetDiagOptions): Diag {
  return async (dev, line, timeoutS = 5) => {
    if (o.signal?.aborted) {
      throw new Error(`${dev.alias}: ${line} not sent: the run was cancelled (the fleet is thrown away)`);
    }
    let r: DiagAnswer;
    if (o.state.linked(dev.alias)) {
      try {
        r = await o.hub.ok<DiagAnswer>('diag_exec', { port: dev.device_id, line, timeout_s: timeoutS });
      } catch (e) {
        if (!(e instanceof HubError) || e.code !== 'DEVICE_OFFLINE') {
          throw e;
        }
        r = await fleetLine(o.fleet, dev, line, timeoutS);
      }
    } else {
      r = await fleetLine(o.fleet, dev, line, timeoutS);
    }
    o.onLine?.(dev.alias, line, r.via);
    if ((r.response as { ok?: unknown }).ok === true) {
      o.state.noteLine(dev.alias, line);
    }
    return r;
  };
}

/** T-FLOOD-B's deps.reachable on the fleet: the control channel reaches every node that is powered on. */
export function fleetReachable(state: FleetState): (dev: { alias: string }) => boolean {
  return (dev) => !state.off.has(dev.alias);
}
