import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scriptExecutor } from './script.js';
import type { ResolvedStep } from './types.js';

/**
 * These run a real local shell command against a real temp run directory — the
 * executor is the side-effecting layer, so its tests exercise actual process
 * spawning and filesystem reads rather than mocks.
 */
describe('scriptExecutor', () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'wm-script-exec-'));
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it('runs the command and captures declared artifacts with correct metadata', async () => {
    const step: ResolvedStep = {
      type: 'script',
      id: 'greet',
      command: 'printf "hi there" > greeting.txt',
      produces: [{ id: 'greeting', path: 'greeting.txt' }],
    };

    const result = await scriptExecutor.run(step, { runDir });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.artifacts).toHaveLength(1);
    const [artifact] = result.artifacts;
    expect(artifact?.id).toBe('greeting');
    expect(artifact?.path).toBe('greeting.txt');

    // sha256 + size must match the bytes actually on disk.
    const bytes = await readFile(join(runDir, 'greeting.txt'));
    expect(artifact?.size).toBe(bytes.byteLength);
    expect(artifact?.size).toBe('hi there'.length);
    expect(artifact?.sha256).toBe(
      createHash('sha256').update(bytes).digest('hex'),
    );
  });

  it('captures multiple declared artifacts in declaration order', async () => {
    const step: ResolvedStep = {
      type: 'script',
      id: 'two',
      command: 'printf one > a.txt && printf twotwo > b.txt',
      produces: [
        { id: 'a', path: 'a.txt' },
        { id: 'b', path: 'b.txt' },
      ],
    };

    const result = await scriptExecutor.run(step, { runDir });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifacts.map((a) => a.id)).toEqual(['a', 'b']);
    expect(result.artifacts.map((a) => a.size)).toEqual([3, 6]);
  });

  it('runs the command with the run directory as its working directory', async () => {
    // `pwd` writing into a relative path proves cwd is the run dir.
    const step: ResolvedStep = {
      type: 'script',
      id: 'where',
      command: 'pwd > where.txt',
      produces: [{ id: 'where', path: 'where.txt' }],
    };

    const result = await scriptExecutor.run(step, { runDir });

    expect(result.ok).toBe(true);
    const contents = (await readFile(join(runDir, 'where.txt'), 'utf8')).trim();
    // macOS symlinks /tmp -> /private/tmp, so compare basenames defensively.
    expect(contents.endsWith(runDir.split('/').pop() ?? '')).toBe(true);
  });

  it('returns { ok: false } when a declared artifact is missing after the run', async () => {
    const step: ResolvedStep = {
      type: 'script',
      id: 'forgetful',
      // Command succeeds but never writes the declared artifact.
      command: 'true',
      produces: [{ id: 'missing', path: 'never-written.txt' }],
    };

    const result = await scriptExecutor.run(step, { runDir });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/missing/);
    expect(result.error).toContain('never-written.txt');
  });

  it('returns { ok: false } when the command exits non-zero', async () => {
    const step: ResolvedStep = {
      type: 'script',
      id: 'boom',
      command: 'exit 3',
      produces: [],
    };

    const result = await scriptExecutor.run(step, { runDir });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/exited with code 3/);
  });

  it('does not capture artifacts when the command fails', async () => {
    // Even though the file exists, a non-zero exit short-circuits to failure.
    const step: ResolvedStep = {
      type: 'script',
      id: 'wrote-then-failed',
      command: 'printf data > out.txt && exit 1',
      produces: [{ id: 'out', path: 'out.txt' }],
    };

    const result = await scriptExecutor.run(step, { runDir });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/exited with code 1/);
  });

  it('succeeds with no artifacts when the step declares none', async () => {
    const step: ResolvedStep = {
      type: 'script',
      id: 'sideless',
      command: 'true',
      produces: [],
    };

    const result = await scriptExecutor.run(step, { runDir });

    expect(result).toEqual({ ok: true, artifacts: [] });
  });

  it('returns { ok: false } for a non-script resolved step without running anything', async () => {
    // The script adapter only knows shell commands; an agent variant is another
    // executor's job, so it fails as a value rather than throwing or spawning.
    const step: ResolvedStep = {
      type: 'agent',
      id: 'draft',
      prompt: 'Write a draft.',
      produces: [],
    };

    const result = await scriptExecutor.run(step, { runDir });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/cannot run 'agent' step/);
  });
});
