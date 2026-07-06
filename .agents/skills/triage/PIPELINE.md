# Triage under /autopilot

*The autopilot-facing subset of [SKILL.md](SKILL.md) — size verification, state tables, and unattended-mode rules only. Keep the two in sync when editing either.*

Pipeline triage runs as an autopilot-spawned sub-agent against one `size:task` child of a slice, produced by `/decompose`. Read the full spec (body, comments, labels) and any prior triage notes before deciding anything.

For label vocabulary see [docs/agents/triage-labels.md](../../../docs/agents/triage-labels.md); for tracker mechanics see [docs/agents/issue-tracker.md](../../../docs/agents/issue-tracker.md).

## Unattended mode

You are running unattended under `/autopilot`: where `/triage` would confirm with a human (size verification, state choice), make the call yourself per the tables below. The expected happy path is `ready-for-agent`, but never force it — if the task genuinely warrants a non-happy-path state (`needs-info`, `ready-for-human`, …), apply it honestly. End with the structured summary the orchestrator asked for: the size verified (or changed), the state applied, and one sentence of reasoning.

## Verify size

`/decompose` should have labeled the child `size:task`. If the size looks right, proceed. If it looks wrong, change the label yourself — do not propose and wait for direction; default toward the larger tier when ambiguous.

`size:task` needs no structural bookkeeping (no integration-branch declaration, no progress comment) — and pipeline triage only ever sees task-sized children.

## Pick the next state

Clear `needs-triage` and apply one state label. Pick from the happy-path table; if none fits, drop to the non-happy-path table.

**Happy path** (the spec was well-specified and ready):

| Size | New state | Next step |
| ---- | --------- | --------- |
| `size:task` | `ready-for-agent` | `/execute <N>` |
| `size:slice` | `ready-for-agent` | `/decompose <N>` (or `/autopilot <N>` to run the whole slice autonomously) |
| `size:feature` / `size:initiative` | *(no state label)* | `/decompose <N>` |

Two hygiene rules for anything you write into a spec or brief — triage notes are load-bearing for the executing agent, and a false claim sends it hunting:

- **Only assert gates that are actually wired.** Before noting "prettier/lint/CI flags this", check the repo defines that gate (a config file, a package.json script). An ad-hoc `npx prettier --check` against a repo with no prettier config produces noise, not a gate.
- **Exclude vendored/build dirs from exploratory greps** — `grep -rn --exclude-dir={node_modules,dist,.vite,build}` (or use `rg`, which honors .gitignore).

**Non-happy path** (any size):

| Outcome | When | Side effect | Next step |
| ------- | ---- | ----------- | --------- |
| `needs-grilling` | Spec wasn't aligned via `/grill-with-docs`. Typical for children synthesized by `/decompose`; aggressive at initiative→feature, optional at feature→slice, absent at slice→task. | Run `/grill-with-docs <N>` now (then drop the label and re-pick from the happy path), or judge grilling unnecessary and drop the label with a comment. | `/grill-with-docs <N>` (if grilling) or back to happy path. |
| `needs-info` | Waiting on the reporter. | Post triage notes naming what's established and what's missing. | Reporter reply. |
| `ready-for-human` | Needs judgment, external access, design decisions, or manual testing an agent can't safely do. | Note why in a comment. | Maintainer. |
| `deferred` | Intentionally parked. | Short comment naming the trigger and the unpark condition. | `Stop.` |
| `wontfix` (bug) | Will not be actioned. | Polite explanation, close. | `Stop.` |
| `wontfix` (enhancement) | Will not be actioned. | Close with a brief explanatory comment — the closed issue **is** the record. | `Stop.` |

Apply the transition in one call (omit `--add-label` for `size:feature` / `size:initiative` happy path):

```bash
gh issue edit <N> --remove-label "needs-triage" --add-label "<chosen-state>"
```

`gh issue edit` tolerates removing labels that aren't present, so re-runs are idempotent. Replace the `size:*` label here only if the size check changed it.
