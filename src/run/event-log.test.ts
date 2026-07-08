import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EngineEvent } from '../domain/index.js';
import { JsonlEventLog } from './event-log.js';

const runId = '20260607T120000Z-tiny-smoke-ab12';

/** A representative gateless event sequence covering every payload shape. */
const sampleLog: EngineEvent[] = [
  {
    type: 'run_created',
    runId,
    seq: 0,
    ts: '2026-06-07T12:00:00.000Z',
    workflowSlug: 'tiny-smoke',
    inputs: { name: 'world', count: 3, verbose: true },
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
    artifacts: [
      {
        id: 'greeting',
        path: 'artifacts/greeting.txt',
        sha256:
          'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        size: 12,
      },
    ],
  },
  {
    type: 'run_completed',
    runId,
    seq: 3,
    ts: '2026-06-07T12:00:03.000Z',
    artifacts: [
      {
        id: 'greeting',
        path: 'artifacts/greeting.txt',
        sha256:
          'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        size: 12,
      },
    ],
  },
];

describe('JsonlEventLog', () => {
  let dir: string;
  let logPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wm-event-log-'));
    logPath = join(dir, 'events.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads an empty list when the backing file does not exist yet', () => {
    expect(new JsonlEventLog(logPath).read()).toEqual([]);
  });

  it('round-trips a single appended event preserving its full payload', () => {
    const log = new JsonlEventLog(logPath);
    const event = sampleLog[0]!;

    log.append(event);

    expect(log.read()).toEqual([event]);
  });

  it('round-trips a full event sequence preserving append order', () => {
    const log = new JsonlEventLog(logPath);
    for (const event of sampleLog) log.append(event);

    const read = log.read();

    expect(read).toEqual(sampleLog);
    expect(read.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
  });

  it('persists across separate log instances over the same file', () => {
    const writer = new JsonlEventLog(logPath);
    for (const event of sampleLog) writer.append(event);

    // A fresh instance (e.g. a later `tick`) reads what an earlier one wrote.
    expect(new JsonlEventLog(logPath).read()).toEqual(sampleLog);
  });

  it('stores one JSON object per line (JSON Lines)', () => {
    const log = new JsonlEventLog(logPath);
    for (const event of sampleLog) log.append(event);

    const lines = readFileSync(logPath, 'utf8').split('\n').filter(Boolean);

    expect(lines).toHaveLength(sampleLog.length);
    expect(JSON.parse(lines[0]!)).toEqual(sampleLog[0]);
  });

  it('creates the backing directory lazily on first append', () => {
    const nested = join(dir, 'runs', runId, 'events.jsonl');
    const log = new JsonlEventLog(nested);

    log.append(sampleLog[0]!);

    expect(log.read()).toEqual([sampleLog[0]]);
  });
});
