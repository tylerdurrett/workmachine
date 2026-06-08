import { existsSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { foldRunState } from '../orchestrator/index.js';
import { JsonlEventLog, resolveRunDir } from '../run/index.js';
import { FakeTracker } from '../tracker/index.js';
import { loadWorkflowFile } from '../workflow/index.js';
import type { CliDeps } from './main.js';
import { main } from './main.js';

/**
 * The CLI-level acceptance test (issue #12, criterion 4): drive the real `main`
 * dispatcher with injected deps — a temp runs root, a deterministic clock and
 * randomness, and a capturing log. Because clock and randomness are fixed, the
 * minted run id is fully determined, so we can compute it and pass it to `tick`.
 */

const now = (): string => '2026-06-07T12:00:00.000Z';
const rand = (): string => 'ab12';
const RUN_ID = '20260607T120000Z-tiny-smoke-ab12';
const SANDBOX_REPO = 'acme/widgets';

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

describe('main (CLI dispatch)', () => {
  let runsRoot: string;
  let workflowPath: string;
  let lines: string[];

  /** Deps wiring the CLI to a temp runs root, fixed clock/rand, capturing log. */
  function deps(): Partial<CliDeps> {
    return {
      runsRoot,
      now,
      rand,
      mintCommentId: () => 'comment-1',
      makeTracker: () => new FakeTracker(),
      log: (line) => lines.push(line),
    };
  }

  beforeEach(async () => {
    runsRoot = await mkdtemp(join(tmpdir(), 'wm-cli-'));
    workflowPath = join(runsRoot, 'workflow.yaml');
    writeFileSync(workflowPath, WORKFLOW_YAML, 'utf8');
    lines = [];
    process.env.WORKMACHINE_SANDBOX_REPO = SANDBOX_REPO;
  });

  afterEach(async () => {
    delete process.env.WORKMACHINE_SANDBOX_REPO;
    await rm(runsRoot, { recursive: true, force: true });
  });

  it('run create then tick produces the expected run dir and events', async () => {
    await main(['run', 'create', workflowPath, '--input', 'msg=hi'], deps());
    await main(['tick', RUN_ID], deps());

    const layout = resolveRunDir(runsRoot, RUN_ID);
    expect(existsSync(layout.runDir)).toBe(true);
    expect(existsSync(layout.eventsLogPath)).toBe(true);
    expect(existsSync(layout.workflowSnapshotPath)).toBe(true);

    const events = new JsonlEventLog(layout.eventsLogPath).read();
    expect(events.map((e) => e.type)).toEqual([
      'run_created',
      'card_created',
      'step_dispatched',
      'step_succeeded',
      'run_completed',
    ]);
    const created = events[0];
    expect(created?.type).toBe('run_created');
    if (created?.type === 'run_created') {
      expect(created.inputs).toEqual({ msg: 'hi' });
    }
  });

  it('opens the card via --repo and records card_created with that repo', async () => {
    const tracker = new FakeTracker();
    await main(['run', 'create', workflowPath, '--repo', 'acme/override'], {
      ...deps(),
      makeTracker: () => tracker,
    });

    const events = new JsonlEventLog(
      resolveRunDir(runsRoot, RUN_ID).eventsLogPath,
    ).read();
    const carded = events.find((e) => e.type === 'card_created');
    expect(carded?.type).toBe('card_created');
    if (carded?.type === 'card_created') {
      // The operator's --repo wins over the WORKMACHINE_SANDBOX_REPO fallback.
      expect(carded.repo).toBe('acme/override');
      expect(carded.runIdMarker).toBe(RUN_ID);
    }

    // The fake recorded the card with the workmachine label and run-id body.
    const card = tracker.cardState('card-1');
    expect(card?.labels).toEqual(['workmachine']);
    expect(card?.body).toContain(RUN_ID);
  });

  it('refuses a --run-id collision', async () => {
    const id = 'fixed-id';
    await main(['run', 'create', workflowPath, '--run-id', id], deps());
    await expect(
      main(['run', 'create', workflowPath, '--run-id', id], deps()),
    ).rejects.toThrow(/already exists/);
  });

  it('throws on an unknown command', async () => {
    await expect(main(['bogus'], deps())).rejects.toThrow(/usage/);
  });

  it('refuses run create when no repo is given and no env fallback is set', async () => {
    delete process.env.WORKMACHINE_SANDBOX_REPO;
    await expect(main(['run', 'create', workflowPath], deps())).rejects.toThrow(
      /no target repo/,
    );
  });

  it('rejects a command with a disallowed decision verb', async () => {
    await expect(main(['command', RUN_ID, 'merge'], deps())).rejects.toThrow(
      /usage/,
    );
  });
});

const GATED_WORKFLOW_YAML = `
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

describe('main command dispatch (manual gate command)', () => {
  let runsRoot: string;
  let workflowPath: string;
  let lines: string[];

  function deps(): Partial<CliDeps> {
    return {
      runsRoot,
      now,
      rand,
      mintCommentId: () => 'comment-1',
      makeTracker: () => new FakeTracker(),
      log: (line) => lines.push(line),
    };
  }

  beforeEach(async () => {
    runsRoot = await mkdtemp(join(tmpdir(), 'wm-cli-cmd-'));
    workflowPath = join(runsRoot, 'workflow.yaml');
    writeFileSync(workflowPath, GATED_WORKFLOW_YAML, 'utf8');
    lines = [];
    process.env.WORKMACHINE_SANDBOX_REPO = SANDBOX_REPO;
  });

  afterEach(async () => {
    delete process.env.WORKMACHINE_SANDBOX_REPO;
    await rm(runsRoot, { recursive: true, force: true });
  });

  it('records a command stamped with the open gate id after a tick stops at the gate', async () => {
    await main(['run', 'create', workflowPath], deps());
    await main(['tick', RUN_ID], deps());
    await main(['command', RUN_ID, 'approve'], deps());

    const events = new JsonlEventLog(
      resolveRunDir(runsRoot, RUN_ID).eventsLogPath,
    ).read();
    const command = events.at(-1);
    expect(command?.type).toBe('command_received');
    if (command?.type === 'command_received') {
      expect(command.gateId).toBe('review');
      expect(command.commentId).toBe('comment-1');
      expect(command.decision).toBe('approve');
    }
  });

  it('records but does not advance a command targeting a closed gate', async () => {
    await main(['run', 'create', workflowPath], deps());
    // No tick yet: the gate has not opened, so this command targets no gate.
    await main(['command', RUN_ID, 'approve'], deps());

    const layout = resolveRunDir(runsRoot, RUN_ID);
    const log = new JsonlEventLog(layout.eventsLogPath);
    const command = log.read().at(-1);
    expect(command?.type).toBe('command_received');
    if (command?.type === 'command_received') {
      expect(command.gateId).toBe('');
    }

    // The next tick runs the script step and opens the gate, but the earlier
    // command (empty gate id) does not match it, so no gate_decided is appended.
    await main(['tick', RUN_ID], deps());
    const types = log.read().map((e) => e.type);
    expect(types).toContain('gate_opened');
    expect(types).not.toContain('gate_decided');
    const workflow = loadWorkflowFile(layout.workflowSnapshotPath);
    expect(foldRunState(workflow, log.read()).openGate?.gateId).toBe('review');
  });
});
