import { existsSync } from 'node:fs';
import type { GateDecision } from '../domain/index.js';
import { foldRunState } from '../orchestrator/index.js';
import { JsonlEventLog, resolveRunDir, writeRunCache } from '../run/index.js';
import { loadWorkflowFile } from '../workflow/index.js';

/**
 * The `command` flow: ingest a reviewer decision against a run's open gate.
 *
 * This is the impure manual front door for a gate command (CONTEXT.md →
 * Command). It records the raw command as an audit fact — a `command_received`
 * event — and nothing more: the validation that decides whether the command
 * actually moves the gate (open gate, matching gate id, verb in
 * `allowed_decisions`, first-valid-wins) stays entirely in the pure `decide`,
 * and the resulting `gate_decided` is appended by the harness on the next tick.
 * So this flow appends one fact and refreshes the derived cache; it never folds
 * a decision itself.
 *
 * The gate a command targets is the run's *currently-open* gate (ADR-0004 — one
 * review card at a time), resolved from folded run state rather than passed as
 * an arg. Stamping that gate id onto the command is what makes a wrong/closed
 * gate well-defined: when no gate is open, the command is still recorded (with
 * an empty gate id) so the audit trail is faithful, and `decide`'s validation
 * cleanly rejects it — producing no `gate_decided` and advancing nothing.
 *
 * Mirrors `run-create.ts`/`tick.ts`: all I/O lives here at the seam, and the
 * canonical idempotency key (the comment id) is injected so the flow is testable
 * with fixed deps. `decide` reads no clock and mints no id — the comment id is
 * the canonical dedup key, minted here on the impure side (ADR-0006).
 */

/**
 * The synthetic actor stamped on a manually-issued command. Identity is recorded
 * but NOT enforced this slice (CONTEXT.md → Command); a real tracker identity
 * replaces this when the GitHub adapter lands.
 */
export const MANUAL_COMMAND_ACTOR = 'cli';

/** Inputs to {@link runCommand}; the comment-id minter is injected for purity. */
export interface RunCommandOptions {
  /** Id of the run whose open gate the command targets; names its directory. */
  runId: string;
  /** The reviewer decision verb (`approve` | `request_changes` | `reject`). */
  decision: GateDecision;
  /** Free-text feedback, meaningful for `request_changes`/`reject`. */
  feedback?: string;
  /** Absolute path to the `runs/` root that holds all run instances. */
  runsRoot: string;
  /**
   * Mint the synthetic comment id — the canonical idempotency key (ADR-0006).
   * Injected (counter/uuid) so the flow is deterministic under test; never read
   * from a clock inside `decide`.
   */
  mintCommentId: () => string;
  /** Injected clock returning an ISO-8601 instant, stamped on the event `ts`. */
  now: () => string;
}

/**
 * Ingest a manual gate command: stamp the run's open gate id onto a
 * `command_received` event, mint its synthetic comment id, append it, and
 * refresh the derived cache.
 *
 * @param opts the run id, decision verb, optional feedback, runs root, and
 *   injected comment-id minter and clock.
 * @throws if no run directory exists for `runId`.
 */
export function runCommand(opts: RunCommandOptions): void {
  const layout = resolveRunDir(opts.runsRoot, opts.runId);
  if (!existsSync(layout.runDir)) {
    throw new Error(`no such run: ${opts.runId}`);
  }

  const workflow = loadWorkflowFile(layout.workflowSnapshotPath);
  const log = new JsonlEventLog(layout.eventsLogPath);
  const events = log.read();

  // Target the run's currently-open gate (single card per ADR-0004). When no
  // gate is open, fall back to an empty gate id: the command is still recorded
  // as an audit fact, and `decide`'s validation cleanly rejects it (no open
  // gate, no match), so nothing advances on the next tick.
  const { openGate } = foldRunState(workflow, events);
  const gateId = openGate?.gateId ?? '';

  log.append({
    type: 'command_received',
    runId: opts.runId,
    seq: events.length,
    ts: opts.now(),
    gateId,
    commentId: opts.mintCommentId(),
    actor: MANUAL_COMMAND_ACTOR,
    decision: opts.decision,
    ...(opts.feedback !== undefined && { feedback: opts.feedback }),
  });
  writeRunCache(layout.runCachePath, log.read());
}
