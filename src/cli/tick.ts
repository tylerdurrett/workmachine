import { existsSync } from 'node:fs';
import { scriptExecutor } from '../executor/index.js';
import { tick } from '../harness/index.js';
import { foldRunState } from '../orchestrator/index.js';
import { JsonlEventLog, resolveRunDir, writeRunCache } from '../run/index.js';
import {
  GitHubTracker,
  resolveGitHubConfig,
  type TrackerAdapter,
} from '../tracker/index.js';
import { isGateStep, loadWorkflowFile } from '../workflow/index.js';

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
 * It also builds the live tracker the harness renders the review card onto when a
 * gate opens (ADR-0004). The run is self-describing: the target repo is read from
 * the folded `RunState.card.repo` (recorded on `card_created`), never re-supplied
 * here, so a tick projects onto the exact card the run was created with. The
 * tracker is built only for a run that can render a review card — one with a gate
 * step and an opened card — so a gateless run never constructs a tracker it would
 * never use, and the harness skips the projection silently when none is passed.
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
  /**
   * Build the tracker the run's review card is rendered onto, given the
   * `owner/name` repo the run recorded on `card_created`. Injected so a tick is
   * testable offline (a {@link FakeTracker}); defaults to a live
   * {@link GitHubTracker} resolved from the environment.
   */
  makeTracker?: (repo: string) => TrackerAdapter;
}

/**
 * Build the live tracker for a resolved repo: a {@link GitHubTracker} over the
 * config resolved from `process.env` plus the run's recorded repo (ADR-0008 —
 * the engine hard-codes no tracker repo). Mirrors `run-create`/`main`'s wiring so
 * a created card and the card a later tick re-renders address the same repo.
 */
function defaultMakeTracker(repo: string): TrackerAdapter {
  return new GitHubTracker(resolveGitHubConfig(process.env, { repo }));
}

/**
 * Advance a run via the harness, then refresh its derived cache.
 *
 * @param opts the run id, runs root, optional injected clock, and optional
 *   tracker factory.
 * @throws if no run directory exists for `runId`.
 */
export async function runTick(opts: RunTickOptions): Promise<void> {
  const layout = resolveRunDir(opts.runsRoot, opts.runId);
  if (!existsSync(layout.runDir)) {
    throw new Error(`no such run: ${opts.runId}`);
  }

  const workflow = loadWorkflowFile(layout.workflowSnapshotPath);
  const log = new JsonlEventLog(layout.eventsLogPath);

  // Resolve the tracker from the run's recorded card: the run is self-describing,
  // so the repo comes from the folded state, not from the caller. Built only when
  // the run can actually render a review card — it has a gate step AND an opened
  // card — so a gateless run never constructs a (live) tracker it would never use,
  // and the harness skips the projection silently when no tracker is passed.
  const makeTracker = opts.makeTracker ?? defaultMakeTracker;
  const repo = foldRunState(workflow, log.read()).card?.repo;
  const hasGate = workflow.steps.some(isGateStep);
  const tracker = hasGate && repo !== undefined ? makeTracker(repo) : undefined;

  await tick({
    workflow,
    log,
    executor: scriptExecutor,
    runDir: layout.runDir,
    ...(opts.now ? { now: opts.now } : {}),
    ...(tracker ? { tracker } : {}),
  });

  writeRunCache(layout.runCachePath, log.read());
}
