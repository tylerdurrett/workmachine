import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { EngineEvent } from '../domain/index.js';

/**
 * The append-only event log behind an interface.
 *
 * `events.jsonl` is the canonical record of a run (ADR-0003): the log is the
 * source of truth and `run.yaml` is a cache derived from it. This interface is
 * the seam that keeps the canonical store swappable — the local-first
 * implementation is {@link JsonlEventLog}, and a later backend can move the log
 * to Postgres/R2 without the orchestrator or harness changing (CONTEXT.md →
 * "Known migration triggers").
 *
 * The contract is deliberately tiny — append one fact, read every fact in
 * order — because that is all a pure fold over the log requires. Querying,
 * indexing, and projection (e.g. `run.yaml`) are built on top, never inside.
 */
export interface EventLog {
  /**
   * Append a single event as the next line in the log. Events are stored in
   * append order; the caller is responsible for assigning a monotonic
   * {@link EngineEvent.seq} before appending.
   */
  append(event: EngineEvent): void;
  /** Read every event in the log, in append order. */
  read(): EngineEvent[];
}

/**
 * A filesystem {@link EventLog} backed by a JSON-lines (`events.jsonl`) file.
 *
 * Each event is serialized to one line of JSON and appended; reading parses the
 * file line by line. JSON Lines is chosen over a single JSON array because it
 * supports cheap O(1) appends (no rewrite of the whole file) and stays
 * human-greppable — the two properties an append-only run log most wants.
 *
 * The backing file is created lazily on first append; reading a log whose file
 * does not exist yet yields an empty list, so a freshly-scaffolded run dir
 * reads as a zero-event log rather than throwing.
 */
export class JsonlEventLog implements EventLog {
  /** Absolute path to the `events.jsonl` file backing this log. */
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  append(event: EngineEvent): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    appendFileSync(this.filePath, `${JSON.stringify(event)}\n`, 'utf8');
  }

  read(): EngineEvent[] {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
    return raw
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as EngineEvent);
  }
}

/** True when `err` is a Node `ENOENT` (file does not exist) error. */
function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
