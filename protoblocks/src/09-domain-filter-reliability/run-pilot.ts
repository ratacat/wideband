#!/usr/bin/env bun
// @ts-nocheck

import { spawnSync } from 'node:child_process'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { wideband, type SweepResult } from '../../../src/index'

const experiment = '09-domain-filter-reliability'
const providerSetName = 'Domain-Filter Capable'
const providers = ['exa', 'tavily', 'linkup', 'nimble']
const maxResults = 10
const timeoutMs = 20_000
const pass = 'pilot'

type TestCase = {
  id: string
  q: string
  tags: string[]
  includeDomains: string[]
  expectedDomains: string[]
  expectedPathTerms: string[]
  category: string
  notes: string
}

type Row = {
  runId: string
  timestamp: string
  experiment: string
  caseId: string
  provider: string
  query: string
  mode: 'research'
  constrained: boolean
  includeDomains: string[]
  sources: number
  sourceUrls: string[]
  costUSD: number
  latencyMs: number
  stats: Record<string, unknown>
  metrics: Record<string, unknown>
  errors?: Array<{ code: string; message: string; stage: string }>
}

type PairMetrics = {
  totalSources: number
  onDomainSources: number
  offDomainSources: number
  expectedPathHits: number
  offDomainUrls: string[]
  complianceRate: number | null
  expectedPathHitRate: number | null
}

const cases: TestCase[] = [
  {
    id: 'case-001-sec-apple-10k',
    q: 'Apple 2025 Form 10-K SEC official filing 0000320193',
    tags: ['regulator', 'company-filing', 'official-domain'],
    includeDomains: ['sec.gov'],
    expectedDomains: ['sec.gov'],
    expectedPathTerms: ['edgar', 'archives', 'data', '0000320193', '10-k'],
    category: 'regulator',
    notes: 'Known SEC EDGAR filing target for a public-company annual report.',
  },
  {
    id: 'case-002-fifa-2026-schedule',
    q: '2026 FIFA World Cup match schedule official',
    tags: ['sports', 'league', 'official-domain'],
    includeDomains: ['fifa.com'],
    expectedDomains: ['fifa.com'],
    expectedPathTerms: ['world-cup', 'matches', 'schedule', '2026'],
    category: 'sports-league',
    notes: 'Official tournament schedule should resolve to fifa.com pages.',
  },
  {
    id: 'case-003-ethereum-json-rpc-docs',
    q: 'Ethereum JSON-RPC API official documentation',
    tags: ['crypto', 'protocol-docs', 'official-domain'],
    includeDomains: ['ethereum.org'],
    expectedDomains: ['ethereum.org'],
    expectedPathTerms: ['developers', 'docs', 'apis', 'json-rpc'],
    category: 'crypto-protocol-docs',
    notes: 'Official Ethereum developer documentation target.',
  },
  {
    id: 'case-004-nvidia-q1-fy2026-results',
    q: 'NVIDIA Q1 fiscal 2026 results official investor relations',
    tags: ['company', 'investor-relations', 'official-domain'],
    includeDomains: ['nvidia.com'],
    expectedDomains: ['nvidia.com'],
    expectedPathTerms: ['investor', 'news', 'results', 'quarterly'],
    category: 'company-investor-relations',
    notes: 'Official NVIDIA investor relations earnings-result page target.',
  },
]

function isoCompact(date: Date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

function jsonLine(value: unknown) {
  return `${JSON.stringify(value)}\n`
}

function jsonLines(values: unknown[]) {
  return values.map(jsonLine).join('')
}

function shellQuote(value: string) {
  if (/^[A-Za-z0-9_./:=,@+-]+$/.test(value)) return value
  return `'${value.replaceAll("'", "'\\''")}'`
}

function round(value: number, places = 6) {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}

function hostWithoutWww(url: string) {
  return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
}

function domainMatches(url: string, domains: string[]) {
  try {
    const host = hostWithoutWww(url)
    return domains.some((raw) => {
      const domain = raw.toLowerCase().replace(/^www\./, '')
      return host === domain || host.endsWith(`.${domain}`)
    })
  } catch {
    return false
  }
}

function pathTermMatches(url: string, terms: string[]) {
  if (!terms.length) return false
  try {
    const parsed = new URL(url)
    const haystack = `${parsed.pathname} ${parsed.search}`.toLowerCase()
    return terms.some((term) => haystack.includes(term.toLowerCase()))
  } catch {
    return false
  }
}

function sourceUrls(result: SweepResult | undefined) {
  return result?.sources.map((source) => source.url).filter((url): url is string => Boolean(url)) ?? []
}

function rowKey(caseId: string, provider: string, constrained: boolean) {
  return `${caseId}::${provider}::${constrained ? 'constrained' : 'unconstrained'}`
}

function measure(urls: string[], testCase: TestCase): PairMetrics {
  const onDomainUrls = urls.filter((url) => domainMatches(url, testCase.includeDomains))
  const offDomainUrls = urls.filter((url) => !domainMatches(url, testCase.includeDomains))
  const expectedPathHits = urls.filter((url) => domainMatches(url, testCase.includeDomains) && pathTermMatches(url, testCase.expectedPathTerms)).length
  return {
    totalSources: urls.length,
    onDomainSources: onDomainUrls.length,
    offDomainSources: offDomainUrls.length,
    expectedPathHits,
    offDomainUrls,
    complianceRate: urls.length ? round(onDomainUrls.length / urls.length) : null,
    expectedPathHitRate: urls.length ? round(expectedPathHits / urls.length) : null,
  }
}

function requiredRowCheck(row: Row) {
  for (const key of ['runId', 'timestamp', 'experiment', 'caseId', 'provider', 'query', 'mode', 'sources', 'costUSD', 'latencyMs', 'stats', 'metrics'] as const) {
    if (!(key in row)) throw new Error(`row missing ${key}`)
  }
  if (!row.runId || !row.experiment || !row.caseId || !row.provider) throw new Error('row has empty required string')
  if (Number.isNaN(Date.parse(row.timestamp))) throw new Error(`row timestamp is not date-time: ${row.timestamp}`)
  if (row.mode !== 'research') throw new Error('row mode must be research')
  if (!Number.isInteger(row.sources) || row.sources < 0) throw new Error('row sources must be a non-negative integer')
  if (typeof row.costUSD !== 'number' || row.costUSD < 0) throw new Error('row costUSD must be a non-negative number')
  if (!Number.isInteger(row.latencyMs) || row.latencyMs < 0) throw new Error('row latencyMs must be a non-negative integer')
}

function statusCounts(rows: Row[]) {
  const counts: Record<string, number> = {}
  for (const row of rows) {
    const status = typeof row.metrics.providerStatus === 'string' ? row.metrics.providerStatus : row.errors?.[0]?.code ?? 'unknown'
    counts[status] = (counts[status] ?? 0) + 1
  }
  return counts
}

function aggregate(rows: Row[], constrained: boolean) {
  const subset = rows.filter((row) => row.constrained === constrained)
  const sources = subset.reduce((sum, row) => sum + row.sources, 0)
  const onDomain = subset.reduce((sum, row) => sum + Number(row.metrics.onDomainSources ?? 0), 0)
  const offDomain = subset.reduce((sum, row) => sum + Number(row.metrics.offDomainSources ?? 0), 0)
  const expectedPathHits = subset.reduce((sum, row) => sum + Number(row.metrics.expectedPathHits ?? 0), 0)
  return {
    rows: subset.length,
    successfulRows: subset.filter((row) => row.metrics.providerStatus === 'ok').length,
    failedRows: subset.filter((row) => row.metrics.providerStatus !== 'ok').length,
    sources,
    onDomain,
    offDomain,
    expectedPathHits,
    complianceRate: sources ? round(onDomain / sources) : null,
    expectedPathHitRate: sources ? round(expectedPathHits / sources) : null,
  }
}

function average(values: Array<number | null | undefined>) {
  const usable = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  if (!usable.length) return null
  return round(usable.reduce((sum, value) => sum + value, 0) / usable.length)
}

function byProvider(rows: Row[]) {
  const result: Record<string, unknown> = {}
  for (const provider of providers) {
    const providerRows = rows.filter((row) => row.provider === provider)
    const constrained = aggregate(providerRows, true)
    const unconstrained = aggregate(providerRows, false)
    result[provider] = {
      rows: providerRows.length,
      statusCounts: statusCounts(providerRows),
      constrained,
      unconstrained,
      precisionGainAvg: average(providerRows.filter((row) => row.constrained).map((row) => row.metrics.precisionGain as number | null | undefined)),
      recallRatioAvg: average(providerRows.filter((row) => row.constrained).map((row) => row.metrics.recallRatioOnDomain as number | null | undefined)),
      costUSD: round(providerRows.reduce((sum, row) => sum + row.costUSD, 0)),
    }
  }
  return result
}

function leakageExamples(rows: Row[], limit = 10, constrainedOnly = true) {
  const examples: Array<{ caseId: string; provider: string; constrained: boolean; url: string }> = []
  for (const row of rows.filter((candidate) => !constrainedOnly || candidate.constrained)) {
    const offDomainUrls = row.metrics.offDomainUrls
    if (!Array.isArray(offDomainUrls)) continue
    for (const url of offDomainUrls) {
      if (typeof url === 'string') examples.push({ caseId: row.caseId, provider: row.provider, constrained: row.constrained, url })
      if (examples.length >= limit) return examples
    }
  }
  return examples
}

function difficultDomains(rows: Row[]) {
  const constrainedRows = rows.filter((row) => row.constrained)
  return constrainedRows
    .filter((row) => row.metrics.providerStatus !== 'ok' || Number(row.metrics.onDomainSources ?? 0) === 0 || Number(row.metrics.expectedPathHits ?? 0) === 0)
    .map((row) => ({
      caseId: row.caseId,
      provider: row.provider,
      includeDomains: row.includeDomains,
      status: row.metrics.providerStatus,
      onDomainSources: row.metrics.onDomainSources,
      expectedPathHits: row.metrics.expectedPathHits,
    }))
}

function interpretationExamples(rows: Row[]) {
  const constrainedRows = rows.filter((row) => row.constrained)
  const byPrecision = [...constrainedRows]
    .filter((row) => typeof row.metrics.precisionGain === 'number')
    .sort((a, b) => Number(b.metrics.precisionGain) - Number(a.metrics.precisionGain))[0]
  const byRecallLoss = [...constrainedRows]
    .filter((row) => typeof row.metrics.recallLossOnDomain === 'number')
    .sort((a, b) => Number(b.metrics.recallLossOnDomain) - Number(a.metrics.recallLossOnDomain))[0]
  const leakage = constrainedRows.find((row) => Number(row.metrics.offDomainSources ?? 0) > 0)

  return [
    byPrecision
      ? {
          type: 'largest_precision_gain',
          caseId: byPrecision.caseId,
          provider: byPrecision.provider,
          precisionGain: byPrecision.metrics.precisionGain,
          constrainedComplianceRate: byPrecision.metrics.complianceRate,
          baselineComplianceRate: byPrecision.metrics.baselineComplianceRate,
        }
      : { type: 'largest_precision_gain', note: 'No comparable successful constrained rows.' },
    byRecallLoss
      ? {
          type: 'largest_on_domain_recall_loss',
          caseId: byRecallLoss.caseId,
          provider: byRecallLoss.provider,
          recallLossOnDomain: byRecallLoss.metrics.recallLossOnDomain,
          baselineOnDomainSources: byRecallLoss.metrics.baselineOnDomainSources,
          constrainedOnDomainSources: byRecallLoss.metrics.onDomainSources,
        }
      : { type: 'largest_on_domain_recall_loss', note: 'No comparable successful constrained rows.' },
    leakage
      ? {
          type: 'constrained_off_domain_leakage',
          caseId: leakage.caseId,
          provider: leakage.provider,
          offDomainSources: leakage.metrics.offDomainSources,
          exampleUrl: Array.isArray(leakage.metrics.offDomainUrls) ? leakage.metrics.offDomainUrls[0] : undefined,
        }
      : { type: 'constrained_off_domain_leakage', note: 'No constrained off-domain leakage observed in pilot.' },
  ]
}

async function main() {
  const runId = process.env.RUN_ID || `${isoCompact(new Date())}-${experiment}-pilot`
  const runDir = join('protoblocks', 'src', experiment, 'runs', runId)
  const rawDir = join(runDir, 'raw')
  const ledgerPath = join(runDir, 'ledger.db')
  const commands: string[] = []
  const callRecords: unknown[] = []

  await mkdir(rawDir, { recursive: true })

  await writeFile(join(runDir, 'cases.jsonl'), jsonLines(cases))
  await writeFile(
    join(runDir, 'sampling.md'),
    [
      `# Sampling - ${runId}`,
      '',
      `- Source: fixed ${cases.length}-case pilot seed list embedded in \`protoblocks/src/${experiment}/run-pilot.ts\`.`,
      `- Sampled: ${new Date().toISOString()} UTC.`,
      '- Filters: known target domains with one include domain per case.',
      `- Case cap: ${cases.length}.`,
      '- Exclusions: remaining categories from the 60-case full-run design.',
      '- Provider calls are made only after this `cases.jsonl` snapshot is written.',
      '',
    ].join('\n'),
  )

  const providersCommand = `WIDEBAND_DB=${shellQuote(ledgerPath)} bun src/cli/main.ts providers --json`
  commands.push(providersCommand)
  const providersRun = spawnSync('bun', ['src/cli/main.ts', 'providers', '--json'], {
    cwd: process.cwd(),
    env: { ...process.env, WIDEBAND_DB: ledgerPath },
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 10,
  })
  await writeFile(join(runDir, 'providers.json'), providersRun.stdout ?? '')
  await writeFile(join(rawDir, 'providers.stderr.txt'), providersRun.stderr ?? '')

  const wb = wideband({ db: ledgerPath })
  const rows: Row[] = []
  const rowMetrics = new Map<string, PairMetrics>()

  try {
    for (const testCase of cases) {
      for (const provider of providers) {
        for (const constrained of [false, true]) {
          const searchMode = constrained ? 'constrained' : 'unconstrained'
          const queryInput = {
            q: testCase.q,
            max: maxResults,
            ...(constrained ? { domains: { include: testCase.includeDomains } } : {}),
          }
          const sweepOptions = { providers: [provider], fresh: true, timeoutMs, capture: true }
          const pseudoCommand = `SDK wb.research(${JSON.stringify(queryInput)}, ${JSON.stringify(sweepOptions)})`
          commands.push(pseudoCommand)
          console.error(`[${new Date().toISOString()}] ${testCase.id} ${provider} ${searchMode}`)

          const started = Date.now()
          const timestamp = new Date().toISOString()
          const rawBase = `${testCase.id}__${provider}__${searchMode}`

          try {
            const result = await wb.research(queryInput, sweepOptions)
            await writeFile(join(rawDir, `${rawBase}.json`), JSON.stringify(result, null, 2))

            const providerStats = result.stats.providers[provider]
            const urls = sourceUrls(result)
            const measured = measure(urls, testCase)
            rowMetrics.set(rowKey(testCase.id, provider, constrained), measured)
            const cost = result.cost.byProvider[provider]?.usd ?? result.cost.totalUSD ?? 0

            const row: Row = {
              runId,
              timestamp,
              experiment,
              caseId: testCase.id,
              provider,
              query: testCase.q,
              mode: 'research',
              constrained,
              includeDomains: testCase.includeDomains,
              sources: urls.length,
              sourceUrls: urls,
              costUSD: cost,
              latencyMs: providerStats?.latencyMs ?? result.timing.totalMs,
              stats: {
                searchMode,
                sweepId: result.sweepId,
                totalHits: result.stats.totalHits,
                uniqueSources: result.stats.uniqueSources,
                overlapPct: result.stats.overlapPct,
                providerStats,
                costBasis: result.cost.byProvider[provider]?.basis,
                queryInput,
                sweepOptions,
                exactSweepOptions: 'providers one at a time; fresh=true; timeoutMs=20000; capture=true; max=10; domains.include only in constrained mode',
              },
              metrics: {
                searchMode,
                constrained,
                includeDomains: testCase.includeDomains,
                expectedPathTerms: testCase.expectedPathTerms,
                totalSources: measured.totalSources,
                onDomainSources: measured.onDomainSources,
                offDomainSources: measured.offDomainSources,
                expectedPathHits: measured.expectedPathHits,
                offDomainUrls: measured.offDomainUrls,
                complianceRate: measured.complianceRate,
                expectedPathHitRate: measured.expectedPathHitRate,
                costPerOnDomainSource: measured.onDomainSources ? round(cost / measured.onDomainSources) : null,
                providerStatus: providerStats?.status ?? 'unknown',
              },
              ...(providerStats?.error ? { errors: [{ ...providerStats.error, stage: 'provider_call' }] } : {}),
            }
            rows.push(row)
            callRecords.push({ caseId: testCase.id, provider, constrained, status: providerStats?.status ?? 'unknown', sources: urls.length, costUSD: cost })
          } catch (error) {
            const latencyMs = Date.now() - started
            const message = error instanceof Error ? error.message : String(error)
            await writeFile(join(rawDir, `${rawBase}.error.json`), JSON.stringify({ message, error }, null, 2))
            const empty = measure([], testCase)
            rowMetrics.set(rowKey(testCase.id, provider, constrained), empty)
            rows.push({
              runId,
              timestamp,
              experiment,
              caseId: testCase.id,
              provider,
              query: testCase.q,
              mode: 'research',
              constrained,
              includeDomains: testCase.includeDomains,
              sources: 0,
              sourceUrls: [],
              costUSD: 0,
              latencyMs,
              stats: {
                searchMode,
                queryInput,
                sweepOptions,
                error: { code: 'sdk_call_failed', message },
                exactSweepOptions: 'providers one at a time; fresh=true; timeoutMs=20000; capture=true; max=10; domains.include only in constrained mode',
              },
              metrics: {
                searchMode,
                constrained,
                includeDomains: testCase.includeDomains,
                expectedPathTerms: testCase.expectedPathTerms,
                totalSources: 0,
                onDomainSources: 0,
                offDomainSources: 0,
                expectedPathHits: 0,
                offDomainUrls: [],
                complianceRate: null,
                expectedPathHitRate: null,
                costPerOnDomainSource: null,
                providerStatus: 'error',
                failureStage: 'provider_call',
              },
              errors: [{ code: 'sdk_call_failed', message, stage: 'provider_call' }],
            })
            callRecords.push({ caseId: testCase.id, provider, constrained, status: 'error', sources: 0, costUSD: 0, error: message })
          }
        }
      }
    }
  } finally {
    wb.close()
  }

  for (const row of rows) {
    if (!row.constrained) continue
    const baseline = rowMetrics.get(rowKey(row.caseId, row.provider, false))
    const current = rowMetrics.get(rowKey(row.caseId, row.provider, true))
    if (!baseline || !current) continue
    const baselineComplianceRate = baseline.complianceRate
    const precisionGain =
      typeof current.complianceRate === 'number' && typeof baselineComplianceRate === 'number' ? round(current.complianceRate - baselineComplianceRate) : null
    const recallRatioOnDomain = baseline.onDomainSources ? round(current.onDomainSources / baseline.onDomainSources) : null
    Object.assign(row.metrics, {
      baselineSources: baseline.totalSources,
      baselineOnDomainSources: baseline.onDomainSources,
      baselineOffDomainSources: baseline.offDomainSources,
      baselineComplianceRate,
      recallLossOnDomain: Math.max(0, baseline.onDomainSources - current.onDomainSources),
      recallDeltaOnDomain: current.onDomainSources - baseline.onDomainSources,
      recallRatioOnDomain,
      precisionGain,
    })
  }

  for (const row of rows) requiredRowCheck(row)

  await writeFile(join(runDir, 'rows.jsonl'), jsonLines(rows))
  await writeFile(join(runDir, 'call-results.jsonl'), jsonLines(callRecords))
  await writeFile(join(runDir, 'commands.log'), `${commands.join('\n')}\n`)

  const constrainedAgg = aggregate(rows, true)
  const unconstrainedAgg = aggregate(rows, false)
  const totalCost = round(rows.reduce((sum, row) => sum + row.costUSD, 0))
  const successfulRows = rows.filter((row) => row.metrics.providerStatus === 'ok').length
  const failedRows = rows.length - successfulRows
  const leaks = leakageExamples(rows)
  const baselineOffDomainExamples = leakageExamples(rows, 10, false).filter((example) => !example.constrained)
  const summary = {
    runId,
    experiment,
    pass,
    providerSetName,
    providersRequested: providers,
    providersUsed: providers,
    caseCount: cases.length,
    callCount: rows.length,
    plannedCalls: cases.length * providers.length * 2,
    costUSD: totalCost,
    sweepOptions: {
      sdkPath: true,
      fresh: true,
      timeoutMs,
      capture: true,
      maxResults,
      modes: ['unconstrained', 'constrained-domains-include'],
      constrainedDomainsField: 'domains.include',
    },
    mainMetrics: {
      statusCounts: statusCounts(rows),
      successfulRows,
      failedRows,
      constrained: constrainedAgg,
      unconstrained: unconstrainedAgg,
      complianceGain: typeof constrainedAgg.complianceRate === 'number' && typeof unconstrainedAgg.complianceRate === 'number' ? round(constrainedAgg.complianceRate - unconstrainedAgg.complianceRate) : null,
      offDomainLeakageExamples: leaks,
      offDomainLeakageExampleCount: leaks.length,
      baselineOffDomainExamples,
      difficultDomains: difficultDomains(rows),
      byProvider: byProvider(rows),
    },
    examplesThatChangedInterpretation: interpretationExamples(rows),
    projectChangesJustified: failedRows ? 'needs_more_data' : 'needs_more_data',
  }
  await writeFile(join(runDir, 'summary.json'), JSON.stringify(summary, null, 2))

  const notes = [
    `# Notes - ${runId}`,
    '',
    `- Provider set: ${providerSetName} (${providers.join(', ')}).`,
    `- Exact sweep options: SDK \`wb.research\`, one provider per call, \`fresh: true\`, \`timeoutMs: ${timeoutMs}\`, \`capture: true\`, \`max: ${maxResults}\`.`,
    '- Modes: unconstrained baseline and constrained `domains.include` using the case target domain.',
    '- The current CLI does not expose `domains.include`, so this used the SDK path as directed by the protoblock.',
    '- `cases.jsonl` was written before `providers.json` and before any provider calls.',
    `- Total calls: ${rows.length}; successful rows: ${successfulRows}; failed rows: ${failedRows}; reported/estimated cost: $${totalCost.toFixed(6)}.`,
    `- Constrained compliance: ${constrainedAgg.complianceRate ?? 'n/a'}; unconstrained compliance: ${unconstrainedAgg.complianceRate ?? 'n/a'}.`,
    `- Constrained off-domain leakage examples captured: ${leaks.length}.`,
    '- No adapter or core code was changed during this pilot.',
    '',
  ].join('\n')
  await writeFile(join(runDir, 'notes.md'), notes)

  const commit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  })
  const commitNote = commit.status === 0 ? commit.stdout.trim() : 'uncommitted/no git commit available'
  const resultEntry = [
    '',
    `### ${new Date().toISOString().slice(0, 10)} - Codex - ${runId}`,
    '',
    `- Commit/worktree: ${commitNote}; workspace had untracked files before this run.`,
    `- Commands: \`bun protoblocks/src/${experiment}/run-pilot.ts\`; internal snapshot command \`${providersCommand}\`; SDK sweeps recorded in \`${runDir}/commands.log\`.`,
    `- Providers: ${providers.join(', ')} (${providerSetName}).`,
    `- Dataset: ${cases.length} fixed pilot cases with one include domain each; sampled from embedded seed list; case cap ${cases.length}.`,
    `- Cost: $${totalCost.toFixed(6)} reported/estimated.`,
    `- Key metrics: ${successfulRows}/${rows.length} successful rows; constrained compliance ${constrainedAgg.complianceRate ?? 'n/a'} vs unconstrained ${unconstrainedAgg.complianceRate ?? 'n/a'}; constrained expected-path hit rate ${constrainedAgg.expectedPathHitRate ?? 'n/a'}; off-domain leakage examples captured ${leaks.length}.`,
    `- Interpretation: pilot data is enough to exercise the measurement path; ${failedRows ? 'provider failures mean the next run should diagnose health before expanding.' : 'use the full sample before changing defaults.'}`,
    '- Follow-up: run the 60-case full sample after reviewing leakage/difficult-domain rows.',
    '- Project change justified: needs_more_data',
    '',
  ].join('\n')
  await appendFile(`protoblocks/${experiment}.md`, resultEntry)

  console.log(JSON.stringify({ runId, runDir, rows: rows.length, costUSD: totalCost, summary: join(runDir, 'summary.json') }, null, 2))
}

await main()
