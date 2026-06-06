# ADR-0004 — Tracker projection is organized around gates, not steps

- **Date:** 2026-06-06
- **Status:** Accepted

## Context

How a run projects onto the tracker is the most load-bearing decision
for the human surface. The deprecated prototype created one Hermes
Kanban task **per step**, which scattered a run's story across many
low-level cards. The lesson taken from that prototype is narrower than
"per-step is wrong": the actual problem was the Kanban *UI*, which read
like something you program a system with rather than something a
teammate uses. Granularity was a secondary concern.

The competing defaults — one card per whole run, or one card per step —
each fail: per-run grows into one long noisy thread when feedback piles
up at every stage; per-step buries the run's narrative in fragments.

## Decision

The human surface is organized around **decisions, not steps**. A card
maps to a **gate** (review step):

- **Review card = one gated step.** It is the unit of human attention:
  it bundles the automatic steps since the previous gate as rolled-up
  context, surfaces the artifact(s) inline and clickable, and accepts
  the decision inline like a normal ticket.
- **Run card = the parent.** A bird's-eye projection of the whole run
  (graph, progress, links to review cards). A gateless run is just a
  run card with its final artifact.
- **Automatic steps get no card.** They appear as nodes in the run
  card's graph and as rolled-up detail inside the next review card.
- **A request-changes loop reuses the same review card** with a
  revision thread — one card per gate, not one card per attempt.

This is tracker-agnostic: parent/child expresses cleanly as GitHub
sub-issues, Trello linked cards, or Linear sub-issues.

The implementation is deferred to match the build-it-up approach: the
first slice ships a **single review card** (one script step + one
gate). The parent run card and multi-gate projection arrive in a later
slice once multi-gate workflows exist.

## Consequences

**Positive:**

- Feedback is segmented per review card; the run card stays a clean
  dashboard rather than an ever-growing thread.
- Each card feels like real human work, addressing the prototype's
  UI-driven "too low-level" complaint.

**Costs:**

- The projection must roll up automatic steps into review-card context
  and the run-card graph, which is more rendering logic than a naive
  one-card-per-step or one-card-per-run mapping.
