# Issue Labels

Issues are labeled along four orthogonal axes: **size** (what tier the work sits at), **state** (where it sits in the maintainer-review workflow), **lifecycle** (whether active work has begun), and **category** (what kind of work the issue represents). Most issues need a value on the first two; the third is set automatically by lifecycle skills; the fourth is optional and applied opportunistically.

## Vocabulary

The canonical hierarchy:

> roadmap → initiative → feature → slice → task → PR

Every issue on the tracker is a **spec** (the generic name for a captured set of specifications, regardless of tier). Sizing happens at triage. Bigger sizes decompose into smaller-sized children until everything reaches task-size, at which point it ships.

| Term       | Meaning                                                                                       |
| ---------- | --------------------------------------------------------------------------------------------- |
| Spec       | Any captured artifact published by `/to-spec`. The generic word; size is a separate axis.    |
| Initiative | A directed effort toward an outcome. Groups multiple features. Closes manually.               |
| Feature    | A meaningful unit of user-facing value. Decomposes into slices. Has an integration branch.    |
| Slice      | A vertical cut of a feature, demoable end-to-end. Always decomposes into multiple tasks.      |
| Task       | One PR's worth of work. Ships via `/execute` + `/ship`.                                 |

A slice can sit under a feature (typical) or be an orphan (ad-hoc multi-task work, not part of any feature). Same operational behavior either way.

## Size axis (`size:*`)

Indicates what tier the spec lives at. Assigned at triage; absence means triage hasn't sized it yet.

| Label             | Meaning                                                              |
| ----------------- | -------------------------------------------------------------------- |
| `size:initiative` | Multi-feature effort. Decomposes into `size:feature` children.       |
| `size:feature`    | Multi-slice feature. Decomposes into `size:slice` children. Has an integration branch. |
| `size:slice`      | Multi-task vertical cut. Decomposes into `size:task` children. Has an integration branch. |
| `size:task`       | One PR's worth of work. Does not decompose further.                  |
| *(none)*          | Drift. `/to-spec` always picks a size at publish; absence indicates a legacy or hand-created spec that `/triage` should size. |

A spec sized as `size:slice` always contains multiple tasks; a spec sized as `size:feature` always contains multiple slices; a spec sized as `size:initiative` always contains multiple features. If a candidate decomposition would yield exactly one child, the parent should have been sized one tier smaller. Right-sizing is iterative.

`size:initiative` and `size:feature` skip `ready-for-agent` direct execution: they decompose, they don't ship via `/execute`. `size:slice` decomposes but its decomposition can be agent-driven (`/decompose` produces task children). Only `size:task` passes through `ready-for-agent` to direct implementation via `/execute`.

## State axis

Where the spec sits in the triage workflow. The skills speak in terms of seven canonical states:

| Label              | Meaning                                                              |
| ------------------ | -------------------------------------------------------------------- |
| `needs-triage`     | Maintainer needs to evaluate this spec (size it, accept it, route it) |
| `needs-info`       | Waiting on reporter for more information                             |
| `needs-grilling`   | Spec exists but hasn't been deeply aligned via `/grill-with-docs`. Typical for children of an initiative decomposition. |
| `ready-for-agent`  | Fully specified, ready for an agent to pick up                       |
| `ready-for-human`  | Requires human implementation                                        |
| `deferred`         | Intentionally parked; revisit later (terminal-cousin to `wontfix`)   |
| `wontfix`          | Will not be actioned                                                 |

The seven labels are mutually exclusive. A spec carries exactly one until it transitions onto the lifecycle axis (or reaches a terminal state like `wontfix` and closes).

`needs-triage` lands on every spec published by `/to-spec`. `/triage` clears it when it does its bookkeeping pass (declares the integration branch for `size:feature` / `size:slice`, seeds the sticky progress comment for `size:initiative`, applies the next state label).

`needs-grilling` is the new state (relative to prior versions of this doc). It applies when a spec was synthesized from a parent's decomposition rather than grilled directly. Aggressive at the initiative→feature boundary (every fresh feature-sized child carries it), optional at feature→slice (depends on judgment), absent at slice→task (tasks are tiny enough that the slice's context covers them). Triage either runs `/grill-with-docs` against the spec (then drops the label) or judges grilling unnecessary (drops the label with a comment).

`deferred` differs from `wontfix` in that the issue stays open as a tracking ticket and is expected to come back into the queue eventually. The unparking move is `deferred` → `needs-triage`.

## Lifecycle axis

Tracks active work. Set automatically by lifecycle skills; do not edit manually unless cleaning up drift surfaced by `/triage` or `/status`.

| Label         | Meaning                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------- |
| `in-progress` | Active work has begun. On `size:initiative` / `size:feature` / `size:slice`: `/decompose` has produced children and PRs are landing. On `size:task`: `/execute` has opened a PR. |

Transitions:

- **`size:initiative`**: `(no state)` → `in-progress` (when first child feature is materialized) → closed (manual; initiatives close on `Definition of done` met, not on all-children-closed).
- **`size:feature`**: `(no state)` → `in-progress` (when `/decompose` runs) → closed (via `/ship` once all slices have shipped).
- **`size:slice`**: `ready-for-agent` → `in-progress` (when `/decompose` runs) → closed (via `/ship` once all tasks have shipped, or via `/ship` defensive close if absorbed elsewhere).
- **`size:task`**: `ready-for-agent` → `in-progress` (when `/execute` opens a PR) → closed (via `/ship`).

The lifecycle label and the state-axis labels are mutually exclusive: when `in-progress` goes on, the previous state label comes off in the same `gh issue edit` call. A spec carrying both `in-progress` and a state label is drift; `/triage` and `/status` will surface it.

## Category axis

Optional labels that describe what kind of work a spec represents, orthogonal to its triage state. Applied when useful for filtering or routing; absent on most specs.

| Label         | Meaning                                                                                       |
| ------------- | --------------------------------------------------------------------------------------------- |
| `bug`         | Something is broken. Typically applied to `size:task` and `size:slice` specs.                 |
| `enhancement` | New feature or improvement. Typically applied at any size.                                    |
| `cleanup`     | Refactor / dedup / housekeeping work surfaced during other tasks. Created by `/defer`. |

`cleanup` specs enter triage like any other (`needs-triage` first), but signal to the triager that the work is non-urgent housekeeping rather than user-facing change. `/triage cleanup` is a useful periodic sweep to keep the queue from rotting.

## Label inventory

All seven state-axis labels, the `in-progress` lifecycle label, the four `size:*` labels, and the three category labels live on `tylerdurrett/workmachine`. Edit the right-hand column above if labels are renamed.
