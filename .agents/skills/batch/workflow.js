export const meta = {
  name: 'batch-execute',
  description:
    "DAG-schedule /execute (inline) across a parent slice's ready sub-tasks: one worktree-isolated agent per task, each firing the moment its dependencies finish, independently code-reviewing each task and squash-merging every code-review-clean task into the slice branch — then, once all tasks land clean, opening one slice promotion PR for review.",
  phases: [
    { title: 'Prep', detail: 'per task: validate, resolve base branch, explore, plan, push empty branch' },
    { title: 'Implement', detail: 'per task: clean-context agent codes each sub-section and pushes commits' },
    { title: 'Review', detail: 'per task: independent /code-review pass; auto-fixes blocking findings, gates the ship' },
    { title: 'Land', detail: 'per task: verify ACs, open PR, and squash-merge into the slice branch when review is clean' },
    { title: 'Settle', detail: 'reconcile lifecycle state, auto-defer non-blocking findings, open the slice promotion PR, recolor DAG, prune this run\'s worktrees, leave HEAD on the slice branch' },
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
const parentIssue = a.parentIssue || null

if (!tasks.length) {
  log('No ready tasks were passed to batch-execute; nothing to run.')
  return { parentIssue: (args && args.parentIssue) || null, results: [] }
}

const byNum = new Map(tasks.map((t) => [t.number, t]))

// dependents.get(T) = the tasks in this batch that depend on T.
// Every code-review-clean task is squash-merged into the slice branch (not just predecessors).
// Dependents still matter for the CASCADE-SKIP: if T is held back by blocking findings, its
// dependents can't build on it and are skipped — and the messaging tells the reviewer so.
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
// findings and gates the auto-ship — a task with surviving blocking findings is NOT merged into the
// slice branch (it stays an open PR for a human), and if any dependent needed it, the scheduler
// cascade-skips that dependent rather than stacking on suspect code. Every clean task IS merged.
// State flows stage→stage via these structured returns, plus the task's shared worktree and origin
// (Prep hands off by pushing the branch; later stages find the shared tree already at the tip).

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
    trivial: {
      type: ['boolean', 'null'],
      description:
        'true ONLY iff the whole task is one sub-section touching ≤2 files with an expected diff ≲30 lines, no new dependencies, and no test-suite additions — eligible for the express (single-agent) path. When in doubt, false.',
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
    landedSha: { type: ['string', 'null'], description: 'origin SHA of the feature branch AFTER your final push (git ls-remote origin <branch>) — proves the commit landed' },
    baseSha: { type: ['string', 'null'], description: 'origin SHA of the base branch (git ls-remote origin <baseBranch>) — must differ from landedSha or nothing landed' },
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
    shipped: { type: 'boolean', description: 'true iff squash-merged into the slice integration branch' },
    blocker: { type: ['string', 'null'] },
  },
}

// Worktree branch protocol — the root-cause fix for the cross-worktree branch collision, carried
// over unchanged in spirit to the shared-task-worktree model. Stages of ONE task now share a single
// worktree (created detached at origin/<branch> by the first implementing stage) and hand off
// through it plus origin; parallel TASKS each get their own worktree. But git still allows a branch
// to be checked out BY NAME in only one worktree at a time, and the MAIN checkout plus every other
// task's worktree are all live — a named checkout anywhere strands someone ("fatal: '<branch>' is
// already used by worktree ..."). So the rule stands: NO stage ever holds the branch by name. Every
// stage works in DETACHED HEAD (HEAD pointing straight at the commit, not via the branch ref) and
// publishes with an explicit refspec. Detached HEADs never collide, the one-branch-per-worktree
// rule can never fire, and ship/TASK.md's "local branch doesn't exist → skip" step stays trivially
// true. A stage arriving mid-task simply finds the shared tree already at the branch tip.
const WORKTREE_PROTOCOL = (branch) =>
  `WORKTREE BRANCH PROTOCOL (critical — do not deviate): NEVER run \`git checkout ${branch}\` / \`git switch ${branch}\` — a named checkout locks the branch, and the main checkout plus every parallel task's worktree must stay able to read it (git forbids the same branch in two worktrees). Your task worktree is created DETACHED at \`origin/${branch}\` and stays that way: always work in DETACHED HEAD (HEAD pointing straight at the commit, not via the branch ref), and publish commits with \`git push origin HEAD:${branch}\`. Arriving mid-task, the tree is already at the branch tip; if you ever need to re-sync it, \`git fetch origin ${branch} && git checkout --detach origin/${branch}\` — never a named checkout.`

// One SHARED worktree per TASK. Stages within a task are strictly serial, so isolation is only
// needed BETWEEN tasks — yet the old stage-per-worktree model paid a fresh `pnpm install` + binary
// discovery + branch re-fetch for every stage of every task. The Workflow runtime has no
// worktree-reuse option (`isolation: 'worktree'` is strictly per-agent-call), so the task worktree
// is hand-rolled: Implement/Express/Review/Land spawn in the MAIN checkout (no runtime isolation)
// and their FIRST action is creating/entering `.claude/worktrees/task-<num>`. Living under
// `.claude/worktrees/` means Settle's baseline-scoped reconcile prunes it with zero extra logic —
// no stage removes its own worktree. The crash-leftover removal below is the ONE sanctioned
// worktree removal outside Settle: it targets exactly this task's own path, which is safe because
// the tracker prevents the same task legitimately running in two live batches (and a live duplicate
// batch of the same slice is already declared unsafe). Creation detaches at `origin/<branch>`, not
// FETCH_HEAD: parallel tasks fetch concurrently in the shared main checkout, and FETCH_HEAD races
// between them while the remote-tracking ref does not. Prep is the exception to all of this — it
// stays runtime-isolated (read/plan/push-refs-only, safe in a throwaway).
const TASK_WORKTREE = (num, branch) =>
  [
    `TASK WORKTREE (do this FIRST, before anything else): you spawn in the repo's MAIN checkout — do not edit, build, or run anything here. Your task's shared worktree is \`WT="$(git rev-parse --show-toplevel)/.claude/worktrees/task-${num}"\`.`,
    `- If it already exists AND you are the first implementing stage or the Implement retry: it is a leftover from a crashed run of this same task — or, if you are the Implement retry, attempt 1's stranded tree — remove it (\`git worktree remove --force "$WT" || rm -rf "$WT"; git worktree prune\`) and recreate. If you are Review or Land, just reuse it (it already holds the branch tip and node_modules).`,
    `- Create (Implement/Express — or Review/Land when it's missing): \`git fetch origin ${branch} && git worktree add --detach "$WT" origin/${branch}\`. Use \`origin/${branch}\` — NEVER \`FETCH_HEAD\` (parallel tasks fetch concurrently in the main checkout; FETCH_HEAD races between them, the remote-tracking ref does not).`,
    `- Then enter it and work there. Shell cwd AND variables reset between invocations — a bare \`cd "$WT"\` in a fresh shell sees $WT unset, and \`cd ""\` silently no-ops, leaving you in the MAIN checkout. So begin EVERY subsequent shell invocation by FIRST re-deriving the path, then entering it: \`WT="$(git rev-parse --git-common-dir)/../.claude/worktrees/task-${num}" && cd "$WT"\` (the git-common-dir form resolves correctly from both the main checkout and inside the task worktree).`,
  ].join('\n')

// Supply-chain lockdown is intentional on this machine (docs/agents/locked-down-npm.md). A stage must
// NEVER weaken it to get unblocked — that turns a one-task hiccup into a machine-wide security hole.
// Kept tight: this block is re-ingested by every stage of every task, so it carries only the
// operative facts (rationale lives in docs/agents/locked-down-npm.md).
const TOOLING_NOTE =
  `TOOLING (locked-down npm — do not circumvent; see docs/agents/locked-down-npm.md): if your task worktree lacks \`node_modules\` AND you actually need to typecheck or test (doc-only work doesn't), run \`pnpm install\` once — expect it to EXIT 1 with \`ERR_PNPM_IGNORED_BUILDS\`; that is deliberate and benign (deps install fine; the toolchain runs on prebuilt binaries). Later stages of this task reuse the same worktree, so it's usually already there. Then use the package-local binaries — \`./node_modules/.bin/tsc --noEmit\` to typecheck, \`./node_modules/.bin/vitest run\` to test — never \`pnpm run <script>\` (its pre-flight rejects the ignored-builds state), and never hunt for tooling the repo doesn't define (no prettier config = no prettier gate; check before assuming). NEVER weaken the lockdown: no \`dangerouslyAllowAllBuilds\`, no \`min-release-age\` change, no \`~/.npmrc\` / global pnpm edits; if a package truly needs its build script, set your blocker and stop — a human allows it per-repo (pnpm-workspace.yaml). Shell note: this machine's shell is zsh — never read an exit code through a pipe (\`\${PIPESTATUS[0]}\` is bash-only and expands EMPTY here, so a silently failing test reads as success); run the command bare and check \`$?\` directly.`

// The parent-chain walk trips agents up the same way every run; state the one correct mechanism.
const PARENT_CHAIN_NOTE = `parent links live in \`**Part of:** #<P>\` lines in issue BODIES, read via \`gh issue view <N> --json body\` — there is no \`--json parent\` field, don't try it`

// Where the batch-facing skill subsets live. Resolved via the git COMMON dir so it works from any
// linked worktree regardless of which (possibly older) branch that worktree has checked out.
const EXECUTE_BATCH_DOC = `"$(git rev-parse --git-common-dir)/../.agents/skills/execute/BATCH.md"`
const SHIP_TASK_DOC = `"$(git rev-parse --git-common-dir)/../.agents/skills/ship/TASK.md"`

// A sibling that squash-merged into the base after this task's branch was cut makes the branch
// stale — the single biggest observed source of wasted land-stage work (parallel agents each
// re-deriving the same merge-base archaeology, or worse, rebasing). Tell the stage exactly what
// happened and how to integrate.
function stalenessNote(baseBranch, landedSince, { forReview } = {}) {
  if (!landedSince.length) return ''
  const who = landedSince.map((s) => `#${s.number} ("${s.title}"${s.files && s.files.length ? ` — ${s.files.join(', ')}` : ''})`).join(', ')
  return forReview
    ? `\nBASE ADVANCED: sibling task(s) ${who} squash-merged into \`${baseBranch}\` AFTER this branch was cut. Diff against the MERGE BASE (\`git merge-base\` / three-dot \`git diff origin/${baseBranch}...HEAD\`), never two-dot against the base tip — otherwise the siblings' code pollutes the diff and reads as spurious reverts.\n`
    : `\nBASE ADVANCED: sibling task(s) ${who} squash-merged into \`${baseBranch}\` AFTER this branch was cut, so expect the branch to be stale there — this is normal, not an anomaly to investigate. Integrate by MERGE ONLY: \`git fetch origin ${baseBranch} && git merge FETCH_HEAD\` (you are detached; commit the merge and push via refspec). NEVER rebase (this PR is squash-merged, so merge commits vanish anyway — and a rebase forces a force-push, which is blocked) and NEVER force-push. If conflicts touch the files listed above, resolve by combining both sides' intent, then re-run typecheck once.\n`
}

function prepPrompt(task) {
  const deps = (task.dependsOn || []).filter((d) => byNum.has(d))
  return [
    `You are the PREP stage of a /batch run for GitHub issue #${task.number} ("${task.title}"), in your own isolated git worktree.`,
    ``,
    TOOLING_NOTE,
    ``,
    `Do NOT run \`pnpm install\` — Prep never builds or tests. (Your throwaway worktree is auto-removed by the runtime only when clean; installing node_modules wastes a minute and can leave it dirty.)`,
    ``,
    `Read ${EXECUTE_BATCH_DOC} and follow its "Prep" section (the /batch-facing subset of /execute Steps 1–6 — do NOT load the full /execute skill): validate labels, walk the parent chain to resolve the base branch (${PARENT_CHAIN_NOTE}) — and if that integration branch (or any ancestor up to main) does not yet exist on origin, seed the whole missing chain per that doc rather than forking the base off main (forking off main flattens the hierarchy and corrupts the later slice/feature promotion diff) — read the brief and any contract-updating parent comments, explore the codebase, and form the numbered sub-section plan. Do NOT halt for approval.`,
    `\nCreate the feature branch (Step 6), but do NOT let your worktree hold it by name — the later stages' shared task worktree works detached at \`origin/<branch>\`, and no worktree in this pipeline ever holds a task branch by name (git forbids the same branch being checked out twice). So instead of \`git checkout -b <branch>\`, resolve the base, detach onto it (\`git fetch origin <resolved-base> && git checkout --detach FETCH_HEAD\`), and create the branch ON ORIGIN ONLY with \`git push origin HEAD:refs/heads/<branch>\`. Do NOT create a local branch ref of any kind.`,
    deps.length
      ? `\nThis task depends on #${deps.join(', #')}, already squash-merged into the integration branch. Fetch the base branch fresh before branching so it includes their code.`
      : ``,
    `\nDo NOT invoke /triage and do NOT wait for a human. If the task is not OPEN + ready-for-agent + size:task, or the Step 4 size escape-hatch fires, set ready:false and return a specific blocker (do not push a branch).`,
    parentIssue
      ? `\nLIVE DAG (amber-on-start): once the branch is pushed and you are about to return ready:true — and ONLY then (a not-ready task keeps its labels untouched) — mark the task active so the parent's Sub-issue DAG lights its node amber. Run \`gh issue edit ${task.number} --remove-label ready-for-agent --add-label in-progress\` (active work has genuinely begun), then recolor the parent: \`node "$(git rev-parse --show-toplevel)/.agents/skills/dag/recolor.mjs" ${parentIssue}\`. Both are best-effort: if either errors (e.g. the parent has no DAG section — the recolor is a clean no-op then), log it and still return ready:true. Never let this block prep.`
      : ``,
    `\nReturn: ready, baseBranch, branch, brief (distilled for the implementer — the agent brief plus any contract updates from parent comments; downstream stages get ONLY this, so make it self-sufficient: include the acceptance criteria), plan (ordered sub-sections; list the files each touches — the scheduler uses them to serialize overlapping siblings), trivial (per the schema — single sub-section, ≤2 files, ≲30-line diff, no new deps/tests), blocker.`,
  ]
    .filter(Boolean)
    .join('\n')
}

function implPrompt(task, prep, attempt = 1) {
  return [
    `You are the IMPLEMENT stage of a /batch run for GitHub issue #${task.number} ("${task.title}"). You are /execute Step 7's clean implementation agent — you do NOT need the base-branch bookkeeping, only the plan below.`,
    ``,
    TASK_WORKTREE(task.number, prep.branch),
    attempt > 1
      ? `\nRETRY: your previous attempt returned done but the branch never advanced past base on origin — the commit did NOT land. You are the Implement retry: remove and recreate the task worktree per the block above (a fresh tree is the point — attempt 1 may have stranded uncommitted work in it). The usual cause: a brand-new file is UNTRACKED, so \`git diff HEAD\` shows nothing — that is NOT "nothing to do". You MUST \`git add -A\`, commit, then \`git push\`, and confirm the push landed before returning done.\n`
      : ``,
    `Branch: \`${prep.branch}\` (already on origin, based on \`${prep.baseBranch}\`). ${WORKTREE_PROTOCOL(prep.branch)}`,
    ``,
    TOOLING_NOTE,
    ``,
    `The contract / brief:`,
    prep.brief || '(see issue #' + task.number + ')',
    ``,
    `The plan — implement each sub-section, in order, as exactly one commit:`,
    ...(prep.plan || []).map((s, i) => `  ${i + 1}. ${s.title}${s.files && s.files.length ? ` [${s.files.join(', ')}]` : ''}${s.notes ? ` — ${s.notes}` : ''}`),
    ``,
    `For each sub-section: implement → typecheck (per TOOLING) → run the repo's lint/format scripts *only if it defines them* (skip silently if absent — don't hunt for tooling that isn't there) → \`git add -A\` and commit with \`<type>(<scope>): <sub-section title>\`. One commit per sub-section — do not bundle. Then push via refspec (you are in detached HEAD): \`git push origin HEAD:${prep.branch}\`. Do NOT run /simplify — the independent Review stage covers cleanup altitude; duplicate passes were measured pure waste.`,
    `Do NOT open a PR, touch labels, or merge. If you hit a real blocker, set done:false and return it.`,
    ``,
    `LANDING PROOF (required — skip it and your work is silently lost when the retry wipes the tree or Settle prunes it): after your final push, prove the commit reached origin. Run \`git ls-remote origin ${prep.branch}\` for the landed SHA and \`git ls-remote origin ${prep.baseBranch}\` for the base SHA; they MUST differ. Report them as landedSha and baseSha.`,
    ``,
    `Return: done, commits (one line each), landedSha, baseSha, deviations, blocker.`,
  ].join('\n')
}

function reviewPrompt(task, prep, hasDependents, landedSince) {
  return [
    `You are the REVIEW stage of a /batch run for GitHub issue #${task.number} ("${task.title}"). You did NOT write this code — review it independently.`,
    ``,
    TASK_WORKTREE(task.number, prep.branch),
    ``,
    `You are Review, so REUSE the worktree (Implement left it at the branch tip with node_modules in place); recreate it per the block above only if it is missing. Before reviewing, sanity-check it: \`git status --porcelain\` should be clean-ish, and after \`git fetch origin ${prep.branch}\`, \`git log -1 HEAD\` should match \`origin/${prep.branch}\` — if the tree drifted, re-sync with \`git checkout --detach origin/${prep.branch}\`.`,
    ``,
    `Branch \`${prep.branch}\` (based on \`${prep.baseBranch}\`) carries the implementation on origin. ${WORKTREE_PROTOCOL(prep.branch)}`,
    ``,
    TOOLING_NOTE,
    stalenessNote(prep.baseBranch, landedSince, { forReview: true }),
    `The contract / brief this diff must satisfy (from Prep — no need to re-fetch the issue):`,
    prep.brief || '(see issue #' + task.number + ')',
    ``,
    `Run \`/code-review high\` over this branch's diff against \`${prep.baseBranch}\`. Classify each finding:`,
    `  - BLOCKING — a correctness bug, logic error, or contract violation introduced by this diff.`,
    `  - cleanup — a non-blocking simplification / efficiency / style improvement.`,
    ``,
    `If there are any BLOCKING findings, fix them in place (you may use \`/code-review --fix\`, or edit by hand), then typecheck (per TOOLING; lint/format only if the repo defines them), commit with \`fix(review): address code-review findings\`, and push via refspec (you are in detached HEAD): \`git push origin HEAD:${prep.branch}\`. Then re-run \`/code-review high\` ONCE more to recount. Do not loop further — report whatever blocking findings still survive that single fix pass. If there are NO blocking findings, do not re-run the implementer's verification (typecheck/tests) — reading the diff is your job; re-proving a green baseline is not.`,
    ``,
    `Do NOT open a PR, change labels, merge, or ship.`,
    `Every code-review-clean task is squash-merged into the slice branch, so any surviving BLOCKING finding holds #${task.number} back from that merge — it stays an OPEN PR for a human to resolve, and the slice promotion PR won't open until it does. Only fixes you actually push count.${hasDependents ? ` Other batched tasks depend on #${task.number}, so holding it will also cause those dependents to be skipped.` : ``}`,
    ``,
    `Return: reviewed, blockingCount (BLOCKING findings remaining AFTER your fix pass), fixed (did you commit+push fixes), findings (the remaining items), summary (a short digest for the PR/report), blocker (only if /code-review could not run at all).`,
  ].join('\n')
}

function landPrompt(task, prep, { shipEligible, hasDependents, review, landedSince }) {
  const findingsNote =
    review && review.summary
      ? `\n  - Fold this Review-stage digest into the PR body under a "Review notes" heading:\n${review.summary}`
      : ``
  const lines = [
    `You are the LAND stage of a /batch run for GitHub issue #${task.number} ("${task.title}").`,
    ``,
    TASK_WORKTREE(task.number, prep.branch),
    ``,
    `You are Land, so REUSE the worktree (it already holds the branch tip and node_modules); recreate it per the block above only if it is missing. Sanity-check it first: \`git status --porcelain\` should be clean-ish, and after \`git fetch origin ${prep.branch}\`, \`git log -1 HEAD\` should match \`origin/${prep.branch}\` — if the tree drifted, re-sync with \`git checkout --detach origin/${prep.branch}\`.`,
    ``,
    `Branch \`${prep.branch}\` (based on \`${prep.baseBranch}\`) carries the finished, independently code-reviewed work on origin. ${WORKTREE_PROTOCOL(prep.branch)}`,
    ``,
    TOOLING_NOTE,
    stalenessNote(prep.baseBranch, landedSince || []),
    `The brief / acceptance criteria (from Prep — do NOT re-fetch issue #${task.number} unless this looks incomplete):`,
    prep.brief || '(brief missing — read issue #' + task.number + ')',
    ``,
    `Your job (the Review stage already ran an independent \`/code-review high\` on this diff and Implement typechecked every commit — do NOT re-review the code and do NOT re-run the full test suite; that duplication was measured pure waste):`,
    `  - Sanity-check the branch: it is on origin and its commits map to the plan's sub-sections. If the BASE-ADVANCED note above applies (or a push is rejected as non-fast-forward), integrate by merge as instructed there, then typecheck once.`,
    `  - Verify each acceptance criterion in the brief first-hand (behavioral check, not code re-read).`,
    `  - Open the PR (\`Closes #${task.number}\` only when the base is main; otherwise say it targets \`${prep.baseBranch}\`). Keep the body SHORT — one-paragraph summary + an AC checklist with pass/fail. This PR was produced under a user-authorized \`/batch\` run — its Step-4 plan-approval gate is the standing authorization to merge each code-review-clean task into the staging slice branch — and its diff already passed an independent \`/code-review high\` by a separate agent. It squash-merges into that staging branch shortly; the aggregate two-party human review happens downstream at the slice promotion PR (which is opened for review and never auto-merged), so do not craft an elaborate test-plan narrative here.${findingsNote}`,
  ]
  if (shipEligible) {
    lines.push(
      `\nThe independent \`/code-review high\` came back clean (no blocking findings), and this user-authorized \`/batch\` run's Step-4 plan-approval gate authorizes the merge, so #${task.number} lands in the staging slice branch — where the slice promotion PR, not the individual task, is the human review surface. After the PR is open and green, squash-merge it by following the task-tier ship flow in ${SHIP_TASK_DOC} (do NOT load the full /ship skill — that doc is the task-tier subset). If the ship flow refuses (failing checks, unresolved review), set ok:false with that blocker and shipped:false. Set shipped:true only if the squash-merge actually landed.${hasDependents ? ` Other batched tasks depend on #${task.number} and build on this merge.` : ``}`,
    )
  } else {
    lines.push(
      `\nCode-review left ${review.blockingCount} surviving blocking finding(s), so #${task.number} is HELD from the slice merge. DO NOT ship or merge. Open the PR, then post the blocking findings as a PR comment (\`gh pr comment <pr> --body "..."\`) so a human reviewer sees them inline:\n${review.findings && review.findings.length ? JSON.stringify(review.findings) : review.summary || '(see the Review stage)'}\nSet ok:true if the PR opened, and shipped:false. The slice promotion PR will not open until a human resolves and ships #${task.number}.${hasDependents ? ` The batch will also skip the dependents until then.` : ``}`,
    )
  }
  lines.push(``, `Return: ok, prNumber, prUrl, shipped, blocker.`)
  return lines.join('\n')
}

// Express path for tasks Prep judged trivial (one sub-section, ≤2 files, ≲30-line diff): one agent
// implements, self-reviews, and lands. Transcript analysis showed the full 4-stage pipeline spending
// ~87% of its cost on scaffolding around such diffs (fresh-worktree bring-up ×3, a high-effort review
// of a whitespace change, a land agent re-reviewing it again). The slice promotion PR remains the
// human review gate, so the lost "independent second pair of eyes" is backstopped for nit-sized work.
const EXPRESS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'shipped'],
  properties: {
    ok: { type: 'boolean', description: 'true iff implemented, committed, pushed, and the PR was opened' },
    shipped: { type: 'boolean', description: 'true iff squash-merged into the slice integration branch' },
    commits: { type: 'array', items: { type: 'string' } },
    landedSha: { type: ['string', 'null'], description: 'origin SHA of the branch after the final push (git ls-remote)' },
    baseSha: { type: ['string', 'null'], description: 'origin SHA of the base branch — must differ from landedSha' },
    blockingCount: { type: ['number', 'null'], description: 'blocking findings surviving the self-review fix pass (0 when clean)' },
    findings: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['severity', 'summary'], properties: { severity: { type: 'string' }, file: { type: ['string', 'null'] }, line: { type: ['number', 'null'] }, summary: { type: 'string' } } } },
    reviewSummary: { type: ['string', 'null'] },
    prNumber: { type: ['number', 'null'] },
    prUrl: { type: ['string', 'null'] },
    blocker: { type: ['string', 'null'] },
  },
}

function expressPrompt(task, prep, hasDependents, landedSince) {
  return [
    `You are the EXPRESS stage of a /batch run for GitHub issue #${task.number} ("${task.title}"). Prep judged this task TRIVIAL (one sub-section, ≤2 files, small diff), so you run the whole implement→review→land pipeline as one agent. If it turns out NOT to be trivial (the diff balloons, new deps needed), stop and return ok:false with blocker "not trivial — route through the full pipeline".`,
    ``,
    TASK_WORKTREE(task.number, prep.branch),
    ``,
    `Branch: \`${prep.branch}\` (already on origin, based on \`${prep.baseBranch}\`). ${WORKTREE_PROTOCOL(prep.branch)}`,
    ``,
    TOOLING_NOTE,
    stalenessNote(prep.baseBranch, landedSince),
    `The contract / brief:`,
    prep.brief || '(see issue #' + task.number + ')',
    ``,
    `The plan:`,
    ...(prep.plan || []).map((s, i) => `  ${i + 1}. ${s.title}${s.files && s.files.length ? ` [${s.files.join(', ')}]` : ''}${s.notes ? ` — ${s.notes}` : ''}`),
    ``,
    `Do, in order:`,
    `  1. IMPLEMENT: one commit (\`<type>(<scope>): <title>\`), typecheck (per TOOLING), push via refspec (\`git push origin HEAD:${prep.branch}\`). LANDING PROOF: \`git ls-remote origin ${prep.branch}\` and \`git ls-remote origin ${prep.baseBranch}\` — landedSha must differ from baseSha, report both.`,
    `  2. SELF-REVIEW: run \`/code-review medium\` on the diff against \`${prep.baseBranch}\`. Fix any BLOCKING finding, push, recount ONCE. Report blockingCount + surviving findings (cleanup ones too — they feed the slice's deferred-findings sweep).`,
    `  3. LAND: open the PR (\`Closes #${task.number}\` only when the base is main; otherwise note it targets \`${prep.baseBranch}\`) with a 2-3 line body. This PR is produced under a user-authorized \`/batch\` run whose Step-4 plan-approval gate authorizes merging each self-reviewed task into the staging slice branch; the two-party human review happens downstream at the slice promotion PR, so keep the body short. Then:`,
    `     - blockingCount 0 → squash-merge via the task-tier ship flow in ${SHIP_TASK_DOC} (do NOT load the full /ship skill); shipped:true only if the merge landed.${hasDependents ? ` Other batched tasks depend on this merge.` : ``}`,
    `     - blockingCount > 0 → do NOT merge; post the findings as a PR comment, shipped:false.`,
    `     - If the squash-merge is blocked or conflicting because the base advanced MID-RUN (a sibling merged into \`${prep.baseBranch}\` while you worked — possible even without a BASE ADVANCED note above, which only sees merges before you spawned), integrate by MERGE ONLY: \`git fetch origin ${prep.baseBranch} && git merge FETCH_HEAD\`, commit, push via refspec, and re-run the step-2 recount ONCE if the merge touched your files. NEVER rebase, NEVER force-push.`,
    ``,
    `Return: ok, shipped, commits, landedSha, baseSha, blockingCount, findings, reviewSummary, prNumber, prUrl, blocker.`,
  ].join('\n')
}

function fail(num, title, blocker, skipped = false) {
  return { number: num, title, ok: false, skipped, shipped: false, commits: [], prUrl: null, prNumber: null, blocker }
}

// Cross-task coordination state, maintained by the scheduler:
// - landedSiblings: tasks already squash-merged into the base, with the files their plan declared.
//   Snapshotted per task at prep time; anything that lands AFTER that snapshot is handed to the
//   Review/Land prompts as staleness context (they'd otherwise re-derive it via merge archaeology).
// - fileClaims: the most recent prep to declare a file holds its claim; a later prep declaring the
//   same file waits for the holder's whole pipeline before implementing, then TAKES OVER the claim
//   — so overlapping tasks form a chain (C waits on B, whose own pipeline waited on A), not a
//   fan-in on the first claimer. Over-serializing beats two agents resolving the same conflict.
//   Waits follow CLAIM order, not task numbers (observed live: #179's prep finished before #178's,
//   and the old lower-number-only test let both edit the same file in parallel). Deadlock-freedom
//   argument, by claim-time ordering: the scheduler is single-threaded and claims are installed
//   synchronously when a prep's continuation runs, so a wait edge always points at a task whose
//   prep continuation ran strictly earlier; a task's own `done` promise resolves only after its
//   waits; wait edges therefore strictly decrease in prep-completion time — the wait graph is
//   acyclic, so no deadlock.
const landedSiblings = [] // { number, title, files }
const fileClaims = new Map() // file -> { num, done: Promise }
const planFilesOf = (prep) => [...new Set((prep.plan || []).flatMap((s) => s.files || []))]

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

    const hasDependents = (dependents.get(num) || []).length > 0

    // Staleness baseline: snapshot BEFORE prep cuts the branch. A sibling in the snapshot is
    // definitely in our base; one that lands later may not be. Overstating staleness is harmless
    // (the instructed merge is just "already up to date"); understating hides a real conflict.
    const landedAtStart = new Set(landedSiblings.map((s) => s.number))
    const landedSince = () => landedSiblings.filter((s) => !landedAtStart.has(s.number) && s.number !== num)

    // Stage 1 — Prep (heavy: bookkeeping + plan; pushes the empty branch).
    const prep = await agent(prepPrompt(task), { label: `prep#${num}`, phase: 'Prep', isolation: 'worktree', schema: PREP_SCHEMA })
    if (!prep) return fail(num, task.title, 'Prep agent died or was skipped.')
    if (!prep.ready) return fail(num, task.title, prep.blocker || 'Prep reported not ready.')

    // Overlap guard: wait for whichever sibling currently claims one of our planned files —
    // regardless of task number; claim order is what's deadlock-safe (see fileClaims above) —
    // before implementing on top of a base it is about to change. ALWAYS take over the claim,
    // waiting or not, so the next overlapping task serializes behind THIS one's whole pipeline.
    const myDone = memo.get(num)
    const overlapping = new Map()
    for (const f of planFilesOf(prep)) {
      const holder = fileClaims.get(f)
      if (holder && holder.num !== num) overlapping.set(holder.num, holder)
      fileClaims.set(f, { num, done: myDone })
    }
    if (overlapping.size) {
      log(`#${num} waits for #${[...overlapping.keys()].join(', #')} — overlapping planned files; serializing to avoid a conflicting parallel merge.`)
      await Promise.all([...overlapping.values()].map((h) => h.done.catch(() => {})))
    }

    // Express path — Prep judged the task trivial: one agent implements, self-reviews, lands.
    // landedSince() is computed at spawn time: the express agent spawns AFTER the overlap wait,
    // so a just-finished overlapping sibling is captured in its staleness note.
    if (prep.trivial) {
      const x = await agent(expressPrompt(task, prep, hasDependents, landedSince()), { label: `express#${num}`, phase: 'Implement', schema: EXPRESS_SCHEMA })
      if (!x) return fail(num, task.title, 'Express agent died or was skipped.')
      if (x.ok && !(x.landedSha && x.baseSha && x.landedSha !== x.baseSha)) {
        return fail(num, task.title, `Express reported ok but its branch never advanced past \`${prep.baseBranch}\` — no commit landed.`)
      }
      const xBlocked = (x.blockingCount ?? 0) > 0
      if (x.shipped) landedSiblings.push({ number: num, title: task.title, files: planFilesOf(prep) })
      return {
        number: num,
        title: task.title,
        ok: x.ok,
        skipped: false,
        shipped: x.shipped,
        reviewBlocked: xBlocked,
        blockingCount: x.blockingCount ?? 0,
        reviewSummary: x.reviewSummary ?? null,
        reviewFindings: x.findings || [],
        commits: x.commits || [],
        prNumber: x.prNumber ?? null,
        prUrl: x.prUrl ?? null,
        branch: prep.branch ?? null,
        express: true,
        blocker: x.ok ? (xBlocked ? `Held from auto-ship: ${x.blockingCount} blocking self-review finding(s); PR open for human review.` : null) : x.blocker,
      }
    }

    // Stage 2 — Implement (CLEAN: only the plan + brief + branch). We do NOT trust impl.done alone: a
    // faulty agent can write code, skip `git add/commit/push`, misread an empty `git diff HEAD`
    // (untracked files don't show) as "nothing to do", and still return done:true — stranding the
    // branch at base and silently losing the work when the worktree is torn down. Require PROOF the
    // branch advanced past base (landedSha ≠ baseSha); retry once since it's intermittent — the
    // retry removes and recreates the task worktree, so it still gets the fresh tree it needs.
    let impl = null
    for (let attempt = 1; attempt <= 2; attempt++) {
      impl = await agent(implPrompt(task, prep, attempt), { label: attempt === 1 ? `impl#${num}` : `impl#${num}·retry`, phase: 'Implement', schema: IMPL_SCHEMA })
      if (!impl) return fail(num, task.title, 'Implement agent died or was skipped.')
      if (!impl.done) return fail(num, task.title, impl.blocker || 'Implement did not finish the plan.')
      if (impl.landedSha && impl.baseSha && impl.landedSha !== impl.baseSha) break
      if (attempt === 2)
        return fail(num, task.title, `Implement reported done but its branch never advanced past \`${prep.baseBranch}\` (landedSha=${impl.landedSha || 'none'}, baseSha=${impl.baseSha || 'none'}) — no commit landed after two attempts.`)
      log(`#${num} Implement returned done but the branch did not advance past base — retrying once.`)
    }

    // Stage 3 — Review (independent /code-review; auto-fixes blocking findings, then GATES the ship).
    const review = await agent(reviewPrompt(task, prep, hasDependents, landedSince()), { label: `review#${num}`, phase: 'Review', schema: REVIEW_SCHEMA })
    if (!review) return fail(num, task.title, 'Review agent died or was skipped.')
    if (!review.reviewed) return fail(num, task.title, review.blocker || 'Review stage did not complete.')
    const reviewClean = review.blockingCount === 0
    // Every clean task is squash-merged into the slice branch (the slice PR is the human review gate).
    // Surviving blocking findings → NOT merged: the task stays an open PR, it blocks the slice PR from
    // opening, and the scheduler cascade-skips any dependents (can't build on un-shipped, suspect code).
    const shipEligible = reviewClean
    const reviewBlocked = !reviewClean

    // Stage 4 — Land (verify ACs, open PR, post findings, squash-merge iff review is clean).
    const land = await agent(landPrompt(task, prep, { shipEligible, hasDependents, review, landedSince: landedSince() }), { label: `land#${num}`, phase: 'Land', schema: LAND_SCHEMA })
    if (!land) return fail(num, task.title, 'Land agent died or was skipped.')
    if (land.shipped) landedSiblings.push({ number: num, title: task.title, files: planFilesOf(prep) })

    return {
      number: num,
      title: task.title,
      ok: land.ok,
      skipped: false,
      shipped: land.shipped,
      reviewBlocked,
      blockingCount: review.blockingCount ?? 0,
      reviewSummary: review.summary ?? null,
      reviewFindings: review.findings || [],
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

// Capture, BEFORE any worktree-isolated agent runs: (a) the repo's current branch, so the
// Settle phase can restore it (worktree isolation has been observed to leave the main worktree
// detached); and (b) the isolation worktrees that ALREADY exist — leftovers from OTHER runs
// (a concurrent batch, or an orphaned dir). The cleanup pass removes only worktrees NOT in this
// baseline, i.e. only ones THIS run created — so it never force-removes another run's live work
// (which also stops the "removing worktrees you didn't create this session" safety trip).
const startInfo = await agent(
  [
    `Run these two READ-ONLY commands and report their output. Do nothing else — no checkout, no edits, no fetch, no removal.`,
    `1. \`git rev-parse --abbrev-ref HEAD\` → its single line is "branch" (it is "HEAD" when detached).`,
    `2. \`git worktree list --porcelain\` → for every "worktree <path>" whose <path> contains \`.claude/worktrees/\`, return that <path> in the "preexistingWorktrees" array (empty array if none).`,
  ].join('\n'),
  { label: 'record-branch', phase: 'Prep', schema: { type: 'object', additionalProperties: false, required: ['branch'], properties: { branch: { type: 'string' }, preexistingWorktrees: { type: 'array', items: { type: 'string' } } } } },
)
const startBranch = startInfo && startInfo.branch && startInfo.branch !== 'HEAD' ? startInfo.branch : null
const preexistingWorktrees = startInfo && Array.isArray(startInfo.preexistingWorktrees) ? startInfo.preexistingWorktrees : []

const results = await Promise.all(tasks.map((t) => run(t.number)))

// ────────────────────────────────────────────────────────────────────────────
// Settle phase. The per-task Land agent is budget-limited and juggling many
// concerns, so the mechanical end-of-run bookkeeping it's least reliable at is
// hoisted here into dedicated, single-purpose passes with explicit checklists.
// Deterministic-where-it-can-be: each agent runs a fixed command list, not its
// own judgment, for the rote steps.
// ────────────────────────────────────────────────────────────────────────────
phase('Settle')

// ② Auto-defer. Non-blocking code-review findings on a SHIPPED task would vanish
//    with its squash-merged, now-closed PR — exactly the "auto-merge buries flagged
//    work" gap. File them as tracked `cleanup` sub-issues of the slice. Task-sized
//    bundles are filed PRE-TRIAGED (`size:task` + `ready-for-agent`): autopilot's
//    cleanup sweep was observed spending a whole triage sub-agent per issue only to
//    rubber-stamp exactly those two labels, so the deferrer — which just verified
//    every finding against the merged code — applies them itself. Anything bigger
//    or murkier still goes to `needs-triage` for a real triage pass. Held/open-PR
//    tasks keep their findings on the still-open PR, so they're left alone.
const DEFER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['issues'],
  properties: {
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['number', 'title'],
        properties: {
          number: { type: 'number' },
          title: { type: 'string' },
          url: { type: ['string', 'null'] },
          covers: { type: 'array', items: { type: 'number' }, description: 'the task numbers whose findings this issue captures' },
        },
      },
    },
    dropped: { type: ['string', 'null'], description: 'short note on findings dropped because grep/Read did not confirm them, or null' },
  },
}

let deferred = []
const shippedWithFindings = results.filter((r) => r.shipped && (r.reviewFindings || []).length > 0)
if (parentIssue && shippedWithFindings.length > 0) {
  const payload = shippedWithFindings.map((r) => ({ task: r.number, pr: r.prNumber, findings: r.reviewFindings }))
  const dz = await agent(
    [
      `You are the AUTO-DEFER stage of a /batch run. The tasks below were squash-merged into slice #${parentIssue} and their PRs are now CLOSED, so the non-blocking code-review findings attached to them would be lost. Capture them as tracked issues by following the /defer skill — with ONE difference: this run is unattended, so DO NOT ask for approval (skip /defer step 4); capture by default.`,
      ``,
      `Findings, grouped by the task they were found on (JSON):`,
      JSON.stringify(payload),
      ``,
      `Steps:`,
      `  1. VERIFY each finding before filing (/defer step 2). Read slice #${parentIssue}'s body for its \`**Integration Branch:**\`, \`git fetch origin <that-branch>\`, then confirm each cited file:line at that ref WITHOUT checking it out — use \`git show origin/<branch>:<path>\` or \`git grep <pattern> origin/<branch>\` (never \`git checkout\`, which would detach the main worktree). DROP any finding that no longer matches; if all of a task's findings fail, skip that task.`,
      `  2. BUNDLE surviving findings by the seam/file they touch (/defer step 3). Findings in the same file across different tasks (a repeated footgun) belong in ONE issue. Target "one focused PR could land all of this".`,
      `  3. CREATE each issue. You just verified every finding against the merged code, so triage-grade judgment is already done — file PRE-TRIAGED when the bundle is genuinely task-sized (one focused PR lands all of it, no open design questions): \`gh issue create --label cleanup --label size:task --label ready-for-agent\`. If a bundle is bigger or murkier than task-sized (needs a human/design call, or could be slice-sized), file THAT one as \`gh issue create --label cleanup --label needs-triage\` instead — never force-fit. The body MUST begin with \`**Part of:** #${parentIssue}\` (the slice — a task can't parent a task) and a \`**Surfaced by:**\` line naming the task(s) + merged PR(s). Use the /defer body template (one section per finding with clickable file:line links, a Scope, an Out of scope) — for pre-triaged issues the body IS the agent brief, so make the Scope precise.`,
      `  4. LINK each new issue as a native sub-issue of #${parentIssue}: \`owner_repo=$(gh repo view --json nameWithOwner -q .nameWithOwner); cid=$(gh api repos/$owner_repo/issues/<new#> --jq .id); gh api --method POST repos/$owner_repo/issues/${parentIssue}/sub_issues -F sub_issue_id=$cid\`.`,
      `  5. Do NOT start any work on the findings themselves.`,
      ``,
      `Return: issues (each {number, title, url, covers}), dropped.`,
    ].join('\n'),
    { label: 'auto-defer', phase: 'Settle', schema: DEFER_SCHEMA },
  )
  if (dz && Array.isArray(dz.issues)) deferred = dz.issues
}

// ① Reconcile + cleanup. Re-assert the lifecycle invariant the Land agent's /ship
//    is supposed to but sometimes doesn't (observed: PR merged yet issue left OPEN):
//    every shipped task ⇒ PR merged AND issue closed AND active-state labels stripped.
//    Then the one authoritative DAG recolor, and worktree hygiene — removing only THIS
//    run's leaked worktrees, runtime isolation dirs and task-<N> dirs alike (no stage removes
//    its own task worktree; this pass is the one sanctioned remover besides the crash-leftover
//    case in TASK_WORKTREE). (HEAD is settled last, in step ④, so it can land on the
//    slice branch once the promotion PR is known).
const RECONCILE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['healed'],
  properties: {
    healed: { type: 'array', items: { type: 'string' }, description: 'one line per corrective action taken; empty if every invariant already held' },
    dagRecolored: { type: ['string', 'null'], description: 'the recolor.mjs output line' },
    worktreesPruned: { type: ['number', 'null'], description: 'count of leftover worktrees removed' },
    notes: { type: ['string', 'null'] },
  },
}
const shippedSet = results.filter((r) => r.shipped).map((r) => ({ task: r.number, pr: r.prNumber }))
// Task numbers are globally unique on the tracker, so `task-<N>` for one of THIS run's task
// numbers is provably this run's worktree — and a `task-<M>` for any other M provably is not
// (it belongs to a concurrent or future run, regardless of whether it existed at baseline time).
const myTaskWorktrees = tasks.map((t) => 'task-' + t.number)
let settle = null
if (parentIssue) {
  settle = await agent(
    [
      `You are the RECONCILE stage of a /batch run for slice #${parentIssue}. Run this fixed checklist of git/gh commands and HEAL any drift. Do not improvise beyond it.`,
      ``,
      `1. LIFECYCLE INVARIANT — for each shipped task below: confirm its PR is MERGED (\`gh pr view <pr> --json state,mergedAt,baseRefName\`), then confirm its issue is CLOSED. If a merged task's issue is still OPEN, heal it: \`gh issue edit <task> --remove-label ready-for-agent --remove-label in-progress\`, then \`gh issue close <task> --comment "Shipped via #<pr> (squash-merged into <baseRefName>). Will reach \\\`main\\\` when parent #${parentIssue} ships upward."\`. If a PR is NOT merged though the task was marked shipped, do NOT close it — record that in notes.`,
      `   Shipped tasks (JSON): ${JSON.stringify(shippedSet)}`,
      `2. DAG — recolor the parent once, authoritatively: \`node "$(git rev-parse --show-toplevel)/.agents/skills/dag/recolor.mjs" ${parentIssue}\`. Relay its output (a clean no-op when there's no "## Sub-issue DAG" section).`,
      `3. WORKTREES — remove ONLY the worktrees THIS run created (the runtime's isolation dirs AND this run's shared \`task-<N>\` worktrees — both live under \`.claude/worktrees/\`); NEVER touch another run's (force-removing a concurrent run's worktree destroys its in-flight work). First \`git worktree prune\` (drops stale admin entries). Then, from \`git worktree list\`, for each path under \`.claude/worktrees/\`, apply these rules: (a) a path whose basename is one of THIS run's task worktrees — ${JSON.stringify(myTaskWorktrees)} — remove it with \`git worktree remove --force <path>\` (task numbers are globally unique on the tracker, so \`task-<N>\` for our N is provably ours); (b) a \`task-<M>\` path for ANY other M — NEVER remove it, even if it is absent from the baseline below (it belongs to a concurrent or future run); (c) any other (non-task-named) path — remove it UNLESS it is in these pre-existing worktrees, which existed before this run began and belong to other runs: ${preexistingWorktrees.length ? JSON.stringify(preexistingWorktrees) : '(none pre-existed)'}. Every path you DO remove is one this run created and whose work is already pushed to origin, so --force discards nothing of value there. Count how many you removed.`,
      ``,
      `Return: healed (one line per corrective action, empty array if nothing needed fixing), dagRecolored, worktreesPruned, notes.`,
    ].join('\n'),
    { label: 'reconcile', phase: 'Settle', schema: RECONCILE_SCHEMA },
  )
}

// ③ Slice promotion PR. The tasks are decomposition scaffolding; the human's review altitude is the
//    SLICE. So once every batched task squash-merged cleanly (the slice branch now holds the whole
//    slice), open ONE promotion PR onto the parent's branch — in review-first mode: open it, do NOT
//    merge it. That single PR is the review gate. We only attempt it when every task shipped; if any
//    task is held/failed the slice is incomplete, so we skip and the report says what to resolve.
//    Even when we do attempt it, the agent re-runs /ship's own P1 gate, so a sibling that was skipped
//    in the /batch pre-flight (never passed to this workflow) still correctly blocks the PR.
const SLICE_PR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['opened'],
  properties: {
    opened: { type: 'boolean', description: 'true iff a slice promotion PR is now open (or already open/merged)' },
    prNumber: { type: ['number', 'null'] },
    prUrl: { type: ['string', 'null'] },
    promotionTarget: { type: ['string', 'null'], description: 'the base branch the PR targets (feature branch or main)' },
    alreadyExisted: { type: ['boolean', 'null'], description: 'true iff a PR was already open/merged (idempotent no-op)' },
    blockedBy: { type: 'array', items: { type: 'number' }, description: 'open blocking child issue numbers that prevented opening (e.g. pre-flight-skipped siblings)' },
    blocker: { type: ['string', 'null'], description: 'why no PR was opened, if opened is false' },
  },
}
const allShipped = results.length > 0 && results.every((r) => r.shipped)
let slicePr = null
if (parentIssue && allShipped) {
  slicePr = await agent(
    [
      `You are the SLICE-PROMOTION stage of a /batch run. Every batched task under #${parentIssue} squash-merged cleanly into its integration branch, so the slice may now be promotable. Open its promotion PR for human review by following the /ship skill's slice-tier "Promotion flow", steps P1–P5, in REVIEW-FIRST mode: open the PR but DO NOT merge it (skip P6 entirely). The human reviews and merges the slice PR — that is the whole point; never merge it yourself.`,
      ``,
      `Do NOT check out any branch — you must not disturb the main worktree's HEAD (other workflows may be running). A promotion PR is opened by refspec against origin; \`git fetch\` is fine, \`git checkout\`/\`git switch\` is NOT.`,
      ``,
      `Steps:`,
      `  1. Confirm #${parentIssue} is a \`size:slice\` (\`gh issue view ${parentIssue} --json labels\`). If it is NOT (orphan parent, or a different tier), STOP: return opened:false, blocker:"parent #${parentIssue} is not a size:slice; nothing to promote".`,
      `  2. P1 GATE — \`owner_repo=$(gh repo view --json nameWithOwner -q .nameWithOwner)\`; list #${parentIssue}'s OPEN native sub-issues (\`gh api repos/$owner_repo/issues/${parentIssue}/sub_issues\`). Partition them: BLOCKING = open children WITHOUT a \`cleanup\`/\`deferred\` label; deferred = open children WITH one. If ANY blocking child remains, DO NOT open a PR — return opened:false, blockedBy:[their numbers]. (Deferred/cleanup children never block.) This catches siblings skipped in the /batch pre-flight.`,
      `  3. P2/P3 — read #${parentIssue}'s body for \`**Integration Branch:**\`; \`git fetch origin <that-branch>\`. Resolve the promotion target per P3: read \`**Part of:** #<P>\`; if present and that parent declares an \`**Integration Branch:**\`, target that; otherwise target \`main\` (orphan slice, or parent is an initiative).`,
      `  4. P4 — if a PR from the integration branch to the target already exists (\`gh pr list --base <target> --head <integration-branch> --state all --json number,state,url\`): if OPEN or MERGED, return opened:true, alreadyExisted:true with its number/url — do NOT open a duplicate.`,
      `  5. P5 — open the promotion PR: \`gh pr create --base <target> --head <integration-branch>\` with the P5 body template (Summary; \`Closes #${parentIssue}\`; a "Children shipped" list derived from \`git log --merges origin/<target>..<integration-branch> --pretty='format:%s'\`; a Test plan). When the target is not \`main\`, note in the body that it targets \`<target>\` and reaches \`main\` when the parent ships. DO NOT merge it.`,
      ``,
      `Return: opened, prNumber, prUrl, promotionTarget, alreadyExisted, blockedBy, blocker.`,
    ].join('\n'),
    { label: 'slice-pr', phase: 'Settle', schema: SLICE_PR_SCHEMA },
  )
}

// ④ Leave the main worktree on the right branch — the FINAL Settle step, after every one of
//    this run's worktrees (runtime + task-<N>) has been pruned. Put HEAD where the human's next action wants it: on the slice's integration
//    branch when a promotion PR was opened (so they can review/build the slice locally without first
//    switching), else restore the pre-run branch if isolation left HEAD detached. Runs last so no
//    other Settle agent's origin work is disturbed, and best-effort — a checkout failure (dirty tree,
//    branch held elsewhere) never fails the run; it just reports where HEAD was left. (Concurrency
//    note: like the reconcile HEAD-restore before it, this moves the shared main worktree's HEAD; a
//    second batch sharing this worktree is already unsafe, so this doesn't regress that.)
let headResult = null
if (parentIssue) {
  const wantSlice = !!(slicePr && slicePr.opened)
  headResult = await agent(
    [
      `You are the CHECKOUT stage of a /batch run — the FINAL step. Leave the main worktree's HEAD on the branch the human needs next. Best-effort: if a checkout would fail (dirty tree blocks it, or the branch is held in another worktree), do NOT force it — just report where you left HEAD and why in notes.`,
      wantSlice
        ? `A slice promotion PR was opened for #${parentIssue}, so leave HEAD on that slice's integration branch — the human is about to review it and shouldn't have to switch first. Read #${parentIssue}'s body for its \`**Integration Branch:**\` line, then \`git fetch origin <that-branch>\` and \`git checkout <that-branch>\` (a plain named checkout is correct now: every one of this run's worktrees (runtime + task-<N>) has been pruned, so the branch is held nowhere else). Report headLeftOn:"<that-branch>".`
        : startBranch
          ? `No slice PR was opened. If \`git rev-parse --abbrev-ref HEAD\` prints "HEAD" (detached), restore the pre-run branch: \`git checkout ${startBranch}\`; otherwise leave HEAD as-is. Report headLeftOn.`
          : `No slice PR was opened and no pre-run branch was captured. If HEAD is detached, record the detached SHA in notes and leave it — do NOT guess a branch. Report headLeftOn (null if left detached).`,
      ``,
      `Return: headLeftOn (the branch you left HEAD on, or null if detached), notes.`,
    ].join('\n'),
    { label: 'checkout', phase: 'Settle', schema: { type: 'object', additionalProperties: false, required: ['headLeftOn'], properties: { headLeftOn: { type: ['string', 'null'] }, notes: { type: ['string', 'null'] } } } },
  )
}

const opened = results.filter((r) => r.ok && !r.shipped && !r.reviewBlocked).map((r) => r.number)
const shipped = results.filter((r) => r.shipped).map((r) => r.number)
const heldForReview = results.filter((r) => r.reviewBlocked)
const failed = results.filter((r) => !r.ok)

if (settle && Array.isArray(settle.healed) && settle.healed.length > 0) {
  log(`Reconcile healed ${settle.healed.length} drifted item(s): ${settle.healed.join(' · ')}`)
}
const slicePrLine = slicePr
  ? slicePr.opened
    ? ` Slice promotion PR ${slicePr.alreadyExisted ? 'already open' : 'opened'}: ${slicePr.prUrl || '#' + slicePr.prNumber} (review-first — merge it to promote the slice).`
    : ` Slice PR not opened: ${slicePr.blockedBy && slicePr.blockedBy.length ? 'blocked by open child #' + slicePr.blockedBy.join(', #') : slicePr.blocker || 'gate not met'}.`
  : allShipped
    ? ''
    : ` Slice PR not opened: ${heldForReview.length + failed.length} task(s) held/failed — resolve them, then \`/ship #${parentIssue}\`.`
log(
  `Done: ${shipped.length} task(s) squash-merged into the slice branch, ${opened.length} clean PR(s) whose ship did not complete, ${heldForReview.length} held by code-review, ${failed.length} failed/skipped, ${deferred.length} finding(s) deferred to new issue(s).${slicePrLine}`,
)

return {
  parentIssue: parentIssue,
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
    deferred,
    slicePr: slicePr
      ? {
          opened: slicePr.opened,
          prNumber: slicePr.prNumber ?? null,
          prUrl: slicePr.prUrl ?? null,
          promotionTarget: slicePr.promotionTarget ?? null,
          alreadyExisted: slicePr.alreadyExisted ?? null,
          blockedBy: slicePr.blockedBy || [],
          blocker: slicePr.blocker ?? null,
        }
      : { opened: false, blocker: allShipped ? 'slice-promotion stage did not run' : `${heldForReview.length + failed.length} task(s) held/failed — slice incomplete`, blockedBy: heldForReview.map((r) => r.number).concat(failed.map((f) => f.number)) },
    reconciled: settle
      ? { healed: settle.healed || [], worktreesPruned: settle.worktreesPruned ?? null, headLeftOn: headResult ? headResult.headLeftOn ?? null : null, notes: settle.notes ?? null }
      : null,
  },
}
