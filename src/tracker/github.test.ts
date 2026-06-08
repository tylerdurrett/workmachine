import { describe, expect, it } from 'vitest';
import { GitHubTracker, resolveGitHubConfig } from './github.js';
import type { TrackerAdapter } from './types.js';

/**
 * Offline tests for the GitHub adapter skeleton: config resolution is a pure
 * function of env + opts, and the HTTP wiring is exercised through an injected
 * `fetch` stub that captures the outgoing request. No live GitHub is touched.
 */

/** A captured outgoing request, for asserting URL/method/headers. */
interface CapturedRequest {
  url: string;
  init: RequestInit | undefined;
}

/**
 * Build a `fetch` stub that records the request it was called with and replies
 * with the given status + JSON body.
 */
function stubFetch(
  status: number,
  jsonBody: unknown,
): { fetch: typeof fetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    calls.push({ url, init });
    return Promise.resolve(
      new Response(JSON.stringify(jsonBody), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  };
  return { fetch: fetchImpl, calls };
}

/** Read a header off a captured request's init, tolerating its shape. */
function header(req: CapturedRequest, name: string): string | undefined {
  const headers = req.init?.headers;
  if (headers === undefined) return undefined;
  return new Headers(headers).get(name) ?? undefined;
}

/**
 * Parse a captured request's JSON body. The adapter always sends a JSON string
 * body, so this narrows the `BodyInit` to the parsed payload for assertions.
 */
function jsonBody(req: CapturedRequest | undefined): unknown {
  const body = req?.init?.body;
  return typeof body === 'string' ? JSON.parse(body) : undefined;
}

describe('resolveGitHubConfig', () => {
  it('resolves the repo from opts over the env fallback', () => {
    const config = resolveGitHubConfig(
      {
        WORKMACHINE_GITHUB_TOKEN: 'tok',
        WORKMACHINE_SANDBOX_REPO: 'fallback/repo',
      },
      { repo: 'acme/widgets' },
    );

    expect(config).toEqual({ token: 'tok', owner: 'acme', repo: 'widgets' });
  });

  it('falls back to WORKMACHINE_SANDBOX_REPO when no override is given', () => {
    const config = resolveGitHubConfig({
      WORKMACHINE_GITHUB_TOKEN: 'tok',
      WORKMACHINE_SANDBOX_REPO: 'tylerdurrett/workmachine-sandbox',
    });

    expect(config).toEqual({
      token: 'tok',
      owner: 'tylerdurrett',
      repo: 'workmachine-sandbox',
    });
  });

  it('throws when the token is missing', () => {
    expect(() =>
      resolveGitHubConfig({ WORKMACHINE_SANDBOX_REPO: 'a/b' }),
    ).toThrow(/WORKMACHINE_GITHUB_TOKEN/);
  });

  it('throws when no repo can be resolved', () => {
    expect(() =>
      resolveGitHubConfig({ WORKMACHINE_GITHUB_TOKEN: 'tok' }),
    ).toThrow(/no target repo/);
  });

  it('throws on a malformed repo string', () => {
    expect(() =>
      resolveGitHubConfig(
        { WORKMACHINE_GITHUB_TOKEN: 'tok' },
        { repo: 'no-slash' },
      ),
    ).toThrow(/malformed repo/);

    expect(() =>
      resolveGitHubConfig(
        { WORKMACHINE_GITHUB_TOKEN: 'tok' },
        { repo: 'a/b/c' },
      ),
    ).toThrow(/malformed repo/);
  });
});

describe('GitHubTracker.verifyAccess', () => {
  const config = { token: 'tok', owner: 'acme', repo: 'widgets' };

  it('GETs the repo with auth + accept headers and returns the full name', async () => {
    const { fetch, calls } = stubFetch(200, { full_name: 'acme/widgets' });
    const tracker = new GitHubTracker(config, { fetch });

    const result = await tracker.verifyAccess();

    expect(result).toEqual({ fullName: 'acme/widgets' });
    expect(calls).toHaveLength(1);
    const [req] = calls;
    expect(req?.url).toBe('https://api.github.com/repos/acme/widgets');
    expect(req?.init?.method).toBe('GET');
    expect(header(req!, 'Authorization')).toBe('Bearer tok');
    expect(header(req!, 'Accept')).toBe('application/vnd.github+json');
    expect(header(req!, 'X-GitHub-Api-Version')).toBe('2022-11-28');
    expect(header(req!, 'User-Agent')).toBe('work-machine');
  });

  it('honors an injected baseUrl', async () => {
    const { fetch, calls } = stubFetch(200, { full_name: 'acme/widgets' });
    const tracker = new GitHubTracker(config, {
      fetch,
      baseUrl: 'http://localhost:9999',
    });

    await tracker.verifyAccess();

    expect(calls[0]?.url).toBe('http://localhost:9999/repos/acme/widgets');
  });

  it('throws with the status and GitHub message on a non-2xx response', async () => {
    const { fetch } = stubFetch(404, { message: 'Not Found' });
    const tracker = new GitHubTracker(config, { fetch });

    await expect(tracker.verifyAccess()).rejects.toThrow(/404 Not Found/);
  });
});

describe('GitHubTracker.createRunCard', () => {
  const config = { token: 'tok', owner: 'acme', repo: 'widgets' };

  it('POSTs an issue with the workmachine label + run-id marker body and returns the card ref', async () => {
    const { fetch, calls } = stubFetch(201, {
      number: 42,
      html_url: 'https://github.com/acme/widgets/issues/42',
    });
    const tracker = new GitHubTracker(config, { fetch });

    const card = await tracker.createRunCard({
      title: 'Run 20260607T120000Z-tiny-smoke-ab12',
      body: 'run-id: 20260607T120000Z-tiny-smoke-ab12',
    });

    expect(card).toEqual({
      id: '42',
      url: 'https://github.com/acme/widgets/issues/42',
    });
    expect(calls).toHaveLength(1);
    const [req] = calls;
    expect(req?.url).toBe('https://api.github.com/repos/acme/widgets/issues');
    expect(req?.init?.method).toBe('POST');
    expect(header(req!, 'Content-Type')).toBe('application/json');
    const payload = jsonBody(req) as {
      title: string;
      body: string;
      labels: string[];
    };
    expect(payload.title).toBe('Run 20260607T120000Z-tiny-smoke-ab12');
    expect(payload.body).toContain('20260607T120000Z-tiny-smoke-ab12');
    expect(payload.labels).toEqual(['workmachine']);
  });

  it('merges caller-supplied labels after the workmachine marker', async () => {
    const { fetch, calls } = stubFetch(201, {
      number: 7,
      html_url: 'https://github.com/acme/widgets/issues/7',
    });
    const tracker = new GitHubTracker(config, { fetch });

    await tracker.createRunCard({ title: 't', body: 'b', labels: ['extra'] });

    const payload = jsonBody(calls[0]) as { labels: string[] };
    expect(payload.labels).toEqual(['workmachine', 'extra']);
  });
});

describe('GitHubTracker.postComment', () => {
  const config = { token: 'tok', owner: 'acme', repo: 'widgets' };
  const card = { id: '42', url: 'https://github.com/acme/widgets/issues/42' };

  it('POSTs a comment to the issue and returns the created comment', async () => {
    const { fetch, calls } = stubFetch(201, {
      id: 1001,
      user: { login: 'octocat' },
      body: '/approve',
      created_at: '2026-06-08T12:00:00Z',
    });
    const tracker = new GitHubTracker(config, { fetch });

    const comment = await tracker.postComment(card, '/approve');

    expect(comment).toEqual({
      id: '1001',
      author: 'octocat',
      body: '/approve',
      createdAt: '2026-06-08T12:00:00Z',
    });
    const [req] = calls;
    expect(req?.url).toBe(
      'https://api.github.com/repos/acme/widgets/issues/42/comments',
    );
    expect(req?.init?.method).toBe('POST');
    expect(jsonBody(req)).toEqual({ body: '/approve' });
  });
});

describe('GitHubTracker adapter methods (stubbed for later tasks)', () => {
  const tracker: TrackerAdapter = new GitHubTracker({
    token: 'tok',
    owner: 'acme',
    repo: 'widgets',
  });
  const card = { id: '1', url: 'https://github.com/acme/widgets/issues/1' };

  it('rejects renderReviewCard (#33) and readCommands (#34)', async () => {
    await expect(tracker.renderReviewCard({ card, body: 'b' })).rejects.toThrow(
      /not implemented yet \(task #33\)/,
    );
    await expect(tracker.readCommands(card)).rejects.toThrow(
      /not implemented yet \(task #34\)/,
    );
  });
});
