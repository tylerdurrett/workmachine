import type { ArtifactIndexEntry } from './artifacts.js';

/**
 * Event taxonomy for the gateless subset of a run.
 *
 * `events.jsonl` is the append-only canonical record of a run (ADR-0003). Every
 * event carries the {@link EventEnvelope} and a `type` discriminant; the union
 * {@link EngineEvent} is what `decide` folds over to derive current state.
 *
 * Gate events (`gate_opened` / `command_received` / `gate_decided`) arrive in a
 * later slice and are deliberately absent here.
 */

/** The discriminant tags for the gateless event subset. */
export type EngineEventType =
  | 'run_created'
  | 'step_dispatched'
  | 'step_succeeded'
  | 'step_failed'
  | 'run_completed'
  | 'run_failed';

/**
 * Fields shared by every event in the log.
 *
 * `ts` is recorded by the harness/executor when the event is appended — never by
 * `decide`, which performs no I/O and reads no clock (ADR-0003).
 */
export interface EventEnvelope {
  /** Discriminant identifying the event kind. */
  type: EngineEventType;
  /** Run this event belongs to (`<timestamp>-<workflow-slug>-<rand4>`). */
  runId: string;
  /** Monotonic position of this event in the run's log. */
  seq: number;
  /** ISO-8601 timestamp recorded by the harness/executor at append time. */
  ts: string;
}

/** The run was minted: records its id, workflow, and inputs. */
export interface RunCreatedEvent extends EventEnvelope {
  type: 'run_created';
  /** Slug of the workflow package being run. */
  workflowSlug: string;
  /** The operator-supplied inputs the run was created with. */
  inputs: Record<string, unknown>;
}

/**
 * A step was dispatched to its executor. The resolver records the
 * fully-resolved command here so the log is self-describing on replay.
 */
export interface StepDispatchedEvent extends EventEnvelope {
  type: 'step_dispatched';
  /** Id of the step being dispatched. */
  stepId: string;
  /** The fully-resolved command the executor runs (no `{{...}}` left). */
  command: string;
}

/** A step finished successfully, producing zero or more artifacts. */
export interface StepSucceededEvent extends EventEnvelope {
  type: 'step_succeeded';
  /** Id of the step that succeeded. */
  stepId: string;
  /** Artifacts the step produced, by index entry. */
  artifacts: ArtifactIndexEntry[];
}

/** A step failed. */
export interface StepFailedEvent extends EventEnvelope {
  type: 'step_failed';
  /** Id of the step that failed. */
  stepId: string;
  /** Human-readable failure reason. */
  reason: string;
}

/** Terminal success for the whole run. */
export interface RunCompletedEvent extends EventEnvelope {
  type: 'run_completed';
  /** The run's final artifacts, if any. */
  artifacts: ArtifactIndexEntry[];
}

/** Terminal failure for the whole run. */
export interface RunFailedEvent extends EventEnvelope {
  type: 'run_failed';
  /** Human-readable failure reason. */
  reason: string;
}

/** Discriminated union of every event kind in the gateless subset. */
export type EngineEvent =
  | RunCreatedEvent
  | StepDispatchedEvent
  | StepSucceededEvent
  | StepFailedEvent
  | RunCompletedEvent
  | RunFailedEvent;
