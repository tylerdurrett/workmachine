# Work Machine Architecture

Canonical system shape. The decisions behind it live in the ADRs
referenced inline; vocabulary lives in [CONTEXT.md](../CONTEXT.md). This
doc describes *what* the system is, not the phase order (see
[roadmap.md](roadmap.md)) and not decomposed work (GitHub issues).

## Thesis

Work Machine is an **active, deterministic orchestrator** that drives
runs forward, with execution and surfaces delegated to adapters. It is
local-first and single-coordinator to start, with seams kept compatible
with a durable runtime (Temporal) later. The tracker (GitHub Issues
first) is a projection and command surface, never the engine.

```text
workflow package (YAML, Zod-validated)
  -> orchestrator: decide(events) — a pure fold over the event log
  -> executor adapters: script | agent | human | noop  (the only side effects)
  -> tracker adapter: projection + command inbox (GitHub Issues first)
  -> artifact storage: local filesystem first, R2/S3 when media arrives
```

## The determinism boundary (ADR-0003)

The load-bearing rule: **orchestration is pure; execution is where all
side effects live.**

- `decide(events) -> Decision` is a pure function. It performs no I/O —
  no filesystem, network, clock, randomness, or LLM calls, not even a
  file-existence check. It decides only from facts already in the log.
- **Executor adapters** are the only place side effects happen (run a
  script, spawn an agent, hash a file, check a path). Their results
  re-enter the system only as appended events.
- This is the local-first equivalent of a Temporal workflow (the pure
  orchestration) plus activities (the executors). The same `decide`
  logic lifts into Temporal later without change.

## Core components

### Workflow package

Declarative, committed source. A `workflow.yaml` validated on load by a
single Zod schema that also yields the engine's inferred TS types
(ADR-0005). Shape:

```yaml
name: tiny-smoke
version: 0.1.0
inputs:
  topic: { type: string, required: true }
artifacts:
  note: { path: note.md, description: A one-line note. }
steps:
  - id: write_note
    title: Write the note
    produces: [note]
    executor:
      type: script
      command: "scripts/write-note.sh {{inputs.topic}} {{artifacts.note.path}}"
    gate:
      type: human_review
      decisions: [approve, request_changes, reject]
```

Steps declare explicit `consumes` / `produces` artifact contracts so the
orchestrator can decide readiness from declared facts rather than
scanning the filesystem (which the determinism boundary forbids). A step
that carries a `gate` is a **review step**. Interpolation uses
double-brace `{{...}}` to avoid clashing with shell brace-expansion.

### Orchestrator and the `tick` loop

The orchestrator is the pure brain. The **`tick`** loop is the thin
impure harness wrapped around it — the only thing that reads, writes, and
executes:

```text
tick:
  events   = read(events.jsonl)
  decision = decide(events)              # PURE
  run step X  -> append step_dispatched; result = executor.run(X); append step_succeeded|failed
  open gate   -> append gate_opened; stop
  wait        -> stop                     # nothing runnable; awaiting a command
  done        -> append run_completed; stop
```

`tick` is re-invokable (manual first, scheduled/daemon later). Commands
like `/approve` arrive as events and wake the run on the next tick.

### Event log and run state

The append-only `events.jsonl` is canonical; everything else is derived.

```text
runs/<run_id>/
  events.jsonl           # canonical, append-only — source of truth
  run.yaml               # derived cache, rebuildable by folding events
  workflow.snapshot.yaml # exact workflow version used for this run
  artifacts/             # produced artifacts (local fs first)
  .cursor.json           # non-canonical harness bookkeeping: tracker poll cursor + ETag
```

Inputs (in `run_created`) and the issue ref (in `card_created`) are
*events*. The poll cursor is the lone sidecar — it tracks tracker
comments that aren't commands, so it can't be derived from events.

#### Event taxonomy (first slice)

| Event | Emitted when | Carries |
|---|---|---|
| `run_created` | `run create` | run_id, workflow name/version, snapshot ref, inputs |
| `card_created` | tracker card made | card ref |
| `step_dispatched` | harness begins a step | step_id |
| `step_succeeded` | executor returns OK | step_id, produced artifacts `[{id, path, sha256, size}]` |
| `step_failed` | executor errors | step_id, error |
| `gate_opened` | `decide` reaches a review step | gate_id (=step_id), artifacts under review |
| `command_received` | raw tracker command arrives | gate_id, decision, actor, source |
| `gate_decided` | `decide` validates the command | gate_id, decision (canonical outcome) |
| `run_completed` / `run_failed` | terminal | — |

`step_dispatched` is recorded *before* execution so a crash leaves a
dangling dispatch with no terminal event — the signal to retry
(idempotently). Commands are two events: the raw `command_received`
(audit) and, only after a pure validation check, the canonical
`gate_decided` — the concrete teeth behind "an unvalidated tracker
comment is not truth."

#### Step lifecycle (derived by folding events)

```text
pending → dispatched → succeeded → (if gate) awaiting_review → approved | changes_requested | rejected
                    ↘ failed
changes_requested loops back to pending; the re-run reuses the same review card.
```

### Executor adapters

The orchestrator never talks to executors; the harness does, behind one
tiny seam:

```ts
interface Executor {
  run(step: ResolvedStep, ctx: RunContext): Promise<ExecutorResult>
}
type ExecutorResult =
  | { ok: true;  artifacts: ProducedArtifact[] }   // -> step_succeeded
  | { ok: false; error: string }                   // -> step_failed
```

An executor's only outputs are artifacts + ok/fail. It never reads the
log, never touches the tracker, never decides what's next. Types:
`script` (first), then `agent` (see [open-questions.md](open-questions.md)
§1), `human`, `noop`.

### Tracker adapter (ADR-0004)

GitHub Issues first. The human surface is organized around **decisions,
not steps**:

- **Review card** — one per gate. The unit of human attention: bundles
  the automatic steps since the previous gate, surfaces artifacts inline,
  accepts the decision inline like a normal ticket. A request-changes
  loop reuses the same card with a revision thread.
- **Run card** — the parent: graph, progress, links to review cards. A
  gateless run is just a run card with its final artifact. (Deferred —
  the first slice ships a single review card.)
- Automatic steps get no card; they roll up into the next review card and
  the run-card graph.

Adapter surface:

```ts
interface TrackerAdapter {
  createRunCard(run): Promise<CardRef>                     // intake
  renderReviewCard(card, state, artifacts): Promise<void>  // projection
  readCommands(card, sinceCursor): Promise<RawCommand[]>   // poll on tick
  postComment(card, text): Promise<void>                   // gate prompts, rejections
}
```

- **Intake:** the CLI creates the run *and* the attached issue (run_id as
  a hidden body marker + a `workmachine` label). "Create a run by
  chatting" is sugar over that CLI.
- **Commands:** polled on each tick (not webhooks) — store a per-card
  cursor, use conditional requests (ETag), and only poll open-gate
  issues. Plenty of headroom under GitHub's 5,000 req/hr.
- **Authorization:** delegated to tracker access control for now; every
  command/decision event records its `actor`, and authorization is a
  pure check inside `decide`, so a real policy drops in later without
  restructuring.

### Artifacts

Local filesystem first, recorded in the event log with `{id, path,
sha256, size}`. Remote object storage (R2/S3) is added when image/video
runs arrive — large media cannot live in the local-only or tracker
surfaces. The artifact contract (`consumes`/`produces`) is backend-
independent.

### Gates

A gate is a coordinator-owned wait state, not a comment convention. The
orchestrator opens it (`gate_opened`); a validated command closes it
(`gate_decided`). Modes carried from the prototype: `human`, `agent`,
`auto_pass`.

## Storage and collaboration stance (first phase)

Workflow packages are committed; run instances are local and gitignored.
The canonical event log being local means **one coordinator, on Tyler's
Mac** — teammates are team-visible and team-commandable through the
tracker, but the system is single-coordinator and asynchronous. See
[CONTEXT.md](../CONTEXT.md) for the full stance and migration triggers.

## Migration path

The seams are deliberately Temporal-compatible: `decide` → workflow,
executors → activities, commands → signals, gates → durable waits, the
event log → durable history. Move the event log to a shared store
(Postgres/R2/service) for an always-on coordinator; adopt a heavyweight
runtime only once the custom coordinator hits real durability pain — not
before.
