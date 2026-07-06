# Ship — task tier (T1–T8)

*The task-tier subset of [SKILL.md](SKILL.md), for /batch Land agents that just opened a task PR. Promotion tiers (slice/feature/initiative) and rationale live in SKILL.md. The workflow prompt governs branch mechanics (detached HEAD, no named checkouts).*

Hard rails: one task per invocation; strict-stop on a dirty working tree; **refuse merges with failing checks or unresolved review** — nothing overrides CI; task tier is squash + `--delete-branch`.

## T1. Identify the PR

Under /batch you just opened the PR — use its number directly. Otherwise, from issue `<N>`:

```bash
gh pr list --state open --search 'in:body "Closes #<N>"' --json number,state,title,baseRefName,headRefName,url
```

Exactly one match → T2. Multiple → stop with a blocker. A PR based on a non-`main` integration branch deliberately omits `Closes #<N>`, so this search returns zero — not a missing PR; use the known PR number.

Zero matches when genuinely no PR exists → defensive close (tracker only, no git): `gh issue edit <N> --remove-label "ready-for-agent" --remove-label "in-progress"` then `gh issue close <N> --comment "Closed defensively (no PR shipped)."` — see SKILL.md T1d for the full flow.

## T2. Sanity-check the PR

```bash
gh pr view <PR#> --json number,state,mergeable,baseRefName,statusCheckRollup,reviewDecision,headRefName,body,url
```

Halt with the blocker if any fail:

- `state` is not `OPEN` → already merged or closed.
- `mergeable` is `CONFLICTING`.
- Any required check in `statusCheckRollup` is `FAILURE` — name the failed check(s).
- `reviewDecision` is `CHANGES_REQUESTED`. (`REVIEW_REQUIRED` and `null` are fine.)

`<base-branch>` is the PR's `baseRefName`. Capture the issue `<N>` from the body's closing reference (`Closes/Fixes/Resolves #<N>`) — or, under /batch, from the task context when the body omits it. No human confirmation step under /batch; these checks are the gate.

## T3. Verify clean working tree

```bash
git status --porcelain
```

Non-empty output → stop and report.

## T4. Merge

```bash
gh pr merge <PR#> --squash --delete-branch
```

If the merge fails (race, protected-branch policy), report the error and stop.

## T5. Close the task issue

The solo flow syncs a local base branch here (`git checkout <base-branch>` + `git pull --ff-only`); under /batch skip it — the workflow prompt governs branch mechanics and the task worktree is pruned at Settle.

```bash
gh issue view <N> --json state -q .state
```

- `OPEN` → strip active-state labels and close (`--remove-label` is no-op-safe):

  ```bash
  gh issue edit <N> --remove-label "ready-for-agent" --remove-label "in-progress"
  gh issue close <N> --comment "Shipped via #<PR#>."
  ```

  When `<base-branch>` is non-`main`, extend the comment: `"Shipped via #<PR#>. Will reach \`main\` when parent #<P> ships upward."` — derive `<P>` from the branch name:

  ```bash
  declaring_parent=$(printf '%s\n' "<base-branch>" | grep -oE 'issue-[0-9]+' | grep -oE '[0-9]+')
  ```

- `CLOSED` → leave it (GitHub's `Closes #<N>` auto-fired on a merge to `main`). Closing the sub-issue is enough parent-side; the native rollup updates implicitly.

Then recolor the parent's DAG — best-effort, never blocks. Parent is the task body's `**Part of:** #<P>` line; skip if orphan:

```bash
node "$(git rev-parse --show-toplevel)/.agents/skills/dag/recolor.mjs" <P>
```

No-op if the parent has no `## Sub-issue DAG` section; on failure log loudly and continue.

## T6. Delete the local head branch

```bash
git branch -D <head-branch-name>
```

`-D` is correct: squash means `-d` would refuse; the MERGED PR on the remote is the authority. If the branch doesn't exist locally (normal under /batch detached-HEAD worktrees), skip silently.

## T7. Re-verify clean working tree

```bash
git status --porcelain
```

Non-empty → surface it and flag for investigation.

## T8. Report

Report: PR squash-merged, issue closed (or why the close was skipped), DAG refresh result. Under /batch, return the fields the workflow prompt specifies — `shipped:true` only if the squash-merge actually landed.
