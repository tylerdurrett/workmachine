# How the workflow system works

This is the single canonical description of how ideas flow through this project, from "I have an idea" all the way to "it shipped to users." Read this first; the other docs in this directory are supporting detail.

## The shape

You have an idea. The system's job is to carry that idea, with as little friction as possible, through:

1. **Alignment.** A real conversation with an agent that understands the project's domain, decisions, and constraints.
2. **Capture.** Writing the alignment down on the tracker as a durable artifact.
3. **Sizing.** Deciding how big the work is and what shape its decomposition should take.
4. **Decomposition.** Breaking the work down, recursively, until every leaf is one PR's worth.
5. **Verification.** Sanity-checking each decomposition before any code gets written.
6. **Execution.** Implementing each leaf, opening the PR, landing it.
7. **Promotion.** Walking the integrated work back up through the tiers until it reaches production.

The same primitives apply at every tier. Once you understand the loop, you understand the whole system.

## The hierarchy

Five tiers, top to bottom. Each tier is a unit of work; bigger tiers contain smaller tiers.

| Tier           | What it is                                                                              | Lives in                          |
| -------------- | --------------------------------------------------------------------------------------- | --------------------------------- |
| **Initiative** | A directed effort toward an outcome. Groups multiple features. Concurrent OK.           | GitHub issue, `size:initiative`   |
| **Feature**    | A meaningful unit of user-facing value. Decomposes into slices. Has an integration branch. | GitHub issue, `size:feature`   |
| **Slice**      | A vertical cut of a feature, demoable end-to-end. Contains multiple tasks.              | GitHub issue, `size:slice`        |
| **Task**       | One PR's worth of work. The leaf.                                                       | GitHub issue, `size:task`         |
| **PR**         | The actual code change, opened against the parent's integration branch.                 | GitHub PR                         |

Every issue on the tracker is a **spec** (the generic name for a captured set of specifications). Size is what distinguishes one tier from another, not the artifact type. A spec sized as `size:slice` always contains multiple tasks; a spec sized as `size:feature` always contains multiple slices; and so on. If a candidate decomposition would yield exactly one child, the parent should have been sized one tier smaller. Right-sizing is iterative.

A slice can sit under a feature (typical) or be an orphan (ad-hoc multi-task work, not part of any feature). The behavior is identical either way.

## The loop

The same five-step loop runs at every tier from initiative down to slice.

```
                    ┌──────────────────────┐
                    │ Once, at the top:    │
                    │  /grill-with-docs    │
                    │  /to-spec            │
                    └──────────┬───────────┘
                               │
                    ┌──────────▼───────────┐
                    │ Loop, per tier:      │
                    │  /triage             │   sizes the spec, may
                    │     │                │   apply needs-grilling
                    │     ▼                │
                    │  /decompose          │   produces children one
                    │     │                │   tier smaller
                    │     ▼                │
                    │  /check  or /audit   │   sanity-check the
                    │                      │   decomposition
                    └──────────┬───────────┘
                               │ (repeat until tasks)
                               │
                    ┌──────────▼───────────┐
                    │ Final, per task:     │
                    │  /execute            │   opens the PR
                    │  /ship               │   merges it
                    └──────────┬───────────┘
                               │ (recurse upward)
                               │
                    ┌──────────▼───────────┐
                    │ Promote, per parent: │
                    │  /ship               │   tier-aware:
                    │                      │   slice → feature branch
                    │                      │   feature → main
                    └──────────────────────┘
```

The triage→decompose→check trio runs once per tier and is what makes the system recursive. An initiative gets triaged, decomposed into features, and the children get checked. Each child feature then gets triaged, decomposed into slices, and the children get checked. Each slice then gets triaged, decomposed into tasks, and the children get checked. Eventually everything bottoms out as tasks, which get executed and shipped.

## The skills

The full skill set, organized by phase of the loop.

### Capture (once per idea)

| Skill                  | What it does                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| `/grill-with-docs`     | Interviews you about a plan, challenging it against `CONTEXT.md` and ADRs. Sharpens vocabulary, surfaces gaps. Updates docs inline as decisions resolve. |
| `/to-spec`             | Captures the conversation as a spec on the tracker, sized at one of `size:initiative` / `size:feature` / `size:slice` / `size:task`. The size call is the agent's best guess, stated inline so the user can override. Parent linkage is inferred from the conversation when context suggests one. Specs land with `needs-triage` until `/triage` clears it. |

### Loop (once per tier, recursively)

| Skill        | What it does                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------- |
| `/triage`    | Verifies the spec's size (may change it), declares the integration branch (`size:feature` / `size:slice`), seeds the sticky progress comment (`size:initiative`), assigns state (`needs-grilling` / `needs-info` / `ready-for-agent` / etc.), recommends the next move. The bookkeeping pass that turns a freshly-published spec into a fully-functional tracker artifact. |
| `/decompose` | Tier-aware decomposition. Reads the spec's size and produces children one tier smaller. Initiative produces features; feature produces slices; slice produces tasks. |
| `/check`     | Single-agent sanity check on a decomposition. Tier-aware: initiative input runs Outcome / Definition-of-done coverage; feature input runs user-story coverage; slice input runs AC coverage + codebase grounding + per-task sizing + sequencing; task input runs codebase grounding + AC sanity-check, with lightweight sibling-context checks when the task has a parent. Read-only, fast, conversational. |
| `/audit`     | Multi-agent (Claude + Codex) version of `/check`. Synthesizes findings with provenance, gates on user approval, writes back additive body edits + a synthesis comment. Reach for it when the cost of a flawed decomposition is high. |

### Execute (once per task, or once per slice via the batch orchestrators)

| Skill            | What it does                                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------------------------- |
| `/execute`       | Implements a `size:task` end-to-end on a branch off the parent's integration branch. One commit per cohesive sub-section. Opens a PR with `Closes #<N>`. |
| `/batch`         | Batch-executes the ready `size:task` children of one parent slice via a worktree-isolated workflow. Infers a dependency DAG, runs independent tasks in parallel and dependent ones in order, squash-merges every code-review-clean task into the slice branch, then opens one slice promotion PR for review. |
| `/autopilot`     | Takes an already-triaged `size:slice` from decomposition to a batched slice promotion PR, autonomously. Composes `/decompose`, `/audit` (auto-approving routine findings, halting on blocking ones), and `/triage` across the task children, then `/batch`, plus a final sweep of the deferred cleanup findings onto the same slice PR. |

### Ship (one tier-aware skill)

| Skill   | What it does                                                                                                                                                |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/ship` | Tier-aware. `size:task` squash-merges the PR, closes the task, prunes the local feature branch; falls back to a defensive close (no git operations) when no open PR exists. `size:slice` promotes the slice's integration branch onto the feature's branch (intermediate; not user-visible yet). `size:feature` promotes the feature's branch onto `main` (the actual user-visible production ship) and ticks the parent initiative's progress comment if any. `size:initiative` refuses; initiatives close manually. |

The user-visible-vs-intermediate signal lives in the outcome line of the end-of-run output, not in the skill name. Initiatives close manually because the maintainer decides when the initiative's `Definition of done` is met.

### Cross-cutting

| Skill         | What it does                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------ |
| `/status`     | Read-only survey of where work stands. Walks the tracker, picks one recommended next-step skill. The "where am I" answer. |
| `/defer`      | Captures cleanup / dedup / refactor findings as `cleanup`-labeled issues so they don't pollute the current PR. Companion to `/simplify`. |
| `/dag`        | Writes (or refreshes) a Mermaid dependency DAG of an issue's direct sub-issues into the issue body. Tier-agnostic. Color-codes each node by status (done / in progress / not started). Idempotent. |

## The labels

Four orthogonal axes. Full detail in [triage-labels.md](triage-labels.md).

- **Size axis** (`size:initiative` / `size:feature` / `size:slice` / `size:task`): which tier the spec lives at. Absence means awaiting triage.
- **State axis** (`needs-triage` / `needs-info` / `needs-grilling` / `ready-for-agent` / `ready-for-human` / `deferred` / `wontfix`): where the spec sits in triage workflow.
- **Lifecycle axis** (`in-progress` / closed): whether active work has begun. Set automatically by lifecycle skills.
- **Category axis** (`bug` / `enhancement` / `cleanup`): kind of work, optional, for filtering.

`needs-grilling` is the load-bearing new state. It applies when a spec was synthesized from a parent's decomposition rather than grilled directly. Aggressive at the initiative→feature boundary; optional at feature→slice; absent at slice→task.

## Integration branches

How code flows up the hierarchy, mirroring how the spec hierarchy flows down.

```
main
 └── feature/issue-<F>-<slug>             ← created lazily by /execute on first task
      └── slice/issue-<S>-<slug>          ← created by /decompose when slice is multi-task
           └── <type>/issue-<T>-<slug>    ← task branches; opened by /execute
                                            <type> is feat/fix/refactor/chore
```

Each task's PR targets the slice's integration branch (or the feature's, or `main`, depending on parentage). When all tasks under a slice close, `/ship <slice>` promotes the slice's branch onto the feature's branch. When all slices under a feature close, `/ship <feature>` promotes the feature's branch onto `main`. Initiatives have no integration branch.

The recursion is captured in [ADR-0001](../adr/0001-issues-branch-from-parent-integration-branch.md): an issue's working branch is its parent's integration branch, walking upward, with `main` as the terminal fallback.

## End-of-run output

Every workflow skill that produces a durable artifact ends with the same three-block template (outcome, links, next step). Skills whose output IS the report (`/status`, `/triage` in conversational mode, `/grill-with-docs`, `/check`, `/audit`) are explicit exceptions. Full detail in [output-format.md](output-format.md).

## Where to start

- **You have an idea brewing**: run `/grill-with-docs` first.
- **You have an alignment session ready to capture**: run `/to-spec`.
- **You have a freshly captured spec on the tracker**: run `/triage <N>` to verify size, seed bookkeeping, and route it.
- **You're not sure where you are**: run `/status`.

## Why this shape

Three principles fall out of how the system was designed:

1. **Alignment before capture, capture before sizing.** You can't write a good spec before you understand what you're building; you can't size what you haven't captured. The loop enforces this ordering.
2. **The same primitives at every tier.** A feature decomposes into slices the same way a slice decomposes into tasks. One `/decompose`, one `/check`, one `/audit`. Tier-aware, not tier-specific.
3. **Promotion is recursive, not flat.** Tasks ship onto slices, slices ship onto features, features ship onto `main`. Each promotion is the same operation at a different layer, and one tier-aware `/ship` covers all three. The moment-of-truth (slice promotion is intermediate, feature promotion is the actual production change) lives in the outcome line of the end-of-run output, not in the skill name.

If you find yourself writing skill prose that violates one of those, push back; the system is shaped to avoid it.

## Other docs in this directory

- [triage-labels.md](triage-labels.md): full label vocabulary and state-machine detail.
- [issue-tracker.md](issue-tracker.md): the GitHub-side mechanics (`gh` CLI, sub-issue attach helper).
- [lifecycle-initiative.md](lifecycle-initiative.md): initiative-tier conventions (no integration branch, manual closure, two-phase intent → materialization).
- [output-format.md](output-format.md): end-of-run output template, voice rules, exception list.
- [domain.md](domain.md): how skills consume the project's domain documentation (`CONTEXT.md`, ADRs).
