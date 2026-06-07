import { existsSync } from 'node:fs';
import { scriptExecutor } from '../executor/index.js';
import { tick } from '../harness/index.js';
import { JsonlEventLog, resolveRunDir, writeRunCache } from '../run/index.js';
import { loadWorkflowFile } from '../workflow/index.js';

/**
 * The `tick` flow: advance an existing run by one harness pass.
 *
 * This is the CLI wrapper around the harness loop (`../harness/tick.ts`). It
 * resolves the run's directory from its id, loads the *pinned* workflow snapshot
 * (so a run always ticks against the definition it was created with, even if the
 * source package changed), and hands the harness the real `scriptExecutor`. The
 * harness reads the run id back from the log's `run_created` event — never from
 * here — keeping that identity single-sourced (CONTEXT.md → Run / run id scheme).
 *
 * Idempotency is inherited from the harness: ticking a completed run reads the
 * log, decides `done`, and returns without appending. We refresh the derived
 * `run.yaml` cache afterward regardless, so it always mirrors the latest log.
 *
 * Named `runTick` (not `tick`) so it is not confused with the harness `tick` it
 * delegates to.
 */

/** Inputs to {@link runTick}. */
export interface RunTickOptions {
  /** Id of the run to advance; names its directory under `runsRoot`. */
  runId: string;
  /** Absolute path to the `runs/` root that holds all run instances. */
  runsRoot: string;
  /** Optional clock injection forwarded to the harness (tests pass a fixed one). */
  now?: () => string;
}

/**
 * Advance a run via the harness, then refresh its derived cache.
 *
 * @param opts the run id, runs root, and optional injected clock.
 * @throws if no run directory exists for `runId`.
 */
export async function runTick(opts: RunTickOptions): Promise<void> {
  const layout = resolveRunDir(opts.runsRoot, opts.runId);
  if (!existsSync(layout.runDir)) {
    throw new Error(`no such run: ${opts.runId}`);
  }

  const workflow = loadWorkflowFile(layout.workflowSnapshotPath);
  const log = new JsonlEventLog(layout.eventsLogPath);

  await tick({
    workflow,
    log,
    executor: scriptExecutor,
    runDir: layout.runDir,
    ...(opts.now ? { now: opts.now } : {}),
  });

  writeRunCache(layout.runCachePath, log.read());
}
