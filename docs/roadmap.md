# Work Machine Roadmap

Repo-level phase map. Decomposed work lives in GitHub issues (the
initiative is [#1](https://github.com/tylerdurrett/workmachine/issues/1);
its candidate-features list is the live backlog). This doc keeps the
sequencing story before work becomes specs.

Guiding approach: **build up one testable chunk at a time.** Prove the
basic machinery before the artifact-heavy intricacies; add one workflow
step at a time before chasing a full pipeline.

## Phase 0 — Project setup / docs migration ✅

- [x] Create repo `tylerdurrett/workmachine`; establish it as canonical
      engineering-docs surface (ADR-0002).
- [x] Project-facing README, CONTEXT, charter, architecture, roadmap.
- [x] Foundational architecture grilled and recorded: ADR-0003
      (deterministic orchestrator / event-sourced state), ADR-0004
      (gate-oriented projection), ADR-0005 (YAML + Zod workflows).
- [x] Publish the initiative spec (#1).

> Stack decided: TypeScript + Node + pnpm, fresh in this repo. The
> deprecated Python `workflow-engine` is read as a spec, not forked.

## Phase 1 — First tracker-backed run

The trivial-but-real vertical: one script step + one human gate,
end-to-end. Built as a few demoable slices:

- **Engine core (no tracker):** Zod-validated workflow loader, the pure
  `decide` fold, the `tick` harness, `events.jsonl` + derived `run.yaml`
  + `workflow.snapshot.yaml`, and a `script` executor — runnable purely
  from the CLI.
- **GitHub projection + intake:** `run create` makes the run *and* the
  attached issue (single review card for now); render status + artifact
  links into the card.
- **Gate round-trip:** open a gate, poll comments on tick, parse
  `/approve | /request-changes | /reject`, validate (record `actor`),
  append `gate_decided`, advance, complete.

Exit: a tiny workflow can be started, tracked, executed, reviewed, and
completed through GitHub while the event log stays canonical.

## Phase 2 — Agent executor

- [ ] `agent` executor under "thin skill, thick engine": engine resolves
      inputs and hands the agent one narrow task; agent never touches
      lifecycle.
- [ ] Artifact-contract enforcement (declared `produces` actually
      produced) and agent failure/retry semantics.
- [ ] Resolve invocation mechanism (see [open-questions.md](open-questions.md) §1).

## Phase 3 — Multi-gate runs and the parent run card

- [ ] Parent run card + multiple review cards; automatic-step rollups.
- [ ] Mermaid workflow graph in the run card.
- [ ] Basic reconciliation between tracker projection and event log.

## Phase 4 — Dynamic fan-out research

- [ ] A researcher that spawns a data-dependent number of sub-tasks and
      synthesizes them — the static-DAG / pure-`decide` tension (see
      [open-questions.md](open-questions.md) §2).

## Phase 5 — Content/video pipeline and remote artifacts

- [ ] Build a real pipeline one step at a time (e.g. summarize → brief →
      …), exercising larger artifacts.
- [ ] R2/S3 artifact-storage adapter + artifact index for media; decide
      whether Frame.io earns a review-adapter spike.

## Phase 6 — Shared state, always-on coordinator, runtime evaluation

- [ ] Move the event log to a shared store (Postgres/R2/service) for an
      always-on coordinator; upgrade `tick` from manual to
      scheduled/daemon.
- [ ] Dev-skills tenant adapter: map runs onto the existing
      `initiative → feature → slice → task` issue hierarchy.
- [ ] Only after the custom coordinator hits real durability pain,
      evaluate Temporal (durable semantics) and Hatchet/Inngest-style
      systems (worker routing). The seams are kept compatible
      throughout — this is a substrate swap, not a rewrite.
