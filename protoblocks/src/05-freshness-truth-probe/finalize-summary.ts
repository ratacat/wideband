#!/usr/bin/env bun
// @ts-nocheck

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

type Label = {
  provider: string
  policy: string
  dateClass: 'fresh' | 'stale' | 'undated'
  useful: boolean
  relevant: boolean
  freshnessRelevance: string
}

const runDir = process.argv[2]
if (!runDir) {
  console.error('usage: bun protoblocks/src/05-freshness-truth-probe/finalize-summary.ts <run-dir>')
  process.exit(2)
}

const summaryPath = join(runDir, 'summary.json')
const summary = JSON.parse(await readFile(summaryPath, 'utf8'))
const labels = (await readFile(join(runDir, 'manual-labels.jsonl'), 'utf8'))
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line) as Label)

function rate(numerator: number, denominator: number) {
  return denominator ? Number((numerator / denominator).toFixed(4)) : 0
}

function metricsFor(subset: Label[]) {
  const freshRelevant = subset.filter((label) => label.freshnessRelevance === 'fresh_relevant').length
  const staleRelevant = subset.filter((label) => label.freshnessRelevance === 'stale_relevant').length
  const undatedRelevant = subset.filter((label) => label.freshnessRelevance === 'undated_relevant').length
  const useful = subset.filter((label) => label.useful).length
  const freshUseful = subset.filter((label) => label.dateClass === 'fresh' && label.useful).length
  const staleUseful = subset.filter((label) => label.dateClass === 'stale' && label.useful).length
  const undatedUseful = subset.filter((label) => label.dateClass === 'undated' && label.useful).length
  const undatedTotal = subset.filter((label) => label.dateClass === 'undated').length
  return {
    audited: subset.length,
    useful,
    usefulRate: rate(useful, subset.length),
    freshRelevant,
    freshRelevantRate: rate(freshRelevant, subset.length),
    freshUseful,
    freshUsefulRate: rate(freshUseful, subset.length),
    staleRelevant,
    staleUseful,
    staleRelevantRate: rate(staleRelevant, subset.length),
    undatedRelevant,
    undatedUseful,
    undatedUsefulRate: rate(undatedUseful, undatedTotal),
    undatedTotal,
  }
}

const byPolicy = Object.fromEntries(
  [...new Set(labels.map((label) => label.policy))]
    .sort()
    .map((policy) => [policy, metricsFor(labels.filter((label) => label.policy === policy))]),
)

const byProviderPolicy = Object.fromEntries(
  [...new Set(labels.map((label) => `${label.provider}:${label.policy}`))]
    .sort()
    .map((key) => {
      const [provider, policy] = key.split(':')
      return [key, metricsFor(labels.filter((label) => label.provider === provider && label.policy === policy))]
    }),
)

summary.manualAudit = {
  method: '100 sampled sources: first round-robin visible sources, 5 per provider-policy pair, manually judged from title/url/snippet/date using USEFUL_SOURCE_RUBRIC.md.',
  totals: metricsFor(labels),
  byPolicy,
  byProviderPolicy,
}

summary.recommendations = {
  timeSensitiveResearch: 'strict, but trust dated freshness mainly for brave and exa in this pilot; tavily/linkup/nimble strict still surfaced undated results.',
  broadRecallResearch: 'strict among the tested freshness policies; recall did not add useful audited sources in this pilot and introduced one stale visible source.',
  polymarketResolutionSourceResearch: 'no 24h freshness baseline or recall-with-audit; the only sampled official Fed source appeared in the no-freshness baseline, so a 24h policy can hide stable official pages.',
}

summary.measurementCaveats = [
  'Native freshness providers keep undated results even when policy is strict, so strict is not equivalent to dated-only freshness for tavily/linkup/nimble.',
  'One Exa recall source was classified stale because its provider timestamp was milliseconds after the CLI before timestamp.',
  'The pilot used only 3 cases, so recommendations are directional and projectChangesJustified remains needs_more_data.',
]

summary.projectChangesJustified = 'needs_more_data'

await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`)
console.log('updated summary.json')
