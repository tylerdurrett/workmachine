import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadWorkflow } from './loader.js';
import { isAgentStep, isGateStep, isScriptStep } from './schema.js';

const validYaml = `
slug: tiny-smoke
name: Tiny Smoke
description: A minimal smoke-test workflow
inputs:
  name:
    type: string
    description: Who to greet
steps:
  - id: greet
    type: script
    run: 'echo "hi {{inputs.name}}" > {{artifacts.greeting.path}}'
    produces:
      - id: greeting
        path: artifacts/greeting.txt
`;

describe('loadWorkflow — parsing and structural validation', () => {
  it('parses valid YAML into a typed definition with applied defaults', () => {
    const def = loadWorkflow(validYaml);

    expect(def.slug).toBe('tiny-smoke');
    expect(def.name).toBe('Tiny Smoke');
    expect(def.steps).toHaveLength(1);
    expect(def.steps[0]?.id).toBe('greet');
    // Defaults are applied so consumers see non-optional shapes.
    expect(def.steps[0]?.needs).toEqual([]);
    expect(def.inputs.name?.type).toBe('string');
  });

  it('defaults inputs to an empty record when omitted', () => {
    const def = loadWorkflow(`
slug: no-inputs
steps:
  - id: only
    type: script
    run: echo hi
`);
    expect(def.inputs).toEqual({});
    const step = def.steps[0];
    expect(step && isScriptStep(step) && step.produces).toEqual([]);
  });

  it('throws a ZodError on invalid YAML syntax', () => {
    expect(() => loadWorkflow('slug: tiny\n  : : bad')).toThrow(z.ZodError);
    try {
      loadWorkflow('foo: [unterminated');
    } catch (err) {
      expect(err).toBeInstanceOf(z.ZodError);
      expect((err as z.ZodError).issues[0]?.message).toMatch(/^Invalid YAML:/);
    }
  });

  it('rejects a missing required field (slug)', () => {
    expect(() =>
      loadWorkflow(`
steps:
  - id: only
    type: script
    run: echo hi
`),
    ).toThrow(z.ZodError);
  });

  it('rejects an empty steps array', () => {
    expect(() => loadWorkflow('slug: x\nsteps: []')).toThrow(z.ZodError);
  });

  it('rejects a wrong field type', () => {
    expect(() =>
      loadWorkflow(`
slug: x
steps:
  - id: only
    type: script
    run: 123
`),
    ).toThrow(z.ZodError);
  });

  it('rejects an unknown/typo key via .strict()', () => {
    try {
      loadWorkflow(`
slug: x
stepz:
  - id: only
    type: script
    run: echo hi
steps:
  - id: only
    type: script
    run: echo hi
`);
      throw new Error('expected a ZodError');
    } catch (err) {
      expect(err).toBeInstanceOf(z.ZodError);
      expect(
        (err as z.ZodError).issues.some((i) => i.code === 'unrecognized_keys'),
      ).toBe(true);
    }
  });

  it('accepts a gate (review) step declaring allowed_decisions', () => {
    const def = loadWorkflow(`
slug: gated
steps:
  - id: build
    type: script
    run: echo hi
  - id: review
    type: gate
    needs: [build]
    allowed_decisions: [approve, request_changes, reject]
`);
    const gate = def.steps[1];
    expect(gate && isGateStep(gate) && gate.allowed_decisions).toEqual([
      'approve',
      'request_changes',
      'reject',
    ]);
  });

  it('rejects a gate step that also carries a script-only key (run)', () => {
    expect(() =>
      loadWorkflow(`
slug: x
steps:
  - id: review
    type: gate
    allowed_decisions: [approve]
    run: echo hi
`),
    ).toThrow(z.ZodError);
  });

  it('accepts an agent step with a prompt, produces, and an optional model', () => {
    const def = loadWorkflow(`
slug: agentic
inputs:
  topic:
    type: string
steps:
  - id: draft
    type: agent
    prompt: 'Write about {{inputs.topic}} into {{artifacts.draft.path}}'
    model: gpt-5
    produces:
      - id: draft
        path: artifacts/draft.md
`);
    const step = def.steps[0];
    expect(step && isAgentStep(step)).toBe(true);
    expect(step && isAgentStep(step) && step.model).toBe('gpt-5');
    expect(step && isAgentStep(step) && step.produces).toEqual([
      { id: 'draft', path: 'artifacts/draft.md' },
    ]);
  });

  it('accepts an agent step without a model (model is optional)', () => {
    const def = loadWorkflow(`
slug: agentic
steps:
  - id: draft
    type: agent
    prompt: 'Write a haiku'
`);
    const step = def.steps[0];
    expect(step && isAgentStep(step) && step.model).toBeUndefined();
    expect(step?.needs).toEqual([]);
  });

  it('rejects an agent step carrying an unknown key via .strict()', () => {
    expect(() =>
      loadWorkflow(`
slug: x
steps:
  - id: draft
    type: agent
    prompt: 'Write a haiku'
    run: echo hi
`),
    ).toThrow(z.ZodError);
  });

  it('rejects an agent step with an empty prompt', () => {
    expect(() =>
      loadWorkflow(`
slug: x
steps:
  - id: draft
    type: agent
    prompt: ''
`),
    ).toThrow(z.ZodError);
  });

  it('rejects a gate step with an empty allowed_decisions list', () => {
    expect(() =>
      loadWorkflow(`
slug: x
steps:
  - id: review
    type: gate
    allowed_decisions: []
`),
    ).toThrow(z.ZodError);
  });

  it('accepts a valid retries value on script and agent steps', () => {
    const def = loadWorkflow(`
slug: retrying
steps:
  - id: build
    type: script
    run: echo hi
    retries: 2
  - id: draft
    type: agent
    prompt: 'Write a haiku'
    retries: 3
`);
    const script = def.steps[0];
    const agent = def.steps[1];
    expect(script && isScriptStep(script) && script.retries).toBe(2);
    expect(agent && isAgentStep(agent) && agent.retries).toBe(3);
  });

  it('defaults retries to 0 when omitted, identical to an explicit 0', () => {
    const omitted = loadWorkflow(`
slug: omitted
steps:
  - id: build
    type: script
    run: echo hi
`);
    const explicit = loadWorkflow(`
slug: explicit
steps:
  - id: build
    type: script
    run: echo hi
    retries: 0
`);
    const omittedStep = omitted.steps[0];
    const explicitStep = explicit.steps[0];
    expect(
      omittedStep && isScriptStep(omittedStep) && omittedStep.retries,
    ).toBe(0);
    expect(
      explicitStep && isScriptStep(explicitStep) && explicitStep.retries,
    ).toBe(0);
    // Omitted and explicit-0 parse to identical step values.
    expect(omittedStep && { ...omittedStep, id: 'x' }).toEqual(
      explicitStep && { ...explicitStep, id: 'x' },
    );
  });

  it('rejects a negative retries value', () => {
    expect(() =>
      loadWorkflow(`
slug: x
steps:
  - id: build
    type: script
    run: echo hi
    retries: -1
`),
    ).toThrow(z.ZodError);
  });

  it('rejects a non-integer retries value', () => {
    expect(() =>
      loadWorkflow(`
slug: x
steps:
  - id: build
    type: script
    run: echo hi
    retries: 1.5
`),
    ).toThrow(z.ZodError);
  });

  it('rejects a gate step carrying retries (unrecognized_keys)', () => {
    try {
      loadWorkflow(`
slug: x
steps:
  - id: review
    type: gate
    allowed_decisions: [approve]
    retries: 1
`);
      throw new Error('expected a ZodError');
    } catch (err) {
      expect(err).toBeInstanceOf(z.ZodError);
      expect(
        (err as z.ZodError).issues.some((i) => i.code === 'unrecognized_keys'),
      ).toBe(true);
    }
  });
});
