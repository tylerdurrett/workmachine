export const meta = {
  name: 'batch-execute',
  description:
    'DAG-schedule /execute (inline) across a parent issue\'s ready sub-tasks: one worktree-isolated agent per task, each firing the moment its dependencies finish, independently code-reviewing each task and auto-shipping dependency predecessors (only when their review is clean) so dependents can build on them.',
  phases: [
    { title: 'Prep', detail: 'per task: validate, resolve base branch, explore, plan, push empty branch' },
    { title: 'Implement', detail: 'per task: clean-context agent codes each sub-section and pushes commits' },
    { title: 'Review', detail: 'per task: independent /code-review pass; auto-fixes blocking findings, gates the ship' },
    { title: 'Land', detail: 'per task: verify ACs, open PR, and ship if a dependent needs it AND review is clean' },
  ],
}

// args (passed by the /batch skill after it has inferred the DAG):
// {
//   parentIssue: number,
//   tasks: [{ number, title, dependsOn: number[] }]   // dependsOn = hard + inferred edges, must be acyclic
// }
// Tolerate args arriving as a JSON-encoded string (some tool-call serializers stringify object args).
const a = typeof args === 'string' ? JSON.parse(args) : (args || {})
const tasks = a.tasks || []

if (!tasks.length) {
  log('No ready tasks were passed to batch-execute; nothing to run.')
  return { parentIssue: (args && args.parentIssue) || null, results: [] }
}

const byNum = new Map(tasks.map((t) => [t.number, t]))

// dependents.get(T) = the tasks in this batch that depend on T.
// A task with ≥1 dependent must be shipped (squash-merged) so dependents see its code.
const dependents = new Map(tasks.map((t) => [t.number, []]))
for (const t of tasks) {
  for (const d of t.dependsOn || []) {
    if (dependents.has(d)) dependents.get(d).push(t.number)
  }
}

// Reject cycles up front — the Promise-memoized scheduler below would otherwise deadlock.
function findCycle() {
  const WHITE = 0,
    GRAY = 1,
    BLACK = 2
  const color = new Map(tasks.map((t) => [t.number, WHITE]))
  let edge = null
  function dfs(n) {
    color.set(n, GRAY)
    for (const d of byNum.get(n).dependsOn || []) {
      if (!byNum.has(d)) continue
      const c = color.get(d)
      if (c === GRAY) {
        edge = [n, d]
        return true
      }
      if (c === WHITE && dfs(d)) return true
    }
    color.set(n, BLACK)
    return false
  }
  for (const t of tasks) if (color.get(t.number) === WHITE && dfs(t.number)) return edge
  return null
}
const cycle = findCycle()
if (cycle) {
  log(`Dependency cycle detected (#${cycle[0]} → #${cycle[1]}); aborting batch.`)
  return {
    parentIssue: (args && args.parentIssue) || null,
    error: `dependency cycle involving #${cycle[0]} and #${cycle[1]}`,
    results: [],
  }
}

// Each task is a 4-stage pipeline of sibling agents — Prep / Implement / Review / Land — relocating
// /execute's Step-7 delegation up here so the Implement stage keeps a clean context. Review is an
// independent /code-review pass (a different agent than the implementer): it auto-fixes blocking
// findings and gates the auto-ship — a predecessor with surviving blocking findings is NOT merged,
// so the scheduler cascade-skips its dependents rather than stacking on suspect code.
// State flows stage→stage via these structured returns plus origin (each stage fetches the branch).

const PREP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ready'],
  properties: {
    ready: { type: 'boolean', description: 'true iff prep succeeded and the branch is pushed' },
    baseBranch: { type: ['string', 'null'], description: 'resolved integration branch (or main)' },
    branch: { type: ['string', 'null'], description: 'the feature branch, created and pushed to origin' },
    brief: { type: ['string', 'null'], description: 'the agent brief + any contract-updating parent comments, distilled for the implementer' },
    plan: {
      type: 'array',
      description: 'ordered cohesive sub-sections, one commit each',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title'],
        properties: {
          title: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          notes: { type: ['string', 'null'] },
        },
      },
    },
    blocker: { type: ['string', 'null'], description: 'if not ready: not OPEN/ready-for-agent/size:task, size escape-hatch, or other' },
  },
}

const IMPL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['done'],
  properties: {
    done: { type: 'boolean', description: 'true iff every sub-section was implemented, committed, and pushed' },
    commits: { type: 'array', items: { type: 'string' }, description: 'one line per commit, in order' },
    deviations: { type: ['string', 'null'], description: 'any deviation from the plan' },
    blocker: { type: ['string', 'null'] },
  },
}

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reviewed', 'blockingCount', 'fixed'],
  properties: {
    reviewed: { type: 'boolean', description: 'true iff /code-review ran to completion' },
    blockingCount: { type: 'number', description: 'BLOCKING (correctness) findings remaining AFTER the fix pass' },
    fixed: { type: 'boolean', description: 'true iff fixes were committed and pushed to the branch' },
    findings: {
      type: 'array',
      description: 'the findings that still remain after the fix pass',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'summary'],
        properties: {
          severity: { type: 'string', description: 'blocking | cleanup' },
          file: { type: ['string', 'null'] },
          line: { type: ['number', 'null'] },
          summary: { type: 'string' },
        },
      },
    },
    summary: { type: ['string', 'null'], description: 'short digest for the PR body / batch report' },
    blocker: { type: ['string', 'null'], description: 'only if the review itself could not run' },
  },
}

const LAND_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'shipped'],
  properties: {
    ok: { type: 'boolean', description: 'true iff the PR was opened (and, when required, squash-merged) successfully' },
    prNumber: { type: ['number', 'null'] },
    prUrl: { type: ['string', 'null'] },
    shipped: { type: 'boolean', description: 'true iff squash-merged into the integration branch to unblock dependents' },
    blocker: { type: ['string', 'null'] },
  },
}

function prepPrompt(task) {
  const deps = (task.dependsOn || []).filter((d) => byNum.has(d))
  return [
    `You are the PREP stage of a /batch run for GitHub issue #${task.number} ("${task.title}"), in your own isolated git worktree.`,
    ``,
    `Follow the /execute skill, Steps 1–6, per its "Running under /batch" section (Prep row): validate labels, walk the parent chain to resolve the base branch, read the brief and any contract-updating parent comments, explore the codebase, and form the numbered sub-section plan. Do NOT halt for approval (skip the Step 5 halt). Create the feature branch off the resolved base (Step 6), then push it empty to origin: \`git push -u origin <branch>\`.`,
    deps.length
      ? `\nThis task depends on #${deps.join(', #')}, already squash-merged into the integration branch. Fetch the base branch fresh before branching so it includes their code.`
      : ``,
    `\nDo NOT invoke /triage and do NOT wait for a human. If the task is not OPEN + ready-for-agent + size:task, or the Step 4 size escape-hatch fires, set ready:false and return a specific blocker (do not push a branch).`,
    `\nReturn: ready, baseBranch, branch, brief (distilled for the implementer — the agent brief plus any contract updates from parent comments), plan (ordered sub-sections), blocker.`,
  ]
    .filter(Boolean)
    .join('\n')
}

function implPrompt(task, prep) {
  return [
    `You are the IMPLEMENT stage of a /batch run for GitHub issue #${task.number} ("${task.title}"), in your own isolated git worktree. You are /execute Step 7's clean implementation agent — you do NOT need the base-branch bookkeeping, only the plan below.`,
    ``,
    `Branch: \`${prep.branch}\` (already on origin, based on \`${prep.baseBranch}\`). Fetch and check it out: \`git fetch origin ${prep.branch} && git checkout ${prep.branch}\`.`,
    ``,
    `The contract / brief:`,
    prep.brief || '(see issue #' + task.number + ')',
    ``,
    `The plan — implement each sub-section, in order, as exactly one commit:`,
    ...(prep.plan || []).map((s, i) => `  ${i + 1}. ${s.title}${s.files && s.files.length ? ` [${s.files.join(', ')}]` : ''}${s.notes ? ` — ${s.notes}` : ''}`),
    ``,
    `For each sub-section: implement → \`pnpm typecheck\` → \`pnpm lint:fix\` → \`pnpm format:fix\` → run /simplify on the changes → stage and commit with \`<type>(<scope>): <sub-section title>\`. One commit per sub-section — do not bundle. Then push all commits: \`git push origin ${prep.branch}\`.`,
    `Do NOT open a PR, touch labels, or merge. If you hit a blocker, set done:false and return it.`,
    ``,
    `Return: done, commits (one line each), deviations, blocker.`,
  ].join('\n')
}

function reviewPrompt(task, prep, mustShip) {
  return [
    `You are the REVIEW stage of a /batch run for GitHub issue #${task.number} ("${task.title}"), in your own isolated git worktree. You did NOT write this code — review it independently.`,
    ``,
    `Branch \`${prep.branch}\` (based on \`${prep.baseBranch}\`) carries the implementation on origin. Fetch and check it out: \`git fetch origin ${prep.branch} && git checkout ${prep.branch}\`.`,
    ``,
    `Run \`/code-review high\` over this branch's diff against \`${prep.baseBranch}\`. Classify each finding:`,
    `  - BLOCKING — a correctness bug, logic error, or contract violation introduced by this diff.`,
    `  - cleanup — a non-blocking simplification / efficiency / style improvement.`,
    ``,
    `If there are any BLOCKING findings, fix them in place (you may use \`/code-review --fix\`, or edit by hand), then \`pnpm typecheck\` → \`pnpm lint:fix\` → \`pnpm format:fix\`, commit with \`fix(review): address code-review findings\`, and \`git push origin ${prep.branch}\`. Then re-run \`/code-review high\` ONCE more to recount. Do not loop further — report whatever blocking findings still survive that single fix pass.`,
    ``,
    `Do NOT open a PR, change labels, merge, or ship.`,
    mustShip
      ? `Other batched tasks depend on #${task.number}, so any surviving BLOCKING finding will hold it back from auto-shipping and cause its dependents to be skipped — only fixes you actually push count.`
      : `No batched task depends on #${task.number}; surviving findings will be posted on its PR for a human reviewer.`,
    ``,
    `Return: reviewed, blockingCount (BLOCKING findings remaining AFTER your fix pass), fixed (did you commit+push fixes), findings (the remaining items), summary (a short digest for the PR/report), blocker (only if /code-review could not run at all).`,
  ].join('\n')
}

function landPrompt(task, prep, { canShip, mustShip, review }) {
  const findingsNote =
    review && review.summary
      ? `\n  - Fold this Review-stage digest into the PR body under a "Review notes" heading:\n${review.summary}`
      : ``
  const lines = [
    `You are the LAND stage of a /batch run for GitHub issue #${task.number} ("${task.title}"), in your own isolated git worktree.`,
    ``,
    `Branch \`${prep.branch}\` (based on \`${prep.baseBranch}\`) carries the finished, independently code-reviewed work on origin. Fetch and check it out, then follow the /execute skill's Step 7-review, Step 8, and Step 9:`,
    `  - Review the diff against \`${prep.baseBranch}\`: one commit per sub-section (plus an optional \`fix(review):\` commit from the Review stage), on-contract, no drift. Re-run \`pnpm typecheck\` (and \`pnpm test\` if the plan calls for it).`,
    `  - Step 8: re-read the agent brief on #${task.number} and verify every acceptance criterion first-hand; this populates the PR test plan.`,
    `  - Step 9: open the PR (\`Closes #${task.number}\` only when the base is main; otherwise note the integration target).${findingsNote}`,
  ]
  if (canShip) {
    lines.push(
      `\nOther batched tasks depend on #${task.number} and code-review came back clean (no blocking findings). After the PR is open and green, you MUST run /ship for #${task.number} (task tier) to squash-merge it into \`${prep.baseBranch}\` so dependents can build on it. If /ship refuses (failing checks, unresolved review), set ok:false with that blocker and shipped:false. Set shipped:true only if the squash-merge actually landed.`,
    )
  } else if (mustShip) {
    lines.push(
      `\nOther batched tasks depend on #${task.number}, BUT code-review left ${review.blockingCount} surviving blocking finding(s), so this task is HELD from auto-ship. DO NOT ship or merge. Open the PR, then post the blocking findings as a PR comment (\`gh pr comment <pr> --body "..."\`) so a human reviewer sees them inline:\n${review.findings && review.findings.length ? JSON.stringify(review.findings) : review.summary || '(see the Review stage)'}\nSet ok:true if the PR opened, and shipped:false. The batch will skip the dependents until a human resolves and ships #${task.number}.`,
    )
  } else {
    lines.push(
      `\nNo batched task depends on #${task.number}. Open the PR and STOP — do NOT ship or merge it (landing is a separate, human-reviewed step).${review && review.findings && review.findings.length ? ` Post the remaining code-review findings as a PR comment (\`gh pr comment <pr> --body "..."\`) for the reviewer.` : ``} Set shipped:false.`,
    )
  }
  lines.push(``, `Return: ok, prNumber, prUrl, shipped, blocker.`)
  return lines.join('\n')
}

function fail(num, title, blocker, skipped = false) {
  return { number: num, title, ok: false, skipped, shipped: false, commits: [], prUrl: null, prNumber: null, blocker }
}

// Promise-memoized DAG scheduler: each task fires the instant ITS specific deps resolve
// (not when a whole "wave" finishes). The runtime's concurrency cap queues excess agents.
const memo = new Map()
function run(num) {
  if (memo.has(num)) return memo.get(num)
  const task = byNum.get(num)
  const p = (async () => {
    const deps = (task.dependsOn || []).filter((d) => byNum.has(d))
    const depResults = await Promise.all(deps.map(run))

    const failed = depResults.find((r) => !r || !r.ok)
    if (failed) {
      log(`#${num} skipped — dependency #${failed.number} did not complete.`)
      return fail(num, task.title, `Dependency #${failed.number} failed or was skipped; not safe to build on it.`, true)
    }
    const idx = depResults.findIndex((r) => !r.shipped)
    if (idx !== -1) {
      return fail(num, task.title, `Dependency #${deps[idx]} reported ok but was not shipped into the integration branch; cannot build on it.`, true)
    }

    const mustShip = (dependents.get(num) || []).length > 0

    // Stage 1 — Prep (heavy: bookkeeping + plan; pushes the empty branch).
    const prep = await agent(prepPrompt(task), { label: `prep#${num}`, phase: 'Prep', isolation: 'worktree', schema: PREP_SCHEMA })
    if (!prep) return fail(num, task.title, 'Prep agent died or was skipped.')
    if (!prep.ready) return fail(num, task.title, prep.blocker || 'Prep reported not ready.')

    // Stage 2 — Implement (CLEAN: only the plan + brief + branch).
    const impl = await agent(implPrompt(task, prep), { label: `impl#${num}`, phase: 'Implement', isolation: 'worktree', schema: IMPL_SCHEMA })
    if (!impl) return fail(num, task.title, 'Implement agent died or was skipped.')
    if (!impl.done) return fail(num, task.title, impl.blocker || 'Implement did not finish the plan.')

    // Stage 3 — Review (independent /code-review; auto-fixes blocking findings, then GATES the ship).
    const review = await agent(reviewPrompt(task, prep, mustShip), { label: `review#${num}`, phase: 'Review', isolation: 'worktree', schema: REVIEW_SCHEMA })
    if (!review) return fail(num, task.title, 'Review agent died or was skipped.')
    if (!review.reviewed) return fail(num, task.title, review.blocker || 'Review stage did not complete.')
    const reviewClean = review.blockingCount === 0
    // A predecessor a dependent needs must be CLEAN to auto-ship. Surviving blocking findings → no
    // merge; the scheduler then cascade-skips its dependents (can't build on un-shipped, suspect code).
    const canShip = mustShip && reviewClean
    const reviewBlocked = mustShip && !reviewClean

    // Stage 4 — Land (verify ACs, open PR, post findings, ship iff canShip).
    const land = await agent(landPrompt(task, prep, { canShip, mustShip, review }), { label: `land#${num}`, phase: 'Land', isolation: 'worktree', schema: LAND_SCHEMA })
    if (!land) return fail(num, task.title, 'Land agent died or was skipped.')

    return {
      number: num,
      title: task.title,
      ok: land.ok,
      skipped: false,
      shipped: land.shipped,
      reviewBlocked,
      blockingCount: review.blockingCount ?? 0,
      reviewSummary: review.summary ?? null,
      commits: impl.commits || [],
      prNumber: land.prNumber ?? null,
      prUrl: land.prUrl ?? null,
      branch: prep.branch ?? null,
      blocker: land.ok
        ? reviewBlocked
          ? `Held from auto-ship: ${review.blockingCount} blocking code-review finding(s); PR open for human review.`
          : null
        : land.blocker,
    }
  })()
  memo.set(num, p)
  return p
}

const results = await Promise.all(tasks.map((t) => run(t.number)))

const opened = results.filter((r) => r.ok && !r.shipped && !r.reviewBlocked).map((r) => r.number)
const shipped = results.filter((r) => r.shipped).map((r) => r.number)
const heldForReview = results.filter((r) => r.reviewBlocked)
const failed = results.filter((r) => !r.ok)

log(
  `Done: ${opened.length} PR(s) opened for review, ${shipped.length} predecessor(s) squash-merged to unblock dependents, ${heldForReview.length} held from auto-ship by code-review, ${failed.length} failed/skipped.`,
)

return {
  parentIssue: (args && args.parentIssue) || null,
  results,
  summary: {
    opened,
    shipped,
    heldForReview: heldForReview.map((r) => ({
      number: r.number,
      prNumber: r.prNumber,
      blockingCount: r.blockingCount,
      reviewSummary: r.reviewSummary,
    })),
    failed: failed.map((f) => ({ number: f.number, blocker: f.blocker })),
  },
}
