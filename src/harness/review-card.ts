import type {
  ArtifactIndexEntry,
  RunState,
  StepState,
} from '../domain/index.js';
import {
  guardedWorkSteps,
  isGateStep,
  type GateStep,
  type WorkflowDefinition,
} from '../workflow/index.js';

/**
 * The pure review-card projection (ADR-0004): render the body of the single
 * review card for the currently-open gate.
 *
 * This is the projection half of the tracker seam — a pure
 * `(workflow, runState) => string`, no I/O — so it is unit-testable in isolation
 * and the harness owns the side-effecting `renderReviewCard` call. ADR-0004
 * organizes the human surface around gates, not steps: one card per gate, the
 * automatic (script) steps since the previous gate rolled up as context, the
 * produced artifacts surfaced inline, and the gate's allowed decisions listed so
 * a reviewer knows the moves available. A `request_changes` loop reuses this same
 * card with a revision thread rather than minting a new one.
 *
 * The vocabulary is deliberately tracker-agnostic (CONTEXT.md → Language): this
 * renders a *card body*, never a GitHub issue. The GitHub-ness lives only in the
 * adapter that PATCHes this body onto the issue.
 *
 * Artifact metadata (path + sha256 + size) is read straight from the folded run
 * state's recorded artifact entries — never re-hashed. The executor already
 * recorded those facts on `step_succeeded`; the projection only reads them.
 */

/** A blank line — the markdown paragraph break between body sections. */
const BREAK = '';

/**
 * Render the review card body for the run's currently-open gate.
 *
 * @param workflow the run's pinned workflow definition.
 * @param runState the folded run state; its `openGate` names the gate to render.
 * @returns the rendered card body (markdown).
 * @throws if no gate is open, or the open gate names no `gate` step in the
 *   workflow — the harness only calls this right after appending `gate_opened`,
 *   so a missing gate is a programming error, not a runtime condition.
 */
export function renderReviewCardBody(
  workflow: WorkflowDefinition,
  runState: RunState,
): string {
  const open = runState.openGate;
  if (open === undefined) {
    throw new Error('renderReviewCardBody: no gate is open to render');
  }
  const gate = workflow.steps.find(
    (s): s is GateStep => s.id === open.stepId && isGateStep(s),
  );
  if (gate === undefined) {
    throw new Error(
      `renderReviewCardBody: open gate names no gate step '${open.stepId}'`,
    );
  }

  const contextSteps = guardedWorkSteps(workflow, gate.id).map(
    (id): StepState => runState.steps[id] ?? { stepId: id, status: 'pending' },
  );
  const lines: string[] = [
    `## Review: ${gate.id}`,
    BREAK,
    ...renderContext(contextSteps),
    BREAK,
    ...renderArtifacts(contextSteps),
    BREAK,
    ...renderAllowedDecisions(gate),
  ];

  const revision = renderRevisionThread(runState.steps[gate.id]);
  if (revision.length > 0) {
    lines.push(BREAK, ...revision);
  }

  return lines.join('\n');
}

/**
 * Roll up the automatic (script) steps the gate guards as context — the work
 * done since the previous gate (ADR-0004). Each step is listed with its status
 * so a reviewer sees what produced the artifacts under review.
 */
function renderContext(contextSteps: readonly StepState[]): string[] {
  const lines = ['### Steps since the last gate'];
  if (contextSteps.length === 0) {
    lines.push('- (no automatic steps)');
    return lines;
  }
  for (const step of contextSteps) {
    lines.push(`- \`${step.stepId}\` — ${step.status}`);
  }
  return lines;
}

/**
 * Surface the artifacts the guarded steps produced inline (ADR-0004): path,
 * sha256, and size, read straight off the recorded artifact entries — never
 * re-hashed, since the executor already recorded them on `step_succeeded`.
 */
function renderArtifacts(contextSteps: readonly StepState[]): string[] {
  const lines = ['### Artifacts'];
  const artifacts = collectArtifacts(contextSteps);
  if (artifacts.length === 0) {
    lines.push('- (none)');
    return lines;
  }
  for (const artifact of artifacts) {
    lines.push(
      `- \`${artifact.path}\` — sha256 \`${artifact.sha256}\`, ${String(artifact.size)} bytes`,
    );
  }
  return lines;
}

/** List the gate's allowed decisions (ADR-0004): the moves the reviewer has. */
function renderAllowedDecisions(gate: GateStep): string[] {
  const lines = ['### Allowed decisions'];
  for (const decision of gate.allowed_decisions) {
    lines.push(`- \`${decision}\``);
  }
  return lines;
}

/**
 * Render the revision thread for a gate that has looped through
 * `request_changes` (ADR-0004 — one card per gate, not one per attempt). The
 * fold records the `decision` + `feedback` on the gate step's resting state
 * after the loop; the projection just surfaces the feedback. Returns no lines
 * when the gate has not been sent back for changes.
 */
function renderRevisionThread(gate: StepState | undefined): string[] {
  if (gate?.decision !== 'request_changes') return [];
  return ['### Revision requested', gate.feedback ?? '(no feedback provided)'];
}

/** Gather the artifact entries the context steps produced, in step order. */
function collectArtifacts(
  contextSteps: readonly StepState[],
): ArtifactIndexEntry[] {
  const artifacts: ArtifactIndexEntry[] = [];
  for (const step of contextSteps) {
    if (step.artifacts !== undefined) artifacts.push(...step.artifacts);
  }
  return artifacts;
}
