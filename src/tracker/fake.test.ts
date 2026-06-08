import { describe, expect, it } from 'vitest';
import { parseCommands } from './command-parser.js';
import { FakeTracker } from './fake.js';

/**
 * The fake is the test double that proves the tracker seam's logic without live
 * GitHub (AGENTS.md → Real testing). These cover the round trip the seam needs:
 * create a card, post a comment, read it back, confirm a re-poll is empty, and
 * confirm re-rendering reuses the same card.
 */
describe('FakeTracker', () => {
  it('mints deterministic card ids and a synthetic url', async () => {
    const tracker = new FakeTracker();

    const first = await tracker.createRunCard({ title: 'A', body: 'a' });
    const second = await tracker.createRunCard({ title: 'B', body: 'b' });

    expect(first).toEqual({ id: 'card-1', url: 'fake://card/card-1' });
    expect(second).toEqual({ id: 'card-2', url: 'fake://card/card-2' });
  });

  it('round-trips the run-id body marker and workmachine label through cardState', async () => {
    // Intake (#32) opens the card with the run id in the body and the
    // workmachine label; the fake must round-trip both so the seam's logic is
    // provable offline (no live GitHub).
    const tracker = new FakeTracker();
    const runId = '20260607T120000Z-tiny-smoke-ab12';

    const card = await tracker.createRunCard({
      title: `Run ${runId}`,
      body: `run-id: ${runId}`,
      labels: ['workmachine'],
    });

    const state = tracker.cardState(card.id);
    expect(state?.title).toBe(`Run ${runId}`);
    expect(state?.body).toContain(runId);
    expect(state?.labels).toEqual(['workmachine']);
  });

  it('round-trips a comment: create, post, read it back, re-poll is empty', async () => {
    const tracker = new FakeTracker({ now: () => '2026-06-08T12:00:00.000Z' });
    const card = await tracker.createRunCard({ title: 'Run', body: 'state' });

    const posted = await tracker.postComment(card, '/approve');
    expect(posted).toEqual({
      id: 'c1',
      author: 'workmachine',
      body: '/approve',
      createdAt: '2026-06-08T12:00:00.000Z',
    });

    const first = await tracker.readCommands(card);
    expect(first.comments).toEqual([posted]);

    // Re-polling with the returned cursor sees nothing new.
    const second = await tracker.readCommands(card, first.cursor);
    expect(second.comments).toEqual([]);

    // A fresh comment shows up on the next poll with that same cursor.
    const again = await tracker.postComment(card, '/reject');
    const third = await tracker.readCommands(card, second.cursor);
    expect(third.comments).toEqual([again]);
  });

  it('scopes comments to their card', async () => {
    const tracker = new FakeTracker();
    const cardA = await tracker.createRunCard({ title: 'A', body: 'a' });
    const cardB = await tracker.createRunCard({ title: 'B', body: 'b' });

    await tracker.postComment(cardA, 'on A');
    await tracker.postComment(cardB, 'on B');

    const onA = await tracker.readCommands(cardA);
    expect(onA.comments.map((c) => c.body)).toEqual(['on A']);
  });

  it('renders the review card idempotently, reusing the same card id', async () => {
    const tracker = new FakeTracker();
    const card = await tracker.createRunCard({ title: 'Run', body: 'v0' });

    await tracker.renderReviewCard({ card, body: 'v1' });
    await tracker.renderReviewCard({ card, body: 'v2' });

    const state = tracker.cardState(card.id);
    expect(state?.body).toBe('v2');
    expect(state?.renderCount).toBe(2);
    // No new card was created by re-rendering.
    expect(tracker.cardState('card-2')).toBeUndefined();
  });

  it('rejects when operating on a card that was never created', async () => {
    const tracker = new FakeTracker();
    const ghost = { id: 'card-99', url: 'fake://card/card-99' };

    await expect(tracker.postComment(ghost, 'x')).rejects.toThrow(/card-99/);
  });

  it('seeds a reviewer comment under a chosen author, distinct from workmachine', async () => {
    const tracker = new FakeTracker();
    const card = await tracker.createRunCard({ title: 'Run', body: 'state' });

    const seeded = await tracker.seedComment(card, '/approve', 'octocat');
    expect(seeded.author).toBe('octocat');

    const { comments } = await tracker.readCommands(card);
    expect(comments).toEqual([seeded]);
  });

  it('cursors past seeded comments: a re-poll is empty until a new one arrives', async () => {
    const tracker = new FakeTracker();
    const card = await tracker.createRunCard({ title: 'Run', body: 'state' });

    await tracker.seedComment(card, '/approve', 'reviewer');
    const first = await tracker.readCommands(card);
    expect(first.comments).toHaveLength(1);

    const second = await tracker.readCommands(card, first.cursor);
    expect(second.comments).toEqual([]);

    const later = await tracker.seedComment(
      card,
      '/request-changes redo it',
      'reviewer',
    );
    const third = await tracker.readCommands(card, second.cursor);
    expect(third.comments).toEqual([later]);
  });
});

describe('polling an issue yields parsed candidate commands', () => {
  it('composes fake.readCommands -> parseCommands end to end', async () => {
    // The fake stands in for a reviewer; the parser turns the polled comments
    // into the candidate commands the next task ingests. No live GitHub.
    const tracker = new FakeTracker();
    const card = await tracker.createRunCard({ title: 'Run', body: 'state' });

    await tracker.seedComment(card, 'looks good, shipping soon', 'octocat');
    await tracker.seedComment(card, '/request-changes add a test', 'reviewer');
    await tracker.seedComment(card, '/approve', 'maintainer');

    const { comments } = await tracker.readCommands(card);
    const commands = parseCommands(comments);

    // The chatter comment is dropped; the two slash commands survive in order,
    // each carrying its stable comment id, author, verb, and trailing text.
    expect(commands).toEqual([
      {
        commentId: 'c2',
        actor: 'reviewer',
        decision: 'request_changes',
        feedback: 'add a test',
      },
      { commentId: 'c3', actor: 'maintainer', decision: 'approve' },
    ]);
  });
});
