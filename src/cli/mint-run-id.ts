/**
 * Mint a run id — the one place a run's identity is born.
 *
 * The run id is the name of a unique run instance and the key everything else
 * hangs off (CONTEXT.md → Run / run id scheme). It is minted *once*, here on the
 * impure side of the determinism boundary, recorded in the `run_created` event,
 * and read back from the log by every later tick — never re-derived. That is why
 * both impure ingredients are injected rather than read in-line: the clock and
 * the randomness enter through parameters so this function itself stays pure and
 * its output is exactly reproducible under a fixed `now`/`rand` in tests.
 */

/**
 * Build a run id of the form `<timestamp>-<slug>-<rand4>`, e.g.
 * `20260607T120000Z-tiny-smoke-ab12`.
 *
 * The timestamp is `now()` compacted to a filesystem-friendly basic ISO-8601
 * form: the `-` and `:` separators are stripped and the `.NNN` milliseconds are
 * dropped, leaving `YYYYMMDDThhmmssZ`. The slug names the workflow; the random
 * suffix disambiguates runs minted within the same second.
 *
 * @param slug the workflow's slug (becomes the middle segment).
 * @param now injected clock returning an ISO-8601 instant (`2026-06-07T...Z`).
 * @param rand injected randomness returning the disambiguating suffix.
 */
export function mintRunId(
  slug: string,
  now: () => string,
  rand: () => string,
): string {
  const ts = now()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  return `${ts}-${slug}-${rand()}`;
}
