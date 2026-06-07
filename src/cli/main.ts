#!/usr/bin/env node
import { randomInt } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
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
 *  - `run create <workflowPath> [--input k=v ...] [--run-id <id>]`
 *  - `tick <runId>`
 */

/** The 4-char run-id suffix alphabet (lowercase + digits). */
const RAND_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** The impure collaborators the CLI needs; all default to production behavior. */
export interface CliDeps {
  /** Absolute path to the `runs/` root. Defaults to `<cwd>/runs`. */
  runsRoot: string;
  /** Clock returning an ISO-8601 instant. Defaults to wall-clock. */
  now: () => string;
  /** Randomness for the minted run-id suffix. Defaults to crypto-backed. */
  rand: () => string;
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

/** Fill in production defaults for any dependency the caller did not inject. */
function resolveDeps(deps?: Partial<CliDeps>): CliDeps {
  return {
    runsRoot: deps?.runsRoot ?? join(process.cwd(), 'runs'),
    now: deps?.now ?? (() => new Date().toISOString()),
    rand: deps?.rand ?? defaultRand,
    log:
      deps?.log ??
      ((line) => {
        console.log(line);
      }),
  };
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
  const { runsRoot, now, rand, log } = resolveDeps(deps);
  const [command, ...rest] = argv;

  if (command === 'run' && rest[0] === 'create') {
    const { values, positionals } = parseArgs({
      args: rest.slice(1),
      allowPositionals: true,
      options: {
        input: { type: 'string', multiple: true },
        'run-id': { type: 'string' },
      },
    });
    const workflowPath = positionals[0];
    if (workflowPath === undefined) {
      throw new Error(
        'usage: workmachine run create <workflowPath> [--input k=v ...] [--run-id <id>]',
      );
    }
    const { runId } = runCreate({
      workflowPath,
      inputs: parseInputs(values.input ?? []),
      runId: values['run-id'],
      runsRoot,
      now,
      rand,
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
    await runTick({ runId, runsRoot, now });
    log(`ticked ${runId}`);
    return;
  }

  throw new Error(
    'usage: workmachine <run create <workflowPath> [--input k=v ...] [--run-id <id>] | tick <runId>>',
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
