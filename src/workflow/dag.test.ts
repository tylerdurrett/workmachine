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

describe('validateDag (via loadWorkflow)', () => {
  it('accepts a valid acyclic graph with explicit and implicit edges', () => {
    const def = loadWorkflow(`
slug: ok-dag
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

  it('rejects a duplicate step id', () => {
    const messages = issueMessages(`
slug: dup-step
steps:
  - id: a
    type: script
    run: echo 1
  - id: a
    type: script
    run: echo 2
`);
    expect(messages).toContain("duplicate step id 'a'");
  });

  it('rejects a duplicate artifact id across steps', () => {
    const messages = issueMessages(`
slug: dup-artifact
steps:
  - id: a
    type: script
    run: echo 1
    produces:
      - id: out
        path: artifacts/a.txt
  - id: b
    type: script
    run: echo 2
    produces:
      - id: out
        path: artifacts/b.txt
`);
    expect(messages).toContain("duplicate artifact id 'out'");
  });

  it('rejects a needs entry pointing at an unknown step', () => {
    const messages = issueMessages(`
slug: bad-needs
steps:
  - id: a
    type: script
    run: echo 1
    needs: [ghost]
`);
    expect(messages).toContain("step 'a' needs unknown step 'ghost'");
  });

  it('rejects an explicit-needs cycle', () => {
    const messages = issueMessages(`
slug: cycle-needs
steps:
  - id: a
    type: script
    run: echo 1
    needs: [b]
  - id: b
    type: script
    run: echo 2
    needs: [a]
`);
    expect(
      messages.some((m) =>
        m.startsWith('cycle detected in step dependencies:'),
      ),
    ).toBe(true);
  });

  it('rejects a cycle formed by implicit artifact edges', () => {
    const messages = issueMessages(`
slug: cycle-artifacts
steps:
  - id: a
    type: script
    run: 'cat {{artifacts.fromB.path}} > {{artifacts.fromA.path}}'
    produces:
      - id: fromA
        path: artifacts/a.txt
  - id: b
    type: script
    run: 'cat {{artifacts.fromA.path}} > {{artifacts.fromB.path}}'
    produces:
      - id: fromB
        path: artifacts/b.txt
`);
    expect(
      messages.some((m) =>
        m.startsWith('cycle detected in step dependencies:'),
      ),
    ).toBe(true);
  });
});
