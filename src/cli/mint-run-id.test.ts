import { describe, expect, it } from 'vitest';
import { mintRunId } from './mint-run-id.js';

/**
 * Unit test for the pure run-id mint. With a fixed clock and randomness the
 * output is fully determined, so we assert the exact string the format produces
 * and that the random suffix is the only part the `rand` injection controls.
 */

const now = (): string => '2026-06-07T12:00:00.000Z';

describe('mintRunId', () => {
  it('compacts the timestamp and joins slug and random suffix', () => {
    const id = mintRunId('tiny-smoke', now, () => 'ab12');
    expect(id).toBe('20260607T120000Z-tiny-smoke-ab12');
  });

  it('changes only the suffix when the randomness changes', () => {
    const a = mintRunId('tiny-smoke', now, () => 'ab12');
    const b = mintRunId('tiny-smoke', now, () => 'zz99');
    expect(a).toBe('20260607T120000Z-tiny-smoke-ab12');
    expect(b).toBe('20260607T120000Z-tiny-smoke-zz99');
  });
});
