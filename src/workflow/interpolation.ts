import { z } from 'zod';
import {
  isAgentStep,
  isScriptStep,
  isTemplatedStep,
  type WorkflowDefinition,
} from './schema.js';

/**
 * Static validation of `{{...}}` interpolation references (AC#2).
 *
 * The loader never substitutes values — that is the resolver's job (#11). This
 * pass only checks that every interpolation token in a step's templated text (a
 * script step's `run`, an agent step's `prompt`) and in each produced
 * artifact's `path` points at something the workflow actually declares:
 *  - `{{inputs.<name>}}` must name a declared input.
 *  - `{{artifacts.<id>.path}}` must name an artifact some step `produces` (an
 *    unresolved one is the "dangling artifact ref" the contract calls out).
 *  - `{{feedback.<field>}}` is a well-formed revision-feedback reference. The
 *    loader accepts its *shape* only — there is nothing to cross-check against a
 *    declaration, because feedback is a runtime fact threaded from the gate's
 *    `request_changes` decision, supplied by the resolver, not by the workflow.
 *  - anything else (unknown namespace, `{{artifacts.x.size}}`, malformed
 *    tokens) is unsupported in this slice and rejected.
 *
 * Failures are returned as `z.ZodIssue[]` (not thrown) so the loader can merge
 * them with the DAG pass into a single `z.ZodError`. Paths point at the precise
 * offending location for clear errors.
 */

/**
 * Matches a `{{ ... }}` token and captures its (untrimmed) inner text.
 *
 * Exported so the resolver (#11) substitutes against the *exact same* grammar
 * this loader pass validates against — sharing the source of truth keeps the
 * static check and the runtime substitution from drifting apart. The regex is
 * `g`-flagged, so any consumer using it with `.exec`/`.test` must reset
 * `lastIndex` or use `.matchAll`; here every use is via `.matchAll`.
 */
export const TOKEN_RE = /\{\{\s*([^}]*?)\s*\}\}/g;
/** Matches the inner text of an `{{inputs.<name>}}` token, capturing `<name>`. */
export const INPUT_REF_RE = /^inputs\.([A-Za-z0-9_-]+)$/;
/** Matches the inner text of an `{{artifacts.<id>.path}}` token, capturing `<id>`. */
export const ARTIFACT_REF_RE = /^artifacts\.([A-Za-z0-9_-]+)\.path$/;
/** Matches the inner text of a `{{feedback.<field>}}` token, capturing `<field>`. */
export const FEEDBACK_REF_RE = /^feedback\.([A-Za-z0-9_-]+)$/;

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
    def.steps.flatMap((step) =>
      isTemplatedStep(step) ? step.produces.map((a) => a.id) : [],
    ),
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

      // `{{feedback.<field>}}` is a runtime fact, not a declaration: there is
      // nothing to cross-check here, so a well-formed reference passes static
      // validation and the resolver supplies its value at dispatch.
      if (FEEDBACK_REF_RE.test(token)) {
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
    // Only script and agent steps carry interpolatable text; gate steps have
    // no templated command/prompt or produced paths.
    if (isScriptStep(step)) {
      check(step.run, ['steps', stepIndex, 'run']);
    } else if (isAgentStep(step)) {
      check(step.prompt, ['steps', stepIndex, 'prompt']);
    } else {
      return;
    }
    step.produces.forEach((artifact, pathIndex) => {
      check(artifact.path, ['steps', stepIndex, 'produces', pathIndex, 'path']);
    });
  });

  return issues;
}
