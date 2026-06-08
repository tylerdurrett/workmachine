---
name: batch
description: Batch-execute the ready `size:task` sub-issues under a parent issue via a worktree-isolated workflow. Infers a dependency DAG, runs independent tasks in parallel and dependent ones in order, and auto-ships (squash-merges) any task another batched task depends on so dependents can build on it. Use when the user says "/batch issue 35", "batch the tasks under #35", or "execute all the sub-issues of #35".
---

# Batch

Run `/execute` across the ready `size:task` children of one parent issue, as a single background [workflow](workflow.js). The orchestration — which tasks may run, in what order — is decided here, by the calling agent, and handed to the workflow as a dependency DAG.

Each task runs as a **4-stage pipeline of sibling worktree-isolated agents** — Prep → Implement → Review → Land — which hoists `/execute`'s Step-7 delegation up into the workflow (see the execute skill's "Running under /batch"). This matters: the Implement agent gets a **clean context** (just the brief, the plan's sub-sections, the branch), exactly as a solo `/execute` keeps its implementation sub-agent clean — it is never asked to juggle base-branch resolution and parent-chain walks *and* write the code. State flows Prep→Implement→Review→Land through structured returns plus origin (each stage fetches the branch); the per-task worktrees keep parallel tasks from colliding.

The **Review stage** is an independent `/code-review high` pass run by a *different* agent than the implementer (a real second pair of eyes on correctness, not just the Land agent's on-contract/AC check). It auto-fixes blocking findings with one bounded fix-and-recount pass, then **gates the auto-ship**: a predecessor whose review leaves surviving blocking findings is *not* merged.

This skill **merges code**, not just opens PRs. To unblock a dependent task, its predecessor is squash-merged into the integration branch via `/ship` (task tier) — without an individual human review, **but only when its independent code-review came back clean**. A predecessor held back by blocking findings stays an open PR (findings posted as a comment), and the scheduler then **cascade-skips its dependents** rather than stacking them on suspect code. That auto-merge is a deliberate escalation over a bare `/execute`. Independent tasks (no batched dependents) only ever get an open PR, fully reviewable as normal. The aggregate review gate stays at slice/feature promotion (`/ship size:slice`). Make this loud in the end-of-run output; never let an auto-merge be a surprise.

## Hard rules

- **One parent per invocation.** Batch the children of a single parent issue.
- **Only OPEN + `ready-for-agent` + `size:task` children enter the batch.** Everything else is reported as skipped with the reason; this skill never runs `/triage`, never decomposes, never relabels.
- **The dependency graph must be acyclic.** When unsure whether two tasks are independent, add an edge (serialize) — over-serializing wastes time; a bad parallel merge corrupts the integration branch.
- **Auto-ship only along real dependency edges.** A task is shipped iff another batched task depends on it. Independent tasks are left as open PRs.
- **One approval gate, here.** The user approves the whole plan in Step 4. Individual leaves do not stop for approval (that's what `/execute`'s inline mode disables).

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
- **Which tasks will be auto-shipped** (those with ≥1 batched dependent) and the one-line consequence: "these squash-merge into `<integration-branch>` without individual human review to unblock their dependents — *only if* their independent `/code-review` pass is clean; a task held back by blocking findings stays an open PR and its dependents are skipped."
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

The workflow runs in the background and returns a structured `{ results, summary }`. It schedules each task to fire the moment *its* dependencies finish (true DAG scheduling, not whole-wave barriers), runs each task as the Prep → Implement → Review → Land pipeline in isolated worktrees, and squash-merges any task that has a batched dependent **whose independent code-review came back clean** (one held back by blocking findings stays an open PR and its dependents cascade-skip). You do not babysit it; `/workflows` shows live progress, grouped by stage.

## Step 6: Report

Three-block output per [docs/agents/output-format.md](../../../docs/agents/output-format.md). Cover, from the workflow's `summary` plus the Step 2 skipped set:

```
Batched #<P>: <opened> PR(s) opened, <shipped> predecessor(s) squash-merged to unblock dependents, <heldForReview> held by code-review, <failed> failed/skipped.

- PRs opened (awaiting review): #<N> <url> · ...
- Squash-merged into <integration-branch> (no individual human review, code-review clean): #<N> · ...   ← only if any
- Held from auto-ship by code-review (<blockingCount> blocking finding(s), PR open for a human): #<N> <url> · ...   ← only if any
- Failed / skipped: #<N> — <blocker or "not ready: run /triage"> · ...

> Next step: review the open PRs, resolve any code-review-held tasks (then `/ship` them so their dependents can be re-batched), and `/ship` the slice once its children are closed.
```

Call out the auto-merged tasks explicitly — they landed without individual human review (their independent `/code-review` was clean), and the reviewer should know to inspect them inside the eventual slice-promotion PR. Call out held-for-review tasks too: each blocked its dependents, so resolving and shipping it is what unblocks the rest.

## What this skill does NOT do

- It does not run `/triage`, `/decompose`, or relabel anything. Non-ready children are reported, not fixed.
- It does not promote any integration branch upward. Slice/feature promotion is `/ship`'s job.
- It does not merge independent tasks. Only dependency predecessors are auto-shipped; everything else stays an open PR.
- It does not address PR review feedback, and it does not batch across more than one parent at a time.
