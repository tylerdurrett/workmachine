# End-of-run output format

What every workflow skill prints to the user when its run is complete. The format is deliberately tight and consistent so the maintainer can pick up the next step without re-reading prose.

## The three-block template

When a skill produces a durable artifact (a new issue, a posted comment, an opened PR, a body edit, a label transition, a branch push), end the run with three blocks in this order:

```
<one-sentence plain-English outcome>

- <durable artifact URL or ref>
- <additional artifact, if any>

> Next step: `/<skill> [args]`. <one-sentence reason>.
```

### Block 1: outcome

One sentence, plain English. State what changed in terms a non-developer could read.

Good:

- "Spec #182 published at feature size."
- "Slice 6 promoted onto the inbox feature's branch."
- "Filed two cleanup specs: #194, #195."

Avoid:

- "Successfully created..." filler.
- Conventional-commit prefixes (`feat(...)`).
- Branch names, commit SHAs, internal jargon. Those belong in block 2.
- Multi-sentence summaries. The diff and the artifact links carry the detail.

### Block 2: links

Bulleted URLs or refs to the artifacts that just changed. Skip the block (no leading blank line) when there's nothing durable to link to.

Examples:

```
- https://github.com/tylerdurrett/workmachine/issues/182
- https://github.com/tylerdurrett/workmachine/pull/45
- branch: feature/issue-12-inbox (pushed)
```

Concrete URLs over prose pointers. The reader should be able to click through without further navigation.

### Block 3: next step

A single quoted line. One skill command, one-sentence reason. The skill named here should be the natural next move in the workflow loop.

Format:

```
> Next step: `/<skill> [args]`. <one-sentence reason>.
```

If the skill genuinely terminates the chain (no follow-up applies), omit the block and write `Stop.` on its own line. Don't pad with filler recommendations.

## Skills that are exceptions to the template

These skills' entire output IS the report. They don't follow the three-block shape:

- **`/status`**: its own multi-section warm-prose report. Reads like a status update for a stakeholder; voice rules below still apply.
- **`/how-to-use`**: verbatim user manual. No closing remark.
- **`/triage`** in conversational mode (e.g. "show what needs attention"): prose-driven survey, ends with a recommendation embedded in the body.
- **`/grill-with-docs`**: interview format, ends when control returns to the user. No canonical wrap-up line.
- **`/check`**: terminal `## Findings` block is the structured artifact `/audit` parses. The conversational lead-up is the report; the Findings block is the contract.

`/audit` follows the three-block template — its durable artifacts (synthesis comment, edited child bodies, new children, upstream propagation comments) belong in the links block, with the outcome line summarising the run and the next-step line pointing at the natural next move.

Every other skill in the workflow loop follows the three-block template.

## Voice rules

These apply across the report shape AND the exception skills above. Each rule comes from a real failure mode in the prior style.

### Plain English over git/GitHub jargon

The reader is the maintainer, not a CI bot. Prefer:

- "shipped" / "landed" over "merged"
- "the feature" / "the work" over "the branch"
- "next up" over "next pending row"
- The feature/slice title in plain words over the kebab-case slug

PR numbers as parentheticals are fine: "(PR #45)".

### Lead with the thing being built

"You're shipping the inbox feature" beats "You're on `feature/issue-12-inbox`."

### No conventional-commit prefixes in user-facing prose

`feat(assets):` belongs in commit subjects, not in the outcome line of a skill report.

### Compress related artifacts

If the run produced five tiny things in the same bucket, write one line summarizing the bucket plus the URLs. Don't blast five repetitive bullets.

### Be specific

"Three sub-tasks: a server action to fetch projects, the tab body, and a reconnect banner" beats "Phase 2 work."

## Examples

### A `/decompose` run on a feature

```
Decomposed feature #82 into 4 slices (#83–#86), declared the feature integration branch.

- https://github.com/tylerdurrett/workmachine/issues/82
- branch declared: feature/issue-82-csv-export
- new slices: #83, #84, #85, #86

> Next step: `/triage #83`. First slice still needs sizing and a brief.
```

### A `/ship` run at the task tier

```
Shipped task #143 via PR #144. The export-pipeline slice now has 3 of 4 tasks landed.

- https://github.com/tylerdurrett/workmachine/pull/144
- on branch: slice/issue-83-export-pipeline
- task issue closed: #143

> Next step: `/execute #145`. Last open task on the same slice.
```

### A `/ship` run at the feature tier

```
Feature #82 shipped to production. Bulk CSV export is live.

- https://github.com/tylerdurrett/workmachine/pull/210 (promotion PR)
- feature issue closed: #82
- ticked row on initiative #50's progress comment

Stop.
```

The outcome line carries the moment-of-truth: "shipped to production" for feature-tier ships, "integrated onto the <feature> branch (intermediate; not user-visible yet)" for slice-tier ships.

### A `/defer` run with two filed specs

```
Filed two cleanup specs.

- https://github.com/tylerdurrett/workmachine/issues/194 (Centralize Postgres helpers in the shared package)
- https://github.com/tylerdurrett/workmachine/issues/195 (Consolidate storage-provider helpers)

Stop.
```

### A `/how-to-use` run

The whole user manual is printed verbatim. No outcome line, no links block, no next step.

### A `/status` run

Multi-section warm-prose report. The lead paragraph names active features and initiatives by title; "What to do next" gives one recommendation. No three-block template.

## Anti-patterns

- Padding the report with "Successfully completed..." or "Here is what I did..." preambles.
- Repeating the artifact URL in three different forms.
- Listing what the skill did NOT do. The user knows.
- Mixing the next-step recommendation into the outcome line. Keep block 3 separate.
- Hard-coded next steps that don't match the run's actual state ("now run /ship #<feature>" when no feature is ready to ship).
- Recommending a skill outside the lifecycle loop (e.g. `/diagnose`, `/improve-codebase-architecture`) as the "next step." Those are reached for directly by the maintainer, never as a workflow handoff.
