# ADR-0003 — Deterministic orchestrator over an event-sourced log

- **Date:** 2026-06-06
- **Status:** Accepted

## Context

The deprecated `workflow-engine` prototype was a *passive* planner: it
validated a `workflow.yaml`, compiled a DAG, projected it onto Hermes
Kanban as tasks + an embedded step contract, and then walked away.
Autonomous agents self-coordinated through tracker comments. Nothing
owned the closed loop, so deterministic script execution was never
built and gate decisions never made it back into the run manifest. Run
state lived in a mutable `run.yaml` snapshot with no real event history.

Work Machine needs a general runner that drives deterministic script
steps as well as agent steps, with a credible path to a durable runtime
(Temporal) later.

## Decision

The coordinator is an **active, deterministic orchestrator** separated
from execution by a hard **determinism boundary**, with state derived
from an append-only event log:

- **Orchestration is pure.** Deciding the next runnable step is a pure
  fold over `events.jsonl`. The orchestrator performs no I/O — no
  filesystem, network, clock, randomness, or LLM calls, not even a
  file-existence check. It decides only from facts already in the log.
- **Executors are the only side-effecting layer.** Running a script,
  spawning an agent, hashing a file, or checking a path happens inside
  an executor adapter and re-enters the system only as appended events.
- **The event log is canonical.** `events.jsonl` is the source of
  truth; `run.yaml` is a derived cache that can always be rebuilt by
  replaying the log.
- **Runs advance via `tick`.** A re-invokable CLI replays the log,
  decides, invokes one executor, appends events, and stops at the next
  gate. Commands like `/approve` arrive as events and wake the run.
  This is the local-first stand-in for a durable runtime; the same pure
  orchestration logic lifts into a Temporal workflow later without
  change, with executors becoming activities.

The prototype's agent-driven lifecycle — tracker-embedded step
contracts, agents self-coordinating through comments — is explicitly
not coming back.

## Consequences

**Positive:**

- Orchestration is unit-testable as a pure function of an event log.
- Crash recovery, audit, and replay come from event sourcing.
- The Temporal migration path stays open: orchestration → workflow,
  executors → activities, commands → signals, gates → durable waits.

**Costs:**

- Early ergonomic ceremony: facts the orchestrator needs (e.g. "the
  artifact exists, hash X") must be emitted as events by executors
  rather than checked inline. This discipline is cheap while the engine
  is small and the entire reason the model survives retries, crashes,
  and a future Temporal port.
