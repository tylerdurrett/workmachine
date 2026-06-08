import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadWorkflow } from '../workflow/index.js';
import {
  ARTIFACTS_DIRNAME,
  CURSOR_SIDECAR_FILENAME,
  createRunDir,
  EVENTS_LOG_FILENAME,
  RUN_CACHE_FILENAME,
  WORKFLOW_SNAPSHOT_FILENAME,
  readCursorSidecar,
  resolveRunDir,
  writeCursorSidecar,
} from './run-dir.js';

const runId = '20260607T120000Z-tiny-smoke-ab12';

const workflow = loadWorkflow(`
slug: tiny-smoke
name: Tiny Smoke
inputs:
  name:
    type: string
steps:
  - id: greet
    type: script
    run: 'echo "hi {{inputs.name}}" > {{artifacts.greeting.path}}'
    produces:
      - id: greeting
        path: artifacts/greeting.txt
`);

describe('resolveRunDir', () => {
  it('resolves the canonical layout paths under runs/<id>/', () => {
    const runsRoot = '/tmp/runs';
    const layout = resolveRunDir(runsRoot, runId);

    expect(layout.runId).toBe(runId);
    expect(layout.runDir).toBe(join(runsRoot, runId));
    expect(layout.eventsLogPath).toBe(
      join(runsRoot, runId, EVENTS_LOG_FILENAME),
    );
    expect(layout.runCachePath).toBe(join(runsRoot, runId, RUN_CACHE_FILENAME));
    expect(layout.workflowSnapshotPath).toBe(
      join(runsRoot, runId, WORKFLOW_SNAPSHOT_FILENAME),
    );
    expect(layout.artifactsDir).toBe(join(runsRoot, runId, ARTIFACTS_DIRNAME));
    expect(layout.cursorSidecarPath).toBe(
      join(runsRoot, runId, CURSOR_SIDECAR_FILENAME),
    );
  });

  it('is pure: resolving twice yields equal layouts and touches no disk', () => {
    expect(resolveRunDir('/tmp/runs', runId)).toEqual(
      resolveRunDir('/tmp/runs', runId),
    );
  });
});

describe('createRunDir', () => {
  let runsRoot: string;

  beforeEach(() => {
    runsRoot = mkdtempSync(join(tmpdir(), 'wm-run-dir-'));
  });

  afterEach(() => {
    rmSync(runsRoot, { recursive: true, force: true });
  });

  it('scaffolds the run dir and artifacts/ subdirectory', () => {
    const layout = resolveRunDir(runsRoot, runId);

    createRunDir(layout, workflow);

    expect(statSync(layout.runDir).isDirectory()).toBe(true);
    expect(statSync(layout.artifactsDir).isDirectory()).toBe(true);
  });

  it('writes the pinned workflow snapshot, round-tripping to the definition', () => {
    const layout = resolveRunDir(runsRoot, runId);

    createRunDir(layout, workflow);

    // Re-loading the snapshot reproduces the exact validated definition, so the
    // run is pinned to the workflow it was created against.
    expect(
      loadWorkflow(readFileSync(layout.workflowSnapshotPath, 'utf8')),
    ).toEqual(workflow);
  });

  it('does not pre-create the event log or run.yaml cache', () => {
    const layout = resolveRunDir(runsRoot, runId);

    createRunDir(layout, workflow);

    // Empty run dir = honest "no events / not yet projected" state.
    expect(existsSync(layout.eventsLogPath)).toBe(false);
    expect(existsSync(layout.runCachePath)).toBe(false);
    // The cursor sidecar is non-canonical and only appears on first poll write.
    expect(existsSync(layout.cursorSidecarPath)).toBe(false);
  });

  it('refuses to overwrite an existing run directory', () => {
    const layout = resolveRunDir(runsRoot, runId);
    createRunDir(layout, workflow);

    expect(() => createRunDir(layout, workflow)).toThrow(/EEXIST/);
  });
});

describe('cursor sidecar', () => {
  let runsRoot: string;

  beforeEach(() => {
    runsRoot = mkdtempSync(join(tmpdir(), 'wm-cursor-'));
  });

  afterEach(() => {
    rmSync(runsRoot, { recursive: true, force: true });
  });

  it('reads undefined when the sidecar does not exist', () => {
    const layout = resolveRunDir(runsRoot, runId);
    createRunDir(layout, workflow);

    expect(readCursorSidecar(layout, 'card-1')).toBeUndefined();
  });

  it('round-trips a per-card cursor through write then read', () => {
    const layout = resolveRunDir(runsRoot, runId);
    createRunDir(layout, workflow);

    writeCursorSidecar(layout, 'card-1', { etag: 'W/"abc"', since: '7' });

    expect(existsSync(layout.cursorSidecarPath)).toBe(true);
    expect(readCursorSidecar(layout, 'card-1')).toEqual({
      etag: 'W/"abc"',
      since: '7',
    });
  });

  it('keeps distinct cards independent and overwrites a card in place', () => {
    const layout = resolveRunDir(runsRoot, runId);
    createRunDir(layout, workflow);

    writeCursorSidecar(layout, 'card-1', { etag: 'one' });
    writeCursorSidecar(layout, 'card-2', { etag: 'two' });
    writeCursorSidecar(layout, 'card-1', { etag: 'one-updated' });

    expect(readCursorSidecar(layout, 'card-1')).toEqual({
      etag: 'one-updated',
    });
    // card-2 survives a peer's later write (the file is merged, not clobbered).
    expect(readCursorSidecar(layout, 'card-2')).toEqual({ etag: 'two' });
  });

  it('returns undefined for an unknown card even when the sidecar exists', () => {
    const layout = resolveRunDir(runsRoot, runId);
    createRunDir(layout, workflow);
    writeCursorSidecar(layout, 'card-1', { since: '3' });

    expect(readCursorSidecar(layout, 'card-99')).toBeUndefined();
  });

  it('degrades a corrupt (non-JSON) sidecar to "poll from the beginning"', () => {
    const layout = resolveRunDir(runsRoot, runId);
    createRunDir(layout, workflow);
    // A half-flushed / garbage sidecar: not even valid JSON.
    writeFileSync(layout.cursorSidecarPath, '{ this is not json', 'utf8');

    // The read does not throw; it falls back to "no cursor".
    expect(readCursorSidecar(layout, 'card-1')).toBeUndefined();

    // And a subsequent write recovers it rather than throwing on the load.
    expect(() =>
      writeCursorSidecar(layout, 'card-1', { etag: 'recovered' }),
    ).not.toThrow();
    expect(readCursorSidecar(layout, 'card-1')).toEqual({ etag: 'recovered' });
  });
});
