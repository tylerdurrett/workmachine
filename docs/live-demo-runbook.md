# Live-demo runbook — watch the loop work against real GitHub

The operator-watched counterpart to the offline smoke (`src/integration.smoke.test.ts`,
issue #36). This drives the **real** run loop through the live GitHub adapter
(ADR-0008) against a **dedicated sandbox repo**, so a human sees
`run create` → real issue → review card → reviewer comment → `completed` happen on
github.com. See [agents/real-testing.md](agents/real-testing.md) for why this is a
tracked deliverable rather than an afterthought.

> **Never run this against the engine's own engineering tracker.** Run cards are
> `workmachine`-labeled issues; they belong only in the sandbox repo.

## Prerequisites

- **Token** — a GitHub token with issues read/write on the sandbox repo, exported
  as `WORKMACHINE_GITHUB_TOKEN`. The repo keeps it in a gitignored `.env`:
  ```sh
  set -a; . ./.env; set +a   # exports WORKMACHINE_GITHUB_TOKEN
  ```
  (A `gh auth token` value also works if it can write issues on the sandbox.)
- **Target repo** — the sandbox `owner/name`, supplied per run via `--repo` or via
  `WORKMACHINE_SANDBOX_REPO`. The engine hard-codes no repo (ADR-0008).
  ```sh
  export WORKMACHINE_SANDBOX_REPO=tylerdurrett/workmachine-sandbox
  ```
  > The acceptance criteria in #37 call this `WORKMACHINE_REPO`; the implemented
  > env var is `WORKMACHINE_SANDBOX_REPO` (or the per-run `--repo` flag).
- **The `workmachine` label must exist in the sandbox repo** — the adapter tags
  every run card with it, and GitHub rejects a create that names a missing label:
  ```sh
  gh label create workmachine --repo "$WORKMACHINE_SANDBOX_REPO" \
    --color 5319e7 --description "Machine-opened run card"
  ```
- **Build** — `pnpm build` (the CLI runs from `dist/`).
- **Codex CLI** (agent-step demo only) — `codex` installed on `PATH` and logged in
  under **subscription auth** (`codex exec` runs non-interactively; no API-key
  billing). Verify with `codex login status`.

## The demo

This uses the committed `workflows/tiny-smoke-feedback/` package, which interpolates
`{{feedback.note}}`, so one run on one card covers create → review card →
`/request-changes` (threaded revision) → `/approve` → completed.

```sh
set -a; . ./.env; set +a
export WORKMACHINE_SANDBOX_REPO=tylerdurrett/workmachine-sandbox
SCRIPT="$PWD/workflows/tiny-smoke-feedback/greet.sh"

# 1. Create — opens a real workmachine-labeled issue with the run-id body marker.
node dist/cli/main.js run create workflows/tiny-smoke-feedback/workflow.yaml \
  --input name=World --input "scriptPath=$SCRIPT"
# -> prints: created run <RID>   (and the next command)
RID=<RID>
```

Confirm on github.com: the new issue exists, carries the `workmachine` label, and its
body reads ``Work Machine run `<RID>` ``. The run's `events.jsonl` shows
`run_created` then `card_created` (with the issue `cardUrl`).

```sh
# 2. Tick — runs the greet step, writes the artifact, renders the review card.
node dist/cli/main.js tick "$RID"
```

Confirm on github.com: the issue body is now the review card — the produced
artifact inline (`artifacts/greeting.txt`, sha256, byte size) and the gate's allowed
decisions. The log stops at `gate_opened`.

```sh
# 3. /request-changes round — OPERATOR comments on the issue (a human handle, not
#    the `workmachine` bot actor, which ingestion skips), then tick.
#      comment on the issue:  /request-changes say it louder
node dist/cli/main.js tick "$RID"
```

Confirm: still only the one issue (no second card minted — ADR-0004, one card per
gate). The SAME card re-renders with a larger artifact (the revision line threaded
in). The log shows `command_received` → `gate_decided (request_changes)` →
`step_dispatched` → `step_succeeded` → `gate_opened`.

```sh
# 4. /approve round — OPERATOR comments, then tick.
#      comment on the issue:  /approve
node dist/cli/main.js tick "$RID"
```

Confirm: the log ends `command_received` → `gate_decided (approve)` →
`run_completed`, and `runs/$RID/run.yaml` reads `status: completed`.

## The agent-step demo (approve path)

The agent-step counterpart (issue #62): the committed `workflows/tiny-agent/`
package drives one `agent` step through the **real** `codex exec` — the engine
spawns it as a subprocess (ADR-0009), it writes the haiku artifact under the run
dir, and the same gated loop carries it to `run_completed`. This demo is
**human-watched at slice ship** and owned by task **#63**; CI never runs it —
the hermetic smoke (`src/integration.smoke.test.ts`) proves the same loop
offline with a stub `codex` on `PATH`.

Prerequisites as above, plus the Codex CLI logged in under subscription auth.

```sh
set -a; . ./.env; set +a
export WORKMACHINE_SANDBOX_REPO=tylerdurrett/workmachine-sandbox

# 1. Create — opens a real workmachine-labeled issue with the run-id body marker.
node dist/cli/main.js run create workflows/tiny-agent/workflow.yaml \
  --input "topic=autumn rain"
# -> prints: created run <RID>
RID=<RID>

# 2. Tick — dispatches the composed prompt to the real `codex exec`, which
#    writes the haiku; the executor captures it and the review card renders.
#    (An agent step legitimately takes a minute or two.)
node dist/cli/main.js tick "$RID"
```

Confirm:

- `runs/$RID/artifacts/haiku.txt` exists and contains a real haiku about the
  topic — written by codex, not by the engine.
- The review card on github.com shows the `haiku` artifact with its sha256 and
  byte size, plus the gate's allowed decisions. The log stops at `gate_opened`.
- `step_dispatched` in `runs/$RID/events.jsonl` has `stepType: "agent"` and its
  `prompt` is the FULL resolved payload: the author text with the topic
  substituted (no `{{...}}` left) plus the appended `## Engine contract` block
  naming `artifacts/haiku.txt`.

```sh
# 3. /approve round — OPERATOR comments on the issue (a human handle, not the
#    `workmachine` bot actor, which ingestion skips), then tick.
#      comment on the issue:  /approve
node dist/cli/main.js tick "$RID"
```

Confirm: the log ends `command_received` → `gate_decided (approve)` →
`run_completed` carrying the haiku artifact, and `runs/$RID/run.yaml` reads
`status: completed`.

Teardown is the same as below.

## Teardown

```sh
# Close the run card(s) in the sandbox so the repo stays clean.
gh issue list --repo "$WORKMACHINE_SANDBOX_REPO" --label workmachine \
  --json number --jq '.[].number' \
  | xargs -I{} gh issue close {} --repo "$WORKMACHINE_SANDBOX_REPO"

# Drop the local run instance (the runs/ root is gitignored anyway).
rm -rf "runs/$RID"
```

## Notes

- **Not a unit test.** CI stays fully offline; this is manual/opt-in. No live GitHub
  in the automated suite — `src/integration.smoke.test.ts` proves the same loop
  against the in-memory `FakeTracker`.
- **Bot-actor exclusion** is keyed on the literal handle `workmachine`
  (`BOT_ACTOR`), not the authenticated token's identity — so an operator commenting
  under their own GitHub login is always ingested, even when the engine authenticates
  as that same login.
