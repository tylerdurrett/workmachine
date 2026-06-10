import { describe, expect, it } from 'vitest';
import { composeAgentPrompt } from './agent.js';

describe('composeAgentPrompt', () => {
  it('appends the exact contract block after the author prompt (multiple artifacts)', () => {
    const composed = composeAgentPrompt('Write a haiku about pelicans.', [
      { id: 'draft', path: 'artifacts/draft.md' },
      { id: 'notes', path: 'artifacts/notes.txt' },
    ]);

    expect(composed).toBe(
      [
        'Write a haiku about pelicans.',
        '',
        '---',
        '',
        '## Engine contract',
        '',
        'You are working inside a workflow run directory (your current working directory).',
        '',
        '- Before you finish, write every one of these declared artifact files (paths are relative to the run directory):',
        '  - `artifacts/draft.md`',
        '  - `artifacts/notes.txt`',
        '- Stay inside the run directory: do not read or write files outside it.',
        '- Do not make git commits and do not push to any remote.',
      ].join('\n'),
    );
  });

  it('states that no artifacts are declared when produces is empty', () => {
    const composed = composeAgentPrompt('Just think.', []);

    expect(composed).toBe(
      [
        'Just think.',
        '',
        '---',
        '',
        '## Engine contract',
        '',
        'You are working inside a workflow run directory (your current working directory).',
        '',
        '- This step declares no artifact files.',
        '- Stay inside the run directory: do not read or write files outside it.',
        '- Do not make git commits and do not push to any remote.',
      ].join('\n'),
    );
  });

  it('is deterministic: the same inputs always compose to the same bytes', () => {
    const produces = [{ id: 'out', path: 'out.txt' }];
    expect(composeAgentPrompt('p', produces)).toBe(
      composeAgentPrompt('p', produces),
    );
  });

  it('preserves the author prompt verbatim at the top', () => {
    const author = 'Line one.\n\nLine two with `backticks` and --- dashes.';
    const composed = composeAgentPrompt(author, []);
    expect(composed.startsWith(`${author}\n`)).toBe(true);
  });
});
