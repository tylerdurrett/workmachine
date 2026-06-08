import { describe, expect, it } from 'vitest';
import { parseCommands } from './command-parser.js';
import type { TrackerComment } from './types.js';

/**
 * The parser turns raw review-card comments into candidate gate commands. These
 * cover the three recognized verbs, trailing-text capture, and the rule that any
 * non-command comment is silently ignored rather than raising.
 */

/** Build a comment with sensible defaults so each test states only what matters. */
function comment(overrides: Partial<TrackerComment> = {}): TrackerComment {
  return {
    id: 'c1',
    author: 'reviewer',
    body: '',
    createdAt: '2026-06-08T12:00:00.000Z',
    ...overrides,
  };
}

describe('parseCommands', () => {
  it('parses /approve into an approve command with no feedback', () => {
    const result = parseCommands([
      comment({ id: 'c1', author: 'octocat', body: '/approve' }),
    ]);

    expect(result).toEqual([
      { commentId: 'c1', actor: 'octocat', decision: 'approve' },
    ]);
  });

  it('parses /request-changes with its trailing text as feedback', () => {
    const result = parseCommands([
      comment({ body: '/request-changes please add tests' }),
    ]);

    expect(result).toEqual([
      {
        commentId: 'c1',
        actor: 'reviewer',
        decision: 'request_changes',
        feedback: 'please add tests',
      },
    ]);
  });

  it('parses /reject with its trailing text as feedback', () => {
    const result = parseCommands([
      comment({ body: '/reject out of scope for this run' }),
    ]);

    expect(result).toEqual([
      {
        commentId: 'c1',
        actor: 'reviewer',
        decision: 'reject',
        feedback: 'out of scope for this run',
      },
    ]);
  });

  it('ignores non-command comments without erroring', () => {
    const result = parseCommands([
      comment({ id: 'a', body: 'looks good to me!' }),
      comment({ id: 'b', body: '' }),
      comment({ id: 'c', body: '/unknown do a thing' }),
      comment({ id: 'd', body: 'mentioning /approve mid-sentence' }),
    ]);

    expect(result).toEqual([]);
  });

  it('tolerates surrounding whitespace and a bare verb with no feedback', () => {
    const result = parseCommands([
      comment({ id: 'c1', body: '  /approve  ' }),
      comment({ id: 'c2', body: '/request-changes   ' }),
    ]);

    expect(result).toEqual([
      { commentId: 'c1', actor: 'reviewer', decision: 'approve' },
      { commentId: 'c2', actor: 'reviewer', decision: 'request_changes' },
    ]);
  });

  it('preserves comment order and each command its own comment id', () => {
    const result = parseCommands([
      comment({ id: 'c1', body: '/request-changes fix it' }),
      comment({ id: 'c2', body: 'just chatter' }),
      comment({ id: 'c3', body: '/approve' }),
    ]);

    expect(result.map((c) => c.commentId)).toEqual(['c1', 'c3']);
    expect(result.map((c) => c.decision)).toEqual([
      'request_changes',
      'approve',
    ]);
  });
});
