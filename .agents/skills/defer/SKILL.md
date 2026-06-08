---
name: defer
description: Capture cleanup / dedup / refactor findings as `cleanup`-labeled GitHub issues so they don't pollute the current PR. Use when a `/simplify` pass, code review, or ad-hoc exploration surfaces work that's real but out of scope for what you're shipping right now. Bundles related findings into one issue, verifies each claim with grep before opening, and links back to the surfacing PR/branch.
---

# Defer

Capture out-of-scope cleanup work as GitHub issues with `needs-triage` + `cleanup` labels, instead of letting it bloat the current PR or rot as inline TODOs.

The skill is the durable companion to `/simplify`: simplify finds a problem, defer parks it where the existing triage flow can decide if and when to ship it.

## When to use

- A `/simplify` pass turned up cross-cutting cleanup that's real but outside the current slice's scope (typical case).
- A code review surfaced refactor opportunities you don't want to act on right now.
- You hit duplicated logic mid-task and want to flag it for a future cleanup PR without context-switching.

## When NOT to use

- The finding is **inside** the current slice's scope — fix it in this PR.
- The finding is a bug or a feature gap, not housekeeping — open a regular `needs-triage` issue without `cleanup`.
- The finding is design-altering (terminology, invariants, architecture) — run `/grill-with-docs` instead so the decision lands in `CONTEXT.md` / an ADR.

## Process

### 1. Gather the findings

Work from whatever is already in the conversation context (typical: a `/simplify` agent's output, or a code-review summary). If the user hands you a free-form description, use that.

For each finding, extract:

- **What** — the duplication / hack / leak in one sentence.
- **Where** — concrete file paths with line numbers.
- **Why it's worth doing** — what the cleanup buys (consistency, type safety, fewer footguns).
- **Why deferred** — what made it out of scope for the surfacing PR (touches another package, requires design call, etc.).

### 2. Verify each claim

**Do not skip this.** Simplify agents and code-reviewers occasionally hallucinate file paths, miscount call sites, or flag patterns that have already been refactored.

For every cited file:line, run a quick `grep` or `Read` to confirm:

- The file exists at the path.
- The line referenced still contains the pattern claimed.
- The duplication count is accurate (don't write "10+ sites" if grep returns 3).

If a claim doesn't survive verification, drop it. If most claims fail, stop and surface that to the user — the source is unreliable and shouldn't drive an issue.

### 3. Bundle related findings

Group findings by **what package or seam they touch**. The natural grain:

- "Centralize X helpers in `<destination-package>`" — when multiple findings all argue for the same destination package.
- "Extract shared X to a common module" — when findings cluster around a single utility seam.
- One finding per issue when they don't share a destination.

Default to grouping. Splintering N findings into N issues makes triage death-by-a-thousand-cuts; one mega-issue makes the work undismissable. The right size is "one focused PR could land all of this."

### 4. Confirm the bundling with the user

Before opening anything, present the proposed issue split as a numbered list:

```
1. Issue: <title>  (covers findings: A, B)
2. Issue: <title>  (covers finding: C)
```

Ask: "Does this grouping look right? Want me to merge / split / drop any?"

Iterate until the user approves. Skip this step only if there's exactly one finding (no grouping decision to make).

### 5. Resolve the parent

The cleanup touches code on the surfacing spec's integration branch, not yet on `main`, so it must branch off that same parent. `/execute` walks `**Part of:**` to find it (see [execute](../execute/SKILL.md), "Base branch"), so the issue needs that line.

If the work was surfaced while executing task #T, read #T's body and use #T's own `**Part of:** #<P>` as the cleanup's parent — NOT #T itself (sizes step down by one tier; a task can't parent another task). If #P can't be determined, leave `**Part of:**` off and note it in the end-of-run output so the user can add it manually. Never guess a wrong parent.

### 6. Open the issues

For each approved issue, run `gh issue create` with:

- **Labels:** `needs-triage,cleanup` — both are required. `needs-triage` puts it in the normal triage flow; `cleanup` flags it as housekeeping for periodic sweeps.
- **Title:** action-oriented and concrete. "Centralize X in `<destination-package>`" beats "X is duplicated."
- **Body:** use the template below. The `**Part of:**` line (step 5) is the machine-readable lineage `/execute` follows; the `**Surfaced by:**` line is the required human breadcrumb so future-you can recover the context.

Use a HEREDOC for the body so markdown formatting is preserved. After each `gh` call, surface the returned issue URL to the user.

### 7. Print the end-of-run output

Three-block template per [output-format.md](../../../docs/agents/output-format.md). The chain genuinely terminates at `/defer` (the next move is `/triage` on each filed spec, but that's a separate, deliberate decision the maintainer makes later), so close with `Stop.` instead of a `Next step:` line.

Pluralise the outcome line by count (`Filed one cleanup spec.` / `Filed two cleanup specs.` / etc.). Each link is a full issue URL with the title in parens for readability:

```
Filed two cleanup specs.

- https://github.com/<owner>/<repo>/issues/37 (Centralize Postgres + JSON helpers in the shared utilities package)
- https://github.com/<owner>/<repo>/issues/38 (Consolidate storage-provider helpers)

Stop.
```

Do **not** offer to start work on the issues. Defer's job ends at the file system; triage is downstream.

## Issue body template

```markdown
**Part of:** #<P>
**Surfaced by:** PR #<N> (<short context, e.g. "asset-materializer simplify pass on branch feat/issue-8-asset-materializer">)

<One paragraph: what the cleanup is and why it's worth doing.>

## <Finding 1 title>

<Specifics. Cite each file:line as a markdown link so reviewers can click through.>

## <Finding 2 title>

<...>

## Scope

- <Concrete deliverables for the PR that addresses this issue.>
- Tests: <what new tests, if any>.

## Out of scope

- <What NOT to expand into. Keeps the cleanup PR from sprawling.>
```

## Hard rules

- **`needs-triage` + `cleanup` are both required.** Never skip `needs-triage` — without it, the issue won't enter the triage state machine and will get lost.
- **Verify before opening.** Step 2 is non-optional. A stale issue in the tracker is worse than no issue.
- **Link back to the surfacing PR/branch.** The `Surfaced by:` line is the audit trail.
- **Set `Part of:` to the surfacing spec's parent, never the spec itself.** Sizes step down by one tier (see [execute](../execute/SKILL.md), "Base branch"). If you can't resolve it, leave it off and tell the user — never guess.
- **Do not start work on the deferred items.** That's a separate, deliberate decision the user makes after triage.
- **Don't invent findings.** If the conversation context doesn't have something concrete, ask the user what to defer. Don't fabricate.
