import { spawn } from 'node:child_process';
import { captureDeclaredArtifacts } from './capture.js';
import type {
  Executor,
  ExecutorResult,
  ResolvedStep,
  RunContext,
} from './types.js';

/**
 * The `script` executor: the first executor adapter. It runs a step's
 * already-resolved command and captures the artifacts the step declared it
 * `produces`.
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
 * - a non-`script` resolved step → `{ ok: false, error }` without running
 *   anything: this adapter only knows how to run shell commands, and an
 *   executor's outcome is always a value, never a thrown error.
 */
export const scriptExecutor: Executor = {
  async run(step: ResolvedStep, ctx: RunContext): Promise<ExecutorResult> {
    if (step.type !== 'script') {
      return {
        ok: false,
        error: `script executor cannot run '${step.type}' step "${step.id}"`,
      };
    }

    const exit = await runCommand(step.command, ctx.runDir);
    if (!exit.ok) {
      return { ok: false, error: exit.error };
    }

    return captureDeclaredArtifacts(step.produces, ctx.runDir);
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
