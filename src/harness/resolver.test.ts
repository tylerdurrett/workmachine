import { describe, expect, it } from 'vitest';
import type { EngineEvent } from '../domain/index.js';
import { isAgentStep, isScriptStep, loadWorkflow } from '../workflow/index.js';
import type {
  AgentStep,
  ScriptStep,
  WorkflowDefinition,
} from '../workflow/index.js';
import { resolveStep } from './resolver.js';

const runId = '20260607T120000Z-tiny-smoke-ab12';

/**
 * Resolve a script step's `run` to just its command string. This is the
 * script-specific convenience the old `resolveCommand` export provided; it now
 * lives here as a test helper over the real {@link resolveStep} path so the
 * substitution assertions below stay unchanged without a production export.
 */
function resolveCommand(
  workflow: WorkflowDefinition,
  step: ScriptStep,
  events: readonly EngineEvent[],
): string {
  return resolveStep(workflow, step, events).command;
}

/** Build a `run_created` event seeding the log with the run's inputs. */
function created(inputs: Record<string, unknown> = {}): EngineEvent {
  return {
    type: 'run_created',
    runId,
    seq: 0,
    ts: '2026-06-07T12:00:00.000Z',
    workflowSlug: 'tiny-smoke',
    inputs,
  };
}

/** A `gate_decided` event closing a gate with the given decision/feedback. */
function gateDecided(
  seq: number,
  decision: 'approve' | 'request_changes' | 'reject',
  feedback?: string,
): EngineEvent {
  return {
    type: 'gate_decided',
    runId,
    seq,
    ts: '2026-06-07T12:00:00.000Z',
    gateId: 'review',
    decision,
    actor: 'reviewer',
    ...(feedback !== undefined && { feedback }),
  };
}

/** The script step whose templated `run` the resolver substitutes. */
function stepOf(workflow: WorkflowDefinition): ScriptStep {
  const [step] = workflow.steps;
  if (step === undefined || !isScriptStep(step)) {
    throw new Error('test workflow has no script step');
  }
  return step;
}

describe('resolveCommand (pure dispatch-time substitution)', () => {
  it('substitutes a {{inputs.*}} token with the run input value', () => {
    const workflow = loadWorkflow(`
slug: tiny-smoke
inputs:
  msg: {}
steps:
  - id: greet
    type: script
    run: "printf '{{inputs.msg}}'"
`);
    const command = resolveCommand(workflow, stepOf(workflow), [
      created({ msg: 'hello world' }),
    ]);
    expect(command).toBe("printf 'hello world'");
  });

  it('substitutes an {{artifacts.*.path}} token with the declared path', () => {
    const workflow = loadWorkflow(`
slug: tiny-smoke
steps:
  - id: greet
    type: script
    run: 'echo hi > {{artifacts.out.path}}'
    produces:
      - id: out
        path: artifacts/out.txt
`);
    const command = resolveCommand(workflow, stepOf(workflow), [created()]);
    expect(command).toBe('echo hi > artifacts/out.txt');
  });

  it('substitutes multiple tokens across both namespaces in one command', () => {
    const workflow = loadWorkflow(`
slug: tiny-smoke
inputs:
  msg: {}
steps:
  - id: greet
    type: script
    run: "printf '{{inputs.msg}}' > {{artifacts.out.path}}"
    produces:
      - id: out
        path: artifacts/out.txt
`);
    const command = resolveCommand(workflow, stepOf(workflow), [
      created({ msg: 'hi' }),
    ]);
    expect(command).toBe("printf 'hi' > artifacts/out.txt");
  });

  it('resolves an {{artifacts.*.path}} token produced by an agent step', () => {
    // The loader admits a script step referencing an agent-produced artifact;
    // the resolver must see the same declared set or a loader-valid workflow
    // would throw at dispatch.
    const workflow = loadWorkflow(`
slug: tiny-smoke
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
`);
    const publish = workflow.steps.find((s) => s.id === 'publish');
    if (publish === undefined || !isScriptStep(publish)) {
      throw new Error('test workflow has no publish script step');
    }
    const command = resolveCommand(workflow, publish, [created()]);
    expect(command).toBe('cat artifacts/draft.md');
  });

  it('tolerates inner whitespace in a token, mirroring the loader grammar', () => {
    const workflow = loadWorkflow(`
slug: tiny-smoke
inputs:
  msg: {}
steps:
  - id: greet
    type: script
    run: "printf '{{  inputs.msg  }}'"
`);
    const command = resolveCommand(workflow, stepOf(workflow), [
      created({ msg: 'spaced' }),
    ]);
    expect(command).toBe("printf 'spaced'");
  });

  it('passes a command with no tokens through unchanged', () => {
    const workflow = loadWorkflow(`
slug: tiny-smoke
steps:
  - id: greet
    type: script
    run: 'echo no tokens here'
`);
    const command = resolveCommand(workflow, stepOf(workflow), [created()]);
    expect(command).toBe('echo no tokens here');
  });

  it('coerces a number input to its string form', () => {
    const workflow = loadWorkflow(`
slug: tiny-smoke
inputs:
  count: { type: number }
steps:
  - id: greet
    type: script
    run: "printf '{{inputs.count}}'"
`);
    const command = resolveCommand(workflow, stepOf(workflow), [
      created({ count: 42 }),
    ]);
    expect(command).toBe("printf '42'");
  });

  it('coerces a boolean input to its string form', () => {
    const workflow = loadWorkflow(`
slug: tiny-smoke
inputs:
  flag: { type: boolean }
steps:
  - id: greet
    type: script
    run: "printf '{{inputs.flag}}'"
`);
    const command = resolveCommand(workflow, stepOf(workflow), [
      created({ flag: true }),
    ]);
    expect(command).toBe("printf 'true'");
  });

  it('produces exactly the command that would be recorded on step_dispatched', () => {
    // The resolved string is what the harness records as the dispatch command;
    // it must contain no residual {{...}} tokens for the log to be self-describing.
    const workflow = loadWorkflow(`
slug: tiny-smoke
inputs:
  msg: {}
steps:
  - id: greet
    type: script
    run: "printf '{{inputs.msg}}' > {{artifacts.out.path}}"
    produces:
      - id: out
        path: artifacts/out.txt
`);
    const command = resolveCommand(workflow, stepOf(workflow), [
      created({ msg: 'recorded' }),
    ]);
    expect(command).not.toMatch(/\{\{/);
    expect(command).toBe("printf 'recorded' > artifacts/out.txt");
  });

  it('throws a clear error when an input binding is absent from the run', () => {
    // The loader normally prevents this; the resolver throws defensively rather
    // than dispatching a half-substituted command.
    const workflow = loadWorkflow(`
slug: tiny-smoke
inputs:
  msg: {}
steps:
  - id: greet
    type: script
    run: "printf '{{inputs.msg}}'"
`);
    expect(() =>
      resolveCommand(workflow, stepOf(workflow), [created({})]),
    ).toThrow(/cannot resolve \{\{inputs\.msg\}\}/);
  });

  const feedbackWorkflow = (): WorkflowDefinition =>
    loadWorkflow(`
slug: tiny-smoke
steps:
  - id: revise
    type: script
    run: "printf '{{feedback.note}}'"
`);

  it('substitutes {{feedback.<field>}} from the latest request_changes decision', () => {
    const workflow = feedbackWorkflow();
    const command = resolveCommand(workflow, stepOf(workflow), [
      created(),
      gateDecided(1, 'request_changes', 'tighten the intro'),
    ]);
    expect(command).toBe("printf 'tighten the intro'");
  });

  it('resolves {{feedback.<field>}} to an empty default on the first dispatch', () => {
    // No prior gate_decided: the loop has not run yet, so feedback is empty
    // rather than throwing — the same templated command stays dispatchable.
    const workflow = feedbackWorkflow();
    const command = resolveCommand(workflow, stepOf(workflow), [created()]);
    expect(command).toBe("printf ''");
  });

  it('uses the latest request_changes feedback across multiple revision rounds', () => {
    const workflow = feedbackWorkflow();
    const command = resolveCommand(workflow, stepOf(workflow), [
      created(),
      gateDecided(1, 'request_changes', 'first round'),
      gateDecided(2, 'request_changes', 'second round'),
    ]);
    expect(command).toBe("printf 'second round'");
  });

  it('ignores non-request_changes decisions when reading feedback', () => {
    // An approve carries no revision feedback; the latest request_changes wins
    // even when a later approve closes a subsequent gate.
    const workflow = feedbackWorkflow();
    const command = resolveCommand(workflow, stepOf(workflow), [
      created(),
      gateDecided(1, 'request_changes', 'please revise'),
      gateDecided(2, 'approve'),
    ]);
    expect(command).toBe("printf 'please revise'");
  });

  it('reads inputs only from the run_created event in the log', () => {
    const workflow = loadWorkflow(`
slug: tiny-smoke
inputs:
  msg: {}
steps:
  - id: greet
    type: script
    run: "printf '{{inputs.msg}}'"
`);
    const events: EngineEvent[] = [
      created({ msg: 'from-log' }),
      {
        type: 'step_dispatched',
        runId,
        seq: 1,
        ts: '2026-06-07T12:00:01.000Z',
        stepId: 'greet',
        stepType: 'script',
        command: "printf 'stale'",
      },
    ];
    expect(resolveCommand(workflow, stepOf(workflow), events)).toBe(
      "printf 'from-log'",
    );
  });
});

describe('resolveStep (per-step-kind resolution into the ResolvedStep union)', () => {
  /** The first agent step in the workflow, for prompt-resolution cases. */
  function agentStepOf(workflow: WorkflowDefinition): AgentStep {
    const step = workflow.steps.find(isAgentStep);
    if (step === undefined) {
      throw new Error('test workflow has no agent step');
    }
    return step;
  }

  it('resolves a script step into the script variant, substituting its command', () => {
    const workflow = loadWorkflow(`
slug: tiny-smoke
inputs:
  msg: {}
steps:
  - id: greet
    type: script
    run: "printf '{{inputs.msg}}' > {{artifacts.out.path}}"
    produces:
      - id: out
        path: artifacts/out.txt
`);
    const step = stepOf(workflow);
    const events = [created({ msg: 'hi' })];

    expect(resolveStep(workflow, step, events)).toEqual({
      type: 'script',
      id: 'greet',
      command: "printf 'hi' > artifacts/out.txt",
      produces: [{ id: 'out', path: 'artifacts/out.txt' }],
    });
  });

  it('substitutes all three namespaces in an agent prompt through the shared grammar', () => {
    const workflow = loadWorkflow(`
slug: tiny-smoke
inputs:
  topic: {}
steps:
  - id: draft
    type: agent
    prompt: 'Write about {{inputs.topic}} into {{artifacts.draft.path}}. Reviewer said: {{feedback.note}}'
    produces:
      - id: draft
        path: artifacts/draft.md
`);
    const resolved = resolveStep(workflow, agentStepOf(workflow), [
      created({ topic: 'gates' }),
      gateDecided(1, 'request_changes', 'shorter please'),
    ]);

    expect(resolved).toEqual({
      type: 'agent',
      id: 'draft',
      prompt:
        'Write about gates into artifacts/draft.md. Reviewer said: shorter please',
      produces: [{ id: 'draft', path: 'artifacts/draft.md' }],
    });
  });

  it('resolves {{feedback.*}} in a prompt to an empty default on the first dispatch', () => {
    const workflow = loadWorkflow(`
slug: tiny-smoke
steps:
  - id: draft
    type: agent
    prompt: 'Revise per: {{feedback.note}}'
`);
    const resolved = resolveStep(workflow, agentStepOf(workflow), [created()]);
    expect(resolved.prompt).toBe('Revise per: ');
  });

  it('uses the latest request_changes feedback in a prompt across revision rounds', () => {
    const workflow = loadWorkflow(`
slug: tiny-smoke
steps:
  - id: draft
    type: agent
    prompt: 'Revise per: {{feedback.note}}'
`);
    const resolved = resolveStep(workflow, agentStepOf(workflow), [
      created(),
      gateDecided(1, 'request_changes', 'first round'),
      gateDecided(2, 'request_changes', 'second round'),
    ]);
    expect(resolved.prompt).toBe('Revise per: second round');
  });

  it('passes the model through when set and omits the key when absent', () => {
    const withModel = loadWorkflow(`
slug: tiny-smoke
steps:
  - id: draft
    type: agent
    prompt: 'Write a draft.'
    model: gpt-5.1-codex
`);
    const withoutModel = loadWorkflow(`
slug: tiny-smoke
steps:
  - id: draft
    type: agent
    prompt: 'Write a draft.'
`);
    expect(
      resolveStep(withModel, agentStepOf(withModel), [created()]).model,
    ).toBe('gpt-5.1-codex');
    expect(
      resolveStep(withoutModel, agentStepOf(withoutModel), [created()]),
    ).not.toHaveProperty('model');
  });

  it('throws a clear error when a prompt token references an absent binding', () => {
    const workflow = loadWorkflow(`
slug: tiny-smoke
inputs:
  topic: {}
steps:
  - id: draft
    type: agent
    prompt: 'Write about {{inputs.topic}}'
`);
    expect(() =>
      resolveStep(workflow, agentStepOf(workflow), [created({})]),
    ).toThrow(/cannot resolve \{\{inputs\.topic\}\} in step 'draft'/);
  });

  it('is a pure function of (workflow, step, events): same inputs, same output', () => {
    const workflow = loadWorkflow(`
slug: tiny-smoke
inputs:
  topic: {}
steps:
  - id: draft
    type: agent
    prompt: 'Write about {{inputs.topic}} into {{artifacts.draft.path}}'
    produces:
      - id: draft
        path: artifacts/draft.md
`);
    const events = [created({ topic: 'purity' })];
    const step = agentStepOf(workflow);

    // No filesystem, clock, or randomness feeds resolution: re-resolving the
    // same (workflow, step, events) yields a deeply identical value.
    expect(resolveStep(workflow, step, events)).toEqual(
      resolveStep(workflow, step, events),
    );
  });
});
