# ADR-0008 — The GitHub tracker adapter talks to GitHub over raw `fetch`, and the target repo is operator-supplied per run

- **Date:** 2026-06-08
- **Status:** Accepted

## Context

Slice #5 introduces the first concrete tracker adapter: a GitHub Issues
implementation behind the `createRunCard` / `renderReviewCard` /
`readCommands` / `postComment` seam ([ADR-0004](0004-tracker-projection-organized-around-gates.md),
CONTEXT → *Tracker adapter*). Building it forces two choices that were
left open by the higher-level ADRs:

1. **How the engine speaks HTTP to GitHub** — a client library (Octokit)
   versus the platform's built-in `fetch`.
2. **Where the target repo address comes from** — baked into engine
   config, or supplied by the operator per run.

Both are easy to get wrong in a way that's expensive to walk back: a
heavy client dependency is sticky, and treating one repo as *the* tracker
quietly contradicts the engine's "general runner" stance ([ADR-0007](0007-engine-owns-example-workflows-consumes-external-production.md)).

## Decision

**The adapter uses raw `fetch` (Node ≥22 global), not Octokit.**

- The surface is tiny — create an issue, post a comment, list comments —
  ~4 endpoints behind a small interface with an in-memory fake for tests.
  Octokit's wins (pagination helpers, throttling, typed responses) barely
  apply at that size.
- Command polling ([ADR-0006](0006-command-ingestion-idempotent-by-comment-id.md))
  needs **explicit ETag conditional requests** (`If-None-Match` → `304`).
  Octokit's REST methods abstract ETags away; reaching them means dropping
  to its low-level `request()` anyway, so the abstraction earns nothing.
- It keeps the dependency set minimal (`yaml` + `zod` today), consistent
  with the engine's lean, side-effects-at-the-seam design.

**The target repo is operator-supplied per run, not global config.**

- `run create <workflow> --repo owner/name` is the real interface: the
  operator picks which tracker each run lands on, mirroring the
  workflow-package consume seam (ADR-0007) where the *engine is a general
  runner, not the home of one project's context*.
- `WORKMACHINE_SANDBOX_REPO` is a **local-dev fallback only** — used when
  `--repo` is omitted so we don't retype the sandbox while building and
  demoing. It is not part of the production interface.
- The GitHub credential is the one genuinely global secret:
  `WORKMACHINE_GITHUB_TOKEN`, a fine-grained PAT scoped to the target repo
  with Issues read/write + Metadata read. Live testing uses the
  `tylerdurrett/workmachine-sandbox` sibling repo (AGENTS.md → *Sandbox Repo*).

## Considered options

- **Octokit (rejected).** Standard and well-typed, but adds a sticky
  dependency and hides the ETag handling the polling loop depends on, for
  a 4-endpoint surface that doesn't need its pagination/throttling.
- **`gh` CLI subprocess (rejected).** Reuses ambient auth, but couples the
  engine to an external binary, is awkward to fake in unit tests, and
  muddies the side-effect seam.
- **Global tracker repo in config (rejected).** Simplest to wire, but
  makes one repo *the* tracker and contradicts the general-runner stance;
  a per-run `--repo` keeps the engine workflow-and-tracker agnostic.

## Consequences

- The GitHub client is a thin `fetch` wrapper; ETag/`304` handling lives
  in `readCommands` and stays visible rather than buried in a library.
- `run create` grows a `--repo owner/name` flag, falling back to
  `WORKMACHINE_SANDBOX_REPO`; the resolved repo is recorded with the
  `card_created` event so the run is self-describing.
- No engine code hard-codes a tracker repo; pointing a run at a different
  repo is a flag change, not a config migration.
- If the adapter ever grows broad pagination or rate-limit-retry needs,
  revisiting Octokit is a contained, behind-the-seam change.
