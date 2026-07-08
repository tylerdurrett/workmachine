---
name: update-skills
description: Pull skill updates from the tdog skills library (the source of truth) down into this consumer repo's .agents/skills/ copies. Use when the user says "update my skills", "pull skill updates", "sync skills from tdog", or suspects the library has moved ahead of this repo. Opposite direction of backport-skill.
---

# Update skills from the library

Skills under `.agents/skills/<name>/` are *copies* of the **tdog skills library** (`github.com/tylerdurrett/skills`). `backport-skill` pushes consumer edits up; this skill pulls library changes down. It only **updates skills the consumer already has** — never install skills the consumer lacks, even if the library has new ones (mention them in the report at most).

## 1. Resolve, verify, freshen the library

Resolve the library checkout and run the remote safety check exactly as described in [backport-skill](../backport-skill/SKILL.md) (env var → `.tdog-skills-path` → auto-discover; verify `origin` matches `github.com/tylerdurrett/skills`).

Then — **the local checkout is routinely stale; a diff against it lies**:

- `git -C <library> fetch origin`
- If the library tree is clean and `main` is strictly behind `origin/main`: `git merge --ff-only origin/main`.
- If the tree is dirty or `main` has diverged: **stop** and tell the user — reconciling the library is their call, not this skill's.

## 2. Classify drift per shared skill

For each directory in the consumer's `.agents/skills/` that also exists in `<library>/skills/`:

```bash
diff -rq -x node_modules .agents/skills/<name> <library>/skills/<name>
```

Identical → skip. For each **differing or library-only file**, determine direction with git, not eyeballs:

```bash
git -C <library> log --oneline --find-object=$(git hash-object <consumer-file>) -- skills/<name>/
```

- **Hit** (consumer's version exists in library history) → the library simply moved ahead → **clean pull**.
- **No hit** → the consumer has local edits → **do not overwrite**. Report it as a backport candidate (recommend `/backport-skill`) or, if the library *also* changed the same file, as diverged — needing hand-reconciliation. Never blind-copy over consumer-ahead content.
- **File exists only in the library** (new file inside an existing skill, e.g. a new template) → part of the pull; copy it, preserving the executable bit.

## 3. Pull

Copy each clean-pull file from `<library>/skills/<name>/` to `.agents/skills/<name>/`. The consumer mirrors `.agents/skills/` into `.claude/skills/` via symlinks, so edit only the `.agents/` copy. Note which library commits each pull corresponds to (`git -C <library> log --oneline -- skills/<name>/`) — they go in the commit message.

## 4. Adaptation pass — the judgment step

Read the actual diff of everything pulled. A verbatim pull can be subtly wrong for this consumer:

- **Dangling references** — incoming text that points at a skill, doc, or path this repo doesn't have (e.g. a pointer to a skill the consumer never installed). Flag it; drop or reword with the user rather than shipping a dead reference.
- **Implied follow-ons** — a pulled change may imply consumer-side work beyond the copy (e.g. a new hook template implies actually installing the hook into `.claude/`). **Surface these as recommendations; don't silently do them.**
- **Repo-specific assumptions** — anything in the incoming text that assumes a layout or convention this consumer doesn't follow.

## 5. Report + commit

Report per skill: **pulled** (with library SHAs), **backport candidate**, **diverged — reconcile by hand**, **skipped** (identical), plus any flagged adaptations and follow-ons. Commit the pulls to the consumer repo per its landing conventions (for skill/doc/config tweaks that's typically straight to `main`), citing the library commit SHAs so the two repos can be confirmed in sync.
