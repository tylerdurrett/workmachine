# tiny-smoke

The engine's committed, gateless example workflow package. Per
[ADR-0007](../../docs/adr/0007-engine-owns-example-workflows-consumes-external-production.md),
the engine repo owns small example/test workflows that prove and
regression-test the engine itself; production workflows live in external repos.

This package has one `script` step (`greet`) that runs `greet.sh` and produces a
single artifact, `artifacts/greeting.txt`, containing `Hello, <name>!`. It is
the fixture the integration smoke (`src/integration.smoke.test.ts`) drives the
real `run create -> tick -> run_completed` spine against.

Because the resolver has no `{{workflow.dir}}` token, the step locates its
committed script via the `scriptPath` input rather than a path relative to the
package.

## Run it yourself

```
pnpm build
node dist/cli/main.js run create workflows/tiny-smoke/workflow.yaml \
  --input name=World \
  --input scriptPath="$(pwd)/workflows/tiny-smoke/greet.sh"
node dist/cli/main.js tick <run-id>
```

The run instance lands under `runs/<id>/` (gitignored), and the final artifact
is `runs/<id>/artifacts/greeting.txt`.
