import type { EngineEvent, RunState } from '../domain/index.js';
import type { Executor } from '../executor/index.js';
import { decide, foldRunState } from '../orchestrator/index.js';
import type { EventLog } from '../run/index.js';
import type { WorkflowDefinition, WorkflowStep } from '../workflow/index.js';
import { resolveCommand } from './resolver.js';

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
 *   4. `wait` → finalize the run: append `run_completed` if every step
 *      succeeded, `run_failed` if any step failed, else genuinely wait (stop).
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
  const { workflow, log, executor, runDir } = deps;
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
 * Append the terminal run event if the run has settled. Returns whether a
 * terminal event was appended (so the caller loops once more to observe
 * `done`); `false` means the run is genuinely still waiting on in-flight work.
 */
function finalize(
  workflow: WorkflowDefinition,
  state: RunState,
  append: (event: DraftEvent) => void,
): boolean {
  if (workflow.steps.every((s) => state.steps[s.id]?.status === 'succeeded')) {
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

/** Read the run's id from its `run_created` event, or throw if absent. */
function runIdOf(events: readonly EngineEvent[]): string {
  for (const event of events) {
    if (event.type === 'run_created') return event.runId;
  }
  throw new Error('cannot tick a run with no run_created event in its log');
}

/** Find a workflow step by id, or throw if the decision names an unknown step. */
function stepOf(workflow: WorkflowDefinition, stepId: string): WorkflowStep {
  const step = workflow.steps.find((s) => s.id === stepId);
  if (step === undefined) {
    throw new Error(`decide named unknown step '${stepId}'`);
  }
  return step;
}
