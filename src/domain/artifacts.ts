/**
 * Machine-readable metadata for a single run output (file, etc.).
 *
 * The artifact index is the canonical record of *what* a step produced; the
 * bytes themselves live on the artifact backend (local filesystem first).
 * Pure data: an executor hashes the file and records the result as a fact on
 * a `step_succeeded` event — `decide` never touches the filesystem.
 */
export interface ArtifactIndexEntry {
  /** Stable identifier for this artifact within the run. */
  id: string;
  /** Location of the artifact relative to the run directory. */
  path: string;
  /** SHA-256 hash of the artifact bytes, recorded by the executor. */
  sha256: string;
  /** Size of the artifact in bytes. */
  size: number;
}
