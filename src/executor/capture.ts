import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ArtifactIndexEntry } from '../domain/artifacts.js';
import type { ProducedArtifact } from '../workflow/schema.js';
import type { ExecutorResult } from './types.js';

/**
 * Shared artifact capture: the post-run half of every executor adapter.
 *
 * Whatever side effect an executor performs (a shell command, an agent
 * harness), the contract afterward is the same: every artifact the step
 * declared in `produces` must exist in the run directory, and each is captured
 * as a full {@link ArtifactIndexEntry} (path, sha256, size). A missing declared
 * artifact is a failure value — never a thrown error — mapped by the harness to
 * `step_failed`.
 */

/**
 * Existence-check and capture every declared artifact, in declaration order.
 * Declared `path`s are relative to `runDir` (architecture.md → run-dir layout).
 * Returns `{ ok: true, artifacts }` only when every declared artifact exists;
 * the first missing or unreadable one short-circuits to `{ ok: false }`.
 */
export async function captureDeclaredArtifacts(
  produces: readonly ProducedArtifact[],
  runDir: string,
): Promise<ExecutorResult> {
  const artifacts: ArtifactIndexEntry[] = [];
  for (const declared of produces) {
    const absolutePath = resolve(runDir, declared.path);
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
