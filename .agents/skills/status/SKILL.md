---
name: status
description: Read-only survey of where work stands across the tracker and recommend the next thing to do. Walks initiative → feature → slice → task via native sub-issue queries, derives one next-step recommendation from the lifecycle, and writes a short warm-prose report. Use when the user says "what's next", "status", "where am I", "what should I do", "check in", "what's in the pipe", or after coming back to the project after a break.
---

# Status

Give the user a clear, warm, one-screen picture of where work stands and what to do next.

This skill is read-only. It surveys local repo state and the tracker, walks initiative → feature → slice → task via native sub-issue queries, derives the next step from the lifecycle decision tree, and writes a short report. It does not close issues, push branches, or take any other action. If it spots drift (stale label, dirty tree), it surfaces it; the user, or another skill, fixes it.

For the system shape see [docs/agents/README.md](../../../docs/agents/README.md); for label vocabulary see [docs/agents/triage-labels.md](../../../docs/agents/triage-labels.md); for voice rules and the report-is-output exception see [docs/agents/output-format.md](../../../docs/agents/output-format.md).

## Hard rules

- **Read-only.** No `git commit`, `git push`, `gh issue close`, `gh pr edit`, `gh pr create`, file deletions, or label edits. Use only read-shaped `gh` and `git` commands. If the survey turns up state that needs fixing (e.g., a slice labeled `in-progress` with all children closed), recommend the relevant skill; do not fix it yourself.
- **Recommend from the lifecycle.** The next-step recommendation must be one of: `/grill-with-docs`, `/to-spec`, `/triage`, `/decompose`, `/autopilot`, `/execute`, `/ship`. `/autopilot` applies only to a triaged, `ready-for-agent` `size:slice`, offered as the autonomous alternative to `/decompose` (run the whole slice end-to-end). Do not recommend `/check`, `/audit`, `/diagnose`, `/improve-codebase-architecture`, `/tdd`, or other ad-hoc skills; they do not fit the "what's next" question this skill answers. `/check` and `/audit` are optional verification reached for directly by the maintainer (or via the nudge `/decompose` prints), not from a `/status` recommendation.
- **One headline action.** Exactly one recommendation under "What to do next." Supporting context lives in the other sections.
- **Voice rules apply.** This skill is one of the report-is-output exceptions in [output-format.md](../../../docs/agents/output-format.md#skills-that-are-exceptions-to-the-template); the three-block template does not apply, but the voice rules in that file do (plain English over jargon, lead with the thing being built, no conventional-commit prefixes, compress related artifacts, be specific).

## Step 1: Survey local state

Gather silently:

```bash
git -C <repo> branch --show-current
git -C <repo> status --porcelain
git -C <repo> branch --list 'feat/issue-*' 'fix/issue-*' 'refactor/issue-*' 'chore/issue-*' --merged main
```

Note any drift: a current branch like `<type>/issue-<N>-<slug>` whose task is already `CLOSED` on the tracker, a working tree with uncommitted changes, or merged-but-unpruned feature/slice integration branches.

## Step 2: Survey the issue tracker

Run these queries in parallel where the shell allows:

```bash
gh issue list --label size:initiative --state open --json number,title,body,labels
gh issue list --label size:feature --state open --json number,title,body,labels
gh issue list --label size:slice --state open --json number,title,labels
gh issue list --label size:task --state open --json number,title,labels
gh issue list --label needs-triage --state open --json number,title,labels
gh issue list --label needs-grilling --state open --json number,title,labels
gh issue list --label ready-for-agent --state open --json number,title,labels
gh issue list --label in-progress --state open --json number,title,labels
gh issue list --label deferred --state open --json number,title
gh pr list --author @me --state open --json number,title,url,baseRefName,reviewDecision,mergeable,headRefName
gh pr list --review-requested @me --state open --json number,title,url
```

The `labels` field is needed for the drift checks below. An "active initiative" is a `size:initiative` carrying `in-progress`; an "active feature" is a `size:feature` carrying `in-progress`; an "active slice" is a `size:slice` carrying `in-progress`. Active features and slices anchor "What's in motion." Active initiatives anchor the lead paragraph as higher-level goal context; they never feed the decision tree because initiatives close manually (see [lifecycle-initiative.md](../../../docs/agents/lifecycle-initiative.md)).

`needs-grilling` issues are synthesized children awaiting alignment. They feed the decision tree only as a low-priority fallback (after the active work and the triage queue are clear). `deferred` issues are intentionally parked: do not feed the decision tree, do not anchor the lead, surface only as a count under "Anything else?" if nonzero.

## Step 3: Walk parent → children via sub-issue queries

For each active initiative, feature, and slice, list its native sub-issues:

```bash
gh api "repos/{owner}/{repo}/issues/<N>/sub_issues" \
  --jq '.[] | {number, state, title, labels: [.labels[].name]}'
```

Walk recursively down the size axis: initiative → features → slices → tasks. Stop at tasks (no further sub-issues). For each parent at each level compute:

- Total children = count of sub-issues returned.
- Closed children = count where `state == "closed"`.

Surface this inline as plain English in "What's in motion" ("4 of 7 sub-tasks shipped" rather than "rollup: 4/7").

For each open task under an active slice (or directly under an active feature), check whether the user has an open PR authored against it: cross-reference the open-PR list from Step 2 against `<type>/issue-<N>-<slug>` head-ref names where `<type>` is `feat`, `fix`, `refactor`, or `chore`. The presence/absence of an open PR distinguishes "in flight" from "ready to start."

Collect a "ready to promote" signal per active slice and feature: are all sub-issues closed? If yes, the parent is ready for `/ship`. (`size:slice` ships intermediate onto the feature's integration branch; `size:feature` ships onto `main` as the production-visible delivery. The skill name is the same; the moment-of-truth lives in the outcome line of `/ship`'s end-of-run output.)

Note inconsistencies for "Anything else?": a `size:feature` or `size:slice` carrying both `needs-triage` and having open children (decomposed without triage bookkeeping); a slice or feature labeled `in-progress` with zero sub-issues (decomposition hasn't run yet); an `in-progress` spec carrying a state-axis label (mutually exclusive per [triage-labels.md](../../../docs/agents/triage-labels.md#lifecycle-axis)); a `size:feature` or `size:slice` missing the `**Integration Branch:**` body line; an `in-progress` `size:initiative` whose feature children are all closed (the initiative's Definition of done may be met; initiatives close manually per [lifecycle-initiative.md §Manual closure](../../../docs/agents/lifecycle-initiative.md#manual-closure), so this surfaces as a review prompt rather than a `/ship` recommendation).

For "recently shipped," fetch the last 5 merged PRs across `main` and any active feature/slice integration branch:

```bash
gh pr list --state merged --base main --limit 5 --json number,title,mergedAt,headRefName
# For each active feature/slice integration branch surfaced in Step 2:
gh pr list --state merged --base <integration-branch> --limit 5 --json number,title,mergedAt
```

Combine, sort by `mergedAt` descending, keep the top 5. Recency is rank-based, not date-based.

## Step 4: Walk the decision tree

Pick the first match top-down. Each match resolves to exactly one recommended skill.

1. **Working tree is dirty.** Lead with a friendly "you've got uncommitted changes" note and stop the recommendation chain.

2. **You have an open PR you authored.** Branch on its review state:
   - `reviewDecision: CHANGES_REQUESTED` → recommend addressing feedback. No slash command; describe the PR and link it.
   - Otherwise (approved / no review yet / awaiting review), branch on what the PR is shipping:
     - **PR's branch matches a `size:task` issue's branch** (`<type>/issue-<N>-<slug>`) AND mergeable AND no failed checks → recommend **`/ship #<PR#>`** (lands the PR, closes the task, prunes the local branch).
     - **PR isn't yet mergeable** (checks running, conflicts) → mention it in "in motion" and continue the decision tree; the user can do prep work while it sits.
     - **PR not associated with a `size:task` issue** (a side PR) → mention without recommendation.

3. **An `in-progress` slice has all its task children closed** → **`/ship <slice#>`**. (All tasks shipped; promote the slice's integration branch onto the feature's.)

4. **An `in-progress` feature has all its slice children closed** → **`/ship <feature#>`**. (All slices shipped; promote onto `main`. This is the production-visible moment.)

5. **An `in-progress` slice has an open task child with no open PR yet** → **`/execute <task#>`** on the lowest-numbered open task (unless dependency order in the slice's body suggests otherwise).

6. **An `in-progress` feature has an open slice child** → recurse silently into the lowest-numbered open slice and let the slice-level rules in this list fire against it. The recommendation surfaces as if invoked against the slice directly (a slice-level `/execute`, `/ship`, `/decompose`, etc.).

7. **A `ready-for-agent` spec exists** with no open PR yet. Branch on its size label:
   - `size:task` → **`/execute <N>`** (one PR's worth; the skill explores, plans inline, branches, commits, opens a PR with `Closes #<N>`).
   - `size:slice` → **`/decompose <N>`** (needs to be broken into task children first), or **`/autopilot <N>`** to run the whole slice autonomously (decompose → audit → triage tasks → batch, halting only on a blocking audit finding).

8. **A `size:feature` or `size:initiative` exists with no state-axis label and zero sub-issues** → **`/decompose <N>`**. (Decompose-ready per [triage-labels.md §Size axis](../../../docs/agents/triage-labels.md#size-axis): features and initiatives skip `ready-for-agent` because they decompose, not execute.)

9. **The triage queue has issues in `needs-triage`** → **`/triage`**. (Backlog needs a maintainer pass.)

10. **The grilling queue has issues in `needs-grilling`** → **`/grill-with-docs <N>`** on the oldest. (Synthesized children awaiting alignment.)

11. **None of the above (truly idle)** → **`/grill-with-docs`** if there's a hint of an idea in recent activity, otherwise **`/to-spec`**. Pick one and explain why briefly. In this idle case only, also include a short one-liner pointing the user at `/how-to-use` for a project-wide overview if they want one.

## Step 5: Compose the report

Write four sections in this order. Skip a section entirely if it has nothing meaningful; empty sections feel worse than absent ones.

### Lead paragraph (no heading)

One or two sentences naming the active feature(s) being built, with a sense of overall progress. Use the feature title from the tracker. If active initiatives exist, mention each by number and title alongside the active features so the lead surfaces both layers of context (e.g., "You're shipping the csv-export feature (#82) under the broader **Reporting initiative (#50)**."). If there are no active initiatives, the lead reads without that clause; no sentinel line, silence is the right default. If there's no active feature, the lead changes shape: "No feature work in flight at the moment" or similar.

### `## Recently shipped`

Up to 5 bullets, derived from the merged-PR list. Each bullet rewrites the PR title into a plain-English description of what shipped. PR number in parens is fine. Skip the section if nothing recent.

If multiple recent PRs are small or thematically grouped, compress: "A handful of small fixes to X" rather than five tiny bullets.

### `## What's in motion`

Describe the active feature(s) and their progress in flowing prose, two or three sentences. What's the current slice about? What just shipped within it? What's next up in plain English (derived from the next open task's title and body)? Surface the rollup count inline ("3 of 5 sub-tasks shipped").

If there are open PRs the user authored that aren't blocking the next step, mention them here as "PR #X is open and awaiting review."

### `## What to do next`

The single recommendation from the decision tree. Format:

> Run **`/skill-name [args]`**. One-sentence reason. Brief description of what the skill will do, in plain English.

If the recommendation is "address review feedback on PR #X" (case 2 above), the format is the same shape but with the PR URL instead of a slash command.

### `## Anything else?`

Short bullets covering: triage queue size, grilling queue size, PRs awaiting your review, stale local branches, parked-issue count (only if nonzero, e.g. "3 issues are parked, run `/triage` to see them"), and any drift detected during the survey (e.g., a feature still labeled `needs-triage` despite having children, recommend `/triage` to clean up; a slice labeled `in-progress` with no sub-issues, recommend `/decompose`; a `size:feature` or `size:slice` missing its `**Integration Branch:**` body line, recommend `/triage`; an `in-progress` initiative whose features are all closed, suggest reviewing its Definition of done and closing manually). Use friendly phrasing: "Nothing in your triage queue" beats "Triage queue: 0." Skip the section if there's nothing meaningful.

## Step 6: Print the report

The report is the only thing the user sees. Do not preface it with "Here's the status:" or summarize what you're about to say. Just print it.

If a survey command failed (network, auth), include a single line at the end noting which signal is missing, e.g. "Couldn't reach the issue tracker. Recommendation may be incomplete." Don't let one failed query block the whole report.

## Verification

The skill's behavior is checked by hand against real tracker state, not automated tests. After any change to this skill:

- **Active feature surfacing.** With at least one `size:feature` + `in-progress` issue open, the lead paragraph names it.
- **Active initiative surfacing.** With at least one `size:initiative` + `in-progress` issue open, the lead paragraph mentions it by number and title alongside any active features. With zero active initiatives, the lead paragraph carries no sentinel line.
- **Rollup surfacing.** With an `in-progress` slice that has task children, "What's in motion" surfaces the rollup inline ("X of Y shipped").
- **Slice ready-to-ship.** With an `in-progress` slice whose task children are all closed, the recommendation is `/ship <slice#>`, before the feature-level check fires.
- **Feature ready-to-ship.** With an `in-progress` feature whose slice children are all closed, the recommendation is `/ship <feature#>`.
- **Feature → slice recursion.** With an `in-progress` feature whose open slice child has an open task, the recommendation comes from the slice-level rules (typically `/execute <task#>`), not from the feature itself.
- **Decision tree silent on initiatives.** No "What to do next" recommendation is generated *because* of an active initiative; only feature/slice/task/PR state drives the recommendation.
- **Initiative-DoD callout.** With an `in-progress` `size:initiative` whose feature children are all closed, "Anything else?" surfaces a one-liner suggesting the maintainer review the DoD and close manually (no `/ship` recommendation, because initiatives close manually).
- **Idle case.** With no active features, no active initiatives, and no open PRs, the report degrades to the truly-idle branch (`/grill-with-docs` or `/to-spec`).

## What this skill does NOT do

- It does not modify any state: no commits, pushes, label changes, or issue closures.
- It does not fix drift it detects. If state is out of date, it surfaces the issue and recommends the skill that handles it.
- It does not recommend skills outside the lifecycle. `/check`, `/audit`, `/diagnose`, `/improve-codebase-architecture`, `/tdd`, and the meta-skills (`/skill-creator`, `/simplify`) are deliberately not recommended here.
- It does not iterate or follow up. One report per invocation. The user re-runs `/status` whenever they want a fresh picture.
