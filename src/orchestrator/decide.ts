import type {
  CommandReceivedEvent,
  Decision,
  EngineEvent,
  OpenGate,
  RunState,
} from '../domain/index.js';
import { isGateStep, type WorkflowDefinition } from '../workflow/index.js';
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
 * Gates extend this same fold without restructuring it: a review step whose
 * `needs` are satisfied is named `open_gate`, and a gate that is already open is
 * advanced by `decide_gate` from the first *valid* command. Command validation
 * lives here, inside `decide` — that is the concrete teeth behind "an unvalidated
 * tracker comment is not truth" (CONTEXT.md → Command). `decide` only *names* the
 * move; the harness appends the resulting `gate_opened`/`gate_decided`.
 */

/** A step is dispatchable once every step it `needs` has succeeded. */
function needsSatisfied(needs: readonly string[], state: RunState): boolean {
  return needs.every((dep) => state.steps[dep]?.status === 'succeeded');
}

/**
 * Pure command validation (CONTEXT.md → Command; ADR-0004). A command is valid
 * iff it targets the currently-open gate (matching `gateId`) and its verb is in
 * that gate's `allowed_decisions`. A wrong/non-current gate id, a disallowed
 * verb, or a closed gate all fail — the command stays an audit-only fact and the
 * run does not advance.
 *
 * Identity is recorded (`actor`) but deliberately NOT enforced: identity
 * authorization drops into this same predicate later (CONTEXT.md → Command
 * validation now; identity authorization deferred).
 */
function commandValidatesGate(
  command: CommandReceivedEvent,
  openGate: OpenGate,
  allowedDecisions: readonly string[],
): boolean {
  return (
    command.gateId === openGate.gateId &&
    allowedDecisions.includes(command.decision)
  );
}

/**
 * Fold the event log into a decision: the next move the coordinator allows.
 *
 *  - `done` — the run has reached a terminal state (`completed`, `failed`, or
 *    `rejected`), so there is nothing left to dispatch.
 *  - `decide_gate <…>` — a gate is open and the *first valid* `command_received`
 *    (in `seq` order) passes pure validation. First-valid-wins per gate: later
 *    commands at the same gate are audit-only. `decide` names the verb/actor; it
 *    never appends `gate_decided`.
 *  - `open_gate <id>` — the first review step (in workflow order) that is
 *    `pending` with its `needs` satisfied, when no gate is currently open.
 *  - `run_step <id>` — the first `script` step (in workflow order) that is
 *    `pending` and whose `needs` are all satisfied. A step left `pending` by a
 *    crash mid-step (dangling dispatch) or a `request_changes` loop is
 *    re-dispatched here.
 *  - `wait` — nothing is currently runnable but the run is not terminal: a gate
 *    is open with no valid command yet, a step is in flight (`running`), or every
 *    remaining step is blocked on a dependency that has not succeeded.
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

  if (
    state.status === 'completed' ||
    state.status === 'failed' ||
    state.status === 'rejected'
  ) {
    return { kind: 'done' };
  }

  // A gate is open: advance it from the first valid command, or wait. No other
  // move is allowed while the coordinator is in a gate's wait state.
  if (state.openGate) {
    return decideOpenGate(workflow, events, state.openGate);
  }

  for (const step of workflow.steps) {
    if (
      state.steps[step.id]?.status !== 'pending' ||
      !needsSatisfied(step.needs, state)
    ) {
      continue;
    }
    return isGateStep(step)
      ? { kind: 'open_gate', gateId: step.id, stepId: step.id }
      : { kind: 'run_step', stepId: step.id };
  }

  return { kind: 'wait' };
}

/**
 * Resolve an open gate: scan `command_received` events in `seq` order and return
 * `decide_gate` for the first one that passes pure validation against the gate's
 * `allowed_decisions` (first-valid-wins). If none is valid yet, `wait`.
 */
function decideOpenGate(
  workflow: WorkflowDefinition,
  events: readonly EngineEvent[],
  openGate: OpenGate,
): Decision {
  const gateStep = workflow.steps.find((s) => s.id === openGate.stepId);
  const allowed =
    gateStep && isGateStep(gateStep) ? gateStep.allowed_decisions : [];

  for (const event of events) {
    if (
      event.type === 'command_received' &&
      commandValidatesGate(event, openGate, allowed)
    ) {
      return {
        kind: 'decide_gate',
        gateId: openGate.gateId,
        decision: event.decision,
        actor: event.actor,
        ...(event.decision === 'request_changes' &&
          event.feedback !== undefined && { feedback: event.feedback }),
      };
    }
  }

  return { kind: 'wait' };
}
