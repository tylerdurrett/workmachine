# tiny-smoke-gated

The engine's committed, gated example workflow package. Per
[ADR-0007](../../docs/adr/0007-engine-owns-example-workflows-consumes-external-production.md),
the engine repo owns small example/test workflows that prove and
regression-test the engine itself; production workflows live in external repos.

This package has one `script` step (`greet`) that runs `greet.sh` and produces a
single artifact, `artifacts/greeting.txt`, followed by a `gate` (review) step
(`review`) that `needs` it and accepts `approve`, `request_changes`, or
`reject`. It is the fixture the integration smoke
(`src/integration.smoke.test.ts`) drives the real gated loop against:
`run create -> tick` (which stops at `gate_opened`), then `command <decision>`
followed by another `tick` to advance — approve to `run_completed`, reject to
`run_failed`.

A review step runs no command and produces no artifacts; it is a
coordinator-owned wait state declaring the decisions it permits (ADR-0004 — one
open gate at a time). Reviewer feedback is recorded on `command`/`gate_decided`
but is not yet interpolated into the re-run step (`{{feedback.*}}` is a later
task), so this fixture deliberately uses no feedback tokens.

Because the resolver has no `{{workflow.dir}}` token, the step locates its
committed script via the `scriptPath` input rather than a path relative to the
package.

## Run it yourself

`run create` needs a target tracker repo: set `WORKMACHINE_SANDBOX_REPO=owner/name`
in the environment, or pass `--repo owner/name` (which overrides the env var).

```
pnpm build
node dist/cli/main.js run create workflows/tiny-smoke-gated/workflow.yaml \
  --input name=World \
  --input scriptPath="$(pwd)/workflows/tiny-smoke-gated/greet.sh"
node dist/cli/main.js tick <run-id>          # runs greet, stops at the gate
node dist/cli/main.js command <run-id> approve
node dist/cli/main.js tick <run-id>          # advances past the gate to completed
```

The run instance lands under `runs/<id>/` (gitignored), and the final artifact
is `runs/<id>/artifacts/greeting.txt`.
