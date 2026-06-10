import type { ProducedArtifact } from '../workflow/schema.js';

/**
 * The `agent` executor's pure half: prompt composition (ADR-0009).
 *
 * An agent step hands a resolved prompt to an autonomous harness working in the
 * run directory; the harness — not the engine — writes the declared artifacts.
 * Enforcement is deterministic: the engine appends a contract block to every
 * resolved prompt stating exactly what the harness must (and must not) do, and
 * after exit verifies each declared `produces` exists. No re-prompt loops.
 *
 * The composition happens AT DISPATCH (in the harness tick), so the prompt
 * recorded on `step_dispatched` is the author text + contract block — the exact
 * bytes the executor later sends. Replay reads the recorded prompt back from
 * the log, never re-composes it.
 */

/**
 * Append the deterministic engine contract block to a resolved author prompt.
 *
 * The block states the step's obligations: write every declared artifact at its
 * path relative to the run directory, stay inside the run directory, and make
 * no git commits or pushes. It is a pure function of its inputs — the same
 * prompt and declarations always compose to the same bytes.
 *
 * @param prompt the fully-resolved author prompt (no `{{...}}` tokens remain).
 * @param produces the artifacts the step declared; paths relative to the run dir.
 */
export function composeAgentPrompt(
  prompt: string,
  produces: readonly ProducedArtifact[],
): string {
  const artifactLines =
    produces.length === 0
      ? ['- This step declares no artifact files.']
      : [
          '- Before you finish, write every one of these declared artifact files (paths are relative to the run directory):',
          ...produces.map((artifact) => `  - \`${artifact.path}\``),
        ];

  return [
    prompt,
    '',
    '---',
    '',
    '## Engine contract',
    '',
    'You are working inside a workflow run directory (your current working directory).',
    '',
    ...artifactLines,
    '- Stay inside the run directory: do not read or write files outside it.',
    '- Do not make git commits and do not push to any remote.',
  ].join('\n');
}
