#!/usr/bin/env bash
#
# pr-merge-gate.sh — PreToolUse invariant gate for `gh pr merge` (matcher: Bash).
#
# WHY THIS EXISTS
#   In auto permission mode the harness safety classifier denies an agent
#   merging a PR it created without human review ("[Merge Without Review]").
#   That correctly blocks unauthorized merges, but it also blocks the ONE merge
#   /batch and /autopilot legitimately need: squash-merging a code-review-clean
#   task PR into a slice/feature *staging* integration branch. The aggregate
#   human review happens later, at the slice/feature promotion PR — which
#   automation opens review-first and NEVER merges.
#
# WHAT IT DOES
#   Rather than grant a blanket `gh pr merge` allow-rule (which would let any
#   agent merge anything, including into main), this hook makes the *capability*
#   narrow. It makes exactly two strong decisions and otherwise stays out of the
#   way (deferring to the normal permission flow / classifier):
#
#     * base is main/master ............................ DENY  (always; deterministic)
#     * task PR (head <type>/issue-N) -> slice/*|feature/*
#       staging branch, OPEN and not CONFLICTING ....... ALLOW (the automation path)
#     * anything else, or facts unresolvable ........... PASS  (emit no decision)
#
#   Because the allowed capability is "a clean task PR into a staging branch,"
#   caller identity is irrelevant to safety: main is protected no matter who
#   (or what) runs the command.
#
# LOGGING
#   Set PR_MERGE_GATE_LOG=/path/to/log to append decisions for debugging.
#   Unset (default) = no logging.

input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null)

# Engage only when `gh pr merge` is actually invoked (command start or right
# after a shell separator) — not when it merely appears inside a quoted string.
printf '%s' "$cmd" | grep -qE '(^|[;&|(])[[:space:]]*gh[[:space:]]+pr[[:space:]]+merge([[:space:]]|$)' || exit 0

log() { [ -n "${PR_MERGE_GATE_LOG:-}" ] && printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$1" >> "$PR_MERGE_GATE_LOG"; return 0; }
pass() { log "PASS: $1"; exit 0; }  # emit no decision — defer to normal flow
emit() { # $1 = allow|deny, $2 = reason
  log "DECISION=$1: $2"
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"%s","permissionDecisionReason":%s}}' \
    "$1" "$(printf '%s' "$2" | jq -Rs .)"
  exit 0
}

pr=$(printf '%s' "$cmd" | grep -oE '\bgh[[:space:]]+pr[[:space:]]+merge[[:space:]]+[0-9]+' | grep -oE '[0-9]+$' | head -1)
[ -z "$pr" ] && pass "no explicit PR number; deferring"

repo=$(printf '%s' "$cmd" | grep -oE '(-R|--repo)[[:space:]]+[^[:space:]]+' | awk '{print $2}' | head -1)
repoflag=""
[ -n "$repo" ] && repoflag="-R $repo"

meta=$(gh pr view "$pr" $repoflag --json baseRefName,headRefName,state,mergeable 2>/dev/null)
[ -z "$meta" ] && pass "could not resolve PR #$pr; deferring"

base=$(printf  '%s' "$meta" | jq -r '.baseRefName // ""')
head=$(printf  '%s' "$meta" | jq -r '.headRefName // ""')
state=$(printf '%s' "$meta" | jq -r '.state // ""')
mergeable=$(printf '%s' "$meta" | jq -r '.mergeable // ""')

# INVARIANT 1: automation may NEVER merge into main/master.
printf '%s' "$base" | grep -qiE '^(main|master)$' \
  && emit deny "merge gate: automation may NEVER merge PR #$pr into '$base'. Open a promotion PR for human review instead."

# INVARIANT 2: the sanctioned automation path — a task PR into a staging branch.
if printf '%s' "$base" | grep -qE '^(slice|feature)/' \
   && printf '%s' "$head" | grep -qE '^[a-z]+/issue-[0-9]+' \
   && [ "$state" = "OPEN" ] && [ "$mergeable" != "CONFLICTING" ]; then
  emit allow "merge gate: task PR #$pr ($head -> $base) into staging integration branch; allowed."
fi

# Anything else: no opinion — let the normal permission flow decide.
pass "PR #$pr ($head -> $base, state=$state) not a recognized task->staging merge; deferring"
