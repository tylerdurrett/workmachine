import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ArtifactIndexEntry, EngineEvent } from '../domain/index.js';
import { JsonlEventLog } from './event-log.js';
import { foldRun, writeRunCache } from './run-cache.js';

const runId = '20260607T120000Z-tiny-smoke-ab12';

const greeting: ArtifactIndexEntry = {
  id: 'greeting',
  path: 'artifacts/greeting.txt',
  sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  size: 12,
};

/** A complete, successful gateless run log. */
const completedLog: EngineEvent[] = [
  {
    type: 'run_created',
    runId,
    seq: 0,
    ts: '2026-06-07T12:00:00.000Z',
    workflowSlug: 'tiny-smoke',
    inputs: { name: 'world' },
  },
  {
    type: 'step_dispatched',
    runId,
    seq: 1,
    ts: '2026-06-07T12:00:01.000Z',
    stepId: 'greet',
    stepType: 'script',
    command: 'echo "hello world" > artifacts/greeting.txt',
  },
  {
    type: 'step_succeeded',
    runId,
    seq: 2,
    ts: '2026-06-07T12:00:02.000Z',
    stepId: 'greet',
    artifacts: [greeting],
  },
  {
    type: 'run_completed',
    runId,
    seq: 3,
    ts: '2026-06-07T12:00:03.000Z',
    artifacts: [greeting],
  },
];

describe('foldRun', () => {
  it('seeds run identity and inputs from run_created', () => {
    const state = foldRun([completedLog[0]!]);

    expect(state.runId).toBe(runId);
    expect(state.workflowSlug).toBe('tiny-smoke');
    expect(state.inputs).toEqual({ name: 'world' });
    expect(state.status).toBe('pending');
    expect(state.steps).toEqual({});
  });

  it('folds a full successful run to completed with step + artifacts', () => {
    const state = foldRun(completedLog);

    expect(state.status).toBe('completed');
    expect(state.artifacts).toEqual([greeting]);
    expect(state.steps.greet).toEqual({
      stepId: 'greet',
      status: 'succeeded',
      command: 'echo "hello world" > artifacts/greeting.txt',
      artifacts: [greeting],
    });
  });

  it('marks the run running once a step is dispatched', () => {
    const state = foldRun(completedLog.slice(0, 2));

    expect(state.status).toBe('running');
    expect(state.steps.greet?.status).toBe('running');
    expect(state.steps.greet?.command).toContain('echo');
  });

  it('records a step failure reason and run_failed status', () => {
    const failedLog: EngineEvent[] = [
      completedLog[0]!,
      completedLog[1]!,
      {
        type: 'step_failed',
        runId,
        seq: 2,
        ts: '2026-06-07T12:00:02.000Z',
        stepId: 'greet',
        reason: 'exit code 1',
      },
      {
        type: 'run_failed',
        runId,
        seq: 3,
        ts: '2026-06-07T12:00:03.000Z',
        reason: 'step greet failed',
      },
    ];

    const state = foldRun(failedLog);

    expect(state.status).toBe('failed');
    expect(state.steps.greet?.status).toBe('failed');
    expect(state.steps.greet?.reason).toBe('exit code 1');
  });

  it('is pure: folding the same log twice yields equal state', () => {
    expect(foldRun(completedLog)).toEqual(foldRun(completedLog));
  });

  it('throws when the log does not begin with run_created', () => {
    expect(() => foldRun([completedLog[1]!])).toThrow(/run_created/);
    expect(() => foldRun([])).toThrow(/run_created/);
  });
});

describe('writeRunCache — rebuild matches the folded log', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wm-run-cache-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('rebuilds run.yaml purely by replaying events.jsonl', () => {
    // Persist the canonical log, then derive the cache from it — exactly the
    // path AC4 requires ("rebuildable purely by replaying events.jsonl").
    const log = new JsonlEventLog(join(dir, 'events.jsonl'));
    for (const event of completedLog) log.append(event);

    const cachePath = join(dir, 'run.yaml');
    const written = writeRunCache(cachePath, log.read());

    const onDisk = parseYaml(readFileSync(cachePath, 'utf8')) as unknown;

    // The written cache, the folded log, and the round-tripped YAML all agree.
    expect(written).toEqual(foldRun(completedLog));
    expect(onDisk).toEqual(foldRun(log.read()));
  });

  it('regenerates the cache wholesale so it cannot drift from the log', () => {
    const cachePath = join(dir, 'run.yaml');

    const partial = writeRunCache(cachePath, completedLog.slice(0, 2));
    expect(partial.status).toBe('running');

    const full = writeRunCache(cachePath, completedLog);
    const onDisk = parseYaml(readFileSync(cachePath, 'utf8')) as unknown;

    expect(full.status).toBe('completed');
    expect(onDisk).toEqual(foldRun(completedLog));
  });
});
