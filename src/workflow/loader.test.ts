import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadWorkflow } from './loader.js';

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
    expect(def.steps[0]?.produces).toEqual([]);
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

  it('rejects a gate step type (gateless scope)', () => {
    try {
      loadWorkflow(`
slug: x
steps:
  - id: approve
    type: gate
    run: echo hi
`);
      throw new Error('expected a ZodError');
    } catch (err) {
      expect(err).toBeInstanceOf(z.ZodError);
      expect(
        (err as z.ZodError).issues.some((i) => i.path.includes('type')),
      ).toBe(true);
    }
  });
});
