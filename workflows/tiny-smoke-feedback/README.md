# tiny-smoke-feedback

The engine's committed, feedback-threading example workflow package. Per
[ADR-0007](../../docs/adr/0007-engine-owns-example-workflows-consumes-external-production.md),
the engine repo owns small example/test workflows that prove and
regression-test the engine itself; production workflows live in external repos.

This package has one `script` step (`greet`) that runs `greet.sh` and produces a
single artifact, `artifacts/greeting.txt`, followed by a `gate` (review) step
(`review`) that `needs` it and accepts `approve`, `request_changes`, or
`reject`. Unlike `tiny-smoke-gated`, the script step's `run` command references
`{{feedback.note}}`, so the resolved command — and therefore the artifact the
re-run produces — differs once a reviewer has requested changes.

It is the fixture the integration smoke (`src/integration.smoke.test.ts`) drives
the full request-changes loop against:

1. `run create -> tick` runs `greet` (feedback resolves to empty, so no revision
   line) and stops at `gate_opened`.
2. `command request_changes <text>` records the reviewer's note.
3. `tick` re-opens the **same** gate (one card per gate, ADR-0004), re-dispatches
   `greet` with `{{feedback.note}}` resolved to the note — recorded verbatim on
   `step_dispatched` — and stops at the gate again. The greeting now carries a
   `Revision:` line.
4. `command approve` then `tick` advances past the gate to `run_completed`.

On the first dispatch the resolver substitutes `{{feedback.note}}` to an empty
string (no prior `gate_decided(request_changes)`), so the same templated command
is dispatchable both before and after a revision round without throwing.

Because the resolver has no `{{workflow.dir}}` token, the step locates its
committed script via the `scriptPath` input rather than a path relative to the
package.

## Run it yourself

```
pnpm build
node dist/cli/main.js run create workflows/tiny-smoke-feedback/workflow.yaml \
  --input name=World \
  --input scriptPath="$(pwd)/workflows/tiny-smoke-feedback/greet.sh"
node dist/cli/main.js tick <run-id>                              # runs greet, stops at the gate
node dist/cli/main.js command <run-id> request_changes "say it louder"
node dist/cli/main.js tick <run-id>                              # re-runs greet with feedback, stops at the gate
node dist/cli/main.js command <run-id> approve
node dist/cli/main.js tick <run-id>                              # advances past the gate to completed
```

The run instance lands under `runs/<id>/` (gitignored), and the final artifact
is `runs/<id>/artifacts/greeting.txt`.
