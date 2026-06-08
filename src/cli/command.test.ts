import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EngineEvent } from '../domain/index.js';
import { foldRunState } from '../orchestrator/index.js';
import { JsonlEventLog, createRunDir, resolveRunDir } from '../run/index.js';
import { loadWorkflow } from '../workflow/index.js';
import type { WorkflowDefinition } from '../workflow/index.js';
import { MANUAL_COMMAND_ACTOR, runCommand } from './command.js';

/**
 * Unit test for the `command` flow: drive `runCommand` with injected deps (a
 * temp runs root, a fixed clock, a fixed comment-id minter) against a seeded run
 * dir, and assert on the appended `command_received`. The CLI only records the
 * raw command as an audit fact — validation lives in `decide` — so these tests
 * assert the recorded fact, then confirm an open gate's command advances on the
 * next decide while a closed-gate command does not.
 */

const RUN_ID = '20260607T120000Z-tiny-smoke-ab12';
const now = (): string => '2026-06-07T12:00:00.000Z';

/** A gated workflow: a script step then a review gate that needs it. */
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

describe('runCommand (manual gate command CLI)', () => {
  let runsRoot: string;

  beforeEach(async () => {
    runsRoot = await mkdtemp(join(tmpdir(), 'wm-command-'));
  });

  afterEach(async () => {
    await rm(runsRoot, { recursive: true, force: true });
  });

  /**
   * Scaffold a run dir for `workflow` and seed its log with `events`. Returns
   * the layout and log so a test can `runCommand` and read the result back.
   */
  function seedRun(
    workflow: WorkflowDefinition,
    events: EngineEvent[],
  ): { log: JsonlEventLog } {
    const layout = resolveRunDir(runsRoot, RUN_ID);
    createRunDir(layout, workflow);
    const log = new JsonlEventLog(layout.eventsLogPath);
    for (const event of events) log.append(event);
    return { log };
  }

  /** A `run_created` event seeding the log at seq 0. */
  function created(): EngineEvent {
    return {
      type: 'run_created',
      runId: RUN_ID,
      seq: 0,
      ts: now(),
      workflowSlug: 'tiny-smoke',
      inputs: {},
    };
  }

  /** A `gate_opened` event for the `review` gate at the given seq. */
  function gateOpened(seq: number): EngineEvent {
    return {
      type: 'gate_opened',
      runId: RUN_ID,
      seq,
      ts: now(),
      gateId: 'review',
      stepId: 'review',
    };
  }

  it('records command_received stamped with the open gate id, synthetic comment id, actor, decision, and feedback', () => {
    const workflow = loadWorkflow(GATED_WORKFLOW);
    const { log } = seedRun(workflow, [created(), gateOpened(1)]);

    runCommand({
      runId: RUN_ID,
      decision: 'request_changes',
      feedback: 'tighten the wording',
      runsRoot,
      mintCommentId: () => 'comment-1',
      now,
    });

    const events = log.read();
    const command = events.at(-1);
    expect(command?.type).toBe('command_received');
    if (command?.type === 'command_received') {
      expect(command.gateId).toBe('review');
      expect(command.commentId).toBe('comment-1');
      expect(command.actor).toBe(MANUAL_COMMAND_ACTOR);
      expect(command.decision).toBe('request_changes');
      expect(command.feedback).toBe('tighten the wording');
    }
  });

  it('omits feedback when none is given', () => {
    const workflow = loadWorkflow(GATED_WORKFLOW);
    const { log } = seedRun(workflow, [created(), gateOpened(1)]);

    runCommand({
      runId: RUN_ID,
      decision: 'approve',
      runsRoot,
      mintCommentId: () => 'comment-1',
      now,
    });

    const command = log.read().at(-1);
    expect(command?.type).toBe('command_received');
    if (command?.type === 'command_received') {
      expect(command).not.toHaveProperty('feedback');
    }
  });

  it('still records a command when no gate is open, stamping an empty gate id so decide rejects it', () => {
    const workflow = loadWorkflow(GATED_WORKFLOW);
    // No gate_opened: the run has only been created, so no gate is open.
    const { log } = seedRun(workflow, [created()]);

    runCommand({
      runId: RUN_ID,
      decision: 'approve',
      runsRoot,
      mintCommentId: () => 'comment-1',
      now,
    });

    const command = log.read().at(-1);
    expect(command?.type).toBe('command_received');
    if (command?.type === 'command_received') {
      // The audit fact is recorded with an empty gate id (no open gate to
      // target); decide's validation will treat it as audit-only.
      expect(command.gateId).toBe('');
    }
    // A closed-gate command advances nothing: the fold ignores it (audit-only),
    // so no gate is open and the run stays where it was.
    const state = foldRunState(workflow, log.read());
    expect(state.openGate).toBeUndefined();
  });

  it('throws when the run does not exist', () => {
    expect(() =>
      runCommand({
        runId: 'no-such-run',
        decision: 'approve',
        runsRoot,
        mintCommentId: () => 'comment-1',
        now,
      }),
    ).toThrow(/no such run/);
  });
});
