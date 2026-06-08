import { existsSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonlEventLog, resolveRunDir } from '../run/index.js';
import { FakeTracker } from '../tracker/index.js';
import { runCreate } from './run-create.js';

/**
 * Integration test for `run create`: it writes a real source workflow file to a
 * temp path, runs the create flow against a temp runs root, and asserts on the
 * scaffolded directory and the seeded event log. With injected clock and
 * randomness the minted run id is fully determined, so we assert it exactly.
 */

const now = (): string => '2026-06-07T12:00:00.000Z';
const rand = (): string => 'ab12';

const WORKFLOW_YAML = `
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
`;

const REPO = 'acme/widgets';

describe('runCreate', () => {
  let runsRoot: string;
  let workflowPath: string;
  let tracker: FakeTracker;

  beforeEach(async () => {
    runsRoot = await mkdtemp(join(tmpdir(), 'wm-create-'));
    workflowPath = join(runsRoot, 'workflow.yaml');
    writeFileSync(workflowPath, WORKFLOW_YAML, 'utf8');
    tracker = new FakeTracker();
  });

  afterEach(async () => {
    await rm(runsRoot, { recursive: true, force: true });
  });

  it('scaffolds the run dir and seeds run_created then card_created', async () => {
    const result = await runCreate({
      workflowPath,
      inputs: { msg: 'hi' },
      runId: undefined,
      runsRoot,
      now,
      rand,
      tracker,
      repo: REPO,
    });

    expect(result.runId).toBe('20260607T120000Z-tiny-smoke-ab12');

    const layout = resolveRunDir(runsRoot, result.runId);
    expect(result.runDir).toBe(layout.runDir);
    expect(existsSync(layout.eventsLogPath)).toBe(true);
    expect(existsSync(layout.workflowSnapshotPath)).toBe(true);

    const events = new JsonlEventLog(layout.eventsLogPath).read();
    expect(events.map((e) => e.type)).toEqual(['run_created', 'card_created']);

    const created = events[0];
    expect(created?.type).toBe('run_created');
    if (created?.type === 'run_created') {
      expect(created.runId).toBe('20260607T120000Z-tiny-smoke-ab12');
      expect(created.seq).toBe(0);
      expect(created.workflowSlug).toBe('tiny-smoke');
      expect(created.inputs).toEqual({ msg: 'hi' });
    }

    const carded = events[1];
    expect(carded?.type).toBe('card_created');
    if (carded?.type === 'card_created') {
      expect(carded.seq).toBe(1);
      expect(carded.cardId).toBe('card-1');
      expect(carded.cardUrl).toBe('fake://card/card-1');
      expect(carded.runIdMarker).toBe('20260607T120000Z-tiny-smoke-ab12');
      expect(carded.repo).toBe(REPO);
    }

    // The fake recorded the card with the run-id marker body and label.
    const card = tracker.cardState('card-1');
    expect(card?.body).toContain('20260607T120000Z-tiny-smoke-ab12');
    expect(card?.labels).toEqual(['workmachine']);
  });

  it('creates the runs root lazily when it does not yet exist', async () => {
    // On a fresh checkout `runs/` is gitignored and absent; create must make it.
    const freshRoot = join(runsRoot, 'nested', 'runs');
    expect(existsSync(freshRoot)).toBe(false);

    const result = await runCreate({
      workflowPath,
      inputs: {},
      runId: undefined,
      runsRoot: freshRoot,
      now,
      rand,
      tracker,
      repo: REPO,
    });

    expect(existsSync(result.runDir)).toBe(true);
  });

  it('refuses a --run-id override whose dir already exists', async () => {
    const override = 'fixed-run-id';
    await runCreate({
      workflowPath,
      inputs: {},
      runId: override,
      runsRoot,
      now,
      rand,
      tracker,
      repo: REPO,
    });

    await expect(
      runCreate({
        workflowPath,
        inputs: {},
        runId: override,
        runsRoot,
        now,
        rand,
        tracker,
        repo: REPO,
      }),
    ).rejects.toThrow(/already exists/);
  });
});
