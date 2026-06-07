import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadWorkflow } from '../workflow/index.js';
import {
  ARTIFACTS_DIRNAME,
  createRunDir,
  EVENTS_LOG_FILENAME,
  RUN_CACHE_FILENAME,
  WORKFLOW_SNAPSHOT_FILENAME,
  resolveRunDir,
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
  });

  it('refuses to overwrite an existing run directory', () => {
    const layout = resolveRunDir(runsRoot, runId);
    createRunDir(layout, workflow);

    expect(() => createRunDir(layout, workflow)).toThrow(/EEXIST/);
  });
});
