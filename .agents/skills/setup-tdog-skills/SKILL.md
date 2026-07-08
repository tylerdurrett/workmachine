---
name: setup-tdog-skills
description: Scaffold the per-repo configuration the tdog engineering skills assume — an `## Agent skills` block in CLAUDE.md/AGENTS.md, the canonical docs under `docs/agents/`, and the integration-branch ADR under `docs/adr/`. Run before first use of `/triage`, `/to-spec`, `/decompose`, `/check`, `/audit`, `/execute`, `/ship`, `/status`, `/recap`, `/defer`, or `/grill-with-docs` — or any time those skills appear to be missing context about the issue tracker, the label vocabulary, the integration-branch convention, or the domain doc layout.
disable-model-invocation: true
---

# Setup tdog's Skills

Scaffold the per-repo configuration the tdog engineering skill set assumes:

- **Issue tracker** — where specs (initiatives, features, slices, tasks) live. tdog currently supports GitHub only; the workflow skills shell out to `gh issue *`. Other backends (local markdown, Linear, Jira, GitLab) are not supported today and would require adapter work in the consumer skills first.
- **Triage labels** — the strings used for the canonical state vocabulary, including the `cleanup` category used by `/defer`.
- **Domain docs** — where `CONTEXT.md` and ADRs live, and the consumer rules for reading them.

Plus four fixed-shape documents that every workflow skill grep's against (not user-configurable), and the integration-branch ADR (referenced by `/execute` and `/ship`; numbered 0001 by default, bumped to the next free slot if the repo already has ADRs occupying it).

This is a prompt-driven skill, not a deterministic script. Explore, present what you found, confirm with the user, then write. Assume the user does not know what these terms mean — each section is preceded by a short explainer.

## Process

### 1. Explore

Look at the current repo to understand its starting state. Read whatever exists; don't assume.

```bash
git remote -v
gh repo view --json nameWithOwner 2>/dev/null
ls -a
ls docs 2>/dev/null
ls docs/agents 2>/dev/null
ls docs/adr 2>/dev/null
```

Things to gather:

- **Repo identity.** `gh repo view --json nameWithOwner --jq .nameWithOwner`. The result is the literal `<owner>/<repo>` string the templates will be rewritten with. If `gh` errors or the remote isn't GitHub, surface this immediately — see the step 2 preamble for the halt condition.
- **Memory files at the repo root.** Does `CLAUDE.md` exist? Does `AGENTS.md` exist? Both? Neither? If both exist, treat `CLAUDE.md` as canonical and prefer editing it; mention `AGENTS.md` to the user as a duplicate worth resolving.
- **Existing `## Agent skills` block** in either file. If present, the skill updates it in place; don't append a duplicate.
- **`CONTEXT.md`, `CONTEXT-MAP.md`** at the repo root. Their presence steers Section B's default.
- **`docs/adr/`** — what numbered ADRs are already there? The integration-branch ADR drops in as `0001-*.md` by default; if the directory already has ADRs, scan for the highest existing number and pick the next free slot.
- **`docs/agents/`** — does prior output already exist? If any of `README.md`, `triage-labels.md`, `issue-tracker.md`, `output-format.md`, `lifecycle-initiative.md`, or `domain.md` is already there, treat this as a re-run and skip the rewrite for the ones that are intact.

### 2. Present findings and ask

Summarise what's present and what's missing in two or three lines.

**Before any decisions: confirm the GitHub backend.** Every workflow skill currently shells out to `gh issue *`. The setup writes [issue-tracker.md](./templates/agents/issue-tracker.md) verbatim against this backend; other trackers (local markdown, Linear, Jira, GitLab) need adapter work in the consumer skills first and are not supported today.

- If `gh repo view --json nameWithOwner` succeeded in step 1 and the user is happy with GitHub Issues for specs, proceed.
- If `gh` isn't installed, or the remote isn't GitHub, or the user wants a different backend, **stop**. Tell them the setup currently only supports GitHub, ask whether they'd like to keep going (and configure GitHub) or wait for adapter support. Don't write anything if they wait.

Once the GitHub backend is confirmed, walk the user through the two remaining decisions **one at a time** — present a section, get the user's answer, then move to the next. Don't dump both at once.

Each section starts with a short explainer (what it is, why these skills need it, what changes if they pick differently). Then show the choices and the default.

#### Section A — Triage label vocabulary

> **Explainer.** When `/triage` processes a spec, it moves it through a state machine — needs evaluation, needs grilling, needs info, ready for an AFK agent, ready for a human, deferred, won't fix — and assigns one of those states as a label. It also recognises a `cleanup` category label that `/defer` files when out-of-scope housekeeping work surfaces during another task. To do its job, `/triage` needs the label *strings* to match what's actually in your tracker. If your repo already uses different label names (e.g. `bug:triage` instead of `needs-triage`), map them here so the skill applies the right ones instead of creating duplicates.

The seven canonical state roles:

| Role               | Default label      |
| ------------------ | ------------------ |
| Needs evaluation   | `needs-triage`     |
| Waiting on reporter | `needs-info`      |
| Synthesised, awaiting alignment | `needs-grilling` |
| AFK-ready          | `ready-for-agent`  |
| Human-implementation | `ready-for-human` |
| Parked, revisit later | `deferred`      |
| Will not be actioned | `wontfix`        |

Plus the lifecycle label `in-progress` and the category labels `bug`, `enhancement`, **`cleanup`**.

Default: each role's string equals its name. Ask the user only whether they want to override any of those strings. If they do, capture the mapping in `docs/agents/triage-labels.md`'s "What replaced what" table so `/triage` and `/status` recognise both old and new during transition.

> **Don't ask about the size tier labels.** `size:initiative`, `size:feature`, `size:slice`, `size:task` are **fixed strings** the workflow skills grep for. Renaming them would mean editing every skill that references them, which is out of scope for the setup. Document them as immutable in the template and move on.

Create the labels on the remote so `/triage` doesn't fail on first use:

```bash
gh label create needs-triage     --color FBCA04 --description "Maintainer needs to evaluate" 2>/dev/null
gh label create needs-info       --color D4C5F9 --description "Waiting on reporter" 2>/dev/null
gh label create needs-grilling   --color F9D0C4 --description "Synthesised; awaiting /grill-with-docs alignment" 2>/dev/null
gh label create ready-for-agent  --color 0E8A16 --description "Fully specified; AFK-ready" 2>/dev/null
gh label create ready-for-human  --color 1D76DB --description "Needs human implementation" 2>/dev/null
gh label create deferred         --color C5DEF5 --description "Intentionally parked; revisit later" 2>/dev/null
gh label create wontfix          --color FFFFFF --description "Will not be actioned" 2>/dev/null
gh label create in-progress      --color 0E8A16 --description "Active work has begun" 2>/dev/null
gh label create bug              --color D73A4A --description "Something is broken" 2>/dev/null
gh label create enhancement      --color A2EEEF --description "New feature or improvement" 2>/dev/null
gh label create cleanup          --color CFD3D7 --description "Refactor / dedup / housekeeping" 2>/dev/null
gh label create size:initiative  --color BFD4F2 --description "Multi-feature effort" 2>/dev/null
gh label create size:feature     --color BFD4F2 --description "Multi-slice feature" 2>/dev/null
gh label create size:slice       --color BFD4F2 --description "Multi-task vertical cut" 2>/dev/null
gh label create size:task        --color BFD4F2 --description "One PR's worth of work" 2>/dev/null
```

`gh label create` 422's on duplicates; `2>/dev/null` keeps the run idempotent. If the user picked custom strings, substitute them in the call before running.

#### Section B — Domain docs

> **Explainer.** Skills that explore the codebase (`/grill-with-docs`, `/execute`, `/decompose`, `/improve-codebase-architecture`, `/diagnose`, `/tdd`) read `CONTEXT.md` for the project's domain language and `docs/adr/` for past architectural decisions. They need to know whether the repo has one global context or multiple (e.g. a monorepo with per-package contexts) so they look in the right place.

Confirm the layout:

- **Single-context** *(default for most repos)* — one `CONTEXT.md` + `docs/adr/` at the repo root.
- **Multi-context** — `CONTEXT-MAP.md` at the root pointing to per-package `CONTEXT.md` files. Typically a monorepo with distinct package vocabularies.

The template at [domain.md](./templates/agents/domain.md) defaults to single-context with a graduation note. For multi-context, edit the file in step 3 to enumerate the per-package layout.

#### What the user does NOT pick

These come along for free, regardless of the answers above:

- **`docs/agents/README.md`** — the system overview every workflow skill references. Fixed convention.
- **`docs/agents/output-format.md`** — the end-of-run output template every workflow skill grep's against. Fixed convention.
- **`docs/agents/lifecycle-initiative.md`** — initiative-tier rules (`<!-- progress-comment:initiative -->` marker, manual closure, two-phase intent → materialization). Fixed convention.
- **`docs/adr/NNNN-issues-branch-from-parent-integration-branch.md`** — referenced by `/execute` and `/ship`. Drops in from the template at `templates/adr/0001-*.md`. Default slot is `0001`; if `docs/adr/` already has ADRs, scan for the highest existing number and use the next free slot instead. Either way, rewrite the file's header `# ADR-NNNN — …` to match the chosen number, and update the references in the freshly-written `docs/agents/README.md` (the link in the "Integration branches" section) and in [issue-tracker-local-markdown.md](./templates/agents/issue-tracker-local-markdown.md) before writing. **Do not** patch references inside the consumer skills under `skills/` — those live in the published library, not the user's repo.

### 3. Confirm and edit drafts

Show the user a draft of:

- The `## Agent skills` block to add to whichever of `CLAUDE.md` / `AGENTS.md` is being edited.
- The contents of `docs/agents/issue-tracker.md`, `docs/agents/triage-labels.md`, `docs/agents/domain.md`.
- A note that `docs/agents/README.md`, `docs/agents/output-format.md`, `docs/agents/lifecycle-initiative.md`, and `docs/adr/NNNN-issues-branch-from-parent-integration-branch.md` (where `NNNN` is `0001` or the next free slot) will be written verbatim from the templates with `<owner>/<repo>` substituted.

Let them edit before writing. If they push back on something fixed (e.g. "do we really need lifecycle-initiative.md?"), the answer is yes — the workflow skills link to it by path and the link will 404 without it. Surface the reason and move on.

### 4. Write

#### 4a. Resolve `<owner>/<repo>`

```bash
NAME_WITH_OWNER=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
```

This is the literal `<owner>/<repo>` string the templates will be rewritten with; every occurrence of the token in the templates is replaced with this value before writing. The step-2 gate already confirmed `gh repo view` works, so this should not fail — if it does, halt and surface the error rather than guessing.

#### 4b. Pick the memory file to edit

- If `CLAUDE.md` exists, edit it.
- Else if `AGENTS.md` exists, edit it.
- If neither exists, ask the user which one to create — don't pick for them.

**Import exception.** If `CLAUDE.md` exists only to import `AGENTS.md` (its content is essentially `@AGENTS.md`), then `AGENTS.md` is the real instructions file and `CLAUDE.md` is just a pointer. Edit `AGENTS.md` — the block reaches Claude sessions through the import either way, and the content stays in one place. Confirm with the user when it's a close call rather than guessing.

Never create the other when one already exists.

If an `## Agent skills` block already exists in the chosen file, update its contents in-place rather than appending. Don't overwrite user edits to surrounding sections.

#### 4c. Write the `## Agent skills` block

Keep this block minimal. The chosen memory file (`CLAUDE.md` / `AGENTS.md`) loads into **every** agent session, so cost-per-token is highest here. Everything the block could spell out — the label vocabulary, the integration-branch rule, the domain layout, the initiative lifecycle, the output format — is already written once in `docs/agents/*` and restated in `docs/agents/README.md`, and every consuming skill (`/triage`, `/execute`, `/ship`, `/decompose`, `/status`, `/check`, `/audit`, `/to-spec`) links the relevant `docs/agents/*` doc and the ADR directly by relative path. An in-file copy is pure duplication that drifts. The block's only job is to point a fresh agent at the README and name the tracker.

Default to the bare pointer:

```markdown
## Agent skills

This repo uses the tdog engineering skill set; its conventions live under [docs/agents/](docs/agents/) — read [docs/agents/README.md](docs/agents/README.md) first. Specs are GitHub issues on `<owner>/<repo>`.
```

Substitute `<owner>/<repo>` with the resolved value. The Section A / B answers don't change the block — they're recorded in `docs/agents/triage-labels.md` and `docs/agents/domain.md`, which the README and skills already reach. Only expand the block beyond this pointer if the user explicitly asks for a fuller in-file summary; otherwise the bare version is correct for both `CLAUDE.md` and `AGENTS.md`.

#### 4d. Write the docs

For each path, copy the template verbatim, then run a literal substitution `<owner>/<repo>` → `$NAME_WITH_OWNER` across the file content before writing. Templates live at `skills/setup-tdog-skills/templates/`; the destinations are inside the user's repo.

| Destination                                       | Source template                                                 | Notes |
| ------------------------------------------------- | --------------------------------------------------------------- | ----- |
| `docs/agents/README.md`                           | `templates/agents/README.md`                                    | verbatim |
| `docs/agents/issue-tracker.md`                    | `templates/agents/issue-tracker.md`                             | verbatim (GitHub backend; the only one supported today) |
| `docs/agents/triage-labels.md`                    | `templates/agents/triage-labels.md`                             | apply any Section A label remap to the "What replaced what" table |
| `docs/agents/output-format.md`                    | `templates/agents/output-format.md`                             | verbatim |
| `docs/agents/lifecycle-initiative.md`             | `templates/agents/lifecycle-initiative.md`                      | verbatim |
| `docs/agents/domain.md`                           | `templates/agents/domain.md`                                    | enumerate per-package layout if Section B picked multi-context |
| `docs/adr/NNNN-issues-branch-from-parent-integration-branch.md` | `templates/adr/0001-issues-branch-from-parent-integration-branch.md` | `NNNN` is `0001` by default; bump to the next free slot if `docs/adr/` already has ADRs occupying it (see "What the user does NOT pick" above). Rewrite the `# ADR-NNNN — …` header to match. |

If `docs/agents/` or `docs/adr/` don't exist yet, create them. Idempotency rule: if a destination file already exists with non-trivial differences from the template, **do not silently overwrite** — show the user a diff and let them decide. Re-runs against a clean install should be no-ops.

#### 4e. Verify substitutions

Quick sweep before declaring done:

```bash
grep -rn "<owner>/<repo>" docs/agents docs/adr 2>/dev/null
```

Should return zero hits. If anything remains, the substitution missed it; fix and re-run.

#### 4f. Add the batch/autopilot land-step autoMode rule (recommended for `/batch` + `/autopilot`)

`/batch` and `/autopilot` squash-merge each code-review-clean task PR into a slice/feature *staging* branch. In auto permission mode the harness safety classifier ("[Merge Without Review]") blocks an agent from merging a PR it created — which also blocks that legitimate task→staging merge and fails the run. The correct fix is an `autoMode.allow` rule that authorizes exactly that one merge shape.

**Why an `autoMode.allow` rule and not a hook.** A PreToolUse hook returning `permissionDecision: "allow"` does **not** override the safety classifier — per the Claude Code docs the classifier is a second gate that runs *after* the permissions system, so a hook `allow` never reaches it. Worse, the classifier can block a delegated sub-agent at the *intent* level, before any `gh pr merge` command string exists for a Bash-matcher hook to inspect. Only an `autoMode.allow` rule speaks to the classifier directly.

**Where the rule must live.** The classifier does **not** read `autoMode` from a checked-in project `.claude/settings.json`. The rule must go in the user's `~/.claude/settings.json` (user scope) or the repo's `.claude/settings.local.json` (project-local, git-ignored). Prefer `.claude/settings.local.json` so the authorization is scoped to this repo.

Skip this only if the user never intends to run `/batch` or `/autopilot` in auto mode. Otherwise:

1. Ensure `.claude/settings.local.json` exists in the user's repo (create it if absent) and that `.claude/settings.local.json` is git-ignored (it holds machine-local, un-checked-in settings — add it to `.gitignore` if it isn't already).
2. **Merge, don't overwrite** — if the file already exists, add the string into the existing `autoMode.allow` array (creating `autoMode`/`allow` only if absent); never clobber unrelated settings. Add this rule verbatim to `autoMode.allow`:

   ```json
   {
     "autoMode": {
       "allow": [
         "Squash-merging a code-review-clean task PR (head branch shaped like <type>/issue-N) into a slice/* or feature/* staging integration branch is authorized, including deleting that same merged task's own head branch as part of the squash-merge (e.g. `gh pr merge --squash --delete-branch`). This is the /batch and /autopilot land step: an independent /code-review high already passed the diff, and the real two-party human review gate is the downstream slice/feature promotion PR — which automation opens review-first and never auto-merges. This authorization does NOT extend to merging into main, master, or any default/protected branch, and does NOT authorize deleting any branch other than the just-merged task's own head branch; those remain blocked."
       ]
     }
   }
   ```

The rule keeps `main`/`master` and any other branch deletion out of scope, so the authorization is narrow no matter who runs the command. If the user prefers user-scope instead of project-local, add the same string to `autoMode.allow` in `~/.claude/settings.json`.

Idempotency: if a matching `autoMode.allow` entry already exists, this is a no-op.

### 5. Done

Tell the user the setup is complete. List the files that were written (or updated). Mention:

- They can edit `docs/agents/*.md` directly later — the workflow skills read those files at runtime; changes take effect immediately.
- If the batch/autopilot `autoMode.allow` rule was added (step 4f), note it lives in `.claude/settings.local.json` (or user settings) — not the checked-in `.claude/settings.json`, which the safety classifier does not read for `autoMode` — and that it authorizes only a clean task PR into a `slice/*`|`feature/*` staging branch; merges into main/master stay blocked, so the slice/feature promotion PR is still where a human reviews and merges.
- Re-running `/setup-tdog-skills` is only necessary if they want to restart from scratch or pick up a future revision of the templates.
- The natural next move is `/triage` (no args) for a survey, or `/to-spec` to capture the first idea.

End-of-run output per [docs/agents/output-format.md](./templates/agents/output-format.md) (this skill produces durable artifacts, so the three-block template applies):

```
Scaffolded tdog skills under <owner>/<repo>.

- docs/agents/{README,issue-tracker,triage-labels,output-format,lifecycle-initiative,domain}.md
- docs/adr/NNNN-issues-branch-from-parent-integration-branch.md  (NNNN = the slot chosen at write time)
- ## Agent skills block in <CLAUDE.md|AGENTS.md>
- .claude/settings.local.json autoMode.allow rule for the batch/autopilot land step  (only if step 4f ran)

> Next step: `/triage`. Survey the tracker (will be quiet on a fresh repo) and confirm the labels resolve.
```

## Verification

After a fresh run in a previously-unconfigured repo, all of the following should be true:

1. `ls docs/agents/` shows `README.md`, `issue-tracker.md`, `triage-labels.md`, `output-format.md`, `lifecycle-initiative.md`, `domain.md`.
2. `ls docs/adr/` includes `NNNN-issues-branch-from-parent-integration-branch.md` (where `NNNN` is `0001` or the next free slot if `0001` was already taken), with the references in `docs/agents/README.md` and `docs/agents/issue-tracker.md` matching the chosen number.
3. `CLAUDE.md` (or `AGENTS.md`) has a bare `## Agent skills` block that points at `docs/agents/README.md` and names the tracker — no inline restatement of labels, branches, domain, lifecycle, or output format.
4. `grep -rn "<owner>/<repo>" docs/` returns nothing.
5. `gh label list` includes all seven state labels, `in-progress`, the four `size:*` labels, and the three category labels (including `cleanup`).
6. `/triage` and `/execute` against fresh specs run without complaining about missing doc paths.

## What this skill does NOT do

- It does not edit the workflow skills under `skills/`. Those are the published library; the user's repo's `docs/agents/` is the configuration surface.
- It does not seed `CONTEXT.md` or any ADR other than the integration-branch one. `/grill-with-docs` is the producer for both.
- It does not create initial specs or initiatives. `/to-spec` is the producer.
- It does not support tracker backends other than GitHub. Local markdown, Linear, Jira, and GitLab would need adapter work in the consumer skills (`/triage`, `/decompose`, `/execute`, `/ship`, `/defer`, `/status`, `/to-spec`, `/audit`, `/check`, `/recap`) before they could be offered here. The local-markdown template file at `templates/agents/issue-tracker-local-markdown.md` is kept as forward-compatible scaffolding for that future work.
