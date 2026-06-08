import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EngineEvent } from '../domain/index.js';
import { scriptExecutor } from '../executor/index.js';
import { JsonlEventLog, createRunDir, resolveRunDir } from '../run/index.js';
import { FakeTracker } from '../tracker/index.js';
import { loadWorkflow } from '../workflow/index.js';
import type { WorkflowDefinition } from '../workflow/index.js';
import { tick } from './tick.js';

/**
 * The harness integration test: it drives the real `tick` loop against a real
 * temp run dir and the real `scriptExecutor`, asserting on the resulting event
 * log. This is the side-effecting layer, so it exercises actual process
 * spawning and filesystem reads rather than mocks (mirrors `script.test.ts`).
 */

const runId = '20260607T120000Z-tiny-smoke-ab12';
/** Deterministic clock so appended `ts` stamps are stable across runs. */
const now = (): string => '2026-06-07T12:00:00.000Z';

describe('tick (full read→decide→resolve→execute→append loop)', () => {
  let runsRoot: string;

  beforeEach(async () => {
    runsRoot = await mkdtemp(join(tmpdir(), 'wm-tick-'));
  });

  afterEach(async () => {
    await rm(runsRoot, { recursive: true, force: true });
  });

  /**
   * Scaffold a run dir for `workflow`, then seed its event log with the given
   * events (a `run_created` plus any crash-mid-step priming). Returns the layout
   * and the log so a test can `tick` and then read the resulting events.
   */
  function seedRun(
    workflow: WorkflowDefinition,
    events: EngineEvent[],
  ): { runDir: string; log: JsonlEventLog } {
    const layout = resolveRunDir(runsRoot, runId);
    createRunDir(layout, workflow);
    const log = new JsonlEventLog(layout.eventsLogPath);
    for (const event of events) log.append(event);
    return { runDir: layout.runDir, log };
  }

  /** A `run_created` event seeding the log at seq 0. */
  function created(inputs: Record<string, unknown> = {}): EngineEvent {
    return {
      type: 'run_created',
      runId,
      seq: 0,
      ts: now(),
      workflowSlug: 'tiny-smoke',
      inputs,
    };
  }

  it('drives a gateless single step to run_completed and writes its artifact', async () => {
    const workflow = loadWorkflow(`
slug: tiny-smoke
steps:
  - id: greet
    type: script
    run: 'printf hi > {{artifacts.out.path}}'
    produces:
      - id: out
        path: artifacts/out.txt
`);
    const { runDir, log } = seedRun(workflow, [created()]);

    await tick({ workflow, log, executor: scriptExecutor, runDir, now });

    const events = log.read();
    expect(events.map((e) => e.type)).toEqual([
      'run_created',
      'step_dispatched',
      'step_succeeded',
      'run_completed',
    ]);

    const dispatched = events[1];
    expect(dispatched?.type).toBe('step_dispatched');
    if (dispatched?.type === 'step_dispatched') {
      expect(dispatched.command).toBe('printf hi > artifacts/out.txt');
      expect(dispatched.command).not.toMatch(/\{\{/);
    }

    const succeeded = events[2];
    expect(succeeded?.type).toBe('step_succeeded');
    if (succeeded?.type === 'step_succeeded') {
      expect(succeeded.artifacts).toHaveLength(1);
      const [artifact] = succeeded.artifacts;
      expect(artifact).toMatchObject({
        id: 'out',
        path: 'artifacts/out.txt',
      });
      expect(artifact?.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof artifact?.size).toBe('number');
    }

    // The artifact bytes exist on disk where the step declared them.
    expect(existsSync(join(runDir, 'artifacts/out.txt'))).toBe(true);
    expect(readFileSync(join(runDir, 'artifacts/out.txt'), 'utf8')).toBe('hi');
  });

  it('substitutes {{inputs.*}} and {{artifacts.*.path}} end to end', async () => {
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
    const { runDir, log } = seedRun(workflow, [created({ msg: 'hello run' })]);

    await tick({ workflow, log, executor: scriptExecutor, runDir, now });

    const events = log.read();
    const dispatched = events.find((e) => e.type === 'step_dispatched');
    expect(dispatched?.type).toBe('step_dispatched');
    if (dispatched?.type === 'step_dispatched') {
      expect(dispatched.command).toBe("printf 'hello run' > artifacts/out.txt");
    }
    expect(events.at(-1)?.type).toBe('run_completed');
    expect(readFileSync(join(runDir, 'artifacts/out.txt'), 'utf8')).toBe(
      'hello run',
    );
  });

  it('reaches run_failed when a step exits non-zero', async () => {
    const workflow = loadWorkflow(`
slug: tiny-smoke
steps:
  - id: boom
    type: script
    run: 'exit 3'
`);
    const { runDir, log } = seedRun(workflow, [created()]);

    await tick({ workflow, log, executor: scriptExecutor, runDir, now });

    const events = log.read();
    expect(events.map((e) => e.type)).toEqual([
      'run_created',
      'step_dispatched',
      'step_failed',
      'run_failed',
    ]);
    const failed = events.at(-1);
    expect(failed?.type).toBe('run_failed');
    if (failed?.type === 'run_failed') {
      expect(failed.reason).toContain('boom');
      expect(failed.reason).toMatch(/exited with code 3/);
    }
  });

  it('is a no-op when re-ticked after the run has completed', async () => {
    const workflow = loadWorkflow(`
slug: tiny-smoke
steps:
  - id: greet
    type: script
    run: 'printf hi > {{artifacts.out.path}}'
    produces:
      - id: out
        path: artifacts/out.txt
`);
    const { runDir, log } = seedRun(workflow, [created()]);

    await tick({ workflow, log, executor: scriptExecutor, runDir, now });
    const afterFirst = log.read();

    await tick({ workflow, log, executor: scriptExecutor, runDir, now });
    const afterSecond = log.read();

    // The second tick sees `done` immediately and appends nothing.
    expect(afterSecond).toEqual(afterFirst);
  });

  /**
   * A script step that writes an artifact, followed by a `gate` review step that
   * `needs` it — the minimal shape that exercises the gate branches.
   */
  const GATED_WORKFLOW = `
slug: tiny-smoke
steps:
  - id: greet
    type: script
    run: 'printf hi > {{artifacts.out.path}}'
    produces:
      - id: out
        path: artifacts/out.txt
  - id: review
    type: gate
    needs: [greet]
    allowed_decisions: [approve, request_changes, reject]
`;

  /** A `card_created` fact at the given seq, naming the run's tracker card. */
  function cardCreated(
    seq: number,
    card: { id: string; url: string },
    repo = 'acme/widgets',
  ): EngineEvent {
    return {
      type: 'card_created',
      runId,
      seq,
      ts: now(),
      cardId: card.id,
      cardUrl: card.url,
      runIdMarker: runId,
      repo,
    };
  }

  /** A `command_received` audit fact at the given seq. */
  function command(
    seq: number,
    fields: {
      gateId: string;
      commentId: string;
      decision: 'approve' | 'request_changes' | 'reject';
      actor?: string;
      feedback?: string;
    },
  ): EngineEvent {
    return {
      type: 'command_received',
      runId,
      seq,
      ts: now(),
      gateId: fields.gateId,
      commentId: fields.commentId,
      actor: fields.actor ?? 'reviewer',
      decision: fields.decision,
      ...(fields.feedback !== undefined && { feedback: fields.feedback }),
    };
  }

  it('runs the script step then stops at gate_opened, dispatching nothing downstream', async () => {
    const workflow = loadWorkflow(GATED_WORKFLOW);
    const { log, runDir } = seedRun(workflow, [created()]);

    await tick({ workflow, log, executor: scriptExecutor, runDir, now });

    const events = log.read();
    // The run dispatches the script step, then opens the gate and waits — no
    // terminal run event, because the gate is genuinely awaiting a command.
    expect(events.map((e) => e.type)).toEqual([
      'run_created',
      'step_dispatched',
      'step_succeeded',
      'gate_opened',
    ]);
    const opened = events.at(-1);
    expect(opened?.type).toBe('gate_opened');
    if (opened?.type === 'gate_opened') {
      expect(opened.gateId).toBe('review');
      expect(opened.stepId).toBe('review');
    }
  });

  it('folds an approve command through to run_completed', async () => {
    const workflow = loadWorkflow(GATED_WORKFLOW);
    const { log, runDir } = seedRun(workflow, [created()]);

    // First tick: run the step and open the gate.
    await tick({ workflow, log, executor: scriptExecutor, runDir, now });
    // A reviewer approves the open gate.
    log.append(
      command(log.read().length, {
        gateId: 'review',
        commentId: 'c1',
        decision: 'approve',
      }),
    );
    // Second tick: validate the command, decide the gate, finalize.
    await tick({ workflow, log, executor: scriptExecutor, runDir, now });

    const events = log.read();
    expect(events.map((e) => e.type)).toEqual([
      'run_created',
      'step_dispatched',
      'step_succeeded',
      'gate_opened',
      'command_received',
      'gate_decided',
      'run_completed',
    ]);
    const decided = events.find((e) => e.type === 'gate_decided');
    expect(decided?.type).toBe('gate_decided');
    if (decided?.type === 'gate_decided') {
      expect(decided.decision).toBe('approve');
      expect(decided.actor).toBe('reviewer');
    }
  });

  it('folds a reject command through to run_failed', async () => {
    const workflow = loadWorkflow(GATED_WORKFLOW);
    const { log, runDir } = seedRun(workflow, [created()]);

    await tick({ workflow, log, executor: scriptExecutor, runDir, now });
    log.append(
      command(log.read().length, {
        gateId: 'review',
        commentId: 'c1',
        decision: 'reject',
      }),
    );
    await tick({ workflow, log, executor: scriptExecutor, runDir, now });

    const events = log.read();
    expect(events.map((e) => e.type)).toEqual([
      'run_created',
      'step_dispatched',
      'step_succeeded',
      'gate_opened',
      'command_received',
      'gate_decided',
      'run_failed',
    ]);
    const failed = events.at(-1);
    expect(failed?.type).toBe('run_failed');
    if (failed?.type === 'run_failed') {
      expect(failed.reason).toMatch(/reject/i);
    }
  });

  it('is idempotent when re-ticked after a gate decision finalizes the run', async () => {
    const workflow = loadWorkflow(GATED_WORKFLOW);
    const { log, runDir } = seedRun(workflow, [created()]);

    await tick({ workflow, log, executor: scriptExecutor, runDir, now });
    log.append(
      command(log.read().length, {
        gateId: 'review',
        commentId: 'c1',
        decision: 'approve',
      }),
    );
    await tick({ workflow, log, executor: scriptExecutor, runDir, now });
    const afterDecision = log.read();

    // Re-ticking a finalized gated run sees `done` and appends nothing more.
    await tick({ workflow, log, executor: scriptExecutor, runDir, now });
    expect(log.read()).toEqual(afterDecision);
  });

  it('re-dispatches a step left dangling by a crash mid-step, then completes', async () => {
    const workflow = loadWorkflow(`
slug: tiny-smoke
steps:
  - id: greet
    type: script
    run: 'printf hi > {{artifacts.out.path}}'
    produces:
      - id: out
        path: artifacts/out.txt
`);
    // A dangling step_dispatched (no terminal event) is a crash mid-step.
    const { runDir, log } = seedRun(workflow, [
      created(),
      {
        type: 'step_dispatched',
        runId,
        seq: 1,
        ts: now(),
        stepId: 'greet',
        command: 'printf hi > artifacts/out.txt',
      },
    ]);

    await tick({ workflow, log, executor: scriptExecutor, runDir, now });

    const events = log.read();
    // The fold unwound the dangling dispatch to pending, so tick re-dispatched.
    expect(events.map((e) => e.type)).toEqual([
      'run_created',
      'step_dispatched',
      'step_dispatched',
      'step_succeeded',
      'run_completed',
    ]);
    expect(readFileSync(join(runDir, 'artifacts/out.txt'), 'utf8')).toBe('hi');
  });

  describe('review-card projection on gate_opened', () => {
    /**
     * Seed a gated run whose card already exists on the tracker, returning the
     * tracker, the card ref, and the run's log/dir. The `card_created` fact names
     * the same card the tracker minted, so the harness re-renders into it.
     */
    async function seedCardedRun(): Promise<{
      tracker: FakeTracker;
      cardId: string;
      log: JsonlEventLog;
      runDir: string;
    }> {
      const workflow = loadWorkflow(GATED_WORKFLOW);
      const tracker = new FakeTracker();
      const card = await tracker.createRunCard({ title: 'Run', body: 'seed' });
      const { log, runDir } = seedRun(workflow, [
        created(),
        cardCreated(1, card),
      ]);
      return { tracker, cardId: card.id, log, runDir };
    }

    const workflow = loadWorkflow(GATED_WORKFLOW);

    it('renders the review card into the run card on gate_opened', async () => {
      const { tracker, cardId, log, runDir } = await seedCardedRun();

      await tick({
        workflow,
        log,
        executor: scriptExecutor,
        runDir,
        now,
        tracker,
      });

      const stored = tracker.cardState(cardId);
      // The single review card was rendered once, into the run's existing card.
      expect(stored?.renderCount).toBe(1);
      expect(stored?.body).toContain('### Artifacts');
      expect(stored?.body).toContain('artifacts/out.txt');
      expect(stored?.body).toMatch(/sha256 `[0-9a-f]{64}`/);
      expect(stored?.body).toContain('### Allowed decisions');
      expect(stored?.body).toContain('`approve`');
      expect(stored?.body).toContain('`request_changes`');
    });

    it('renders into the run-recorded card ref, never minting a new card', async () => {
      const { tracker, cardId, log, runDir } = await seedCardedRun();

      await tick({
        workflow,
        log,
        executor: scriptExecutor,
        runDir,
        now,
        tracker,
      });

      // The harness rendered into the card the run recorded on `card_created`
      // (`card-1`), not a freshly minted one — the seam reuses the CardRef.
      expect(cardId).toBe('card-1');
      expect(tracker.cardState('card-2')).toBeUndefined();
      expect(tracker.cardState(cardId)?.renderCount).toBe(1);
    });

    it('re-renders the SAME card with the revision thread after a request_changes loop', async () => {
      const { tracker, cardId, log, runDir } = await seedCardedRun();

      // First tick: run the work, open the gate, render the card.
      await tick({
        workflow,
        log,
        executor: scriptExecutor,
        runDir,
        now,
        tracker,
      });
      const renderCountAfterOpen = tracker.cardState(cardId)?.renderCount;

      // A reviewer requests changes with feedback. The fold loops the work and
      // the gate back to pending and records the feedback on the gate's resting
      // state; the next tick re-runs the work and re-opens the SAME gate.
      log.append(
        command(log.read().length, {
          gateId: 'review',
          commentId: 'c1',
          decision: 'request_changes',
          feedback: 'please tighten the copy',
        }),
      );
      await tick({
        workflow,
        log,
        executor: scriptExecutor,
        runDir,
        now,
        tracker,
      });

      const stored = tracker.cardState(cardId);
      // Same card, rendered again (not a new one), now carrying the revision.
      expect(tracker.cardState('card-2')).toBeUndefined();
      expect(stored?.renderCount).toBeGreaterThan(renderCountAfterOpen ?? 0);
      expect(stored?.body).toContain('### Revision requested');
      expect(stored?.body).toContain('please tighten the copy');
    });

    it('opens the gate but renders nothing when the run has no card', async () => {
      // No `card_created` fact: a script-only style run with a gate but no card.
      const { log, runDir } = seedRun(workflow, [created()]);
      const tracker = new FakeTracker();

      await tick({
        workflow,
        log,
        executor: scriptExecutor,
        runDir,
        now,
        tracker,
      });

      // The gate still opened — the projection is a silent no-op without a card.
      expect(log.read().map((e) => e.type)).toContain('gate_opened');
    });
  });
});
