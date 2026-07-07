import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProducedArtifact } from '../workflow/schema.js';
import { captureDeclaredArtifacts } from './capture.js';
import type {
  Executor,
  ExecutorResult,
  ResolvedAgentStep,
  ResolvedStep,
  RunContext,
} from './types.js';

/**
 * The `agent` executor: runs an agent step by spawning the Codex CLI in
 * non-interactive mode (`codex exec`) as a subprocess (ADR-0009).
 *
 * An agent step hands a resolved prompt to an autonomous harness working in the
 * run directory; the harness — not the engine — writes the declared artifacts.
 * Enforcement is deterministic: the engine appends a contract block to every
 * resolved prompt stating exactly what the harness must (and must not) do, and
 * after exit verifies each declared `produces` exists. No re-prompt loops.
 *
 * The composition happens AT DISPATCH (in the harness tick), so the prompt
 * recorded on `step_dispatched` is the author text + contract block — the exact
 * bytes the executor later sends. Replay reads the recorded prompt back from
 * the log, never re-composes it.
 */

/**
 * Append the deterministic engine contract block to a resolved author prompt.
 *
 * The block states the step's obligations: write every declared artifact at its
 * path relative to the run directory, stay inside the run directory, and make
 * no git commits or pushes. It is a pure function of its inputs — the same
 * prompt and declarations always compose to the same bytes.
 *
 * @param prompt the fully-resolved author prompt (no `{{...}}` tokens remain).
 * @param produces the artifacts the step declared; paths relative to the run dir.
 */
export function composeAgentPrompt(
  prompt: string,
  produces: readonly ProducedArtifact[],
): string {
  const artifactLines =
    produces.length === 0
      ? ['- This step declares no artifact files.']
      : [
          '- Before you finish, write every one of these declared artifact files (paths are relative to the run directory):',
          ...produces.map((artifact) => `  - \`${artifact.path}\``),
        ];

  return [
    prompt,
    '',
    '---',
    '',
    '## Engine contract',
    '',
    'You are working inside a workflow run directory (your current working directory).',
    '',
    ...artifactLines,
    '- Stay inside the run directory: do not read or write files outside it.',
    '- Do not make git commits and do not push to any remote.',
  ].join('\n');
}

/**
 * Hard wall-clock timeout for one agent invocation. Generous on purpose — an
 * agent step legitimately runs for many minutes — but a hard ceiling so a hung
 * subprocess is killed and recorded as `step_failed` rather than wedging the
 * tick forever. A constant, deliberately not schema-exposed (ADR-0009);
 * per-step tuning is a policy decision the workflow schema does not offer.
 */
export const AGENT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * File codex writes its final agent message into via `--output-last-message`
 * (ADR-0009). It lives inside the run dir so the `--sandbox workspace-write`
 * root (pinned by `-C runDir`) can write it, and is dot-prefixed and NOT a
 * declared `produces` artifact so {@link captureDeclaredArtifacts} never treats
 * it as run output. The executor clears any stale copy before each spawn and
 * reads it back after the child closes, on both success and failure.
 */
export const LAST_MESSAGE_FILE = '.codex-last-message.txt';

/**
 * The slice of a spawned child the agent executor needs: its process id (to
 * signal the whole process group on timeout), kill, and the `error` / `close`
 * lifecycle events. `node:child_process`'s `ChildProcess` satisfies it
 * structurally; tests substitute a fake.
 */
export interface AgentChild {
  /**
   * The child's OS process id, or `undefined` before it has been assigned. Also
   * the id of the child's process group (it is spawned `detached`, so it leads
   * its own group), which the timeout kill signals via a negative pid.
   */
  pid?: number | undefined;
  /** Deliver a signal to the child alone (the fallback when `pid` is absent). */
  kill(signal: NodeJS.Signals): boolean;
  /** The child failed to spawn. */
  on(event: 'error', listener: (err: Error) => void): unknown;
  /** The child exited: a code XOR a terminating signal. */
  on(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
}

/**
 * Spawn-function seam: unit tests inject a fake so they never touch a real
 * `codex` binary; production defaults to `node:child_process`'s `spawn`. The
 * child is spawned `detached` so it leads its own process group, letting the
 * timeout kill reap codex's own subprocesses (sandbox helpers, tool calls)
 * instead of orphaning them.
 */
export type AgentSpawn = (
  command: string,
  args: readonly string[],
  options: { stdio: 'ignore'; detached: boolean },
) => AgentChild;

/**
 * Deliver a signal to a whole process group (a negative pid). Production uses
 * `process.kill`; tests inject a fake to assert the group-kill without a real
 * process group.
 */
export type KillGroup = (pid: number, signal: NodeJS.Signals) => void;

/** Injection points for {@link createAgentExecutor}; tests only. */
export interface AgentExecutorOptions {
  /** Spawn substitute; defaults to the real `node:child_process` spawn. */
  spawnFn?: AgentSpawn;
  /** Timeout override; the production default is {@link AGENT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Group-kill substitute; defaults to `process.kill`. */
  killGroupFn?: KillGroup;
}

/**
 * Build an `agent` executor over an injectable spawn function and timeout.
 *
 * Outcomes (always values, never thrown — the executor seam contract):
 * - `codex` exits zero and every declared artifact exists → `{ ok: true,
 *   artifacts }` with each artifact's path/sha256/size.
 * - non-zero exit, spawn failure, terminating signal, or the wall-clock
 *   timeout killing a hung child → `{ ok: false, error }` → `step_failed`.
 * - zero exit but a declared artifact missing → `{ ok: false, error }`: the
 *   same deterministic enforcement scripts obey, with no re-prompt loop.
 * - a non-`agent` resolved step → `{ ok: false, error }` without spawning.
 */
export function createAgentExecutor(
  options: AgentExecutorOptions = {},
): Executor {
  const spawnFn =
    options.spawnFn ??
    ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
  const timeoutMs = options.timeoutMs ?? AGENT_TIMEOUT_MS;
  const killGroupFn =
    options.killGroupFn ?? ((pid, signal) => void process.kill(pid, signal));

  return {
    async run(step: ResolvedStep, ctx: RunContext): Promise<ExecutorResult> {
      if (step.type !== 'agent') {
        return {
          ok: false,
          error: `agent executor cannot run '${step.type}' step "${step.id}"`,
        };
      }

      const lastMessageFile = join(ctx.runDir, LAST_MESSAGE_FILE);
      // Clear any final message left by a prior attempt so a spawn failure can
      // never attach a stale summary — after the child closes, a file present
      // here was written by this invocation.
      await rm(lastMessageFile, { force: true });

      const exit = await runCodex(
        spawnFn,
        killGroupFn,
        step,
        ctx.runDir,
        lastMessageFile,
        timeoutMs,
      );
      // Read the final message on BOTH outcomes: a failed agent step can still
      // have written one before exiting non-zero.
      const summary = await readLastMessage(lastMessageFile);

      if (!exit.ok) {
        return withSummary({ ok: false, error: exit.error }, summary);
      }

      const captured = await captureDeclaredArtifacts(
        step.produces,
        ctx.runDir,
      );
      return withSummary(captured, summary);
    },
  };
}

/** The production `agent` executor: real spawn, hardcoded generous timeout. */
export const agentExecutor: Executor = createAgentExecutor();

/** Result of the codex subprocess: an ok/fail verdict with a reason on failure. */
type CodexResult = { ok: true } | { ok: false; error: string };

/**
 * Spawn `codex exec` for the step and wait for it to settle. The flag surface
 * (verified against codex v0.137.0, ADR-0009): `-C <runDir>` pins the working
 * root to the run dir, `--sandbox workspace-write` bounds the blast radius,
 * `--skip-git-repo-check` because a run dir is not a git repo, `--json` selects
 * JSONL event output (discarded via `stdio: 'ignore'`; sourcing `sessionRef`
 * from it stays out of scope), `-o <lastMessageFile>` captures the agent's
 * final message into a file the executor reads back as `summary`, `-m <model>`
 * only when the step sets one, and the already-composed prompt as the final
 * argument — exactly the bytes recorded on `step_dispatched`.
 *
 * A wall-clock timer SIGKILLs a hung child's whole process group (the child is
 * spawned `detached`, so it leads its own group and its `-pid` reaches codex's
 * subprocesses too); the kill surfaces as a timeout failure, not a bare signal
 * exit. Never rejects: a spawn error, a signal, a non-zero exit, and a timeout
 * all resolve as `{ ok: false }` values.
 */
function runCodex(
  spawnFn: AgentSpawn,
  killGroupFn: KillGroup,
  step: ResolvedAgentStep,
  runDir: string,
  lastMessageFile: string,
  timeoutMs: number,
): Promise<CodexResult> {
  const args = [
    'exec',
    '-C',
    runDir,
    '--sandbox',
    'workspace-write',
    '--skip-git-repo-check',
    '--json',
    '-o',
    lastMessageFile,
    ...(step.model !== undefined ? ['-m', step.model] : []),
    step.prompt,
  ];

  return new Promise((resolvePromise) => {
    const child = spawnFn('codex', args, { stdio: 'ignore', detached: true });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // Reap the whole process group, not just the direct child: codex spawns
      // its own subprocesses, which orphan if only `child.kill` runs. A negative
      // pid signals the group (child is the detached group leader). Fall back to
      // a direct kill only if the pid never landed.
      const { pid } = child;
      if (pid === undefined) {
        child.kill('SIGKILL');
      } else {
        killGroupFn(-pid, 'SIGKILL');
      }
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      resolvePromise({
        ok: false,
        error: `codex failed to start: ${err.message}`,
      });
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        resolvePromise({
          ok: false,
          error: `codex timed out after ${timeoutMs}ms and was killed`,
        });
        return;
      }
      if (signal !== null) {
        resolvePromise({
          ok: false,
          error: `codex terminated by signal ${signal}`,
        });
        return;
      }
      if (code !== 0) {
        resolvePromise({
          ok: false,
          error: `codex exited with code ${code}`,
        });
        return;
      }
      resolvePromise({ ok: true });
    });
  });
}

/**
 * Read codex's `--output-last-message` file back as the agent's `summary`.
 * Returns `undefined` when the file is absent (codex wrote none) or empty, so
 * the field is omitted rather than set to an empty string. Surrounding
 * whitespace is trimmed; a missing file is an expected outcome, never an error.
 */
async function readLastMessage(
  lastMessageFile: string,
): Promise<string | undefined> {
  try {
    const message = (await readFile(lastMessageFile, 'utf8')).trim();
    return message === '' ? undefined : message;
  } catch {
    return undefined;
  }
}

/**
 * Merge a captured `summary` onto an {@link ExecutorResult} without setting the
 * key to `undefined` (which `exactOptionalPropertyTypes` forbids). Preserves the
 * result's `ok` discriminant and its success/failure payload.
 */
function withSummary(
  result: ExecutorResult,
  summary: string | undefined,
): ExecutorResult {
  return summary === undefined ? result : { ...result, summary };
}
