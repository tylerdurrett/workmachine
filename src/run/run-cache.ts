import { writeFileSync } from 'node:fs';
import { stringify as stringifyYaml } from 'yaml';
import type { EngineEvent, RunState, StepState } from '../domain/index.js';

/**
 * The derived `run.yaml` cache: a pure projection of the canonical event log.
 *
 * `events.jsonl` is the source of truth (ADR-0003); `run.yaml` mirrors a folded
 * snapshot of it for cheap inspection. The contract this module exists to
 * uphold is that **no canonical state lives only in the cache** — {@link
 * foldRun} reconstructs the entire {@link RunState} from the log alone, so the
 * cache is always rebuildable by replaying events and is safe to delete.
 *
 * This fold is the run-state *projection*, not the orchestrator's `decide`. It
 * answers "what does the log say the run looks like now?" so the cache can be
 * written; choosing the next runnable step is a separate pure function that
 * lands with the orchestrator. Keeping the projection here lets the persistence
 * layer prove the rebuild invariant without waiting on the decision logic.
 */

/**
 * Fold an event log into the current {@link RunState}.
 *
 * Pure and I/O-free: it reads only the facts already in `events` and never
 * touches a clock, the filesystem, or randomness. Replaying the same log always
 * yields the same state, which is what makes `run.yaml` a disposable cache.
 *
 * Events are applied in the order given (the log's append order). Steps appear
 * in the state as soon as they are dispatched; their status advances as
 * terminal events arrive. A run is `running` once any step is dispatched, and
 * reaches `completed`/`failed` only on the terminal run event.
 *
 * @throws if the log does not begin with `run_created`, since every other
 *   event presupposes a minted run.
 */
export function foldRun(events: EngineEvent[]): RunState {
  const first = events[0];
  if (!first || first.type !== 'run_created') {
    throw new Error('event log must begin with a run_created event');
  }

  const state: RunState = {
    runId: first.runId,
    workflowSlug: first.workflowSlug,
    status: 'pending',
    inputs: first.inputs,
    steps: {},
    artifacts: [],
  };

  const stepStatus = (id: string): StepState =>
    (state.steps[id] ??= { stepId: id, status: 'pending' });

  for (const event of events) {
    switch (event.type) {
      case 'run_created':
        // Already seeded from the first event; nothing further to apply.
        break;
      case 'step_dispatched': {
        const step = stepStatus(event.stepId);
        step.status = 'running';
        step.command = event.command;
        if (state.status === 'pending') state.status = 'running';
        break;
      }
      case 'step_succeeded': {
        const step = stepStatus(event.stepId);
        step.status = 'succeeded';
        step.artifacts = event.artifacts;
        break;
      }
      case 'step_failed': {
        const step = stepStatus(event.stepId);
        step.status = 'failed';
        step.reason = event.reason;
        break;
      }
      case 'run_completed':
        state.status = 'completed';
        state.artifacts = event.artifacts;
        break;
      case 'run_failed':
        state.status = 'failed';
        break;
    }
  }

  return state;
}

/**
 * Rebuild the {@link RunState} from `events` and write it to `run.yaml`.
 *
 * The cache is regenerated wholesale from the log on every write, so it can
 * never drift from the canonical record — there is no partial-update path that
 * could leave it stale.
 *
 * @returns the folded state that was written, for callers that want it in hand.
 */
export function writeRunCache(
  runCachePath: string,
  events: EngineEvent[],
): RunState {
  const state = foldRun(events);
  writeFileSync(runCachePath, stringifyYaml(state), 'utf8');
  return state;
}
