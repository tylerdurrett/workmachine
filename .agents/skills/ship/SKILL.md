---
name: ship
description: Tier-aware ship skill. Reads the input spec's `size:*` label and dispatches. `size:task` squash-merges the PR, closes the task, prunes the local feature branch; falls back to a defensive close when no open PR exists. `size:slice` opens a promotion PR onto the feature integration branch (or `main` for orphans), prompts merge-now-or-review, closes the slice, deletes the local slice branch. `size:feature` opens the final promotion PR onto `main`, closes the feature, deletes the local feature branch, ticks the parent initiative's progress comment if any. `size:initiative` refuses (initiatives close manually). Use when the user says "ship task <N>", "ship slice <S>", "ship feature <F>", "land PR <#>", "close out slice <S>", "promote feature <F>", or "close task <N> defensively".
---

*Batch-mode agents: read [TASK.md](TASK.md) instead of this file — it is the /batch-facing task-tier subset (T1–T8). Keep the two in sync when editing either.*

# Ship

A single tier-aware ship skill. The user says "ship the thing"; the skill reads the input's `size:*` label and picks the right mechanics. The moment-of-truth (intermediate vs. user-visible production ship) lives in the outcome line, not in the skill's name.

| Tier              | What `/ship` does                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `size:task` (PR open)    | Squash-merge the PR, sync the local base branch, close the task, prune the local feature branch.                                                            |
| `size:task` (no PR)      | Offer a defensive close: strip active-state labels and close the task on the tracker, no git operations. Use when the work was absorbed elsewhere or dropped. |
| `size:slice`      | Verify children closed, open promotion PR onto the feature integration branch (or `main` for orphan slice), prompt merge-now-or-review, close the slice, delete the local slice branch. |
| `size:feature`    | Verify children closed, open promotion PR onto `main`, prompt merge-now-or-review, close the feature, delete the local feature branch, tick the parent initiative's `<!-- progress-comment:initiative -->` row if any. |
| `size:initiative` | Refuse. Initiatives close manually; see [docs/agents/lifecycle-initiative.md](../../../docs/agents/lifecycle-initiative.md).                                       |

This skill is stateful at the promotion tiers but presents as a single invocation: it detects whether a promotion PR already exists and whether it has been merged, and resumes from the right step. Re-running is always safe.

## Hard rules

- **One spec per invocation.** Even if multiple ship candidates are ready, stop after one.
- **Strict-stop on a dirty working tree.** Surface what's there and ask the user; do not auto-restore.
- **Refuse merges with failing checks or unresolved review.** "I'm happy with it" doesn't override CI. The user merges manually with `gh` directly if they want to override.
- **At the task tier: squash + `--delete-branch`, force-delete the local feature branch (`-D`).** Squash produces non-byte-identical commits; the PR being MERGED on the remote is the authority.
- **At the slice/feature tier: merge commit (`gh pr merge --merge`), safe local-branch delete (`-d`, never `-D`).** A merge commit on the promotion target preserves the per-child PR history. If `-d` refuses, that is signal: stop and ask.
- **Do not touch the remote integration branch at the slice/feature tier.** Leaving it on origin preserves an emergency rollback path. A future cleanup sweep removes the remote branch after a grace period.

## Step 1: Identify the spec and dispatch

If the user passed an issue number `<N>`, use it. Otherwise infer from the current branch:

- `feat|fix|refactor|chore/issue-<N>-<slug>` -> task ship for `<N>`.
- `slice/issue-<N>-<slug>` -> slice ship for `<N>`.
- `feature/issue-<N>-<slug>` -> feature ship for `<N>`.
- Anything else -> ask the user.

Read the spec's size label:

```bash
gh issue view <N> --json state,title,labels --jq '[.labels[].name] | map(select(startswith("size:"))) | .[0]'
```

- `size:task` -> [Task-tier flow](#task-tier-flow).
- `size:slice` or `size:feature` -> [Promotion flow](#promotion-flow-slice-and-feature).
- `size:initiative` -> refuse:
  > Initiatives close manually. The maintainer decides when the initiative's Definition of done is met. See `docs/agents/lifecycle-initiative.md`.
- Missing or unrecognized -> refuse and recommend `/triage <N>` to size it.

If the spec is already `CLOSED` at the promotion tiers, the previous run finished; skip directly to the final-cleanup verification block and exit.

## Task-tier flow

The closing bracket of `/execute` for any task, regardless of parent kind. The flow branches on whether an open PR exists:

- **PR exists**: squash + delete-branch + fast-forward base + close task. Steps T1 through T8.
- **No PR exists**: defensive close on the tracker, no git operations. Step T1d.

GitHub's `Closes #<N>` keyword only auto-closes when a PR merges into the repo's default branch. Per [ADR-0001](../../../docs/adr/0001-issues-branch-from-parent-integration-branch.md) (or whatever slot the integration-branch ADR landed in), almost every task PR targets a non-`main` integration branch, so this skill makes that gap invisible.

### T1. Identify the PR (or route to defensive close)

If the input was a PR number directly, use it. If it was an issue number `<N>`, search for the open PR that closes it:

```bash
gh pr list --state open --search 'in:body "Closes #<N>"' --json number,state,title,baseRefName,headRefName,url
```

- Exactly one match -> use it; continue to T2.
- Multiple matches -> stop and ask which PR.
- Zero matches -> route to [T1d: Defensive close](#t1d-defensive-close-no-open-pr).

### T2. Sanity-check the PR

```bash
gh pr view <PR#> --json number,state,mergeable,baseRefName,statusCheckRollup,reviewDecision,headRefName,body,url
```

Halt with a clear message if any of these fail:

- `state` is not `OPEN` -> already merged or closed; ask the user.
- `mergeable` is `CONFLICTING` -> tell the user to resolve and try again.
- Any required check in `statusCheckRollup` is `FAILURE` -> name the failed check(s) and stop.
- `reviewDecision` is `CHANGES_REQUESTED` -> stop. (Treat `REVIEW_REQUIRED` and `null` as fine; branch protection will enforce if it must.)

Parse the PR body for the closing reference (`Closes #<N>`, `Fixes #<N>`, `Resolves #<N>`). Capture `<N>`. If absent, surface and ask whether to proceed without the issue-close step.

`<base-branch>` is the PR's `baseRefName`.

Summarize the PR (number, title, base, head, the issue it closes) and ask the user to confirm before proceeding.

### T3. Verify clean working tree

```bash
git status --porcelain
```

If output is non-empty: stop, show the user, suggest `git restore`/`git stash`/`git add && git commit` without acting on any of them, ask the user to clean up and re-run.

### T4. Merge

```bash
gh pr merge <PR#> --squash --delete-branch
```

If the merge fails (race against another push, protected-branch policy), surface the error and stop.

### T5. Sync the local base branch and close the task issue

```bash
git fetch origin <base-branch>
git checkout <base-branch>
git pull --ff-only origin <base-branch>
```

If the local base branch refuses to fast-forward, stop.

Then close the task issue:

```bash
gh issue view <N> --json state -q .state
```

- If `OPEN`: strip the active-state labels and close with a comment:

  ```bash
  gh issue edit <N> --remove-label "ready-for-agent" --remove-label "in-progress"
  gh issue close <N> --comment "Shipped via #<PR#>."
  ```

  When `<base-branch>` is any non-`main` integration branch, extend the comment: `"Shipped via #<PR#>. Will reach \`main\` when parent #<P> ships upward."` Derive `<P>` from the branch name (the embedded issue number):

  ```bash
  declaring_parent=$(printf '%s\n' "<base-branch>" | grep -oE 'issue-[0-9]+' | grep -oE '[0-9]+')
  ```

  `<P>` here is the immediate ancestor whose body declared `<base-branch>`. Under the recursive rule (the integration-branch ADR) the chain may be deeper (slice -> feature -> main), but the comment names only the immediate parent because that is the next promotion step the task is waiting on.

- If `CLOSED`: leave it. GitHub's `Closes #<N>` keyword auto-fired (the PR merged to `main`).

Closing the sub-issue is enough on the parent side: GitHub's native sub-issue rollup on the parent's panel updates implicitly when a child closes. There is no separate parent-side write to perform at this tier.

If no closing reference was found in T2, skip the issue-close step entirely and note in the final report that no issue was closed.

Then refresh the parent's DAG (best-effort) — see [Refresh the parent's Sub-issue DAG](#refresh-the-parents-sub-issue-dag-best-effort). The task's parent is its body's `**Part of:** #<P>` line; if absent (orphan task), skip.

### T6. Delete the local feature branch

```bash
git branch -D <head-branch-name>
```

`-D` is correct here: squash merge means the feature branch's commits are not byte-identical to anything on the base, so `-d` refuses. The PR being MERGED on the remote is the authority.

If the local branch does not exist (already cleaned up, or worked from a different machine), skip silently.

### T7. Re-verify clean working tree

```bash
git status --porcelain
```

Defense-in-depth: T3 already guaranteed a clean entry, and `checkout` / `pull --ff-only` / `branch -D` should not introduce dirt under normal conditions. If output is non-empty, surface it and tell the user to investigate.

### T8. End-of-run output (task tier)

Three-block template per [output-format.md](../../../docs/agents/output-format.md). Outcome line names the task in plain English. Next-step rules:

- If the parent slice/feature has more open task children -> `> Next step: \`/execute #<next>\`. <reason>.`
- If the closing task was the parent's last open child -> `> Next step: \`/ship #<parent>\`. <reason>.`
- If the task was orphan -> `Stop.`

### T1d. Defensive close (no open PR)

Routed to from T1 when zero open PRs reference `Closes #<N>`. The skill closes the task on the tracker only; no git operations.

Fetch the task to confirm it's the right shape:

```bash
gh issue view <N> --json number,state,title,labels,body
```

- `state` must be `OPEN`. If `CLOSED`, tell the user the task is already closed and stop; do not touch labels on a closed issue (GitHub preserves them as historical record).
- The size label was already verified as `size:task` in Step 1; no re-check needed here.
- If the task is itself a parent with open sub-issues (`gh api repos/{owner}/{repo}/issues/<N>/sub_issues`), refuse: close the children first via `/ship` per child, then re-run.

Surface the situation to the user and confirm before writing:

> No open PR was found for task #<N> ("<title>"). Common reasons:
>
> - The work was absorbed into another PR and the task is no longer needed.
> - The scope was dropped or no longer relevant.
> - A PR exists but uses a different keyword (`Fixes`, `Resolves`); search manually if so.
>
> Want me to close #<N> defensively? I will strip `ready-for-agent` / `in-progress` and post a close comment. No branches or PRs are touched.

Wait for confirmation. The user may supply a reason ("absorbed into #99", "no longer relevant after schema change"); use it verbatim in the close comment when given. Otherwise default to "Closed defensively (no PR shipped)."

On confirmation:

```bash
gh issue edit <N> --remove-label "ready-for-agent" --remove-label "in-progress"
gh issue close <N> --comment "<reason>"
```

`--remove-label` is no-op-safe; missing labels don't error.

End with the three-block template:

```
Closed task #<N> defensively: <task title in plain English>.

- <issue URL>

> Next step: <derived per the rules below>.
```

Next-step rules mirror T8:

- If the parent slice/feature has other open task children -> `> Next step: \`/execute #<next>\`. <reason>.`
- If this task was the parent's last open child -> `> Next step: \`/ship #<parent>\`. <reason>.`
- If the task was orphan -> `Stop.`

Derive the parent from the task body's `**Part of:** #<P>` line if present.

## Promotion flow (slice and feature)

Land a slice's or feature's integration branch on its parent's branch (or `main` for orphans / for features), then close the parent spec and clean up locally. This is the recursive shape from [ADR-0001](../../../docs/adr/0001-issues-branch-from-parent-integration-branch.md) (or the slot it landed in if `0001` was already taken): an issue's working branch is its parent's integration branch, and `main` is the terminal fallback.

The flow is stateful but presents as a single invocation: it detects whether a promotion PR already exists and whether it has been merged, and resumes from the right step. Re-running is always safe; at worst it is a no-op.

| Closing spec       | Promotion target                       |
| ------------------ | -------------------------------------- |
| Slice, orphan      | `main`                                 |
| Slice under a feature | the feature's integration branch    |
| Feature, orphan    | `main`                                 |
| Feature under an initiative | `main` (initiatives have no integration branch) |

### P1. Verify all native sub-issues are closed

Partition open children into **blocking** (real scope that must land before promotion) and **deferred** (`cleanup`- or `deferred`-labeled housekeeping — typically findings parked by `/defer` or auto-filed by a `/batch` Settle pass, explicitly future work):

```bash
owner_repo=$(gh repo view --json nameWithOwner -q .nameWithOwner)
open_blocking=$(gh api "repos/${owner_repo}/issues/<N>/sub_issues" \
  --jq '.[] | select(.state == "open") | select([.labels[].name] | (index("cleanup") or index("deferred")) | not) | "#\(.number) — \(.title)"')
open_deferred=$(gh api "repos/${owner_repo}/issues/<N>/sub_issues" \
  --jq '.[] | select(.state == "open") | select([.labels[].name] | (index("cleanup") or index("deferred"))) | "#\(.number) — \(.title)"')
```

If `open_blocking` is non-empty, stop and tell the user:

> Parent #<N> still has open sub-issues. Close each one via `/ship` (PR-merge or defensive close, picked automatically):
> <list>

Do not force-close children. The user re-engages explicitly per child.

`open_deferred` does **not** block promotion — deferred work is, by definition, for later. But carry it forward: surface it loudly in the P9 report so it's acknowledged at the gate instead of silently promoted past (this is the anti-burial guarantee — a slice never ships while quietly orphaning the cleanup it spawned). Keep the list for P9.

### P2. Identify the integration branch and verify clean tree

Read the spec body for the integration-branch declaration:

```
**Integration Branch:** `<branch>`
```

If absent, refuse: spec has no integration branch declared, so there is nothing to promote.

```bash
git status --porcelain
git fetch origin <integration-branch>
git checkout <integration-branch>
git pull --ff-only origin <integration-branch>
```

Working tree must be clean. Local integration branch must match `origin/<integration-branch>` after the fast-forward.

### P3. Resolve the promotion target

For a `size:feature` -> `main`.

For a `size:slice` -> walk the parent chain:

1. Read the slice body for `**Part of:** #<P>` (the parent reference).
2. If absent -> target is `main` (orphan slice).
3. If present, fetch the parent's body and look for `**Integration Branch:**`. If found, target is that branch.
4. If the parent has no integration branch (it is an initiative, or hand-created without declaration), target is `main`.

Reference implementation:

```bash
resolve_promotion_target() {
  local issue=$1
  local size=$2
  if [ "$size" = "size:feature" ]; then
    echo "main"; return
  fi
  local body
  body=$(gh issue view "$issue" --json body -q .body)
  local part_of
  part_of=$(printf '%s\n' "$body" | grep -oE '^\*\*Part of:\*\* #[0-9]+' | grep -oE '[0-9]+' | head -1)
  [ -z "$part_of" ] && { echo "main"; return; }
  local parent_body
  parent_body=$(gh issue view "$part_of" --json body -q .body)
  local branch
  branch=$(printf '%s\n' "$parent_body" \
    | grep -oE '^\*\*Integration Branch:\*\* `?[^`[:space:]]+' \
    | head -1 \
    | sed -E 's/^\*\*Integration Branch:\*\* `?//; s/`?$//')
  [ -n "$branch" ] && { echo "$branch"; return; }
  echo "main"
}

promotion_target=$(resolve_promotion_target <N> <size>)
```

Surface `<promotion-target>` to the user before continuing so a misconfigured parent chain is caught early.

### P4. Detect an existing promotion PR

```bash
gh pr list --base <promotion-target> --head <integration-branch> --state all --json number,state,url,mergedAt
```

Branch on the result:

- **No PR exists** -> continue to P5 (open one).
- **PR exists, `OPEN`** -> skip to P6 (prompt merge-now-or-review).
- **PR exists, `MERGED`** -> skip to P7 (final cleanup).
- **PR exists, `CLOSED` and not merged** -> unusual. Stop and ask before proceeding.

### P5. Open the promotion PR

Build the PR body. Child references are best derived from the merge commits on the integration branch since it was forked off `<promotion-target>`:

```bash
git log --merges "origin/${promotion_target}..${integration_branch}" --pretty='format:%s'
```

Use those merge-commit subjects to populate the body.

```bash
gh pr create \
  --base <promotion-target> \
  --head <integration-branch> \
  --title "feat: ship #<N> — <spec-title>" \
  --body "$(cat <<EOF
## Summary

Promotes integrated work for #<N> from \`<integration-branch>\` to \`<promotion-target>\` as a single deploy.

Closes #<N>

## Children shipped

<bulleted list derived from merge commits on the integration branch>

## Test plan

The integration branch was built incrementally via per-child PRs that each carry their own coverage. Recommended verification before merge:

- [ ] Diff \`<integration-branch>\` against \`<promotion-target>\` is the union of all child changes
- [ ] CI on the integration branch is green
- [ ] Spot-check one or two end-to-end flows that exercise the integrated work
EOF
)"
```

When `<promotion-target>` is not `main`, add a one-line note in the body such as "Targets `<promotion-target>`; will reach `main` when the parent ships." so reviewers do not expect a prod deploy.

Surface the new PR URL.

### P6. Prompt merge-now-or-review-first

> Promotion PR is open at `<url>`.
>
> Options:
>   1. **Merge now**. I will run `gh pr merge --merge` and wait for it to land, then continue to final cleanup.
>   2. **Review first**. I will stop here. Re-run `/ship <N>` after you have merged it on GitHub.

Wait for the user's choice.

- **Merge now:** `gh pr merge <pr-number> --merge`. Wait for completion. If the merge fails (CI red, conflicts, branch protection), surface the error and stop; the user resolves and re-runs.
- **Review first:** stop. Tell the user the PR URL again and the exact re-invocation: `/ship <N>`.

After a successful merge-now, continue to P7 in the same invocation.

### P7. Final cleanup

By this point the promotion PR is merged. Confirm by fetching:

```bash
git fetch origin <promotion-target>
git log "origin/${promotion_target}" --oneline -5
```

Then:

1. **Close the spec issue if open:**

   ```bash
   gh issue view <N> --json state -q .state
   ```

   - If `OPEN`: remove the `in-progress` label, then close with a comment:
     ```bash
     gh issue edit <N> --remove-label "in-progress"
     gh issue close <N> --comment "Promoted to <promotion-target> via PR #<pr-number>. All sub-issues shipped."
     ```
   - If already `CLOSED` (the promotion PR's `Closes #<N>` did it on merge, only possible when `<promotion-target>` is the repo default branch): skip.

2. **Switch off the integration branch and delete it locally:**

   ```bash
   git checkout <promotion-target>
   git pull --ff-only origin <promotion-target>
   git branch -d <integration-branch>
   ```

   If `git branch -d` refuses, the local integration branch has commits not in `<promotion-target>`. Stop and surface the refusal verbatim; do not retry with `-D`.

3. **Do not delete the remote integration branch.** It stays on origin until a future grace-period sweep.

4. **Refresh the parent's DAG (best-effort)** — see [Refresh the parent's Sub-issue DAG](#refresh-the-parents-sub-issue-dag-best-effort). The parent is this spec's `**Part of:** #<P>` line — the same `gp_num` P8 derives below. For a slice that's the feature; for a feature that's the initiative. If orphan (no `**Part of:**`), skip.

### P8. Tick the parent's progress comment (best-effort, feature tier)

After the spec issue closes, check whether this spec has a parent with a sticky progress comment to tick. Only initiatives carry `<!-- progress-comment:initiative -->`, so this step only does work at the feature tier; at the slice tier (parent is a feature) the lookup falls through to a silent skip.

Best-effort, loudly logged on failure, never blocks close:

```bash
parent_num=<N>
parent_body=$(gh issue view "$parent_num" --json body -q .body)
gp_num=$(printf '%s\n' "$parent_body" | grep -oE '^\*\*Part of:\*\* #[0-9]+' | grep -oE '[0-9]+' | head -1)

# Orphan parent -> silent skip.
if [ -n "$gp_num" ]; then
  gp_size=$(gh issue view "$gp_num" --json labels --jq '[.labels[].name] | map(select(startswith("size:"))) | .[0]')
  case "$gp_size" in
    size:initiative) marker="<!-- progress-comment:initiative -->" ;;
    size:feature)    marker="" ;;  # features carry no marker; silent skip
    *)
      echo "Loud: grand-parent #${gp_num} has size '${gp_size:-<none>}'; no progress-comment marker applies. Skipping tick."
      marker=""
      ;;
  esac

  if [ -n "$marker" ]; then
    gp_comment_id=$(gh api "repos/${owner_repo}/issues/${gp_num}/comments" \
      --jq ".[] | select(.body | startswith(\"$marker\")) | .id" | head -1)

    if [ -z "$gp_comment_id" ]; then
      echo "Loud: grand-parent #${gp_num} is missing its ${marker} comment — cannot tick #${parent_num}. Re-seed by hand if you want the historical row."
    else
      existing=$(gh api "repos/${owner_repo}/issues/comments/${gp_comment_id}" --jq .body)
      updated=$(printf '%s\n' "$existing" | sed -E "s/^- \[ \] #${parent_num} — (.*)$/- [x] #${parent_num} — \1/")
      if [ "$existing" = "$updated" ]; then
        echo "Loud: no '- [ ] #${parent_num} — ...' row found in grand-parent #${gp_num}'s ${marker} comment — nothing ticked. The spec is closed; only the comment is stale."
      else
        gh api -X PATCH "repos/${owner_repo}/issues/comments/${gp_comment_id}" -f body="$updated" \
          || echo "Loud: PATCH to tick row on grand-parent #${gp_num}'s ${marker} comment failed. The spec is closed; the row is stale."
      fi
    fi
  fi
fi
```

Every branch falls through to P9. Closure has already succeeded by the time this block runs; a stale checkbox on the grand-parent is not worth blocking on.

This step is intentionally late in the flow (after the spec is closed and after the local branch is deleted), so a tracker-side hiccup here cannot un-do the closure work.

### P9. End-of-run output (slice / feature tier)

Three-block template. Outcome line carries the moment-of-truth signal:

- Slice -> "Slice #<N> integrated onto `<feature-slug>` (intermediate; not user-visible yet)." (Or onto `main` for orphan slices.)
- Feature -> "Feature #<N> shipped to production." (Or the orphan-feature analog.)

Links: promotion PR URL, closed spec URL, parent's ticked row when applicable.

If `open_deferred` (from P1) is non-empty, add a **Deferred work carried forward** line listing those issues — the cleanup/findings this spec spawned that are now promoting un-addressed. They didn't block the ship, but the reader should know they're outstanding:

```
> Deferred work carried forward (not blocking, but now in `<promotion-target>` un-addressed): #<N> <title> · ...
>   Run `/triage` on each to size and ready it, then `/execute` (or `/batch`) before they rot.
```

Next step:

- Slice whose parent feature still has open sibling slices -> `Stop.` (the user picks the next slice).
- Slice whose parent feature has zero open children remaining -> `> Next step: \`/ship #<feature>\`. The feature is now ready to ship to production.`
- Feature whose parent initiative still has open siblings -> `Stop.` with a note that the initiative remains in flight; close it manually when its Definition of done is met.
- Orphan slice or feature -> `Stop.`.

## Refresh the parent's Sub-issue DAG (best-effort)

Shared by both flows (task tier in T5, slice/feature tier in P7). When a child closes/merges, the custom Mermaid DAG that `/dag` may have written onto the **parent's** body goes stale — unlike GitHub's native rollup, it does not auto-update. So after the close, recolor it:

```bash
node "$(git rev-parse --show-toplevel)/.agents/skills/dag/recolor.mjs" <P>
```

`<P>` is the just-closed spec's parent (derived per the calling step). The script is a **no-op** if the parent has no `## Sub-issue DAG` section, so DAGs stay opt-in per parent — nothing is created where none existed.

Rules, mirroring P8's progress-comment tick:

- **Best-effort, never blocks the ship.** The close already succeeded by the time this runs. On any failure, log loudly and continue to the end-of-run output; a stale chart is not worth undoing a merge.
- **Conditional / idempotent.** Only an existing chart is touched, and only its node colors; re-running is safe.
- **Skip for orphans.** No parent → nothing to refresh.

See [the dag skill's recolor section](../dag/SKILL.md#refreshing-colors-only-the-recolormjs-fast-path) for what the script does and why it's safe to run concurrently.

## What this skill does NOT do

- It does not close initiatives. Initiatives close manually; see [docs/agents/lifecycle-initiative.md](../../../docs/agents/lifecycle-initiative.md).
- It does not delete the remote integration branch at the slice/feature tier. That is a deliberate later action, possibly a future cleanup-sweep skill.
- It does not merge child PRs onto the integration branch. That happens incrementally via `/execute` + `/ship` at the task tier.
- It does not roll back a merged promotion. If something goes wrong post-merge, the rollback path is `git revert` on `<promotion-target>` plus the still-present remote integration branch.
- It does not start the next task. That's `/execute`.
- It does not override merge style. Task tier is squash; slice/feature tier is merge commit. The shapes carry different audit-trail intent.
- It does not auto-restore a dirty working tree. Strict-stop, ask, defer to the user.

## Verification

Manual end-to-end checklist: what to run, what to inspect, what "correct" looks like.

### Task tier: happy path

1. Open a PR for a `size:task` issue via `/execute <N>`, get it to clean CI + clean review.
2. Run `/ship <N>` (or `/ship <PR#>`). Steps T1–T7 should complete: PR squash-merged with `--delete-branch`, base branch fast-forwarded, task issue closed with the "Shipped via #<PR#>" comment, local feature branch force-deleted.
3. **Inspect the tracker:** the task issue is `CLOSED`. The `ready-for-agent` and `in-progress` labels are stripped. The parent slice/feature panel reflects the closed sub-issue (via GitHub native rollup).
4. **Inspect the next-step block:** if siblings remain, recommends `/execute #<next>`; if the task was the last open child, recommends `/ship #<parent>`.

### Task tier: defensive close (no open PR)

1. Pre-conditions: a `size:task` `<N>` is `OPEN`, no open PR references `Closes #<N>`. Typical reason: the work was absorbed into another PR, or the scope was dropped.
2. Run `/ship <N>`. T1 finds zero matching PRs and routes to T1d. The skill surfaces the situation, lists the common reasons, and asks for confirmation before any tracker writes.
3. On confirmation, the task is closed with the `ready-for-agent` / `in-progress` labels stripped and a close comment posted (default `"Closed defensively (no PR shipped)."`, or a user-supplied reason verbatim).
4. **Inspect the tracker:** task is `CLOSED`. No branches were created or deleted.
5. **Outcome line** reads "Closed task #<N> defensively: <title>." Next-step block follows the same parent-rollup rules as T8.

### Slice tier: happy path (child of a feature)

1. Pre-conditions: a `size:slice` `<S>` with `**Integration Branch:** slice/issue-<S>-<slug>` and `**Part of:** #<F>` where `<F>` is a `size:feature` declaring its own `**Integration Branch:**`. All of `<S>`'s tasks are closed.
2. Run `/ship <S>`. Promotion target resolves to `feature/issue-<F>-<slug>` (the feature's branch). Promotion PR opens with `--base feature/issue-<F>-<slug>`. P1–P7 close the slice; P8 silent-skips (features carry no progress-comment marker, so there's nothing to tick).
3. **Inspect the tracker:** the slice issue is `CLOSED`. The feature panel reflects the closed sub-issue. The feature itself is **not** closed.
4. **Outcome line** names the slice and the feature in plain English: "Slice #<S> integrated onto the <feature-title> branch (intermediate; not user-visible yet)."

### Feature tier: user-visible production ship

1. Pre-conditions: a `size:feature` `<F>` with `**Integration Branch:** feature/issue-<F>-<slug>`. All slices closed. `**Part of:** #<I>` references a `size:initiative`. The initiative has a `<!-- progress-comment:initiative -->` comment with a `- [ ] #<F> — <title>` row.
2. Run `/ship <F>`. Promotion target resolves to `main`. PR opens with `--base main`. P1–P7 close the feature; P8 ticks the initiative's row.
3. **Inspect the initiative's sticky comment:** the matching row is now `- [x] #<F> — <title>` (only the leading `[ ]` flipped; the title is preserved). Other rows are unchanged.
4. **Outcome line** carries the moment-of-truth signal: "Feature #<F> shipped to production." Next-step block notes the initiative remains open (manual closure).

### Initiative tier: refusal

1. Run `/ship <I>` on a `size:initiative`.
2. The skill refuses with the manual-closure explanation and links to `docs/agents/lifecycle-initiative.md`. No tracker writes, no git operations.

### Missing size label: triage nudge

1. Run `/ship <N>` on an issue with no `size:*` label.
2. The skill refuses and recommends `/triage <N>` to size the spec before shipping.

If any step surfaces drift, fix the skill in a follow-up rather than the issue; the skill is the source of truth.
