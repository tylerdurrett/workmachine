import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { validateInterpolationRefs } from './interpolation.js';
import { workflowSchema, type WorkflowDefinition } from './schema.js';

/**
 * Parse and validate `workflow.yaml` text into a typed {@link WorkflowDefinition}.
 *
 * All failures — invalid YAML syntax, schema violations, bad interpolation
 * references, and DAG problems — surface as a `z.ZodError`, so a single
 * `catch (err) { if (err instanceof z.ZodError) ... }` handles every case. No
 * value substitution happens here: the loader validates statically and the
 * resolver (#11) substitutes `{{...}}` tokens per dispatch.
 *
 * @throws {z.ZodError} on any validation failure.
 */
export function loadWorkflow(yamlText: string): WorkflowDefinition {
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new z.ZodError([
      {
        code: z.ZodIssueCode.custom,
        path: [],
        message: `Invalid YAML: ${message}`,
      },
    ]);
  }

  const def = workflowSchema.parse(parsed);

  const issues = validateInterpolationRefs(def);
  if (issues.length > 0) {
    throw new z.ZodError(issues);
  }

  return def;
}

/**
 * Read a `workflow.yaml` file from disk (UTF-8) and validate it via
 * {@link loadWorkflow}.
 *
 * @throws {z.ZodError} on any validation failure.
 */
export function loadWorkflowFile(filePath: string): WorkflowDefinition {
  return loadWorkflow(readFileSync(filePath, 'utf8'));
}
