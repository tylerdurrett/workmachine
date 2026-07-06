---
name: audit
description: Multi-agent (Claude sub-agent + Codex subprocess) version of `/check`. Tier-aware via the input spec's `size:*` label. Synthesises both legs' findings with provenance, classifies them into per-tier writes (per-child body edits, new children for uncovered scope, dated synthesis comment, upstream propagation comments), gates every write on explicit user approval, and on approval lands the writes back to the tracker. Reach for it when the cost of a flawed decomposition is high. Use when the user says "audit the spec", "cross-check this plan", "audit the feature/slice/initiative", or asks for a deeper review than `/check` alone.
---

# Audit

Cross-check a tier-bearing spec's decomposition against itself using two heterogeneous reviewers, classify the surviving findings into the per-tier writes that follow from them, gate every write behind explicit user approval, and on approval land the writes — per-child body edits, new children for uncovered scope (feature and initiative tiers), a dated synthesis comment, and (slice and task tiers) sibling or parent propagation comments where the bar is met.

`/check` on its own is single-agent and read-only — fast and useful, but it shares the spec author's blind spots with the reviewer. `/audit` runs `/check` twice in parallel — once as a Claude sub-agent and once as a Codex subprocess — then this orchestrating session synthesises both legs, drops findings that a later open child already addresses, draws a tight bar around what propagates upstream, walks the user through the surviving findings one at a time behind an explicit approval gate, and on approval lands the writes.

`/check` is the faster path. Reach for `/audit` when the cost of a flawed decomposition is high enough to justify the second leg — typically right after `/decompose` publishes children, before any `/execute` runs.

For tracker mechanics see [docs/agents/issue-tracker.md](../../../docs/agents/issue-tracker.md); for label vocabulary see [docs/agents/triage-labels.md](../../../docs/agents/triage-labels.md); for the canonical end-of-run output see [docs/agents/output-format.md](../../../docs/agents/output-format.md).

## When to use

- After `/decompose` publishes a spec's children, before kicking off `/execute` against the first task.
- After the maintainer hand-edits a spec body or a child body in a way that might have shifted coverage or scope.
- When `/check` flagged nothing but you still suspect the decomposition might be wrong (single-agent blind spot).

## When NOT to use

- The spec has no size label. Run `/triage <N>` first to size it.
- The spec is closed. Coverage of closed work is meaningless.
- The spec has no children to audit (initiative / feature / slice tiers) — run `/decompose` first.
- You want to **edit** the spec body itself to add or restructure scope. That's a maintainer action, not this skill.

## Tier dispatch

The input spec's `size:*` label picks the mode. Each tier's per-child writes, new-child policy, and propagation rules differ; the orchestration (Codex subprocess, parsing, dedupe, provenance, approval gate) is shared.

| Size label        | Mode       | Per-child writes                                         | New children?                                | Synthesis comment? | Backward propagation?                       |
| ----------------- | ---------- | -------------------------------------------------------- | -------------------------------------------- | ------------------ | ------------------------------------------- |
| `size:initiative` | initiative | `## Audit findings (<date>)` in affected feature children | Yes — cluster uncovered DoD outcomes         | Yes (on initiative) | No (top of tier chain)                      |
| `size:feature`    | feature    | `## Audit findings (<date>)` in affected slice children   | Yes — cluster uncovered user stories         | Yes (on feature)    | No                                          |
| `size:slice`      | slice      | `## Audit findings (<date>)` in affected task children    | No (slice-level gaps are a `/decompose` job) | Yes (on slice)      | Yes — schema / breaking-type / sequencing   |
| `size:task`       | task       | `## Audit findings (<date>)` in the task body itself      | n/a (leaf)                                   | No (body edit IS the artifact) | Yes when parent exists — same bar as slice |

## Roles and processes

Three roles, two delegated check legs:

- **Orchestrator** — this Claude session (the main agent). Resolves the spec, fetches children, dispatches both check legs in parallel, and — once both have returned — does everything after: synthesis, the one-finding-at-a-time user discussion, the approval gate, and applying the writes. It does **not** run `/check` in its own context; both legs are delegated so the orchestrator stays an impartial synthesiser rather than also being a finding author.
- **Agent A** — a Claude **sub-agent** (via `Task`) running `/check #<N>` against the resolved spec. It runs `/check` to completion and returns its terminal `## Findings` block verbatim as its final message (the Task result). Delegating Agent A to a sub-agent — rather than running it inline — keeps the orchestrator's later synthesis and user-facing discussion uncoloured by having authored one of the legs.
- **Agent B** — `codex exec` subprocess running `/check #<N>` against the same spec in parallel. Output captured deterministically via `-o <tmpfile>`. Runs in `--sandbox workspace-write` with `sandbox_workspace_write.network_access=true` because `/check` needs the network (`gh issue view`, `gh issue list`) and reads from the workspace; the skill's own contract is what prevents writes, not the sandbox. `read-only` is the wrong fit — it blocks network and `gh` cannot reach `api.github.com`, so the leg falls through with "missing-issue".

Both check legs run outside the orchestrator's context — one a Claude sub-agent, one a Codex subprocess — so the orchestrator reads both `## Findings` blocks fresh and synthesises them symmetrically. Sub-tasks within synthesis (forward-scope checks, codebase grounding when a finding needs a re-read, clustering uncovered scope into draft new children) use `Task(subagent_type="Explore")`.

## Process

### 1. Resolve the spec and pick a mode

The user passes an issue reference: `#<N>`, a bare number, or a full `https://github.com/<owner>/<repo>/issues/<N>` URL. Resolve to a number, then fetch the spec:

```bash
gh issue view <N> --comments --json number,title,body,labels,state
```

Read the body and every comment before doing anything else.

The spec's size label picks the mode per the [tier-dispatch table](#tier-dispatch). Both labels missing, multiple size labels present, or the spec is closed → ask the user to clarify before proceeding. Do not guess.

#### Refusal paths

Stop and tell the user clearly when any of these hold. Do not improvise.

- **Missing spec.** `gh issue view` errored (404, network, auth). Surface the error verbatim and exit.
- **Closed spec.** `state` is `CLOSED`. Exit.
- **No size label.** Spec carries none of `size:initiative` / `size:feature` / `size:slice` / `size:task`. Tell the user to run `/triage <N>` first.
- **Body lacks the tier's required forward-coverage section.** Per the table below. Tell the user to re-run `/to-spec` (which writes the section by template) or hand-add the section before re-running.
- **Non-issue argument.** A branch name, a file path, a PR URL. Refuse politely and tell them the shape: `/audit #<N>` against an open size-labeled spec. Decomposition lives on the tracker as native sub-issues, not as files in a `.plans/` directory; a path argument is almost certainly a stale habit.

| Mode       | Required body section          |
| ---------- | ------------------------------ |
| initiative | `## Definition of done`        |
| feature    | `## User Stories`              |
| slice      | `## Acceptance criteria`       |
| task       | `## Acceptance criteria`       |

Soft skip: if the body lacks `## Out of Scope` (or `## Out of scope`, case varies by template), continue. Both legs run the forward (coverage) check only; the negative check is silently skipped. Note the skip in the synthesis comment preamble so the maintainer knows the run was partial.

### 2. Fetch children once, up front

All modes except a parentless task fetch children (or, for task mode, the task's siblings via its parent) once, up front. The orchestrator uses this for forward-scope checks, drafting per-child body edits, clustering uncovered scope, and re-run dedupe via the audit-origin marker.

**Initiative / feature / slice modes.** Fetch the input spec's children:

```bash
gh issue list --search "parent-issue:<owner>/<repo>#<N>" \
  --state all \
  --json number,title,state,labels,body \
  --limit 100
```

Read every open child's body. Closed children matter for the forward check (a target addressed by a shipped child is covered, not uncovered) and for sequencing; they're out of scope for per-child writes (already shipped).

**Task mode.** Resolve the parent first — the body's first line should be `**Part of:** #<P>` (or near the top). If absent, the task is a parentless leaf; skip the sibling fetch and run the per-task checks below without sibling context. If present, fetch the parent body and sibling task bodies (open + closed):

```bash
gh issue list --search "parent-issue:<owner>/<repo>#<P>" \
  --state all \
  --json number,title,state,body \
  --limit 100
```

### 3. Launch both legs in parallel

Dispatch both check legs so they run concurrently — Agent B as a **backgrounded** Bash call, Agent A as a `Task` sub-agent launched right after — then wait for both to return before synthesising. They take roughly the same wall-clock time, so launching them serially doubles the audit cost for no gain. The orchestrator runs neither `/check` itself.

**Agent A (Claude sub-agent).** Dispatch a `Task` sub-agent (a general-purpose Claude agent with full tools) and have it run `/check #<N>` to completion, returning the terminal `## Findings` block verbatim as its final message. A prompt of the shape:

> Run the `/check` skill against issue `#<N>` in this repo. Let it run its full read-only analysis, then return its terminal `## Findings` block **verbatim** as your entire final message — the `## Findings` heading and every bullet (or the `_No issues surfaced._` sentinel), and nothing else.

The Task result IS Agent A's output — the orchestrator reads the `## Findings` block straight from it in Step 4. Do not run `/check` in the orchestrator's own context; the whole point of delegating is to keep the synthesising session impartial.

**Agent B (Codex subprocess).** Run via Bash, backgrounded so it runs alongside the Agent A sub-agent:

```bash
RUN_ID=$(date +%Y%m%d-%H%M%S)-$$
CODEX_OUT=$(mktemp -t "audit-codex-${RUN_ID}.XXXXXX")
GH_TOKEN="$(gh auth token)" codex exec \
  --sandbox workspace-write \
  -c 'sandbox_workspace_write.network_access=true' \
  --ephemeral \
  --skip-git-repo-check \
  -C "$(pwd)" \
  -o "$CODEX_OUT" \
  '/check #<N>'
```

Notes on the invocation:

- `--sandbox workspace-write -c 'sandbox_workspace_write.network_access=true'` because `/check` needs network access (`gh issue view`, `gh issue list`) — the previous `--sandbox read-only` blocked network and the Codex leg silently fell through with `error connecting to api.github.com`. `workspace-write` allows network and writes inside the workspace; the skill's read-only contract is what stops writes, not the sandbox.
- `GH_TOKEN="$(gh auth token)"` is prepended so `gh` authenticates **inside** the Codex sandbox. When the operator's token lives in the macOS keychain (the `gh auth login` default — `gh auth status` shows `(keyring)` and `~/.config/gh/hosts.yml` has no `oauth_token:` field), the sandbox can't reach the keychain and `gh` fails with `HTTP 401: Requires authentication`. Resolving the token in the unsandboxed parent shell and passing it as an env var sidesteps the keychain: `gh` prefers `GH_TOKEN`/`GITHUB_TOKEN` over the keyring, and env vars pass through the sandbox. The token is never written to disk — it lives only in the child process's environment for the life of the one-shot. If `gh auth token` itself fails in the parent shell, the operator isn't logged in at all; fall through to single-leg per the Codex-failure mode.
- `--ephemeral` because this is a one-shot — no need to persist a Codex session.
- `-o <file>` writes Agent B's final message (which carries the `## Findings` block) to a file the synthesiser can read deterministically. This is the analog of `claude -p --output-format json`'s `result` field — same idea, different CLI.
- `-C "$(pwd)"` ensures Codex runs at the repo root so its `.agents/skills/` lookup resolves `/check`. Skip only if the parent is already at the root.
- The trailing positional prompt is a single shell-quoted string with the issue reference — `'/check #<N>'`. The slash-command resolves inside Codex via the same `.agents/skills/` lookup Claude uses, and `/check` itself does the tier dispatch from labels, so this skill never has to special-case the mode at the Codex boundary.

Kick off the backgrounded Codex Bash call first, then dispatch the Agent A `Task` in the same turn so both legs run concurrently. When the Agent A Task returns, read the backgrounded Codex output (Step 4). Do not block on Codex before dispatching Agent A — that serialises the two legs and doubles the audit cost for no gain.

### 4. Parse both legs' findings

Agent A's terminal `## Findings` block is the Task sub-agent's returned result — read it directly from the Task output.

Agent B's terminal `## Findings` block is at the bottom of `$CODEX_OUT` — read the file, locate the last `## Findings` heading, and parse the bullets that follow.

For each leg, parse bullets of the shape `- [<severity>] <claim>. <ref> [<ref> ...]`. A `<ref>` is either a `path/to/file.ts:line` (or bare path) or an issue / comment URL — `/check` cites file paths for grounding findings and tracker URLs for coverage findings, so the parser must accept both shapes. Treat anything that doesn't match (truncated output, missing block, conversational text in place of bullets) as a parse failure for that leg — see the failure-modes section below.

The clean-bill sentinel `_No issues surfaced._` parses as zero findings (not a parse failure).

### 5. Synthesise

Build the unified findings set with these rules:

- **Dedupe by substance.** Two findings are equivalent when they refer to the same claim about the same target (file, `file:line`, or issue / comment URL). Wording will differ between agents — judge by substance, not lexical match. Equivalent findings collapse into one unified finding tagged `both`.
- **Provenance.** Each unified finding carries a `claude` / `codex` / `both` tag. Display this in every artefact the synthesiser produces (chat output, per-child body edits, new child bodies, the synthesis comment, upstream comments) — provenance is what makes the cross-check meaningful.
- **Refutation.** If one leg makes a claim and the other leg explicitly refutes it (not just silence — silence is silence), drop the refuted item and note the refutation in the synthesised report. Refutation is rare; do not over-claim it.
- **Severity reconciliation.** When both legs flag the same item with different severities, take the higher (`blocker` > `concern` > `nit`).
- **Action classification.** Tag each unified finding with the per-tier action it maps to:

| Tier       | Classifications                                                                                |
| ---------- | ---------------------------------------------------------------------------------------------- |
| initiative | `uncovered-outcome` / `partial-coverage` / `oos-drift` / `initiative-itself-wrong`             |
| feature    | `uncovered-story` / `partial-coverage` / `oos-drift` / `feature-itself-wrong`                  |
| slice      | `grounding` / `sizing` / `sequencing` / `ac-uncovered` / `ac-partial` / `oos-drift`            |
| task       | `grounding` / `ac-sanity` / `sibling-context`                                                  |

The classified set is what every subsequent step operates on.

### 6. Forward-scope check

For each unified finding, check whether the issue is actually addressed by a *later* open child — or already shipped by a closed child. Dispatch **one** `Task(subagent_type="Explore")` subagent for the whole finding set — not one per finding: every per-finding agent would re-ingest the same child corpus, making the cost quadratic in decomposition size for zero extra signal. Brief the single subagent with ALL findings' claims + cited targets, and every child's body (from Step 2), and ask it to report **per finding** whether any later open child's `## Scope`, `## Sub-tasks`, `## Candidate tasks`, `## Acceptance criteria`, `## User Stories`, or `## Definition of done` covers the same work, or whether a closed child already addressed it. (Split into 2–3 batched agents only if the combined brief would be enormous — say 15+ findings.)

If yes, drop the finding from the synthesised set with a noted reason (e.g. "covered by child #143 sub-task 3" or "shipped in closed child #128"). These are premature flags — they look like gaps in an early child because the work lands in a later child.

If no (or unclear), keep the finding.

In task mode without a parent, the forward-scope check is skipped (no siblings to defer to). Every surviving finding from Step 5 carries forward.

### 7. Backward-propagation check (slice and task modes only)

Skip this step for initiative and feature modes — they don't propagate.

For each surviving finding in slice or task mode, decide whether it meets the bar to push back upstream into sibling specs or the parent. The bar is narrow:

- **Schema changes.** Column adds / drops, FK changes, RLS policy shifts, enum value changes. Anything a downstream developer would not naturally discover by reading their own spec's code.
- **Breaking API or type changes.** Signature changes, removed exports, collapsed discriminated unions, removed fields. Anything that breaks consumers in other slices or tasks.
- **Sequencing reversals.** A finding that flips the order of two children (e.g. task #4 has to land before task #2 because of a runtime dependency).

Everything else stays inside the audited spec. A "this child is too vague" or "this assertion about helper X is wrong" finding doesn't propagate — the spec owner reads the per-child callouts and the synthesis comment and acts on them. Only propagate things downstream developers wouldn't discover from reading their own work.

**Enumerate propagation targets.** Walk the audited spec's body for `**Part of:** #<P>`:

- If absent → orphan spec with no parent. Skip the propagation step entirely; per-child writes and the synthesis comment still happen on approval.
- If present → `<P>` is the parent. Sibling specs at the same tier are listed via the `parent-issue:` search qualifier:

  ```bash
  gh issue list --search "parent-issue:<owner>/<repo>#<P>" \
    --state open \
    --json number,title \
    --limit 100
  ```

  The audited spec itself appears in this list — exclude it before drafting. Closed siblings are out of scope (already shipped). The parent `<P>` is itself a valid target — draft a comment there when the finding is broad enough to concern the whole parent's scope rather than any one sibling.

For each propagating finding, draft a `gh issue comment` post:

```bash
gh issue comment <N> --body "$(cat <<'EOF'
**Surfaced by:** /audit run on <tier> issue #<audited-N> (parent: #<parent-N>)

<one-line summary of the finding>

<the finding text from the audit run, including its file references and provenance>
EOF
)"
```

`<N>` is the sibling or parent issue number. The skill drafts these but does not post them yet — every write goes through the approval gate.

### 8. Draft the writes

For each surviving finding, draft the corresponding write per the [tier-dispatch table](#tier-dispatch). Drafts are held in-session through the approval gate; nothing is sent to the tracker yet.

#### Per-child body edits — `## Audit findings (<date>)` section

For each affected child (or, in task mode, the audited task itself), draft a `## Audit findings (<YYYY-MM-DD>)` section to insert into the body. Insertion location: just above the first breakdown section in the body, in this preference order: `## Sub-tasks` → `## Candidate tasks` → `## Acceptance criteria` → end of body. This puts findings where the executing or decomposing agent will see them before they start work.

Section shape:

```markdown
## Audit findings (<YYYY-MM-DD>)

- [<severity>] (<provenance>) [<classification>] <claim>. <ref> [<ref> ...]
- [<severity>] (<provenance>) [<classification>] <claim>. <ref>
```

`<provenance>` is `claude`, `codex`, or `both`. `<classification>` is the per-tier tag from Step 5. `<ref>` is `path/to/file.ts:line` (or bare path) or an issue / comment URL — same shape as `/check`'s output. One bullet per finding affecting this child.

If the child body already has an `## Audit findings (<YYYY-MM-DD>)` section dated today (re-running on the same day), append the new bullets to the existing section's bullet list rather than creating a second same-dated section. Older audit-findings sections on different dates are preserved verbatim — every audit is additive and dated.

If the child body has no recognised insertion target (no `## Sub-tasks`, no `## Candidate tasks`, no `## Acceptance criteria` — irregular shape), surface the issue and skip writes to that child. Do not guess. The user can re-shape the child manually and re-run.

**Load-bearing slice-wide findings are propagated downward.** A slice-mode finding tagged with the propagation bar (sequencing reversals especially) lands in the slice synthesis comment AND in each affected task child's `## Audit findings` section, so the executing agent sees the constraint locally rather than having to chase a slice-level comment. Tag the bullet `[<classification>, slice-wide]` to signal it propagated down.

#### New children (initiative and feature modes only)

In initiative mode, group `uncovered-outcome` findings into draft new feature children. In feature mode, group `uncovered-story` findings into draft new slice children. Use the same tracer-bullet logic `/decompose` uses — related uncovered scope grouped into one cohesive child, not 1:1 mapping.

Each draft uses the per-tier body template `/decompose` writes (feature template for initiative-mode new children, slice template for feature-mode new children) and ends with:

```markdown
**Part of:** #<P>
**Surfaced by:** /audit run on <tier> #<P>
```

`<P>` is the audited spec's number. The `**Part of:**` line is the canonical greppable parent reference (read by `/execute`, `/decompose`, `/ship`, this skill's re-run dedupe). The `**Surfaced by:** /audit run on <tier> #<P>` marker is the audit-origin anchor — the dedupe key against existing native sub-issues of `<P>` on re-runs (see Step 10b).

The new children will be created with `size:<child-tier>` + `needs-triage` so they enter the standard triage flow.

In slice and task modes, no new children are drafted. Slice-level gaps in the AC list are a `/decompose` re-decompose problem; task is a leaf.

#### Synthesis comment

Drafted in initiative, feature, and slice modes, regardless of finding count. Skipped in task mode — the per-task body edit IS the audit artefact for a leaf.

Comment body shape, posted on the audited spec:

```markdown
## Audit synthesis (<YYYY-MM-DD>)

Audited via `/audit`. Legs: Claude (sub-agent), Codex (subprocess).

- [<severity>] (<provenance>) [<classification>] <claim>. <ref> [<ref> ...]
- [<severity>] (<provenance>) [<classification>] <claim>. <ref>

<Optional one-paragraph note on legs that failed or were skipped, and why.>
```

One bullet per surviving finding (every finding the audit surfaced — per-child + spec-wide), in the order findings were surfaced in conversation. The comment is summary-only; the per-child body edits in Step 10c are the duplicate cover for the executing agent.

If there were zero surviving findings (clean bill), the comment still posts on approval — its body is the dated heading, the legs line, and a single line `_No issues surfaced._` Posting on a clean bill is intentional: the dated comment is the durable artefact that this spec was audited and came up clean.

### 9. Approval gate

Nothing is written until the user approves — no body edit, no new issue, no comment, even for nit-level findings. Walk the user through the results **one finding at a time** (the way `/check` surfaces findings conversationally), then confirm the spec-level writes. Do not dump the whole write set as a single wall and ask one yes/no — the per-finding walk is what lets the user keep some findings and drop others, and is the load-bearing difference between this gate and a blanket "apply everything?".

#### 9a. Findings, one at a time

For each surviving finding, in the order it was surfaced:

- **Explain it in plain English** — *what's going on*, *why it matters* (the concrete failure it would cause an executing or decomposing agent downstream), and the *proposed write* it maps to (which child body gets the `## Audit findings` bullet, or which upstream comment it drafts).
- **State its provenance plainly** — `both` legs agreed, or it's `claude`-only / `codex`-only. When one leg is silent, say so and say that silence is **not** refutation. This is what makes the cross-check legible to the user.
- **Gate that finding individually.** Ask whether to record/apply it. Accept record-it / skip-it / edit-the-wording, and carry the decision forward into the write set.

Use `AskUserQuestion` (one finding per question, with the explanation in the surrounding message) or a plain conversational ask — whichever fits — but gate each finding on its own so the user can take some and drop others. A clean bill (zero findings) skips 9a entirely; the synthesis comment in 9b is still offered.

#### 9b. Spec-level writes

After the per-finding pass, confirm the writes that aren't tied to a single finding, reflecting only the findings the user kept in 9a:

- **Synthesis comment** (initiative / feature / slice modes). Show the full body that will be posted (or appended to today's existing audit comment, see Step 10a). Include only kept findings as live bullets, with a one-line footnote noting any finding reviewed-and-dropped so the audit record stays honest about what the cross-check covered. Ask whether to post it.
- **New children to create** (initiative and feature modes only). For each draft: the proposed title, the full body that will be sent to `gh issue create`, the labels (`size:<child-tier>` + `needs-triage`), and a one-line note on which uncovered-scope finding(s) it bundles. Gate each draft.
- **Upstream propagation comments** (slice and task modes only). Target issue number and full comment body for each. Gate each.

Mark any child being skipped due to irregular body shape so the user sees the skip up front.

Throughout 9a and 9b the user can: approve an item, skip it, edit its wording before applying, or reject the whole run (exit cleanly, no writes anywhere). Apply only what the user explicitly accepts.

Do not write anything until the user approves. The skill is unusable without this gate — its whole point is producing reviewer-grade audit output, not autonomously editing the tracker.

### 10. Apply approved writes

#### 10a. Post (or append to) the synthesis comment

Skipped in task mode. For initiative / feature / slice modes, check whether a `## Audit synthesis (<YYYY-MM-DD>)` comment dated today already exists on the audited spec:

```bash
today=$(date +%Y-%m-%d)
existing_id=$(gh api repos/<owner>/<repo>/issues/<N>/comments \
  --jq ".[] | select(.body | startswith(\"## Audit synthesis ($today)\")) | .id" | head -1)
```

- **No existing same-dated comment.** Create a new comment with the drafted body:

  ```bash
  gh issue comment <N> --body-file <tmp>
  ```

- **Existing same-dated comment.** Append today's new bullets to that comment's bullet list rather than creating a second same-dated comment. Fetch the existing body, splice the new bullets after the last existing bullet (preserving any trailing prose), and PATCH:

  ```bash
  gh api -X PATCH repos/<owner>/<repo>/issues/comments/$existing_id -f body="$updated"
  ```

Older dated comments are preserved verbatim — every audit run is additive and dated.

If the comment post or PATCH fails (network, auth), surface the error and continue with the rest of Step 10. The synthesis comment is the spec-level reader's view; the per-child writes still cover the executing agents.

Surface the resulting comment URL after a successful post or append.

#### 10b. Re-run dedupe — drop already-created new children (initiative and feature modes only)

Before creating any new child, dedupe against existing native sub-issues of `<N>` using the open-children data already fetched in Step 2 (no second tracker round-trip needed).

For each draft new child, check whether any open child from the Step 2 fetch carries the marker `**Surfaced by:** /audit run on <tier> #<N>` in its body AND covers the same uncovered-scope bundle (substance match against the bundled outcomes / stories — same actor + capability + benefit triples — not lexical title match).

- **Match found.** Skip the draft. Log a one-line note (`Skipping new child for <bundle summary> — already covered by existing audit-origin issue #<N>.`) and continue.
- **No match.** Proceed to create.

The audit-origin marker is the canonical dedupe anchor. Without it, re-running the audit would create duplicate children for the same uncovered scope every time.

#### 10c. Create approved new children and attach as native sub-issues

For each surviving (post-dedupe) draft, create the child issue and attach it:

```bash
new_url=$(gh issue create \
  --title "<drafted title>" \
  --body-file <tmp> \
  --label "size:<child-tier>" \
  --label "needs-triage")
new_number=$(echo "$new_url" | grep -oE '/[0-9]+$' | tr -d '/')
```

Then attach as a native sub-issue of `<N>` via the [Sub-issue attach helper](../decompose/SKILL.md#sub-issue-attach-helper) shared with `/decompose` — resolve the child's database ID and POST per the helper's call shape, and apply the helper's loud-failure semantics (log a single line `[sub-issue attach failed] #<new_number> → #<N>: <error>` and continue). Do not re-derive the call shape inline; the helper is the contract.

Surface each new issue URL to the user after creation.

#### 10d. Apply approved per-child body edits

For each affected child (or the audited task in task mode), fetch the current body, splice in the `## Audit findings (<YYYY-MM-DD>)` section per Step 8's insertion rules, and write the body back:

```bash
gh issue edit <child-N> --body-file <tmp>
```

Use `--body-file` rather than `--body` so multi-line bodies with backticks and dollar signs don't fight shell quoting.

If `gh issue edit` fails on an approved edit (network, auth), surface the error, skip that child, and continue. Do not retry, do not roll back already-applied edits.

#### 10e. Post approved upstream propagation comments (slice and task modes only)

For each approved sibling or parent comment from Step 7, run the drafted `gh issue comment` call. Surface the returned comment URL after each post.

If a comment post fails, surface the error verbatim, skip that comment, and continue with the rest. Do not retry, do not roll back already-posted comments or already-edited bodies.

### 11. End-of-run output

Print the canonical three-block template per [docs/agents/output-format.md](../../../docs/agents/output-format.md). Outcome line names the audited tier in plain English and summarises the run; URL block lists every durable artefact (synthesis comment, edited children, new children, upstream comments); next-step line points at the natural next move.

Shape:

```
Audited <tier> #<N>; <X> findings surfaced (<Y> applied, <Z> dropped). Codex leg: <ok|fell-through>.

- <synthesis comment URL> (when initiative / feature / slice mode)
- #<edited child N> body edited
- #<edited child N> body edited
- #<new child N> created
- #<upstream comment target N> commented (when slice / task mode propagated)

> Next step: `/<skill> [args]`. <one-sentence reason>.
```

Pick the next-step skill from the lifecycle loop:

- Findings remained and the maintainer needs to address them → `> Next step: resolve the findings above before continuing.` (no skill name).
- Initiative / feature mode created new children → `> Next step: /triage #<first-new-child-N>. Audit added new children that need sizing and routing.`
- Initiative / feature mode landed clean (or fully resolved) → `> Next step: /decompose <next-child-N>. Next iteration of the loop.`
- Slice mode landed clean → `> Next step: /execute #<first-open-task-N>. First open task on the audited slice.`
- Task mode landed clean → `> Next step: /execute #<N>. Audit found nothing tree-killing.`

## Failure modes

- **Codex errors / times out / can't authenticate.** Continue with single-agent (Agent A only) findings. The synthesis comment's preamble paragraph notes that the cross-check leg fell through, and every finding is provenance-tagged `claude` only. Do not halt on Codex failure — the Agent A sub-agent's output is still useful.
- **Codex's `## Findings` block is missing or malformed.** Same handling as Codex error — flag the leg as unparsable, treat it as if the cross-check fell through, continue with the other leg's findings. Surface the raw tail of `$CODEX_OUT` so the user can see what Codex produced.
- **Agent A's `## Findings` block is missing or malformed.** The Task sub-agent returned something other than a clean `## Findings` block (conversational text, a truncated result, an error). Re-dispatch the Agent A Task once with a sharper instruction to return only the verbatim block. If it still comes back malformed, abort and surface the bug; do not silently fall through to Codex-only output (the symmetry would mask a regression in `/check`). Agent A is the in-house leg — a persistent malformation signals a regression worth stopping on, unlike a Codex leg that merely fell through.
- **A child's body is irregularly shaped (no recognised insertion target).** Surface the issue and skip writes to that child. Continue with the remaining writes.
- **`gh issue create` fails on an approved new child.** Surface the error, skip that draft, continue with the rest. Note the skipped draft in the final summary so the user can manually retry.
- **`gh issue comment` (or PATCH on an existing same-dated comment) fails on the synthesis comment.** Surface the error and continue to the per-child edits and upstream comments. The per-child writes still cover the executing agents.
- **`gh issue edit` fails on an approved per-child body edit.** Surface the error, skip that child, continue with the rest. Do not retry, do not roll back already-applied edits.
- **`gh issue comment` fails on an approved upstream post.** Skip that comment and continue with the rest. Surface the error in the final summary so the user can manually retry.
- **Sub-issue attach fails on a created new child.** Log the single-line attach-failed message and continue. The child issue is already created; the parent linkage can be repaired by hand.
- **User rejects the approval gate.** Exit cleanly with no writes. The `$CODEX_OUT` tmpfile is cleaned up.

Every failure is loud (surfaced to the user) and non-fatal (the rest of the audit's writes still happen). The single exception is malformed Agent A output that persists after one re-dispatch, which aborts because it indicates a regression in the inner skill.

## Cleanup

The `$CODEX_OUT` tmpfile is best-effort cleaned up on skill exit (success or failure):

```bash
rm -f "$CODEX_OUT"
```

If the skill aborts mid-run, the file remains in `${TMPDIR:-/tmp}/` for forensic purposes — `mktemp -t "audit-codex-*"` makes the leftovers easy to find and delete manually.

## Hard rules

- **Approval gate is non-optional.** The skill never edits a body, creates an issue, or posts a comment without explicit user approval, even for nit-level findings. There is no auto-approve fast path.
- **Issue-body edits are additive and dated.** Per affected child (or the audited task), insert a single dated `## Audit findings (<YYYY-MM-DD>)` section above the first breakdown section. Same-day re-runs append to today's section; older dated sections are preserved verbatim. Never rewrite or restructure other parts of any body.
- **The audited spec's body is never edited.** The synthesis is posted as a comment on the spec — never inserted into the spec body. Spec body edits are `/decompose`'s and `/triage`'s purview.
- **Provenance is preserved everywhere.** Every artefact the synthesiser produces (chat output, per-child body edits, new child bodies, synthesis comment, upstream comments) tags each finding with `claude` / `codex` / `both`. Stripping provenance defeats the cross-check.
- **Backward-propagation bar is narrow.** Slice and task modes only. Schema changes, breaking API / type changes, sequencing reversals — and that's it. Anything broader spams sibling specs and parent specs with noise.
- **Re-runs are idempotent on new-child creation.** The `**Surfaced by:** /audit run on <tier> #<N>` marker is the canonical dedupe key against existing native sub-issues of `<N>`. Re-running on the same spec produces only new children that don't already exist; existing audit-origin children are skipped.
- **Re-runs append to today's synthesis comment.** Same-day re-runs append new bullets to today's existing dated comment rather than creating a second same-dated comment.
- **Codex sandbox is `workspace-write` with `sandbox_workspace_write.network_access=true`.** `/check` needs network for `gh issue view` / `gh issue list`. `read-only` blocks network in Codex and the leg falls through with `error connecting to api.github.com`; that's what the skill exists to catch via its single failure mode, not the desired steady state. The skill's read-only contract is what prevents writes, not the sandbox.
- **The Codex leg gets `gh` auth via `GH_TOKEN="$(gh auth token)"`, never the keychain.** A keychain-stored token (the `gh auth login` default on macOS) is unreachable inside the sandbox and the leg falls through with `HTTP 401: Requires authentication`. Resolve the token in the unsandboxed parent shell and pass it as an env var; never write it to disk or hardcode it.
- **`/check` remains independently invocable.** This skill orchestrates `/check`; it does not replace it. The single-agent path is faster and remains the default for cheap dry-runs.

## What this skill does NOT do

- It does not edit the audited spec's body, even when the audit decides the spec itself is wrong (`feature-itself-wrong` / `initiative-itself-wrong` classifications). Contradictions are flagged in the synthesis comment; the maintainer decides.
- It does not create new children at slice or task tier. Slice-level AC gaps are a `/decompose` re-decompose problem; tasks are leaves with no children.
- It does not run automatically from `/decompose`. The integration is a printed nudge in `/decompose`'s end-of-run line — a visible recommendation to run this skill, never an auto-invocation. Auto-running would couple decomposition to Codex availability and add wall-clock cost to every `/decompose` run.
- It does not auto-approve any finding, even nits. Every write is human-gated.
- It does not re-run automatically when a body changes — every audit is a deliberate user invocation.
- It does not drive `/execute` or `/decompose` afterward. The user picks up the next step.
