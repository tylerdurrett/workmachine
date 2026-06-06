# Work Machine

Work Machine is a repo-centered workflow system for coordinating human, agent, and script work through tracker-backed runs.

It treats an issue/card tracker as the human surface, not the execution engine. The coordinator owns run state and valid transitions; tracker adapters project state outward and accept human commands like `/approve`.

## Current stance

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

## Why this project exists

Workflows are not just prompts or cards. A serious run has:

```text
workflow definition + coordinator state + tracker surface + executors + workers + artifacts + gates
```

The tracker is where humans see and command the work. The coordinator decides valid transitions. Workers execute steps. Artifact storage holds generated files and metadata.

## First vertical slice

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
