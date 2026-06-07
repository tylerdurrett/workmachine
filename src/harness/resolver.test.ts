import { describe, expect, it } from 'vitest';
import type { EngineEvent } from '../domain/index.js';
import { isScriptStep, loadWorkflow } from '../workflow/index.js';
import type { ScriptStep, WorkflowDefinition } from '../workflow/index.js';
import { resolveCommand } from './resolver.js';

const runId = '20260607T120000Z-tiny-smoke-ab12';

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
        command: "printf 'stale'",
      },
    ];
    expect(resolveCommand(workflow, stepOf(workflow), events)).toBe(
      "printf 'from-log'",
    );
  });
});
