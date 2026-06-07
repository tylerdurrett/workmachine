import { z } from 'zod';
import type { ArtifactIndexEntry } from '../domain/artifacts.js';

/**
 * Zod schema and inferred types for a `workflow.yaml` definition.
 *
 * A workflow package declares its inputs and an ordered list of `script` steps;
 * each step runs a templated command and may `produce` named artifacts. The
 * loader (see `loader.ts`) parses YAML into this shape and Zod-validates it; the
 * resolver (#11) later substitutes `{{...}}` tokens per dispatch. This schema is
 * purely structural — interpolation-reference and DAG checks live in their own
 * modules so each concern surfaces a precise, focused error.
 *
 * Scope is deliberately gateless (ADR/CONTEXT): only `script` steps exist here.
 * A `gate` step type arrives in a later slice and MUST be rejected by this
 * schema today, so step `type` is a `z.literal('script')`. Every object is
 * `.strict()` so a typo'd or unknown key surfaces as a schema violation rather
 * than being silently dropped.
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
 * A single `script` step: a templated command plus optional explicit
 * dependencies and produced artifacts.
 */
const workflowStepSchema = z
  .object({
    /** Stable, non-empty id for the step within the workflow. */
    id: z.string().min(1),
    /** Step kind. Gateless scope: only `script` is permitted. */
    type: z.literal('script'),
    /** Templated command to run; may contain `{{inputs.*}}`/`{{artifacts.*.path}}`. */
    run: z.string().min(1),
    /** Explicit step-id dependencies; defaults to none. */
    needs: z.array(z.string()).default([]),
    /** Artifacts this step produces; defaults to none. */
    produces: z.array(producedArtifactSchema).default([]),
  })
  .strict();

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

/** A fully-parsed, validated workflow definition. */
export type WorkflowDefinition = z.infer<typeof workflowSchema>;
/** A single validated step within a {@link WorkflowDefinition}. */
export type WorkflowStep = z.infer<typeof workflowStepSchema>;
/** A single validated input declaration within a {@link WorkflowDefinition}. */
export type WorkflowInput = z.infer<typeof workflowInputSchema>;
