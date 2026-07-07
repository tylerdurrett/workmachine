import { createHash } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureDeclaredArtifacts } from './capture.js';

/**
 * These run against a real temp run directory: capture is the side-effecting,
 * filesystem-reading half of every executor, so its tests exercise actual
 * `stat` / stream reads rather than mocks — including the failure paths that the
 * never-throws executor seam must map to `{ ok: false }` values.
 */
describe('captureDeclaredArtifacts', () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'wm-capture-'));
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it('captures a declared artifact with path/sha256/size', async () => {
    await writeFile(join(runDir, 'out.txt'), 'hello', 'utf8');

    const result = await captureDeclaredArtifacts(
      [{ id: 'out', path: 'out.txt' }],
      runDir,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]?.size).toBe('hello'.length);
    expect(result.artifacts[0]?.sha256).toBe(
      createHash('sha256').update('hello').digest('hex'),
    );
  });

  it('returns { ok: false } when a declared artifact is missing', async () => {
    const result = await captureDeclaredArtifacts(
      [{ id: 'gone', path: 'gone.txt' }],
      runDir,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/missing/);
    expect(result.error).toContain('gone.txt');
  });

  it('contains a hash-time read error as a failure value (stats ok, unreadable at read)', async () => {
    // The file exists so `stat` succeeds, but it is unreadable when `hashFile`
    // opens its stream — the delete/chmod-after-stat race that must resolve to a
    // failure value, never throw through the never-throws executor seam.
    const unreadable = join(runDir, 'locked.txt');
    await writeFile(unreadable, 'secret', 'utf8');
    await chmod(unreadable, 0o000);

    // A throw here would fail the test — proving the rejection is contained.
    // (afterEach's forced recursive rm removes the file regardless of its mode.)
    const result = await captureDeclaredArtifacts(
      [{ id: 'locked', path: 'locked.txt' }],
      runDir,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/could not be read/);
    expect(result.error).toContain('locked');
    expect(result.error).toContain('locked.txt');
  });
});
