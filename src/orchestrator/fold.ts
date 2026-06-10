import type {
  ArtifactIndexEntry,
  EngineEvent,
  RunState,
  StepState,
} from '../domain/index.js';
import {
  guardedWorkSteps,
  type WorkflowDefinition,
} from '../workflow/index.js';

/**
 * Pure event-sourced fold: replay an `events.jsonl` log into a {@link RunState}
 * snapshot (ADR-0003; CONTEXT.md → Coordinator / Determinism boundary).
 *
 * This is the determinism boundary in code. The fold performs **zero I/O** — no
 * filesystem, network, clock, randomness, or shell — and derives every fact from
 * the events already in the log. It is the rebuildable cache behind `run.yaml`:
 * given the same workflow + log it always produces the same state.
 *
 * A `script` step's lifecycle is derived purely from events:
 *
 *   step_dispatched → running → step_succeeded (succeeded) | step_failed (failed)
 *
 * A **dangling** `step_dispatched` with no terminal `step_succeeded`/`step_failed`
 * folds back to `pending`, not `running`: a crash mid-step leaves a dispatch with
 * no outcome in the log, and on replay that step must be re-runnable. The fold
 * therefore treats "dispatched, no terminal event" as "not yet attempted" so a
 * later `tick` re-dispatches it (AC: crash-mid-step replay).
 *
 * A `gate` (review) step runs no command; its lifecycle is driven by gate facts:
 *
 *   gate_opened → awaiting_review → gate_decided →
 *     approve          → approved
 *     request_changes  → changes_requested, and the steps it guards (its
 *                        transitive `needs` back to the previous gate) plus the
 *                        gate itself reset to `pending`, so the work re-runs and
 *                        the *same* gate re-opens (ADR-0004 — one card per gate).
 *     reject           → rejected, and the run folds to `rejected`.
 *
 * A `command_received` is recorded as a canonical fact but advances no state on
 * its own: only a `gate_decided` (named by `decide`'s pure validation) moves a
 * gate. An invalid command therefore stays audit-only here.
 *
 * The fold never builds shell strings or knows path layout — it only records the
 * resolved `command` already present on `step_dispatched` and the artifacts
 * already recorded on `step_succeeded`.
 */

/** Seed a {@link StepState} in its pre-dispatch resting state. */
function pendingStep(stepId: string): StepState {
  return { stepId, status: 'pending' };
}

/**
 * Attach the resolved `command` to a step only when one exists, so the optional
 * `command` key is omitted (not set to `undefined`) under
 * `exactOptionalPropertyTypes`. A terminal event carries the command forward
 * from the preceding `step_dispatched`.
 */
function withCommand(step: StepState, command: string | undefined): StepState {
  return command === undefined ? step : { ...step, command };
}

/**
 * Fold a workflow definition plus its event log into the derived run state.
 *
 * Every step declared by the workflow appears in `steps`, seeded `pending`, so
 * callers (notably `decide`) can reason about steps that have not been touched
 * yet without consulting the workflow separately.
 *
 * @param workflow the validated workflow definition (the run's snapshot).
 * @param events the run's append-only event log, in `seq` order.
 * @returns the derived run-state snapshot; pure, always rebuildable from the log.
 */
export function foldRunState(
  workflow: WorkflowDefinition,
  events: readonly EngineEvent[],
): RunState {
  const steps: Record<string, StepState> = {};
  for (const step of workflow.steps) {
    steps[step.id] = pendingStep(step.id);
  }

  const state: RunState = {
    runId: '',
    workflowSlug: workflow.slug,
    status: 'pending',
    inputs: {},
    steps,
    artifacts: [],
  };

  // Track step ids dispatched but not yet terminated, so a dangling dispatch
  // (no terminal event) can be unwound to `pending` at the end.
  const danglingDispatch = new Set<string>();

  for (const event of events) {
    switch (event.type) {
      case 'run_created': {
        state.runId = event.runId;
        state.workflowSlug = event.workflowSlug;
        state.inputs = event.inputs;
        state.status = 'running';
        break;
      }
      case 'card_created': {
        // Record-only: the card ref is a canonical fact projected into derived
        // state so the snapshot is self-describing. It advances no step lifecycle.
        state.card = {
          id: event.cardId,
          url: event.cardUrl,
          repo: event.repo,
        };
        break;
      }
      case 'step_dispatched': {
        danglingDispatch.add(event.stepId);
        // Only a script dispatch carries a `command`; an agent dispatch records
        // its resolved `prompt` on the event itself, not in StepState.
        steps[event.stepId] = withCommand(
          { stepId: event.stepId, status: 'running' },
          event.stepType === 'script' ? event.command : undefined,
        );
        break;
      }
      case 'step_succeeded': {
        danglingDispatch.delete(event.stepId);
        steps[event.stepId] = withCommand(
          {
            stepId: event.stepId,
            status: 'succeeded',
            artifacts: event.artifacts,
          },
          steps[event.stepId]?.command,
        );
        appendArtifacts(state, event.artifacts);
        break;
      }
      case 'step_failed': {
        danglingDispatch.delete(event.stepId);
        steps[event.stepId] = withCommand(
          {
            stepId: event.stepId,
            status: 'failed',
            reason: event.reason,
          },
          steps[event.stepId]?.command,
        );
        break;
      }
      case 'run_completed': {
        state.status = 'completed';
        appendArtifacts(state, event.artifacts);
        break;
      }
      case 'run_failed': {
        state.status = 'failed';
        break;
      }
      case 'gate_opened': {
        state.openGate = { gateId: event.gateId, stepId: event.stepId };
        steps[event.stepId] = {
          ...(steps[event.stepId] ?? pendingStep(event.stepId)),
          status: 'awaiting_review',
        };
        break;
      }
      case 'command_received': {
        // Audit-only: a command is a canonical fact but never advances state on
        // its own. Only the `gate_decided` that `decide`'s pure validation names
        // (first-valid-wins) moves the gate; an invalid command leaves no trace
        // in the derived state.
        break;
      }
      case 'gate_decided': {
        const stepId = state.openGate?.stepId;
        delete state.openGate;
        if (stepId === undefined) break;

        if (event.decision === 'request_changes') {
          // Loop the gate: reset the work it guards (its transitive `needs` back
          // to the previous gate) so it re-runs consuming the recorded feedback,
          // and reset the gate step itself so the *same* gate re-opens once the
          // work re-succeeds (ADR-0004 — one card per gate). The decision and
          // feedback are recorded on the gate step's resting (`pending`) state
          // for projection.
          for (const guarded of guardedWorkSteps(workflow, stepId)) {
            steps[guarded] = pendingStep(guarded);
          }
          steps[stepId] = {
            ...pendingStep(stepId),
            decision: event.decision,
            ...(event.feedback !== undefined && { feedback: event.feedback }),
          };
          break;
        }

        // approve | reject: a terminal verdict on the gate step.
        steps[stepId] = {
          ...(steps[stepId] ?? pendingStep(stepId)),
          status: event.decision === 'approve' ? 'approved' : 'rejected',
          decision: event.decision,
        };
        if (event.decision === 'reject') {
          state.status = 'rejected';
        }
        break;
      }
    }
  }

  // Unwind dangling dispatches: a `step_dispatched` with no terminal event is a
  // crash mid-step. Reset it to `pending` so replay re-dispatches it.
  for (const stepId of danglingDispatch) {
    if (steps[stepId]?.status === 'running') {
      steps[stepId] = pendingStep(stepId);
    }
  }

  return state;
}

/** Append produced artifacts to the run-level index (later wins on id clash). */
function appendArtifacts(
  state: RunState,
  artifacts: readonly ArtifactIndexEntry[],
): void {
  for (const artifact of artifacts) {
    const existing = state.artifacts.findIndex((a) => a.id === artifact.id);
    if (existing >= 0) {
      state.artifacts[existing] = artifact;
    } else {
      state.artifacts.push(artifact);
    }
  }
}
