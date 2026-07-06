# Open Design Questions (deferred)

Decisions intentionally deferred past the first vertical slice. Each is
real and load-bearing; none blocks slice 1. Promote into an ADR (and the
canonical docs) when resolved.

## 1. The agent executor — how an agent step actually runs ✅ RESOLVED

Resolved 2026-06-09 by [ADR-0009](adr/0009-agent-steps-run-codex-cli-llm-steps-deferred.md)
and the CONTEXT.md vocabulary (*Agent step*, *LLM step (deferred)*):

- **Invocation mechanism:** Codex CLI (`codex exec`, subprocess) under
  subscription auth. The Claude Agent SDK was rejected on pricing (no
  longer subscription-countable). "Choosable models via the Vercel AI
  SDK" turned out to be a *different step kind* (the deferred LLM step),
  not a backend of this one.
- **Artifact contract enforcement:** deterministic only — the executor
  appends a contract block to every resolved prompt, and a post-exit
  existence check maps any missing declared artifact to `step_failed`
  (the script executor's existing rule). No re-prompt loops.
- **Failure/retry semantics:** all failures (exit/spawn, missing
  artifact, timeout) are `step_failed` facts; retry is a pure `decide`
  policy via optional `retries: N` (default 0), every attempt log-visible.

## 2. Dynamic fan-out — the researcher spawning a data-dependent N

The fan-out researcher spawns *many* sub-tasks whose count depends on
runtime data (e.g. one sub-task per source discovered), then synthesizes.
A static `workflow.yaml` can't express N upfront, which is in tension
with the static-DAG / pure-`decide` model.

Unresolved:

- **Dynamic step expansion vs child sub-runs:** does a `fanout` step's
  executor emit events that expand the graph with N runnable steps, or
  does it spawn N child *runs* with a parent synthesis step that waits on
  all of them? (`kind: fanout` existed in the prototype schema but was
  never implemented.)
- **Convergence:** how a synthesis step waits on a set whose size is only
  known at runtime, while `decide` stays a pure fold.
- **Step instances vs definitions:** fan-out introduces runtime step
  *instances* (e.g. `slide[3]`) distinct from static step *definitions*,
  with composite ids and a readiness rule of "all spawned siblings
  complete." Nested fan-out (N items × K variants → `slide[3].variant[2]`)
  is the same mechanism applied twice.
- **Variants and the selection gate:** generating K options per item
  ("4 options each, pick the best later") needs a gate flavor beyond
  approve/reject — a **selection gate** where the review card shows the K
  candidates and the human picks one inline. The chosen variant becomes
  the canonical artifact (others kept as alternates or discarded); this is
  a generalization of the produce→approve→promote flow to
  produce-set→select→promote. Custom gate `decisions` already allow this
  shape (cf. the prototype's `choose_remotion` branch decision).
- **Operational, not architectural, hard parts:** N×K agent runs explode
  cost/concurrency (worker routing, rate limits, dollars) and clutter the
  projection (run card needs rollup/grouping). Per-instance events isolate
  partial failure cleanly. None of this touches the orchestrator's purity.
- **Temporal mapping:** this is exactly where Temporal child workflows /
  parallel activities would later fit; keep the seam compatible.
