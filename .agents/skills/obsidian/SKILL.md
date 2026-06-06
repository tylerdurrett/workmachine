---
name: obsidian
description: Read, search, create, and edit notes in the Obsidian labs vault.
---

# Obsidian Vault

Use this skill for filesystem-first Obsidian vault work: reading notes, listing notes, searching note files, creating notes, appending content, and adding wikilinks.

Work through your native file tools (read / list / search / create / edit) rather than shell commands wherever one fits. Native tools return structured results, avoid shell-quoting pitfalls, and handle paths with spaces cleanly. Fall back to the shell only when no file tool covers the operation.

## Resolve the vault path

The vault's checkout path varies per machine, so resolve it at runtime rather than assuming. Try in order; stop at the first hit:

1. **`$OBSIDIAN_VAULT_PATH`** env var, if set.
2. **`.obsidian-vault-path`** — a gitignored file at this repo's root containing the absolute vault path on one line.
3. **Fallback default** — `/Users/tylerdurrett/Documents/obsidian/labs/Labs`.

**Safety check — run this on whatever path resolves, every time:** confirm the directory exists and contains a `.obsidian/` folder, i.e. it is actually an Obsidian vault. Never create or edit notes under a path that fails this check — a stale pointer must not write into the wrong directory.

**Guardrail when nothing resolves (or the check fails):** stop. Tell the user the vault couldn't be located, ask for the absolute path, run the safety check on their answer, and offer to write it to `.obsidian-vault-path` so this machine is set up once.

File tools do not expand shell variables. Do not pass paths containing `$OBSIDIAN_VAULT_PATH` to file tools; resolve the path first and pass a concrete absolute path. If the path is still unknown, the shell is acceptable for resolving the env var or checking whether a candidate path exists — once the path is known, switch back to file tools.

## Read a note

Read the note by its resolved absolute path. Prefer your file-read tool over `cat` because it provides line numbers and pagination.

## List notes

List notes with your file-search/glob tool against the resolved vault path. Prefer this over `find` or `ls`.

- To list all markdown notes, match `*.md` under the vault path.
- To list a subfolder, search under that subfolder's absolute path.

## Search

Use your search tools for both filename and content searches. Prefer them over `grep`, `find`, or `ls`.

- For filenames, match a filename pattern under the vault path.
- For note contents, search with a content regex and restrict to `*.md` when you want only markdown notes.

## Create a note

Create the note by writing its full markdown content to the resolved absolute path. Prefer your file-write tool over shell heredocs or `echo`: it avoids shell quoting issues and returns structured results.

## Append to a note

Prefer a native file-tool workflow when it is not awkward:

- Read the target note first.
- Use a targeted edit for an anchored append when there is stable context, such as adding a section after an existing heading or appending before a known trailing block.
- Rewrite the whole note when that is clearer than constructing a fragile edit.

For an anchored append, replace the anchor with the anchor plus the new content.

For a simple append with no stable context, the shell is acceptable if it is the clearest safe option.

## Targeted edits

Use a targeted edit for focused note changes when the current content gives you stable surrounding context. Prefer this over shell text rewriting.

## Wikilinks

Obsidian links notes with `[[Note Name]]` syntax. When creating notes, use these to link related content.
