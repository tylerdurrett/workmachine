---
name: triage
description: Verify the size `/to-spec` picked, lay down per-tier bookkeeping (integration branch declaration, sticky progress comment), apply the next state label, and clear `needs-triage`. Also surfaces what's most actionable across the tracker when invoked without a specific spec. Use after `/to-spec` publishes a spec, when picking up a hand-created spec, or when asking "what should I look at next?"
---

*Pipeline agents (running under /autopilot): read [PIPELINE.md](PIPELINE.md) instead of this file — it is the autopilot-facing subset. Keep the two in sync when editing either.*

# Triage

The bookkeeping pass that turns a freshly-published spec into a fully-functional tracker artifact, and a conversational survey of what's most actionable across the queue.

`/to-spec` picks the size and publishes with `needs-triage`. `/triage` verifies that call, lays down the structural bookkeeping for the spec's tier (integration branch declaration for `size:feature` / `size:slice`, sticky progress comment for `size:initiative`), routes synthesized children through `/grill-with-docs` when appropriate, and clears `needs-triage` by applying the next state label.

For label vocabulary see [docs/agents/triage-labels.md](../../../docs/agents/triage-labels.md); for tracker mechanics see [docs/agents/issue-tracker.md](../../../docs/agents/issue-tracker.md); for the canonical end-of-run output see [docs/agents/output-format.md](../../../docs/agents/output-format.md).

## Modes

The maintainer's request shape picks the mode:

- **Per-spec triage**: "triage #42", "let's look at #42", "move #42 to ready-for-agent". Bookkeeping pass plus state transition on one spec. Ends with the three-block template.
- **Show what needs attention**: "what needs my attention?", "what's ready for agents?", `/triage` with no arguments. Conversational queue survey. Ends with a recommendation paragraph (per the conversational-mode exception in [output-format.md](../../../docs/agents/output-format.md#skills-that-are-exceptions-to-the-template)).

## Per-spec triage

### 1. Gather context

Read the full spec (body, comments, labels, dates). Parse any prior triage notes so you don't re-ask resolved questions. Read `CONTEXT.md` if present, respect ADRs in the touched area, use the project's domain glossary. Read `.out-of-scope/*.md` and surface any prior rejection that resembles this spec.

### 2. Verify size

`/to-spec` should have picked one of `size:initiative` / `size:feature` / `size:slice` / `size:task`. If the size looks right, proceed. If it looks wrong, propose a correction and wait for direction; default toward the larger tier when ambiguous.

If the spec has no size label (hand-created without `/to-spec`), recommend one and apply it after confirmation. This is the only path by which `/triage` originates a size; the default path is verification.

### 3. Per-tier bookkeeping

Conditional on the (final) size:

- **`size:feature` or `size:slice`**: declare the integration branch. Compute the branch name (`feature/issue-<N>-<slug>` for features, `slice/issue-<N>-<slug>` for slices) and prepend `**Integration Branch:** <branch>` to the spec body, just below the `**Part of:** #<P>` line if present. Body edit via `gh issue edit <N> --body-file -`. The branch itself is created lazily by `/execute` on first use per [ADR-0001](../../../docs/adr/0001-issues-branch-from-parent-integration-branch.md) (or the slot it landed in if `0001` was already taken); `/triage` only declares the name.

- **`size:initiative`**: seed the sticky progress comment. Post a comment in the exact shape documented at [lifecycle-initiative.md §The marker](../../../docs/agents/lifecycle-initiative.md#the---progress-commentinitiative---marker) (`<!-- progress-comment:initiative -->` marker on the first line, `## Child features` heading, italic placeholder). `/to-spec` (initiative as parent) and `/decompose` replace the placeholder with `- [ ] #<F> — <title>` rows as features attach.

- **`size:task`**: no structural bookkeeping required.

### 4. Reproduce (bugs only)

For `bug`-category specs, attempt repro before transitioning state: read the reporter's steps, trace the relevant code, run targeted tests. A confirmed repro makes a much stronger downstream brief; failed repro or insufficient detail is a strong `needs-info` signal.

### 5. Pick the next state

Clear `needs-triage` and apply one of the seven canonical state labels (or, for initiative and feature specs ready to decompose, no state label at all). Pick from the happy-path table below; if none fits, drop to the non-happy-path table.

**Happy path** (the spec was well-specified and ready):

| Size | New state | Next step |
| ---- | --------- | --------- |
| `size:task` | `ready-for-agent` | `/execute <N>` |
| `size:slice` | `ready-for-agent` | `/decompose <N>` (or `/autopilot <N>` to run the whole slice autonomously) |
| `size:feature` / `size:initiative` | *(no state label)* | `/decompose <N>` |

`size:feature` and `size:initiative` skip `ready-for-agent` because they decompose, not execute (see [triage-labels.md §Size axis](../../../docs/agents/triage-labels.md#size-axis)). For `ready-for-agent` outcomes, post an agent brief comment (see [AGENT-BRIEF.md](AGENT-BRIEF.md)) **only if the spec body is thin**; `/to-spec`-published specs usually make a separate brief redundant.

Two hygiene rules for anything you write into a spec or brief — triage notes are load-bearing for the executing agent, and a false claim sends it hunting:

- **Only assert gates that are actually wired.** Before noting "prettier/lint/CI flags this", check the repo defines that gate (a config file, a package.json script). An ad-hoc `npx prettier --check` against a repo with no prettier config produces noise, not a gate — a downstream agent was measured burning minutes chasing exactly that.
- **Exclude vendored/build dirs from exploratory greps** — `grep -rn --exclude-dir={node_modules,dist,.vite,build}` (or use `rg`, which honors .gitignore). A bare recursive grep over `apps/` once returned 614KB of bundler output for one probe.

**Non-happy path** (any size):

| Outcome | When | Side effect | Next step |
| ------- | ---- | ----------- | --------- |
| `needs-grilling` | Spec wasn't aligned via `/grill-with-docs`. Typical for children synthesized by `/decompose`; aggressive at initiative→feature, optional at feature→slice, absent at slice→task. | Run `/grill-with-docs <N>` now (then drop the label and re-pick from the happy path), or judge grilling unnecessary and drop the label with a comment. | `/grill-with-docs <N>` (if grilling) or back to happy path. |
| `needs-info` | Waiting on the reporter. | Post triage notes (template below). | Reporter reply. |
| `ready-for-human` | Needs judgment, external access, design decisions, or manual testing an agent can't safely do. | Note why in a comment. | Maintainer. |
| `deferred` | Intentionally parked. | Short comment naming the trigger and the unpark condition. | `Stop.` |
| `wontfix` (bug) | Will not be actioned. | Polite explanation, close. | `Stop.` |
| `wontfix` (enhancement) | Will not be actioned. | Close with a brief explanatory comment — the closed issue **is** the record. Do **not** write a repo file by default. Only when the maintainer explicitly wants the reasoning preserved in-tree for a durable, likely-to-recur rejection (not a deferral — see the `deferred` row), offer to write to `.out-of-scope/`, and do so only on a yes (see [OUT-OF-SCOPE.md](OUT-OF-SCOPE.md)). | `Stop.` |

Apply the transition in one call (omit `--add-label` for `size:feature` / `size:initiative` happy path):

```bash
gh issue edit <N> --remove-label "needs-triage" --add-label "<chosen-state>"
```

`gh issue edit` tolerates removing labels that aren't present, so re-runs are idempotent. Replace the `size:*` label here only if step 2 changed it.

### 6. Print the end-of-run output

Three-block template per [output-format.md](../../../docs/agents/output-format.md):

```
Triaged #<N> as <size>, <state>.

- <issue URL>
- branch declared: <branch>          # only for size:feature / size:slice
- progress comment seeded             # only for size:initiative

> Next step: `/<skill> <N>`. <one-sentence reason>.
```

The next-step skill comes from the "Next step" column of whichever table in step 5 the outcome landed in.

## Show what needs attention

Conversational mode. Walk the tracker and present these buckets in order:

1. **Freshly published specs (`needs-triage`)**: `/to-spec` left them with bookkeeping pending. The typical post-`/to-spec` state. Sort by size descending (initiative first, then feature, slice, task). Recommended action per spec: `/triage <N>`.

2. **`needs-grilling`**: synthesized children awaiting alignment, oldest first. Group by parent. Recommended action: `/grill-with-docs <N>`, or `/triage <N>` if the maintainer wants to skip grilling.

3. **Active features and slices (`in-progress`)**: specs that `/decompose` produced children for. Group by parent. Show the auto-rollup (`X of Y children shipped`). On an `in-progress` `size:slice` with open task children, the recommended next action is `/execute <task#>` on the lowest-numbered open task, not further triage on the slice itself.

4. **`ready-for-agent`**: fully specified, waiting for the next move. Only `size:task` and `size:slice` land here (features and initiatives skip `ready-for-agent`). `/execute <N>` for tasks; `/decompose <N>` for slices (or `/autopilot <N>` to run the whole slice autonomously).

   Plus **decompose-ready features and initiatives**: `size:feature` / `size:initiative` carrying no state-axis label after `/triage`'s bookkeeping pass. Recommended action: `/decompose <N>`.

5. **`needs-info` with reporter activity since the last triage notes**: re-evaluation due, oldest first. Recommended action: `/triage <N>`.

6. **Drift to flag**: one bullet per drift instance with the fix. Drift to look for: `in-progress` with no children; children with no `in-progress` parent; missing `size:*` label; both `in-progress` and a state-axis label set; `**Integration Branch:**` line missing on an `in-progress` `size:feature` / `size:slice`.

7. **Parked (`deferred`)**: shown last, collapsed to a count plus title list. Mention how long each has been parked. Don't recommend acting on these unless asked.

Show counts and a one-line summary per spec. After the buckets, **recommend the concrete next action**: name one spec and one skill. Decision priority (highest first):

1. An `in-progress` slice with an open task child → `/execute <task#>` on the lowest-numbered open task.
2. A `ready-for-agent` `size:task` → `/execute <N>`.
3. A `ready-for-agent` `size:slice` → `/decompose <N>` (or `/autopilot <N>` to run the whole slice autonomously); a `size:feature` / `size:initiative` with no state-axis label → `/decompose <N>`.
4. A `needs-triage` spec → `/triage <N>`.
5. A `needs-grilling` spec → `/grill-with-docs <N>`.

Parked specs never feed the priority chain. The natural next child under a parent is the lowest-numbered open child unless dependency order suggests otherwise.

## Quick state override

If the maintainer says "move #42 to ready-for-agent", trust them and apply the label directly after confirming what you're about to do. Skip grilling and the bookkeeping checks. If no size label is set, ask which to apply; `/execute` and `/decompose` refuse to run without one.

## Needs-info template

```markdown
## Triage Notes

**What we've established so far:**

- point 1
- point 2

**What we still need from you (@reporter):**

- question 1
- question 2
```

Capture everything resolved during grilling under "established so far" so the work isn't lost. Questions must be specific and actionable, not "please provide more info."

## Resuming a previous session

If prior triage notes exist on a spec, read them, check whether the reporter answered any outstanding questions, and present an updated picture before continuing. Don't re-ask resolved questions.

## Re-triage idempotency

`/triage` is safe to re-run, but the body-edit and sticky-comment steps need a brief precheck:

- **Integration branch declaration**: if the body already has an `**Integration Branch:**` line, leave it. Only prepend on first triage.
- **Sticky progress comment**: if a comment containing `<!-- progress-comment:initiative -->` already exists on the spec, leave it. Only post on first triage.
- **Label transitions**: idempotent via `gh issue edit` semantics; re-runs are safe.

## Verification

Manual end-to-end checklist. For each fresh-spec row, `needs-triage` comes off and the row's "Happy-path label" goes on (a blank means no replacement label).

| Size | Body edit | Sticky comment | Happy-path label |
| ---- | --------- | -------------- | ---------------- |
| `size:feature` | `**Integration Branch:** feature/issue-<N>-<slug>` prepended | *(none)* | *(none)* |
| `size:slice` | `**Integration Branch:** slice/issue-<N>-<slug>` prepended | *(none)* | `ready-for-agent` |
| `size:initiative` | *(none)* | `<!-- progress-comment:initiative -->` marker comment posted | *(none)* |
| `size:task` | *(none)* | *(none)* | `ready-for-agent` |

Plus three non-table cases:

- **`needs-grilling` spec.** Either `/grill-with-docs` runs (then the label drops), or the label drops with a comment.
- **Hand-created spec lacking a size label.** Triage proposes a size, applies it after confirmation, then proceeds with the bookkeeping pass.
- **Show-attention mode.** `/triage` with no arguments prints the buckets in order and ends with one concrete next-step recommendation embedded in prose (not the three-block template).

Per-spec runs end with the three-block template.
