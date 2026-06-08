import { existsSync, mkdirSync } from 'node:fs';
import {
  JsonlEventLog,
  createRunDir,
  resolveRunDir,
  writeRunCache,
} from '../run/index.js';
import type { TrackerAdapter } from '../tracker/index.js';
import { loadWorkflowFile } from '../workflow/index.js';
import { mintRunId } from './mint-run-id.js';

/**
 * The `run create` flow: mint a run's identity and scaffold its directory.
 *
 * This is the front door for a run instance and the one place its id is born
 * (CONTEXT.md → Run / run id scheme). The id is minted here on the impure side
 * — clock and randomness injected — recorded once in the `run_created` event,
 * and never re-derived: every later tick reads it back from the log. All I/O
 * lives here at the seam (loading the source workflow, scaffolding the dir,
 * appending the seed event, seeding the cache); the orchestrator stays pure.
 *
 * The workflow definition is pinned into `workflow.snapshot.yaml` at create time
 * so the run reproduces against the exact definition it was started with, even
 * if the source workflow package later changes.
 */

/** Inputs to {@link runCreate}; clock and randomness are injected for purity. */
export interface RunCreateOptions {
  /** Path to the source `workflow.yaml` to create the run against. */
  workflowPath: string;
  /** Operator-supplied inputs, recorded verbatim in `run_created`. */
  inputs: Record<string, unknown>;
  /**
   * `--run-id` override, or `undefined` to mint one. An override whose dir
   * already exists is refused (a run id names a unique instance).
   */
  runId: string | undefined;
  /** Absolute path to the `runs/` root that holds all run instances. */
  runsRoot: string;
  /** Injected clock returning an ISO-8601 instant. */
  now: () => string;
  /** Injected randomness for the minted id's disambiguating suffix. */
  rand: () => string;
  /**
   * The tracker the run's card is opened on. Injected so the flow is testable
   * offline (a {@link FakeTracker}); `main` defaults it to the live
   * {@link GitHubTracker}.
   */
  tracker: TrackerAdapter;
  /**
   * The `owner/name` repo the card is opened against, resolved at the seam from
   * `--repo`/`WORKMACHINE_SANDBOX_REPO` (ADR-0008). Recorded on `card_created`
   * so the run is self-describing.
   */
  repo: string;
}

/** What {@link runCreate} hands back: the run's id and its directory path. */
export interface RunCreateResult {
  runId: string;
  runDir: string;
}

/**
 * Create a new run: load and pin the workflow, scaffold `runs/<id>/`, seed the
 * log with `run_created`, open the run's tracker card, and record it as a
 * canonical `card_created` fact.
 *
 * The card is opened with the run id embedded in its body — the marker that
 * later anchors the card idempotently (ADR-0008) — and the `workmachine` label.
 * Opening the card is the one network touch at this seam; the returned
 * {@link CardRef} plus the resolved repo are appended as `card_created` (seq 1)
 * so the card ref is canonical, not only cached.
 *
 * @param opts the workflow path, inputs, optional id override, runs root,
 *   injected clock/randomness, tracker, and resolved repo.
 * @returns the minted (or overridden) run id and its directory path.
 * @throws if an explicit `--run-id` override names an existing run directory.
 */
export async function runCreate(
  opts: RunCreateOptions,
): Promise<RunCreateResult> {
  const workflow = loadWorkflowFile(opts.workflowPath);
  const runId = opts.runId ?? mintRunId(workflow.slug, opts.now, opts.rand);
  const layout = resolveRunDir(opts.runsRoot, runId);

  // Check first for a friendly message; createRunDir's mkdir is the hard EEXIST
  // backstop that still enforces the "a run id is unique" invariant at the seam.
  if (existsSync(layout.runDir)) {
    throw new Error(`run directory already exists: ${layout.runDir}`);
  }

  // Ensure the `runs/` root exists before createRunDir, which mkdirs the run dir
  // itself non-recursively (to make a colliding run id an EEXIST). On a fresh
  // checkout `runs/` is gitignored and absent, so the root is created lazily on
  // first run; the run dir's uniqueness guard is unaffected.
  mkdirSync(opts.runsRoot, { recursive: true });

  createRunDir(layout, workflow);

  const log = new JsonlEventLog(layout.eventsLogPath);
  log.append({
    type: 'run_created',
    runId,
    seq: 0,
    ts: opts.now(),
    workflowSlug: workflow.slug,
    inputs: opts.inputs,
  });

  // Open the run's card carrying the run-id marker, then record the returned
  // ref as a canonical event. It follows `run_created` (seq 0) so it is seq 1.
  const card = await opts.tracker.createRunCard({
    title: `Run ${runId}`,
    body: cardBody(runId),
    labels: ['workmachine'],
  });
  log.append({
    type: 'card_created',
    runId,
    seq: 1,
    ts: opts.now(),
    cardId: card.id,
    cardUrl: card.url,
    runIdMarker: runId,
    repo: opts.repo,
  });

  writeRunCache(layout.runCachePath, log.read());

  return { runId, runDir: layout.runDir };
}

/**
 * The run card's initial body: a single run-id marker line. The marker is the
 * run id itself — the anchor a later poll matches a card back to its run by
 * (ADR-0008). Rendering richer run state onto the card is a later task.
 */
function cardBody(runId: string): string {
  return `Work Machine run \`${runId}\`.`;
}
