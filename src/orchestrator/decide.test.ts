import { describe, expect, it } from 'vitest';
import type {
  ArtifactIndexEntry,
  Decision,
  EngineEvent,
} from '../domain/index.js';
import { loadWorkflow } from '../workflow/index.js';
import type { WorkflowDefinition } from '../workflow/index.js';
import { decide } from './decide.js';

const runId = '20260607T120000Z-tiny-smoke-ab12';

/** A representative produced-artifact index entry for success events. */
const artifact: ArtifactIndexEntry = {
  id: 'out',
  path: 'artifacts/out.txt',
  sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  size: 12,
};

/** Single-step gateless workflow: the happy-path/crash/fail fixtures use this. */
const oneStep: WorkflowDefinition = loadWorkflow(`
slug: tiny-smoke
steps:
  - id: greet
    type: script
    run: 'echo hi > {{artifacts.out.path}}'
    produces:
      - id: out
        path: artifacts/out.txt
`);

/** Two steps wired by an explicit dependency, to exercise needs-gating. */
const twoStep: WorkflowDefinition = loadWorkflow(`
slug: chained
steps:
  - id: first
    type: script
    run: 'echo a'
  - id: second
    type: script
    run: 'echo b'
    needs: [first]
`);

/** Build a `run_created` event seeding the log. */
function created(seq: number): EngineEvent {
  return {
    type: 'run_created',
    runId,
    seq,
    ts: '2026-06-07T12:00:00.000Z',
    workflowSlug: 'tiny-smoke',
    inputs: {},
  };
}

/** Build a `step_dispatched` event for a step. */
function dispatched(seq: number, stepId: string): EngineEvent {
  return {
    type: 'step_dispatched',
    runId,
    seq,
    ts: '2026-06-07T12:00:01.000Z',
    stepId,
    command: `echo ${stepId}`,
  };
}

/** Build a `step_succeeded` event for a step. */
function succeeded(
  seq: number,
  stepId: string,
  artifacts: ArtifactIndexEntry[] = [],
): EngineEvent {
  return {
    type: 'step_succeeded',
    runId,
    seq,
    ts: '2026-06-07T12:00:02.000Z',
    stepId,
    artifacts,
  };
}

interface DecideCase {
  /** What the sequence represents, used as the test name. */
  name: string;
  /** The workflow definition the run executes against. */
  workflow: WorkflowDefinition;
  /** The crafted event log to fold. */
  events: EngineEvent[];
  /** The decision `decide` must return for this log. */
  expected: Decision;
}

const cases: DecideCase[] = [
  {
    name: 'happy path: a freshly created run dispatches its first step',
    workflow: oneStep,
    events: [created(0)],
    expected: { kind: 'run_step', stepId: 'greet' },
  },
  {
    name: 'mid-run: decide advances to the next ready step once a dep succeeds',
    workflow: twoStep,
    // `first` succeeded, so its dependant `second` is now the next move — the
    // in-progress shape of a multi-step run.
    events: [created(0), dispatched(1, 'first'), succeeded(2, 'first')],
    expected: { kind: 'run_step', stepId: 'second' },
  },
  {
    name: 'completed: a run_completed log is a no-op (done)',
    workflow: oneStep,
    events: [
      created(0),
      dispatched(1, 'greet'),
      succeeded(2, 'greet', [artifact]),
      {
        type: 'run_completed',
        runId,
        seq: 3,
        ts: '2026-06-07T12:00:03.000Z',
        artifacts: [artifact],
      },
    ],
    expected: { kind: 'done' },
  },
  {
    name: 'crash mid-step: a dangling dispatch replays as re-runnable',
    workflow: oneStep,
    // A dispatch with no terminal step_succeeded/step_failed is a crash
    // mid-step. The fold unwinds it to pending, so decide re-dispatches the
    // step rather than waiting on it forever.
    events: [created(0), dispatched(1, 'greet')],
    expected: { kind: 'run_step', stepId: 'greet' },
  },
  {
    name: 'step_failed -> run_failed: a failed run is done',
    workflow: oneStep,
    events: [
      created(0),
      dispatched(1, 'greet'),
      {
        type: 'step_failed',
        runId,
        seq: 2,
        ts: '2026-06-07T12:00:02.000Z',
        stepId: 'greet',
        reason: 'exit code 1',
      },
      {
        type: 'run_failed',
        runId,
        seq: 3,
        ts: '2026-06-07T12:00:03.000Z',
        reason: 'step greet failed',
      },
    ],
    expected: { kind: 'done' },
  },
  {
    name: 'wait: every remaining step is blocked on a dependency that failed',
    workflow: twoStep,
    // `first` failed terminally but the run has not yet been marked run_failed;
    // `second` needs `first`, so nothing is runnable. decide waits rather than
    // dispatching a step whose dependency cannot have succeeded.
    events: [
      created(0),
      dispatched(1, 'first'),
      {
        type: 'step_failed',
        runId,
        seq: 2,
        ts: '2026-06-07T12:00:02.000Z',
        stepId: 'first',
        reason: 'exit code 1',
      },
    ],
    expected: { kind: 'wait' },
  },
];

describe('decide (pure event-log fold)', () => {
  it.each(cases)('$name', ({ workflow, events, expected }) => {
    expect(decide(workflow, events)).toEqual(expected);
  });

  it('is a pure function: same inputs yield the same decision, no mutation', () => {
    const events: EngineEvent[] = [created(0)];
    const before = structuredClone(events);

    const first = decide(oneStep, events);
    const second = decide(oneStep, events);

    expect(first).toEqual(second);
    // The log argument is never mutated by the fold.
    expect(events).toEqual(before);
  });
});
