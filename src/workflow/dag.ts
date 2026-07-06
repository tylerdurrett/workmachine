import { z } from 'zod';
import {
  isScriptStep,
  isTemplatedStep,
  type WorkflowDefinition,
} from './schema.js';

/**
 * Static validation of the step dependency graph (AC#3).
 *
 * The execution order of a workflow is a DAG. This pass checks the graph's
 * structural integrity without running anything:
 *  - step ids are unique;
 *  - produced artifact ids are unique across the whole workflow;
 *  - every explicit `needs` entry names an existing step;
 *  - the dependency graph is acyclic.
 *
 * Edges come from two sources: explicit `needs` (step → its dependency) and
 * implicit artifact wiring — if a step references `{{artifacts.X.path}}` and
 * another step produces `X`, the consumer depends on the producer. Only
 * resolved artifact refs become edges; dangling refs are interpolation.ts's
 * concern and are not re-reported here.
 *
 * Failures are returned as `z.ZodIssue[]` (not thrown) so the loader can merge
 * them with the interpolation pass into a single `z.ZodError`.
 */

/** Matches a resolved `{{artifacts.<id>.path}}` token, capturing the id. */
const ARTIFACT_PATH_REF_RE = /\{\{\s*artifacts\.([A-Za-z0-9_-]+)\.path\s*\}\}/g;

/** Collect the artifact ids referenced by a step's templated text and produced paths. */
function referencedArtifactIds(text: string): string[] {
  return [...text.matchAll(ARTIFACT_PATH_REF_RE)].map(([, id]) => id ?? '');
}

/**
 * Validate uniqueness, `needs` existence, and acyclicity of the step graph.
 *
 * @returns one issue per problem found; empty when the graph is sound.
 */
export function validateDag(def: WorkflowDefinition): z.ZodIssue[] {
  const issues: z.ZodIssue[] = [];

  // Unique step ids; also map id -> index for later edge building.
  const stepIndexById = new Map<string, number>();
  const seenStepIds = new Set<string>();
  def.steps.forEach((step, i) => {
    if (seenStepIds.has(step.id)) {
      issues.push({
        code: z.ZodIssueCode.custom,
        path: ['steps', i, 'id'],
        message: `duplicate step id '${step.id}'`,
      });
    }
    seenStepIds.add(step.id);
    if (!stepIndexById.has(step.id)) {
      stepIndexById.set(step.id, i);
    }
  });

  // Unique artifact ids across all steps; map id -> producing step id.
  const producerStepIdByArtifact = new Map<string, string>();
  const seenArtifactIds = new Set<string>();
  def.steps.forEach((step, i) => {
    if (!isTemplatedStep(step)) return;
    step.produces.forEach((artifact, j) => {
      if (seenArtifactIds.has(artifact.id)) {
        issues.push({
          code: z.ZodIssueCode.custom,
          path: ['steps', i, 'produces', j, 'id'],
          message: `duplicate artifact id '${artifact.id}'`,
        });
      }
      seenArtifactIds.add(artifact.id);
      if (!producerStepIdByArtifact.has(artifact.id)) {
        producerStepIdByArtifact.set(artifact.id, step.id);
      }
    });
  });

  // Build the dependency edge set: step id -> set of step ids it depends on.
  const deps = new Map<string, Set<string>>();
  for (const step of def.steps) {
    deps.set(step.id, deps.get(step.id) ?? new Set());
  }
  const addEdge = (from: string, to: string): void => {
    deps.get(from)?.add(to);
  };

  def.steps.forEach((step, i) => {
    // Explicit needs.
    step.needs.forEach((dep, j) => {
      if (!stepIndexById.has(dep)) {
        issues.push({
          code: z.ZodIssueCode.custom,
          path: ['steps', i, 'needs', j],
          message: `step '${step.id}' needs unknown step '${dep}'`,
        });
        return;
      }
      addEdge(step.id, dep);
    });

    // Implicit edges from resolved artifact references (script and agent
    // steps only; gate steps carry no templated text or produced paths).
    if (!isTemplatedStep(step)) return;
    const templatedText = isScriptStep(step) ? step.run : step.prompt;
    const refTexts = [templatedText, ...step.produces.map((a) => a.path)];
    for (const text of refTexts) {
      for (const artifactId of referencedArtifactIds(text)) {
        const producer = producerStepIdByArtifact.get(artifactId);
        if (producer !== undefined && producer !== step.id) {
          addEdge(step.id, producer);
        }
      }
    }
  });

  const cycle = findCycle(deps);
  if (cycle) {
    issues.push({
      code: z.ZodIssueCode.custom,
      path: ['steps'],
      message: `cycle detected in step dependencies: ${cycle.join(' -> ')}`,
    });
  }

  return issues;
}

/**
 * DFS for a single cycle in the dependency graph. Returns the cycle as a path
 * `a -> b -> ... -> a`, or `undefined` if the graph is acyclic.
 */
function findCycle(deps: Map<string, Set<string>>): string[] | undefined {
  const VISITING = 1;
  const DONE = 2;
  const state = new Map<string, number>();
  const stack: string[] = [];

  const visit = (node: string): string[] | undefined => {
    state.set(node, VISITING);
    stack.push(node);
    for (const next of deps.get(node) ?? []) {
      const s = state.get(next);
      if (s === VISITING) {
        const start = stack.indexOf(next);
        return [...stack.slice(start), next];
      }
      if (s !== DONE) {
        const found = visit(next);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(node, DONE);
    return undefined;
  };

  for (const node of deps.keys()) {
    if (state.get(node) === undefined) {
      const found = visit(node);
      if (found) return found;
    }
  }
  return undefined;
}
