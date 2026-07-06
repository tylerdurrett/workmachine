#!/usr/bin/env bash
# Data-gathering helper for /recap.
#
# Resolves the time window for the requested period, runs read-only `gh`
# and `git` queries, classifies issues by kind, gathers feature context
# for any closed features or slices, pipes the result through the filter
# predicate at lib/filter.sh, and prints the filtered JSON to stdout.
#
# Usage:
#   gather.sh [today|week|upcoming] [--dry-run]
#
# Windows: `today` (trailing 24h), `week` (trailing 7d), `upcoming`
# (forward-looking; no time bound, draws from open parents and the
# ready-for-agent queue). Defaults to `today` when no positional argument
# is given. Unknown positional arguments are a hard error so silent
# fallback can't hide a bug in an upstream caller. The `--dry-run` flag
# is accepted as a no-op so the SKILL.md prompt can pass it through; the
# helper output is identical with or without it (the prompt decides
# whether to invoke the agent on the result).
#
# Read-only by construction: only `gh` and `git` query commands appear
# below. No `commit`, `push`, `close`, `edit`, `comment`, `create`, or
# label-mutation calls.
#
# Linux GNU `date` is assumed for `-d "24 hours ago"`. macOS users would
# need to swap that line for `date -u -v-1d ...`.

set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly FILTER="$SCRIPT_DIR/filter.sh"

# --- Argument parsing ---
# Recognized vocabulary: today | week | upcoming, default today. Unknown
# positional arguments are a hard error: silent fallback masks bugs in
# upstream callers and confuses users running `/recap typoed-window`.
window=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) ;;
    today|week|upcoming)
      if [ -n "$window" ] && [ "$window" != "$arg" ]; then
        printf 'recap: conflicting windows "%s" and "%s"\n' "$window" "$arg" >&2
        exit 2
      fi
      window="$arg"
      ;;
    *)
      printf 'recap: unrecognized argument "%s"\n' "$arg" >&2
      printf 'recap: supported windows are today, week, upcoming\n' >&2
      exit 2
      ;;
  esac
done
[ -z "$window" ] && window="today"

# --- Window resolution ---
# Past windows resolve a trailing-from-now `range_start`; downstream
# `gh` and `git` queries are window-agnostic and just consume the range.
# `upcoming` is forward-looking and never reads `range_start`.
now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
case "$window" in
  week) range_start=$(date -u -d "7 days ago" +%Y-%m-%dT%H:%M:%SZ) ;;
  upcoming) range_start="" ;;
  *) range_start=$(date -u -d "24 hours ago" +%Y-%m-%dT%H:%M:%SZ) ;;
esac

# Shared scratch dir for `--slurpfile`-based JSON assembly (large blobs
# would trip ARG_MAX on `--argjson`).
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT

# --- Shared helpers (used by both past-window and upcoming branches) ---

# fetch_open_with_label: print open issues with the given label as a JSON
# array, normalizing labels to a string array.
fetch_open_with_label() {
  gh issue list --state open --label "$1" \
    --json number,title,body,labels --limit 100 \
    | jq 'map(.labels = (.labels | map(.name)))'
}

# fetch_in_progress_slices: print open `in-progress` issues that are
# standard `size:slice` slices (i.e. not features or initiatives, both of
# which also wear `in-progress` once `/decompose` runs), augmented with
# each slice's parent issue number and child PR progress
# (`closed`/`total`). The forward-looking closer (past windows) and the
# upcoming-window composition both consume this. Per-slice round-trips
# are acceptable because the number of in-progress slices is small
# (~0-5 at any time).
fetch_in_progress_slices() {
  local in_progress_all in_progress_slices_raw out='[]'
  in_progress_all=$(fetch_open_with_label "in-progress")
  in_progress_slices_raw=$(jq '
    map(select(.labels | any(. == "size:slice")))
    | sort_by(.number)
  ' <<<"$in_progress_all")
  while read -r slice; do
    [ -z "$slice" ] && continue
    local num subs total closed parent
    num=$(jq -r .number <<<"$slice")
    subs=$(gh api "repos/{owner}/{repo}/issues/$num/sub_issues" 2>/dev/null || echo '[]')
    total=$(jq 'length' <<<"$subs")
    closed=$(jq '[.[] | select(.state == "closed")] | length' <<<"$subs")
    parent=$(gh api "repos/{owner}/{repo}/issues/$num/parent" --jq .number 2>/dev/null || true)
    out=$(jq \
      --argjson slice "$slice" \
      --argjson total "$total" \
      --argjson closed "$closed" \
      --argjson parent "${parent:-null}" \
      '. + [$slice + {parentNumber: $parent, childProgress: {closed: $closed, total: $total}}]' \
      <<<"$out")
  done < <(jq -c '.[]' <<<"$in_progress_slices_raw")
  printf '%s' "$out"
}

# --- Upcoming branch ---
# `upcoming` is forward-looking: skip the past-window queries below and
# survey the project's open obligations instead. The output document has
# a different shape (no `range`, `commits`, `prsMerged`, `issuesClosed`,
# `featureContext`); the SKILL.md prompt branches on `window` to consume
# it.
if [ "$window" = "upcoming" ]; then
  features_raw=$(fetch_open_with_label "size:feature")
  initiatives_raw=$(fetch_open_with_label "size:initiative")
  open_parents=$(jq -s '
    add
    | map(. + {kind: (if (.labels | any(. == "size:initiative")) then "initiative" else "feature" end)})
    | sort_by(.number)
  ' <(printf '%s' "$features_raw") <(printf '%s' "$initiatives_raw"))

  in_progress_slices=$(fetch_in_progress_slices)

  ready_queue=$(fetch_open_with_label "ready-for-agent")

  printf '%s' "$open_parents" >"$tmp_dir/parents.json"
  printf '%s' "$in_progress_slices" >"$tmp_dir/slices.json"
  printf '%s' "$ready_queue" >"$tmp_dir/ready.json"

  unfiltered=$(jq -n \
    --arg window "$window" \
    --arg now "$now" \
    --slurpfile openParents "$tmp_dir/parents.json" \
    --slurpfile inProgressSlices "$tmp_dir/slices.json"  \
    --slurpfile readyQueue "$tmp_dir/ready.json" '
    {
      window: $window,
      now: $now,
      openParents: $openParents[0],
      inProgressSlices: $inProgressSlices[0],
      readyQueue: $readyQueue[0]
    }
  ')

  printf '%s\n' "$unfiltered" | bash "$FILTER"
  exit 0
fi

# --- Commits in window ---
# Throughput is measured against what shipped to `main`, not what's
# reachable from HEAD. Running this from a feature branch otherwise
# inflates the count with unmerged work-in-progress. Quiet fetch keeps
# the local ref fresh; failure (no network, no remote) is tolerated and
# the helper falls back to whatever ref exists.
git fetch origin main --quiet 2>/dev/null || true
commits_count=$(git log --oneline origin/main --since="$range_start" 2>/dev/null | wc -l | tr -d ' ')
commits_sample=$(
  git log origin/main --since="$range_start" --pretty=format:'%h%x09%s' --max-count=50 2>/dev/null \
    | jq -R -s '
        split("\n")
        | map(select(length > 0))
        | map(split("\t") | {shortSha: .[0], subject: (.[1] // "")})
      '
)

# --- PRs merged in window ---
prs_raw=$(
  gh pr list --state merged \
    --search "merged:>=$range_start" \
    --limit 200 \
    --json number,title,baseRefName,labels,mergedAt,body,files
)
prs_in_window=$(jq '
  map(
    .labels = (.labels | map(.name))
    | .changedPaths = (.files // [] | map(.path))
    | del(.files)
  )
' <<<"$prs_raw")

# --- Issues closed in window ---
issues_raw=$(
  gh issue list --state closed \
    --search "closed:>=$range_start" \
    --limit 200 \
    --json number,title,labels,body,closedAt
)
issues_in_window=$(jq '
  map(.labels = (.labels | map(.name)))
  | map(. + {
      kind: (
        if   (.labels | any(. == "size:initiative")) then "initiative"
        elif (.labels | any(. == "size:feature"))    then "feature"
        elif (.labels | any(. == "size:slice"))      then "slice"
        else                                              "task"
        end
      )
    })
' <<<"$issues_raw")

# --- Feature context ---
# Fetch User Stories for any feature closed in window, plus the parent
# feature of any slice closed in window (so the agent has authoritative
# source material for user-meaning translation). Parent lookup uses the
# native sub-issue parent endpoint, not body-grep, so it stays accurate
# even if the `## Parent` markdown convention drifts.

extract_user_stories() {
  awk '/^## User Stories/{flag=1; next} flag && /^## /{exit} flag{print}'
}

feature_context='[]'
seen=' '
add_feature_context() {
  local num="$1"
  case "$seen" in *" $num "*) return ;; esac
  seen="$seen$num "
  local data title body us
  data=$(gh issue view "$num" --json title,body 2>/dev/null) || return 0
  title=$(jq -r .title <<<"$data")
  body=$(jq -r .body <<<"$data")
  us=$(printf '%s\n' "$body" | extract_user_stories)
  feature_context=$(jq --argjson n "$num" --arg t "$title" --arg us "$us" \
    '. + [{number: $n, title: $t, userStories: $us}]' <<<"$feature_context")
}

for num in $(jq -r '.[] | select(.kind == "feature") | .number' <<<"$issues_in_window"); do
  add_feature_context "$num"
done

for num in $(jq -r '.[] | select(.kind == "slice") | .number' <<<"$issues_in_window"); do
  parent=$(gh api "repos/{owner}/{repo}/issues/$num/parent" --jq .number 2>/dev/null) || continue
  [ -n "$parent" ] && add_feature_context "$parent"
done

# --- In-progress slices (closer source) ---
# The optional forward-looking closer in past-window prose ("next up:
# ...") must be sourced from real open work, not extrapolated from a
# closed feature's user stories. Surface the same `inProgressSlices`
# shape the upcoming branch uses, scoped to whatever is in motion right
# now.
in_progress_slices=$(fetch_in_progress_slices)

# `$rangeEnd` (not `$end`) because `end` is a jq builtin and shadows it.
# Large blobs (PR bodies, issue bodies, full commit list) route through
# files via `--slurpfile` (set up at the top of the script) rather than
# `--argjson`, because a busy week's worth of PR bodies and changedPaths
# arrays trips the kernel's ARG_MAX limit when passed on the command
# line.
printf '%s' "$commits_sample" >"$tmp_dir/commits.json"
printf '%s' "$prs_in_window" >"$tmp_dir/prs.json"
printf '%s' "$issues_in_window" >"$tmp_dir/issues.json"
printf '%s' "$feature_context" >"$tmp_dir/feature.json"
printf '%s' "$in_progress_slices" >"$tmp_dir/inflight.json"

unfiltered=$(jq -n \
  --arg window "$window" \
  --arg now "$now" \
  --arg rangeStart "$range_start" \
  --arg rangeEnd "$now" \
  --argjson commitsCount "$commits_count" \
  --slurpfile commitsSample "$tmp_dir/commits.json" \
  --slurpfile prsMerged "$tmp_dir/prs.json" \
  --slurpfile issuesClosed "$tmp_dir/issues.json" \
  --slurpfile featureContext "$tmp_dir/feature.json" \
  --slurpfile inProgressSlices "$tmp_dir/inflight.json" '
  {
    window: $window,
    now: $now,
    range: { start: $rangeStart, "end": $rangeEnd },
    commits: { count: $commitsCount, sample: $commitsSample[0] },
    prsMerged: $prsMerged[0],
    issuesClosed: $issuesClosed[0],
    featureContext: $featureContext[0],
    inProgressSlices: $inProgressSlices[0]
  }
')

# --- Pipe through filter and emit ---
printf '%s\n' "$unfiltered" | bash "$FILTER"
