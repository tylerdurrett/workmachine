# Issue tracker: GitHub

Specs (initiatives, features, slices, tasks) for this repo all live as GitHub issues on `tylerdurrett/work-machine`. Use the `gh` CLI for all operations. `gh` resolves the repo automatically from `git remote -v` (the `origin` remote points at `tylerdurrett/work-machine`).

For the canonical hierarchy and label vocabulary, see [triage-labels.md](triage-labels.md). At a glance: roadmap → initiative → feature → slice → task → PR. Every issue is a "spec" of some size; size determines which decomposition step applies next.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Sub-issues

GitHub supports native sub-issue links between a parent issue and its children. When a skill creates an issue that has a parent (any larger-sized spec on the tracker), it attaches the child as a native sub-issue of the parent so:

- The parent's **Sub-issues** panel renders the child.
- The parent's auto-rollup count reflects open/closed state across children.
- The child surfaces in searches qualified by parent (see below).

Each child has at most one parent. GitHub enforces this server-side. Re-attaching an already-attached child returns 422 with a body like `"Issue may not contain duplicate sub-issues and Sub issue may only have one parent"`.

### Attach a child as a native sub-issue

The REST endpoint expects the child's database `id` (numeric), not its human-facing `number`. Resolve the `id` first, then POST. The full procedure (call shape, loud-failure semantics, and the one-parent constraint) lives as a [sub-issue attach helper](../../.agents/skills/decompose/SKILL.md#sub-issue-attach-helper) in the `/decompose` skill. Other skills that link a child to a parent should reuse that helper rather than re-deriving the API contract.

### Search by parent

GitHub indexes the parent relationship as a search qualifier:

```bash
gh issue list --search "parent-issue:tylerdurrett/work-machine#59"
```

This returns every child issue attached as a sub-issue of #59. Combine with `--state` filters as usual.

### When there is no parent

A skill that creates a top-level spec from a roadmap bullet (or from a freeform conversation that doesn't reference an existing parent) has no existing parent issue to attach to. In that case the skill skips the attach call entirely; there is nothing to link to. This is the documented no-parent path for orphan specs at any size.
