#!/usr/bin/env bun
// @ts-nocheck

import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

type Source = {
  id?: string
  url: string
  title?: string
  snippet?: string
  publishedAt?: string
  freshness?: { confidence?: string }
}

const runDir = process.argv[2]
if (!runDir) {
  console.error('usage: bun protoblocks/src/05-freshness-truth-probe/make-audit-sample.ts <run-dir>')
  process.exit(2)
}

const cases = Object.fromEntries(
  (await readFile(join(runDir, 'cases.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const row = JSON.parse(line) as { id: string; expectedFreshAfter: string; category: string; q: string }
      return [row.id, row]
    }),
)

function classifyPublishedAt(publishedAt: string | undefined, after: string | undefined, before: string | undefined) {
  if (!publishedAt) return 'undated'
  const published = Date.parse(publishedAt)
  if (Number.isNaN(published)) return 'undated'
  if (after) {
    const afterMs = Date.parse(after)
    if (!Number.isNaN(afterMs) && published < afterMs) return 'stale'
  }
  if (before) {
    const beforeMs = Date.parse(before)
    if (!Number.isNaN(beforeMs) && published > beforeMs) return 'stale'
  }
  return 'fresh'
}

const rawDir = join(runDir, 'raw')
const files = (await readdir(rawDir)).filter((name) => name.endsWith('.stdout.json')).sort()
const buckets = new Map<string, unknown[]>()

for (const file of files) {
  const [caseId, provider, policyWithSuffix] = file.split('__')
  const policy = policyWithSuffix.replace('.stdout.json', '')
  const key = `${provider}:${policy}`

  const parsed = JSON.parse(await readFile(join(rawDir, file), 'utf8')) as {
    query?: { freshness?: { after?: string; before?: string } }
    sources?: Source[]
  }
  const c = cases[caseId]
  const after = parsed.query?.freshness?.after ?? c.expectedFreshAfter
  const before = parsed.query?.freshness?.before ?? new Date().toISOString()

  for (const [index, source] of (parsed.sources ?? []).entries()) {
    const rows = buckets.get(key) ?? []
    rows.push({
      sourceId: source.id ?? `${caseId}-${provider}-${policy}-${index}`,
      caseId,
      provider,
      policy,
      query: c.q,
      category: c.category,
      rank: index + 1,
      url: source.url,
      title: source.title ?? '',
      snippet: source.snippet ?? '',
      publishedAt: source.publishedAt ?? null,
      dateClass: classifyPublishedAt(source.publishedAt, after, before),
      freshnessConfidence: source.freshness?.confidence ?? null,
    })
    buckets.set(key, rows)
  }
}

const selected: unknown[] = []
for (const rows of buckets.values()) {
  const byCase = new Map<string, unknown[]>()
  for (const row of rows as Array<{ caseId: string }>) {
    const caseRows = byCase.get(row.caseId) ?? []
    caseRows.push(row)
    byCase.set(row.caseId, caseRows)
  }
  while (selected.length < 100 && selected.filter((row) => `${(row as { provider: string }).provider}:${(row as { policy: string }).policy}` === `${(rows[0] as { provider: string }).provider}:${(rows[0] as { policy: string }).policy}`).length < 5) {
    let added = false
    for (const caseRows of byCase.values()) {
      const currentKey = `${(rows[0] as { provider: string }).provider}:${(rows[0] as { policy: string }).policy}`
      const currentCount = selected.filter((row) => `${(row as { provider: string }).provider}:${(row as { policy: string }).policy}` === currentKey).length
      if (currentCount >= 5) break
      const next = caseRows.shift()
      if (next) {
        selected.push(next)
        added = true
      }
    }
    if (!added) break
  }
}

await writeFile(join(runDir, 'audit-sample.jsonl'), `${selected.map((row) => JSON.stringify(row)).join('\n')}\n`)
console.log(`wrote ${selected.length} audit samples`)
