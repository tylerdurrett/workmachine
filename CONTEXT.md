# Work Machine Context

## One-sentence definition

Work Machine coordinates tracker-backed workflow runs across human review, agent work, scripts, workers, artifacts, and gates.

## Core vocabulary

- **Workflow package** — declarative workflow definition plus any supporting assets, validators, examples, or package-local procedures.
- **Run** — one execution of a workflow package, with machine-readable state and event history.
- **Coordinator (orchestrator)** — deterministic engine that decides what is allowed next by folding the event log into current state. It does no I/O: it never touches the filesystem, network, or an LLM directly. Replayable and unit-testable as a pure function of the event log.
- **Determinism boundary** — the hard rule separating orchestration from execution. The coordinator is pure and side-effect-free; every side effect (running a script, spawning an agent, hashing a file, checking a path) happens inside an executor and re-enters the system only as an appended event.
- **Event log** — the append-only `events.jsonl` that is the canonical record of a run. `run.yaml` is a derived cache that can always be rebuilt by replaying the log.
- **Tick** — one re-invokable advance of a run: replay the event log, decide the next runnable step, invoke its executor, append the resulting events, and stop at the next gate. The local-first stand-in for a durable runtime.
- **Tracker adapter** — integration that projects run state into an issue/card surface and reads human commands back from that surface.
- **Tracker surface** — the human-visible issue/card where status, artifacts, discussion, and commands live.
- **Executor adapter** — implementation of a step type such as `script`, `agent`, `human`, or `noop`. The only place side effects are allowed.
- **Worker** — process or machine that executes runnable steps. Starts local; may become cloud/GPU-capability-aware later.
- **Artifact index** — machine-readable metadata for outputs such as file paths, sizes, hashes, URLs, and validation state.
- **Gate** — a coordinator-owned wait state that requires a command, commonly a human tracker command like `/approve`. A step that carries a gate is a **review step**.
- **Command** — an external signal such as `/approve` arriving from the tracker. It becomes canonical only once validated and appended to the event log; an unvalidated tracker comment is not truth.
- **Projection** — the tracker-facing rendering of coordinator state. The projection is useful, but not canonical.
- **Review card** — the projection of a single gated step, and the unit of human attention. It bundles the automatic steps since the previous gate as rolled-up context, surfaces the artifact(s) inline, and accepts the decision inline like a normal ticket. One card per gate: a request-changes loop reuses the same card with a revision thread, not a fresh card per attempt.
- **Run card** — the parent projection of a whole run: the bird's-eye graph, overall progress, and links to its review cards. Always conceptually present; a gateless run is just a run card with its final artifact. (Deferred in implementation — the first slice ships a single review card.)

## Language rules

- Say **tracker adapter** when referring to GitHub Issues, Trello, or future issue/card integrations.
- Say **coordinator** for the deterministic state machine. Avoid making GitHub Issues sound canonical.
- Say **artifact index** for metadata. Avoid implying large artifacts live in GitHub.
- Say **gate** for state-machine waits. Avoid treating `/approve` as just a comment convention.

## First concrete choices

- First tracker adapter: GitHub Issues.
- First worker: local process on Tyler's machine.
- First artifact backend: local filesystem plus artifact index.
- First workflow proof: one tiny script step plus one human approval gate.

## Flagged ambiguities

- **"Coordinator" was ambiguous between an active driver and a passive planner.** Resolved: the coordinator is an **active** deterministic orchestrator that drives runs forward via `tick`. The deprecated prototype was passive — it planned a DAG, projected it onto Hermes Kanban, and let autonomous agents self-coordinate through tracker comments. That pattern (tracker-embedded step contracts, agent-driven lifecycle) is deprecated and is not coming back.
- **"Worker" vs "coordinator."** The coordinator decides; the worker (or executor) does. Early on, a single `tick` CLI plays both roles, but they stay conceptually distinct so worker/capability routing can be split out later without touching orchestration logic.
- **Card granularity (per-run vs per-step) resolved by a principle: the human surface is organized around _decisions_, not steps.** A card maps to a gate (review step), not to a run and not to every step. Automatic steps roll up into the next review card and the run card's graph. The Hermes Kanban "too low-level" complaint was about its UI, not granularity.

## Storage and collaboration stance (first phase)

- **Workflow packages are committed source; run instances are not.** A workflow package (`workflow.yaml` + scripts/validators) is versioned and reviewed like code. A run instance (event log, artifacts, derived `run.yaml`) lives in a local, gitignored `runs/<run_id>/` directory and is not committed (append-only logs merge badly; artifacts can be large or secret).
- **One coordinator, on Tyler's Mac.** Because the canonical event log is local, there is a single coordinator. Teammates are *team-visible and team-commandable* through the tracker projection, but the system is **single-coordinator and asynchronous**: a `/approve` is a `command_received` fact that only advances the run on the next `tick`. If the machine is off, runs pause; they are not lost.
- **Known migration triggers.** Move the event log to a shared store (Postgres/R2/service) to get an always-on coordinator. Add remote object storage (R2) for artifacts **by the time image/video runs arrive** — large media cannot live in the local-only / tracker surfaces.
- **Authorization is deliberately delegated to tracker access control for now.** No allowlist or role config in this phase; only approved people can comment on the boards, so that is the de facto policy. The seam is kept minimal-but-future-proof: every command/decision event records its `actor`, and authorization is a pure check inside `decide`, so a real identity/roles policy drops into an existing function later without restructuring.

## Out of scope for the first slice

- Temporal or another heavyweight workflow runtime.
- Trello adapter.
- R2/S3/Frame.io artifact storage.
- Complex multi-worker scheduling.
- Generic workflow marketplace.
