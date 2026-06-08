import type { EngineEvent, RunState, StepStatus } from '../domain/index.js';
import type { Executor } from '../executor/index.js';
import { decide, foldRunState } from '../orchestrator/index.js';
import type { EventLog } from '../run/index.js';
import type { TrackerAdapter } from '../tracker/index.js';
import {
  isScriptStep,
  type ScriptStep,
  type WorkflowDefinition,
} from '../workflow/index.js';
import { resolveCommand } from './resolver.js';
import { renderReviewCardBody } from './review-card.js';

/**
 * The tick harness: the impure loop that ties the four pure pieces together
 * (ADR-0003; CONTEXT.md → Resolver / Determinism boundary).
 *
 * Everything `decide` and `foldRunState` do is a pure fold over the event log;
 * everything side-effecting — reading the clock, resolving commands, spawning
 * the executor, appending events — lives here, on the impure side of the
 * boundary. The loop is deliberately thin: it asks `decide` for the single next
 * move and carries it out, never deciding for itself what runs next.
 *
 * The loop, per iteration:
 *   1. read the log, fold it via `decide`;
 *   2. `done` → stop (the run is already terminal);
 *   3. `run_step` → resolve the command, append `step_dispatched` (with the
 *      resolved command), run the executor, append `step_succeeded` /
 *      `step_failed`;
 *   4. `open_gate` → append `gate_opened` and stop: the run is genuinely waiting
 *      for a command, so there is nothing to loop for;
 *   5. `decide_gate` → append the validated `gate_decided` and continue, letting
 *      the next fold advance the gate (approve/request_changes/reject);
 *   6. `wait` → finalize the run: append `run_completed` if every step is
 *      complete (`succeeded`, or `approved` for a review step), `run_failed` if
 *      any step failed or the run was rejected, else genuinely wait (stop).
 *
 * Why finalization lives in the `wait` branch, not inline after a step event:
 * `decide` returns `wait` (not `done`) once the last step settles but no
 * terminal `run_*` event exists yet. Putting `run_completed`/`run_failed` here
 * means a crash *after* `step_failed` but *before* `run_failed` re-finalizes on
 * the next tick — the harness re-reads the log, `decide` returns `wait` again,
 * and this branch appends the missing terminal event. Nothing is lost.
 *
 * Replay-safety, in two parts:
 *  - A crash mid-step leaves a dangling `step_dispatched`; `foldRunState`
 *    unwinds it to `pending`, so `decide` re-dispatches and the step re-runs.
 *  - The resolved command for an *already-completed* step is read back from the
 *    log (via the fold), never re-resolved — so replay reproduces the exact
 *    bytes that ran, even if inputs or the clock would resolve differently now.
 */

/**
 * An event minus the envelope fields the harness stamps at append time
 * (`runId`, `seq`, `ts`). The conditional type distributes `Omit` over each
 * member of the {@link EngineEvent} union, so each variant keeps its own
 * discriminated fields (a plain `Omit<EngineEvent, …>` collapses the union to
 * only its common keys).
 */
type DraftEvent = EngineEvent extends infer E
  ? E extends EngineEvent
    ? Omit<E, 'runId' | 'seq' | 'ts'>
    : never
  : never;

/** The collaborators a single {@link tick} needs; all I/O enters through here. */
export interface TickDeps {
  /** The run's validated workflow definition (its pinned snapshot). */
  workflow: WorkflowDefinition;
  /** The run's append-only event log — read at the loop top, appended to. */
  log: EventLog;
  /** The executor that runs a resolved step's command. */
  executor: Executor;
  /** Absolute path to the run directory; the executor's working directory. */
  runDir: string;
  /**
   * Clock injection point. The harness — never `decide` — stamps event `ts`.
   * Defaults to wall-clock ISO-8601; tests inject a deterministic stamp.
   */
  now?: () => string;
  /**
   * The tracker the run's review card is projected onto. Optional: when absent
   * (or when the run has no card yet), the gate still opens but no card is
   * rendered — so a script-only harness test needs no tracker at all. When
   * present, the harness re-renders the single review card each time it opens a
   * gate (ADR-0004), reusing the run's recorded {@link RunState.card}.
   */
  tracker?: TrackerAdapter;
}

/**
 * Drive a run to a stopping point: dispatch and execute every ready step,
 * finalize the run, and return. Idempotent — ticking a completed run reads the
 * log, sees `done`, and returns without appending anything.
 *
 * @param deps the run's workflow, event log, executor, run dir, and clock.
 * @throws if the log has no `run_created` event (an uncreated run can't tick).
 */
export async function tick(deps: TickDeps): Promise<void> {
  const { workflow, log, executor, runDir, tracker } = deps;
  const now = deps.now ?? (() => new Date().toISOString());

  for (;;) {
    const events = log.read();
    const runId = runIdOf(events);

    // Local seq counter seeded from the log length; each append bumps it, so a
    // multi-append iteration (dispatch + outcome) stays monotonic without a
    // re-read between appends.
    let seq = events.length;
    const append = (event: DraftEvent): void => {
      log.append({ ...event, runId, seq, ts: now() });
      seq += 1;
    };

    const decision = decide(workflow, events);

    if (decision.kind === 'done') {
      // A `reject` gate decision folds the run status to `rejected` immediately,
      // so `decide` reports `done` before any terminal `run_*` event exists
      // (a `run_failed`/`run_completed` would have folded the status to
      // `failed`/`completed`, not `rejected`). Finalize here so reject reaches a
      // terminal `run_failed`, and a crash before that append re-finalizes on the
      // next tick. The `completed`/`failed` states already carry their terminal
      // event, so they fall straight through and the run truly stops.
      const state = foldRunState(workflow, events);
      if (state.status === 'rejected' && finalize(workflow, state, append)) {
        continue;
      }
      return;
    }

    if (decision.kind === 'run_step') {
      const step = stepOf(workflow, decision.stepId);
      const command = resolveCommand(workflow, step, events);
      append({ type: 'step_dispatched', stepId: step.id, command });

      const result = await executor.run(
        { id: step.id, command, produces: step.produces },
        { runDir },
      );

      if (result.ok) {
        append({
          type: 'step_succeeded',
          stepId: step.id,
          artifacts: result.artifacts,
        });
      } else {
        append({ type: 'step_failed', stepId: step.id, reason: result.error });
      }
      continue;
    }

    if (decision.kind === 'open_gate') {
      // The coordinator reached a review step: open its gate, project the review
      // card, and STOP. The run is genuinely waiting for a command — no further
      // move is possible until one arrives, so there is nothing to loop for.
      append({
        type: 'gate_opened',
        gateId: decision.gateId,
        stepId: decision.stepId,
      });
      // Re-fold the log (now including the just-appended `gate_opened`) and
      // render the single review card for the now-open gate (ADR-0004). The
      // render is idempotent: re-ticking the same open gate re-renders into the
      // run's recorded `card` rather than minting a new one. Skipped silently
      // when there is no tracker or the run has no card yet, so a script-only
      // run never needs a tracker.
      await renderGateCard(workflow, log.read(), tracker);
      return;
    }

    if (decision.kind === 'decide_gate') {
      // A valid command closed the open gate: record the validated decision and
      // loop. The fold advances on the next iteration — approve folds the review
      // step to `approved` (finalizes or runs the next step), request_changes
      // loops the guarded work back to `pending` (re-dispatched), reject folds
      // the run to `rejected` (finalized as `run_failed`).
      append({
        type: 'gate_decided',
        gateId: decision.gateId,
        decision: decision.decision,
        actor: decision.actor,
        ...(decision.feedback !== undefined && { feedback: decision.feedback }),
      });
      continue;
    }

    // decision.kind === 'wait': nothing is dispatchable. Either the run has
    // settled (finalize it) or a step is genuinely in flight elsewhere (stop).
    const state = foldRunState(workflow, events);
    if (finalize(workflow, state, append)) {
      continue; // next iteration's decide returns `done` → return.
    }
    return;
  }
}

/**
 * Project the just-opened gate's review card onto the tracker (ADR-0004). Folds
 * the log to read the open gate and the run's recorded {@link RunState.card},
 * renders the card body via the pure projection, and replaces the card body in
 * place — idempotent, so re-ticking the same open gate re-renders the same card
 * (the tracker reuses the {@link CardRef}) rather than minting a new one, and a
 * `request_changes` loop re-renders the same card with the latest feedback.
 *
 * A no-op when there is no tracker or the run has no card yet (a script-only run
 * never opens a card), so this stays invisible to gateless harness paths.
 */
async function renderGateCard(
  workflow: WorkflowDefinition,
  events: readonly EngineEvent[],
  tracker: TrackerAdapter | undefined,
): Promise<void> {
  if (tracker === undefined) return;
  const state = foldRunState(workflow, events);
  if (state.card === undefined) return;

  const body = renderReviewCardBody(workflow, state);
  await tracker.renderReviewCard({
    card: { id: state.card.id, url: state.card.url },
    body,
  });
}

/**
 * Append the terminal run event if the run has settled. Returns whether a
 * terminal event was appended (so the caller loops once more to observe
 * `done`); `false` means the run is genuinely still waiting on in-flight work.
 */
function finalize(
  workflow: WorkflowDefinition,
  state: RunState,
  append: (event: DraftEvent) => void,
): boolean {
  // A reject decision folds the run status to `rejected`; surface it as the
  // terminal `run_failed` so the gate's reject path reaches a terminal outcome.
  if (state.status === 'rejected') {
    append({
      type: 'run_failed',
      reason: 'run rejected at review gate',
    });
    return true;
  }

  // Every step is settled successfully: a `script` step ends `succeeded`, while
  // an approved review (`gate`) step ends `approved` — both count as complete.
  if (workflow.steps.every((s) => isStepComplete(state.steps[s.id]?.status))) {
    append({ type: 'run_completed', artifacts: state.artifacts });
    return true;
  }

  const failed = workflow.steps.find(
    (s) => state.steps[s.id]?.status === 'failed',
  );
  if (failed) {
    append({
      type: 'run_failed',
      reason: `step '${failed.id}' failed: ${state.steps[failed.id]?.reason ?? 'unknown error'}`,
    });
    return true;
  }

  return false;
}

/**
 * Whether a step's status counts as completed for run finalization: a `script`
 * step settles at `succeeded`, an approved `gate` (review) step at `approved`.
 */
function isStepComplete(status: StepStatus | undefined): boolean {
  return status === 'succeeded' || status === 'approved';
}

/** Read the run's id from its `run_created` event, or throw if absent. */
function runIdOf(events: readonly EngineEvent[]): string {
  for (const event of events) {
    if (event.type === 'run_created') return event.runId;
  }
  throw new Error('cannot tick a run with no run_created event in its log');
}

/**
 * Find the script step a `run_step` decision names, or throw. `decide` only ever
 * names a script step for `run_step` (gate steps advance via the gate-decision
 * moves); the type narrowing makes that contract explicit at the dispatch site.
 */
function stepOf(workflow: WorkflowDefinition, stepId: string): ScriptStep {
  const step = workflow.steps.find((s) => s.id === stepId);
  if (step === undefined) {
    throw new Error(`decide named unknown step '${stepId}'`);
  }
  if (!isScriptStep(step)) {
    throw new Error(`decide named non-script step '${stepId}' for run_step`);
  }
  return step;
}
