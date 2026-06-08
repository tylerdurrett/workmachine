import type { ArtifactIndexEntry } from './artifacts.js';
import type { GateDecision } from './events.js';

/**
 * The output of `decide`: the single next move the coordinator allows.
 *
 * `decide` is a pure fold over the event log — `(events) => Decision` — with no
 * I/O (ADR-0003). It only *names* the move; the harness carries it out. Gate
 * moves only name what is allowed:
 *  - `open_gate` names the review step whose gate must be opened (the harness
 *    appends `gate_opened`).
 *  - `decide_gate` names the validated verb/gate/actor of the first valid
 *    command; the harness appends `gate_decided`. `decide` never appends it.
 */
export type Decision =
  | { kind: 'run_step'; stepId: string }
  | { kind: 'open_gate'; gateId: string; stepId: string }
  | {
      kind: 'decide_gate';
      gateId: string;
      decision: GateDecision;
      actor: string;
      /** Revision feedback, present only when `decision` is `request_changes`. */
      feedback?: string;
    }
  | { kind: 'wait' }
  | { kind: 'done' };

/** Lifecycle status of a run, derived from the event log. */
export type RunStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'rejected';

/**
 * Lifecycle status of a single step within a run.
 *
 * A plain `script` step runs `pending → running → succeeded | failed`. A review
 * step adds the gate states once it has `succeeded`: it enters
 * `awaiting_review` (gate open) and then resolves to `approved`,
 * `changes_requested`, or `rejected` per the validated decision.
 * `changes_requested` loops the step back to `pending` for re-dispatch.
 */
export type StepStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'awaiting_review'
  | 'approved'
  | 'changes_requested'
  | 'rejected';

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
  /** The validated decision that closed this review step's gate, once decided. */
  decision?: GateDecision;
  /** Revision feedback from a `request_changes` decision, once recorded. */
  feedback?: string;
}

/**
 * The run's tracker card, derived from the `card_created` fact in the log. It is
 * the projection target the run's state renders onto; recorded here so the
 * folded state is self-describing without re-reading the tracker. The domain
 * stays tracker-agnostic (CONTEXT.md → Language): this is a card ref, never a
 * GitHub issue.
 */
export interface RunCard {
  /** Provider-stable card id (the GitHub issue number, as a string). */
  id: string;
  /** Human-openable url for the card surface. */
  url: string;
  /** The `owner/name` repo the card was opened against. */
  repo: string;
}

/** The currently-open gate: at most one this slice (ADR-0004). */
export interface OpenGate {
  /** Stable id of the open gate (the target a command must match). */
  gateId: string;
  /** Id of the review step this gate guards. */
  stepId: string;
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
  /**
   * The run's tracker card, once `run create` has opened it (`card_created`).
   * Absent until the card is opened; the field is omitted (not `undefined`)
   * under `exactOptionalPropertyTypes`.
   */
  card?: RunCard;
  /**
   * The currently-open gate, if any. Set when a `gate_opened` has no matching
   * `gate_decided` yet; cleared once the gate is decided. At most one this slice
   * (ADR-0004).
   */
  openGate?: OpenGate;
}
