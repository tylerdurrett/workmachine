import type { ArtifactIndexEntry } from '../domain/artifacts.js';
import type { ProducedArtifact } from '../workflow/schema.js';

/**
 * The executor seam: the only place side effects are allowed (CONTEXT.md →
 * Determinism boundary / Executor adapter).
 *
 * The orchestrator never talks to executors; the harness does, behind this one
 * tiny interface. An executor consumes an already-resolved step (the resolver,
 * #11, has substituted every `{{...}}` token) plus the run context, performs
 * its side effect, and returns artifacts or an error. It never reads the event
 * log, never touches the tracker, and never decides what runs next — its only
 * outputs are produced artifacts plus an ok/fail verdict, which the harness maps
 * to a `step_succeeded` / `step_failed` event.
 */

/**
 * Fields every resolved step variant shares, regardless of kind: the step's
 * identity and the artifacts it promised to produce.
 */
interface ResolvedStepBase {
  /** Id of the step being executed. */
  id: string;
  /**
   * Artifacts this step declared it produces. Each is captured into a full
   * {@link ArtifactIndexEntry} after the run; a declared artifact missing on
   * disk afterward is a failure.
   */
  produces: ProducedArtifact[];
}

/**
 * A `script` step whose command has already been resolved by the harness
 * resolver (#11): every `{{inputs.*}}` / `{{artifacts.*.path}}` /
 * `{{feedback.*}}` token has been substituted, so `command` is a literal shell
 * string the executor can run as-is.
 */
export interface ResolvedScriptStep extends ResolvedStepBase {
  /** Step kind discriminant, mirroring the workflow schema's. */
  type: 'script';
  /** The fully-resolved command to run (no `{{...}}` tokens remain). */
  command: string;
}

/**
 * An `agent` step whose prompt has already been resolved by the harness
 * resolver: every `{{...}}` token has been substituted through the same grammar
 * as a script command, so `prompt` is the literal author prompt the agent
 * invocation receives as-is.
 */
export interface ResolvedAgentStep extends ResolvedStepBase {
  /** Step kind discriminant, mirroring the workflow schema's. */
  type: 'agent';
  /** The fully-resolved prompt to run (no `{{...}}` tokens remain). */
  prompt: string;
  /** Optional model override for the agent invocation, passed through verbatim. */
  model?: string;
}

/**
 * A step the harness resolver has fully substituted, discriminated by `type`
 * exactly like the workflow schema's executable step kinds. The executor never
 * performs interpolation itself; each executor adapter narrows to the variant
 * it knows how to run.
 */
export type ResolvedStep = ResolvedScriptStep | ResolvedAgentStep;

/**
 * Ambient context an executor needs to do its work. Held minimal on purpose:
 * the run directory anchors both where the command runs and where declared
 * artifact paths resolve, since artifact `path`s are relative to the run dir
 * (architecture.md → run-dir layout).
 */
export interface RunContext {
  /** Absolute path to the run directory (`runs/<run_id>/`). */
  runDir: string;
}

/**
 * The result of executing a step. A success carries the captured artifact index
 * entries (mapped to `step_succeeded`); a failure carries a human-readable
 * reason (mapped to `step_failed`).
 */
export type ExecutorResult =
  | { ok: true; artifacts: ArtifactIndexEntry[] }
  | { ok: false; error: string };

/** The executor interface. One method, behind which all side effects live. */
export interface Executor {
  /** Run the resolved step in the given context and report its outcome. */
  run(step: ResolvedStep, ctx: RunContext): Promise<ExecutorResult>;
}
