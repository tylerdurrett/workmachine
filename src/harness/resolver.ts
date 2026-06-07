import type { EngineEvent } from '../domain/index.js';
import type { WorkflowDefinition, WorkflowStep } from '../workflow/index.js';
import { ARTIFACT_REF_RE, INPUT_REF_RE, TOKEN_RE } from '../workflow/index.js';

/**
 * The resolver: turn a step's templated `run` command into the concrete shell
 * string the executor runs, by substituting `{{...}}` tokens at dispatch time
 * (ADR-0003; CONTEXT.md → Resolver / Determinism boundary).
 *
 * Resolution is the harness's job, never `decide`'s. `decide` is a pure fold
 * that only *names* the next step; it builds no shell strings and knows no path
 * layout. The resolver lives on the impure side of the boundary only because it
 * reads the run's inputs from the log — but it is itself a pure function of
 * `(workflow, step, events)`, with no I/O, so the resolved command it produces
 * is deterministic and gets recorded verbatim on `step_dispatched`. That
 * recording is what makes replay safe: a re-tick after a crash reads the
 * resolved command back from the log rather than re-resolving it.
 *
 * The substitution grammar mirrors the loader's static validation exactly
 * (`interpolation.ts`) by importing its regexes, so the check and the
 * substitution share one source of truth and cannot drift. Two namespaces are
 * supported in this gateless slice:
 *  - `{{inputs.<name>}}` → the run's input value, stringified.
 *  - `{{artifacts.<id>.path}}` → the declared path of that produced artifact.
 *
 * `{{feedback.*}}` (gate feedback) is out of scope for slice 1. The dispatch
 * table below is structured so a new namespace drops in as one more entry
 * without touching the substitution loop.
 */

/** Resolve a single token's inner text to its value, or `undefined` if unhandled. */
type TokenResolver = (inner: string) => string | undefined;

/**
 * Read the run's inputs from the `run_created` event. Inputs are a fact of the
 * log (recorded at run-create), so resolution reasons from the same canonical
 * source `decide` folds over — not from ambient state.
 */
function readInputs(events: readonly EngineEvent[]): Record<string, unknown> {
  for (const event of events) {
    if (event.type === 'run_created') {
      return event.inputs;
    }
  }
  return {};
}

/**
 * Build the `id → declared path` map from every artifact any step produces.
 * Declared paths are static workflow data, so the map is the same on every tick.
 */
function artifactPaths(workflow: WorkflowDefinition): Map<string, string> {
  return new Map(
    workflow.steps.flatMap((step) => step.produces.map((a) => [a.id, a.path])),
  );
}

/**
 * Resolve `step.run` into a concrete command by substituting every `{{...}}`
 * token. Pure: no filesystem, clock, or shell — just `(workflow, step, events)`.
 *
 * The loader has already validated that every token names a declared input or a
 * produced artifact, so in practice no binding is missing; the defensive throw
 * exists so a malformed log (or a future caller that skips the loader) fails
 * loudly at dispatch rather than dispatching a half-substituted command.
 *
 * @param workflow the run's validated workflow definition (its snapshot).
 * @param step the step whose templated command is being resolved.
 * @param events the run's event log, read for the run's inputs.
 * @returns the fully-resolved command, with no `{{...}}` tokens remaining.
 * @throws if a token references a binding absent from inputs/artifacts.
 */
export function resolveCommand(
  workflow: WorkflowDefinition,
  step: WorkflowStep,
  events: readonly EngineEvent[],
): string {
  const inputs = readInputs(events);
  const paths = artifactPaths(workflow);

  // Each resolver handles one namespace; a new namespace (e.g. `feedback`)
  // drops in as one more entry without touching the substitution loop below.
  const resolvers: TokenResolver[] = [
    (inner) => {
      const match = INPUT_REF_RE.exec(inner);
      if (!match) return undefined;
      const name = match[1] ?? '';
      if (!(name in inputs)) {
        throw new Error(
          `cannot resolve {{inputs.${name}}} in step '${step.id}': no such input on the run`,
        );
      }
      return String(inputs[name]);
    },
    (inner) => {
      const match = ARTIFACT_REF_RE.exec(inner);
      if (!match) return undefined;
      const id = match[1] ?? '';
      const path = paths.get(id);
      if (path === undefined) {
        throw new Error(
          `cannot resolve {{artifacts.${id}.path}} in step '${step.id}': no step produces artifact '${id}'`,
        );
      }
      return path;
    },
  ];

  return step.run.replace(TOKEN_RE, (_token, inner: string) => {
    for (const resolve of resolvers) {
      const value = resolve(inner);
      if (value !== undefined) return value;
    }
    throw new Error(
      `unsupported interpolation '{{${inner}}}' in step '${step.id}'`,
    );
  });
}
