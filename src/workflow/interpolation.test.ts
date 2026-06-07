import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadWorkflow } from './loader.js';

/** Collect issue messages from a thrown ZodError for a workflow that should fail. */
function issueMessages(yamlText: string): string[] {
  try {
    loadWorkflow(yamlText);
    throw new Error('expected loadWorkflow to throw a ZodError');
  } catch (err) {
    expect(err).toBeInstanceOf(z.ZodError);
    return (err as z.ZodError).issues.map((i) => i.message);
  }
}

describe('validateInterpolationRefs (via loadWorkflow)', () => {
  it('accepts references to declared inputs and produced artifacts', () => {
    const def = loadWorkflow(`
slug: ok
inputs:
  name:
    type: string
steps:
  - id: greet
    type: script
    run: 'echo "hi {{inputs.name}}" > {{artifacts.greeting.path}}'
    produces:
      - id: greeting
        path: artifacts/greeting.txt
`);
    expect(def.steps[0]?.id).toBe('greet');
  });

  it('resolves an artifact ref to a producer in a different step', () => {
    const def = loadWorkflow(`
slug: cross-step
steps:
  - id: make
    type: script
    run: 'echo hi > {{artifacts.out.path}}'
    produces:
      - id: out
        path: artifacts/out.txt
  - id: use
    type: script
    run: 'cat {{artifacts.out.path}}'
    needs: [make]
`);
    expect(def.steps).toHaveLength(2);
  });

  it('rejects a reference to an undeclared input', () => {
    const messages = issueMessages(`
slug: bad-input
steps:
  - id: greet
    type: script
    run: 'echo {{inputs.missing}}'
`);
    expect(messages).toContain("references undeclared input 'missing'");
  });

  it('rejects a dangling artifact reference (no producer)', () => {
    const messages = issueMessages(`
slug: dangling
steps:
  - id: use
    type: script
    run: 'cat {{artifacts.ghost.path}}'
`);
    expect(messages).toContain(
      "references artifact 'ghost' that no step produces",
    );
  });

  it('rejects an unsupported reference shape', () => {
    const messages = issueMessages(`
slug: unsupported
steps:
  - id: use
    type: script
    run: 'echo {{artifacts.x.size}} {{feedback.note}} {{inputs.}}'
`);
    expect(messages).toContain(
      "unsupported interpolation reference '{{artifacts.x.size}}'",
    );
    expect(messages).toContain(
      "unsupported interpolation reference '{{feedback.note}}'",
    );
    expect(messages).toContain(
      "unsupported interpolation reference '{{inputs.}}'",
    );
  });

  it('validates tokens inside produced artifact paths too', () => {
    const messages = issueMessages(`
slug: path-token
steps:
  - id: make
    type: script
    run: echo hi
    produces:
      - id: out
        path: 'artifacts/{{inputs.dir}}/out.txt'
`);
    expect(messages).toContain("references undeclared input 'dir'");
  });
});
