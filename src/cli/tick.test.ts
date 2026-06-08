import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonlEventLog, resolveRunDir } from '../run/index.js';
import { FakeTracker } from '../tracker/index.js';
import { runCreate } from './run-create.js';
import { runTick } from './tick.js';

/**
 * Integration test for `tick`: it creates a real run via `runCreate`, then
 * drives it to completion through `runTick` against the real `scriptExecutor`,
 * asserting on the event sequence, the produced artifact, and idempotency.
 */

const now = (): string => '2026-06-07T12:00:00.000Z';
const rand = (): string => 'ab12';

const WORKFLOW_YAML = `
slug: tiny-smoke
steps:
  - id: greet
    type: script
    run: 'printf hi > {{artifacts.out.path}}'
    produces:
      - id: out
        path: artifacts/out.txt
`;

describe('runTick', () => {
  let runsRoot: string;
  let workflowPath: string;

  beforeEach(async () => {
    runsRoot = await mkdtemp(join(tmpdir(), 'wm-tick-cli-'));
    workflowPath = join(runsRoot, 'workflow.yaml');
    writeFileSync(workflowPath, WORKFLOW_YAML, 'utf8');
  });

  afterEach(async () => {
    await rm(runsRoot, { recursive: true, force: true });
  });

  it('drives a created run to completion and is idempotent', async () => {
    const { runId, runDir } = await runCreate({
      workflowPath,
      inputs: {},
      runId: undefined,
      runsRoot,
      now,
      rand,
      tracker: new FakeTracker(),
      repo: 'acme/widgets',
    });

    await runTick({ runId, runsRoot, now });

    const layout = resolveRunDir(runsRoot, runId);
    const log = new JsonlEventLog(layout.eventsLogPath);
    const events = log.read();
    expect(events.map((e) => e.type)).toEqual([
      'run_created',
      'card_created',
      'step_dispatched',
      'step_succeeded',
      'run_completed',
    ]);
    expect(existsSync(join(runDir, 'artifacts/out.txt'))).toBe(true);
    expect(readFileSync(join(runDir, 'artifacts/out.txt'), 'utf8')).toBe('hi');

    // Re-ticking a completed run appends nothing.
    await runTick({ runId, runsRoot, now });
    expect(log.read()).toHaveLength(events.length);
  });

  it('throws on a nonexistent run id', async () => {
    await expect(
      runTick({ runId: 'no-such-run', runsRoot, now }),
    ).rejects.toThrow(/no such run/);
  });
});
