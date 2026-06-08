#!/usr/bin/env node
import { randomInt, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { GateDecision } from '../domain/index.js';
import {
  GitHubTracker,
  type TrackerAdapter,
  resolveGitHubConfig,
} from '../tracker/index.js';
import { runCommand } from './command.js';
import { runCreate } from './run-create.js';
import { runTick } from './tick.js';

/**
 * The CLI entry point: parse argv, dispatch to a command, and report.
 *
 * This is the outermost layer of the determinism boundary — the only place that
 * reads the real wall-clock and real randomness (CONTEXT.md → determinism
 * boundary; ADR-0003). Every impure dependency is injected through {@link
 * CliDeps} with production defaults, so the whole CLI can be driven from a test
 * with a fixed clock, fixed randomness, a temp runs root, and a capturing log —
 * which makes the minted run id deterministic and the end-to-end flow assertable.
 *
 * Commands:
 *  - `run create <workflowPath> [--input k=v ...] [--run-id <id>] [--repo owner/name]`
 *  - `tick <runId>`
 *  - `command <runId> <decision> [text]`
 */

/** The 4-char run-id suffix alphabet (lowercase + digits). */
const RAND_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** The decision verbs the `command` flow accepts, mirroring `GateDecision`. */
const GATE_DECISIONS: readonly GateDecision[] = [
  'approve',
  'request_changes',
  'reject',
];

/** Usage line for the `command` flow, shared by its arg checks. */
const COMMAND_USAGE =
  'usage: workmachine command <runId> <approve|request_changes|reject> [text]';

/** The impure collaborators the CLI needs; all default to production behavior. */
export interface CliDeps {
  /** Absolute path to the `runs/` root. Defaults to `<cwd>/runs`. */
  runsRoot: string;
  /** Clock returning an ISO-8601 instant. Defaults to wall-clock. */
  now: () => string;
  /** Randomness for the minted run-id suffix. Defaults to crypto-backed. */
  rand: () => string;
  /**
   * Mint the synthetic comment id a manual command carries — its canonical
   * idempotency key (ADR-0006). Defaults to a crypto UUID; tests inject a fixed
   * minter so the appended `command_received` is fully determined.
   */
  mintCommentId: () => string;
  /**
   * Build the tracker the run's card opens on, given the resolved `owner/name`
   * repo. Defaults to a live {@link GitHubTracker} from
   * {@link resolveGitHubConfig}; tests inject a {@link FakeTracker} so intake
   * runs offline (no live GitHub).
   */
  makeTracker: (repo: string) => TrackerAdapter;
  /** Output sink. Defaults to `console.log`. */
  log: (line: string) => void;
}

/** A crypto-backed 4-char suffix over {@link RAND_ALPHABET}. */
function defaultRand(): string {
  let suffix = '';
  for (let i = 0; i < 4; i += 1) {
    suffix += RAND_ALPHABET[randomInt(RAND_ALPHABET.length)];
  }
  return suffix;
}

/**
 * Build the live tracker for a resolved repo: a {@link GitHubTracker} over the
 * config resolved from `process.env` plus the operator-supplied repo (ADR-0008 —
 * the engine hard-codes no tracker repo). The repo string was already validated
 * as `owner/name` when it was resolved, so passing it through here re-resolves
 * the same config rather than reaching for the env fallback.
 */
function defaultMakeTracker(repo: string): TrackerAdapter {
  return new GitHubTracker(resolveGitHubConfig(process.env, { repo }));
}

/** Fill in production defaults for any dependency the caller did not inject. */
function resolveDeps(deps?: Partial<CliDeps>): CliDeps {
  return {
    runsRoot: deps?.runsRoot ?? join(process.cwd(), 'runs'),
    now: deps?.now ?? (() => new Date().toISOString()),
    rand: deps?.rand ?? defaultRand,
    mintCommentId: deps?.mintCommentId ?? (() => randomUUID()),
    makeTracker: deps?.makeTracker ?? defaultMakeTracker,
    log:
      deps?.log ??
      ((line) => {
        console.log(line);
      }),
  };
}

/** Narrow a raw argv token to a {@link GateDecision}, or throw a usage error. */
function parseDecision(raw: string | undefined): GateDecision {
  if (
    raw !== undefined &&
    (GATE_DECISIONS as readonly string[]).includes(raw)
  ) {
    return raw as GateDecision;
  }
  throw new Error(COMMAND_USAGE);
}

/** Parse `--input k=v` pairs into a record, splitting on the first `=`. */
function parseInputs(pairs: readonly string[]): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq === -1) {
      throw new Error(`invalid --input '${pair}': expected key=value`);
    }
    inputs[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return inputs;
}

/**
 * Run the CLI: parse `argv` (already sliced past `node script`), dispatch to a
 * command, and write status through `deps.log`.
 *
 * @param argv the command-line arguments (e.g. `process.argv.slice(2)`).
 * @param deps optional dependency overrides; production defaults fill the rest.
 * @throws on an unknown/missing command, a malformed `--input`, or any error a
 *   command surfaces (e.g. a `--run-id` collision).
 */
export async function main(
  argv: string[],
  deps?: Partial<CliDeps>,
): Promise<void> {
  const { runsRoot, now, rand, mintCommentId, makeTracker, log } =
    resolveDeps(deps);
  const [command, ...rest] = argv;

  if (command === 'run' && rest[0] === 'create') {
    const { values, positionals } = parseArgs({
      args: rest.slice(1),
      allowPositionals: true,
      options: {
        input: { type: 'string', multiple: true },
        'run-id': { type: 'string' },
        repo: { type: 'string' },
      },
    });
    const workflowPath = positionals[0];
    if (workflowPath === undefined) {
      throw new Error(
        'usage: workmachine run create <workflowPath> [--input k=v ...] [--run-id <id>] [--repo owner/name]',
      );
    }
    // The card's repo is operator-supplied per run via `--repo`, falling back to
    // the local-dev `WORKMACHINE_SANDBOX_REPO` (ADR-0008). It is recorded on
    // `card_created` so the run is self-describing; the live adapter
    // (`makeTracker`) re-resolves it alongside the token via resolveGitHubConfig.
    const repo = values.repo ?? process.env.WORKMACHINE_SANDBOX_REPO;
    if (repo === undefined || repo === '') {
      throw new Error(
        'no target repo: pass --repo owner/name or set WORKMACHINE_SANDBOX_REPO',
      );
    }
    const { runId } = await runCreate({
      workflowPath,
      inputs: parseInputs(values.input ?? []),
      runId: values['run-id'],
      runsRoot,
      now,
      rand,
      tracker: makeTracker(repo),
      repo,
    });
    log(`created run ${runId}`);
    log(`next: workmachine tick ${runId}`);
    return;
  }

  if (command === 'tick') {
    const runId = rest[0];
    if (runId === undefined) {
      throw new Error('usage: workmachine tick <runId>');
    }
    await runTick({ runId, runsRoot, now, makeTracker });
    log(`ticked ${runId}`);
    return;
  }

  if (command === 'command') {
    const [runId, decisionArg, feedback] = rest;
    if (runId === undefined) {
      throw new Error(COMMAND_USAGE);
    }
    const decision = parseDecision(decisionArg);
    runCommand({
      runId,
      decision,
      ...(feedback !== undefined && { feedback }),
      runsRoot,
      mintCommentId,
      now,
    });
    log(`recorded ${decision} command on run ${runId}`);
    log(`next: workmachine tick ${runId}`);
    return;
  }

  throw new Error(
    'usage: workmachine <run create <workflowPath> [--input k=v ...] [--run-id <id>] [--repo owner/name] | tick <runId> | command <runId> <approve|request_changes|reject> [text]>',
  );
}

// Run-guard: execute only when invoked as a script (`node .../main.js ...`), so
// importing this module in tests does not trigger the CLI.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
