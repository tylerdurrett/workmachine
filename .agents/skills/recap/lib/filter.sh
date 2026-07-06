#!/usr/bin/env bash
# Filter predicate for /recap.
#
# Reads a recap data document from stdin and writes a filtered version to
# stdout. Pure transformation: deterministic, no network, no env reads,
# no side effects.
#
# Filter rules:
#   1. Drop any prsMerged or issuesClosed item labeled `cleanup` or
#      `wontfix`. `cleanup` items are bookkeeping noise; `wontfix` items
#      are scope cuts (the work was explicitly NOT done) and must not
#      appear in a "what shipped" recap as if they had landed.
#   2. Drop merge-only commits and pure branch-rename commits from
#      commits.sample. Their subjects start with "Merge " (merge commit)
#      or are exactly empty after trimming.
#   3. For past windows, drop `cleanup`-labeled items from
#      inProgressSlices (the closer source). `wontfix` slices wouldn't
#      be in the open-issue list anyway, but we drop them defensively.
#   4. For the `upcoming` window (different shape: openParents,
#      inProgressSlices, readyQueue instead of past-window arrays), drop
#      any item labeled `cleanup` or `wontfix` from each list.
#
# Note on signal/noise: an earlier version of this filter dropped PRs
# whose changed paths were entirely under skill/lifecycle directories
# (`.claude/skills/`, `.agents/skills/`, `docs/agents/`, `docs/adr/`).
# That rule was removed because the recap's audience includes teammates
# who care about workflow tooling time, not just product-surface change.
# Signal/noise discrimination for tooling work now happens in the prose
# composer per SKILL.md's voice rules (lead with user-facing change;
# include meaningful tooling work; roll up minor skill churn).
#
# This script is the place where filter rules accrete. Add a new rule by
# extending the jq program below.

set -euo pipefail

jq '
  # has_label: true if any label name matches the given string
  def has_label($name):
    (.labels // []) | any(. == $name);

  # is_noise_label: true if any label is `cleanup` or `wontfix`. Cleanup
  # is bookkeeping noise; wontfix is a scope cut (the work was explicitly
  # not done). Neither belongs in a "what shipped" recap.
  def is_noise_label:
    has_label("cleanup") or has_label("wontfix");

  # is_merge_or_rename: true if a commit is a merge commit or has an
  # empty subject after trimming (pure branch-rename / SHA-only refs).
  def is_merge_or_rename:
    ((.subject // "") | sub("^[[:space:]]+"; "") | sub("[[:space:]]+$"; "")) as $s
    | ($s == "") or ($s | startswith("Merge "));

  if .window == "upcoming" then
    .openParents       |= map(select(is_noise_label | not))
    | .inProgressSlices |= map(select(is_noise_label | not))
    | .readyQueue       |= map(select(is_noise_label | not))
  else
    .prsMerged    |= map(select(is_noise_label | not))
    | .issuesClosed |= map(select(is_noise_label | not))
    | .inProgressSlices |= ((. // []) | map(select(is_noise_label | not)))
    | .commits.sample |= (map(select(is_merge_or_rename | not)))
  end
'
