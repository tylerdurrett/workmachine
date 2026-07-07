import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CliDeps } from './cli/index.js';
import { main } from './cli/index.js';
import { JsonlEventLog, foldRun, resolveRunDir } from './run/index.js';
import { FakeTracker } from './tracker/index.js';

/**
 * The retry-path integration smoke (issue #90): the hermetic twin of the agent
 * block in `src/integration.smoke.test.ts`, exercising the coordinator's retry
 * fold (#89) end to end against a *fail-once* stub `codex`. It drives the real
 * CLI front door — `run create <workflow> -> tick` — through the real
 * `agentExecutor`, which spawns plain `codex` off `PATH`; a stub dropped into a
 * temp dir prepended to `PATH` intercepts that spawn with no real binary and no
 * network.
 *
 * What only this test proves: under `retries: 1`, a `step_failed` on the first
 * attempt folds the step back to a fresh `pending` (attempts remain), so a
 * *single* `tick` re-dispatches and the second attempt succeeds — the whole
 * fail-once -> retry -> succeed -> complete arc drains in one tick. The two
 * dispatched prompts are byte-identical (an agent step threads no failure
 * feedback across attempts), and the run reaches `run_completed` with the
 * artifact the stub's *second* invocation wrote on disk.
 *
 * Distinct from #54's separate human-watched live `codex exec` demo: this proof
 * is fully offline. Both the workflow and the deliberately-broken stub are
 * written to temp dirs at runtime (never committed), so a fail-once `codex`
 * never lands in the repo's `workflows/` tree and the run writes only to a temp
 * `runsRoot`, never the repo's gitignored `runs/`.
 *
 * Clock and randomness are injected and fixed, so the minted run id is fully
 * determined (`mintRunId`: timestamp compacted to basic ISO-8601, then the
 * `tiny-agent` slug, then the rand suffix) — asserted exactly.
 */

const now = (): string => '2026-06-07T12:00:00.000Z';
const rand = (): string => 'ab12';
const RUN_ID = '20260607T120000Z-tiny-agent-ab12';

/** The artifact bytes the stub's SECOND (successful) invocation writes. */
const RESULT_TEXT = 'retry-path stub artifact';
const RESULT = `${RESULT_TEXT}\n`;

/**
 * A gateless, one-step agent workflow used only by this smoke. The single agent
 * step declares `retries: 1` and one artifact, and carries a fully static prompt
 * (no `{{...}}` tokens) so both dispatches resolve to byte-identical prompts —
 * the retry threads no failure feedback. Written to a temp dir at runtime rather
 * than committed, so the fail-once stub it pairs with stays out of `workflows/`.
 */
const WORKFLOW_YAML = `slug: tiny-agent
name: Tiny Agent Retry
description: >-
  A gateless one-step agent workflow used only by the retry-path smoke. Its
  single agent step permits one retry and writes a fixed artifact; a fail-once
  stub codex fails the first attempt so the coordinator's retry fold re-dispatches
  it, proving the create -> tick -> run_completed arc drains through one retry in
  a single tick.
steps:
  - id: write
    type: agent
    retries: 1
    prompt: >-
      Write the fixed contract contents to the declared artifact file, then stop.
    produces:
      - id: result
        path: artifacts/result.txt
`;

/**
 * A hermetic, *fail-once* stand-in for the Codex CLI. The agent executor spawns
 * plain `codex` (resolved through `PATH`) with `-C <runDir>` naming the run
 * directory and `-o <lastMessageFile>` the final-message sink; this stub parses
 * both out of argv (its own cwd stays the test's cwd, so every path it touches
 * is anchored under `$run_dir`).
 *
 * Fail-once is driven by a run-local counter file `.stub-codex-attempts` that
 * the executor never touches — it clears only `.codex-last-message.txt` between
 * attempts — so the counter survives across the two spawns of the same run. The
 * dot prefix keeps it out of `captureDeclaredArtifacts` (which only checks the
 * declared `produces`). On the FIRST invocation the counter is absent: the stub
 * creates it, writes to stderr, and exits non-zero (no artifact, no final
 * message). On the SECOND the counter exists: the stub writes the declared
 * artifact and the final message, then exits zero.
 */
const STUB_CODEX = `#!/bin/sh
run_dir=''
last_msg=''
prev=''
for arg in "$@"; do
  case "$prev" in
    -C) run_dir=$arg ;;
    -o) last_msg=$arg ;;
  esac
  prev=$arg
done

counter="$run_dir/.stub-codex-attempts"
if [ ! -f "$counter" ]; then
  printf 'attempted\\n' > "$counter"
  echo 'stub-codex: deliberate first-attempt failure' >&2
  exit 1
fi

mkdir -p "$run_dir/artifacts"
printf '%s\\n' '${RESULT_TEXT}' > "$run_dir/artifacts/result.txt"
printf '%s' 'stub-codex second attempt succeeded' > "$last_msg"
exit 0
`;

/**
 * Restore `process.env.PATH` to a previously-captured value. When the original
 * was unset, `delete` it rather than assigning — a bare `process.env.PATH =
 * undefined` would coerce to the literal string `'undefined'` and poison PATH
 * for later tests.
 */
function restorePath(original: string | undefined): void {
  if (original === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = original;
  }
}

describe('integration retry smoke: fail-once codex drains through one retry in a single tick', () => {
  let runsRoot: string;
  let fixtureDir: string;
  let stubDir: string;
  let workflowPath: string;
  let originalPath: string | undefined;
  let lines: string[];

  /** Deps wiring the CLI to a temp runs root, fixed clock/rand, capturing log. */
  function deps(): Partial<CliDeps> {
    return {
      runsRoot,
      now,
      rand,
      makeTracker: () => new FakeTracker(),
      log: (line) => lines.push(line),
    };
  }

  beforeEach(async () => {
    runsRoot = await mkdtemp(join(tmpdir(), 'wm-retry-smoke-'));
    fixtureDir = await mkdtemp(join(tmpdir(), 'wm-retry-fixture-'));
    stubDir = await mkdtemp(join(tmpdir(), 'wm-stub-codex-'));
    workflowPath = join(fixtureDir, 'workflow.yaml');
    await writeFile(workflowPath, WORKFLOW_YAML);
    await writeFile(join(stubDir, 'codex'), STUB_CODEX, { mode: 0o755 });
    // Prepend the stub dir so the executor's plain `codex` spawn resolves to the
    // fail-once stub — the only `codex` any spawn in this test can reach.
    originalPath = process.env.PATH;
    process.env.PATH = `${stubDir}:${originalPath ?? ''}`;
    lines = [];
    process.env.WORKMACHINE_SANDBOX_REPO = 'acme/widgets';
  });

  afterEach(async () => {
    restorePath(originalPath);
    delete process.env.WORKMACHINE_SANDBOX_REPO;
    await rm(stubDir, { recursive: true, force: true });
    await rm(fixtureDir, { recursive: true, force: true });
    await rm(runsRoot, { recursive: true, force: true });
  });

  it('retries a fail-once agent step to run_completed with the artifact on disk', async () => {
    // Drive the real flow: create against the temp fixture, then tick once. The
    // single tick runs attempt 1 (the stub exits non-zero), folds the step back
    // to pending under its retry budget, re-dispatches, runs attempt 2 (the stub
    // writes the artifact and exits zero), and finalizes the run.
    await main(['run', 'create', workflowPath], deps());
    await main(['tick', RUN_ID], deps());

    const layout = resolveRunDir(runsRoot, RUN_ID);
    const events = new JsonlEventLog(layout.eventsLogPath).read();

    // The run reached its terminal completed event.
    const completed = events.at(-1);
    expect(completed?.type).toBe('run_completed');
    if (completed?.type === 'run_completed') {
      expect(completed.artifacts).toContainEqual(
        expect.objectContaining({ id: 'result', path: 'artifacts/result.txt' }),
      );
    }

    // The artifact bytes the stub's SECOND invocation wrote are on disk, verbatim
    // — proving the successful attempt, not the failed first one, produced them.
    expect(
      readFileSync(join(layout.runDir, 'artifacts/result.txt'), 'utf8'),
    ).toBe(RESULT);

    // The completed state is observable on disk (run.yaml), and a replay fold
    // agrees — the run genuinely finalized, not merely folded in memory.
    const cache = parseYaml(readFileSync(layout.runCachePath, 'utf8')) as {
      status: string;
    };
    expect(cache.status).toBe('completed');
    expect(foldRun(events).status).toBe('completed');
  });
});
