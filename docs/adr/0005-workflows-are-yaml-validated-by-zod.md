# ADR-0005 — Workflows are YAML, validated by Zod

- **Date:** 2026-06-06
- **Status:** Accepted

## Context

The engine is TypeScript, so workflows could be authored as type-safe TS
objects (a DSL). But two stated requirements pull the other way:
workflows must be **agent-authorable** and **portable/visualizable** (an
agent drafts them; a tracker may render them). A TS DSL couples workflow
authoring to the engine's language and runtime and makes both agent
authoring and over-the-wire portability harder.

## Decision

Workflows are declarative **YAML**, validated on load by a single **Zod**
schema that also yields the inferred TS types used throughout the engine.
This keeps authoring as plain data (easy for agents and humans, portable,
renderable) while giving compile-time types and one source of validation
truth — replacing the prototype's hand-rolled validation pass.

## Consequences

**Positive:**

- Agents and humans draft workflows as data, not code.
- One Zod schema is both the validator and the type source.

**Costs:**

- A TS contributor may expect typed-object workflows; the indirection
  (YAML → Zod → types) is deliberate, not an oversight.
