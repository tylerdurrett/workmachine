import { describe, expect, it } from 'vitest';
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
        type: 'step_dispatched',
        runId,
        seq: 1,
        ts: '2026-06-07T12:00:01.000Z',
        stepId: 'greet',
        command: 'echo "hello world"',
      },
      {
        type: 'step_succeeded',
        runId,
        seq: 2,
        ts: '2026-06-07T12:00:02.000Z',
        stepId: 'greet',
        artifacts: [artifact],
      },
      {
        type: 'step_failed',
        runId,
        seq: 3,
        ts: '2026-06-07T12:00:03.000Z',
        stepId: 'flaky',
        reason: 'exit code 1',
      },
      {
        type: 'run_completed',
        runId,
        seq: 4,
        ts: '2026-06-07T12:00:04.000Z',
        artifacts: [artifact],
      },
      {
        type: 'run_failed',
        runId,
        seq: 5,
        ts: '2026-06-07T12:00:05.000Z',
        reason: 'step flaky failed',
      },
    ];

    expect(log).toHaveLength(6);
    expect(log.map((e) => e.type)).toEqual([
      'run_created',
      'step_dispatched',
      'step_succeeded',
      'step_failed',
      'run_completed',
      'run_failed',
    ]);
  });

  it('models each Decision variant', () => {
    const decisions: Decision[] = [
      { kind: 'run_step', stepId: 'greet' },
      { kind: 'wait' },
      { kind: 'done' },
    ];

    expect(decisions.map((d) => d.kind)).toEqual(['run_step', 'wait', 'done']);
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
});
