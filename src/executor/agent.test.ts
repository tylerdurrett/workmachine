import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AgentSpawn,
  composeAgentPrompt,
  createAgentExecutor,
  type KillGroup,
  LAST_MESSAGE_FILE,
  STDERR_TAIL_MAX_BYTES,
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
  pid: number | undefined;
  /** Piped stderr, as `stdio: ['ignore', 'ignore', 'pipe']` yields. */
  readonly stderr = new EventEmitter();

  kill(signal: NodeJS.Signals): boolean {
    this.killedWith = signal;
    // Deliver the kill asynchronously, like the OS would.
    queueMicrotask(() => this.emit('close', null, signal));
    return true;
  }
}

/** One recorded spawn call: the command, args, and options the executor passed. */
interface SpawnCall {
  command: string;
  args: string[];
  options: { stdio: ['ignore', 'ignore', 'pipe']; detached: boolean };
  child: FakeChild;
}

/**
 * Build an injectable spawn that records every call and hands the new child to
 * `script` so each test drives the lifecycle it needs (exit code, signal,
 * spawn error, or hang). Each child is given a stable fake pid so a test can
 * assert the process-group kill targets its negative.
 */
function fakeSpawn(script: (child: FakeChild) => void): {
  spawnFn: AgentSpawn;
  calls: SpawnCall[];
} {
  const calls: SpawnCall[] = [];
  const spawnFn: AgentSpawn = (command, args, options) => {
    const child = new FakeChild();
    child.pid = 4000 + calls.length;
    calls.push({ command, args: [...args], options, child });
    script(child);
    return child;
  };
  return { spawnFn, calls };
}

/**
 * A fake process-group killer paired with the recorded spawn calls: records
 * every (pid, signal) it is asked to deliver, and — like an OS SIGKILL settling
 * the group — closes the matching child (matched by `|pid|`). So a timeout test
 * proves the negative-pid group kill without a real process group.
 */
function fakeKillGroup(calls: SpawnCall[]): {
  killGroupFn: KillGroup;
  killGroupCalls: { pid: number; signal: NodeJS.Signals }[];
} {
  const killGroupCalls: { pid: number; signal: NodeJS.Signals }[] = [];
  const killGroupFn: KillGroup = (pid, signal) => {
    killGroupCalls.push({ pid, signal });
    for (const call of calls) {
      if (call.child.pid === -pid) {
        call.child.emit('close', null, signal);
      }
    }
  };
  return { killGroupFn, killGroupCalls };
}

/** A child that exits with `code` on the next tick. */
const exitWith =
  (code: number) =>
  (child: FakeChild): void => {
    queueMicrotask(() => child.emit('close', code, null));
  };

/**
 * A child that writes each `chunk` to its (piped) stderr — one `data` event
 * apiece, so a test exercises the executor's accumulate-and-truncate path — and
 * then closes with `code`. When `streamError` is given, the stderr stream emits
 * it (as a real `Readable` does on EPIPE / premature destroy) after the chunks
 * and before the close: with no `error` listener that bare emit would throw
 * synchronously, so it drives the executor's swallow path; the `data` chunks are
 * the tail buffered before the break.
 */
const emitStderrThenExit =
  (chunks: readonly string[], code: number, streamError?: Error) =>
  (child: FakeChild): void => {
    queueMicrotask(() => {
      for (const chunk of chunks) {
        child.stderr.emit('data', Buffer.from(chunk));
      }
      if (streamError !== undefined) {
        child.stderr.emit('error', streamError);
      }
      child.emit('close', code, null);
    });
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
    // Spawned detached so it leads its own process group (timeout group-kill),
    // with only stderr piped (for the failure tail); stdin/stdout stay ignored.
    expect(calls[0]?.options.detached).toBe(true);
    expect(calls[0]?.options.stdio).toEqual(['ignore', 'ignore', 'pipe']);
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

  it('carries a bounded stderr tail in the failure when codex exits non-zero', async () => {
    const { spawnFn } = fakeSpawn(
      emitStderrThenExit(
        ['thread panicked at foo.rs:1\n', 'note: run with RUST_BACKTRACE=1\n'],
        3,
      ),
    );
    const executor = createAgentExecutor({ spawnFn });

    const result = await executor.run(agentStep(), { runDir });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The original exit reason survives, with the stderr tail appended.
    expect(result.error).toMatch(/exited with code 3/);
    expect(result.error).toContain('codex stderr');
    expect(result.error).toContain('thread panicked at foo.rs:1');
    expect(result.error).toContain('note: run with RUST_BACKTRACE=1');
  });

  it('truncates an over-long stderr to the last STDERR_TAIL_MAX_BYTES', async () => {
    // Emit more than the cap across two chunks; only the trailing bytes survive.
    const head = 'X'.repeat(STDERR_TAIL_MAX_BYTES);
    const tailMarker = 'THE-LAST-LINE-OF-STDERR';
    const { spawnFn } = fakeSpawn(emitStderrThenExit([head, tailMarker], 1));
    const executor = createAgentExecutor({ spawnFn });

    const result = await executor.run(agentStep(), { runDir });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The trailing marker is kept, but the head is truncated to the cap: only
    // the last STDERR_TAIL_MAX_BYTES bytes survive, so some leading X's are lost.
    expect(result.error).toContain(tailMarker);
    const retainedX = (result.error.match(/X/g) ?? []).length;
    expect(retainedX).toBe(STDERR_TAIL_MAX_BYTES - tailMarker.length);
  });

  it('contains a stderr stream error and still resolves the step normally', async () => {
    // The piped stderr breaks (EPIPE) mid-run. With no `error` listener Node
    // would throw it uncaught; the executor must swallow it, keep the tail it
    // already buffered, and resolve the non-zero exit as a failure.
    const { spawnFn } = fakeSpawn(
      emitStderrThenExit(
        ['partial diagnostics before the break\n'],
        3,
        new Error('EPIPE: broken pipe'),
      ),
    );
    const executor = createAgentExecutor({ spawnFn });

    const result = await executor.run(agentStep(), { runDir });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/exited with code 3/);
    // The tail buffered before the stream error still rides along on the failure.
    expect(result.error).toContain('partial diagnostics before the break');
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

  it('SIGKILLs the codex process group (negative pid) at the wall-clock timeout and fails the step', async () => {
    // The child never closes on its own; only the timeout's kill ends it.
    const { spawnFn, calls } = fakeSpawn(() => {});
    const { killGroupFn, killGroupCalls } = fakeKillGroup(calls);
    const executor = createAgentExecutor({
      spawnFn,
      killGroupFn,
      timeoutMs: 20,
    });

    const result = await executor.run(agentStep(), { runDir });

    const pid = calls[0]?.child.pid;
    expect(pid).toBeDefined();
    // The whole group is reaped via the negative pid — not just the direct child.
    expect(killGroupCalls).toEqual([
      { pid: -(pid as number), signal: 'SIGKILL' },
    ]);
    expect(calls[0]?.child.killedWith).toBeUndefined();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/timed out after 20ms/);
  });

  it('falls back to a direct child kill at the timeout when the child has no pid', async () => {
    const { spawnFn, calls } = fakeSpawn((child) => {
      child.pid = undefined;
    });
    const { killGroupFn, killGroupCalls } = fakeKillGroup(calls);
    const executor = createAgentExecutor({
      spawnFn,
      killGroupFn,
      timeoutMs: 20,
    });

    const result = await executor.run(agentStep(), { runDir });

    expect(killGroupCalls).toHaveLength(0);
    expect(calls[0]?.child.killedWith).toBe('SIGKILL');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/timed out after 20ms/);
  });

  it('contains an ESRCH throw from the timeout kill and still fails the step (no reject)', async () => {
    // Real race: codex self-exits just before the timer fires, its `close` not
    // yet delivered. The timer fires and the group kill throws ESRCH (the group
    // is already gone). The executor must swallow the throw; the in-flight
    // `close` (Node still delivers it for an already-exited child) then resolves
    // the step as a timeout failure — not an uncaught crash or a hung promise.
    const { spawnFn, calls } = fakeSpawn(() => {});
    const killGroupFn: KillGroup = () => {
      // The OS still delivers `close` for the already-exited child.
      queueMicrotask(() => calls[0]?.child.emit('close', null, null));
      throw new Error('kill ESRCH');
    };
    const executor = createAgentExecutor({
      spawnFn,
      killGroupFn,
      timeoutMs: 20,
    });

    const result = await executor.run(agentStep(), { runDir });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/timed out after 20ms/);
  });

  it('fails as a value (never throws) when the stale last-message file cannot be cleared', async () => {
    // Force the pre-spawn clear to reject deterministically: a directory sits
    // where the last-message file path points, so `rm(..., { force: true })`
    // rejects with EISDIR (force suppresses only a missing file). The seam must
    // contain that as a failure value and never spawn a child.
    const { spawnFn, calls } = fakeSpawn(exitWith(0));
    await mkdir(join(runDir, LAST_MESSAGE_FILE));
    const executor = createAgentExecutor({ spawnFn });

    const result = await executor.run(agentStep(), { runDir });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/could not clear stale last-message file/);
    expect(calls).toHaveLength(0);
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
