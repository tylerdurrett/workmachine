import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CliDeps } from './cli/index.js';
import { main } from './cli/index.js';
import { JsonlEventLog, foldRun, resolveRunDir } from './run/index.js';

/**
 * The slice's integration smoke (issue #13): the one test that drives the *real*
 * CLI front door against the *real* committed `workflows/tiny-smoke/` package,
 * proving the whole gateless engine spine end to end — `run create` -> `tick` ->
 * `run_completed` — with a verifiable artifact and the event log folded to
 * `completed`.
 *
 * Everything else in the suite exercises one layer in isolation (the resolver,
 * the executor, the harness loop, the CLI dispatcher) against inline fixture
 * YAML. This test is deliberately different: it resolves the actual committed
 * package files from the repo so a broken `workflow.yaml` or `greet.sh` fails
 * here, and it uses no mock executor — it spawns the real shell. Its job is the
 * gateless demoable outcome from the acceptance criteria: a run with its final
 * artifact on disk and `run.yaml` folded to `completed`.
 *
 * The committed package lives at the repo root (`workflows/tiny-smoke/`); this
 * test file is `src/integration.smoke.test.ts`, so the repo root is one level up
 * from `src/`. We resolve the package paths relative to this file rather than
 * cwd so the test is location-independent. The run instance is written to a temp
 * `runsRoot`, never the repo's gitignored `runs/`, and is torn down afterward.
 *
 * Clock and randomness are injected and fixed, so the minted run id is fully
 * determined (`mintRunId`: timestamp compacted to basic ISO-8601, then slug,
 * then the rand suffix) — we assert it exactly.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = resolve(
  repoRoot,
  'workflows',
  'tiny-smoke',
  'workflow.yaml',
);
const scriptPath = resolve(repoRoot, 'workflows', 'tiny-smoke', 'greet.sh');

const now = (): string => '2026-06-07T12:00:00.000Z';
const rand = (): string => 'ab12';
const RUN_ID = '20260607T120000Z-tiny-smoke-ab12';

const GREETING = 'Hello, World!\n';

describe('integration smoke: gateless spine (create -> tick -> completed)', () => {
  let runsRoot: string;
  let lines: string[];

  /** Deps wiring the CLI to a temp runs root, fixed clock/rand, capturing log. */
  function deps(): Partial<CliDeps> {
    return { runsRoot, now, rand, log: (line) => lines.push(line) };
  }

  beforeEach(async () => {
    runsRoot = await mkdtemp(join(tmpdir(), 'wm-smoke-'));
    lines = [];
  });

  afterEach(async () => {
    await rm(runsRoot, { recursive: true, force: true });
  });

  it('runs the committed tiny-smoke package end to end', async () => {
    // Drive the real flow: create against the committed package, then tick once.
    await main(
      [
        'run',
        'create',
        workflowPath,
        '--input',
        'name=World',
        '--input',
        `scriptPath=${scriptPath}`,
      ],
      deps(),
    );
    await main(['tick', RUN_ID], deps());

    // The run instance was scaffolded with its canonical files.
    const layout = resolveRunDir(runsRoot, RUN_ID);
    const events = new JsonlEventLog(layout.eventsLogPath).read();

    // The full gateless spine, in order.
    expect(events.map((e) => e.type)).toEqual([
      'run_created',
      'step_dispatched',
      'step_succeeded',
      'run_completed',
    ]);

    // The dispatched command is fully resolved — no tokens, real artifact path.
    const dispatched = events[1];
    expect(dispatched?.type).toBe('step_dispatched');
    if (dispatched?.type === 'step_dispatched') {
      expect(dispatched.command).not.toMatch(/\{\{/);
      expect(dispatched.command).toContain('artifacts/greeting.txt');
    }

    // The step recorded exactly one artifact with a real hash and size.
    const succeeded = events[2];
    expect(succeeded?.type).toBe('step_succeeded');
    if (succeeded?.type === 'step_succeeded') {
      expect(succeeded.artifacts).toHaveLength(1);
      const [artifact] = succeeded.artifacts;
      expect(artifact).toMatchObject({
        id: 'greeting',
        path: 'artifacts/greeting.txt',
      });
      expect(artifact?.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof artifact?.size).toBe('number');
      expect(artifact?.size).toBeGreaterThan(0);
    }

    // The artifact bytes the committed greet.sh wrote are on disk, verbatim.
    expect(
      readFileSync(join(layout.runDir, 'artifacts/greeting.txt'), 'utf8'),
    ).toBe(GREETING);

    // The terminal run event carries the same final artifact.
    const completed = events.at(-1);
    expect(completed?.type).toBe('run_completed');
    if (completed?.type === 'run_completed') {
      expect(completed.artifacts).toHaveLength(1);
      expect(completed.artifacts[0]).toMatchObject({
        id: 'greeting',
        path: 'artifacts/greeting.txt',
      });
    }

    // The gateless demoable outcome: run.yaml folded to `completed`, carrying
    // the final artifact. Asserting the file content (not just an in-memory
    // fold) proves the completed state is observable on disk per AC#3 — and the
    // independent fold confirms the cache matches a replay of the log.
    const cache = parseYaml(readFileSync(layout.runCachePath, 'utf8')) as {
      status: string;
      artifacts: { id: string; path: string }[];
    };
    expect(cache.status).toBe('completed');
    expect(cache.artifacts).toContainEqual(
      expect.objectContaining({
        id: 'greeting',
        path: 'artifacts/greeting.txt',
      }),
    );
    expect(foldRun(events).status).toBe('completed');
  });
});
