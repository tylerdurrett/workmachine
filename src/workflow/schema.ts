import { z } from 'zod';
import type { ArtifactIndexEntry } from '../domain/artifacts.js';
import type { GateDecision } from '../domain/events.js';

/**
 * Zod schema and inferred types for a `workflow.yaml` definition.
 *
 * A workflow package declares its inputs and an ordered list of steps — a
 * `script` step runs a templated command and may `produce` named artifacts; an
 * `agent` step runs a templated prompt and may `produce` named artifacts; a
 * `gate` (review) step is a wait state declaring its `allowed_decisions`. The
 * loader (see `loader.ts`) parses YAML into this shape and Zod-validates it; the
 * resolver (#11) later substitutes `{{...}}` tokens per dispatch. This schema is
 * purely structural — interpolation-reference and DAG checks live in their own
 * modules so each concern surfaces a precise, focused error.
 *
 * Three step kinds exist (CONTEXT.md → Gate): a `script` step runs a templated
 * command and may `produce` artifacts; an `agent` step runs a templated prompt
 * through an agent invocation and may `produce` artifacts; a `gate` step is a
 * **review step** — a coordinator-owned wait state that declares the
 * `allowed_decisions` a reviewer may hand it. `type` discriminates the three. A
 * `script`-only workflow parses exactly as before. Every object is `.strict()`
 * so a typo'd or unknown key surfaces as a schema violation rather than being
 * silently dropped.
 *
 * This schema accepts the gate *shape* only; revision feedback threading
 * (`{{feedback.*}}`) stays rejected by the loader's interpolation pass — that is
 * a later task.
 */

/**
 * Declaration of an artifact a step produces, keyed into the run's artifact
 * index. Bound to the domain {@link ArtifactIndexEntry} via `satisfies` so the
 * loader's shape cannot drift from the canonical index entry: the workflow only
 * declares `id` + `path`; `sha256`/`size` are recorded by the executor at run
 * time, not authored in the workflow.
 */
export type ProducedArtifact = Pick<ArtifactIndexEntry, 'id' | 'path'>;

const producedArtifactSchema = z
  .object({
    /** Stable identifier for this artifact within the run. */
    id: z.string().min(1),
    /** Location of the artifact relative to the run directory. */
    path: z.string().min(1),
  })
  .strict() satisfies z.ZodType<ProducedArtifact>;

/**
 * Declaration of a single operator-supplied input. The `type` is advisory for
 * now (the resolver substitutes string tokens); it defaults to `'string'`.
 */
const workflowInputSchema = z
  .object({
    /** Declared value type of the input; defaults to `string`. */
    type: z.enum(['string', 'number', 'boolean']).default('string'),
    /** Optional human-readable description of the input. */
    description: z.string().optional(),
  })
  .strict();

/**
 * The decision verbs a gate may permit, mirroring the domain `GateDecision`
 * vocabulary. A review step declares the subset it accepts via
 * `allowed_decisions`; a command's verb is valid only if it appears here.
 */
const gateDecisionSchema = z.enum([
  'approve',
  'request_changes',
  'reject',
]) satisfies z.ZodType<GateDecision>;

/**
 * A single `script` step: a templated command plus optional explicit
 * dependencies and produced artifacts.
 */
const scriptStepSchema = z
  .object({
    /** Stable, non-empty id for the step within the workflow. */
    id: z.string().min(1),
    /** Step kind discriminant. */
    type: z.literal('script'),
    /** Templated command to run; may contain `{{inputs.*}}`/`{{artifacts.*.path}}`. */
    run: z.string().min(1),
    /** Explicit step-id dependencies; defaults to none. */
    needs: z.array(z.string()).default([]),
    /** Artifacts this step produces; defaults to none. */
    produces: z.array(producedArtifactSchema).default([]),
  })
  .strict();

/**
 * A single `agent` step: a templated prompt run through an agent invocation,
 * plus optional explicit dependencies, produced artifacts, and model override.
 */
const agentStepSchema = z
  .object({
    /** Stable, non-empty id for the step within the workflow. */
    id: z.string().min(1),
    /** Step kind discriminant. */
    type: z.literal('agent'),
    /** Templated prompt to run; may contain `{{inputs.*}}`/`{{artifacts.*.path}}`. */
    prompt: z.string().min(1),
    /** Explicit step-id dependencies; defaults to none. */
    needs: z.array(z.string()).default([]),
    /** Artifacts this step produces; defaults to none. */
    produces: z.array(producedArtifactSchema).default([]),
    /** Optional model override for the agent invocation. */
    model: z.string().min(1).optional(),
  })
  .strict();

/**
 * A single `gate` step (a **review step**): a coordinator-owned wait state that
 * accepts a reviewer decision. It runs no command and produces no artifacts; it
 * only declares the `allowed_decisions` it permits.
 */
const gateStepSchema = z
  .object({
    /** Stable, non-empty id for the step within the workflow. */
    id: z.string().min(1),
    /** Step kind discriminant. */
    type: z.literal('gate'),
    /** Decision verbs this gate permits; at least one, no duplicates. */
    allowed_decisions: z.array(gateDecisionSchema).min(1),
    /** Explicit step-id dependencies; defaults to none. */
    needs: z.array(z.string()).default([]),
  })
  .strict();

/**
 * A single step: a `script` step, an `agent` step, or a `gate` (review) step,
 * discriminated by `type`.
 */
const workflowStepSchema = z.discriminatedUnion('type', [
  scriptStepSchema,
  agentStepSchema,
  gateStepSchema,
]);

/** The top-level `workflow.yaml` schema. */
export const workflowSchema = z
  .object({
    /** Workflow package slug; required, non-empty. */
    slug: z.string().min(1),
    /** Optional human-readable workflow label. */
    name: z.string().optional(),
    /** Optional human-readable workflow description. */
    description: z.string().optional(),
    /** Declared inputs, keyed by input name; defaults to none. */
    inputs: z.record(workflowInputSchema).default({}),
    /** Ordered list of steps; at least one is required. */
    steps: z.array(workflowStepSchema).min(1),
  })
  .strict();

/**
 * Narrow a {@link WorkflowStep} to a `script` step. Loader passes that reason
 * about commands and artifacts (interpolation, DAG wiring) and the harness's
 * resolver/executor narrow on this; gate steps carry no `run` or `produces`.
 */
export function isScriptStep(step: WorkflowStep): step is ScriptStep {
  return step.type === 'script';
}

/** Narrow a {@link WorkflowStep} to an `agent` step. */
export function isAgentStep(step: WorkflowStep): step is AgentStep {
  return step.type === 'agent';
}

/** Narrow a {@link WorkflowStep} to a `gate` (review) step. */
export function isGateStep(step: WorkflowStep): step is GateStep {
  return step.type === 'gate';
}

/** A fully-parsed, validated workflow definition. */
export type WorkflowDefinition = z.infer<typeof workflowSchema>;
/** A single validated step within a {@link WorkflowDefinition} (script, agent, or gate). */
export type WorkflowStep = z.infer<typeof workflowStepSchema>;
/** A validated `script` step within a {@link WorkflowDefinition}. */
export type ScriptStep = z.infer<typeof scriptStepSchema>;
/** A validated `agent` step within a {@link WorkflowDefinition}. */
export type AgentStep = z.infer<typeof agentStepSchema>;
/** A validated `gate` (review) step within a {@link WorkflowDefinition}. */
export type GateStep = z.infer<typeof gateStepSchema>;
/** A single validated input declaration within a {@link WorkflowDefinition}. */
export type WorkflowInput = z.infer<typeof workflowInputSchema>;
