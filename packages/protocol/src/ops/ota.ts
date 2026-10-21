// OTA ops (design c4 §4, spec 09 §9.4-9.5; streams H1 and H2): ota_deploy and ota_status, then deploy in
// its own section below. Spread into OPS (packages/protocol/src/ops.ts); handlers in
// packages/hub/src/ota/ops.ts (ota_deploy, ota_status) and packages/hub/src/ota/deploy.ts (deploy).

import { z } from 'zod';

import { MAX_WAIT_S, op, sourceDir, waitS } from './common.ts';

const selector = z.string().min(1).describe('device selector (alias, id:<12hex>, tag:<t>, chip:<c>, online, all; comma-separated, ! negates)');
const via = z
  .enum(['auto', 'serial', 'wifi'])
  .default('auto')
  .describe("transport: auto = serial when the device's USB port is open and idle, else Wi-Fi");

export const OTA_OPS = [
  op({
    name: 'ota_deploy',
    kind: 'job',
    summary:
      "Update the selected devices' firmware: an HTTP pull over Wi-Fi from the hub (or serial, via), one child job per device with OFFER -> download -> reboot -> health check. The artifact is `build`, else the newest debug artifact of each device's registry profile (or `profile`); a fault build only by naming it, and only over Wi-Fi (auto picks Wi-Fi for it; via serial is INVALID_ARGS). A device already running it reports already_current (unless force). Events: ota.job.state.",
    input: z.object({
      selector,
      build: z.string().optional().describe('build_id; default: the newest debug artifact of each device profile'),
      profile: z.string().optional().describe("profile whose newest debug artifact to deploy; default: each device's registry profile"),
      via,
      max_parallel: z.number().int().min(1).max(16).default(4),
      on_failure: z.enum(['halt', 'continue']).default('continue').describe('halt: no new device starts after a failure'),
      force: z.boolean().default(false).describe('skip the identity and same-firmware checks (REJECT identity, same_fw)'),
      allow_downgrade: z.boolean().default(false),
      dry_run: z.boolean().default(false),
      wait_s: waitS,
    }),
    cli: { path: ['ota'], positional: ['selector'] },
  }),
  op({
    name: 'ota_status',
    kind: 'query',
    summary: 'OTA jobs: per-device state (QUEUED .. SUCCEEDED, FAILED, ROLLED_BACK, TIMED_OUT, CANCELLED), bytes and timings, by job or by selector.',
    input: z.object({
      selector: selector.optional(),
      job: z.string().optional().describe('an ota_deploy job id'),
    }),
    cli: { path: ['ota', 'status'], positional: ['selector'] },
  }),

  // ---- deploy (stream H2) ----
  op({
    name: 'deploy',
    kind: 'job',
    summary:
      "The happy path in one call: build once per distinct registry profile of the selected devices (build_start; fault: health builds a debug image that never passes its health check), hand each profile's devices to ota_deploy with that build (via), wait for each back online on the new fw_id, then for expect_log / expect_event since the device last went down. A device already running the build is already_current. Per device: outcome updated | already_current | rolled_back | failed, the OTA state, expect matched | timeout | skipped. A fault deploy goes over Wi-Fi and expects rolled_back. The job fails (OTA_FAILED, OTA_ROLLED_BACK, BUILD_FAILED or TIMEOUT for an expectation) unless every device ends as expected, with the per-device results in error.details.",
    input: z.object({
      selector,
      source_dir: sourceDir,
      build_type: z.enum(['debug', 'release']).default('debug'),
      via,
      fault: z.enum(['health']).optional().describe('debug only: deploy a fault build over Wi-Fi (health: rolls back)'),
      expect_log: z.string().min(1).optional().describe('a log line containing this text, after the device came back (not with expect_event); the hub reads logs only from a USB port it holds open, so each device needs one (for a node on Wi-Fi alone use expect_event)'),
      expect_event: z.string().min(1).optional().describe('event type globs, e.g. node.boot, after the device came back (not with expect_log)'),
      expect_timeout_s: z.number().int().min(1).max(MAX_WAIT_S).default(30).describe('seconds each device has to show expect_log / expect_event'),
      dry_run: z.boolean().default(false),
      wait_s: waitS,
    }),
    cli: { path: ['deploy'], positional: ['selector'] },
  }),
] as const;

export type OtaOpName = (typeof OTA_OPS)[number]['name'];
