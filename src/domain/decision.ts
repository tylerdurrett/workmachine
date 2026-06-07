import type { ArtifactIndexEntry } from './artifacts.js';

/**
 * The output of `decide`: the single next move the coordinator allows.
 *
 * `decide` is a pure fold over the event log — `(events) => Decision` — with no
 * I/O (ADR-0003). It only *names* the step to dispatch; the harness resolver
 * builds the actual command and the executor runs it.
 */
export type Decision =
  | { kind: 'run_step'; stepId: string }
  | { kind: 'wait' }
  | { kind: 'done' };

/** Lifecycle status of a run, derived from the event log. */
export type RunStatus = 'pending' | 'running' | 'completed' | 'failed';

/** Lifecycle status of a single step within a run. */
export type StepStatus = 'pending' | 'running' | 'succeeded' | 'failed';

/** Derived state of a single step, folded from the log. */
export interface StepState {
  /** Id of the step. */
  stepId: string;
  /** Current lifecycle status of the step. */
  status: StepStatus;
  /** The resolved command, once the step has been dispatched. */
  command?: string;
  /** Artifacts produced by the step, once it has succeeded. */
  artifacts?: ArtifactIndexEntry[];
  /** Failure reason, once the step has failed. */
  reason?: string;
}

/**
 * Current run state, produced by folding `events.jsonl` into a snapshot.
 *
 * This is the derived cache that `run.yaml` mirrors (ADR-0003): pure data,
 * always rebuildable by replaying the log.
 */
export interface RunState {
  /** The run's id. */
  runId: string;
  /** Slug of the workflow package being run. */
  workflowSlug: string;
  /** Overall lifecycle status of the run. */
  status: RunStatus;
  /** Inputs the run was created with. */
  inputs: Record<string, unknown>;
  /** Per-step state, keyed by step id. */
  steps: Record<string, StepState>;
  /** Artifacts accumulated across the run. */
  artifacts: ArtifactIndexEntry[];
}
