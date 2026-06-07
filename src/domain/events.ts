import type { ArtifactIndexEntry } from './artifacts.js';

/**
 * Event taxonomy for a run.
 *
 * `events.jsonl` is the append-only canonical record of a run (ADR-0003). Every
 * event carries the {@link EventEnvelope} and a `type` discriminant; the union
 * {@link EngineEvent} is what `decide` folds over to derive current state.
 *
 * Beyond the gateless step lifecycle, the log carries the three gate facts that
 * drive a review step (CONTEXT.md → Gate / Command):
 *
 *   - `gate_opened` — the coordinator has reached a review step and is waiting
 *     on a command (the coordinator-owned wait state itself).
 *   - `command_received` — an external tracker signal (e.g. `/approve`) ingested
 *     into the log. It becomes canonical here but is *not* yet truth: `decide`'s
 *     pure validation decides whether it drives the gate or stays audit-only.
 *   - `gate_decided` — a validated decision closed the gate.
 */

/** The discriminant tags for every event kind in the log. */
export type EngineEventType =
  | 'run_created'
  | 'step_dispatched'
  | 'step_succeeded'
  | 'step_failed'
  | 'run_completed'
  | 'run_failed'
  | 'gate_opened'
  | 'command_received'
  | 'gate_decided';

/**
 * The decision a reviewer can hand a gate. Bound to the workflow's
 * `allowed_decisions` vocabulary: a command's verb is valid only if the open
 * gate lists it.
 *
 *  - `approve` — accept the review step's output; the gate closes and the run
 *    advances past it.
 *  - `request_changes` — send the step back for revision; carries free-text
 *    {@link GateDecidedEvent.feedback} and loops the step to `pending`.
 *  - `reject` — terminally decline; the run fails.
 */
export type GateDecision = 'approve' | 'request_changes' | 'reject';

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

/**
 * The coordinator reached a review step and opened its gate: it is now in a
 * wait state until a valid {@link CommandReceivedEvent} closes the gate. One
 * open gate at a time this slice (ADR-0004).
 */
export interface GateOpenedEvent extends EventEnvelope {
  type: 'gate_opened';
  /** Stable id of the gate that was opened (the target a command must match). */
  gateId: string;
  /** Id of the review step this gate guards. */
  stepId: string;
}

/**
 * An external tracker command (e.g. `/approve`) was ingested into the log. It
 * is canonical-but-not-yet-truth: `decide` runs the pure validation
 * (open gate + matching `gateId` + verb in the gate's `allowed_decisions`) and
 * only the first valid command per gate drives a {@link GateDecidedEvent}; any
 * other (wrong gate, disallowed verb, closed gate, or a later valid duplicate)
 * stays in the log as an audit-only fact that advances no state.
 */
export interface CommandReceivedEvent extends EventEnvelope {
  type: 'command_received';
  /** Gate this command targets; must match the currently-open gate to be valid. */
  gateId: string;
  /**
   * Tracker's stable comment id — the canonical idempotency key. A comment id
   * already present in the log is ignored on re-ingestion, so a crash mid-poll
   * is a no-op (CONTEXT.md → Command).
   */
  commentId: string;
  /** Who issued the command. Recorded now; identity is NOT enforced yet. */
  actor: string;
  /** The decision verb the command carries. */
  decision: GateDecision;
  /**
   * Free-text revision feedback the reviewer attached, meaningful only when
   * `decision` is `request_changes`. `decide` threads it onto the resulting
   * `decide_gate` so the harness records it on `gate_decided`.
   */
  feedback?: string;
}

/**
 * A validated command closed a gate. The harness appends this after `decide`
 * names `decide_gate`; `decide` never appends it itself.
 */
export interface GateDecidedEvent extends EventEnvelope {
  type: 'gate_decided';
  /** Gate that was decided. */
  gateId: string;
  /** The decision verb that closed the gate. */
  decision: GateDecision;
  /** Who issued the decision (recorded, not enforced). */
  actor: string;
  /**
   * Free-text revision feedback, present only when `decision` is
   * `request_changes`. Threaded into the re-dispatched step's resolution context
   * in a later task; recorded here as a fact now.
   */
  feedback?: string;
}

/** Discriminated union of every event kind in the log. */
export type EngineEvent =
  | RunCreatedEvent
  | StepDispatchedEvent
  | StepSucceededEvent
  | StepFailedEvent
  | RunCompletedEvent
  | RunFailedEvent
  | GateOpenedEvent
  | CommandReceivedEvent
  | GateDecidedEvent;
