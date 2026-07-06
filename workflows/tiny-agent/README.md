# tiny-agent

The engine's committed agent-step example workflow package. Per
[ADR-0007](../../docs/adr/0007-engine-owns-example-workflows-consumes-external-production.md),
the engine repo owns small example/test workflows that prove and
regression-test the engine itself; production workflows live in external repos.

This package is the agent-twin of [tiny-smoke-gated](../tiny-smoke-gated/): one
`agent` step (`haiku`) whose prompt interpolates `{{inputs.topic}}` and produces
a single artifact, `artifacts/haiku.txt`, followed by a `gate` (review) step
(`review`) that `needs` it and accepts `approve`, `request_changes`, or
`reject`. Like [tiny-smoke-feedback](../tiny-smoke-feedback/), the step's prompt
also interpolates `{{feedback.note}}`, so the resolved prompt — and therefore
the artifact the re-run produces — differs once a reviewer has requested
changes. It is the fixture the agent integration smoke
(`src/integration.smoke.test.ts`) drives the real agent loop against:
`run create -> tick` (which dispatches `codex exec` and stops at
`gate_opened`), then `command approve` followed by another `tick` to
`run_completed`.

## The request-changes revision path

Because the prompt threads `{{feedback.note}}`, the same review card loops
through a revision round without minting a new one (one card per gate,
[ADR-0004](../../docs/adr/0004-tracker-projection-organized-around-gates.md)):

1. `run create -> tick` dispatches the agent (feedback resolves to empty, so the
   prompt ends with the bare "…if present: " marker) and stops at `gate_opened`.
2. `command request_changes <note>` records the reviewer's note.
3. `tick` re-opens the **same** gate and re-dispatches the agent with
   `{{feedback.note}}` resolved to the note — recorded verbatim on the
   re-dispatch's `step_dispatched.prompt` — so the agent genuinely revises the
   haiku, and its bytes/sha256 change from the first round.
4. `command approve` then `tick` advances past the gate to `run_completed`.

On the first dispatch the resolver substitutes `{{feedback.note}}` to an empty
string (no prior `gate_decided(request_changes)`), so the same templated prompt
is dispatchable both before and after a revision round without throwing.

An agent step's resolved prompt is composed at dispatch: the engine appends a
deterministic `## Engine contract` block naming every declared artifact path
(relative to the run directory), and the exact composed bytes are recorded on
`step_dispatched`. Enforcement is deterministic too — after the agent exits,
the executor existence-checks every declared `produces` and records each
artifact's path/sha256/size (or `step_failed` if one is missing). No model
override is set; the fixture stays minimal.

Because the prompt needs no script path (there is no script), the package
declares a single `topic` input — unlike the script fixtures, which thread a
`scriptPath` input because the resolver has no `{{workflow.dir}}` token.

## Run it yourself

Requires the real `codex` CLI on `PATH`, logged in (the hermetic smoke in CI
uses a stub `codex` instead — see `src/integration.smoke.test.ts`). `run create`
also needs a target tracker repo: set `WORKMACHINE_SANDBOX_REPO=owner/name` in the
environment, or pass `--repo owner/name` (which overrides the env var).

```
pnpm build
node dist/cli/main.js run create workflows/tiny-agent/workflow.yaml \
  --input topic=autumn
node dist/cli/main.js tick <run-id>          # codex writes the haiku, stops at the gate
node dist/cli/main.js command <run-id> request_changes "make it about maple leaves"
node dist/cli/main.js tick <run-id>          # codex revises the haiku with the note, stops at the gate
node dist/cli/main.js command <run-id> approve
node dist/cli/main.js tick <run-id>          # advances past the gate to completed
```

The run instance lands under `runs/<id>/` (gitignored), and the final artifact
is `runs/<id>/artifacts/haiku.txt`.
