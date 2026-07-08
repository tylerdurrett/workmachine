# Initiative lifecycle

How `size:initiative` parent specs move through the tracker. Initiatives differ from features and slices in two load-bearing ways: they have **no integration branch**, and they **close manually** rather than via `/ship`.

For label semantics, see [triage-labels.md](triage-labels.md). For tracker mechanics, see [issue-tracker.md](issue-tracker.md).

## What an initiative is

A `size:initiative` GitHub issue is a parent spec that groups related features under a shared outcome. Each initiative's body is its own goal/purpose document; its sub-issues are the features that contribute to that purpose. Initiatives are captured via `/to-spec` from conversation context, then sized as `size:initiative` at triage.

Initiatives sit one level above features in the planning hierarchy:

```
initiative (size:initiative GitHub issue)
  └── feature (size:feature GitHub issue)
       └── slice (size:slice GitHub issue)
            └── task (size:task GitHub issue)
                 └── PR
```

Concurrent initiatives are normal. Two unrelated bodies of work (e.g. a billing-rewrite initiative and a docs-system initiative) can run in parallel without conflict; they share no state.

## Lifecycle states

Initiatives use the `in-progress` lifecycle label and a closed terminal state. The standard state machine (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`) does not apply to initiatives directly: they are parent specs that decompose, not implementations.

| State              | Set by                              | Meaning                                                                                                  |
| ------------------ | ----------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `needs-triage`     | `/to-spec` (publish)                | Initiative was just published. Awaits `/triage`'s bookkeeping pass to seed the sticky progress comment.  |
| *(no state label)* | `/triage` (after bookkeeping)       | Initiative is fully functional and ready to accept materialization. Sized, sticky comment seeded.        |
| `in-progress`      | `/decompose` (first child feature)  | First child feature has been attached. Decomposition has begun.                                          |
| *(closed)*         | maintainer (manual)                 | Initiative's purpose is met. The user closes the issue by hand.                                          |

Transitions:

- `needs-triage` → `(no state label)` happens when `/triage` runs its bookkeeping pass against the freshly-published initiative (seeds the sticky progress comment, confirms the size, clears the label).
- `(no state label)` → `in-progress` happens automatically the first time a feature is materialized into the initiative via `/decompose <I>` or via `/to-spec` against a conversation that names the initiative as parent.
- `in-progress` → closed is a deliberately manual step. There is no "all child features closed → close initiative" automation; see [Manual closure](#manual-closure) below.
- An initiative can sit in the no-state-label phase indefinitely. While the body's Candidate features section may evolve in that state, the lifecycle label only flips when a real linked feature appears.

## No integration branch

Initiatives have **no integration branch**. Feature integration branches (`feature/issue-<F>-<slug>`) remain the integration unit one level down; initiatives span too long for a single integration branch to be useful. `/to-spec` does not write an `**Integration Branch:**` field into an initiative-sized spec, and downstream skills do not look for one.

This is the load-bearing difference between initiatives and features as parent specs. Each feature under an initiative still gets its own integration branch the normal way (declared by `/decompose` when the feature is first decomposed into slices); those are independent of the initiative.

## The `<!-- progress-comment:initiative -->` marker

Initiatives carry a single sticky comment seeded by `/triage` (when it confirms the spec is sized as initiative during its bookkeeping pass) whose first line is the literal HTML marker:

```
<!-- progress-comment:initiative -->
```

The marker is a unique string so grep-style detection in lifecycle skills is unambiguous.

The seeded body for a fresh initiative is:

```
<!-- progress-comment:initiative -->
## Child features

_(none yet — populated as features are attached via `/to-spec` or `/decompose`)_
```

As features attach, the placeholder is replaced with `- [ ] #<F> — <title>` task-list rows, one per feature, in attachment order. `/ship` (at the feature tier) ticks rows by exact `#<F>` match when a child feature closes.

The sticky comment is **the canonical record of materialized work**. The initiative body lists un-materialized intent (Candidate features); the sticky comment lists materialized features as linked task-list rows.

## Two-phase authoring (intent → materialization)

Initiative authoring is deliberately two-phase. This is the load-bearing pattern that lets an initiative exist as a thinking surface before any features do.

**Phase 1, intent.** `/to-spec` publishes the initiative with:

- Body sections: Outcome, Problem, Definition of done, Out of scope, Candidate features.
- Candidate features is a one-line bullet list, no issue links: sketches of features the author imagines will exist.
- `size:initiative` and `needs-triage` labels.

`/triage` then runs the bookkeeping pass: it confirms the size, seeds the sticky `<!-- progress-comment:initiative -->` comment with the placeholder line, and clears `needs-triage`. At that point the initiative is fully functional on the tracker, has zero linked features, and is ready to accept materialization. The Candidate features section is enough to have a real conversation about whether the initiative is shaped right.

**Phase 2, materialization.** As each candidate becomes a real feature via `/to-spec` (with an inferred or recommended initiative parent) or via `/decompose <I>`:

- The matching candidate bullet is removed from the initiative body.
- The new feature is added to the sticky progress comment as `- [ ] #<F> — <title>`.
- On the first such transition, the initiative gains the `in-progress` lifecycle label.

The transition is gradual and one-way at the per-feature granularity, not a global label flip. An initiative can sit in a mixed state indefinitely (some features materialized, others still bullets) and that is normal.

The narrative sections (Outcome / Problem / Definition of done / Out of scope) are the durable part of the artifact. Candidate features is intentionally a lightweight, dynamic list that drains over time.

### Discipline: outcome, not enumerated features

An initiative without real features underneath is structurally vulnerable to becoming a wishlist masquerading as a strategic frame. The forcing function against this is the body template itself: the narrative sections feel weighty; Candidate features feels disposable.

Watch for these drift signals:

- Candidate features section is **growing** rather than draining.
- Candidate bullets acquire sub-bullets, prose, or implementation detail.
- The Out of scope section is empty (suggests the author hasn't done the work of saying no to anything).

When any of these fire, the initiative is bloating into a mini-feature. Pull back: split the initiative, narrow it, or defer items as hypothetical work.

## Manual closure

Initiatives close manually when their purpose is met. There is intentionally **no** automation that closes an initiative when all of its child features have closed; that heuristic would close initiatives prematurely.

An initiative may legitimately:

- Outlive its first batch of features (e.g. the Definition of done isn't satisfied yet, even though the materialized features have all shipped).
- Pause indefinitely (e.g. priorities shift; the Definition of done is still the right target but not now).
- Close with open candidate bullets still in the body (e.g. the maintainer decides those candidates don't need to ship to call the initiative done).

Closing an initiative is a deliberate user action: edit the issue, drop the `in-progress` label, close with a comment summarizing the outcome. No skill performs this transition automatically.

This is the same discipline the feature ecosystem applies one level down (`/ship` at the feature tier is invoked by the user, never automatically). Escalated further at the initiative layer because an initiative spans more time and more variability than a single feature.

## What the related skills do

| Skill              | Touches the initiative by…                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| `/to-spec`         | Publishes the initiative with `size:initiative` + `needs-triage`, infers and attaches a parent if the conversation supplies one, prints the URL plus a one-line nudge pointing at `/triage` as the recommended next step. |
| `/triage`          | Verifies `size:initiative` (may change it), seeds the sticky progress comment, clears `needs-triage`, applies the next state label, may apply `needs-grilling` when the spec was synthesized rather than grilled. Does not recommend `ready-for-agent`. |
| `/decompose <I>`   | Materializes child features under the initiative. Removes matching candidate bullets from the body, adds rows to the sticky comment, flips to `in-progress` on first attach. |
| `/ship` (feature)  | Ticks the matching `- [ ] #<F>` row in the parent initiative's sticky comment when a child feature closes.  |
| `/status`          | Surfaces active initiatives (`size:initiative` + `in-progress`) by name in the lead paragraph alongside active features. |

This doc tracks the initiative-level conventions only. The skill-side details (call shapes, idempotency, failure semantics) live in each skill's `SKILL.md`.
