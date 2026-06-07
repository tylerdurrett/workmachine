import { z } from 'zod';
import type { WorkflowDefinition } from './schema.js';

/**
 * Static validation of `{{...}}` interpolation references (AC#2).
 *
 * The loader never substitutes values — that is the resolver's job (#11). This
 * pass only checks that every interpolation token in a step's `run` command and
 * in each produced artifact's `path` points at something the workflow actually
 * declares:
 *  - `{{inputs.<name>}}` must name a declared input.
 *  - `{{artifacts.<id>.path}}` must name an artifact some step `produces` (an
 *    unresolved one is the "dangling artifact ref" the contract calls out).
 *  - anything else (unknown namespace, `{{artifacts.x.size}}`, `{{feedback.*}}`,
 *    malformed tokens) is unsupported in this slice and rejected.
 *
 * Failures are returned as `z.ZodIssue[]` (not thrown) so the loader can merge
 * them with the DAG pass into a single `z.ZodError`. Paths point at the precise
 * offending location for clear errors.
 */

/** Matches a `{{ ... }}` token and captures its (untrimmed) inner text. */
const TOKEN_RE = /\{\{\s*([^}]*?)\s*\}\}/g;
const INPUT_REF_RE = /^inputs\.([A-Za-z0-9_-]+)$/;
const ARTIFACT_REF_RE = /^artifacts\.([A-Za-z0-9_-]+)\.path$/;

/**
 * Validate every interpolation reference in `def` against its declarations.
 *
 * @returns one issue per bad reference; empty when all references resolve.
 */
export function validateInterpolationRefs(
  def: WorkflowDefinition,
): z.ZodIssue[] {
  const issues: z.ZodIssue[] = [];
  const declaredInputs = new Set(Object.keys(def.inputs));
  const producedIds = new Set(
    def.steps.flatMap((step) => step.produces.map((a) => a.id)),
  );

  const check = (text: string, path: (string | number)[]): void => {
    for (const [, inner] of text.matchAll(TOKEN_RE)) {
      const token = inner ?? '';

      const inputMatch = INPUT_REF_RE.exec(token);
      if (inputMatch) {
        const name = inputMatch[1] ?? '';
        if (!declaredInputs.has(name)) {
          issues.push({
            code: z.ZodIssueCode.custom,
            path,
            message: `references undeclared input '${name}'`,
          });
        }
        continue;
      }

      const artifactMatch = ARTIFACT_REF_RE.exec(token);
      if (artifactMatch) {
        const id = artifactMatch[1] ?? '';
        if (!producedIds.has(id)) {
          issues.push({
            code: z.ZodIssueCode.custom,
            path,
            message: `references artifact '${id}' that no step produces`,
          });
        }
        continue;
      }

      issues.push({
        code: z.ZodIssueCode.custom,
        path,
        message: `unsupported interpolation reference '{{${token}}}'`,
      });
    }
  };

  def.steps.forEach((step, stepIndex) => {
    check(step.run, ['steps', stepIndex, 'run']);
    step.produces.forEach((artifact, pathIndex) => {
      check(artifact.path, ['steps', stepIndex, 'produces', pathIndex, 'path']);
    });
  });

  return issues;
}
