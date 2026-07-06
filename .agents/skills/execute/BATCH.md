# Execute under /batch

*The /batch-facing subset of [SKILL.md](SKILL.md) Steps 1–6 (Prep) and 7-review/8/9 (Land). Mechanics only; rationale lives in SKILL.md. The workflow prompt governs branch mechanics (detached HEAD, refspec pushes) — never do named checkouts.*

## Prep

No human halts: batch pre-filters `needs-triage`, and Step 5's approval halt is skipped. Any failed gate → return not-ready with the blocker.

**1. Validate.**

```bash
gh issue view <N> --comments --json number,title,body,labels,state
```

`state` must be `OPEN`; labels must include `ready-for-agent` AND `size:task` — otherwise return not-ready. Read the agent brief comment (most recent `## Agent Brief`) plus any later comments that update the contract.

**2. Resolve the base branch** by walking `**Part of:** #<P>` body lines up the parent chain to the nearest `**Integration Branch:**` declaration (fallback `main`):

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

The stderr echo is contract: read every `## Parent comments` block. A comment contradicting the brief is a blocker — don't pick silently.

Check `git ls-remote --heads origin <base-branch>`. Missing and non-`main` → seed the whole missing ancestor chain recursively. **Never fork off `main` instead** — that flattens the hierarchy and corrupts the promotion diff:

```bash
# Idempotent; safe under concurrent first-tasks. `main` is terminal.
ensure_integration_branch() {
  local branch=$1 decl=$2
  [ "$branch" = "main" ] && return 0
  if [ -n "$(git ls-remote --heads origin "$branch")" ]; then
    echo "Reusing existing integration branch $branch on origin" >&2
    return 0
  fi
  local fork_source fork_decl
  read fork_source fork_decl < <(resolve_base_branch "$decl")
  ensure_integration_branch "$fork_source" "$fork_decl"   # seed the chain first
  git fetch origin "$fork_source"
  git push origin "origin/$fork_source:refs/heads/$branch"
  echo "Created integration branch $branch on origin from origin/$fork_source" >&2
}

ensure_integration_branch "$base_branch" "$declaring_parent"
```

A failed push is a stop condition — return not-ready.

**3. Sync.** `git fetch origin <base-branch>` so exploration and the plan are grounded in the freshest tree.

**4. Explore.** Use the brief's named interfaces, types, packages, and ACs as entry points; respect ADRs and `CONTEXT.md`. Size gate — more than ~6 sub-sections, a migration plus cross-package cascades, 3+ coordinated packages, or naturally demoable progressions → mis-sized; return not-ready recommending re-triage. Never relabel.

**5. Plan.** Numbered sub-sections (2–6 typical), **one commit each**; critical files with one-line notes; verification commands. Return it — no approval halt.

**6. Branch name.** `<type>/issue-<N>-<slug>`: `fix/` (bug fix), `feat/` (new behavior; default), `refactor/`, `chore/` (tooling/docs); slug ≤3 kebab-case words from the title. Creation and push per the workflow prompt.

## Land

Covers Step 7-review, Steps 8–9, and the ship handoff.

**Review the implementation.** `git fetch origin <base-branch>`, then:

```bash
git log --oneline origin/<base-branch>..HEAD
git diff origin/<base-branch>..HEAD
```

One commit per plan sub-section (plus an optional `fix(review):` commit), on-contract, no drift into SKILL.md's "What this skill does NOT do" areas. Re-run `pnpm typecheck` (and `pnpm test` if the plan calls for it); the workflow's supply-chain note governs binary invocation. Fix small gaps directly, commit, push via refspec. A red tree or off-contract diff is a blocker.

**Verify acceptance criteria first-hand (Step 8).** Walk the brief's AC list in order. Each is **verified** (you ran it and saw the outcome) or **cannot verify locally** (name the specific blocker). Anything checkable with a small throwaway script must be verified — write it, run it, delete it. Don't rebadge "didn't run it" as manual smoke.

**Open the PR (Step 9).** The branch is already on origin; from detached HEAD pass `--head` explicitly:

```bash
gh pr create --base <base-branch> --head <type>/issue-<N>-<slug> --title "<title>" --body "..."
```

- `Closes #<N>` in the body **only when `<base-branch>` is `main`**. Otherwise omit it and note: "Targets `<base-branch>`; will land on `main` when parent #<declaring-parent> promotes upward." (`/ship` closes the issue then.)
- Keep the body short: Summary, the AC checklist with pass/fail from Step 8, and a "Review notes" digest if the workflow prompt supplied one. Skip SKILL.md's full test-plan narrative — under /batch this PR auto-merges into the slice branch minutes later and is never individually human-reviewed; the slice promotion PR is the human review surface.

**Ship handoff.** When the workflow prompt marks the task ship-eligible (clean review), run the task-tier ship flow — [../ship/TASK.md](../ship/TASK.md) — to squash-merge into `<base-branch>` and close the issue. If it refuses (failing checks, conflicts, unresolved review), report the blocker with `shipped:false`; never force. A held task gets its PR opened and the surviving findings posted as a PR comment — no merge.
