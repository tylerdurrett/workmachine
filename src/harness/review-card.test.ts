import { describe, expect, it } from 'vitest';
import type { RunState } from '../domain/index.js';
import { loadWorkflow } from '../workflow/index.js';
import { renderReviewCardBody } from './review-card.js';

/**
 * Unit tests for the pure review-card projection. The function is a pure
 * `(workflow, runState) => string`, so these drive it with hand-built run states
 * (no harness, no tracker, no I/O) and assert on the rendered body: the
 * automatic-step rollup, the inline artifact metadata, the allowed-decisions
 * list, and the revision thread after a `request_changes` loop.
 */

const WORKFLOW_YAML = `
slug: tiny-smoke
steps:
  - id: build
    type: script
    run: 'printf hi > {{artifacts.out.path}}'
    produces:
      - id: out
        path: artifacts/out.txt
  - id: review
    type: gate
    needs: [build]
    allowed_decisions: [approve, request_changes, reject]
`;

const workflow = loadWorkflow(WORKFLOW_YAML);

/** A run state with the script step succeeded and the gate open for review. */
function awaitingReview(overrides?: Partial<RunState>): RunState {
  return {
    runId: 'r1',
    workflowSlug: 'tiny-smoke',
    status: 'running',
    inputs: {},
    steps: {
      build: {
        stepId: 'build',
        status: 'succeeded',
        artifacts: [
          {
            id: 'out',
            path: 'artifacts/out.txt',
            sha256: 'a'.repeat(64),
            size: 2,
          },
        ],
      },
      review: { stepId: 'review', status: 'awaiting_review' },
    },
    artifacts: [
      { id: 'out', path: 'artifacts/out.txt', sha256: 'a'.repeat(64), size: 2 },
    ],
    openGate: { gateId: 'review', stepId: 'review' },
    ...overrides,
  };
}

describe('renderReviewCardBody', () => {
  it('rolls up the automatic steps since the previous gate as context', () => {
    const body = renderReviewCardBody(workflow, awaitingReview());

    expect(body).toContain('### Steps since the last gate');
    expect(body).toContain('`build` — succeeded');
    // The gate step itself is not listed as one of its own context steps.
    expect(body).not.toContain('`review` — awaiting_review');
  });

  it('renders a succeeded agent step summary beside its status line', () => {
    const state = awaitingReview({
      steps: {
        build: {
          stepId: 'build',
          status: 'succeeded',
          summary: 'wrote the greeting file as requested',
        },
        review: { stepId: 'review', status: 'awaiting_review' },
      },
    });

    const body = renderReviewCardBody(workflow, state);

    expect(body).toContain('`build` — succeeded');
    expect(body).toContain('wrote the greeting file as requested');
  });

  it('renders a failed agent step summary beside its status line', () => {
    const state = awaitingReview({
      steps: {
        build: {
          stepId: 'build',
          status: 'failed',
          summary: 'could not resolve the template variable',
        },
        review: { stepId: 'review', status: 'awaiting_review' },
      },
    });

    const body = renderReviewCardBody(workflow, state);

    expect(body).toContain('`build` — failed');
    expect(body).toContain('could not resolve the template variable');
  });

  it('indents every line of a multi-line summary inside the nested list item', () => {
    const state = awaitingReview({
      steps: {
        build: {
          stepId: 'build',
          status: 'succeeded',
          summary:
            'greeting file written\nhi now rests in out.txt\ntwo bytes, no more',
        },
        review: { stepId: 'review', status: 'awaiting_review' },
      },
    });

    const body = renderReviewCardBody(workflow, state);

    // Continuation lines carry four leading spaces (the content column of
    // `  - `), so the whole summary stays within the nested list item.
    expect(body).toContain(
      [
        '- `build` — succeeded',
        '  - greeting file written',
        '    hi now rests in out.txt',
        '    two bytes, no more',
      ].join('\n'),
    );
  });

  it('keeps the plain status line for a step that carries no summary', () => {
    // Script steps — and agent steps that captured no final message — leave
    // `summary` omitted, so the rollup shows only the single-line status.
    const body = renderReviewCardBody(workflow, awaitingReview());

    expect(body).toContain('`build` — succeeded');
    // No indented summary continuation is emitted for a summary-less step.
    expect(body).not.toContain('\n  - ');
  });

  it('surfaces produced artifacts inline with path + sha256 + size', () => {
    const body = renderReviewCardBody(workflow, awaitingReview());

    expect(body).toContain('### Artifacts');
    expect(body).toContain(
      `\`artifacts/out.txt\` — sha256 \`${'a'.repeat(64)}\`, 2 bytes`,
    );
  });

  it('lists the open gate allowed_decisions', () => {
    const body = renderReviewCardBody(workflow, awaitingReview());

    expect(body).toContain('### Allowed decisions');
    expect(body).toContain('`approve`');
    expect(body).toContain('`request_changes`');
    expect(body).toContain('`reject`');
  });

  it('renders a "(none)" artifact line when the rolled-up steps produced nothing', () => {
    const state = awaitingReview({
      steps: {
        build: { stepId: 'build', status: 'succeeded' },
        review: { stepId: 'review', status: 'awaiting_review' },
      },
      artifacts: [],
    });

    const body = renderReviewCardBody(workflow, state);

    expect(body).toContain('### Artifacts');
    expect(body).toContain('- (none)');
  });

  it('appends a revision thread when the gate carries a request_changes decision', () => {
    // After a request_changes loop the fold resets the gate to `pending` and
    // records the decision + feedback on its resting state; the gate is re-opened
    // once the work re-succeeds, so it is awaiting_review again here.
    const state = awaitingReview();
    state.steps.review = {
      stepId: 'review',
      status: 'awaiting_review',
      decision: 'request_changes',
      feedback: 'please tighten the copy',
    };

    const body = renderReviewCardBody(workflow, state);

    expect(body).toContain('### Revision requested');
    expect(body).toContain('please tighten the copy');
  });

  it('omits the revision thread when the gate has not been sent back', () => {
    const body = renderReviewCardBody(workflow, awaitingReview());

    expect(body).not.toContain('### Revision requested');
  });

  it('throws when no gate is open', () => {
    const state = awaitingReview();
    delete state.openGate;

    expect(() => renderReviewCardBody(workflow, state)).toThrow(
      /no gate is open/,
    );
  });
});
