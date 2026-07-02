import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AgentSpawn,
  composeAgentPrompt,
  createAgentExecutor,
  LAST_MESSAGE_FILE,
} from './agent.js';
import type { ResolvedAgentStep } from './types.js';

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

/**
 * A fake spawned child: an EventEmitter whose `kill` records the signal and
 * emits the `close` the OS would deliver. Tests script its lifecycle, so the
 * executor's unit tests never touch a real `codex` binary.
 */
class FakeChild extends EventEmitter {
  killedWith: NodeJS.Signals | undefined;

  kill(signal: NodeJS.Signals): boolean {
    this.killedWith = signal;
    // Deliver the kill asynchronously, like the OS would.
    queueMicrotask(() => this.emit('close', null, signal));
    return true;
  }
}

/** One recorded spawn call: the command and args the executor passed. */
interface SpawnCall {
  command: string;
  args: string[];
  child: FakeChild;
}

/**
 * Build an injectable spawn that records every call and hands the new child to
 * `script` so each test drives the lifecycle it needs (exit code, signal,
 * spawn error, or hang).
 */
function fakeSpawn(script: (child: FakeChild) => void): {
  spawnFn: AgentSpawn;
  calls: SpawnCall[];
} {
  const calls: SpawnCall[] = [];
  const spawnFn: AgentSpawn = (command, args) => {
    const child = new FakeChild();
    calls.push({ command, args: [...args], child });
    script(child);
    return child;
  };
  return { spawnFn, calls };
}

/** A child that exits with `code` on the next tick. */
const exitWith =
  (code: number) =>
  (child: FakeChild): void => {
    queueMicrotask(() => child.emit('close', code, null));
  };

describe('agentExecutor', () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'wm-agent-exec-'));
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  function agentStep(
    overrides: Partial<ResolvedAgentStep> = {},
  ): ResolvedAgentStep {
    return {
      type: 'agent',
      id: 'draft',
      prompt: 'Write a draft.',
      produces: [],
      ...overrides,
    };
  }

  /**
   * A child that writes `message` into the `--output-last-message` file (as the
   * real codex would) and then closes with `code` — so a test can drive the
   * executor's final-message read path on either outcome.
   */
  const writeMessageThenExit =
    (message: string, code: number) =>
    (child: FakeChild): void => {
      void writeFile(join(runDir, LAST_MESSAGE_FILE), message, 'utf8').then(
        () => child.emit('close', code, null),
      );
    };

  it('spawns codex exec with the exact flag surface and the prompt as the final argument', async () => {
    const { spawnFn, calls } = fakeSpawn(exitWith(0));
    const executor = createAgentExecutor({ spawnFn });

    const result = await executor.run(
      agentStep({ prompt: 'Write a haiku.', model: 'smart-model' }),
      { runDir },
    );

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe('codex');
    expect(calls[0]?.args).toEqual([
      'exec',
      '-C',
      runDir,
      '--sandbox',
      'workspace-write',
      '--skip-git-repo-check',
      '--json',
      '-o',
      join(runDir, LAST_MESSAGE_FILE),
      '-m',
      'smart-model',
      'Write a haiku.',
    ]);
  });

  it('omits -m when the step sets no model', async () => {
    const { spawnFn, calls } = fakeSpawn(exitWith(0));
    const executor = createAgentExecutor({ spawnFn });

    await executor.run(agentStep({ prompt: 'Write a haiku.' }), { runDir });

    expect(calls[0]?.args).toEqual([
      'exec',
      '-C',
      runDir,
      '--sandbox',
      'workspace-write',
      '--skip-git-repo-check',
      '--json',
      '-o',
      join(runDir, LAST_MESSAGE_FILE),
      'Write a haiku.',
    ]);
  });

  it('captures declared artifacts with path/sha256/size on a zero exit', async () => {
    // The "agent" wrote its declared artifact before exiting zero.
    await writeFile(join(runDir, 'draft.md'), 'a fine draft', 'utf8');
    const { spawnFn } = fakeSpawn(exitWith(0));
    const executor = createAgentExecutor({ spawnFn });

    const result = await executor.run(
      agentStep({ produces: [{ id: 'draft', path: 'draft.md' }] }),
      { runDir },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifacts).toHaveLength(1);
    const [artifact] = result.artifacts;
    expect(artifact?.id).toBe('draft');
    expect(artifact?.path).toBe('draft.md');

    const bytes = await readFile(join(runDir, 'draft.md'));
    expect(artifact?.size).toBe(bytes.byteLength);
    expect(artifact?.sha256).toBe(
      createHash('sha256').update(bytes).digest('hex'),
    );
  });

  it('reads the codex final message into summary on a zero exit', async () => {
    const { spawnFn } = fakeSpawn(
      writeMessageThenExit('Wrote the draft; see draft.md.\n', 0),
    );
    const executor = createAgentExecutor({ spawnFn });

    const result = await executor.run(agentStep(), { runDir });

    expect(result.ok).toBe(true);
    expect(result.summary).toBe('Wrote the draft; see draft.md.');
  });

  it('reads the final message into summary even when the step fails', async () => {
    const { spawnFn } = fakeSpawn(
      writeMessageThenExit('Got stuck on the second stanza.', 3),
    );
    const executor = createAgentExecutor({ spawnFn });

    const result = await executor.run(agentStep(), { runDir });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/exited with code 3/);
    expect(result.summary).toBe('Got stuck on the second stanza.');
  });

  it('omits summary when codex writes no final message', async () => {
    const { spawnFn } = fakeSpawn(exitWith(0));
    const executor = createAgentExecutor({ spawnFn });

    const result = await executor.run(agentStep(), { runDir });

    expect(result.ok).toBe(true);
    expect(result.summary).toBeUndefined();
  });

  it('never populates sessionRef (its cheap source is discarded)', async () => {
    const { spawnFn } = fakeSpawn(writeMessageThenExit('done', 0));
    const executor = createAgentExecutor({ spawnFn });

    const result = await executor.run(agentStep(), { runDir });

    expect(result.sessionRef).toBeUndefined();
  });

  it('fails when a declared artifact is missing after a zero exit', async () => {
    const { spawnFn } = fakeSpawn(exitWith(0));
    const executor = createAgentExecutor({ spawnFn });

    const result = await executor.run(
      agentStep({ produces: [{ id: 'missing', path: 'never-written.md' }] }),
      { runDir },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/missing/);
    expect(result.error).toContain('never-written.md');
  });

  it('maps a non-zero exit to a failure without capturing artifacts', async () => {
    // Even though the declared artifact exists, a non-zero exit short-circuits.
    await writeFile(join(runDir, 'draft.md'), 'written then failed', 'utf8');
    const { spawnFn } = fakeSpawn(exitWith(3));
    const executor = createAgentExecutor({ spawnFn });

    const result = await executor.run(
      agentStep({ produces: [{ id: 'draft', path: 'draft.md' }] }),
      { runDir },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/exited with code 3/);
  });

  it('maps a spawn error to a failure', async () => {
    const { spawnFn } = fakeSpawn((child) => {
      queueMicrotask(() => child.emit('error', new Error('ENOENT: no codex')));
    });
    const executor = createAgentExecutor({ spawnFn });

    const result = await executor.run(agentStep(), { runDir });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/failed to start/);
    expect(result.error).toContain('ENOENT');
  });

  it('maps a terminating signal to a failure', async () => {
    const { spawnFn } = fakeSpawn((child) => {
      queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
    });
    const executor = createAgentExecutor({ spawnFn });

    const result = await executor.run(agentStep(), { runDir });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/terminated by signal SIGTERM/);
  });

  it('kills a hung child at the wall-clock timeout and fails the step', async () => {
    // The child never closes on its own; only the timeout's kill ends it.
    const { spawnFn, calls } = fakeSpawn(() => {});
    const executor = createAgentExecutor({ spawnFn, timeoutMs: 20 });

    const result = await executor.run(agentStep(), { runDir });

    expect(calls[0]?.child.killedWith).toBe('SIGKILL');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/timed out after 20ms/);
  });

  it('returns { ok: false } for a non-agent resolved step without spawning', async () => {
    const { spawnFn, calls } = fakeSpawn(exitWith(0));
    const executor = createAgentExecutor({ spawnFn });

    const result = await executor.run(
      { type: 'script', id: 'greet', command: 'true', produces: [] },
      { runDir },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/cannot run 'script' step/);
    expect(calls).toHaveLength(0);
  });
});
