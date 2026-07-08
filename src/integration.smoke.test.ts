import { existsSync, readFileSync, rmSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CliDeps } from './cli/index.js';
import { main } from './cli/index.js';
import { composeAgentPrompt } from './executor/index.js';
import { foldRunState } from './orchestrator/index.js';
import { JsonlEventLog, foldRun, resolveRunDir } from './run/index.js';
import { FakeTracker } from './tracker/index.js';
import type { CardRef } from './tracker/index.js';
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
    if (
      dispatched?.type === 'step_dispatched' &&
      dispatched.stepType === 'script'
    ) {
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
    if (
      firstDispatch?.type === 'step_dispatched' &&
      firstDispatch.stepType === 'script'
    ) {
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
    if (
      redispatch?.type === 'step_dispatched' &&
      redispatch.stepType === 'script'
    ) {
      expect(redispatch.command).not.toMatch(/\{\{/);
      expect(redispatch.command).toContain(`"${REVISION_NOTE}"`);
      // The re-run's command legitimately differs from the first dispatch.
      expect(redispatch.command).not.toBe(
        dispatches[0]?.type === 'step_dispatched' &&
          dispatches[0].stepType === 'script'
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

/**
 * The fake-GitHub-surface smoke (issue #36): the slice's proof-of-life. Where the
 * gated/feedback blocks above drive the gate decision through the `command` CLI
 * subcommand, this block closes the slice acceptance criterion — "adapter behavior
 * tested against a fake GitHub surface; no live GitHub in unit tests" — by driving
 * `/approve` IN AS A REVIEWER COMMENT through the {@link FakeTracker} surface and
 * the harness's `readCommands` ingestion path, exactly as a human reviewer's
 * comment would arrive in production.
 *
 * The whole loop runs offline against the in-memory fake: `run create` opens the
 * fake card, the first `tick` runs the script step and opens the gate (rendering
 * the review card), `seedComment` injects a reviewer `/approve` on that card (NOT
 * `postComment`, which stamps the bot-comment marker and is ingestion-excluded by
 * it, never by author), and the
 * next `tick` polls the card, ingests the comment as `command_received`, validates
 * it against the open gate, and folds the run to `completed`.
 *
 * The reviewer card is `card-1`: the shared {@link FakeTracker} mints ids from a
 * monotonic counter, and `run create` opens exactly one card before the first
 * tick, so its id is fully determined. The cursor sidecar is wired by the CLI
 * `tick` (`.cursor.json`), so deleting it between ticks is a faithful "lost
 * cursor" — the dedup that survives it is keyed on comment ids in the log, never
 * on the sidecar (ADR-0006).
 */
const FAKE_SURFACE_CARD: CardRef = {
  id: 'card-1',
  url: 'fake://card/card-1',
};
const REVIEWER = 'octocat';

describe('integration smoke: fake GitHub surface (create -> tick -> /approve comment -> tick -> completed)', () => {
  let runsRoot: string;
  let lines: string[];
  let tracker: FakeTracker;

  // One tracker shared across create + every tick, as production hits one repo:
  // the card opened at create is the card the gate re-renders into and the card
  // a reviewer comment is seeded onto.
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

  function logForGated(): JsonlEventLog {
    return new JsonlEventLog(
      resolveRunDir(runsRoot, GATED_RUN_ID).eventsLogPath,
    );
  }

  function gatedSnapshot() {
    return loadWorkflowFile(
      resolveRunDir(runsRoot, GATED_RUN_ID).workflowSnapshotPath,
    );
  }

  /** Create the gated run against the committed package. */
  async function createGated(): Promise<void> {
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

  /** Create the gated run, then tick once so greet runs and the gate opens. */
  async function createAndOpenGate(): Promise<JsonlEventLog> {
    await createGated();
    await main(['tick', GATED_RUN_ID], deps());
    return logForGated();
  }

  function logForFeedback(): JsonlEventLog {
    return new JsonlEventLog(
      resolveRunDir(runsRoot, FEEDBACK_RUN_ID).eventsLogPath,
    );
  }

  function feedbackSnapshot() {
    return loadWorkflowFile(
      resolveRunDir(runsRoot, FEEDBACK_RUN_ID).workflowSnapshotPath,
    );
  }

  /** Create the feedback run, then tick once so greet runs and the gate opens. */
  async function createFeedbackAndOpenGate(): Promise<JsonlEventLog> {
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
    return logForFeedback();
  }

  beforeEach(async () => {
    runsRoot = await mkdtemp(join(tmpdir(), 'wm-smoke-fake-surface-'));
    lines = [];
    tracker = new FakeTracker();
    process.env.WORKMACHINE_SANDBOX_REPO = 'acme/widgets';
  });

  afterEach(async () => {
    delete process.env.WORKMACHINE_SANDBOX_REPO;
    await rm(runsRoot, { recursive: true, force: true });
  });

  it('ingests a reviewer /approve comment off the fake surface and folds to completed', async () => {
    const log = await createAndOpenGate();

    // The first tick stopped at the open gate, having rendered the review card —
    // nothing is decided yet because no reviewer comment exists.
    expect(log.read().map((e) => e.type)).toEqual([
      'run_created',
      'card_created',
      'step_dispatched',
      'step_succeeded',
      'gate_opened',
    ]);
    expect(tracker.cardState(FAKE_SURFACE_CARD.id)?.renderCount).toBe(1);

    // A reviewer leaves `/approve` on the card. seedComment posts a bare body with
    // no bot-comment marker (unlike postComment), so ingestion will pick it up.
    await tracker.seedComment(FAKE_SURFACE_CARD, '/approve', REVIEWER);

    // The next tick polls the card, ingests the comment as `command_received`,
    // validates it against the open gate, and drives the run to completion — the
    // command never touched the `command` CLI; it came in as a comment.
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

    // The ingested command carries the reviewer's handle and decision, bound to
    // the open gate — proving it flowed through the fake surface, not the CLI.
    const received = events.find((e) => e.type === 'command_received');
    expect(received?.type).toBe('command_received');
    if (received?.type === 'command_received') {
      expect(received.actor).toBe(REVIEWER);
      expect(received.decision).toBe('approve');
      expect(received.gateId).toBe('review');
      expect(received.commentId).toBe('c1');
    }

    // The folded state: run completed, the review step approved.
    const state = foldRunState(gatedSnapshot(), events);
    expect(state.status).toBe('completed');
    expect(state.steps.review?.status).toBe('approved');

    // The completed state is observable on disk, not just in memory.
    const layout = resolveRunDir(runsRoot, GATED_RUN_ID);
    const cache = parseYaml(readFileSync(layout.runCachePath, 'utf8')) as {
      status: string;
    };
    expect(cache.status).toBe('completed');
    expect(foldRun(events).status).toBe('completed');
  });

  it('ingests a comment exactly once across a lost cursor (crash-and-replay dedup)', async () => {
    const log = await createAndOpenGate();
    await tracker.seedComment(FAKE_SURFACE_CARD, '/approve', REVIEWER);
    await main(['tick', GATED_RUN_ID], deps());

    // The comment was ingested once and the run completed.
    const afterFirst = log.read();
    expect(
      afterFirst.filter((e) => e.type === 'command_received'),
    ).toHaveLength(1);
    expect(foldRun(afterFirst).status).toBe('completed');

    // Simulate a lost cursor: the CLI tick wrote `.cursor.json` after ingesting,
    // so the poll would normally skip `c1`. Delete it to force a re-poll from the
    // beginning, exactly as a crashed/wiped sidecar would (ADR-0006). The comment
    // is back in the read window — only the log-keyed dedup can stop a re-ingest.
    const layout = resolveRunDir(runsRoot, GATED_RUN_ID);
    expect(existsSync(layout.cursorSidecarPath)).toBe(true);
    rmSync(layout.cursorSidecarPath);

    // Re-tick: the poll re-reads `c1` from index 0, but dedup is keyed on the
    // comment ids already in the log, not the cursor — so no second
    // `command_received` is appended for the same comment id (AC2/AC5).
    await main(['tick', GATED_RUN_ID], deps());

    const afterReplay = log.read();
    expect(
      afterReplay.filter((e) => e.type === 'command_received'),
    ).toHaveLength(1);
    // The replay appended nothing at all: the surviving `command_received` (for
    // comment `c1`) is byte-for-byte the one from the first ingest, not a new one.
    expect(afterReplay).toEqual(afterFirst);
  });

  it('reuses the same card across a re-tick at the open gate, never minting a second', async () => {
    const log = await createAndOpenGate();

    // The gate is open and its card was rendered once. No reviewer comment exists,
    // so the run waits here.
    expect(log.read().map((e) => e.type)).toEqual([
      'run_created',
      'card_created',
      'step_dispatched',
      'step_succeeded',
      'gate_opened',
    ]);
    const before = log.read();
    expect(tracker.cardState(FAKE_SURFACE_CARD.id)?.renderCount).toBe(1);
    expect(tracker.cardState('card-2')).toBeUndefined();

    // Re-tick the run sitting at the open gate: it appends nothing (still waiting
    // on a command) and, crucially, never mints a second card — the run's recorded
    // `card-1` is the only one, so a later render threads into it (ADR-0004, one
    // card per gate) rather than opening a fresh card.
    await main(['tick', GATED_RUN_ID], deps());
    expect(log.read()).toEqual(before);
    expect(tracker.cardState('card-2')).toBeUndefined();
  });

  it('threads a request_changes revision into the same card off the fake surface', async () => {
    const log = await createFeedbackAndOpenGate();

    // The gate opened and its single card was rendered once.
    expect(tracker.cardState(FAKE_SURFACE_CARD.id)?.renderCount).toBe(1);
    expect(tracker.cardState('card-2')).toBeUndefined();

    // A reviewer leaves `/request-changes <note>` on the card (not via the
    // `command` CLI). The next tick ingests it, re-dispatches the guarded step
    // with the feedback resolved in, and re-opens the SAME gate — re-rendering the
    // same card with the revision threaded, never minting a new one.
    await tracker.seedComment(
      FAKE_SURFACE_CARD,
      `/request-changes ${REVISION_NOTE}`,
      REVIEWER,
    );
    await main(['tick', FEEDBACK_RUN_ID], deps());

    const events = log.read();
    expect(events.map((e) => e.type)).toEqual([
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

    // The decision flowed through the fake surface as the reviewer's comment.
    const decided = events.find((e) => e.type === 'gate_decided');
    expect(decided?.type).toBe('gate_decided');
    if (decided?.type === 'gate_decided') {
      expect(decided.decision).toBe('request_changes');
      expect(decided.actor).toBe(REVIEWER);
      expect(decided.feedback).toBe(REVISION_NOTE);
    }

    // The one gate was reused: both `gate_opened`s target the same gate id, and
    // the run is back at it (ADR-0004 — one card per gate, no new gate minted).
    const gateIds = events
      .filter((e) => e.type === 'gate_opened')
      .map((e) => (e.type === 'gate_opened' ? e.gateId : ''));
    expect(gateIds).toEqual(['review', 'review']);
    expect(foldRunState(feedbackSnapshot(), events).openGate).toEqual({
      gateId: 'review',
      stepId: 'review',
    });

    // The SAME card was re-rendered (renderCount bumped) — no second card minted.
    expect(tracker.cardState(FAKE_SURFACE_CARD.id)?.renderCount).toBe(2);
    expect(tracker.cardState('card-2')).toBeUndefined();
  });
});

const agentWorkflowPath = resolve(
  repoRoot,
  'workflows',
  'tiny-agent',
  'workflow.yaml',
);
const AGENT_RUN_ID = '20260607T120000Z-tiny-agent-ab12';
const TOPIC = 'autumn rain';

/**
 * The author prompt from the committed `workflows/tiny-agent/workflow.yaml`
 * with `{{inputs.topic}}` resolved and `{{feedback.note}}` resolved to the
 * empty string (YAML `>-` folds it to one line). On the first dispatch no prior
 * `request_changes` decision exists, so the feedback token collapses to nothing
 * and the prompt ends with the bare "…if present: " marker (trailing space).
 * Pinned verbatim, like {@link GREETING}, so a drifted fixture fails here.
 */
const AGENT_AUTHOR_PROMPT = `Write a haiku about ${TOPIC}. Output only the three lines of the haiku, nothing else. Address this reviewer feedback if present: `;

/** The reviewer's revision note, threaded into the re-dispatched prompt. */
const AGENT_REVISION_NOTE = 'make it about maple leaves';

/**
 * The author prompt after a `request_changes(AGENT_REVISION_NOTE)`: because
 * {@link AGENT_AUTHOR_PROMPT} ends with the trailing-space marker, the resolved
 * revision prompt is simply the note appended. The re-dispatch legitimately
 * differs from the first, and the stub keys its revised bytes off it.
 */
const AGENT_REVISION_PROMPT = `${AGENT_AUTHOR_PROMPT}${AGENT_REVISION_NOTE}`;

/** The bytes the stub codex writes to every declared artifact path with no feedback. */
const HAIKU =
  'stub silicon mind\nwrites seventeen syllables\nthe contract is kept\n';

/**
 * The bytes the stub writes once reviewer feedback is present in the prompt:
 * the base haiku plus a `Revision:` line carrying the note (mirroring
 * `greet.sh`'s non-empty-feedback branch), so the revised artifact's
 * bytes/sha256/size legitimately change across the request_changes round.
 */
const REVISED_HAIKU = `${HAIKU}Revision: ${AGENT_REVISION_NOTE}\n`;

/**
 * A hermetic stand-in for the Codex CLI. The agent executor spawns plain
 * `codex` (resolved through `PATH`), so a stub dropped into a temp dir
 * prepended to `PATH` intercepts the spawn with no real binary and no network.
 *
 * It honors the executor's actual argv contract: `-C <runDir>` names the run
 * directory and the composed prompt is the final argument. Like a compliant
 * agent, it reads its obligations from the prompt itself — extracting every
 * backticked path from the `## Engine contract` block's artifact lines
 * (`  - \`<path>\``) and writing the haiku there under the run dir — then
 * exits zero.
 *
 * It is also feedback-aware, mirroring `greet.sh`'s non-empty branch: it reads
 * the reviewer's note off the author line (everything after the "…if present: "
 * marker on line 1 of the composed prompt) and, when that note is non-empty,
 * appends a \`Revision: <note>\` line so the revised artifact's bytes/sha256
 * legitimately change across a request_changes round. On the first dispatch the
 * resolver substitutes \`{{feedback.note}}\` to empty, so the note is empty and
 * the base haiku is written unchanged.
 */
const FEEDBACK_MARKER = 'Address this reviewer feedback if present: ';
const STUB_CODEX = `#!/bin/sh
run_dir=''
prev=''
for arg in "$@"; do
  if [ "$prev" = '-C' ]; then run_dir=$arg; fi
  prev=$arg
done
prompt=$prev

feedback=$(printf '%s\\n' "$prompt" | sed -n '1s/.*${FEEDBACK_MARKER}//p')

printf '%s\\n' "$prompt" | grep '^  - \`' | sed 's/^  - \`//; s/\`$//' \\
  | while IFS= read -r path; do
      mkdir -p "$run_dir/$(dirname "$path")"
      if [ -n "$feedback" ]; then
        printf '%sRevision: %s\\n' '${HAIKU}' "$feedback" > "$run_dir/$path"
      else
        printf '%s' '${HAIKU}' > "$run_dir/$path"
      fi
    done
exit 0
`;

/**
 * Restore `process.env.PATH` to a previously-captured value. When the original
 * was unset, `delete` it rather than assigning — a bare `process.env.PATH =
 * undefined` would coerce to the literal string `'undefined'` and poison PATH
 * for later tests.
 */
function restorePath(original: string | undefined): void {
  if (original === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = original;
  }
}

/**
 * The agent-step smoke (issue #62): the agent-twin of the gated block above. It
 * drives the *real* CLI against the committed `workflows/tiny-agent/` package
 * through the whole gated loop — `create -> tick` (the agent step runs, the
 * gate opens) -> `command approve` -> `tick` -> `run_completed` — with the real
 * `agentExecutor` spawning a stub `codex` off `PATH`, so CI proves the loop
 * fully offline (the real `codex exec` demo is the live runbook's job,
 * docs/live-demo-runbook.md, owned by #63).
 *
 * What only this test proves: the prompt recorded on `step_dispatched` is the
 * exact composed bytes the subprocess receives (author text with the topic
 * substituted + the appended `## Engine contract` block), and the artifact the
 * *agent* wrote — at the path the contract block named, not a path the engine
 * chose — is captured with path/sha256/size and carried to `run_completed`.
 */
describe('integration smoke: agent loop with stub codex (create -> tick -> approve -> tick)', () => {
  let runsRoot: string;
  let stubDir: string;
  let originalPath: string | undefined;
  let lines: string[];
  let tracker: FakeTracker;

  // One tracker shared across create + tick (production hits the same repo).
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

  beforeEach(async () => {
    runsRoot = await mkdtemp(join(tmpdir(), 'wm-smoke-agent-'));
    stubDir = await mkdtemp(join(tmpdir(), 'wm-stub-codex-'));
    await writeFile(join(stubDir, 'codex'), STUB_CODEX, { mode: 0o755 });
    originalPath = process.env.PATH;
    process.env.PATH = `${stubDir}:${originalPath ?? ''}`;
    lines = [];
    tracker = new FakeTracker();
    process.env.WORKMACHINE_SANDBOX_REPO = 'acme/widgets';
  });

  afterEach(async () => {
    restorePath(originalPath);
    delete process.env.WORKMACHINE_SANDBOX_REPO;
    await rm(stubDir, { recursive: true, force: true });
    await rm(runsRoot, { recursive: true, force: true });
  });

  it('runs the committed tiny-agent package end to end against the stub', async () => {
    await main(
      ['run', 'create', agentWorkflowPath, '--input', `topic=${TOPIC}`],
      deps(),
    );
    await main(['tick', AGENT_RUN_ID], deps());

    const layout = resolveRunDir(runsRoot, AGENT_RUN_ID);
    const log = new JsonlEventLog(layout.eventsLogPath);

    // The agent step ran (the stub wrote the haiku), the gate opened, and the
    // run stopped waiting — nothing terminal until a reviewer decides.
    const opened = log.read();
    expect(opened.map((e) => e.type)).toEqual([
      'run_created',
      'card_created',
      'step_dispatched',
      'step_succeeded',
      'gate_opened',
    ]);

    // The recorded prompt is the FULL composed payload, byte for byte: the
    // author text with the topic substituted (no tokens left) plus the engine
    // contract block naming the declared artifact path.
    const dispatched = opened[2];
    expect(dispatched?.type).toBe('step_dispatched');
    if (dispatched?.type === 'step_dispatched') {
      expect(dispatched.stepType).toBe('agent');
      if (dispatched.stepType === 'agent') {
        expect(dispatched.prompt).not.toMatch(/\{\{/);
        expect(dispatched.prompt).toContain(AGENT_AUTHOR_PROMPT);
        expect(dispatched.prompt).toContain('## Engine contract');
        expect(dispatched.prompt).toContain('`artifacts/haiku.txt`');
        expect(dispatched.prompt).toBe(
          composeAgentPrompt(AGENT_AUTHOR_PROMPT, [
            { id: 'haiku', path: 'artifacts/haiku.txt' },
          ]),
        );
      }
    }

    // Approve, then tick: the run advances past the gate to completed.
    await main(['command', AGENT_RUN_ID, 'approve'], deps());
    await main(['tick', AGENT_RUN_ID], deps());

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

    // The executor captured the artifact the STUB wrote at the contract-named
    // path, with a real hash and size; the terminal event carries it too.
    const succeeded = events.find((e) => e.type === 'step_succeeded');
    expect(succeeded?.type).toBe('step_succeeded');
    if (succeeded?.type === 'step_succeeded') {
      expect(succeeded.artifacts).toHaveLength(1);
      const [artifact] = succeeded.artifacts;
      expect(artifact).toMatchObject({
        id: 'haiku',
        path: 'artifacts/haiku.txt',
      });
      expect(artifact?.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(artifact?.size).toBeGreaterThan(0);
    }
    const completed = events.at(-1);
    expect(completed?.type).toBe('run_completed');
    if (completed?.type === 'run_completed') {
      expect(completed.artifacts).toContainEqual(
        expect.objectContaining({ id: 'haiku', path: 'artifacts/haiku.txt' }),
      );
    }

    // The bytes on disk are exactly what the stub wrote.
    expect(
      readFileSync(join(layout.runDir, 'artifacts/haiku.txt'), 'utf8'),
    ).toBe(HAIKU);

    // The completed state is observable on disk, and a replay fold agrees.
    const cache = parseYaml(readFileSync(layout.runCachePath, 'utf8')) as {
      status: string;
    };
    expect(cache.status).toBe('completed');
    expect(foldRun(events).status).toBe('completed');
  });
});

/**
 * The agent revision smoke (issue #75): the agent-twin of the feedback-loop
 * block above. It drives the committed `workflows/tiny-agent/` package through
 * the whole request-changes loop against a stub `codex`, fully offline —
 * `create -> tick` (agent runs, gate opens) -> `command request_changes <note>`
 * -> `tick` (the SAME gate re-dispatches the agent with the note resolved into
 * the prompt) -> `command approve` -> `tick` -> `run_completed`.
 *
 * What only this test proves: the fixture threads `{{feedback.note}}` into the
 * agent prompt, so the SECOND `step_dispatched.prompt` carries the reviewer's
 * note verbatim and differs from the first; the feedback-aware stub therefore
 * writes visibly different bytes on the re-run, so the artifact's sha256/size
 * change across the round; and the loop reuses the one review card (ADR-0004,
 * one card per gate) rather than minting a second.
 */
describe('integration smoke: agent revision loop with stub codex (request_changes -> tick -> approve -> tick)', () => {
  let runsRoot: string;
  let stubDir: string;
  let originalPath: string | undefined;
  let lines: string[];
  let tracker: FakeTracker;

  // One tracker shared across create + every tick, as production hits one repo:
  // the card opened at create is the card the gate re-renders into on revision.
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

  /** Create the agent run, then tick once so the agent runs and the gate opens. */
  async function createAndOpenGate(): Promise<JsonlEventLog> {
    await main(
      ['run', 'create', agentWorkflowPath, '--input', `topic=${TOPIC}`],
      deps(),
    );
    await main(['tick', AGENT_RUN_ID], deps());
    return new JsonlEventLog(
      resolveRunDir(runsRoot, AGENT_RUN_ID).eventsLogPath,
    );
  }

  function snapshot() {
    return loadWorkflowFile(
      resolveRunDir(runsRoot, AGENT_RUN_ID).workflowSnapshotPath,
    );
  }

  beforeEach(async () => {
    runsRoot = await mkdtemp(join(tmpdir(), 'wm-smoke-agent-rev-'));
    stubDir = await mkdtemp(join(tmpdir(), 'wm-stub-codex-'));
    await writeFile(join(stubDir, 'codex'), STUB_CODEX, { mode: 0o755 });
    originalPath = process.env.PATH;
    process.env.PATH = `${stubDir}:${originalPath ?? ''}`;
    lines = [];
    tracker = new FakeTracker();
    process.env.WORKMACHINE_SANDBOX_REPO = 'acme/widgets';
  });

  afterEach(async () => {
    restorePath(originalPath);
    delete process.env.WORKMACHINE_SANDBOX_REPO;
    await rm(stubDir, { recursive: true, force: true });
    await rm(runsRoot, { recursive: true, force: true });
  });

  it('re-dispatches the agent with the reviewer note, revising the artifact in the same card', async () => {
    const layout = resolveRunDir(runsRoot, AGENT_RUN_ID);
    const artifactPath = join(layout.runDir, 'artifacts/haiku.txt');
    const log = await createAndOpenGate();

    // First dispatch: no prior decision, so {{feedback.note}} resolves to empty
    // and the composed prompt is the base author text (bare marker, no note).
    const firstDispatch = log.read().find((e) => e.type === 'step_dispatched');
    expect(firstDispatch?.type).toBe('step_dispatched');
    if (
      firstDispatch?.type === 'step_dispatched' &&
      firstDispatch.stepType === 'agent'
    ) {
      expect(firstDispatch.prompt).not.toMatch(/\{\{/);
      expect(firstDispatch.prompt).not.toContain(AGENT_REVISION_NOTE);
      expect(firstDispatch.prompt).toBe(
        composeAgentPrompt(AGENT_AUTHOR_PROMPT, [
          { id: 'haiku', path: 'artifacts/haiku.txt' },
        ]),
      );
    }

    // The gate opened and its single card was rendered once — no reviewer
    // decision yet, so nothing terminal.
    expect(log.read().map((e) => e.type)).toEqual([
      'run_created',
      'card_created',
      'step_dispatched',
      'step_succeeded',
      'gate_opened',
    ]);
    expect(tracker.cardState(FAKE_SURFACE_CARD.id)?.renderCount).toBe(1);
    expect(tracker.cardState('card-2')).toBeUndefined();

    // The first-round artifact is the base haiku the stub wrote with no feedback.
    const firstBytes = readFileSync(artifactPath, 'utf8');
    expect(firstBytes).toBe(HAIKU);

    // Request changes, then tick: the SAME gate's step re-dispatches with the
    // feedback resolved into the prompt — no new gate id is minted.
    await main(
      ['command', AGENT_RUN_ID, 'request_changes', AGENT_REVISION_NOTE],
      deps(),
    );
    await main(['tick', AGENT_RUN_ID], deps());

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

    // The SECOND dispatch's prompt carries the reviewer's note verbatim and
    // legitimately differs from the first — the determinism guarantee: replay
    // reproduces the exact composed bytes the agent received.
    const dispatches = afterRevision.filter(
      (e) => e.type === 'step_dispatched',
    );
    expect(dispatches).toHaveLength(2);
    const redispatch = dispatches[1];
    expect(redispatch?.type).toBe('step_dispatched');
    if (
      redispatch?.type === 'step_dispatched' &&
      redispatch.stepType === 'agent'
    ) {
      expect(redispatch.prompt).not.toMatch(/\{\{/);
      expect(redispatch.prompt).toContain(AGENT_REVISION_NOTE);
      expect(redispatch.prompt).toBe(
        composeAgentPrompt(AGENT_REVISION_PROMPT, [
          { id: 'haiku', path: 'artifacts/haiku.txt' },
        ]),
      );
      // …and legitimately differs from the first dispatch's composed bytes.
      expect(redispatch.prompt).not.toBe(
        composeAgentPrompt(AGENT_AUTHOR_PROMPT, [
          { id: 'haiku', path: 'artifacts/haiku.txt' },
        ]),
      );
    }

    // The revised artifact the agent wrote carries the Revision line, so its
    // bytes — and the recorded sha256/size — change across the round.
    const revisedBytes = readFileSync(artifactPath, 'utf8');
    expect(revisedBytes).toBe(REVISED_HAIKU);
    expect(revisedBytes).not.toBe(firstBytes);

    const successes = afterRevision.filter((e) => e.type === 'step_succeeded');
    expect(successes).toHaveLength(2);
    const hashes = successes.map((e) =>
      e.type === 'step_succeeded' ? e.artifacts[0]?.sha256 : undefined,
    );
    expect(hashes[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(hashes[1]).toMatch(/^[0-9a-f]{64}$/);
    expect(hashes[1]).not.toBe(hashes[0]);

    // The SAME card was re-rendered (renderCount bumped) — no second card minted.
    expect(tracker.cardState(FAKE_SURFACE_CARD.id)?.renderCount).toBe(2);
    expect(tracker.cardState('card-2')).toBeUndefined();

    // Approve, then tick: the fresh command binds to the re-opened gate (not the
    // spent request_changes), so the run folds to completed.
    await main(['command', AGENT_RUN_ID, 'approve'], deps());
    await main(['tick', AGENT_RUN_ID], deps());

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

    // The revised bytes are what remain on disk, and re-ticking is a no-op.
    expect(readFileSync(artifactPath, 'utf8')).toBe(REVISED_HAIKU);
    await main(['tick', AGENT_RUN_ID], deps());
    expect(log.read()).toEqual(final);
  });
});
