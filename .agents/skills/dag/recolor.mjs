#!/usr/bin/env node
// Recolor an issue's "## Sub-issue DAG" Mermaid block in place from live sub-issue state.
//
// This is the DETERMINISTIC refresh path for the /dag skill. It does NOT re-infer edges or
// rebuild the chart — it reuses the existing nodes and edges exactly and rewrites ONLY the
// `class <ids> done|inProgress|notStarted;` assignment lines. classDefs, nodes, edges, the
// legend, and everything outside the DAG section are preserved byte-for-byte.
//
// Why a script (not the agent flow): /ship and /batch refresh colors frequently and, under
// /batch, concurrently. Re-running the full agent flow each time would (a) cost an agent per
// refresh and (b) let edge inference drift run-to-run, making the chart flicker. Recoloring is
// pure mechanism, so it lives in code: fast, churn-free, and safe to fire on every transition.
//
// Concurrency: each run re-reads live state and writes a COMPLETE body via one atomic
// `gh issue edit`. So a lost update (two siblings racing) self-heals on the next call, and the
// /batch workflow's end-of-run sweep guarantees the final resting state is correct.
//
// Usage:  node recolor.mjs <issue-number>
// Exit:   0 = recolored (or a no-op: no DAG section / no change). 1 = malformed DAG block. 2 = bad args.

import { execFileSync } from 'node:child_process'
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const issue = process.argv[2]
if (!issue || !/^\d+$/.test(issue)) {
  console.error('usage: recolor.mjs <issue-number>')
  process.exit(2)
}

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

const HEADING = '## Sub-issue DAG'

const body = (JSON.parse(sh('gh', ['issue', 'view', issue, '--json', 'body'])).body || '').replace(/\r\n/g, '\n')
if (!body.includes(HEADING)) {
  console.log(`#${issue}: no "${HEADING}" section — nothing to recolor.`)
  process.exit(0)
}

// Scope every edit to the DAG section: from its heading to the next "## " heading (or EOF).
const start = body.indexOf(HEADING)
let end = body.indexOf('\n## ', start + HEADING.length)
if (end === -1) end = body.length
const before = body.slice(0, start)
const section = body.slice(start, end)
const after = body.slice(end)

// Every node id referenced in the chart (node defs, edges, and class lines all use I<number>).
const nodeIds = new Set()
for (const m of section.matchAll(/\bI(\d+)\b/g)) nodeIds.add(Number(m[1]))
if (nodeIds.size === 0) {
  console.log(`#${issue}: DAG section has no nodes — nothing to recolor.`)
  process.exit(0)
}

// Live state of the direct sub-issues → status class per child number.
const repo = sh('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']).trim()
const subs = JSON.parse(sh('gh', ['api', `repos/${repo}/issues/${issue}/sub_issues`, '--paginate']))
const classOf = new Map()
for (const c of subs) {
  const labels = (c.labels || []).map((l) => l.name)
  classOf.set(
    c.number,
    c.state === 'closed' ? 'done' : labels.includes('in-progress') ? 'inProgress' : 'notStarted',
  )
}

// Group the chart's nodes by recomputed status. A node with no matching sub-issue (chart drifted
// from the children) stays grey rather than vanishing — a full `/dag` re-run fixes structure.
const groups = { done: [], inProgress: [], notStarted: [] }
for (const id of [...nodeIds].sort((a, b) => a - b)) {
  groups[classOf.get(id) || 'notStarted'].push('I' + id)
}
const classBlock = ['done', 'inProgress', 'notStarted']
  .filter((k) => groups[k].length)
  .map((k) => `    class ${groups[k].join(',')} ${k};`)
  .join('\n')

// Drop the existing `class ...;` assignment lines (NOT the `classDef ...;` palette lines) and
// reinsert the rebuilt block immediately after the last classDef.
const lines = section.split('\n')
const isAssign = (l) => /^\s*class\s+/.test(l) && !/^\s*classDef\s+/.test(l)
let lastClassDef = -1
const kept = []
for (const l of lines) {
  if (isAssign(l)) continue
  kept.push(l)
  if (/^\s*classDef\s+/.test(l)) lastClassDef = kept.length - 1
}
if (lastClassDef === -1) {
  console.error(`#${issue}: DAG section has no classDef lines — not a recognized chart; leaving it untouched.`)
  process.exit(1)
}
kept.splice(lastClassDef + 1, 0, classBlock)
const newBody = before + kept.join('\n') + after

if (newBody === body) {
  console.log(`#${issue}: DAG colors already current — no write.`)
  process.exit(0)
}

// Unique temp file: /batch's parallel agents share /tmp, so a fixed path would collide.
const dir = mkdtempSync(join(tmpdir(), 'dag-recolor-'))
const file = join(dir, `issue-${issue}-body.md`)
writeFileSync(file, newBody)
try {
  sh('gh', ['issue', 'edit', issue, '--body-file', file])
} finally {
  try {
    unlinkSync(file)
  } catch {}
}

const counts = `🟩 ${groups.done.length} · 🟨 ${groups.inProgress.length} · ⬜ ${groups.notStarted.length}`
console.log(`#${issue}: DAG recolored (${counts}).`)
