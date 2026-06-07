import { existsSync } from 'node:fs';
import {
  JsonlEventLog,
  createRunDir,
  resolveRunDir,
  writeRunCache,
} from '../run/index.js';
import { loadWorkflowFile } from '../workflow/index.js';
import { mintRunId } from './mint-run-id.js';

/**
 * The `run create` flow: mint a run's identity and scaffold its directory.
 *
 * This is the front door for a run instance and the one place its id is born
 * (CONTEXT.md → Run / run id scheme). The id is minted here on the impure side
 * — clock and randomness injected — recorded once in the `run_created` event,
 * and never re-derived: every later tick reads it back from the log. All I/O
 * lives here at the seam (loading the source workflow, scaffolding the dir,
 * appending the seed event, seeding the cache); the orchestrator stays pure.
 *
 * The workflow definition is pinned into `workflow.snapshot.yaml` at create time
 * so the run reproduces against the exact definition it was started with, even
 * if the source workflow package later changes.
 */

/** Inputs to {@link runCreate}; clock and randomness are injected for purity. */
export interface RunCreateOptions {
  /** Path to the source `workflow.yaml` to create the run against. */
  workflowPath: string;
  /** Operator-supplied inputs, recorded verbatim in `run_created`. */
  inputs: Record<string, unknown>;
  /**
   * `--run-id` override, or `undefined` to mint one. An override whose dir
   * already exists is refused (a run id names a unique instance).
   */
  runId: string | undefined;
  /** Absolute path to the `runs/` root that holds all run instances. */
  runsRoot: string;
  /** Injected clock returning an ISO-8601 instant. */
  now: () => string;
  /** Injected randomness for the minted id's disambiguating suffix. */
  rand: () => string;
}

/** What {@link runCreate} hands back: the run's id and its directory path. */
export interface RunCreateResult {
  runId: string;
  runDir: string;
}

/**
 * Create a new run: load and pin the workflow, scaffold `runs/<id>/`, and seed
 * the log with `run_created`.
 *
 * @param opts the workflow path, inputs, optional id override, runs root, and
 *   injected clock/randomness.
 * @returns the minted (or overridden) run id and its directory path.
 * @throws if an explicit `--run-id` override names an existing run directory.
 */
export function runCreate(opts: RunCreateOptions): RunCreateResult {
  const workflow = loadWorkflowFile(opts.workflowPath);
  const runId = opts.runId ?? mintRunId(workflow.slug, opts.now, opts.rand);
  const layout = resolveRunDir(opts.runsRoot, runId);

  // Check first for a friendly message; createRunDir's mkdir is the hard EEXIST
  // backstop that still enforces the "a run id is unique" invariant at the seam.
  if (existsSync(layout.runDir)) {
    throw new Error(`run directory already exists: ${layout.runDir}`);
  }

  createRunDir(layout, workflow);

  const log = new JsonlEventLog(layout.eventsLogPath);
  log.append({
    type: 'run_created',
    runId,
    seq: 0,
    ts: opts.now(),
    workflowSlug: workflow.slug,
    inputs: opts.inputs,
  });
  writeRunCache(layout.runCachePath, log.read());

  return { runId, runDir: layout.runDir };
}
