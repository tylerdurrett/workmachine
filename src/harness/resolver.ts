import type { EngineEvent } from '../domain/index.js';
import type {
  ResolvedAgentStep,
  ResolvedScriptStep,
  ResolvedStep,
} from '../executor/index.js';
import type {
  AgentStep,
  ScriptStep,
  WorkflowDefinition,
} from '../workflow/index.js';
import {
  ARTIFACT_REF_RE,
  FEEDBACK_REF_RE,
  INPUT_REF_RE,
  isTemplatedStep,
  TOKEN_RE,
} from '../workflow/index.js';

/**
 * The resolver: turn a step's templated text into the concrete string the
 * executor consumes, by substituting `{{...}}` tokens at dispatch time
 * (ADR-0003; CONTEXT.md → Resolver / Determinism boundary). One generic
 * substitution path serves every step kind — a `script` step's `run` becomes
 * the shell command, an `agent` step's `prompt` becomes the literal prompt —
 * so the grammar cannot fork between kinds.
 *
 * Resolution is the harness's job, never `decide`'s. `decide` is a pure fold
 * that only *names* the next step; it builds no shell strings and knows no path
 * layout. The resolver lives on the impure side of the boundary only because it
 * reads the run's inputs from the log — but it is itself a pure function of
 * `(workflow, step, events)`, with no I/O, so the resolved text it produces
 * is deterministic and gets recorded verbatim on `step_dispatched`. That
 * recording is what makes replay safe: a re-tick after a crash reads the
 * resolved command back from the log rather than re-resolving it.
 *
 * The substitution grammar mirrors the loader's static validation exactly
 * (`interpolation.ts`) by importing its regexes, so the check and the
 * substitution share one source of truth and cannot drift. Three namespaces are
 * supported:
 *  - `{{inputs.<name>}}` → the run's input value, stringified.
 *  - `{{artifacts.<id>.path}}` → the declared path of that produced artifact.
 *  - `{{feedback.<field>}}` → the revision feedback from the latest
 *    `gate_decided(request_changes)`, so a step re-dispatched by the
 *    request-changes loop runs with the reviewer's note threaded in. On the
 *    first dispatch (no prior decision) it resolves to an empty default rather
 *    than throwing, so the same templated command is dispatchable both before
 *    and after a revision round.
 *
 * The dispatch table below is structured so a new namespace drops in as one more
 * entry without touching the substitution loop.
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
 * Read the revision feedback the request-changes loop threads into a re-run.
 *
 * Scans the log back-to-front for the latest `gate_decided` whose decision is
 * `request_changes` and returns its `feedback` text. Latest-wins so that across
 * several revision rounds the step re-runs with the most recent reviewer note.
 * Returns `''` when no such decision exists yet — the first dispatch precedes
 * any gate, so `{{feedback.*}}` resolves to an empty default rather than
 * throwing, keeping the same templated command dispatchable on every round.
 */
function readFeedback(events: readonly EngineEvent[]): string {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (
      event?.type === 'gate_decided' &&
      event.decision === 'request_changes'
    ) {
      return event.feedback ?? '';
    }
  }
  return '';
}

/**
 * Build the `id → declared path` map from every artifact any step produces
 * (script and agent steps alike — the loader admits artifact refs against
 * both, so the resolver must see the same declared set or the two drift).
 * Declared paths are static workflow data, so the map is the same on every tick.
 */
function artifactPaths(workflow: WorkflowDefinition): Map<string, string> {
  return new Map(
    workflow.steps.flatMap((step) =>
      isTemplatedStep(step)
        ? step.produces.map((a): [string, string] => [a.id, a.path])
        : [],
    ),
  );
}

/**
 * Substitute every `{{...}}` token in one piece of templated text against the
 * run's bindings. This is the single substitution path every step kind goes
 * through — a script step's `run` and an agent step's `prompt` resolve through
 * exactly the same grammar, so the namespaces cannot drift between kinds.
 *
 * The loader has already validated that every token names a declared input or a
 * produced artifact, so in practice no binding is missing; the defensive throw
 * exists so a malformed log (or a future caller that skips the loader) fails
 * loudly at dispatch rather than dispatching half-substituted text.
 *
 * @param workflow the run's validated workflow definition (its snapshot).
 * @param events the run's event log, read for the run's inputs and the latest
 *   request-changes feedback.
 * @param stepId id of the step being resolved, for error messages.
 * @param text the templated text to substitute (`run` or `prompt`).
 * @returns the fully-resolved text, with no `{{...}}` tokens remaining.
 * @throws if a token references a binding absent from inputs/artifacts.
 */
function substitute(
  workflow: WorkflowDefinition,
  events: readonly EngineEvent[],
  stepId: string,
  text: string,
): string {
  const inputs = readInputs(events);
  const paths = artifactPaths(workflow);
  const feedback = readFeedback(events);

  // Each resolver handles one namespace; a new namespace drops in as one more
  // entry without touching the substitution loop below.
  const resolvers: TokenResolver[] = [
    (inner) => {
      const match = INPUT_REF_RE.exec(inner);
      if (!match) return undefined;
      const name = match[1] ?? '';
      if (!(name in inputs)) {
        throw new Error(
          `cannot resolve {{inputs.${name}}} in step '${stepId}': no such input on the run`,
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
          `cannot resolve {{artifacts.${id}.path}} in step '${stepId}': no step produces artifact '${id}'`,
        );
      }
      return path;
    },
    (inner) => {
      // `{{feedback.<field>}}` is the latest request-changes note; the field is
      // the template author's label for that one free-text string. Empty default
      // on the first dispatch — never throws — so the loop can re-run the step.
      if (!FEEDBACK_REF_RE.test(inner)) return undefined;
      return feedback;
    },
  ];

  return text.replace(TOKEN_RE, (_token, inner: string) => {
    for (const resolve of resolvers) {
      const value = resolve(inner);
      if (value !== undefined) return value;
    }
    throw new Error(
      `unsupported interpolation '{{${inner}}}' in step '${stepId}'`,
    );
  });
}

/**
 * Resolve an executable step into its {@link ResolvedStep} variant: a `script`
 * step's `run` becomes the resolved `command`, an `agent` step's `prompt`
 * becomes the resolved prompt (with the optional `model` passed through
 * verbatim). Both go through the one shared {@link substitute} path, so every
 * namespace works identically in a command and a prompt. Pure: no filesystem,
 * clock, or shell — just `(workflow, step, events)`.
 *
 * The agent variant carries the AUTHOR prompt only — the executor-facing
 * contract block (artifact instructions etc.) is composed at dispatch by the
 * agent executor, never here.
 *
 * The overloads narrow the return variant when the step kind is statically
 * known, so a caller holding a {@link ScriptStep} gets a
 * {@link ResolvedScriptStep} without a runtime check.
 *
 * @param workflow the run's validated workflow definition (its snapshot).
 * @param step the script or agent step whose templated text is being resolved.
 * @param events the run's event log, read for the run's inputs and the latest
 *   request-changes feedback.
 * @returns the resolved variant matching the step's kind.
 * @throws if a token references a binding absent from inputs/artifacts.
 */
export function resolveStep(
  workflow: WorkflowDefinition,
  step: ScriptStep,
  events: readonly EngineEvent[],
): ResolvedScriptStep;
export function resolveStep(
  workflow: WorkflowDefinition,
  step: AgentStep,
  events: readonly EngineEvent[],
): ResolvedAgentStep;
export function resolveStep(
  workflow: WorkflowDefinition,
  step: ScriptStep | AgentStep,
  events: readonly EngineEvent[],
): ResolvedStep;
export function resolveStep(
  workflow: WorkflowDefinition,
  step: ScriptStep | AgentStep,
  events: readonly EngineEvent[],
): ResolvedStep {
  if (step.type === 'script') {
    return {
      type: 'script',
      id: step.id,
      command: substitute(workflow, events, step.id, step.run),
      produces: step.produces,
    };
  }
  return {
    type: 'agent',
    id: step.id,
    prompt: substitute(workflow, events, step.id, step.prompt),
    ...(step.model !== undefined && { model: step.model }),
    produces: step.produces,
  };
}
