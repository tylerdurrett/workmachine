---
name: recap
description: Produce a paste-ready, stakeholder-facing prose recap of recent project activity. Surveys the issue tracker and git history via read-only `gh` and `git` queries, filters infrastructure noise, and writes a short Markdown post the maintainer can paste into Slack. Use when the user says "recap today", "what shipped this week", "what's coming up", "give me a Slack update", or invokes `/recap`. Supports three windows: `today` (trailing 24 hours, default), `week` (trailing 7 days), and `upcoming` (forward-looking, no time bound).
---

# Recap

Write a short stakeholder-facing prose recap of what the team has done (`today`, `week`) or what the team is currently working on (`upcoming`).

This skill is read-only. It surveys the issue tracker and git history, filters out bookkeeping noise, and produces a paste-ready Markdown post. It does not commit, push, post anywhere, or mutate tracker state. The maintainer reads the output and decides what to do with it (typically: paste into Slack).

The audience is teammates and stakeholders, mostly non-technical, who want a sense of where the team's time and attention has been going. Many of them are also users of the product, so user-facing product change is the load-bearing content of any recap. But teammates also care about meaningful internal work — workflow rebuilds, tooling that changes how the team plans or ships, infrastructure that unblocks the next stretch — even when it doesn't show up in the product yet. Each sentence has to land on something a thoughtful non-technical teammate would care about reading: a product change they would notice, a meaningful shift in how the team operates, or an honest note about where the week's effort went.

## Hard rules

- **Read-only.** No `git commit`, `git push`, `gh issue close`, `gh pr edit`, `gh pr create`, `gh issue comment`, file deletions, or label edits. Use only read-shaped `gh` and `git` commands. The data-gathering helper enforces this; do not bypass it with ad-hoc mutating calls.
- **Length depends on window.** `today`: 3 to 6 sentences in a single short paragraph. `week`: 6 to 12 sentences, may break into 2 paragraphs when there are clearly distinct themes. `upcoming`: 3 to 6 sentences. No headers (no `##`, `###`), no horizontal rules, no frontmatter in any window. Bold is permitted for feature names.
- **Plain English over git/GitHub jargon.** See "Voice and tone" below — this is the most important rule.
- **Tie every user-meaning claim to a merged PR.** For past windows, only describe features whose corresponding PR is present in `prsMerged`. Do not bridge from a feature's `## User Stories` to "we shipped X" without a merged PR backing it. Feature user stories capture original intent; some stories get cut (the helper filters `wontfix` closures out of `issuesClosed`, but does not filter the source feature's user stories), some get deferred, and the recap is about what landed, not what the feature originally promised.
- **One window per invocation.** Recognized vocabulary: `today` (default), `week`, `upcoming`. The data-gathering helper errors on anything else; do not paper over the error in prose.
- **`--dry-run` short-circuits prose.** If the user passes `--dry-run` (anywhere in the args), run the data-gathering helper and print its JSON output verbatim to stdout. Do not write prose, do not paraphrase, do not add commentary. This is the debug seam — the maintainer is inspecting the data, not the prose.

## Voice and tone

The output is a short Slack-paste-ready post a stakeholder could read comfortably. Aim for warm, human, plainspoken — but to the point.

**Use "we" voice.** "We shipped..." / "We finished..." / "Today we...". Not "the team", not the project's name, not "the project". The recap is from the inside.

**Translate technical change into something a teammate would care about.** This is the central rule. For every candidate sentence, ask: *would a thoughtful non-technical teammate care about this if they read it over coffee?* If yes, write it as the thing they would care about. If no, drop it. Do not paraphrase mechanism into noise — silence is better than filler.

The translation rule has two flavors depending on what kind of change you're describing:

- For user-facing product change, translate mechanism into the experience the user would notice.
  - **Good:** "Switching between accounts now feels noticeably snappier on the first click."
  - **Bad:** "We added a warm-prelude pass to the account-switch server actions."
  - **Good:** "Long exports no longer cut off partway through."
  - **Bad:** "We fixed a race condition in the chunk-flush step of the export pipeline."

- For internal tooling and workflow change, translate mechanism into the shift in how the team operates or what it unblocks. Reserve this for work that meaningfully changes the day, not minor skill churn.
  - **Good:** "We reworked how we slice large bodies of work into trackable pieces, so big efforts plan and execute faster going forward."
  - **Bad:** "We rewrote /decompose to create native GitHub sub-issues."

**Lead with user-facing change, include meaningful tooling work.** Product change is the load-bearing content — when both kinds of work happened in the same window, lead with what users would notice and weave the tooling work in afterward. When a window was dominated by tooling work (no product change shipped), the tooling work earns the lead, but framed in team-language outcomes rather than skill names.

**Roll up minor skill churn.** A handful of small skill or workflow tweaks (typo fixes, label adjustments, status-line polishes) collapse into one summary sentence — "and a handful of polishes to how we triage and merge issues" — not a bullet-by-bullet list. Reserve dedicated sentences for tooling work that meaningfully changes the team's day.

**Avoid in the prose itself:**
- Em-dashes (`—`). Use commas, periods, or parentheses instead.
- Branch names (`feature/issue-<N>-<slug>`). Refer to the *thing* ("the recap work") instead.
- Commit SHAs of any length.
- Conventional-commit prefixes (`feat(scope):`, `fix:`, `chore:`). Rewrite the title in plain English.
- PR or issue numbers as primary objects ("PR #168 added X"). Numbers may appear as parenthetical references when truly necessary, but never as the subject of a sentence.
- Slug forms (`settings-panel`, `filter-bar`). Use plain words — "the settings panel", "the filter bar".
- Phrases like "merged to main", "rebased", "fast-forward", "integration branch", "feature branch", "sub-issue rollup", "ahead/behind".

**Do:**
- Lead with the *thing being delivered*, not the git state.
- Talk about features and what they do, not commits or PRs as objects.
- Prefer "shipped" / "landed" over "merged"; "the work" / "the feature" over "the branch"; "next up" over "next pending row".
- Be specific. "Three small polishes around the settings-panel layout" beats "some settings-panel improvements."

The skill instructs you to write fresh prose for each invocation based on what the data-gathering helper returns. Do not fill in a template.

## Magnitude calibration

**Past windows only (`today`, `week`).** The `upcoming` window is forward-looking and uses a different framing — see "Composing the upcoming window" below.

The window's lead phrasing has to match what actually happened. Pick one of four tiers, evaluated top-down — the first match wins. For `week`, evaluate the magnitude across the whole 7-day window, not the most recent day; a week is "headline" if a feature or initiative landed at any point in it.

- **Headline.** A `size:feature` issue closed with its promotion PR landing on `main` in the window, or a `size:initiative` issue closed manually in the window. The recap leads strongly: "Today we shipped **the [feature title]** — [one-sentence user-facing summary]." Reserve headline phrasing for this case only. Features that did not land on `main` (still open, or merged to a parent integration branch but not promoted) are not headlines.

- **Notable.** No feature/initiative ship, but a `size:slice` issue closed in the window, or 3+ individual closures landed, or a single closure is independently noteworthy (a long-standing bug fix, a user-visible polish that meaningfully improves a flow). Lead with a soft anchor: "The most useful change today...", "Today's biggest move...", "Today we polished...".

- **Ordinary.** Steady throughput (typically 4 to 12 commits) with several small closures, none rising to "notable". No lead phrase. Just describe what shipped: "Today we tightened up X, finished Y, and fixed Z."

- **Quiet.** 1 to 3 commits, no closures, mostly polish or cleanup. Acknowledge softly and honestly: "Today was a quiet day of polish." or "A steady, heads-down day." Do not oversell. Do not invent a narrative. If everything that happened was minor bookkeeping, say so plainly: "Today was small bookkeeping work, nothing meaningful to call out."

The magnitude rule is the trust anchor. Stakeholders learn to read the lead phrasing as a signal of actual significance. Headline phrasing on an ordinary day erodes that signal permanently.

## Throughput anchor

**Past windows only.** Past-window recaps include a commit count near the lead, as a sense of pace. Examples:

- "Today saw 12 commits go in across the project."
- "This week we pushed 47 commits, mostly around the settings panel."

On very quiet windows (1 to 2 commits) the count may be omitted in favor of pure description. On 3+ commits, include it. The `upcoming` window has no time bound and no commit count; do not invent one.

## Forward-looking closer

**Past windows only.** A past-window recap may end with a one-sentence "coming up" closer when there is a notable in-flight thing to mention. Examples:

- "Coming up: video script generation off the back of these recaps."
- "Next up: the in-app version of stakeholder updates."

**The closer must be sourced from `inProgressSlices` in the helper output**, not extrapolated from a closed feature's user stories. `inProgressSlices` is the list of open `size:slice` slices currently landing PRs — that is the only definition of "in flight" the recap recognizes. If you find yourself reaching into a feature's `## User Stories` to invent a closer, stop: those stories may have been cut, deferred, or never converted to real work. If `inProgressSlices` is empty, skip the closer entirely. Do not invent activity to fill the slot. The `upcoming` window is itself entirely forward-looking, so the closer concept does not apply to it.

## Composing the upcoming window

The `upcoming` window is forward-looking. The data does not represent what shipped; it represents what the team is currently working on or holding in queue. The voice rules ("we" voice, user-meaning translation, no em-dashes, no SHAs/branch names/conventional-commit prefixes/PR or issue numbers as primary objects) carry over unchanged. The magnitude tiers, throughput anchor, and forward-looking closer **do not apply** — they are past-window concerns.

The data-gathering helper produces three lists for `upcoming`:

- `openParents` — open `size:feature` and `size:initiative` issues, the named bodies of work the team has committed to. Each carries a `kind` field (`"feature"` or `"initiative"`), a `title`, and a `body` (which often contains a `## Solution` or `## User Stories` section that is the source-of-truth for stakeholder framing).
- `inProgressSlices` — standard `size:slice` issues with the `in-progress` label. Each has a `parentNumber` (the feature or initiative it belongs to) and a `childProgress` block (`closed` and `total` PRs already shipped vs. queued under the slice).
- `readyQueue` — open `ready-for-agent` issues. Some are children of in-progress slices, some are direct children of features, some are orphans. The label set distinguishes `size:task` from `size:slice`.

Frame the prose around what is in motion right now and what is queued next, in stakeholder language:

- Lead with the most active body of work — typically the feature or initiative with the most in-progress slices and the most progress on its children. If two are equally active, lead with whichever has more user-perceptible weight.
- Translate slice and queue items into user-meaning: a slice's `childProgress` ("3 of 5 PRs shipped") is a *progress signal*, but the prose should describe the *capability* the slice delivers, not the count.
- Mention the queue if it materially shapes what's next — "after that, we're set up to start on …". Skip the queue if it's empty or dominated by minor bookkeeping the translation rule would drop.
- Acknowledge quiet states honestly. If `openParents` is empty, that's a meaningful signal ("we don't have a big body of work in flight right now"); if everything is in early triage, say so plainly.

A good `upcoming` recap is 3 to 6 sentences. It reads as "here's what we're doing right now and what's queued next", not as a status dashboard.

## Output format

- **Markdown.** Paste-ready for Slack.
- **No `##` or `###` headers.** No horizontal rules. No frontmatter. No code blocks unless quoting actual content (rare).
- **Length per window.** `today`: 3 to 6 sentences in a single short paragraph; the optional forward-looking closer may stand as a second paragraph. `week`: 6 to 12 sentences; may break into 2 paragraphs when there are clearly distinct themes (for example, "early in the week we …; later in the week we …", or one paragraph per body of work). `upcoming`: 3 to 6 sentences, single paragraph.
- **Bold is permitted for feature names.** Use it sparingly and consistently — one or two bolded names at most.
- **PR / issue numbers as parenthetical references only**, when necessary. Never as the subject of a sentence.

## Step 1: Parse arguments

The user invokes `/recap` and optionally passes positional arguments and flags:

- `today` (positional, default when no arg given) — trailing 24 hours.
- `week` (positional) — trailing 7 days.
- `upcoming` (positional) — forward-looking; no time bound.
- `--dry-run` (flag, anywhere in args) — print the data-gathering helper's JSON output and exit. Do not write prose.

The data-gathering helper recognizes exactly that vocabulary and exits with a clear error on anything else (e.g. `/recap weak` or `/recap last-month`). When it errors, surface the error to the user verbatim and stop. Do not paper over the error by defaulting to `today`.

## Step 2: Run the data-gathering helper

From the repo root, invoke the helper with the chosen window:

```bash
bash .agents/skills/recap/lib/gather.sh <window>
```

Where `<window>` is `today`, `week`, or `upcoming`. The helper resolves the appropriate range (or skips ranges entirely for `upcoming`), runs read-only `gh` and `git` queries, applies the filter predicate at `lib/filter.sh`, and prints a JSON document.

The document shape branches on window:

**Past windows (`today`, `week`):**

```json
{
  "window": "today" | "week",
  "now": "<iso>",
  "range": { "start": "<iso>", "end": "<iso>" },
  "commits": { "count": <n>, "sample": [{ "shortSha": "...", "subject": "..." }] },
  "prsMerged": [
    { "number": <n>, "title": "...", "baseRefName": "...", "labels": [...], "changedPaths": [...], "body": "...", "mergedAt": "..." }
  ],
  "issuesClosed": [
    { "number": <n>, "title": "...", "labels": [...], "kind": "feature|initiative|slice|task", "body": "...", "closedAt": "..." }
  ],
  "featureContext": [
    { "number": <n>, "title": "...", "userStories": "..." }
  ],
  "inProgressSlices": [
    { "number": <n>, "title": "...", "labels": [...], "body": "...", "parentNumber": <n>, "childProgress": { "closed": <n>, "total": <n> } }
  ]
}
```

`inProgressSlices` is the source-of-truth for the optional forward-looking closer. The helper filters `cleanup`/`wontfix` items, and `prsMerged`/`issuesClosed` are scoped to "what shipped" (scope cuts are filtered out), so the prose composer can describe entries in those arrays as having landed without separately checking close-state.

**Forward-looking (`upcoming`):**

```json
{
  "window": "upcoming",
  "now": "<iso>",
  "openParents": [
    { "number": <n>, "title": "...", "labels": [...], "body": "...", "kind": "feature" | "initiative" }
  ],
  "inProgressSlices": [
    { "number": <n>, "title": "...", "labels": [...], "body": "...", "parentNumber": <n>, "childProgress": { "closed": <n>, "total": <n> } }
  ],
  "readyQueue": [
    { "number": <n>, "title": "...", "labels": [...], "body": "..." }
  ]
}
```

If the helper fails (network, auth, missing `gh`), surface the error to the user and stop. Do not invent a recap.

## Step 3: If `--dry-run`, print and stop

If the user passed `--dry-run`, print the helper's JSON output verbatim and stop. Do not write prose. Do not summarize. The maintainer is inspecting the data shape and the filter behavior, not the narrative.

## Step 4: Read the feature context (past windows only)

For past windows (`today`, `week`), the helper's `featureContext` field contains, for every feature or slice that closed in the window, the parent feature's `## User Stories` section. This is a **translation aid**, not a feature checklist.

If a feature or slice closed in the window, read its user stories *before* drafting the lead sentence. The user-meaning translation rule cannot be applied without this — without it you will fall back to paraphrasing PR titles, which is exactly the failure mode the rule exists to prevent.

**Bound how you use it.** A feature's user stories capture original intent at feature creation time. By the time the feature ships, some stories have been cut (closed `wontfix`, dropped from scope, or rolled into a future feature), and others have been deferred to a later body of work. Use the stories to find stakeholder-friendly language for capabilities that *did* land, by cross-referencing each candidate story against `prsMerged` (and only `prsMerged`). If a story has no matching merged PR, it did not ship in this window — do not describe it as if it had.

If `featureContext` is empty (no features or slices closed in the window), skip this step.

For the `upcoming` window, the source-of-truth is the `body` field on each `openParents` entry directly — read each parent's `## Solution` and `## User Stories` sections to ground stakeholder framing.

## Step 5: Compose the prose

Branch on `window`.

**For past windows (`today`, `week`):** walk the data top-down.

1. **Pick the magnitude tier** using the rule under "Magnitude calibration". The first match top-down wins.
2. **Draft the lead sentence** in the chosen tier's voice. For headline tier, name the feature or initiative and give a one-sentence user-facing summary drawn from `featureContext`. For notable, anchor on the most user-visible change. For ordinary, just describe. For quiet, acknowledge honestly.
3. **Add the throughput anchor** near the lead unless the window is very quiet (1 to 2 commits).
4. **Fill the body** with more sentences covering the other meaningful changes. For `today`, 1 to 4 body sentences. For `week`, 4 to 10 body sentences, optionally split across two paragraphs grouped by theme. Apply the translation rule ruthlessly — drop sentences that cannot land on something a teammate would care about, and roll up minor skill churn into a single summary sentence rather than enumerating it.
5. **Optionally add a forward-looking closer** if `inProgressSlices` contains a notable entry you can describe in plain English. The closer's source must be `inProgressSlices`, never a feature's user stories. Skip the closer if `inProgressSlices` is empty or dominated by minor skill churn that wouldn't earn its own sentence in the body.
6. **Re-read the prose against the voice rules.** Strip em-dashes, branch names, SHAs, conventional-commit prefixes, slug forms. If a PR or issue number appears as a primary object, rewrite the sentence. For each user-facing claim, verify there is a corresponding entry in `prsMerged` — if there isn't, drop or rewrite the sentence.

**For the `upcoming` window:** follow "Composing the upcoming window" above, then re-read against the voice rules in step 6 the same way.

## Step 6: Print the recap

The recap is the only thing the user sees. Do not preface it with "Here's the recap:" or summarize what you're about to write. Just print the prose.

If the data-gathering helper succeeded but produced an empty result, the right output is a single honest sentence and nothing more.

- For `today` / `week` with no commits and no closures: "Today was a quiet day, nothing meaningful to call out." or "This week was small bookkeeping work, no substantial changes to share." Do not pad.
- For `upcoming` with no open parents and an empty queue: "We don't have a major body of work in flight right now; the team is between bets." Do not invent activity to fill the slot.

## Verification

The skill's behavior is checked by hand against real activity, not automated tests. After any change to this skill:

- **Real-window smoke.** Invoke `/recap today`, `/recap week`, and `/recap upcoming` against current repo state. The prose for each is paste-ready (no headers, no horizontal rules), uses "we" voice, contains no em-dashes, and reads like a human team note. The `upcoming` recap reads as forward-looking, not as a status dashboard.
- **Argument grammar check.** Invoke `/recap nonsense` and confirm the helper exits with a clear error naming the supported windows. Invoke `/recap` (no arg) and confirm it produces the `today` recap.
- **Filter check.** Invoke `/recap today --dry-run`, `/recap week --dry-run`, and `/recap upcoming --dry-run` and verify that `cleanup`-labeled and `wontfix`-labeled items are absent from `prsMerged`/`issuesClosed`/`openParents`/`inProgressSlices`/`readyQueue`. For past windows, verify `inProgressSlices` is populated when there is in-flight work and is an empty array otherwise. Skill-only PRs are intentionally retained — signal/noise discrimination for tooling work happens in the prose composer per the voice rules, not in the filter. Run the filter directly with a fixture to confirm rules in isolation.
- **Closer source check.** When writing a past-window recap, every user-facing claim in the prose must trace back to an entry in `prsMerged`, and the optional "next up" closer must trace back to an entry in `inProgressSlices`. If you find yourself bridging from a feature's `## User Stories` to invent prose without a merged-PR (for body) or in-progress-slice (for closer) backing, stop. That is the failure mode the rule exists to prevent.
- **Magnitude check (past windows).** On a day where a feature or initiative landed on `main`, the recap leads in headline tier. On a day with steady mid-volume commits and no closures, the recap reads as ordinary. On a day with 1 to 2 commits, the recap is a quiet acknowledgment.
- **Read-only check.** Inspect `lib/gather.sh` to confirm only read-shaped `gh` and `git` commands appear. No `gh issue close`, `gh pr edit`, `gh issue comment`, `gh pr create`, `git commit`, `git push`, etc.

## What this skill does NOT do

- It does not post to Slack, GitHub, or anywhere else. Output is stdout only; the maintainer copies and pastes.
- It does not modify any state. No commits, pushes, label changes, issue closures.
- It does not persist anything between invocations. Every run re-queries from now using the chosen window.
- It does not support calendar-anchored windows (no `--this-week`, no `--since-monday`). All past windows are trailing-from-now.
- It does not run on a cron, react to webhooks, or schedule itself. The maintainer invokes it manually.
- It does not let you target a different repo. The helper relies on `gh`'s automatic repo resolution against whatever the current working directory's origin remote points at; run it from the repo you want to recap.
