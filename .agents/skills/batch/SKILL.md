---
name: batch
description: Batch-execute the ready `size:task` sub-issues under a parent slice via a worktree-isolated workflow. Infers a dependency DAG, runs independent tasks in parallel and dependent ones in order, squash-merges every code-review-clean task into the slice branch, and — once all tasks land clean — opens one slice promotion PR for review. Use when the user says "/batch issue 35", "batch the tasks under #35", or "execute all the sub-issues of #35".
---

# Batch

Run `/execute` across the ready `size:task` children of one parent issue, as a single background [workflow](workflow.js). The orchestration — which tasks may run, in what order — is decided here, by the calling agent, and handed to the workflow as a dependency DAG.

Each task runs as a **4-stage pipeline of sibling agents** — Prep → Implement → Review → Land — which hoists `/execute`'s Step-7 delegation up into the workflow (stage agents read [execute/BATCH.md](../execute/BATCH.md) and [ship/TASK.md](../ship/TASK.md), the batch-facing subsets, instead of the full skill docs). This matters: the Implement agent gets a **clean context** (just the brief, the plan's sub-sections, the branch), exactly as a solo `/execute` keeps its implementation sub-agent clean — it is never asked to juggle base-branch resolution and parent-chain walks *and* write the code. Prep runs in a throwaway runtime-isolated worktree; Implement, Review, and Land (and the express path) share **one per-task worktree** under `.claude/worktrees/task-<N>` — created detached by the first implementing stage, one `pnpm install` per task instead of per stage, pruned by Settle — so parallel tasks stay fully isolated from each other and from the main checkout. State flows Prep→Implement→Review→Land through structured returns plus the shared worktree and origin. Prep's brief and plan are forwarded to every later stage, which also receives a **staleness note** naming any sibling that merged into the base after the branch was cut (integrate by merge, never rebase) — downstream stages don't re-fetch the issue or re-derive base history.

Two scheduler refinements keep the pipeline from paying for work already done: a task Prep judges **trivial** (one sub-section, ≤2 files, ≲30-line diff) runs an **express path** — a single agent implements, self-reviews (`/code-review medium`), and lands it, since a fresh 3-agent handoff around a nit-sized diff was measured ~87% scaffolding (the slice PR remains the human review gate). And when two parallel tasks' Prep plans declare the **same file**, the later-to-prep task waits for the current claim holder's whole pipeline to finish before implementing, then takes over the claim (waits follow claim order, not issue number, so further overlaps chain behind it) — over-serializing beats two agents resolving the same conflict.

The **Review stage** is an independent `/code-review high` pass run by a *different* agent than the implementer (a real second pair of eyes on correctness, not just the Land agent's on-contract/AC check). It auto-fixes blocking findings with one bounded fix-and-recount pass, then **gates the merge**: a task whose review leaves surviving blocking findings is *not* merged into the slice branch.

**The tasks are decomposition scaffolding; your review altitude is the slice.** So this skill squash-merges **every code-review-clean task** into the slice integration branch via `/ship` (task tier) — without an individual human review — and then, once *all* tasks have landed clean, opens **one slice promotion PR** for you to review and merge. That single PR is the review gate: no code reaches the feature branch (or `main`) without your eyes on the aggregate. Merging clean tasks into the slice branch without individual review is safe precisely because the slice branch is *staging* — it goes nowhere until you merge that promotion PR. A task held back by blocking findings stays an open PR (findings posted as a comment); it blocks the slice promotion PR from opening, and if any batched task depended on it the scheduler **cascade-skips those dependents** rather than stacking them on suspect code. Make all of this loud in the end-of-run output; never let an auto-merge be a surprise.

## Hard rules

- **One parent per invocation.** Batch the children of a single parent issue.
- **Only OPEN + `ready-for-agent` + `size:task` children enter the batch.** Everything else is reported as skipped with the reason; this skill never runs `/triage`, never decomposes, never relabels.
- **The dependency graph must be acyclic.** When unsure whether two tasks are independent, add an edge (serialize) — over-serializing wastes time; a bad parallel merge corrupts the integration branch.
- **Squash-merge every code-review-clean task into the slice branch.** Not just dependency predecessors — every task whose independent `/code-review` came back clean. A task with surviving blocking findings is held back as an open PR (and, if it had dependents, they cascade-skip).
- **Open the slice promotion PR, never merge it.** Once all tasks land clean, batch opens one `size:slice` promotion PR (review-first) and stops. That PR is the human review gate — the user reviews and merges it. If any task is held/failed the slice is incomplete, so the PR is *not* opened; the report says what to resolve.
- **One approval gate, here.** The user approves the whole plan in Step 4. Individual leaves do not stop for approval (that's what `/execute`'s inline mode disables); the slice PR opens without a further gate because opening a PR *is* what hands the user their review.

## Step 1: Identify the parent and pull its children

The parent issue number comes from the invocation ("`/batch issue 35`" → `35`). List its native sub-issues:

```bash
gh api "repos/{owner}/{repo}/issues/<P>/sub_issues" \
  --jq '.[] | {number, title, state, labels: [.labels[].name]}'
```

For each child, fetch the full body and comments — the briefs carry the dependency signals you need in Step 3:

```bash
gh issue view <N> --json number,title,body,labels,state,comments
```

## Step 2: Pre-flight filter

Partition the children:

- **Eligible** — `state == OPEN` AND labels include both `ready-for-agent` and `size:task`. These enter the batch.
- **Skipped** — everything else. Record the reason per issue (`needs-triage`, missing `ready-for-agent`, wrong size, already closed). These do **not** enter the workflow; they are surfaced in the Step 6 report with the right next step (usually `/triage <N>` or `/decompose <N>`).

If zero children are eligible, stop and report the skipped set with recommendations — there is nothing to batch.

## Step 3: Infer the dependency DAG

For each eligible task, determine which other eligible tasks it `dependsOn`. Combine three signals:

1. **Hard edges — `## Blocked by` lines.** `/decompose` writes `Blocked by #<N>` lines for non-linear sibling dependencies. Every such line that points at another *eligible* task is a hard edge (`Blocked by #A` on task B ⇒ B `dependsOn` A). Always respected.
2. **Linear-default from sub-issue order.** `/decompose` omits `## Blocked by` for the natural linear case (each child depends on the previous), relying on sub-issue order. Treat this as a *prior*, not a law: where briefs read as a sequence and you have no evidence two adjacent tasks are independent, add the linear edge.
3. **Judged code / logical overlap.** Read the briefs. Add an edge when task B's acceptance criteria logically require task A's output, or when both tasks modify the same files / module / migration (a parallel merge would conflict). When genuinely uncertain, add the edge — the cost is serialization, not corruption.

Drop edges that point at skipped (non-eligible) tasks — but if an eligible task is `Blocked by` a task that is *not done and not in this batch*, mark it **skipped** ("blocked by #X which isn't ready"), don't run it against a missing prerequisite.

The result is a list: `[{ number, title, dependsOn: [numbers] }, ...]`, acyclic.

## Step 4: Present the plan and get approval

Show the user, concisely:

- The eligible tasks and the inferred DAG, grouped so the parallelism is visible (e.g. "Wave 1 (parallel): #3, #5 · Wave 2: #4 after #3").
- **The end state:** "every task whose independent `/code-review` is clean squash-merges into `<integration-branch>` without individual human review; then, once all tasks land clean, I open one slice promotion PR for you to review and merge. A task held back by blocking findings stays an open PR (and blocks the slice PR until resolved); if it had dependents, they're skipped."
- The skipped tasks and their recommended next step.

Stop for approval, redirect, or correction of the DAG. **Do not start the workflow yet.** This is the batch's single approval gate.

## Step 5: Run the workflow

Resolve the absolute path to [workflow.js](workflow.js) sitting next to this skill, and invoke the `Workflow` tool:

```
Workflow({
  scriptPath: "<repo>/.claude/skills/batch/workflow.js",
  args: {
    parentIssue: <P>,
    tasks: [ { number, title, dependsOn: [...] }, ... ]   // the approved DAG from Step 4
  }
})
```

The workflow runs in the background and returns a structured `{ results, summary }`. It schedules each task to fire the moment *its* dependencies finish (true DAG scheduling, not whole-wave barriers), runs each task as the Prep → Implement → Review → Land pipeline (Prep in a throwaway isolated worktree, the rest sharing the task's own worktree), and squash-merges **every task whose independent code-review came back clean** into the slice branch (one held back by blocking findings stays an open PR and its dependents cascade-skip). You do not babysit it; `/workflows` shows live progress, grouped by stage.

After every task settles, a final **Settle** phase makes the run self-finishing — these are deterministic, single-purpose passes that hoist the rote end-of-run bookkeeping out of the per-task agents (which were observed to drop it):

- **Auto-defer.** Non-blocking code-review findings on an auto-merged task would vanish with its squash-merged, now-closed PR. The Settle phase verifies each (grep against the merged code), bundles them by seam, and files them as `cleanup` sub-issues of the slice — so flagged work is captured, not buried. Task-sized bundles are filed **pre-triaged** (`size:task` + `ready-for-agent`): the deferrer just verified every finding, so a triage pass would only rubber-stamp those two labels; bigger or murkier bundles get `needs-triage` for a real triage. Held / open-PR tasks keep their findings on the still-open PR. These land as `summary.deferred`.
- **Reconcile.** Re-asserts the lifecycle invariant `shipped task ⇒ PR merged AND issue closed AND active-state labels stripped` and heals any drift (e.g. a PR that merged but left its issue open), then runs the one authoritative DAG recolor. Healed actions land as `summary.reconciled.healed`.
- **Slice promotion PR.** When *every* batched task squash-merged cleanly, the slice branch now holds the whole slice — so this pass opens one `size:slice` promotion PR onto the parent's branch (or `main` for an orphan slice) in **review-first mode: it opens the PR, it does not merge it.** It reuses `/ship`'s own P1 gate, so a sibling that was skipped in the Step 2 pre-flight (and never entered the workflow) still correctly blocks the PR — reported as `blockedBy`. If any task is held/failed, the slice is incomplete and no PR is opened. Lands as `summary.slicePr`. This never merges anything and never checks out a branch (it must not disturb the main worktree's HEAD while other workflows may be running).
- **Cleanup.** Prunes only the worktrees *this run* created — Prep's runtime isolation dirs and the shared `task-<N>` worktrees alike (no stage removes its own) — it snapshots the worktrees that pre-exist at run start and excludes them, so a concurrent batch's live worktrees are never force-removed (and the cleanup no longer trips the "removing worktrees you didn't create this session" safety guard). Then it leaves the main worktree on the branch you'll want next: checked out on the slice's integration branch when a promotion PR was opened, so you can review or build the slice locally without switching first — otherwise it restores the pre-run branch if isolation left HEAD detached. Best-effort: a checkout that can't proceed (dirty tree, branch held elsewhere) reports where HEAD was left rather than failing the run. Lands as `summary.reconciled.headLeftOn`.

## Step 6: Report

Three-block output per [docs/agents/output-format.md](../../../docs/agents/output-format.md). Cover, from the workflow's `summary` plus the Step 2 skipped set:

Happy path (all tasks landed clean → slice PR opened):

```
Batched #<P>: <shipped> task(s) squash-merged into <integration-branch>, slice promotion PR opened. <deferred> finding(s) deferred, <failed> failed/skipped.

- Squash-merged into <integration-branch> (no individual human review, code-review clean): #<N> · ...
- 🚀 Slice promotion PR (review-first — review and merge to promote the slice): #<slicePR> <url> → targets <promotion-target>
- Deferred to new issues (non-blocking findings from the merged tasks, captured so they aren't buried): #<new> <url> (covers #<task>) · ...   ← only if any
- Reconciled: <healed actions, e.g. "closed #34 (merged but left open)"> · pruned <n> leftover worktree(s)   ← only if the Settle pass healed anything

> Next step: review the slice PR <url> and merge it (or `/ship #<P>`) to promote the slice; the deferred issues are mostly pre-triaged (`ready-for-agent`) — batch them onto the slice, or `/triage` any filed as `needs-triage`.
```

Exception path (a task was held/failed, or a pre-flight sibling still blocks → slice PR NOT opened):

```
Batched #<P>: <shipped> task(s) squash-merged into <integration-branch>, <heldForReview> held by code-review, <failed> failed/skipped. Slice PR not opened — slice is incomplete.

- Squash-merged into <integration-branch> (no individual human review, code-review clean): #<N> · ...   ← only if any
- Held from the slice merge by code-review (<blockingCount> blocking finding(s), PR open for a human): #<N> <url> · ...   ← only if any
- Slice PR not opened: blocked by open child #<A>, #<B> (resolve, then `/ship #<P>`)
- Deferred to new issues: #<new> <url> (covers #<task>) · ...   ← only if any
- Failed / skipped: #<N> — <blocker or "not ready: run /triage"> · ...

> Next step: resolve the held/failed tasks (fix + `/ship` each), `/triage` the deferred issues, then `/ship #<P>` to open the slice promotion PR.
```

Call out the merged tasks explicitly — they landed without individual human review (their independent `/code-review` was clean), and the reviewer should know to inspect them inside the slice promotion PR (that's the review surface). Call out the **slice PR** loudly — opened *or* withheld — because it's the whole point of the run: opened, it's what the user reviews; withheld, the named blockers are exactly what stands between them and a reviewable slice. Call out held-for-review tasks (each blocks the slice PR, and any dependents were skipped) and the **deferred issues** (non-blocking findings from merged tasks that would otherwise vanish with their closed PRs).

## Live DAG updates

A batch can run for a long time. If the parent issue carries a `## Sub-issue DAG` (from `/dag`), the workflow keeps it live so you can watch progress fill in without babysitting `/workflows`:

- **Amber on start.** When a task's Prep stage finishes and its branch is pushed, the workflow flips that task `ready-for-agent` → `in-progress` and recolors the parent's DAG — the node turns amber for the whole Implement → Review → Land span (the long part). Flipping at pipeline start is consistent with the label's meaning ("active work has begun"); it's earlier than a solo `/execute`'s flip-at-PR-open, which is the point — the chart should show work the moment it's underway. A task that Prep finds not-ready keeps its labels untouched.
- **Green on merge — free via `/ship`, guaranteed by Reconcile.** Every clean task closes through `/ship` (task tier), which recolors the parent after a close, so those nodes usually turn green on their own. But `/ship` runs inside a budget-limited Land agent and was observed to merge a PR yet leave its issue open — so the Settle phase's **Reconcile** pass re-asserts the close and strips active-state labels for any shipped-but-still-open task, making green-on-merge a guarantee rather than a hope. Only a task **held** by code-review (or failed) stays amber as an open PR — which is correct: those are exactly the nodes still needing a human.
- **Final sweep.** The Settle phase's Reconcile pass runs one authoritative recolor of the parent after every task settles *and* after it has healed any lifecycle drift. Per-stage refreshes race under parallelism (last-writer-wins on the parent body), so a node can briefly show a stale color; each recolor recomputes from live state, so it self-heals, and this trailing sweep guarantees the resting chart is correct. (Note: recolor only repaints **existing** nodes — any new `deferred` sub-issues the Settle phase files won't appear on the chart until you re-run `/dag <P>`.)

All of this is best-effort and gated on the parent actually having a DAG section ([recolor.mjs](../dag/recolor.mjs) is a no-op otherwise) — it never blocks or fails a batch. See [the dag skill](../dag/SKILL.md#refreshing-colors-only-the-recolormjs-fast-path) for the mechanism.

## What this skill does NOT do

- It does not run `/triage`, `/decompose`, or relabel anything. Non-ready children are reported, not fixed.
- It does not **merge** the slice promotion PR. It opens it in review-first mode and stops — merging it (promoting the slice onto the feature branch) is the user's call, via review + `/ship` or a manual merge. It also never promotes a *feature* upward.
- It does not merge a task with surviving blocking code-review findings. Every *clean* task is squash-merged into the slice branch; a held one stays an open PR and blocks the slice PR.
- It does not address PR review feedback, and it does not batch across more than one parent at a time.
