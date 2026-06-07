import { existsSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonlEventLog, resolveRunDir } from '../run/index.js';
import { main } from './main.js';

/**
 * The CLI-level acceptance test (issue #12, criterion 4): drive the real `main`
 * dispatcher with injected deps — a temp runs root, a deterministic clock and
 * randomness, and a capturing log. Because clock and randomness are fixed, the
 * minted run id is fully determined, so we can compute it and pass it to `tick`.
 */

const now = (): string => '2026-06-07T12:00:00.000Z';
const rand = (): string => 'ab12';
const RUN_ID = '20260607T120000Z-tiny-smoke-ab12';

const WORKFLOW_YAML = `
slug: tiny-smoke
inputs:
  msg: {}
steps:
  - id: greet
    type: script
    run: "printf '{{inputs.msg}}' > {{artifacts.out.path}}"
    produces:
      - id: out
        path: artifacts/out.txt
`;

describe('main (CLI dispatch)', () => {
  let runsRoot: string;
  let workflowPath: string;
  let lines: string[];

  /** Deps wiring the CLI to a temp runs root, fixed clock/rand, capturing log. */
  function deps(): {
    runsRoot: string;
    now: () => string;
    rand: () => string;
    log: (line: string) => void;
  } {
    return { runsRoot, now, rand, log: (line) => lines.push(line) };
  }

  beforeEach(async () => {
    runsRoot = await mkdtemp(join(tmpdir(), 'wm-cli-'));
    workflowPath = join(runsRoot, 'workflow.yaml');
    writeFileSync(workflowPath, WORKFLOW_YAML, 'utf8');
    lines = [];
  });

  afterEach(async () => {
    await rm(runsRoot, { recursive: true, force: true });
  });

  it('run create then tick produces the expected run dir and events', async () => {
    await main(['run', 'create', workflowPath, '--input', 'msg=hi'], deps());
    await main(['tick', RUN_ID], deps());

    const layout = resolveRunDir(runsRoot, RUN_ID);
    expect(existsSync(layout.runDir)).toBe(true);
    expect(existsSync(layout.eventsLogPath)).toBe(true);
    expect(existsSync(layout.workflowSnapshotPath)).toBe(true);

    const events = new JsonlEventLog(layout.eventsLogPath).read();
    expect(events.map((e) => e.type)).toEqual([
      'run_created',
      'step_dispatched',
      'step_succeeded',
      'run_completed',
    ]);
    const created = events[0];
    expect(created?.type).toBe('run_created');
    if (created?.type === 'run_created') {
      expect(created.inputs).toEqual({ msg: 'hi' });
    }
  });

  it('refuses a --run-id collision', async () => {
    const id = 'fixed-id';
    await main(['run', 'create', workflowPath, '--run-id', id], deps());
    await expect(
      main(['run', 'create', workflowPath, '--run-id', id], deps()),
    ).rejects.toThrow(/already exists/);
  });

  it('throws on an unknown command', async () => {
    await expect(main(['bogus'], deps())).rejects.toThrow(/usage/);
  });
});
