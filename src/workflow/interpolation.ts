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
 * The loader never substitutes values — that is the resolver's job (#11). A
 * step's templated TEXT (a script step's `run`, an agent step's `prompt`) may
 * carry resolvable interpolation; this pass checks that every token there points
 * at something the workflow actually declares:
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
 * A produced artifact's `path` is different in kind: it is a STATIC fact, not
 * templated text, and may NOT contain any token at all. The resolver uses the
 * declared path verbatim, capture existence-checks it literally, and replay
 * reads it back unchanged — so a `{{...}}` token there would be a promise the
 * runtime can't keep. We therefore reject ANY token in `produces[].path`,
 * regardless of whether it would otherwise resolve (#71).
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

  // A produced artifact `path` is a static fact, not templated text: reject ANY
  // `{{...}}` token in it (even one that would otherwise resolve). The resolver
  // uses the declared path verbatim, so a token there could never be kept.
  const rejectPathTokens = (text: string, path: (string | number)[]): void => {
    for (const [, inner] of text.matchAll(TOKEN_RE)) {
      issues.push({
        code: z.ZodIssueCode.custom,
        path,
        message: `interpolation token '{{${inner ?? ''}}}' is not allowed in a produced artifact path; declared paths must be static`,
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
      rejectPathTokens(artifact.path, [
        'steps',
        stepIndex,
        'produces',
        pathIndex,
        'path',
      ]);
    });
  });

  return issues;
}
