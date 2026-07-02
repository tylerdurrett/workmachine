import { describe, expect, it } from 'vitest';
import { foldRunState } from '../orchestrator/index.js';
import type { WorkflowDefinition } from '../workflow/index.js';
import type {
  ArtifactIndexEntry,
  Decision,
  EngineEvent,
  RunState,
} from '../index.js';

const runId = '20260607T120000Z-tiny-smoke-ab12';

const artifact: ArtifactIndexEntry = {
  id: 'out',
  path: 'artifacts/out.txt',
  sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  size: 12,
};

describe('domain type contracts', () => {
  it('models the full gateless event sequence as EngineEvents', () => {
    const log: EngineEvent[] = [
      {
        type: 'run_created',
        runId,
        seq: 0,
        ts: '2026-06-07T12:00:00.000Z',
        workflowSlug: 'tiny-smoke',
        inputs: { name: 'world' },
      },
      {
        type: 'card_created',
        runId,
        seq: 1,
        ts: '2026-06-07T12:00:00.500Z',
        cardId: '42',
        cardUrl: 'https://github.com/acme/widgets/issues/42',
        runIdMarker: runId,
        repo: 'acme/widgets',
      },
      {
        type: 'step_dispatched',
        runId,
        seq: 2,
        ts: '2026-06-07T12:00:01.000Z',
        stepId: 'greet',
        stepType: 'script',
        command: 'echo "hello world"',
      },
      {
        type: 'step_succeeded',
        runId,
        seq: 3,
        ts: '2026-06-07T12:00:02.000Z',
        stepId: 'greet',
        artifacts: [artifact],
      },
      {
        type: 'step_failed',
        runId,
        seq: 4,
        ts: '2026-06-07T12:00:03.000Z',
        stepId: 'flaky',
        reason: 'exit code 1',
      },
      {
        type: 'run_completed',
        runId,
        seq: 5,
        ts: '2026-06-07T12:00:04.000Z',
        artifacts: [artifact],
      },
      {
        type: 'run_failed',
        runId,
        seq: 6,
        ts: '2026-06-07T12:00:05.000Z',
        reason: 'step flaky failed',
      },
    ];

    expect(log).toHaveLength(7);
    expect(log.map((e) => e.type)).toEqual([
      'run_created',
      'card_created',
      'step_dispatched',
      'step_succeeded',
      'step_failed',
      'run_completed',
      'run_failed',
    ]);
  });

  it('models the gate event subset as EngineEvents', () => {
    const log: EngineEvent[] = [
      {
        type: 'gate_opened',
        runId,
        seq: 0,
        ts: '2026-06-07T12:00:00.000Z',
        gateId: 'review',
        stepId: 'review',
      },
      {
        type: 'command_received',
        runId,
        seq: 1,
        ts: '2026-06-07T12:00:01.000Z',
        gateId: 'review',
        commentId: 'gh-comment-42',
        actor: 'alice',
        decision: 'request_changes',
        feedback: 'tighten the copy',
      },
      {
        type: 'gate_decided',
        runId,
        seq: 2,
        ts: '2026-06-07T12:00:02.000Z',
        gateId: 'review',
        decision: 'request_changes',
        actor: 'alice',
        feedback: 'tighten the copy',
      },
    ];

    expect(log.map((e) => e.type)).toEqual([
      'gate_opened',
      'command_received',
      'gate_decided',
    ]);
  });

  it('models each Decision variant, including the gate moves', () => {
    const decisions: Decision[] = [
      { kind: 'run_step', stepId: 'greet' },
      { kind: 'open_gate', gateId: 'review', stepId: 'review' },
      {
        kind: 'decide_gate',
        gateId: 'review',
        decision: 'approve',
        actor: 'alice',
      },
      { kind: 'wait' },
      { kind: 'done' },
    ];

    expect(decisions.map((d) => d.kind)).toEqual([
      'run_step',
      'open_gate',
      'decide_gate',
      'wait',
      'done',
    ]);
  });

  it('models a review step and a rejected run via the gate vocabulary', () => {
    const state: RunState = {
      runId,
      workflowSlug: 'gated',
      status: 'rejected',
      inputs: {},
      steps: {
        review: {
          stepId: 'review',
          status: 'rejected',
          decision: 'reject',
        },
      },
      artifacts: [],
    };

    expect(state.status).toBe('rejected');
    expect(state.steps.review?.decision).toBe('reject');
  });

  it('models a derived RunState snapshot', () => {
    const state: RunState = {
      runId,
      workflowSlug: 'tiny-smoke',
      status: 'completed',
      inputs: { name: 'world' },
      steps: {
        greet: {
          stepId: 'greet',
          status: 'succeeded',
          command: 'echo "hello world"',
          artifacts: [artifact],
        },
      },
      artifacts: [artifact],
    };

    expect(state.status).toBe('completed');
    expect(state.steps.greet?.status).toBe('succeeded');
  });

  it('models an ArtifactIndexEntry', () => {
    expect(artifact.size).toBe(12);
    expect(artifact.sha256).toHaveLength(64);
  });

  it('carries an optional agent summary on step_succeeded, absent for scripts', () => {
    const scriptSucceeded: EngineEvent = {
      type: 'step_succeeded',
      runId,
      seq: 3,
      ts: '2026-06-07T12:00:02.000Z',
      stepId: 'greet',
      artifacts: [artifact],
    };
    const agentSucceeded: EngineEvent = {
      type: 'step_succeeded',
      runId,
      seq: 3,
      ts: '2026-06-07T12:00:02.000Z',
      stepId: 'draft',
      artifacts: [artifact],
      summary: 'Wrote the draft.',
    };

    // A script step's event omits the field entirely (not set to undefined).
    expect('summary' in scriptSucceeded).toBe(false);
    if (agentSucceeded.type === 'step_succeeded') {
      expect(agentSucceeded.summary).toBe('Wrote the draft.');
    }
  });

  it('carries an optional agent summary on step_failed, absent for scripts', () => {
    const scriptFailed: EngineEvent = {
      type: 'step_failed',
      runId,
      seq: 4,
      ts: '2026-06-07T12:00:03.000Z',
      stepId: 'greet',
      reason: 'exit code 1',
    };
    const agentFailed: EngineEvent = {
      type: 'step_failed',
      runId,
      seq: 4,
      ts: '2026-06-07T12:00:03.000Z',
      stepId: 'draft',
      reason: 'codex exited with code 3',
      summary: 'Got stuck on the second stanza.',
    };

    expect('summary' in scriptFailed).toBe(false);
    if (agentFailed.type === 'step_failed') {
      expect(agentFailed.summary).toBe('Got stuck on the second stanza.');
    }
  });
});

describe('foldRunState card_created handling', () => {
  const workflow: WorkflowDefinition = {
    slug: 'tiny-smoke',
    inputs: {},
    steps: [
      { id: 'greet', type: 'script', run: 'true', needs: [], produces: [] },
    ],
  };

  it('records the card ref into derived state, advancing no step lifecycle', () => {
    const log: EngineEvent[] = [
      {
        type: 'run_created',
        runId,
        seq: 0,
        ts: '2026-06-07T12:00:00.000Z',
        workflowSlug: 'tiny-smoke',
        inputs: {},
      },
      {
        type: 'card_created',
        runId,
        seq: 1,
        ts: '2026-06-07T12:00:00.500Z',
        cardId: '42',
        cardUrl: 'https://github.com/acme/widgets/issues/42',
        runIdMarker: runId,
        repo: 'acme/widgets',
      },
    ];

    const state = foldRunState(workflow, log);

    expect(state.card).toEqual({
      id: '42',
      url: 'https://github.com/acme/widgets/issues/42',
      repo: 'acme/widgets',
    });
    // The fold records the card but touches no step: greet stays pending.
    expect(state.steps.greet?.status).toBe('pending');
  });
});
