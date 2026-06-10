import { describe, expect, it } from 'vitest';
import type {
  ArtifactIndexEntry,
  Decision,
  EngineEvent,
} from '../domain/index.js';
import { loadWorkflow } from '../workflow/index.js';
import type { WorkflowDefinition } from '../workflow/index.js';
import { decide } from './decide.js';
import { foldRunState } from './fold.js';

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

/** One script step guarded by a review gate; the single-review-card fixture. */
const gated: WorkflowDefinition = loadWorkflow(`
slug: gated
steps:
  - id: build
    type: script
    run: 'echo build'
  - id: review
    type: gate
    needs: [build]
    allowed_decisions: [approve, request_changes, reject]
`);

/** A single agent step, proving agent steps dispatch like any non-gate step. */
const agentStep: WorkflowDefinition = loadWorkflow(`
slug: agentic
steps:
  - id: draft
    type: agent
    prompt: 'Write a haiku into {{artifacts.draft.path}}'
    produces:
      - id: draft
        path: artifacts/draft.md
`);

/** A gate that only permits approval, to exercise disallowed-verb rejection. */
const approveOnly: WorkflowDefinition = loadWorkflow(`
slug: approve-only
steps:
  - id: build
    type: script
    run: 'echo build'
  - id: review
    type: gate
    needs: [build]
    allowed_decisions: [approve]
`);

/** Build a `gate_opened` event for a review step (gateId === stepId here). */
function gateOpened(seq: number, stepId: string): EngineEvent {
  return {
    type: 'gate_opened',
    runId,
    seq,
    ts: '2026-06-07T12:00:03.000Z',
    gateId: stepId,
    stepId,
  };
}

/** Build a `command_received` event targeting a gate. */
function command(
  seq: number,
  gateId: string,
  decision: 'approve' | 'request_changes' | 'reject',
  extra: { actor?: string; commentId?: string; feedback?: string } = {},
): EngineEvent {
  return {
    type: 'command_received',
    runId,
    seq,
    ts: '2026-06-07T12:00:04.000Z',
    gateId,
    commentId: extra.commentId ?? `c-${seq}`,
    actor: extra.actor ?? 'reviewer',
    decision,
    ...(extra.feedback !== undefined && { feedback: extra.feedback }),
  };
}

/** Build a `gate_decided` event closing a gate. */
function gateDecided(
  seq: number,
  gateId: string,
  decision: 'approve' | 'request_changes' | 'reject',
  extra: { actor?: string; feedback?: string } = {},
): EngineEvent {
  return {
    type: 'gate_decided',
    runId,
    seq,
    ts: '2026-06-07T12:00:05.000Z',
    gateId,
    decision,
    actor: extra.actor ?? 'reviewer',
    ...(extra.feedback !== undefined && { feedback: extra.feedback }),
  };
}

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
    name: 'agent step: a freshly created run dispatches a pending agent step (non-gate)',
    // decide special-cases only gate steps; an agent step is dispatchable
    // exactly like a script step, with no orchestrator change.
    workflow: agentStep,
    events: [created(0)],
    expected: { kind: 'run_step', stepId: 'draft' },
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

  // ── Gate decisions ──────────────────────────────────────────────────────
  {
    name: 'gate: a review step whose needs succeeded opens its gate',
    workflow: gated,
    events: [created(0), dispatched(1, 'build'), succeeded(2, 'build')],
    expected: { kind: 'open_gate', gateId: 'review', stepId: 'review' },
  },
  {
    name: 'gate: an open gate with no command yet waits',
    workflow: gated,
    events: [
      created(0),
      dispatched(1, 'build'),
      succeeded(2, 'build'),
      gateOpened(3, 'review'),
    ],
    expected: { kind: 'wait' },
  },
  {
    name: 'gate happy path: a valid approve drives decide_gate',
    workflow: gated,
    events: [
      created(0),
      dispatched(1, 'build'),
      succeeded(2, 'build'),
      gateOpened(3, 'review'),
      command(4, 'review', 'approve', { actor: 'alice' }),
    ],
    expected: {
      kind: 'decide_gate',
      gateId: 'review',
      decision: 'approve',
      actor: 'alice',
    },
  },
  {
    name: 'gate request_changes: a valid command drives decide_gate with feedback',
    workflow: gated,
    events: [
      created(0),
      dispatched(1, 'build'),
      succeeded(2, 'build'),
      gateOpened(3, 'review'),
      command(4, 'review', 'request_changes', { feedback: 'fix the title' }),
    ],
    expected: {
      kind: 'decide_gate',
      gateId: 'review',
      decision: 'request_changes',
      actor: 'reviewer',
      feedback: 'fix the title',
    },
  },
  {
    name: 'gate reject: a valid reject drives decide_gate',
    workflow: gated,
    events: [
      created(0),
      dispatched(1, 'build'),
      succeeded(2, 'build'),
      gateOpened(3, 'review'),
      command(4, 'review', 'reject'),
    ],
    expected: {
      kind: 'decide_gate',
      gateId: 'review',
      decision: 'reject',
      actor: 'reviewer',
    },
  },
  {
    name: 'invalid command (wrong gate id): audit-only, gate keeps waiting',
    workflow: gated,
    events: [
      created(0),
      dispatched(1, 'build'),
      succeeded(2, 'build'),
      gateOpened(3, 'review'),
      command(4, 'not-this-gate', 'approve'),
    ],
    expected: { kind: 'wait' },
  },
  {
    name: 'invalid command (disallowed verb): audit-only, gate keeps waiting',
    workflow: approveOnly,
    events: [
      created(0),
      dispatched(1, 'build'),
      succeeded(2, 'build'),
      gateOpened(3, 'review'),
      command(4, 'review', 'request_changes'),
    ],
    expected: { kind: 'wait' },
  },
  {
    name: 'invalid command (closed/already-decided gate): no re-decide',
    workflow: gated,
    // The gate was already approved; a later command targets a closed gate and
    // is audit-only. The run has settled, so decide waits for finalization.
    events: [
      created(0),
      dispatched(1, 'build'),
      succeeded(2, 'build'),
      gateOpened(3, 'review'),
      gateDecided(4, 'review', 'approve'),
      command(5, 'review', 'reject'),
    ],
    expected: { kind: 'wait' },
  },
  {
    name: 'first-valid-wins: the first valid command at a gate drives the decision',
    workflow: approveOnly,
    // An invalid command (disallowed verb) precedes two valid ones; the first
    // VALID command (approve) wins, not the first command overall.
    events: [
      created(0),
      dispatched(1, 'build'),
      succeeded(2, 'build'),
      gateOpened(3, 'review'),
      command(4, 'review', 'request_changes'), // invalid here: not allowed
      command(5, 'review', 'approve', { actor: 'first-valid' }),
      command(6, 'review', 'approve', { actor: 'later' }),
    ],
    expected: {
      kind: 'decide_gate',
      gateId: 'review',
      decision: 'approve',
      actor: 'first-valid',
    },
  },
  {
    name: 'request_changes loop: after the gate decides, the work re-dispatches',
    workflow: gated,
    // request_changes loops `build` (and the gate) back to pending; decide
    // re-dispatches the guarded work, reusing the same gate afterward.
    events: [
      created(0),
      dispatched(1, 'build'),
      succeeded(2, 'build'),
      gateOpened(3, 'review'),
      gateDecided(4, 'review', 'request_changes', { feedback: 'again' }),
    ],
    expected: { kind: 'run_step', stepId: 'build' },
  },
  {
    name: 'a re-opened gate binds to the fresh command, not the spent request_changes',
    workflow: gated,
    // After request_changes loops the gate, the command that drove that round is
    // spent: it sits at/before the `gate_decided` that closed it. When the same
    // gate re-opens, a new approve must win — otherwise the stale
    // request_changes (seq 4) would replay forever and the run never settles.
    events: [
      created(0),
      dispatched(1, 'build'),
      succeeded(2, 'build'),
      gateOpened(3, 'review'),
      command(4, 'review', 'request_changes', { feedback: 'v2' }),
      gateDecided(5, 'review', 'request_changes', { feedback: 'v2' }),
      dispatched(6, 'build'),
      succeeded(7, 'build'),
      gateOpened(8, 'review'),
      command(9, 'review', 'approve'),
    ],
    expected: {
      kind: 'decide_gate',
      gateId: 'review',
      decision: 'approve',
      actor: 'reviewer',
    },
  },
  {
    name: 'a re-opened gate still waits when no fresh command has arrived',
    workflow: gated,
    // The earlier (spent) request_changes must not re-drive the re-opened gate;
    // with no new command yet, decide waits.
    events: [
      created(0),
      dispatched(1, 'build'),
      succeeded(2, 'build'),
      gateOpened(3, 'review'),
      command(4, 'review', 'request_changes', { feedback: 'v2' }),
      gateDecided(5, 'review', 'request_changes', { feedback: 'v2' }),
      dispatched(6, 'build'),
      succeeded(7, 'build'),
      gateOpened(8, 'review'),
    ],
    expected: { kind: 'wait' },
  },
  {
    name: 'reject is terminal: a rejected run is done',
    workflow: gated,
    events: [
      created(0),
      dispatched(1, 'build'),
      succeeded(2, 'build'),
      gateOpened(3, 'review'),
      gateDecided(4, 'review', 'reject'),
    ],
    expected: { kind: 'done' },
  },
  {
    name: 'approve settles the run: nothing left to dispatch, finalize',
    workflow: gated,
    events: [
      created(0),
      dispatched(1, 'build'),
      succeeded(2, 'build'),
      gateOpened(3, 'review'),
      gateDecided(4, 'review', 'approve'),
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

describe('foldRunState — gate lifecycle', () => {
  it('opens a gate: the review step becomes awaiting_review and openGate is set', () => {
    const state = foldRunState(gated, [
      created(0),
      dispatched(1, 'build'),
      succeeded(2, 'build'),
      gateOpened(3, 'review'),
    ]);

    expect(state.steps.review?.status).toBe('awaiting_review');
    expect(state.openGate).toEqual({ gateId: 'review', stepId: 'review' });
  });

  it('approve: the review step is approved and the gate closes', () => {
    const state = foldRunState(gated, [
      created(0),
      dispatched(1, 'build'),
      succeeded(2, 'build'),
      gateOpened(3, 'review'),
      gateDecided(4, 'review', 'approve', { actor: 'alice' }),
    ]);

    expect(state.steps.review?.status).toBe('approved');
    expect(state.steps.review?.decision).toBe('approve');
    expect(state.openGate).toBeUndefined();
  });

  it('request_changes loops the guarded work and the gate back to pending', () => {
    const state = foldRunState(gated, [
      created(0),
      dispatched(1, 'build'),
      succeeded(2, 'build'),
      gateOpened(3, 'review'),
      gateDecided(4, 'review', 'request_changes', { feedback: 'redo it' }),
    ]);

    // The work the gate guards re-runs, and the gate re-opens (one card/gate).
    expect(state.steps.build?.status).toBe('pending');
    expect(state.steps.review?.status).toBe('pending');
    // The decision + feedback are recorded on the (looped) gate step.
    expect(state.steps.review?.decision).toBe('request_changes');
    expect(state.steps.review?.feedback).toBe('redo it');
    expect(state.openGate).toBeUndefined();
  });

  it('reject folds the run toward a terminal rejected outcome', () => {
    const state = foldRunState(gated, [
      created(0),
      dispatched(1, 'build'),
      succeeded(2, 'build'),
      gateOpened(3, 'review'),
      gateDecided(4, 'review', 'reject'),
    ]);

    expect(state.status).toBe('rejected');
    expect(state.steps.review?.status).toBe('rejected');
  });

  it('an invalid command is audit-only: the open gate is unchanged', () => {
    const state = foldRunState(gated, [
      created(0),
      dispatched(1, 'build'),
      succeeded(2, 'build'),
      gateOpened(3, 'review'),
      command(4, 'wrong-gate', 'approve'),
    ]);

    // The command advanced no state: the gate is still open, awaiting review.
    expect(state.openGate).toEqual({ gateId: 'review', stepId: 'review' });
    expect(state.steps.review?.status).toBe('awaiting_review');
  });

  it('replays a full request_changes loop: re-run, re-open, approve, settle', () => {
    // build → gate → request_changes → build re-runs → gate re-opens → approve.
    const state = foldRunState(gated, [
      created(0),
      dispatched(1, 'build'),
      succeeded(2, 'build'),
      gateOpened(3, 'review'),
      gateDecided(4, 'review', 'request_changes', { feedback: 'v2' }),
      dispatched(5, 'build'),
      succeeded(6, 'build'),
      gateOpened(7, 'review'),
      gateDecided(8, 'review', 'approve'),
    ]);

    expect(state.steps.build?.status).toBe('succeeded');
    expect(state.steps.review?.status).toBe('approved');
    expect(state.openGate).toBeUndefined();
  });
});
