# Open Design Questions (deferred)

Decisions intentionally deferred past the first vertical slice. Each is
real and load-bearing; none blocks slice 1. Promote into an ADR (and the
canonical docs) when resolved.

## 1. The agent executor — how an agent step actually runs

The first slice has only a `script` executor. Two of the three tenants
(the fan-out researcher, the dev-skills replacement) and most video
steps need an `agent` executor. The architecture already places it
cleanly: an agent step is just an `Executor` (ADR-0003) — non-determinism
is fine because executors are the side-effecting layer, and "thin skill,
thick engine" means the engine resolves inputs, hands the agent exactly
one narrow creative task plus the resolved input artifacts, and the agent
never touches run lifecycle, gates, or "what's next."

Unresolved:

- **Invocation mechanism:** Claude Code headless (`claude -p` / the
  Agent SDK), the Claude Agent SDK directly (TS-native), or a Hermes
  profile. Lean is the TS Agent SDK for first-class typing, but undecided.
- **Artifact contract enforcement:** how the engine guarantees an agent
  produced its declared `produces` artifacts (structured output? a
  post-step validator? re-prompt on miss?).
- **Failure/retry semantics:** how agent errors and partial output map to
  `step_failed`, and what (if anything) retries.

## 2. Dynamic fan-out — the researcher spawning a data-dependent N

The fan-out researcher spawns *many* sub-tasks whose count depends on
runtime data (e.g. one sub-task per source discovered), then synthesizes.
A static `workflow.yaml` can't express N upfront, which is in tension
with the static-DAG / pure-`decide` model.

Unresolved:

- **Dynamic step expansion vs child sub-runs:** does a `fanout` step's
  executor emit events that expand the graph with N runnable steps, or
  does it spawn N child *runs* with a parent synthesis step that waits on
  all of them? (`kind: fanout` existed in the prototype schema but was
  never implemented.)
- **Convergence:** how a synthesis step waits on a set whose size is only
  known at runtime, while `decide` stays a pure fold.
- **Temporal mapping:** this is exactly where Temporal child workflows /
  parallel activities would later fit; keep the seam compatible.
