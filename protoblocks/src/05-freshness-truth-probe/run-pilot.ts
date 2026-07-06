#!/usr/bin/env bun
// @ts-nocheck

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

type CaseRow = {
  id: string
  q: string
  tags: string[]
  expectedFreshAfter: string
  category: string
  notes?: string
}

type ProviderStats = {
  status: string
  hits: number
  uniqueContributed: number
  latencyMs: number
  freshness?: {
    support: 'native' | 'post-filter'
    policy: 'strict' | 'balanced' | 'recall'
    kept: number
    keptUndated: number
    keptStale: number
    droppedStale: number
    droppedUndated: number
  }
  error?: { code: string; message: string }
}

type Source = {
  id?: string
  url: string
  title?: string
  snippet?: string
  publishedAt?: string
  freshness?: { confidence: 'native' | 'verified' | 'undated' | 'stale'; providers?: Record<string, string> }
}

type SweepResult = {
  sweepId: string
  query: { q: string; freshness?: { after?: string; before?: string }; freshnessPolicy?: string }
  sources: Source[]
  stats: { totalHits: number; uniqueSources: number; overlapPct: number; providers: Record<string, ProviderStats> }
  cost: { totalUSD: number; byProvider: Record<string, { usd: number; basis: string }> }
  timing: { totalMs: number }
}

const experiment = '05-freshness-truth-probe'
const providers = ['brave', 'exa', 'tavily', 'linkup', 'nimble']
const policies = ['none', 'strict', 'balanced', 'recall'] as const
const runDir = process.argv[2]

if (!runDir) {
  console.error('usage: bun protoblocks/src/05-freshness-truth-probe/run-pilot.ts <run-dir>')
  process.exit(2)
}

const runId = runDir.split('/').filter(Boolean).at(-1) ?? 'unknown-run'
const rawDir = join(runDir, 'raw')
await mkdir(rawDir, { recursive: true })

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

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

function lines(values: unknown[]) {
  return `${values.map((value) => JSON.stringify(value)).join('\n')}\n`
}

const cases = (await readFile(join(runDir, 'cases.jsonl'), 'utf8'))
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line) as CaseRow)

const rows: unknown[] = []
const commandRecords: string[] = []
const callRecords: unknown[] = []

for (const c of cases) {
  for (const provider of providers) {
    for (const policy of policies) {
      console.error(`[${new Date().toISOString()}] ${c.id} ${provider} ${policy}`)
      const args = ['src/cli/main.ts', 'research', c.q, '--providers', provider, '--max', '10', '--timeout', '20000', '--fresh', '--json']
      if (policy !== 'none') args.push('--hours', '24', '--freshness', policy)

      const command = `WIDEBAND_DB=${shellQuote(join(runDir, 'ledger.db'))} bun ${args.map(shellQuote).join(' ')}`
      commandRecords.push(command)

      const started = Date.now()
      const proc = Bun.spawn(['bun', ...args], {
        cwd: process.cwd(),
        env: { ...process.env, WIDEBAND_DB: join(runDir, 'ledger.db') },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
      const timestamp = new Date().toISOString()
      const rawBase = `${c.id}__${provider}__${policy}`
      await writeFile(join(rawDir, `${rawBase}.stdout.json`), stdout)
      await writeFile(join(rawDir, `${rawBase}.stderr.txt`), stderr)

      let parsed: SweepResult | undefined
      try {
        if (stdout.trim()) parsed = JSON.parse(stdout) as SweepResult
      } catch (error) {
        callRecords.push({ caseId: c.id, provider, policy, exitCode, parseError: error instanceof Error ? error.message : String(error) })
      }

      if (!parsed || !parsed.stats?.providers?.[provider]) {
        rows.push({
          runId,
          timestamp,
          experiment,
          caseId: c.id,
          provider,
          query: c.q,
          mode: 'research',
          sources: 0,
          sourceUrls: [],
          costUSD: 0,
          latencyMs: Date.now() - started,
          stats: { policy, command, exitCode, stdoutBytes: stdout.length, stderr },
          metrics: { policy, failureStage: 'cli_or_parse', totalSources: 0 },
          errors: [{ code: 'CLI_PARSE_FAILURE', message: stderr.trim() || 'No parseable provider result', stage: 'provider_call' }],
        })
        continue
      }

      const providerStats = parsed.stats.providers[provider]
      const after = parsed.query.freshness?.after ?? c.expectedFreshAfter
      const before = parsed.query.freshness?.before ?? timestamp
      const visibleCounts = { fresh: 0, stale: 0, undated: 0 }

      for (const source of parsed.sources) {
        const classification = classifyPublishedAt(source.publishedAt, after, before) as keyof typeof visibleCounts
        visibleCounts[classification] += 1
      }

      const cost = parsed.cost.byProvider[provider]?.usd ?? parsed.cost.totalUSD ?? 0
      rows.push({
        runId,
        timestamp,
        experiment,
        caseId: c.id,
        provider,
        query: c.q,
        mode: 'research',
        policy,
        sources: parsed.sources.length,
        sourceUrls: parsed.sources.map((source) => source.url),
        costUSD: cost,
        latencyMs: providerStats.latencyMs ?? parsed.timing.totalMs,
        stats: {
          policy,
          command,
          exitCode,
          sweepId: parsed.sweepId,
          totalHits: parsed.stats.totalHits,
          uniqueSources: parsed.stats.uniqueSources,
          overlapPct: parsed.stats.overlapPct,
          providerStats,
          costBasis: parsed.cost.byProvider[provider]?.basis,
          freshnessWindow: { after, before },
        },
        metrics: {
          policy,
          totalSources: parsed.sources.length,
          keptUndated: providerStats.freshness?.keptUndated ?? null,
          keptStale: providerStats.freshness?.keptStale ?? null,
          droppedStale: providerStats.freshness?.droppedStale ?? null,
          droppedUndated: providerStats.freshness?.droppedUndated ?? null,
          staleVisibleCount: visibleCounts.stale,
          undatedVisibleCount: visibleCounts.undated,
          freshVisibleCount: visibleCounts.fresh,
          staleVisibleRate: parsed.sources.length ? visibleCounts.stale / parsed.sources.length : 0,
          undatedVisibleRate: parsed.sources.length ? visibleCounts.undated / parsed.sources.length : 0,
          freshVisibleRate: parsed.sources.length ? visibleCounts.fresh / parsed.sources.length : 0,
          providerStatus: providerStats.status,
          providerFreshnessSupport: providerStats.freshness?.support ?? null,
        },
        ...(providerStats.error ? { errors: [{ ...providerStats.error, stage: 'provider_call' }] } : {}),
      })

      callRecords.push({ caseId: c.id, provider, policy, exitCode, sources: parsed.sources.length, costUSD: cost })
    }
  }
}

await writeFile(join(runDir, 'commands.log'), `${commandRecords.join('\n')}\n`)
await writeFile(join(runDir, 'call-results.jsonl'), lines(callRecords))
await writeFile(join(runDir, 'rows.jsonl'), lines(rows))

const rowObjs = rows as Array<{
  provider: string
  policy: string
  sources: number
  costUSD: number
  latencyMs: number
  metrics: {
    providerStatus?: string
    staleVisibleCount?: number
    undatedVisibleCount?: number
    freshVisibleCount?: number
    staleVisibleRate?: number
    undatedVisibleRate?: number
    freshVisibleRate?: number
  }
  errors?: unknown[]
}>

const byProviderPolicy: Record<string, unknown> = {}
for (const provider of providers) {
  for (const policy of policies) {
    const subset = rowObjs.filter((row) => row.provider === provider && row.policy === policy)
    const sources = subset.reduce((sum, row) => sum + row.sources, 0)
    const stale = subset.reduce((sum, row) => sum + (row.metrics.staleVisibleCount ?? 0), 0)
    const undated = subset.reduce((sum, row) => sum + (row.metrics.undatedVisibleCount ?? 0), 0)
    const fresh = subset.reduce((sum, row) => sum + (row.metrics.freshVisibleCount ?? 0), 0)
    byProviderPolicy[`${provider}:${policy}`] = {
      rows: subset.length,
      sources,
      statuses: [...new Set(subset.map((row) => row.metrics.providerStatus ?? (row.errors ? 'error' : 'unknown')))],
      costUSD: Number(subset.reduce((sum, row) => sum + row.costUSD, 0).toFixed(6)),
      avgLatencyMs: subset.length ? Math.round(subset.reduce((sum, row) => sum + row.latencyMs, 0) / subset.length) : 0,
      freshVisibleRate: sources ? Number((fresh / sources).toFixed(4)) : 0,
      staleLeakageRate: sources ? Number((stale / sources).toFixed(4)) : 0,
      undatedVisibleRate: sources ? Number((undated / sources).toFixed(4)) : 0,
    }
  }
}

const policyTotals: Record<string, unknown> = {}
for (const policy of policies) {
  const subset = rowObjs.filter((row) => row.policy === policy)
  const sources = subset.reduce((sum, row) => sum + row.sources, 0)
  const stale = subset.reduce((sum, row) => sum + (row.metrics.staleVisibleCount ?? 0), 0)
  const undated = subset.reduce((sum, row) => sum + (row.metrics.undatedVisibleCount ?? 0), 0)
  const fresh = subset.reduce((sum, row) => sum + (row.metrics.freshVisibleCount ?? 0), 0)
  policyTotals[policy] = {
    rows: subset.length,
    sources,
    costUSD: Number(subset.reduce((sum, row) => sum + row.costUSD, 0).toFixed(6)),
    freshVisibleRate: sources ? Number((fresh / sources).toFixed(4)) : 0,
    staleLeakageRate: sources ? Number((stale / sources).toFixed(4)) : 0,
    undatedVisibleRate: sources ? Number((undated / sources).toFixed(4)) : 0,
  }
}

const summary = {
  runId,
  experiment,
  providerSetName: 'Freshness-Capable',
  providers,
  policies,
  caseCount: cases.length,
  callCount: rowObjs.length,
  costUSD: Number(rowObjs.reduce((sum, row) => sum + row.costUSD, 0).toFixed(6)),
  mainMetrics: {
    policyTotals,
    byProviderPolicy,
    errorRows: rowObjs.filter((row) => row.errors?.length).length,
  },
  examplesChangedInterpretation: rowObjs
    .filter((row) => row.sources > 0)
    .sort(
      (a, b) =>
        (b.metrics.staleVisibleCount ?? 0) + (b.metrics.undatedVisibleCount ?? 0) - ((a.metrics.staleVisibleCount ?? 0) + (a.metrics.undatedVisibleCount ?? 0)),
    )
    .slice(0, 3)
    .map((row) => ({
      provider: row.provider,
      policy: row.policy,
      sources: row.sources,
      staleVisibleCount: row.metrics.staleVisibleCount,
      undatedVisibleCount: row.metrics.undatedVisibleCount,
      freshVisibleCount: row.metrics.freshVisibleCount,
    })),
  projectChangesJustified: 'needs_more_data',
}

await writeFile(join(runDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
console.log(JSON.stringify(summary, null, 2))
