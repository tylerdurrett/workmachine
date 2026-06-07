import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EngineEvent } from '../domain/index.js';
import { scriptExecutor } from '../executor/index.js';
import { JsonlEventLog, createRunDir, resolveRunDir } from '../run/index.js';
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
});
