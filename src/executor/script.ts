import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ArtifactIndexEntry } from '../domain/artifacts.js';
import type {
  Executor,
  ExecutorResult,
  ResolvedStep,
  RunContext,
} from './types.js';

/**
 * The `script` executor: the first (and, in the gateless slice, only) executor
 * adapter. It runs a step's already-resolved command and captures the artifacts
 * the step declared it `produces`.
 *
 * This is the determinism boundary's only side-effecting layer (CONTEXT.md):
 * it spawns a shell, lets the command write files into the run directory, then
 * hashes and sizes each declared artifact. The command is run with the run
 * directory as its working directory, so a step's `produces` paths (relative to
 * the run dir, per architecture.md) line up with what the command writes.
 *
 * Outcomes:
 * - command exits zero and every declared artifact exists → `{ ok: true,
 *   artifacts }`, mapped by the harness to `step_succeeded`.
 * - command exits non-zero, or fails to spawn, or a declared artifact is
 *   missing afterward → `{ ok: false, error }`, mapped to `step_failed`.
 */
export const scriptExecutor: Executor = {
  async run(step: ResolvedStep, ctx: RunContext): Promise<ExecutorResult> {
    const exit = await runCommand(step.command, ctx.runDir);
    if (!exit.ok) {
      return { ok: false, error: exit.error };
    }

    const artifacts: ArtifactIndexEntry[] = [];
    for (const declared of step.produces) {
      const absolutePath = resolve(ctx.runDir, declared.path);
      const captured = await captureArtifact(
        declared.id,
        declared.path,
        absolutePath,
      );
      if (!captured.ok) {
        return { ok: false, error: captured.error };
      }
      artifacts.push(captured.entry);
    }

    return { ok: true, artifacts };
  },
};

/** Result of spawning the command: an ok/fail verdict with a reason on failure. */
type CommandResult = { ok: true } | { ok: false; error: string };

/**
 * Run `command` through the shell with `cwd` as the working directory. Resolves
 * `{ ok: true }` only on a zero exit code; a non-zero exit, a signal, or a
 * spawn failure resolves `{ ok: false }` with a human-readable reason. Never
 * rejects, so the executor's outcome is always a value, not a thrown error.
 */
function runCommand(command: string, cwd: string): Promise<CommandResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: 'ignore',
    });

    child.on('error', (err) => {
      resolvePromise({
        ok: false,
        error: `command failed to start: ${err.message}`,
      });
    });

    child.on('close', (code, signal) => {
      if (signal !== null) {
        resolvePromise({
          ok: false,
          error: `command terminated by signal ${signal}`,
        });
        return;
      }
      if (code !== 0) {
        resolvePromise({
          ok: false,
          error: `command exited with code ${code}`,
        });
        return;
      }
      resolvePromise({ ok: true });
    });
  });
}

/** Result of capturing one declared artifact from disk. */
type CaptureResult =
  | { ok: true; entry: ArtifactIndexEntry }
  | { ok: false; error: string };

/**
 * Stat and SHA-256 the file a declared artifact points at, building its
 * {@link ArtifactIndexEntry}. A missing file (or any read error) is a failure —
 * the contract is that a declared `produces` artifact must exist after a
 * successful run.
 */
async function captureArtifact(
  id: string,
  path: string,
  absolutePath: string,
): Promise<CaptureResult> {
  let size: number;
  try {
    const stats = await stat(absolutePath);
    if (!stats.isFile()) {
      return {
        ok: false,
        error: `declared artifact "${id}" at "${path}" is not a file`,
      };
    }
    size = stats.size;
  } catch {
    return {
      ok: false,
      error: `declared artifact "${id}" missing at "${path}"`,
    };
  }

  const sha256 = await hashFile(absolutePath);
  return { ok: true, entry: { id, path, sha256, size } };
}

/** Compute the SHA-256 hex digest of a file by streaming its bytes. */
function hashFile(absolutePath: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(absolutePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolvePromise(hash.digest('hex')));
  });
}
