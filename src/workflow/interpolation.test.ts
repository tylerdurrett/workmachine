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

  it('accepts a well-formed {{feedback.<field>}} reference', () => {
    // Feedback is a runtime fact the resolver supplies, not a declaration; the
    // loader only checks its shape, so a well-formed reference passes.
    const def = loadWorkflow(`
slug: feedback-ok
steps:
  - id: revise
    type: script
    run: 'echo {{feedback.note}}'
`);
    expect(def.steps[0]?.id).toBe('revise');
  });

  it('rejects an unsupported reference shape', () => {
    const messages = issueMessages(`
slug: unsupported
steps:
  - id: use
    type: script
    run: 'echo {{artifacts.x.size}} {{inputs.}}'
`);
    expect(messages).toContain(
      "unsupported interpolation reference '{{artifacts.x.size}}'",
    );
    expect(messages).toContain(
      "unsupported interpolation reference '{{inputs.}}'",
    );
  });

  it('rejects an undeclared input referenced in an agent prompt, at the prompt path', () => {
    try {
      loadWorkflow(`
slug: bad-agent-input
steps:
  - id: draft
    type: agent
    prompt: 'Write about {{inputs.missing}}'
`);
      throw new Error('expected loadWorkflow to throw a ZodError');
    } catch (err) {
      expect(err).toBeInstanceOf(z.ZodError);
      const issue = (err as z.ZodError).issues[0];
      expect(issue?.message).toBe("references undeclared input 'missing'");
      expect(issue?.path).toEqual(['steps', 0, 'prompt']);
    }
  });

  it('rejects a dangling artifact reference in an agent prompt', () => {
    const messages = issueMessages(`
slug: bad-agent-artifact
steps:
  - id: draft
    type: agent
    prompt: 'Summarize {{artifacts.ghost.path}}'
`);
    expect(messages).toContain(
      "references artifact 'ghost' that no step produces",
    );
  });

  it('lets a script step reference an agent-produced artifact', () => {
    const def = loadWorkflow(`
slug: agent-producer
steps:
  - id: draft
    type: agent
    prompt: 'Write a draft into {{artifacts.draft.path}}'
    produces:
      - id: draft
        path: artifacts/draft.md
  - id: publish
    type: script
    run: 'cat {{artifacts.draft.path}}'
    needs: [draft]
`);
    expect(def.steps).toHaveLength(2);
  });

  it('accepts a well-formed {{feedback.<field>}} reference in an agent prompt', () => {
    const def = loadWorkflow(`
slug: agent-feedback
steps:
  - id: revise
    type: agent
    prompt: 'Apply this feedback: {{feedback.note}}'
`);
    expect(def.steps[0]?.id).toBe('revise');
  });

  it('validates tokens inside agent produced artifact paths too', () => {
    const messages = issueMessages(`
slug: agent-path-token
steps:
  - id: draft
    type: agent
    prompt: 'Write something'
    produces:
      - id: out
        path: 'artifacts/{{inputs.dir}}/out.md'
`);
    expect(messages).toContain("references undeclared input 'dir'");
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
