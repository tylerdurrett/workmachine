import type { Decision, EngineEvent, RunState } from '../domain/index.js';
import type { WorkflowDefinition } from '../workflow/index.js';
import { foldRunState } from './fold.js';

/**
 * The gateless orchestrator: a pure `decide(events) -> Decision` fold that names
 * the single next move the coordinator allows (ADR-0003; CONTEXT.md →
 * Coordinator / Determinism boundary).
 *
 * This is the determinism boundary in code. `decide` performs **zero I/O** — no
 * filesystem, network, clock, randomness, or shell — and reasons only from facts
 * already in the event log, folded into a {@link RunState}. It only *names* the
 * step to dispatch (`run_step <id>`); it never builds shell strings, knows path
 * layout, or resolves `{{...}}` templates. Resolution is the harness resolver's
 * job at dispatch time; `decide` stays a pure fold so the same logic lifts into a
 * durable runtime later unchanged.
 *
 * The workflow definition is data (the run's validated snapshot, from #6/#7), not
 * I/O: `decide` needs it to know which steps exist and how `needs` orders them.
 * Reading that in-memory definition keeps the fold pure while letting it reason
 * about steps no event has touched yet.
 *
 * Gateless scope: there are no gate or command branches here. `open gate` and
 * command validation arrive in slice 2 and drop in as additional `Decision`
 * branches without restructuring this fold.
 */

/** A step is dispatchable once every step it `needs` has succeeded. */
function needsSatisfied(needs: readonly string[], state: RunState): boolean {
  return needs.every((dep) => state.steps[dep]?.status === 'succeeded');
}

/**
 * Fold the event log into a decision: the next move the coordinator allows.
 *
 *  - `done` — the run has reached a terminal state (`completed` or `failed`),
 *    so there is nothing left to dispatch.
 *  - `run_step <id>` — the first declared step (in workflow order) that is
 *    `pending` and whose `needs` are all satisfied. A step left `pending` by a
 *    crash mid-step (dangling dispatch, unwound by the fold) is re-dispatched
 *    here.
 *  - `wait` — nothing is currently runnable but the run is not terminal: a step
 *    is in flight (`running`), or every remaining step is blocked on a
 *    dependency that has not succeeded.
 *
 * @param workflow the run's validated workflow definition (its snapshot).
 * @param events the run's append-only event log, in `seq` order.
 * @returns the single next move; pure, derived only from the log.
 */
export function decide(
  workflow: WorkflowDefinition,
  events: readonly EngineEvent[],
): Decision {
  const state = foldRunState(workflow, events);

  if (state.status === 'completed' || state.status === 'failed') {
    return { kind: 'done' };
  }

  for (const step of workflow.steps) {
    if (
      state.steps[step.id]?.status === 'pending' &&
      needsSatisfied(step.needs, state)
    ) {
      return { kind: 'run_step', stepId: step.id };
    }
  }

  return { kind: 'wait' };
}
