import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import type { CommandCursor } from '../tracker/index.js';
import type { WorkflowDefinition } from '../workflow/index.js';

/**
 * The on-disk layout of a single run instance: `runs/<id>/`.
 *
 * A run instance is local and gitignored (CONTEXT.md → "Workflow packages are
 * committed source; run instances are not"). Its directory holds four things,
 * with sharply different roles:
 *
 *  - `events.jsonl` — the canonical, append-only event log (ADR-0003).
 *  - `run.yaml` — a *derived* cache of run state, always rebuildable by
 *    replaying the log. No canonical state lives only here.
 *  - `workflow.snapshot.yaml` — the exact workflow definition the run was
 *    created against, captured at `run create`. Pinning it makes a run
 *    reproducible even if the source workflow package later changes.
 *  - `artifacts/` — the directory step executors write produced files into;
 *    the artifact *index* lives in the event log, the bytes live here.
 *
 * This module owns only path conventions and directory scaffolding. It never
 * folds the log or writes `run.yaml` — that derivation lives in `run-cache.ts`
 * so the cache stays a pure projection of the canonical log.
 */

/** Canonical filenames within a `runs/<id>/` directory. */
export const EVENTS_LOG_FILENAME = 'events.jsonl';
export const RUN_CACHE_FILENAME = 'run.yaml';
export const WORKFLOW_SNAPSHOT_FILENAME = 'workflow.snapshot.yaml';
export const ARTIFACTS_DIRNAME = 'artifacts';

/**
 * The comment-polling cursor sidecar. Unlike the files above, this is *not*
 * canonical: it caches the per-card command cursor (ETag + timestamp watermark)
 * so the poller can issue conditional requests and skip comments it has already
 * read (ADR-0006). Dropping it costs a redundant re-read, never correctness, so
 * it lives in the gitignored run dir beside `events.jsonl` rather than in the
 * log itself.
 */
export const CURSOR_SIDECAR_FILENAME = '.cursor.json';

/** The resolved absolute paths for one run's directory layout. */
export interface RunDirLayout {
  /** The run's id (`<timestamp>-<workflow-slug>-<rand4>`). */
  runId: string;
  /** Absolute path to the run directory `<runsRoot>/<runId>`. */
  runDir: string;
  /** Absolute path to the canonical append-only `events.jsonl`. */
  eventsLogPath: string;
  /** Absolute path to the derived `run.yaml` cache. */
  runCachePath: string;
  /** Absolute path to the pinned `workflow.snapshot.yaml`. */
  workflowSnapshotPath: string;
  /** Absolute path to the `artifacts/` directory. */
  artifactsDir: string;
  /** Absolute path to the non-canonical `.cursor.json` polling sidecar. */
  cursorSidecarPath: string;
}

/**
 * Resolve the canonical paths for a run without touching the filesystem.
 *
 * Pure path arithmetic: every later `tick` resolves the same paths from the
 * run id, so the layout is a stable convention rather than stored state.
 *
 * @param runsRoot Absolute path to the `runs/` root holding all run instances.
 * @param runId The run's minted id; becomes the directory name.
 */
export function resolveRunDir(runsRoot: string, runId: string): RunDirLayout {
  const runDir = join(runsRoot, runId);
  return {
    runId,
    runDir,
    eventsLogPath: join(runDir, EVENTS_LOG_FILENAME),
    runCachePath: join(runDir, RUN_CACHE_FILENAME),
    workflowSnapshotPath: join(runDir, WORKFLOW_SNAPSHOT_FILENAME),
    artifactsDir: join(runDir, ARTIFACTS_DIRNAME),
    cursorSidecarPath: join(runDir, CURSOR_SIDECAR_FILENAME),
  };
}

/**
 * Scaffold a run directory on disk and pin its workflow snapshot.
 *
 * Creates `runs/<id>/` and its `artifacts/` subdirectory, then writes the
 * `workflow.snapshot.yaml` from the validated definition the run is created
 * against. The `events.jsonl` and `run.yaml` files are intentionally *not*
 * pre-created: the event log appears on first append and the cache appears on
 * first projection, so an empty run dir is an honest "no events yet" state.
 *
 * @throws if `runDir` already exists. A run id names a unique instance; the
 *   harness mints a fresh one (or refuses an `--run-id` override whose dir
 *   exists), so colliding here is a programming error, not a recoverable state.
 */
export function createRunDir(
  layout: RunDirLayout,
  workflow: WorkflowDefinition,
): void {
  // `recursive: false` makes an existing run dir an EEXIST error rather than a
  // silent no-op, enforcing the "a run id is unique" invariant at the seam.
  mkdirSync(layout.runDir, { recursive: false });
  mkdirSync(layout.artifactsDir, { recursive: false });
  writeFileSync(layout.workflowSnapshotPath, stringifyYaml(workflow), 'utf8');
}

/**
 * The sidecar's on-disk shape: a map from card id to that card's last
 * {@link CommandCursor}. A map (rather than a single cursor) keeps the file
 * honest if a run ever polls more than one card, and lets a poll read/write
 * just its own card's entry.
 */
const cursorSidecarSchema = z.record(
  z.string(),
  z.object({ etag: z.string().optional(), since: z.string().optional() }),
);
type CursorSidecar = z.infer<typeof cursorSidecarSchema>;

/**
 * Load the whole sidecar map, or `{}` when it is absent or unparseable. A
 * missing/corrupt sidecar is not an error: the cursor is a non-canonical
 * optimization, so a bad one just means polling from the beginning (ADR-0006).
 */
function loadCursorSidecar(layout: RunDirLayout): CursorSidecar {
  if (!existsSync(layout.cursorSidecarPath)) return {};
  // A truncated or garbage sidecar (a half-flushed write, a crash mid-write)
  // makes JSON.parse throw before zod ever runs. Catch it here too, so a
  // corrupt sidecar degrades to "poll from the beginning" exactly like a
  // schema-mismatched one — never an error on the read *or* the next write.
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(layout.cursorSidecarPath, 'utf8'));
  } catch {
    return {};
  }
  const parsed = cursorSidecarSchema.safeParse(json);
  return parsed.success ? parsed.data : {};
}

/**
 * Read a card's cached polling cursor from the sidecar, or `undefined` if the
 * file or that card's entry is absent.
 */
export function readCursorSidecar(
  layout: RunDirLayout,
  cardId: string,
): CommandCursor | undefined {
  const entry = loadCursorSidecar(layout)[cardId];
  if (entry === undefined) return undefined;
  // Rebuild without undefined-valued keys so the cursor satisfies
  // `CommandCursor` under exactOptionalPropertyTypes.
  return {
    ...(entry.etag !== undefined && { etag: entry.etag }),
    ...(entry.since !== undefined && { since: entry.since }),
  };
}

/**
 * Write a card's polling cursor into the sidecar, merging over any existing
 * entries so a multi-card run does not clobber its peers. The file appears on
 * this first write, mirroring the `events.jsonl` "appears on first write"
 * convention — it is never pre-created by {@link createRunDir}.
 */
export function writeCursorSidecar(
  layout: RunDirLayout,
  cardId: string,
  cursor: CommandCursor,
): void {
  const next = { ...loadCursorSidecar(layout), [cardId]: cursor };
  writeFileSync(
    layout.cursorSidecarPath,
    JSON.stringify(next, null, 2),
    'utf8',
  );
}
