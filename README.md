# Work Machine

**Let your agents focus on the work, not the workflow.**

AI agents are great at real creative work — until the job gets big. A serious job (say, making a video) moves through a brief, a script, storyboards, a rough cut, polish, and a string of approvals. Teach an agent that whole process and it stops just *doing the work*: now it's also tracking where it is, remembering who approves what, deciding where files go, and trying not to skip a step. The creative task ends up sharing headspace with a pile of bookkeeping, and both suffer.

## The idea: thick engine, thin skill

Work Machine is built on one move: **separate the doing from the managing.**

The *managing* — what happens next, who approves it, where files live, making sure nothing gets skipped — is pulled out into a dependable engine that handles it the same way every time. The *doing* is handed to an agent (or a person, or a script) with a single, clean, focused task and none of the baggage.

We call it a **thick engine and a thin skill.** The engine is heavy, reliable, and boring on purpose. The skill is light: each worker shows up, does one well-defined thing it's genuinely good at, hands the result back, and never has to think about the workflow at all.

## What you get

- **More reliable work** — small, focused tasks mean better creative calls, and the engine guarantees the steps happen correctly and in order.
- **Your team can actually see it** — work lives in tools they already use (Trello, Slack, Frame.io), so they can follow along and review without learning anything new.
- **People, agents, and scripts are interchangeable** — any step can be an AI agent, a plain script, or a human, and the rest of the workflow doesn't notice.
- **Every decision is on the record** — approvals, feedback, and revisions are all captured in the tracker.
- **Many jobs at once, and much bigger ones** — with the mechanics handled by the engine, you can run lots of projects in parallel and take on far longer jobs than you'd attempt by hand.

For the fuller story — including a start-to-finish walkthrough of a real run — see [docs/explainer.md](docs/explainer.md).

## How it's built

Work Machine treats an issue/card tracker as the human surface, not the execution engine. The coordinator owns run state and valid transitions; tracker adapters project state outward and accept human commands like `/approve`.

### Current stance

Start small and concrete:

```text
workflow package
  -> lightweight coordinator / run state
  -> issue/card tracker adapter: GitHub Issues first
  -> local/cloud workers
  -> script + agent executor adapters
  -> artifact storage adapters
  -> human gates and notifications
```

GitHub Issues is the first repo-native tracker surface for development, but the architecture should remain tracker-adapter based so Trello or other card/issue surfaces can be swapped in later.

A serious run has more than a prompt or a card:

```text
workflow definition + coordinator state + tracker surface + executors + workers + artifacts + gates
```

The tracker is where humans see and command the work. The coordinator decides valid transitions. Workers execute steps. Artifact storage holds generated files and metadata.

### First vertical slice

The first build should prove one complete run, not every future adapter:

1. Load a tiny `workflow.yaml`.
2. Create a local run directory and event log.
3. Create a GitHub issue as the visible run surface.
4. Execute one local script step.
5. Record one artifact path/hash in an artifact index.
6. Update the issue with artifact links.
7. Open one human approval gate.
8. Accept `/approve` from the issue.
9. Complete the run.

## Docs

- [docs/explainer.md](docs/explainer.md) — accessible, benefit-first overview with a full run walkthrough.
- [CONTEXT.md](CONTEXT.md) — domain vocabulary and project glossary.
- [docs/charter.md](docs/charter.md) — mission, principles, scope, and non-goals.
- [docs/architecture.md](docs/architecture.md) — canonical system shape and core components.
- [docs/north-star.md](docs/north-star.md) — vision and direction.
- [docs/roadmap.md](docs/roadmap.md) — high-level build phases before work becomes issues.
- [docs/open-questions.md](docs/open-questions.md) — load-bearing decisions deferred past the first slice.
- [docs/research/README.md](docs/research/README.md) — background research and architecture exploration.
- [docs/agents/README.md](docs/agents/README.md) — agent workflow system used to develop this repo.
- [docs/adr/](docs/adr/) — accepted architecture decisions.

## Repo / vault boundary

This repo owns executable and code-adjacent truth: README, domain context, architecture docs, ADRs, examples, tests, implementation docs, and GitHub issues.

The Labs Obsidian vault keeps only the basic project gist, orientation links, and durable Labs-level decisions.
