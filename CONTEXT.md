# Work Machine Context

## One-sentence definition

Work Machine coordinates tracker-backed workflow runs across human review, agent work, scripts, workers, artifacts, and gates.

## Core vocabulary

- **Workflow package** — declarative workflow definition plus any supporting assets, validators, examples, or package-local procedures. Packages come from two places: the engine repo **owns example/test packages** under committed `workflows/` (used for proofs and integration tests — e.g. `workflows/tiny-smoke/`), while **production packages live in external repos** the engine *consumes by path/reference without owning their creative context, fixtures, or skills*. See [ADR-0007](docs/adr/0007-engine-owns-example-workflows-consumes-external-production.md).
- **Run** — one execution of a workflow package, with machine-readable state and event history. Its **run id** (the `runs/<id>/` directory name and the tracker idempotency marker) is engine-minted at `run create` as `<timestamp>-<workflow-slug>-<rand4>` — sortable, legible, collision-resistant — with an optional operator `--run-id` override that the harness refuses if the dir already exists. The id is minted once (clock used in the harness, never in `decide`), recorded in `run_created`, and read from the log by every later `tick` rather than re-derived, so replay stays deterministic.
- **Coordinator (orchestrator)** — deterministic engine that decides what is allowed next by folding the event log into current state. It does no I/O: it never touches the filesystem, network, or an LLM directly. Replayable and unit-testable as a pure function of the event log.
- **Determinism boundary** — the hard rule separating orchestration from execution. The coordinator is pure and side-effect-free; every side effect (running a script, spawning an agent, hashing a file, checking a path) happens inside an executor and re-enters the system only as an appended event.
- **Event log** — the append-only `events.jsonl` that is the canonical record of a run. `run.yaml` is a derived cache that can always be rebuilt by replaying the log.
- **Tick** — one re-invokable advance of a run: replay the event log, decide the next runnable step, invoke its executor, append the resulting events, and stop at the next gate. The local-first stand-in for a durable runtime.
- **Resolver** — the harness step that, at dispatch time, folds the event log into concrete bindings (inputs from `run_created`, artifact paths from the run-dir convention, revision feedback from the latest `gate_decided`) and substitutes them into a step's `{{...}}` template to produce the fully-resolved command the executor runs. The **loader** only *validates statically* that every interpolation reference points at a real declaration; *value* substitution happens per-dispatch in the resolver. The resolved command is recorded on `step_dispatched`, so the event log is self-describing and replay never needs the path convention. The resolver lives in the harness, never in `decide` — `decide` only names the step to dispatch and never builds shell strings or knows path layout.
- **Tracker adapter** — integration that projects run state into an issue/card surface and reads human commands back from that surface, behind a small `createRunCard` / `renderReviewCard` / `readCommands` / `postComment` interface with an in-memory fake for tests. The first implementation is GitHub Issues over raw `fetch` (not Octokit), with explicit ETag conditional polling; the target repo is operator-supplied per run via `run create --repo owner/name` (falling back to `WORKMACHINE_SANDBOX_REPO` in local dev), never a global tracker. The GitHub credential is the one global secret, `WORKMACHINE_GITHUB_TOKEN`. See [ADR-0008](docs/adr/0008-github-tracker-adapter-raw-fetch-operator-supplied-repo.md).
- **Tracker surface** — the human-visible issue/card where status, artifacts, discussion, and commands live.
- **Executor adapter** — implementation of a step type such as `script`, `agent`, `human`, or `noop`. The only place side effects are allowed.
- **Worker** — process or machine that executes runnable steps. Starts local; may become cloud/GPU-capability-aware later.
- **Artifact index** — machine-readable metadata for outputs such as file paths, sizes, hashes, URLs, and validation state.
- **Gate** — a coordinator-owned wait state that requires a command, commonly a human tracker command like `/approve`. A step that carries a gate is a **review step**.
- **Command** — an external signal such as `/approve` arriving from the tracker. It becomes canonical only once validated and appended to the event log; an unvalidated tracker comment is not truth. Each `command_received` records the tracker's stable **comment id** as a canonical idempotency key: the fold ignores a comment id already in the log, so re-ingestion after a crash is a no-op and the poll cursor stays a non-canonical fetch optimization, never a correctness boundary. When several un-ingested commands exist at one tick, **first-valid-wins per gate**: the first valid decision closes the gate; later comments target an already-closed gate and fail validation (audit-only).
- **Projection** — the tracker-facing rendering of coordinator state. The projection is useful, but not canonical.
- **Review card** — the projection of a single gated step, and the unit of human attention. It bundles the automatic steps since the previous gate as rolled-up context, surfaces the artifact(s) inline, and accepts the decision inline like a normal ticket. One card per gate: a request-changes loop reuses the same card with a revision thread, not a fresh card per attempt.
- **Revision feedback** — the free text a reviewer attaches to a `request_changes` decision. It is recorded as a fact on the `gate_decided` event and threaded into the re-dispatched step's resolution context (a `{{feedback.*}}` namespace), so the re-run can legitimately produce different output while `decide` stays a pure fold over the log. For a deterministic `script` executor the re-run only differs if the script consumes that feedback; the mechanism exists so the deferred `agent` executor inherits it unchanged.
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
- **Command validation now; identity authorization deferred.** The pure check inside `decide` in this phase is **command validation**, not identity: it rejects a `command_received` whose gate_id has no open gate, whose decision verb isn't in the gate's `allowed_decisions`, or that targets a gate that isn't the currently open one. A rejected command stays in the log as an audit fact but produces no `gate_decided`, so the run does not advance — the concrete teeth behind "an unvalidated tracker comment is not truth." Identity/role **authorization is deliberately delegated to tracker access control for now** (only approved people can comment on the boards, so that is the de facto policy). The seam is kept minimal-but-future-proof: every command/decision event records its `actor`, and identity authorization later drops into the *same* `decide` function without restructuring.

## Out of scope for the first slice

- Temporal or another heavyweight workflow runtime.
- Trello adapter.
- R2/S3/Frame.io artifact storage.
- Complex multi-worker scheduling.
- Generic workflow marketplace.
