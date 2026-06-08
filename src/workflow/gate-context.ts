import { isGateStep, type WorkflowDefinition } from './schema.js';

/**
 * The work steps a gate guards: its transitive `needs` predecessors, walking
 * back through `script` steps and stopping at any prior `gate` (that earlier
 * work belongs to the earlier review card, ADR-0004).
 *
 * This is the single definition of "the work behind one gate," shared by the two
 * places that must agree on it: the fold resets exactly these steps to `pending`
 * on a `request_changes` loop, and the review-card projection rolls up exactly
 * these steps as the card's context. Returned in workflow declaration order so a
 * rollup reads top-to-bottom.
 *
 * @param workflow the validated workflow definition.
 * @param gateStepId id of the gate step whose guarded work is wanted.
 * @returns the guarded script step ids, in declaration order.
 */
export function guardedWorkSteps(
  workflow: WorkflowDefinition,
  gateStepId: string,
): string[] {
  const stepById = new Map(workflow.steps.map((s) => [s.id, s]));
  const guarded = new Set<string>();
  const queue = [...(stepById.get(gateStepId)?.needs ?? [])];

  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined || guarded.has(id)) continue;
    const step = stepById.get(id);
    // Stop at a prior gate: its guarded work is a separate review card.
    if (step === undefined || isGateStep(step)) continue;
    guarded.add(id);
    queue.push(...step.needs);
  }

  return workflow.steps.filter((s) => guarded.has(s.id)).map((s) => s.id);
}
