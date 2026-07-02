# ADR-0009 — Agent steps run the Codex CLI under subscription auth; raw model-call steps are a distinct, deferred step kind

- **Date:** 2026-06-09
- **Status:** Accepted

## Context

Phase 2 introduces the `agent` executor ([roadmap](../roadmap.md), open
question §1). The architecture already places it cleanly — an agent step
is just an `Executor` ([ADR-0003](0003-deterministic-orchestrator-event-sourced-state.md)),
side effects belong to executors — but building it forces the invocation
mechanism decision that was deliberately deferred, plus one the
open-questions doc didn't anticipate: whether "agent step" and "single
model call with a choosable model" are the same concept.

A pricing change forced the first call: **Claude Agent SDK usage no
longer counts against a Claude subscription** — it bills as metered API.
Agent steps will run constantly once workflows are real; an agent
harness that meters per token is a cost non-starter when
subscription-backed CLI harnesses do the same job.

## Decision

**Agent steps are executed by the Codex CLI in non-interactive mode
(`codex exec`), as a subprocess, riding ChatGPT subscription auth.**

- The executor stays a subprocess-spawner like `scriptExecutor`; the
  backend choice is hidden behind the `Executor` seam, so swapping
  harnesses later is a one-file change (the same containment argument as
  ADR-0008's raw-`fetch` choice).
- `codex exec` covers every control surface the engine needs, verified
  against v0.137.0: `-C <runDir>` (working root), `--sandbox
  workspace-write` (blast radius), `--json` (JSONL events), `-o` (final
  message to file), `--skip-git-repo-check`, `-m` (per-step model
  override, exposed as an optional `model:` field on agent steps).

**"Agent step" and "LLM step" are two distinct step kinds, and this
feature ships only the first.** The load-bearing difference is *who
writes the artifact*:

- An **agent step** hands a resolved prompt to an autonomous harness
  (tools, shell, multi-turn loop) working in the run dir; the *harness*
  writes the declared artifacts.
- An **LLM step** (deferred) is a single resolved-prompt completion; the
  *engine* captures the response and writes the artifact itself. Per-step
  model choice across providers (e.g. via the Vercel AI SDK) and the
  metered-API auth/billing story live there — solving them is that
  feature's job, not this one's.

## Considered options

- **Claude Agent SDK (rejected).** First-class TypeScript typing and the
  prior lean in open-questions §1, but its usage now bills as metered API
  rather than subscription. Do not re-propose absent a pricing change.
- **Claude Code headless / `claude -p` (rejected).** Same
  subscription-vs-metered question hangs over it, and Codex CLI offers an
  equivalent flag surface with known subscription auth today.
- **Vercel AI SDK as the agent backend (rejected as conflation).** It is
  a model-call library, not an agent harness — no tools, no filesystem.
  Treating it as a swappable backend of the *agent* step would blur who
  writes the artifact; it returns as the **LLM step's** natural backend.

## Consequences

- The engine takes no Anthropic/OpenAI SDK dependency; the agent executor
  depends on a `codex` binary on PATH (an accepted external-binary
  coupling, unlike the tracker's — the executor is exactly the seam where
  such coupling belongs, and unit tests inject a fake spawn).
- Enforcement stays deterministic: the executor appends a contract block
  to every resolved prompt (declared artifact paths, stay-in-run-dir),
  and after exit verifies each declared `produces` exists — missing →
  `step_failed`, the same rule scripts already obey. No re-prompt loops
  inside the executor.
- Retry is coordinator policy, not executor intelligence: optional
  `retries: N` (default 0) folded purely in `decide`; every attempt is a
  visible `step_dispatched`/`step_failed` pair in the log. A hard
  wall-clock timeout in the executor (constant, not schema-exposed) kills
  hung subprocesses.
- No new event types: `step_dispatched` records the resolved `prompt`
  (+ optional `model`) for agent steps as it records `command` for
  scripts; `step_succeeded`/`step_failed` gain an optional `summary`
  (the agent's final message) and, if cheaply available, a `sessionRef`.
  Token/cost telemetry is deliberately not recorded — it becomes a real
  fact only when the metered LLM step exists.
