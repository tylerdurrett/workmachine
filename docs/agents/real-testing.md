# Real testing — prove it against the real thing

Fakes and unit tests prove the *logic*. They do not prove the *integration*. A slice is "demoable end-to-end" only when a human has watched it work against the real external surface (real GitHub, real API, real filesystem) — not just against a stub.

The rule:

- **Every slice that touches an external surface includes a live-demo deliverable** — an operator runs the real loop against a real (sandbox) target and confirms each visible step. This is separate from, and in addition to, the offline fake-backed coverage.
- **Keep the live path out of the automated unit suite.** CI stays offline; the live demo is manual/opt-in (env-gated if committed). "No live X in unit tests" and "prove it live before calling it done" are both true — they're different layers.
- **`/check` and `/audit` check AC *coverage*, not *reality*.** A decomposition can have every AC covered and still never make a human see the real thing work. When auditing, ask: "does any child require demonstrating this against the real surface?" If not, that's a gap.

Why: a fake can pass forever while the real adapter is misconfigured, mis-authed, or wrong about the external contract. The first real run is where those bugs surface — so make the first real run a tracked deliverable, not an afterthought.

See [#37](https://github.com/tylerdurrett/workmachine/issues/37) for the canonical example (the live-demo task added to slice #5), and [../live-demo-runbook.md](../live-demo-runbook.md) for the repeatable procedure it produced.
