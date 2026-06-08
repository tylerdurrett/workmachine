import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CliDeps } from './cli/index.js';
import { main } from './cli/index.js';
import { foldRunState } from './orchestrator/index.js';
import { JsonlEventLog, foldRun, resolveRunDir } from './run/index.js';
import { FakeTracker } from './tracker/index.js';
import { loadWorkflowFile } from './workflow/index.js';

/**
 * The slice's integration smoke (issue #13): the one test that drives the *real*
 * CLI front door against the *real* committed `workflows/tiny-smoke/` package,
 * proving the whole gateless engine spine end to end — `run create` -> `tick` ->
 * `run_completed` — with a verifiable artifact and the event log folded to
 * `completed`.
 *
 * Everything else in the suite exercises one layer in isolation (the resolver,
 * the executor, the harness loop, the CLI dispatcher) against inline fixture
 * YAML. This test is deliberately different: it resolves the actual committed
 * package files from the repo so a broken `workflow.yaml` or `greet.sh` fails
 * here, and it uses no mock executor — it spawns the real shell. Its job is the
 * gateless demoable outcome from the acceptance criteria: a run with its final
 * artifact on disk and `run.yaml` folded to `completed`.
 *
 * The committed package lives at the repo root (`workflows/tiny-smoke/`); this
 * test file is `src/integration.smoke.test.ts`, so the repo root is one level up
 * from `src/`. We resolve the package paths relative to this file rather than
 * cwd so the test is location-independent. The run instance is written to a temp
 * `runsRoot`, never the repo's gitignored `runs/`, and is torn down afterward.
 *
 * Clock and randomness are injected and fixed, so the minted run id is fully
 * determined (`mintRunId`: timestamp compacted to basic ISO-8601, then slug,
 * then the rand suffix) — we assert it exactly.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = resolve(
  repoRoot,
  'workflows',
  'tiny-smoke',
  'workflow.yaml',
);
const scriptPath = resolve(repoRoot, 'workflows', 'tiny-smoke', 'greet.sh');

const now = (): string => '2026-06-07T12:00:00.000Z';
const rand = (): string => 'ab12';
const RUN_ID = '20260607T120000Z-tiny-smoke-ab12';

const GREETING = 'Hello, World!\n';

describe('integration smoke: gateless spine (create -> tick -> completed)', () => {
  let runsRoot: string;
  let lines: string[];

  /** Deps wiring the CLI to a temp runs root, fixed clock/rand, capturing log. */
  function deps(): Partial<CliDeps> {
    return {
      runsRoot,
      now,
      rand,
      makeTracker: () => new FakeTracker(),
      log: (line) => lines.push(line),
    };
  }

  beforeEach(async () => {
    runsRoot = await mkdtemp(join(tmpdir(), 'wm-smoke-'));
    lines = [];
    process.env.WORKMACHINE_SANDBOX_REPO = 'acme/widgets';
  });

  afterEach(async () => {
    delete process.env.WORKMACHINE_SANDBOX_REPO;
    await rm(runsRoot, { recursive: true, force: true });
  });

  it('runs the committed tiny-smoke package end to end', async () => {
    // Drive the real flow: create against the committed package, then tick once.
    await main(
      [
        'run',
        'create',
        workflowPath,
        '--input',
        'name=World',
        '--input',
        `scriptPath=${scriptPath}`,
      ],
      deps(),
    );
    await main(['tick', RUN_ID], deps());

    // The run instance was scaffolded with its canonical files.
    const layout = resolveRunDir(runsRoot, RUN_ID);
    const events = new JsonlEventLog(layout.eventsLogPath).read();

    // The full gateless spine, in order. `card_created` follows `run_created`:
    // intake opens the run's card before the first tick dispatches a step.
    expect(events.map((e) => e.type)).toEqual([
      'run_created',
      'card_created',
      'step_dispatched',
      'step_succeeded',
      'run_completed',
    ]);

    // The dispatched command is fully resolved — no tokens, real artifact path.
    const dispatched = events[2];
    expect(dispatched?.type).toBe('step_dispatched');
    if (dispatched?.type === 'step_dispatched') {
      expect(dispatched.command).not.toMatch(/\{\{/);
      expect(dispatched.command).toContain('artifacts/greeting.txt');
    }

    // The step recorded exactly one artifact with a real hash and size.
    const succeeded = events[3];
    expect(succeeded?.type).toBe('step_succeeded');
    if (succeeded?.type === 'step_succeeded') {
      expect(succeeded.artifacts).toHaveLength(1);
      const [artifact] = succeeded.artifacts;
      expect(artifact).toMatchObject({
        id: 'greeting',
        path: 'artifacts/greeting.txt',
      });
      expect(artifact?.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof artifact?.size).toBe('number');
      expect(artifact?.size).toBeGreaterThan(0);
    }

    // The artifact bytes the committed greet.sh wrote are on disk, verbatim.
    expect(
      readFileSync(join(layout.runDir, 'artifacts/greeting.txt'), 'utf8'),
    ).toBe(GREETING);

    // The terminal run event carries the same final artifact.
    const completed = events.at(-1);
    expect(completed?.type).toBe('run_completed');
    if (completed?.type === 'run_completed') {
      expect(completed.artifacts).toHaveLength(1);
      expect(completed.artifacts[0]).toMatchObject({
        id: 'greeting',
        path: 'artifacts/greeting.txt',
      });
    }

    // The gateless demoable outcome: run.yaml folded to `completed`, carrying
    // the final artifact. Asserting the file content (not just an in-memory
    // fold) proves the completed state is observable on disk per AC#3 — and the
    // independent fold confirms the cache matches a replay of the log.
    const cache = parseYaml(readFileSync(layout.runCachePath, 'utf8')) as {
      status: string;
      artifacts: { id: string; path: string }[];
    };
    expect(cache.status).toBe('completed');
    expect(cache.artifacts).toContainEqual(
      expect.objectContaining({
        id: 'greeting',
        path: 'artifacts/greeting.txt',
      }),
    );
    expect(foldRun(events).status).toBe('completed');
  });
});

const gatedWorkflowPath = resolve(
  repoRoot,
  'workflows',
  'tiny-smoke-gated',
  'workflow.yaml',
);
const gatedScriptPath = resolve(
  repoRoot,
  'workflows',
  'tiny-smoke-gated',
  'greet.sh',
);
const GATED_RUN_ID = '20260607T120000Z-tiny-smoke-gated-ab12';

/**
 * The gated companion to the gateless smoke: it drives the *real* CLI against
 * the committed `workflows/tiny-smoke-gated/` package through the whole manual
 * gate loop. The pure gate core (#23) and the impure half (this task) only earn
 * their keep when the committed fixture, the harness, and the command CLI move a
 * run end to end — `create -> tick` (stop at the gate) -> `command <decision>`
 * -> `tick` (advance) — so this is the one test that exercises that spine with
 * the real shell and no mocks.
 *
 * Reviewer identity is recorded, not enforced, this slice; feedback tokens are
 * out of scope (`{{feedback.*}}` lands later), so the fixture carries none.
 */
describe('integration smoke: gated loop (create -> tick -> command -> tick)', () => {
  let runsRoot: string;
  let lines: string[];
  let tracker: FakeTracker;

  // One tracker shared across create + tick (production hits the same repo): the
  // card opened at create is the card the gate-open tick re-renders into.
  function deps(): Partial<CliDeps> {
    return {
      runsRoot,
      now,
      rand,
      mintCommentId: () => 'comment-1',
      makeTracker: () => tracker,
      log: (line) => lines.push(line),
    };
  }

  /** The run's event log handle. */
  function logFor(): JsonlEventLog {
    return new JsonlEventLog(
      resolveRunDir(runsRoot, GATED_RUN_ID).eventsLogPath,
    );
  }

  /** Create the gated run against the committed package. */
  async function create(): Promise<void> {
    await main(
      [
        'run',
        'create',
        gatedWorkflowPath,
        '--input',
        'name=World',
        '--input',
        `scriptPath=${gatedScriptPath}`,
      ],
      deps(),
    );
  }

  /** Create the gated run, then tick once so it runs greet and opens the gate. */
  async function createAndOpenGate(): Promise<JsonlEventLog> {
    await create();
    await main(['tick', GATED_RUN_ID], deps());
    return logFor();
  }

  /** The pinned snapshot, for gate-aware fold assertions on the run state. */
  function snapshot() {
    return loadWorkflowFile(
      resolveRunDir(runsRoot, GATED_RUN_ID).workflowSnapshotPath,
    );
  }

  beforeEach(async () => {
    runsRoot = await mkdtemp(join(tmpdir(), 'wm-smoke-gated-'));
    lines = [];
    tracker = new FakeTracker();
    process.env.WORKMACHINE_SANDBOX_REPO = 'acme/widgets';
  });

  afterEach(async () => {
    delete process.env.WORKMACHINE_SANDBOX_REPO;
    await rm(runsRoot, { recursive: true, force: true });
  });

  it('stops at gate_opened after the first tick, with nothing dispatched downstream', async () => {
    const log = await createAndOpenGate();
    const events = log.read();

    // The script step ran, the gate opened, and the run stopped waiting — no
    // terminal run event, no decision, because no command has arrived yet.
    expect(events.map((e) => e.type)).toEqual([
      'run_created',
      'card_created',
      'step_dispatched',
      'step_succeeded',
      'gate_opened',
    ]);
    const state = foldRunState(snapshot(), events);
    expect(state.openGate).toEqual({ gateId: 'review', stepId: 'review' });
    expect(state.status).toBe('running');
    // The artifact the script wrote is on disk before any review.
    expect(
      readFileSync(
        join(
          resolveRunDir(runsRoot, GATED_RUN_ID).runDir,
          'artifacts/greeting.txt',
        ),
        'utf8',
      ),
    ).toBe(GREETING);
  });

  it('approve -> tick reaches run_completed', async () => {
    const log = await createAndOpenGate();
    await main(['command', GATED_RUN_ID, 'approve'], deps());
    await main(['tick', GATED_RUN_ID], deps());

    const events = log.read();
    expect(events.map((e) => e.type)).toEqual([
      'run_created',
      'card_created',
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
    }
    const state = foldRunState(snapshot(), events);
    expect(state.status).toBe('completed');
    expect(state.steps.review?.status).toBe('approved');

    // Re-ticking a completed gated run is a no-op.
    await main(['tick', GATED_RUN_ID], deps());
    expect(log.read()).toEqual(events);
  });

  it('reject -> tick reaches run_failed / rejected', async () => {
    const log = await createAndOpenGate();
    await main(['command', GATED_RUN_ID, 'reject', 'not good enough'], deps());
    await main(['tick', GATED_RUN_ID], deps());

    const events = log.read();
    expect(events.map((e) => e.type)).toEqual([
      'run_created',
      'card_created',
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
    // The terminal `run_failed` folds the run status to `failed`; the rejected
    // verdict is preserved on the gate step itself (and on its recorded
    // decision), so reject is observable end to end.
    const state = foldRunState(snapshot(), events);
    expect(state.status).toBe('failed');
    expect(state.steps.review?.status).toBe('rejected');
    expect(state.steps.review?.decision).toBe('reject');

    // Re-ticking a rejected run appends nothing more.
    await main(['tick', GATED_RUN_ID], deps());
    expect(log.read()).toEqual(events);
  });

  it('records a closed-gate command but does not advance the run', async () => {
    // Issue a command BEFORE any tick, while no gate is open: the CLI stamps an
    // empty gate id, so the command is recorded as an audit fact but can never
    // match the gate that opens later — decide leaves it audit-only.
    await create();
    await main(['command', GATED_RUN_ID, 'approve'], deps());

    const log = logFor();
    const closed = log.read().at(-1);
    expect(closed?.type).toBe('command_received');
    if (closed?.type === 'command_received') {
      expect(closed.gateId).toBe('');
    }

    // Tick: greet runs and the gate opens, but the stale command (empty gate
    // id) does not match it, so no gate_decided is appended and the run stops at
    // the open gate rather than advancing.
    await main(['tick', GATED_RUN_ID], deps());
    const events = log.read();
    const types = events.map((e) => e.type);
    expect(types).toContain('gate_opened');
    expect(types).not.toContain('gate_decided');
    expect(types).not.toContain('run_completed');
    expect(types).not.toContain('run_failed');

    const state = foldRunState(snapshot(), events);
    expect(state.openGate).toEqual({ gateId: 'review', stepId: 'review' });
    expect(state.status).toBe('running');

    // Re-ticking does not advance either: still waiting on a valid command.
    await main(['tick', GATED_RUN_ID], deps());
    expect(log.read()).toEqual(events);
  });
});

const feedbackWorkflowPath = resolve(
  repoRoot,
  'workflows',
  'tiny-smoke-feedback',
  'workflow.yaml',
);
const feedbackScriptPath = resolve(
  repoRoot,
  'workflows',
  'tiny-smoke-feedback',
  'greet.sh',
);
const FEEDBACK_RUN_ID = '20260607T120000Z-tiny-smoke-feedback-ab12';
const REVISION_NOTE = 'say it louder';

/**
 * The feedback-threading smoke (issue #25): the one test that drives the *real*
 * CLI against the committed `workflows/tiny-smoke-feedback/` package through the
 * whole request-changes loop — `create -> tick` (stop at gate) ->
 * `command request_changes <text>` -> `tick` (re-dispatch the SAME gate's step
 * with `{{feedback.note}}` resolved into the recorded command, no new gate) ->
 * `command approve` -> `tick` -> completed.
 *
 * The fixture's script step interpolates `{{feedback.note}}`, so the re-run's
 * resolved command — recorded verbatim on `step_dispatched` — legitimately
 * differs from the first dispatch once a reviewer has requested changes, and the
 * artifact the re-run writes carries the reviewer's note. This is the one test
 * that proves the `{{feedback.*}}` namespace end to end against the real shell
 * with no mocks.
 */
describe('integration smoke: feedback loop (request_changes -> tick -> approve -> tick)', () => {
  let runsRoot: string;
  let lines: string[];
  let tracker: FakeTracker;

  // One tracker shared across create + tick (production hits the same repo): the
  // request_changes loop re-renders the SAME card with the revision thread.
  function deps(): Partial<CliDeps> {
    return {
      runsRoot,
      now,
      rand,
      mintCommentId: () => 'comment-1',
      makeTracker: () => tracker,
      log: (line) => lines.push(line),
    };
  }

  function logFor(): JsonlEventLog {
    return new JsonlEventLog(
      resolveRunDir(runsRoot, FEEDBACK_RUN_ID).eventsLogPath,
    );
  }

  function snapshot() {
    return loadWorkflowFile(
      resolveRunDir(runsRoot, FEEDBACK_RUN_ID).workflowSnapshotPath,
    );
  }

  /** Create the feedback run, then tick once so greet runs and the gate opens. */
  async function createAndOpenGate(): Promise<JsonlEventLog> {
    await main(
      [
        'run',
        'create',
        feedbackWorkflowPath,
        '--input',
        'name=World',
        '--input',
        `scriptPath=${feedbackScriptPath}`,
      ],
      deps(),
    );
    await main(['tick', FEEDBACK_RUN_ID], deps());
    return logFor();
  }

  beforeEach(async () => {
    runsRoot = await mkdtemp(join(tmpdir(), 'wm-smoke-feedback-'));
    lines = [];
    tracker = new FakeTracker();
    process.env.WORKMACHINE_SANDBOX_REPO = 'acme/widgets';
  });

  afterEach(async () => {
    delete process.env.WORKMACHINE_SANDBOX_REPO;
    await rm(runsRoot, { recursive: true, force: true });
  });

  it('threads request_changes feedback into the re-dispatched step, then approve completes the run', async () => {
    const log = await createAndOpenGate();

    // First dispatch: no prior decision, so {{feedback.note}} resolves to empty
    // and the greeting carries no revision line.
    const firstDispatch = log.read().find((e) => e.type === 'step_dispatched');
    expect(firstDispatch?.type).toBe('step_dispatched');
    if (firstDispatch?.type === 'step_dispatched') {
      expect(firstDispatch.command).not.toMatch(/\{\{/);
      expect(firstDispatch.command).toContain(`"${feedbackScriptPath}"`);
      // The trailing feedback arg is empty on the first round.
      expect(firstDispatch.command).toMatch(/""\s*$/);
    }

    // Request changes, then tick: the SAME gate's step re-dispatches with the
    // feedback resolved in — no new gate id is minted.
    await main(
      ['command', FEEDBACK_RUN_ID, 'request_changes', REVISION_NOTE],
      deps(),
    );
    await main(['tick', FEEDBACK_RUN_ID], deps());

    const afterRevision = log.read();
    expect(afterRevision.map((e) => e.type)).toEqual([
      'run_created',
      'card_created',
      'step_dispatched',
      'step_succeeded',
      'gate_opened',
      'command_received',
      'gate_decided',
      'step_dispatched',
      'step_succeeded',
      'gate_opened',
    ]);

    // The loop reused the one gate (ADR-0004 — one card per gate): every
    // gate_opened targets the same gate id, and the run is back at that gate.
    const gateIds = afterRevision
      .filter((e) => e.type === 'gate_opened')
      .map((e) => (e.type === 'gate_opened' ? e.gateId : ''));
    expect(gateIds).toEqual(['review', 'review']);
    expect(foldRunState(snapshot(), afterRevision).openGate).toEqual({
      gateId: 'review',
      stepId: 'review',
    });

    // The re-dispatched command is fully resolved and records the feedback
    // verbatim — the determinism guarantee: replay reproduces exact bytes.
    const dispatches = afterRevision.filter(
      (e) => e.type === 'step_dispatched',
    );
    expect(dispatches).toHaveLength(2);
    const redispatch = dispatches[1];
    if (redispatch?.type === 'step_dispatched') {
      expect(redispatch.command).not.toMatch(/\{\{/);
      expect(redispatch.command).toContain(`"${REVISION_NOTE}"`);
      // The re-run's command legitimately differs from the first dispatch.
      expect(redispatch.command).not.toBe(
        dispatches[0]?.type === 'step_dispatched'
          ? dispatches[0].command
          : undefined,
      );
    }

    // The artifact the re-run wrote carries the reviewer's revision line.
    expect(
      readFileSync(
        join(
          resolveRunDir(runsRoot, FEEDBACK_RUN_ID).runDir,
          'artifacts/greeting.txt',
        ),
        'utf8',
      ),
    ).toBe(`${GREETING}Revision: ${REVISION_NOTE}\n`);

    // Approve, then tick: the fresh command binds to the re-opened gate (not the
    // spent request_changes), so the run folds to completed.
    await main(['command', FEEDBACK_RUN_ID, 'approve'], deps());
    await main(['tick', FEEDBACK_RUN_ID], deps());

    const final = log.read();
    expect(final.map((e) => e.type)).toEqual([
      'run_created',
      'card_created',
      'step_dispatched',
      'step_succeeded',
      'gate_opened',
      'command_received',
      'gate_decided',
      'step_dispatched',
      'step_succeeded',
      'gate_opened',
      'command_received',
      'gate_decided',
      'run_completed',
    ]);
    const decisions = final
      .filter((e) => e.type === 'gate_decided')
      .map((e) => (e.type === 'gate_decided' ? e.decision : ''));
    expect(decisions).toEqual(['request_changes', 'approve']);

    const state = foldRunState(snapshot(), final);
    expect(state.status).toBe('completed');
    expect(state.steps.review?.status).toBe('approved');
    expect(foldRun(final).status).toBe('completed');

    // Re-ticking a completed run is a no-op.
    await main(['tick', FEEDBACK_RUN_ID], deps());
    expect(log.read()).toEqual(final);
  });
});
