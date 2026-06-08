import { z } from 'zod';
import { markBotComment } from './types.js';
import type {
  CardRef,
  CommandCursor,
  CreateRunCardInput,
  ReadCommandsResult,
  RenderReviewCardInput,
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
 * the `workmachine` label) and `postComment`; review-card projection (#33)
 * implements `renderReviewCard` (PATCH the issue body in place); command polling
 * (#34) implements `readCommands` (GET the issue comments with an `If-None-Match`
 * conditional request driven by the cursor's ETag). The human-watched live demo
 * against the sandbox repo is deferred to its own task.
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

  /**
   * Render (re-render) the single review card by replacing its issue body in
   * place: `PATCH /repos/{owner}/{repo}/issues/{id}` with `{ body }` (ADR-0004,
   * ADR-0008). Idempotent — it always targets the card named by `input.card`,
   * never opening a new issue, so a re-render or a `request_changes` revision
   * lands on the same card. Returns `void`: the body is not read back, and
   * `request()` already throws on any non-2xx, so success is simply not throwing.
   */
  async renderReviewCard(input: RenderReviewCardInput): Promise<void> {
    const { owner, repo } = this.config;
    await this.request(
      'PATCH',
      `/repos/${owner}/${repo}/issues/${input.card.id}`,
      {
        body: input.body,
      },
    );
  }

  /**
   * Poll the card's issue for new comments:
   * `GET /repos/{owner}/{repo}/issues/{id}/comments`. The cursor's `etag` rides
   * along as `If-None-Match` so an unchanged comment list comes back `304 Not
   * Modified` — GitHub costs us no rate-limit budget and we return no comments
   * with the cursor unchanged. On a `200`, the response `ETag` becomes the next
   * cursor's `etag`, and the latest comment's `created_at` its coarse `since`
   * watermark (CONTEXT.md → Command; ADR-0006).
   *
   * Returned comments are raw {@link TrackerComment}s. Parsing them into
   * `/approve`-style commands is the command parser's job; ingesting them into
   * the log with comment-id dedup is the next task. The cursor here is only a
   * fetch optimization, never an exactly-once boundary.
   */
  async readCommands(
    card: CardRef,
    sinceCursor?: CommandCursor,
  ): Promise<ReadCommandsResult> {
    const { owner, repo } = this.config;
    const response = await this.send(
      'GET',
      `/repos/${owner}/${repo}/issues/${card.id}/comments`,
      sinceCursor?.etag !== undefined
        ? { 'If-None-Match': sinceCursor.etag }
        : undefined,
    );

    // 304: nothing changed since the cursor's ETag — no comments, same cursor.
    if (response.status === 304) {
      return { comments: [], cursor: sinceCursor ?? {} };
    }

    const comments = z
      .array(commentSchema)
      .parse(await response.json())
      .map(toTrackerComment);

    const etag = response.headers.get('ETag') ?? undefined;
    const since = comments.at(-1)?.createdAt ?? sinceCursor?.since;
    return {
      comments,
      cursor: {
        ...(etag !== undefined && { etag }),
        ...(since !== undefined && { since }),
      },
    };
  }

  /**
   * Post a comment to the card's issue: `POST .../issues/{id}/comments`. The
   * outgoing body is stamped with the {@link markBotComment} marker so ingestion
   * recognizes it as the engine's own and never re-ingests it as a command
   * (ADR-0006, AC6) — author-matching can't, since GitHub stamps the author with
   * the token's own login. Returns the created comment, including its
   * provider-assigned id — the canonical idempotency key the event log dedups on.
   */
  async postComment(card: CardRef, body: string): Promise<TrackerComment> {
    const { owner, repo } = this.config;
    const json = await this.request(
      'POST',
      `/repos/${owner}/${repo}/issues/${card.id}/comments`,
      { body: markBotComment(body) },
    );
    return toTrackerComment(commentSchema.parse(json));
  }

  /**
   * The single authenticated HTTP entry point used by the body-returning
   * methods. Sends the request via {@link send}, and returns the parsed JSON
   * body as `unknown` — callers narrow it with zod. `send` already threw on any
   * non-2xx, so reaching here means success.
   */
  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const response = await this.send(method, path, undefined, body);
    return response.json();
  }

  /**
   * The low-level authenticated request: sets the Bearer credential and the
   * headers GitHub expects (Accept, API version, User-Agent), merges any caller
   * `extraHeaders` (e.g. `If-None-Match` for a conditional poll), and returns
   * the raw {@link Response} so callers can read response headers like `ETag`.
   *
   * It throws on a non-2xx response with the status and GitHub's message —
   * except `304 Not Modified`, which a conditional request expects and the
   * caller handles, so it is passed back rather than treated as an error.
   */
  private async send(
    method: string,
    path: string,
    extraHeaders?: Record<string, string>,
    body?: unknown,
  ): Promise<Response> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': API_VERSION,
        'User-Agent': 'workmachine',
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
        ...extraHeaders,
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });

    if (!response.ok && response.status !== 304) {
      const message = await readErrorMessage(response);
      throw new Error(
        `GitHub ${method} ${path} failed: ${String(response.status)} ${message}`,
      );
    }

    return response;
  }
}

/**
 * Map GitHub's comment shape onto the tracker-agnostic {@link TrackerComment}:
 * `id`→`String(id)` (the canonical idempotency key), `user.login`→`author`, and
 * `created_at`→`createdAt`. A missing `user` or `body` (deleted account, empty
 * comment) collapses to an empty string rather than failing the poll.
 */
function toTrackerComment(
  comment: z.infer<typeof commentSchema>,
): TrackerComment {
  return {
    id: String(comment.id),
    author: comment.user?.login ?? '',
    body: comment.body ?? '',
    createdAt: comment.created_at,
  };
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
