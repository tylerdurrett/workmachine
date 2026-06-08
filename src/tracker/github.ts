import { z } from 'zod';
import type {
  CardRef,
  CreateRunCardInput,
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
 * The skeleton (#31) stood up config resolution, the authenticated HTTP client,
 * and a `verifyAccess` smoke path that proves live reachability. Intake (#32)
 * implements `createRunCard` (open the issue carrying the run-id body marker and
 * the `workmachine` label) and `postComment`; `renderReviewCard` (#33) and the
 * ETag-cursor `readCommands` (#34) stay stubbed until their tasks own them. The
 * human-watched live demo against the sandbox repo is deferred to its own task.
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
 * Shape of the issue fields we read off a created issue (`POST .../issues`): the
 * `number` becomes the {@link CardRef.id} and `html_url` its human-openable url.
 */
const issueSchema = z.object({
  number: z.number(),
  html_url: z.string(),
});

/** Shape of the comment fields we read off a created comment (`POST .../comments`). */
const commentSchema = z.object({
  id: z.number(),
  user: z.object({ login: z.string() }).nullable(),
  body: z.string().nullable(),
  created_at: z.string(),
});

/**
 * The label the GitHub adapter tags every run card with, so a run's issues are
 * findable as machine-opened (ADR-0008; intake task #32).
 */
const WORKMACHINE_LABEL = 'workmachine';

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

  /**
   * Open the run's card as a GitHub issue: `POST /repos/{owner}/{repo}/issues`
   * with the rendered title/body and the `workmachine` label. The run-id
   * idempotency marker rides in `input.body` (rendered by the caller), so the
   * card carries the run id that later anchors it. Returns the issue number (as
   * the card id) and its `html_url`.
   */
  async createRunCard(input: CreateRunCardInput): Promise<CardRef> {
    const { owner, repo } = this.config;
    const json = await this.request('POST', `/repos/${owner}/${repo}/issues`, {
      title: input.title,
      body: input.body,
      labels: [WORKMACHINE_LABEL, ...(input.labels ?? [])],
    });
    const issue = issueSchema.parse(json);
    return { id: String(issue.number), url: issue.html_url };
  }

  renderReviewCard(): Promise<void> {
    return notImplemented('renderReviewCard', 33);
  }

  readCommands(): Promise<ReadCommandsResult> {
    return notImplemented('readCommands', 34);
  }

  /**
   * Post a comment to the card's issue: `POST .../issues/{id}/comments`. Returns
   * the created comment, including its provider-assigned id — the canonical
   * idempotency key the event log dedups on (ADR-0006).
   */
  async postComment(card: CardRef, body: string): Promise<TrackerComment> {
    const { owner, repo } = this.config;
    const json = await this.request(
      'POST',
      `/repos/${owner}/${repo}/issues/${card.id}/comments`,
      { body },
    );
    const comment = commentSchema.parse(json);
    return {
      id: String(comment.id),
      author: comment.user?.login ?? '',
      body: comment.body ?? '',
      createdAt: comment.created_at,
    };
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
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
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
