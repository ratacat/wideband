#!/usr/bin/env bun
// @ts-nocheck
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const experiment = '06-leave-one-provider-out'
const providerSet = ['brave', 'exa', 'tavily', 'searchx']
const maxResults = 10
const timeoutMs = 20_000

type TestCase = {
  id: string
  q: string
  tags: string[]
  expectedDomains?: string[]
  notes?: string
}

type SourceLike = {
  id?: string
  url?: string
  title?: string
  snippet?: string
  providers?: string[]
}

type SweepLike = {
  sweepId?: string
  sources?: SourceLike[]
  stats?: {
    totalHits?: number
    uniqueSources?: number
    overlapPct?: number
    providers?: Record<string, { status?: string; hits?: number; uniqueContributed?: number; latencyMs?: number; error?: { code: string; message: string } }>
  }
  cost?: {
    totalUSD?: number
    byProvider?: Record<string, { usd?: number; basis?: string }>
  }
  timing?: { totalMs?: number }
}

type CliRun = {
  label: string
  command: string
  exitCode: number
  elapsedMs: number
  stdout: string
  stderr: string
  result?: SweepLike
  parseError?: string
}

const cases: TestCase[] = [
  {
    id: 'case-001-polymarket-fed-june-2026',
    q: 'Polymarket Fed interest rate decision June 2026 resolution source FOMC',
    tags: ['polymarket', 'resolution-source', 'official-domain'],
    expectedDomains: ['polymarket.com', 'federalreserve.gov'],
  },
  {
    id: 'case-002-current-news-nvidia-earnings',
    q: 'latest NVIDIA earnings guidance news June 2026 Reuters official',
    tags: ['current-news', 'company-news'],
    expectedDomains: ['reuters.com', 'nvidia.com', 'sec.gov'],
  },
  {
    id: 'case-003-official-bls-employment-may-2026',
    q: 'BLS Employment Situation May 2026 official release',
    tags: ['official-domain', 'labor-data'],
    expectedDomains: ['bls.gov'],
  },
]

function isoCompact(date: Date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

function shellQuote(value: string) {
  if (/^[A-Za-z0-9_./:=,@+-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function jsonLine(value: unknown) {
  return `${JSON.stringify(value)}\n`
}

function roundUSD(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000
}

function roundMetric(value: number) {
  return Math.round(value * 1_000) / 1_000
}

function hostMatches(url: string | undefined, domains: string[] | undefined) {
  if (!url || !domains?.length) return false
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '')
    return domains.some((raw) => {
      const domain = raw.toLowerCase().replace(/^www\./, '')
      return host === domain || host.endsWith(`.${domain}`)
    })
  } catch {
    return false
  }
}

function sourceIds(sources: SourceLike[]) {
  return new Set(sources.map((source) => source.id).filter((id): id is string => typeof id === 'string' && id.length > 0))
}

function urls(sources: SourceLike[]) {
  return sources.map((source) => source.url).filter((url): url is string => typeof url === 'string' && url.length > 0)
}

function providerStatuses(result: SweepLike | undefined) {
  return Object.fromEntries(
    Object.entries(result?.stats?.providers ?? {}).map(([provider, stats]) => [
      provider,
      {
        status: stats.status ?? 'unknown',
        hits: stats.hits ?? 0,
        uniqueContributed: stats.uniqueContributed ?? 0,
        latencyMs: stats.latencyMs ?? 0,
        ...(stats.error ? { error: stats.error } : {}),
      },
    ]),
  )
}

function rowErrors(stage: string, run: CliRun) {
  const errors: { code: string; message: string; stage: string; provider?: string }[] = []
  if (run.parseError) errors.push({ code: 'parse_error', message: run.parseError, stage })
  if (run.exitCode !== 0 && !run.result) {
    errors.push({
      code: 'cli_exit',
      message: run.stderr.trim() || `CLI exited ${run.exitCode}`,
      stage,
    })
  }
  for (const [provider, stats] of Object.entries(run.result?.stats?.providers ?? {})) {
    if (stats.error) errors.push({ ...stats.error, stage, provider })
  }
  return errors
}

function validateRow(row: Record<string, unknown>) {
  const required = ['runId', 'timestamp', 'experiment', 'caseId', 'provider', 'query', 'mode', 'sources', 'costUSD', 'latencyMs', 'stats', 'metrics']
  for (const key of required) {
    if (!(key in row)) throw new Error(`row missing ${key}`)
  }
  if (typeof row.runId !== 'string' || !row.runId) throw new Error('row.runId must be a non-empty string')
  if (typeof row.timestamp !== 'string' || Number.isNaN(Date.parse(row.timestamp))) throw new Error('row.timestamp must be date-time')
  if (typeof row.experiment !== 'string' || !row.experiment) throw new Error('row.experiment must be a non-empty string')
  if (typeof row.caseId !== 'string' || !row.caseId) throw new Error('row.caseId must be a non-empty string')
  if (typeof row.provider !== 'string' || !row.provider) throw new Error('row.provider must be a non-empty string')
  if (typeof row.query !== 'string') throw new Error('row.query must be a string')
  if (row.mode !== 'research') throw new Error('row.mode must be research')
  if (!Number.isInteger(row.sources) || (row.sources as number) < 0) throw new Error('row.sources must be a non-negative integer')
  if (typeof row.costUSD !== 'number' || row.costUSD < 0) throw new Error('row.costUSD must be a non-negative number')
  if (!Number.isInteger(row.latencyMs) || (row.latencyMs as number) < 0) throw new Error('row.latencyMs must be a non-negative integer')
  if (!row.stats || typeof row.stats !== 'object') throw new Error('row.stats must be an object')
  if (!row.metrics || typeof row.metrics !== 'object') throw new Error('row.metrics must be an object')
}

const repoRoot = process.cwd()
const runId = process.env.RUN_ID || `${isoCompact(new Date())}-${experiment}-pilot`
const runDir = join('protoblocks', 'src', experiment, 'runs', runId)
const rawDir = join(runDir, 'raw')
const ledgerPath = join(runDir, 'ledger.db')

mkdirSync(rawDir, { recursive: true })

const commands: string[] = []

function runCli(label: string, args: string[], outFile?: string): CliRun {
  const command = `WIDEBAND_DB=${shellQuote(ledgerPath)} bun ${args.map(shellQuote).join(' ')}`
  commands.push(command)
  const started = Date.now()
  const child = spawnSync('bun', args, {
    cwd: repoRoot,
    env: { ...process.env, WIDEBAND_DB: ledgerPath },
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 50,
  })
  const elapsedMs = Date.now() - started
  const stdout = child.stdout ?? ''
  const stderr = child.stderr ?? ''
  if (outFile) writeFileSync(outFile, stdout)

  const cliRun: CliRun = {
    label,
    command,
    exitCode: child.status ?? 1,
    elapsedMs,
    stdout,
    stderr,
  }

  if (stdout.trim().startsWith('{')) {
    try {
      cliRun.result = JSON.parse(stdout) as SweepLike
    } catch (error) {
      cliRun.parseError = error instanceof Error ? error.message : 'Unable to parse JSON stdout'
    }
  }
  return cliRun
}

writeFileSync(join(runDir, 'cases.jsonl'), cases.map(jsonLine).join(''))
writeFileSync(
  join(runDir, 'sampling.md'),
  [
    `# Sampling - ${runId}`,
    '',
    `- Source: fixed 3-case pilot seed list embedded in \`protoblocks/src/${experiment}/run-pilot.ts\`.`,
    `- Sampled: ${new Date().toISOString()} UTC.`,
    '- Filters: mixed benchmark, one Polymarket-style resolution-source case, one current-news case, one official-domain case.',
    '- Case cap: 3.',
    '- Exclusions: full benchmark categories beyond pilot cap.',
    '',
  ].join('\n'),
)

const providersRun = runCli('providers', ['src/cli/main.ts', 'providers', '--json'], join(runDir, 'providers.json'))
writeFileSync(join(rawDir, 'providers.stderr.txt'), providersRun.stderr)

const researchRuns: CliRun[] = []
const rows: Record<string, unknown>[] = []

for (const testCase of cases) {
  const baseline = runCli(`${testCase.id}:baseline`, [
    'src/cli/main.ts',
    'research',
    testCase.q,
    '--providers',
    providerSet.join(','),
    '--max',
    String(maxResults),
    '--timeout',
    String(timeoutMs),
    '--fresh',
    '--json',
  ])
  researchRuns.push(baseline)
  writeFileSync(join(rawDir, `${testCase.id}__baseline.stdout.json`), baseline.stdout)
  writeFileSync(join(rawDir, `${testCase.id}__baseline.stderr.txt`), baseline.stderr)

  for (const excludedProvider of providerSet) {
    const minusProviders = providerSet.filter((provider) => provider !== excludedProvider)
    const minus = runCli(`${testCase.id}:minus-${excludedProvider}`, [
      'src/cli/main.ts',
      'research',
      testCase.q,
      '--providers',
      minusProviders.join(','),
      '--max',
      String(maxResults),
      '--timeout',
      String(timeoutMs),
      '--fresh',
      '--json',
    ])
    researchRuns.push(minus)
    writeFileSync(join(rawDir, `${testCase.id}__minus-${excludedProvider}.stdout.json`), minus.stdout)
    writeFileSync(join(rawDir, `${testCase.id}__minus-${excludedProvider}.stderr.txt`), minus.stderr)

    const baselineSources = baseline.result?.sources ?? []
    const minusSources = minus.result?.sources ?? []
    const minusIds = sourceIds(minusSources)
    const lostSources = baselineSources.filter((source) => source.id && !minusIds.has(source.id))
    const baselineExpectedDomainSources = baselineSources.filter((source) => hostMatches(source.url, testCase.expectedDomains))
    const minusExpectedDomainSources = minusSources.filter((source) => hostMatches(source.url, testCase.expectedDomains))
    const lostExpectedDomainSources = lostSources.filter((source) => hostMatches(source.url, testCase.expectedDomains))
    const baselineTotalCost = baseline.result?.cost?.totalUSD ?? 0
    const minusTotalCost = minus.result?.cost?.totalUSD ?? 0
    const baselineProviderCost = baseline.result?.cost?.byProvider?.[excludedProvider]?.usd ?? 0
    const baselineTotalMs = baseline.result?.timing?.totalMs ?? baseline.elapsedMs
    const minusTotalMs = minus.result?.timing?.totalMs ?? minus.elapsedMs
    const observedCostDeltaUSD = roundUSD(baselineTotalCost - minusTotalCost)
    const observedLatencyDeltaMs = Math.round(baselineTotalMs - minusTotalMs)
    const row = {
      runId,
      timestamp: new Date().toISOString(),
      experiment,
      caseId: testCase.id,
      provider: `all-minus-${excludedProvider}`,
      query: testCase.q,
      mode: 'research',
      sources: minusSources.length,
      sourceUrls: urls(minusSources),
      costUSD: roundUSD(minusTotalCost),
      latencyMs: Math.max(0, Math.round(minusTotalMs)),
      stats: {
        excludedProvider,
        baselineSweepId: baseline.result?.sweepId,
        minusSweepId: minus.result?.sweepId,
        baseline: {
          exitCode: baseline.exitCode,
          totalHits: baseline.result?.stats?.totalHits ?? 0,
          uniqueSources: baseline.result?.stats?.uniqueSources ?? baselineSources.length,
          overlapPct: baseline.result?.stats?.overlapPct ?? 0,
          costUSD: roundUSD(baselineTotalCost),
          latencyMs: Math.max(0, Math.round(baselineTotalMs)),
          providers: providerStatuses(baseline.result),
        },
        minus: {
          exitCode: minus.exitCode,
          providerSet: minusProviders,
          totalHits: minus.result?.stats?.totalHits ?? 0,
          uniqueSources: minus.result?.stats?.uniqueSources ?? minusSources.length,
          overlapPct: minus.result?.stats?.overlapPct ?? 0,
          costUSD: roundUSD(minusTotalCost),
          latencyMs: Math.max(0, Math.round(minusTotalMs)),
          providers: providerStatuses(minus.result),
        },
      },
      metrics: {
        excludedProvider,
        baselineSources: baselineSources.length,
        minusSources: minusSources.length,
        lostSourceCount: lostSources.length,
        baselineExpectedDomainCount: baselineExpectedDomainSources.length,
        minusExpectedDomainCount: minusExpectedDomainSources.length,
        lostExpectedDomainCount: lostExpectedDomainSources.length,
        costSavedUSD: roundUSD(baselineProviderCost),
        observedCostDeltaUSD,
        latencySavedMs: observedLatencyDeltaMs,
        baselineExcludedProviderLatencyMs: baseline.result?.stats?.providers?.[excludedProvider]?.latencyMs ?? 0,
        costSavedPerLostSourceUSD: lostSources.length > 0 ? roundUSD(baselineProviderCost / lostSources.length) : null,
        latencySavedPerLostSourceMs: lostSources.length > 0 ? roundMetric(observedLatencyDeltaMs / lostSources.length) : null,
        lostUrls: urls(lostSources),
        lostExpectedDomainUrls: urls(lostExpectedDomainSources),
        failureStage: !baseline.result ? 'baseline' : !minus.result ? 'minus' : undefined,
      },
      errors: [...rowErrors('baseline', baseline), ...rowErrors('minus', minus)],
    }
    validateRow(row)
    rows.push(row)
  }
}

writeFileSync(join(runDir, 'rows.jsonl'), rows.map(jsonLine).join(''))
writeFileSync(join(runDir, 'commands.jsonl'), commands.map((command) => jsonLine({ command })).join(''))

const totalCostUSD = roundUSD(researchRuns.reduce((sum, run) => sum + (run.result?.cost?.totalUSD ?? 0), 0))
const providerCallSlots = researchRuns.reduce((sum, run) => {
  const providerArg = run.command.match(/--providers ([^ ]+)/)?.[1] ?? ''
  return sum + providerArg.split(',').filter(Boolean).length
}, 0)
const providerStatsRecorded = researchRuns.reduce((sum, run) => sum + Object.keys(run.result?.stats?.providers ?? {}).length, 0)
const failureRows = rows.filter((row) => Array.isArray(row.errors) && row.errors.length > 0)

const byExcludedProvider = Object.fromEntries(
  providerSet.map((provider) => {
    const providerRows = rows.filter((row) => (row.metrics as { excludedProvider?: string }).excludedProvider === provider)
    const lost = providerRows.reduce((sum, row) => sum + ((row.metrics as { lostSourceCount?: number }).lostSourceCount ?? 0), 0)
    const lostExpected = providerRows.reduce((sum, row) => sum + ((row.metrics as { lostExpectedDomainCount?: number }).lostExpectedDomainCount ?? 0), 0)
    const costSaved = providerRows.reduce((sum, row) => sum + ((row.metrics as { costSavedUSD?: number }).costSavedUSD ?? 0), 0)
    const latencySaved = providerRows.reduce((sum, row) => sum + ((row.metrics as { latencySavedMs?: number }).latencySavedMs ?? 0), 0)
    return [
      provider,
      {
        rows: providerRows.length,
        lostSourceCount: lost,
        avgLostSources: roundMetric(lost / Math.max(1, providerRows.length)),
        lostExpectedDomainCount: lostExpected,
        totalCostSavedUSD: roundUSD(costSaved),
        avgCostSavedUSD: roundUSD(costSaved / Math.max(1, providerRows.length)),
        totalLatencySavedMs: latencySaved,
        avgLatencySavedMs: roundMetric(latencySaved / Math.max(1, providerRows.length)),
        failures: providerRows.filter((row) => Array.isArray(row.errors) && row.errors.length > 0).length,
      },
    ]
  }),
)

const topRows = [...rows]
  .sort((a, b) => ((b.metrics as { lostSourceCount?: number }).lostSourceCount ?? 0) - ((a.metrics as { lostSourceCount?: number }).lostSourceCount ?? 0))
  .slice(0, 3)

const examples: { caseId: unknown; excludedProvider: string | undefined | null; lostSourceCount: number | undefined; exampleUrl: string | null }[] = topRows.map((row) => {
  const metrics = row.metrics as { excludedProvider?: string; lostSourceCount?: number; lostUrls?: string[] }
  return {
    caseId: row.caseId,
    excludedProvider: metrics.excludedProvider,
    lostSourceCount: metrics.lostSourceCount,
    exampleUrl: metrics.lostUrls?.[0] ?? null,
  }
})

while (examples.length < 3) {
  examples.push({ caseId: null, excludedProvider: null, lostSourceCount: 0, exampleUrl: null })
}

const providerFailures = researchRuns.flatMap((run) =>
  Object.entries(run.result?.stats?.providers ?? {})
    .filter(([, stats]) => stats.status && stats.status !== 'ok')
    .map(([provider, stats]) => ({ run: run.label, provider, status: stats.status, error: stats.error ?? null })),
)

const projectChangeJustified = failureRows.length > 0 ? 'needs_more_data' : 'none'
const summary = {
  runId,
  experiment,
  pass: 'pilot',
  providerSet,
  providerOrder: providerSet,
  caseCount: cases.length,
  cases: cases.map((testCase) => ({ id: testCase.id, tags: testCase.tags, expectedDomains: testCase.expectedDomains ?? [] })),
  sweepCount: researchRuns.length,
  callCount: providerCallSlots,
  providerStatsRecorded,
  cost: {
    totalUSD: totalCostUSD,
  },
  mainMetrics: {
    rows: rows.length,
    totalLostSources: rows.reduce((sum, row) => sum + ((row.metrics as { lostSourceCount?: number }).lostSourceCount ?? 0), 0),
    totalLostExpectedDomainSources: rows.reduce((sum, row) => sum + ((row.metrics as { lostExpectedDomainCount?: number }).lostExpectedDomainCount ?? 0), 0),
    byExcludedProvider,
    failureRows: failureRows.length,
  },
  examples,
  providerFailures,
  commands,
  projectChangesJustified: projectChangeJustified,
}

writeFileSync(join(runDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)

const metricLines = Object.entries(byExcludedProvider)
  .map(([provider, metrics]) => {
    const m = metrics as { lostSourceCount: number; avgLostSources: number; lostExpectedDomainCount: number; totalCostSavedUSD: number; failures: number }
    return `| ${provider} | ${m.lostSourceCount} | ${m.avgLostSources} | ${m.lostExpectedDomainCount} | ${m.totalCostSavedUSD} | ${m.failures} |`
  })
  .join('\n')

const notes = [
  `# Notes - ${runId}`,
  '',
  `- Providers used, in order: ${providerSet.join(',')}.`,
  `- Cases: ${cases.length}.`,
  `- Sweep calls: ${researchRuns.length}; provider call slots: ${providerCallSlots}; provider stats recorded: ${providerStatsRecorded}.`,
  `- Reported research cost: $${totalCostUSD}.`,
  `- Project change justified: ${projectChangeJustified}.`,
  '',
  '## Metrics By Excluded Provider',
  '',
  '| Excluded | Lost sources | Avg lost | Lost expected-domain | Baseline provider cost saved USD | Failure rows |',
  '| --- | ---: | ---: | ---: | ---: | ---: |',
  metricLines,
  '',
  '## Provider Failures',
  '',
  providerFailures.length ? providerFailures.map((failure) => `- ${failure.run}: ${failure.provider} ${failure.status}${failure.error ? ` (${failure.error.code}: ${failure.error.message})` : ''}`).join('\n') : '- None.',
  '',
  '## Measurement Bugs',
  '',
  '- None observed in the runner. Nonzero CLI exits for zero-source/error sweeps are recorded as row errors when stdout cannot be parsed.',
  '',
  '## Commands',
  '',
  ...commands.map((command) => `- \`${command}\``),
  '',
].join('\n')

writeFileSync(join(runDir, 'notes.md'), notes)

const resultLog = [
  '',
  `### ${new Date().toISOString().slice(0, 10)} - Codex - ${runId}`,
  '',
  '- Commit/worktree: uncommitted/no HEAD',
  `- Commands: \`bun protoblocks/src/${experiment}/run-pilot.ts\`; full command list in \`${runDir}/commands.jsonl\``,
  `- Providers: ${providerSet.join(',')}`,
  '- Dataset: 3 fixed pilot cases; one Polymarket-style resolution-source, one current-news, one official-domain.',
  `- Cost: $${totalCostUSD}`,
  '- Key metrics:',
  '',
  '| Excluded | Lost sources | Avg lost | Lost expected-domain | Baseline provider cost saved USD | Failure rows |',
  '| --- | ---: | ---: | ---: | ---: | ---: |',
  metricLines,
  '',
  `- Interpretation: ${failureRows.length > 0 ? 'Provider/API failures affected at least one row, so marginal-value conclusions need another clean pilot.' : 'Pilot completed without measurement blockers; marginal source loss is visible in summary.json.'}`,
  '- Follow-up: rerun a 5-case pilot if failures appear; otherwise expand to the full mixed benchmark.',
  `- Project change justified: ${projectChangeJustified}`,
  '',
].join('\n')

appendFileSync(`protoblocks/${experiment}.md`, resultLog)

console.log(JSON.stringify({ runId, runDir, costUSD: totalCostUSD, rows: rows.length, projectChangeJustified }, null, 2))
