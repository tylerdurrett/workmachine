# Issue tracker: Local Markdown

Specs (initiatives, features, slices, tasks) for this repo live as markdown files under `.scratch/`. This is the offline alternative to the GitHub-backed tracker; pick it when there's no remote, when you're working on a one-person prototype, or when you want everything to live in-repo.

For the canonical hierarchy and label vocabulary, see [triage-labels.md](triage-labels.md). At a glance: initiative → feature → slice → task → PR. Every file is a "spec" of some size; size determines which decomposition step applies next.

> **Heads-up.** The workflow skills (`/triage`, `/decompose`, `/execute`, `/ship`, `/defer`, `/status`, etc.) are currently written against the GitHub tracker — they shell out to `gh issue *`. Picking local-markdown means the spec files exist and this doc describes the shape, but those skills will refuse or no-op until they grow a local-markdown code path. Treat this variant as the file convention; expect to patch the consumer skills before they work end-to-end. The convention below is what they will read once patched.

## File layout

```
.scratch/
├── 0001-<slug>.md         ← one spec per file, zero-padded numbering
├── 0002-<slug>.md
└── ...
```

One flat directory keyed by spec number. Numbers are assigned at publish time by `/to-spec` (the highest existing number plus one). Slugs are kebab-case, 3 words or fewer, derived from the title.

## Spec file shape

```markdown
---
title: Short human title here
size: feature                            # initiative | feature | slice | task
state: needs-triage                      # see triage-labels.md
lifecycle:                               # in-progress when active work has begun; empty otherwise
category: enhancement                    # bug | enhancement | cleanup; optional
part-of:                                 # parent spec number, e.g. 0042; empty for orphans
integration-branch:                      # feature/issue-<N>-<slug> or slice/issue-<N>-<slug>; declared by /triage
---

## Outcome
…

## Problem
…

## Acceptance criteria
…

## Comments

### YYYY-MM-DD HH:MM — <author>

…
```

The frontmatter keys carry the same load as the label axes on GitHub: `size`, `state`, `lifecycle`, `category`. Empty values mean "not applicable yet" (e.g. fresh task specs have no `lifecycle` until `/execute` opens its PR).

## Conventions

- **Create a spec**: write a new file under `.scratch/`. Pick the next free four-digit number; pick a slug.
- **Read a spec**: read the file directly. The file path or the bare number both work as a reference (`0042` ≡ `.scratch/0042-<anything>.md`).
- **List specs**: shell out to `grep`/`rg` over the frontmatter, e.g. `rg -l "^state: needs-triage" .scratch/`.
- **Apply / change labels**: edit the frontmatter line in-place. Multi-axis transitions in one edit (drop `state: needs-triage`, set `lifecycle: in-progress`) preserve invariants.
- **Comment**: append a `### YYYY-MM-DD HH:MM — <author>` block under `## Comments` at the bottom of the file. Don't edit older comments.
- **Close**: append a closing comment, then set `state:` to a terminal value (`wontfix`) or move the file to `.scratch/closed/` if you prefer a two-zone layout. The skills should accept either.

## When a skill says "publish to the issue tracker"

Create a new file under `.scratch/` with the shape above.

## When a skill says "fetch the relevant ticket"

Read the file at `.scratch/<NNNN>-*.md`. Globbing the number is enough; the slug doesn't need to be passed in.

## Sub-issues (parent relationships)

The `part-of:` frontmatter field is the parent link. Each spec has at most one parent. Setting `part-of: 0042` makes this spec a child of `.scratch/0042-*.md`. To find a spec's children, grep the directory: `rg -l "^part-of: 0042$" .scratch/`.

There is no separate "sub-issue attach" call — setting the frontmatter is the attach. The auto-rollup that GitHub's sub-issue panel renders is a `rg`-driven count when needed (see `/status`).

## When there is no parent

A top-level spec (a freeform initiative, or an orphan ad-hoc slice/task) sets `part-of:` to empty. This is the documented no-parent path; downstream walks (`/execute`'s parent-chain walk per [ADR-0001](../adr/0001-issues-branch-from-parent-integration-branch.md)) terminate at `main` as the fallback base branch.
