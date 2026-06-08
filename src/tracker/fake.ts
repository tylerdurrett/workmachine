import { BOT_ACTOR } from './types.js';
import type {
  CardRef,
  CommandCursor,
  CreateRunCardInput,
  ReadCommandsResult,
  RenderReviewCardInput,
  TrackerAdapter,
  TrackerComment,
} from './types.js';

/**
 * An in-memory {@link TrackerAdapter} for tests. It holds cards and comments in
 * plain structures and never touches the network, so unit tests can drive the
 * full create → render → comment → poll loop deterministically (no live GitHub).
 *
 * Determinism is the point: ids are minted from monotonic counters (`card-1`…,
 * `c1`…) and `createdAt` comes from an injected clock, so a test that does the
 * same calls in the same order always sees the same ids and timestamps. This is
 * the fake that proves the seam's *logic*; integration against the real tracker
 * is a separate, human-watched live demo (AGENTS.md → Real testing).
 *
 * The cursor is modeled the way CONTEXT.md frames it — a non-canonical fetch
 * optimization, never a correctness boundary: the fake watermarks on a simple
 * comment index, returns everything after it, and advances past what it returned,
 * so a re-poll with the returned cursor is empty until new comments arrive.
 */
export class FakeTracker implements TrackerAdapter {
  /**
   * Author stamped on comments the adapter itself posts (gate prompts, notes).
   * It is the shared {@link BOT_ACTOR} so ingestion's bot-exclusion (ADR-0006,
   * AC6) recognizes the fake's own comments exactly as it does the live adapter's.
   */
  private static readonly DEFAULT_AUTHOR = BOT_ACTOR;

  /** Stored cards, keyed by minted card id. */
  private readonly cards = new Map<string, StoredCard>();

  /** All comments, in post order, across all cards. */
  private readonly comments: StoredComment[] = [];

  /** Monotonic counter behind minted card ids (`card-1`, `card-2`, …). */
  private nextCardSeq = 1;

  /** Monotonic counter behind minted comment ids (`c1`, `c2`, …). */
  private nextCommentSeq = 1;

  /** Injected clock for `createdAt`; defaults to a fixed deterministic stamp. */
  private readonly now: () => string;

  constructor(deps?: { now?: () => string }) {
    this.now = deps?.now ?? (() => '2026-01-01T00:00:00.000Z');
  }

  // The fake does no real I/O, so each method returns an already-resolved (or
  // rejected) promise rather than being `async`. A missing card resolves to a
  // rejected promise via `requireCard`, so callers see the same failure shape
  // they would from the live adapter's network errors.

  createRunCard(input: CreateRunCardInput): Promise<CardRef> {
    const id = `card-${String(this.nextCardSeq)}`;
    this.nextCardSeq += 1;
    this.cards.set(id, {
      title: input.title,
      body: input.body,
      labels: input.labels ?? [],
      renderCount: 0,
    });
    return Promise.resolve({ id, url: `fake://card/${id}` });
  }

  renderReviewCard(input: RenderReviewCardInput): Promise<void> {
    return this.requireCard(input.card.id).then((card) => {
      // Idempotent: the same card id is reused and its body replaced in place,
      // never a new card. renderCount is bumped purely so tests assert reuse.
      card.body = input.body;
      card.renderCount += 1;
    });
  }

  readCommands(
    card: CardRef,
    sinceCursor?: CommandCursor,
  ): Promise<ReadCommandsResult> {
    return this.requireCard(card.id).then(() => {
      const after = cursorIndex(sinceCursor);
      const matched: TrackerComment[] = [];
      let lastIndex = after;
      for (const stored of this.comments) {
        if (stored.cardId !== card.id || stored.index <= after) continue;
        matched.push(stored.comment);
        lastIndex = stored.index;
      }
      return { comments: matched, cursor: { since: String(lastIndex) } };
    });
  }

  postComment(card: CardRef, body: string): Promise<TrackerComment> {
    return this.append(card, body, FakeTracker.DEFAULT_AUTHOR);
  }

  /**
   * Seed a comment authored by an arbitrary handle, simulating a *reviewer*
   * leaving a `/approve` on the card — something the adapter's own
   * {@link postComment} can't express, since coordinator-posted comments are
   * always stamped `workmachine`. Test-only: it lets a parser/polling test
   * stand in for a human reviewer without live GitHub.
   */
  seedComment(
    card: CardRef,
    body: string,
    author: string,
  ): Promise<TrackerComment> {
    return this.append(card, body, author);
  }

  /** Mint, store, and return a comment with the given author. */
  private append(
    card: CardRef,
    body: string,
    author: string,
  ): Promise<TrackerComment> {
    return this.requireCard(card.id).then(() => {
      const comment: TrackerComment = {
        id: `c${String(this.nextCommentSeq)}`,
        author,
        body,
        createdAt: this.now(),
      };
      this.comments.push({
        cardId: card.id,
        index: this.nextCommentSeq,
        comment,
      });
      this.nextCommentSeq += 1;
      return comment;
    });
  }

  /** Read-only peek at a stored card, for test assertions. */
  cardState(id: string): Readonly<StoredCard> | undefined {
    return this.cards.get(id);
  }

  /** Look a card up by id, rejecting if it was never created. */
  private requireCard(id: string): Promise<StoredCard> {
    const card = this.cards.get(id);
    return card === undefined
      ? Promise.reject(new Error(`FakeTracker: unknown card "${id}"`))
      : Promise.resolve(card);
  }
}

/** A card as the fake stores it: content plus a render counter for assertions. */
interface StoredCard {
  title: string;
  body: string;
  labels: string[];
  renderCount: number;
}

/** A comment plus the bookkeeping the fake's cursor watermarks on. */
interface StoredComment {
  /** Which card the comment belongs to. */
  cardId: string;
  /** Monotonic 1-based index, the value the cursor watermarks on. */
  index: number;
  /** The comment as returned to callers. */
  comment: TrackerComment;
}

/**
 * Decode a cursor's `since` watermark back to a comment index. An absent or
 * unparseable cursor means "from the beginning" (index 0) — the cursor is a
 * fetch optimization, so a bad one costs a redundant read, never correctness.
 */
function cursorIndex(cursor: CommandCursor | undefined): number {
  const since = cursor?.since;
  if (since === undefined) return 0;
  const parsed = Number.parseInt(since, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}
