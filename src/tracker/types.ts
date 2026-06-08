/**
 * The tracker seam: the engine projects run state onto a human-visible card and
 * reads human commands back from it, behind this one small interface
 * (CONTEXT.md → Tracker adapter; ADR-0004). The first concrete implementation is
 * GitHub Issues over raw `fetch` (ADR-0008), with an in-memory fake for tests.
 *
 * The vocabulary here is deliberately tracker-agnostic: card / comment / command
 * / cursor, never "issue" (CONTEXT.md → Language). The GitHub-ness lives only in
 * the GitHub adapter; nothing in this interface names a provider, so a future
 * Trello or other tracker drops in behind the same contract.
 *
 * Projection is useful but not canonical (CONTEXT.md → Projection): these methods
 * render coordinator state outward and surface raw commands inward, but the
 * event log remains the truth. Parsing a comment into a `/approve` command and
 * deciding what runs next happen elsewhere — the adapter only moves cards and
 * comments across the wire.
 */

/**
 * A handle to a created tracker surface (CONTEXT.md → Tracker surface): the
 * stable id the adapter addresses the card by, plus a human-openable url. The
 * harness holds this between ticks to re-render the review card and poll its
 * comments; it carries no card content, only identity.
 */
export interface CardRef {
  /** Provider-stable id of the card (the GitHub issue number, as a string). */
  id: string;
  /** Human-openable url for the card surface. */
  url: string;
}

/**
 * What it takes to open a run's tracker surface. `title` and `body` are the
 * initial rendering of run state; `labels` are optional provider-side tags (the
 * GitHub adapter uses these for the `workmachine` marker, task #32). The run-id
 * idempotency marker lives in the rendered body, not here — this input is just
 * the content to create the card with.
 */
export interface CreateRunCardInput {
  /** The card's title line. */
  title: string;
  /** The card's body — the rendered projection of run state. */
  body: string;
  /** Optional provider-side labels to tag the card with. */
  labels?: string[];
}

/**
 * What it takes to (re-)render the single review card. Carries the existing
 * {@link CardRef} so the render reuses that same surface rather than creating a
 * new one — the render is idempotent (ADR-0004): re-rendering replaces the card
 * body in place.
 */
export interface RenderReviewCardInput {
  /** The existing card to render into. */
  card: CardRef;
  /** The new body to render onto the card. */
  body: string;
}

/**
 * The actor a tracker stamps on the engine's *own* comments (gate prompts, the
 * rendered review card, coordinator notes) — the bot identity, as opposed to a
 * human reviewer. Ingestion excludes comments authored by this actor so the
 * engine never re-ingests its own output as a command (CONTEXT.md → Command;
 * ADR-0006, AC6). It is the GitHub `workmachine` bot/label name; the in-memory
 * fake stamps the same value on `postComment`, so the exclusion is provider-
 * agnostic and single-sourced here at the seam.
 */
export const BOT_ACTOR = 'workmachine';

/**
 * One raw comment read off a card. The `id` is the tracker's stable comment id —
 * the canonical idempotency key the event log dedups on (CONTEXT.md → Command;
 * ADR-0006), not the cursor. The adapter returns comments verbatim; turning a
 * comment body into a `/approve` command is command parsing (task #34), not the
 * adapter's job.
 */
export interface TrackerComment {
  /** Stable, provider-assigned comment id — the canonical idempotency key. */
  id: string;
  /** The comment's author (a provider handle). */
  author: string;
  /** The raw comment body, unparsed. */
  body: string;
  /** ISO-8601 instant the comment was created. */
  createdAt: string;
}

/**
 * An opaque polling optimization for reading new comments — never a correctness
 * boundary (CONTEXT.md → Command; ADR-0006). Comment-id dedup in the event log
 * is the real idempotency key; the cursor only spares the poller from re-reading
 * comments it has already seen. The `etag` carries GitHub's `ETag` so a later
 * poll can issue a conditional request (`If-None-Match` → `304`); `since` is a
 * coarse timestamp watermark. Both are hints: dropping a cursor costs a redundant
 * read, never correctness.
 */
export interface CommandCursor {
  /** Last-seen ETag, for a conditional re-poll (`If-None-Match`). */
  etag?: string;
  /** Coarse timestamp watermark of the last comment seen. */
  since?: string;
}

/**
 * The result of a comment poll: the comments new since the supplied cursor, plus
 * an advanced cursor to feed the next poll. Re-polling with the returned cursor
 * yields no comments until new ones arrive.
 */
export interface ReadCommandsResult {
  /** Comments observed since the supplied cursor (all of them, if none given). */
  comments: TrackerComment[];
  /** Advanced cursor to pass to the next {@link TrackerAdapter.readCommands}. */
  cursor: CommandCursor;
}

/**
 * The tracker adapter interface: the only seam through which the engine touches
 * a tracker. All methods are async — the live adapter does network I/O. Every
 * implementation (the GitHub adapter, the in-memory fake) honors this same shape,
 * so the harness is written once against the contract and never against a
 * provider.
 */
export interface TrackerAdapter {
  /**
   * Create the run's tracker surface and return a handle to it. Called once per
   * run, at the front door, to open the card the run's state projects onto.
   */
  createRunCard(input: CreateRunCardInput): Promise<CardRef>;

  /**
   * Render (or re-render) the single review card. Idempotent: it reuses the
   * card named by {@link RenderReviewCardInput.card}, replacing its body in
   * place rather than creating a new card on each call (ADR-0004).
   */
  renderReviewCard(input: RenderReviewCardInput): Promise<void>;

  /**
   * Read new comments on a card since the cursor. The `card` parameter names
   * which surface to poll — the brief writes this as `readCommands(sinceCursor)`,
   * but a poller must say which card it is polling, so the card is explicit and
   * the cursor optional. With no cursor, returns every comment; the returned
   * {@link ReadCommandsResult.cursor} advances past what was read. Returns raw
   * comments — parsing them into commands is task #34, not here.
   */
  readCommands(
    card: CardRef,
    sinceCursor?: CommandCursor,
  ): Promise<ReadCommandsResult>;

  /**
   * Post a comment to the card and return the created comment (including its
   * canonical comment id). Used to surface coordinator-side notes back onto the
   * tracker.
   */
  postComment(card: CardRef, body: string): Promise<TrackerComment>;
}
