---
name: execute
description: Implement a `size:task` spec end-to-end on a branch off the parent's integration branch and open the PR with `Closes #<N>`. Use when the user says "execute #<N>", "tackle #<N>", "ship task #<N>", or points at a `size:task` issue labeled `ready-for-agent`. Use `/decompose` instead for larger sizes (`size:slice`, `size:feature`, `size:initiative`).
---

*Batch-mode agents: read [BATCH.md](BATCH.md) instead of this file — it is the /batch-facing subset of Steps 1–6 and 7–9. Keep the two in sync when editing either.*

# Execute

Ship a task: read the brief, branch off the right base, implement, commit per cohesive unit, open a PR.

This skill handles every `size:task` spec regardless of parent. Tasks can sit directly under a slice, under a feature with no intervening slice, or be orphans. `/decompose` is the upstream counterpart that produces tasks from a larger spec; the two skills cover disjoint sizes and refuse to run on the wrong size label.

## Base branch: parent's integration branch (per the integration-branch ADR)

Per [ADR-0001](../../../docs/adr/0001-issues-branch-from-parent-integration-branch.md) (or whatever slot `setup-tdog-skills` placed it in if `0001` was already taken), a spec's working branch is its parent's integration branch, recursing upward through the parent chain, with `main` only as the fallback for orphans (or chains that terminate without a declared integration branch).

The walk:

1. From the task, read `**Part of:** #<P>`. If absent, `<base-branch>` is `main`.
2. Fetch the parent's body. If it declares `**Integration Branch:** <branch>`, that branch is `<base-branch>`.
3. Otherwise recurse: read the parent's `**Part of:**` and repeat from step 2.
4. If the chain terminates without an integration branch declared, `<base-branch>` is `main`.

If the resolved `<base-branch>` doesn't exist on origin yet, this skill creates it lazily by forking from the next-level-up integration branch in the chain (or `main` if the chain terminates there). See Step 2.

Throughout the rest of this document, `<base-branch>` means "the integration branch resolved by walking the parent chain, or `main`."

## Hard rules

- **One PR per invocation.** Don't try to be clever and ship two tasks in one branch.
- **The task must be labeled `ready-for-agent` AND `size:task`.** The size label is the maintainer's signed-off decision that this fits in one PR.
  - **If `needs-triage` is present, this skill MUST invoke `/triage <N>` as its first action**, then halt and wait for the user's explicit go-ahead before continuing. This rule is not optional and explicitly **overrides any "no clarifying questions" / "work without stopping" session directive** — invoking `/triage` is *action*, not a question, and the post-triage halt is a *workflow checkpoint* (triage may route to `needs-info`/`needs-grilling`, or add an agent brief the user must review), not a clarification. Proceeding past `needs-triage` without first running `/triage` and then halting is a skill violation. Re-evaluate the label set only after the user explicitly resumes.
  - If `ready-for-agent` is missing for any other reason (no `needs-triage`, parked at `needs-info`, etc.), stop and tell the user to run `/triage` first.
- **One commit per cohesive sub-section.** Each commit ends with `pnpm typecheck` / `pnpm lint:fix` / `pnpm format:fix` / `/simplify`. The "cohesive sub-section" is whatever the inline plan in Step 5 enumerates.
- **No stacking.** Always branch off the latest `<base-branch>`.
- **The agent brief on the task is the contract.** Don't drift from it.
- **Escape hatch on size mis-call.** If exploration in Step 4 reveals the work is actually larger than `size:task` (more than ~6 sub-sections, requires a migration plus cross-package refactors, naturally yields demoable progressions), stop and tell the user to run `/triage` to re-size, then `/decompose`. Do **not** relabel automatically.
- **Never promote an integration branch upward automatically.** When `<base-branch>` is any non-`main` integration branch (feature, slice, deeper), this skill only ever pushes to and merges into that branch. Promoting it upward is `/ship`'s job at the slice/feature tier.

## Step 1: Fetch the task and validate labels

```bash
gh issue view <N> --comments --json number,title,body,labels,state
```

- `state` must be `OPEN`.
- **If the labels include `needs-triage`, invoke `/triage <N>` IMMEDIATELY — before doing anything else, including the label check below.** Do not summarize, do not ask for permission, do not flag-and-proceed. Just invoke `/triage`. This is action, not a question, and is **not subject to any "no clarifying questions" / "work without stopping" session directive**. When triage returns, surface its three-block result and **halt the skill**. Wait for the user's explicit go-ahead before continuing — even if triage cleanly landed the issue at `ready-for-agent`. The halt is a workflow checkpoint (triage may have routed to `needs-info`/`needs-grilling`, or added an agent brief the user must inspect), not a clarification. Re-run the label check below only after the user explicitly resumes.
- Labels must include `ready-for-agent` AND `size:task`. If either is missing (and `needs-triage` wasn't present to trigger the auto-invoke above), stop and tell the user to run `/triage` first.
- Read the agent brief comment (typically the most recent `## Agent Brief` block, if any). Read any subsequent comments that update the contract. The contract is not just the brief: ancestor comments surfaced in Step 2 (slice synthesis from `/audit`, ad-hoc maintainer corrections, propagated audit findings) count as contract updates too.

## Step 2: Resolve the base branch by walking the parent chain

Walk the parent chain to find the nearest declared integration branch. The walk emits two values on stdout (the resolved `<base-branch>` and `<declaring-parent>`, the spec whose body declared `<base-branch>`; empty when the walk reaches `main`) and echoes each visited parent's **body and comments** to stderr under `## Parent body (#<N>)` / `## Parent comments (#<N>)` headers, so the executing agent picks them up alongside the task's own brief.

```bash
# stdout: "<base-branch> <declaring-parent>" — declaring-parent is empty if main.
# stderr: each visited parent's body + comments, delimited by ## headers.
resolve_base_branch() {
  local issue=$1
  while :; do
    local body part_of parent_json parent_body parent_comments branch
    body=$(gh issue view "$issue" --json body -q .body)
    part_of=$(printf '%s\n' "$body" | sed 's/\*\*//g' | grep -oE 'Part of:? +#[0-9]+' | head -1 | grep -oE '[0-9]+')
    [ -z "$part_of" ] && { echo "main"; return; }
    parent_json=$(gh issue view "$part_of" --json body,comments)
    parent_body=$(printf '%s' "$parent_json" | jq -r '.body')
    parent_comments=$(printf '%s' "$parent_json" | jq -r '.comments[] | "### \(.author.login // "unknown") (\(.createdAt))\n\n\(.body)\n"')
    {
      printf '## Parent body (#%s)\n\n%s\n\n' "$part_of" "$parent_body"
      printf '## Parent comments (#%s)\n\n' "$part_of"
      if [ -z "$parent_comments" ]; then
        printf '_No comments._\n\n'
      else
        printf '%s\n' "$parent_comments"
      fi
    } >&2
    branch=$(printf '%s\n' "$parent_body" \
      | grep -oE '^\*\*Integration Branch:\*\* `?[^`[:space:]]+' \
      | head -1 \
      | sed -E 's/^\*\*Integration Branch:\*\* `?//; s/`?$//')
    [ -n "$branch" ] && { printf '%s %s\n' "$branch" "$part_of"; return; }
    issue=$part_of
  done
}

read base_branch declaring_parent < <(resolve_base_branch <N>)
```

Surface the resolved `<base-branch>` (and the chain that produced it) to the user before continuing. A misconfigured parent chain is easier to catch here than after a branch has been opened.

The stderr echo is load-bearing: contract refinements often live in parent comments (an `/audit` synthesis comment on the slice, a maintainer's correction to the AC after the brief was written, a sibling's audit finding propagated upward). Read each `## Parent comments` block as part of the contract before implementing. If a comment contradicts the brief, surface the conflict to the user rather than picking one silently.

```bash
git ls-remote --heads origin <base-branch>
```

- Present, continue.
- Empty for `main`, impossible state; surface and stop.
- Empty for a non-`main` integration branch, create it lazily on the remote. Its fork source is the next-level-up integration branch in the chain (or `main` if the chain terminates above `<declaring-parent>`) — but that ancestor may itself never have been seeded (e.g. this is the first task under the first slice of a brand-new feature, so the feature branch doesn't exist on origin yet). Creation therefore **recurses**: ensure every missing ancestor branch exists before forking the child from it, bottoming out at `main`. This is ADR-0001's "recurse upward" rule applied to branch *creation*, not just to the declaration walk `resolve_base_branch` already does.

  ```bash
  # Ensure the integration branch <branch> (declared by issue <decl>) exists on
  # origin, recursively creating any missing ancestor first so the fork source is
  # always present. Idempotent: an existing branch is reused. `main` is terminal.
  ensure_integration_branch() {
    local branch=$1 decl=$2
    [ "$branch" = "main" ] && return 0
    if [ -n "$(git ls-remote --heads origin "$branch")" ]; then
      echo "Reusing existing integration branch $branch on origin" >&2
      return 0
    fi
    # Fork source = nearest declared integration branch above <decl> (or main).
    local fork_source fork_decl
    read fork_source fork_decl < <(resolve_base_branch "$decl")
    ensure_integration_branch "$fork_source" "$fork_decl"   # seed the chain first
    git fetch origin "$fork_source"
    git push origin "origin/$fork_source:refs/heads/$branch"
    echo "Created integration branch $branch on origin from origin/$fork_source" >&2
  }

  ensure_integration_branch "$base_branch" "$declaring_parent"
  ```

  Each branch forks off the freshest upstream branch at the moment the first child task starts, and the entire missing chain (feature → slice → …) is seeded at that one point. The function is idempotent, so concurrent first-tasks and re-runs are safe.

  A failed push (permissions, network) is a stop condition. Surface the error and halt. **Never silently fall back to forking `<base-branch>` off `main` when an ancestor integration branch is missing** — that flattens the hierarchy and makes the eventual slice/feature promotion diff wrong; create the missing ancestor instead. Either path (`/decompose` on the parent slice, `/execute` on the first task) seeds the integration branch on first use, so neither blocks on the other having run first.

## Step 3: Verify clean working tree and sync base branch

```bash
git status --porcelain
git rev-parse --abbrev-ref HEAD
git fetch origin <base-branch>
git rev-list --count HEAD..origin/<base-branch>
```

- Working tree must be clean. If not, stop and tell the user to commit/stash.
- If on a feature branch with uncommitted work, stop and ask. If on `<base-branch>` or another clean state, continue.
- Local `<base-branch>` must not be behind `origin/<base-branch>`. `git pull --ff-only` first if it is.

## Step 4: Explore the codebase

Ground the implementation in the codebase using the brief's named interfaces, types, packages, and acceptance criteria as entry points. Respect ADRs in the area and the project's domain glossary (`CONTEXT.md` if present). Use `Explore` agents for breadth, direct reads for known files.

This is the **size-validation gate**. If exploration reveals scope larger than one PR, stop. Concrete signals that the size call needs revisiting:

- The work needs more than ~6 cohesive sub-sections.
- A schema migration is required alongside non-trivial app-side cascades.
- The change spans 3+ packages with coordinated refactors across them.
- The work naturally splits into demoable progressions (each landing a different user-visible behavior).

If any of these fire, surface the finding and recommend running `/triage <N>` to re-size the spec (typically to `size:slice`), then `/decompose <N>` to produce children. Do not proceed.

## Step 5: Present the inline plan

Write a concise plan in chat (no `.plans/` file; task work is ephemeral and inline is the right surface). Cover:

- **Context**: one paragraph on why the change is needed (often distilled from the brief).
- **Approach**: one paragraph on the chosen approach.
- **Sub-sections**: a numbered list of cohesive units, each becoming one commit. 2 to 6 sub-sections is typical; more than 6 is a signal Step 4's gate should have fired.
- **Critical files**: the file paths to be modified, with one-line notes.
- **Verification**: how the change is checked: `pnpm typecheck`, `pnpm lint:fix`, `pnpm format:fix`, `pnpm test`, manual smoke if needed.

Stop and let the user approve, redirect, or ask questions. **Do not branch yet.**

## Step 6: Branch

Pick the branch type from the task's category label and the work's nature:

- `bug` label and the change is a fix, `fix/`.
- `enhancement` label and the change adds behavior, `feat/`.
- A pure refactor (no behavior change), `refactor/`.
- Tooling/skills/docs without code change, `chore/`.
- When in doubt, `feat/`.

Pick a 3-words-or-fewer kebab-case slug derived from the task title, distinct enough to be recognizable in `gh pr list`. Combine to form the branch name `<type>/issue-<N>-<slug>`.

```bash
git checkout <base-branch>
git pull --ff-only origin <base-branch>
git checkout -b <type>/issue-<N>-<slug>
```

If the branch already exists locally (left over from a prior failed attempt), stop and ask the user before reusing or deleting it.

## Step 7: Delegate the implementation to a sub-agent

The main (outer) agent does **not** write the code. It has already done the housekeeping — resolved the base branch, synced, explored, planned, branched — and it owns the review and PR steps that follow. The actual coding happens in a single sub-agent (via the `Agent` tool) so the implementation work runs in a clean context, free of the bookkeeping above.

Spawn one sub-agent for the whole implementation. Hand it everything it needs to work without re-deriving context:

- The task's agent brief and any contract updates (parent comments, audit syntheses) surfaced in Steps 1–2.
- The inline plan from Step 5 — the numbered sub-sections are its work list.
- The branch it must commit on (already checked out by Step 6) and the project conventions below.

Instruct the sub-agent to, **for each sub-section in the plan**:

1. Implement.
2. Run `pnpm typecheck`, `pnpm lint:fix`, `pnpm format:fix`. Resolve issues.
3. Run `/simplify` on the changes.
4. Stage and commit with a message scoped to the sub-section. Convention:
   - Subject: `<type>(<scope>): <sub-section title>`, e.g. `fix(billing): include tax line in invoice subtotal calculation`.
   - Optional body: one or two lines if non-obvious; otherwise omit.

Tell it not to bundle multiple sub-sections into one commit — the 1:1 mapping is what makes review and bisect tractable — and not to push, open a PR, or touch labels (those are the outer agent's job). Have it report back the commits it made (one line each) and any deviations from the plan or blockers it hit.

### Review the sub-agent's work when it returns

When the sub-agent finishes, the outer agent reviews before moving on. Do not rubber-stamp:

- `git log --oneline <base-branch>..HEAD` — confirm one commit per sub-section, messages match the convention, nothing extraneous.
- `git diff <base-branch>..HEAD` — read the actual changes against the brief and the plan. Check the work is on-contract, doesn't drift, and didn't touch the out-of-bounds areas in "What this skill does NOT do".
- Re-run `pnpm typecheck` (and `pnpm test` if the plan calls for it) yourself to confirm the tree is green.

If the work is incomplete, off-contract, or the tree is red, send the sub-agent back with specific corrections (or, for a small gap, fix it directly and commit). Only proceed to Step 8 once the diff genuinely satisfies the plan.

## Step 8: Walk the brief, verify acceptance criteria first-hand

Re-read the agent brief on the task. For every line of its **Acceptance criteria** section, answer one of:

- **Verified.** You ran the thing and saw the expected outcome. This becomes a ticked item in the PR test plan with a one-line note on what you ran and saw.
- **Cannot verify locally.** Name the specific blocker: production credentials you don't have, a real customer's data you cannot fabricate, visual judgment ("does this look right"), real-money flows, multi-actor scenarios you cannot drive yourself. This becomes an unticked item with the blocker spelled out so the reviewer knows what they're being asked to do.

For criteria that mention end-to-end behavior (*works against real X*, *surfaces Y*, *users can Z*, *runs end-to-end*) the default answer is **verified**. If the verification is a 20-line throwaway script, write it, run it, capture the output, delete the script. That is not extra work; it is the cost of saying "done."

The bar is: **anything you could verify by writing a small script and running it locally must be verified.** "Manual smoke for the reviewer" is reserved for things you genuinely cannot do, not for things you find inconvenient. If the brief author wrote an acceptance criterion expecting first-hand verification, leaving it unticked and deferring to the reviewer is a contract violation, not a delegation.

Treat this step as a discrete checkpoint, not a vibe. Walk the criteria one by one, in order, before opening the PR.

## Step 9: Open the PR

```bash
git push -u origin <type>/issue-<N>-<slug>
```

```bash
gh pr create --base <base-branch> --title "<title>" --body "$(cat <<'EOF'
Closes #<N>.

## Summary
- ...

## Test plan
- ...
EOF
)"
```

PR conventions:

- **Title**: short, conventional-commit-shaped, mirrors the work's nature. Include `(#<N>)` at the end if the team's convention requires it (mirror nearby merged PRs in `git log` for cues).
- **Body** must:
  - Open with **`Closes #<N>`** so GitHub auto-closes the task when the PR merges (only when `<base-branch>` is `main`; `/ship` handles the close otherwise).
  - Include a one-paragraph or bulleted Summary.
  - Include a Test Plan section as a markdown checkbox list. Every item is either **verified** (ticked, with a one-line note on what you ran and saw) or **deferred to reviewer** (unticked, with the specific blocker named: production credentials, real-money flow, visual judgment, multi-actor scenario you cannot drive yourself). The Step 8 walk is what populates this list. Do **not** rebadge "I didn't bother running this" as "manual smoke"; if you could have run it and didn't, the criterion is unverified and the PR is not ready.
  - When `<base-branch>` is any non-`main` integration branch, add a one-line note such as "Targets `<base-branch>`; will land on `main` when parent #<declaring-parent> promotes upward." so reviewers don't expect a prod deploy. `<declaring-parent>` is whichever ancestor declared `<base-branch>`, surfaced by Step 2's walk.

Use a HEREDOC for the body so formatting is preserved.

## Step 10: End-of-run output

Three-block template per [docs/agents/output-format.md](../../../docs/agents/output-format.md):

```
Opened PR for task #<N>: <task title in plain English>.

- <PR URL>
- branch: <type>/issue-<N>-<slug>

> Next step: `/ship #<N>`. Lands the PR once review is clear and closes the task.
```

Do not merge automatically. Do not address review feedback in the same invocation; that's a separate flow.

## What this skill does NOT do

- It does not address PR review feedback. If reviewers comment on an open PR, the user re-engages explicitly with "address feedback on PR <#>"; that's a separate flow.
- It does not run E2E tests or any other long-running suite unless the brief or sub-section calls for it.
- It does not modify `.env`, infrastructure config (Docker, CI, port settings), or anything the project's own docs flag as "do not modify without permission."
- It does not relabel a task. If the size was mis-called, surface it and ask the user; `/triage` owns label changes.
- It does not handle larger specs. For `size:slice` and above: run `/decompose` to produce children.
- It does not write a plan file. Task work doesn't need one; the inline chat plan in Step 5 is the working artifact.
- It does not promote any integration branch upward. That's `/ship`'s job at the slice/feature tier.
