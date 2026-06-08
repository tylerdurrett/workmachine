import { z } from 'zod';
import type {
  CardRef,
  ReadCommandsResult,
  TrackerAdapter,
  TrackerComment,
} from './types.js';

/**
 * The GitHub Issues tracker adapter (ADR-0008): the first concrete
 * {@link TrackerAdapter}, talking to GitHub over raw `fetch` — not Octokit. The
 * surface is tiny (create an issue, post a comment, list comments), and command
 * polling (#34) needs explicit ETag conditional requests, so the HTTP path is
 * kept transparent rather than buried in a client library.
 *
 * This slice (#31) is the *skeleton*: config resolution, the authenticated HTTP
 * client, and a `verifyAccess` smoke path that proves live reachability. The four
 * adapter methods are stubbed — their behavior (the run-id body marker, the
 * `workmachine` label, ETag cursor semantics) is decided by #32/#33/#34, and
 * implementing them here would pre-empt those decisions. The human-watched live
 * demo against the sandbox repo is deferred to its own task.
 *
 * GitHub-specific naming stays inside this file (CONTEXT.md → Language): the
 * interface speaks card / comment / command / cursor; only here do those map onto
 * issues, issue comments, and ETags.
 */

/** GitHub's default API origin; overridable in tests via the deps `baseUrl`. */
const DEFAULT_BASE_URL = 'https://api.github.com';

/** The pinned REST API version GitHub recommends sending on every request. */
const API_VERSION = '2022-11-28';

/**
 * The resolved address + credential the adapter needs to talk to one repo. The
 * `token` is the one global secret (`WORKMACHINE_GITHUB_TOKEN`); `owner`/`repo`
 * are the operator-supplied target, split from an `owner/name` string.
 */
export interface GitHubConfig {
  /** Fine-grained PAT, the one global secret. */
  token: string;
  /** Repository owner (login or org). */
  owner: string;
  /** Repository name. */
  repo: string;
}

/** Impure collaborators the adapter needs; production defaults fill any gap. */
interface GitHubTrackerDeps {
  /** HTTP transport; defaults to the global `fetch` (Node ≥22). */
  fetch?: typeof fetch;
  /** API origin; defaults to {@link DEFAULT_BASE_URL}. */
  baseUrl?: string;
}

/** Shape of the `GET /repos/{owner}/{repo}` response fields we read. */
const repoSchema = z.object({ full_name: z.string() });

/**
 * Resolve the GitHub config from the environment and an optional repo override.
 * Pure in its inputs: it reads `WORKMACHINE_GITHUB_TOKEN` for the credential and
 * resolves the target repo from `opts.repo` (the operator's per-run `--repo`)
 * else `WORKMACHINE_SANDBOX_REPO` (the local-dev fallback, ADR-0008). The repo
 * string must be `owner/name` with both halves non-empty.
 *
 * @throws if the token is missing, no repo can be resolved, or the repo string
 *   is not a well-formed `owner/name`.
 */
export function resolveGitHubConfig(
  env: Record<string, string | undefined>,
  opts?: { repo?: string },
): GitHubConfig {
  const token = env.WORKMACHINE_GITHUB_TOKEN;
  if (token === undefined || token === '') {
    throw new Error(
      'WORKMACHINE_GITHUB_TOKEN is not set (a fine-grained PAT is required)',
    );
  }

  const repoSpec = opts?.repo ?? env.WORKMACHINE_SANDBOX_REPO;
  if (repoSpec === undefined || repoSpec === '') {
    throw new Error(
      'no target repo: pass a repo override or set WORKMACHINE_SANDBOX_REPO (owner/name)',
    );
  }

  const [owner, repo, ...rest] = repoSpec.split('/');
  if (
    rest.length > 0 ||
    owner === undefined ||
    owner === '' ||
    repo === undefined ||
    repo === ''
  ) {
    throw new Error(`malformed repo "${repoSpec}": expected "owner/name"`);
  }

  return { token, owner, repo };
}

/**
 * The GitHub Issues {@link TrackerAdapter}. Constructed with a resolved config
 * and optional injected `fetch`/`baseUrl` (production defaults: global `fetch`,
 * the public API origin), so tests drive it offline through a stub transport.
 */
export class GitHubTracker implements TrackerAdapter {
  private readonly config: GitHubConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(config: GitHubConfig, deps?: GitHubTrackerDeps) {
    this.config = config;
    this.fetchImpl = deps?.fetch ?? fetch;
    this.baseUrl = deps?.baseUrl ?? DEFAULT_BASE_URL;
  }

  /**
   * The smoke path / live-reachability proof: `GET /repos/{owner}/{repo}`,
   * returning the repo's `full_name`. Used to confirm the token reaches the
   * target repo before a run leans on the adapter (the human-watched live demo
   * is a separate task).
   */
  async verifyAccess(): Promise<{ fullName: string }> {
    const { owner, repo } = this.config;
    const json = await this.request('GET', `/repos/${owner}/${repo}`);
    const parsed = repoSchema.parse(json);
    return { fullName: parsed.full_name };
  }

  // The four adapter methods are intentionally unimplemented in this slice
  // (#31). Their behavior is owned by later tasks; stubbing avoids pre-empting
  // those decisions while the seam and the live client are stood up.

  createRunCard(): Promise<CardRef> {
    return notImplemented('createRunCard', 32);
  }

  renderReviewCard(): Promise<void> {
    return notImplemented('renderReviewCard', 33);
  }

  readCommands(): Promise<ReadCommandsResult> {
    return notImplemented('readCommands', 34);
  }

  postComment(): Promise<TrackerComment> {
    return notImplemented('postComment', 32);
  }

  /**
   * The single authenticated HTTP entry point. Sets the Bearer credential and
   * the headers GitHub expects (Accept, API version, User-Agent), and maps any
   * non-2xx response to a thrown Error carrying the status and GitHub's message.
   * Returns the parsed JSON body as `unknown` — callers narrow it with zod.
   */
  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': API_VERSION,
        'User-Agent': 'work-machine',
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });

    if (!response.ok) {
      const message = await readErrorMessage(response);
      throw new Error(
        `GitHub ${method} ${path} failed: ${String(response.status)} ${message}`,
      );
    }

    return response.json();
  }
}

/**
 * The shared rejection for an adapter method this slice (#31) leaves stubbed,
 * naming the task that owns its implementation.
 */
function notImplemented(method: string, taskNumber: number): Promise<never> {
  return Promise.reject(
    new Error(
      `GitHubTracker.${method} not implemented yet (task #${String(taskNumber)})`,
    ),
  );
}

/** GitHub error bodies carry a top-level `message`; tolerate its absence. */
const errorSchema = z.object({ message: z.string() }).partial();

/**
 * Best-effort extraction of GitHub's error `message` from a failed response,
 * falling back to the status text when the body is missing or not the expected
 * shape — error reporting must never itself throw.
 */
async function readErrorMessage(response: Response): Promise<string> {
  try {
    const parsed = errorSchema.safeParse(await response.json());
    if (parsed.success && parsed.data.message !== undefined) {
      return parsed.data.message;
    }
  } catch {
    // fall through to status text
  }
  return response.statusText;
}
