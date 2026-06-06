---
name: backport-skill
description: Port a skill tweak made here back to the original tdog skills repo (the source of truth), then commit/push it there.
---

# Backport a skill change

The skills in this repo under `.agents/skills/<name>/` are *consumer copies*. The source of truth is the **tdog skills library**, identified portably by its git remote:

```
github.com/tylerdurrett/skills
```

That remote is the invariant. The library's *local checkout path* varies per machine, so resolve it at runtime (below) rather than hardcoding it. Backports flow consumer → source.

## Resolve the library checkout

Try in order; stop at the first hit:

1. **`$TDOG_SKILLS_REPO`** env var, if set.
2. **`.tdog-skills-path`** — a gitignored file at this repo's root containing the absolute path on one line. (Already in `.gitignore`.)
3. **Auto-discover** — scan sibling directories (e.g. `../*`, `../../*/*`) for a git repo whose `origin` matches the known remote:
   ```bash
   git -C "<candidate>" remote get-url origin
   ```

**Safety check — run this on whatever path resolves, every time:** confirm the directory is a git repo whose `origin` matches `github.com/tylerdurrett/skills` (allowing `https`/`ssh`/`.git` variants). Never `git add`/`commit`/`push` against a path that fails this check — a stale pointer must not push to the wrong repo.

**Guardrail when nothing resolves (or the match fails):** stop. Tell the user it couldn't locate the library, ask for the absolute path, run the safety check on their answer, and offer to write it to `.tdog-skills-path` so this machine is set up once.

## Path mapping

Within the library, find the matching file by skill name; mind the doubled `skills/`:

```
.agents/skills/<name>/<file>   →   <library>/skills/<name>/<file>
```

`.claude/skills/` here is just symlinks into `.agents/skills/`, so you only ever edit one path on this side.

## Procedure

1. Identify the change to port (the commit or working-tree diff in this repo).
2. Resolve and verify the library checkout (above).
3. **Don't assume the two files are byte-identical.** Before applying, confirm the target's pre-change content matches what you edited here — grep the anchors / surrounding lines in the library file. If it has drifted, stop and reconcile by hand; do not blind-apply the same edits.
4. Apply the same edit to the mapped library file.
5. In the library repo: `git add` the file, commit (carry the same intent/rationale as the original), and `git push origin main`.
6. Report the library commit SHA so the two repos can be confirmed in sync.
