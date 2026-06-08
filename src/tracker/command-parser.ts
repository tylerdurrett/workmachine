import type { GateDecision } from '../domain/events.js';
import type { TrackerComment } from './types.js';

/**
 * Turning a raw {@link TrackerComment} into a decision command — the step the
 * tracker adapter deliberately does *not* do (it "only moves cards and comments
 * across the wire", types.ts). The adapter speaks card / comment / cursor; this
 * module adds the missing verb, mapping a reviewer's slash command to a
 * {@link GateDecision} the gate understands.
 *
 * It is pure and tracker-agnostic: a list of comments in, a list of candidate
 * commands out, no I/O and no GitHub-isms. A *candidate* command, not a truth —
 * the cursor and this parse are both non-canonical. The event log's comment-id
 * dedup is what makes ingestion exactly-once (ADR-0006), and `decide`'s
 * validation is what decides whether a candidate actually drives a gate. That
 * ingestion + dedup wiring is the next task; here we stop at the parse.
 */

/** The slash commands a reviewer can leave, mapped to their gate decision. */
const VERB_DECISIONS: Record<string, GateDecision> = {
  '/approve': 'approve',
  '/request-changes': 'request_changes',
  '/reject': 'reject',
};

/**
 * A command parsed out of one comment, ready to feed a `command_received` event
 * downstream (events.ts) — it carries exactly that event's reviewer-supplied
 * fields. The `commentId` is the canonical idempotency key the log dedups on;
 * `actor` is recorded, not yet enforced.
 */
export interface CandidateCommand {
  /** Stable tracker comment id this command was parsed from. */
  commentId: string;
  /** Who left the comment (a provider handle). Recorded, not enforced. */
  actor: string;
  /** The decision verb the slash command maps to. */
  decision: GateDecision;
  /** Trailing free-text after the verb, if any (the revision feedback / reason). */
  feedback?: string;
}

/**
 * Parse a card's comments into the decision commands they carry. Recognizes
 * `/approve`, `/request-changes <text>`, and `/reject <text>` as the first
 * token of a comment; any trailing text becomes {@link CandidateCommand.feedback}.
 *
 * Non-matching comments — chatter, an unknown slash command, an empty body — are
 * simply skipped, never errors: a review card is a human conversation, and most
 * of it is not a command.
 */
export function parseCommands(comments: TrackerComment[]): CandidateCommand[] {
  const commands: CandidateCommand[] = [];
  for (const comment of comments) {
    const command = parseComment(comment);
    if (command !== undefined) commands.push(command);
  }
  return commands;
}

/** Parse one comment into a command, or `undefined` if its body is not one. */
function parseComment(comment: TrackerComment): CandidateCommand | undefined {
  const trimmed = comment.body.trim();
  const firstSpace = trimmed.search(/\s/);
  const verb = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
  const decision = VERB_DECISIONS[verb];
  if (decision === undefined) return undefined;

  const feedback =
    firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1).trim();
  return {
    commentId: comment.id,
    actor: comment.author,
    decision,
    ...(feedback !== '' && { feedback }),
  };
}
