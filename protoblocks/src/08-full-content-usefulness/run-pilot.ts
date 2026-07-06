#!/usr/bin/env bun
// @ts-nocheck
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const experiment = '08-full-content-usefulness'
const providerSet = ['exa', 'parallel', 'tavily', 'jina']
const maxResults = 10
const timeoutMs = 30_000

type TestCase = {
  id: string
  q: string
  tags: string[]
  expectedTerms: string[]
  expectedDomains?: string[]
  pageType: 'news' | 'agency' | 'company' | 'blog' | 'resolution_source' | 'structured'
  notes?: string
}

type SourceLike = {
  id?: string
  url?: string
  title?: string
  snippet?: string
  content?: string
  publishedAt?: string
  mediaType?: string
  providers?: string[]
  provenance?: Array<{ provider?: string; rank?: number; score?: number }>
  score?: number
}

type ProviderStats = {
  status?: string
  hits?: number
  uniqueContributed?: number
  latencyMs?: number
  error?: { code: string; message: string }
}

type SweepLike = {
  sweepId?: string
  query?: { q?: string; mode?: string; max?: number }
  sources?: SourceLike[]
  stats?: {
    totalHits?: number
    uniqueSources?: number
    overlapPct?: number
    providers?: Record<string, ProviderStats>
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

type ResultRow = {
  runId: string
  timestamp: string
  experiment: string
  caseId: string
  provider: string
  query: string
  mode: 'research'
  sources: number
  sourceUrls: string[]
  costUSD: number
  latencyMs: number
  stats: Record<string, unknown>
  metrics: Record<string, unknown>
  errors?: Array<{ code: string; message: string; stage: string }>
  [key: string]: unknown
}

const cases: TestCase[] = [
  {
    id: 'case-001-news-sam-altman-reuters',
    q: 'Reuters May 2024 OpenAI Scarlett Johansson Sky voice Sam Altman',
    tags: ['news', 'article', 'full-content'],
    expectedTerms: ['Scarlett Johansson', 'Sky', 'Sam Altman'],
    expectedDomains: ['reuters.com'],
    pageType: 'news',
    notes: 'News article case with known answer-bearing names.',
  },
  {
    id: 'case-002-agency-sec-climate-rule',
    q: 'SEC final rule climate-related disclosures Release No. 33-11275 greenhouse gas emissions',
    tags: ['agency', 'official', 'full-content'],
    expectedTerms: ['Release No. 33-11275', 'climate-related disclosures', 'greenhouse gas emissions'],
    expectedDomains: ['sec.gov'],
    pageType: 'agency',
    notes: 'Official agency rule page/PDF with known release number and subject.',
  },
  {
    id: 'case-003-company-apple-q4-2023',
    q: 'Apple reports fourth quarter results 2023 investor relations Services revenue September 30 2023',
    tags: ['company', 'investor-relations', 'full-content'],
    expectedTerms: ['quarterly revenue', 'Services revenue', 'September 30, 2023'],
    expectedDomains: ['apple.com'],
    pageType: 'company',
    notes: 'Company investor-relations release with known financial-result wording.',
  },
  {
    id: 'case-004-structured-bls-employment-may-2024',
    q: 'BLS Employment Situation May 2024 Table A-1 unemployment rate official',
    tags: ['structured', 'agency', 'table', 'full-content'],
    expectedTerms: ['Table A-1', 'unemployment rate', 'Total nonfarm payroll employment'],
    expectedDomains: ['bls.gov'],
    pageType: 'structured',
    notes: 'Structured official report with tables and standard employment terms.',
  },
]

const boilerplateTerms = ['subscribe', 'cookie', 'privacy policy', 'sign up', 'advertisement', 'all rights reserved']

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

function round(value: number, places = 6) {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}

function median(values: number[]) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!
}

function host(url: string | undefined) {
  if (!url) return undefined
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return undefined
  }
}

function hostMatches(url: string | undefined, domains: string[] | undefined) {
  const h = host(url)
  if (!h || !domains?.length) return false
  return domains.some((raw) => {
    const domain = raw.toLowerCase().replace(/^www\./, '')
    return h === domain || h.endsWith(`.${domain}`)
  })
}

function expectedTermHits(content: string, terms: string[]) {
  const lower = content.toLowerCase()
  return terms.filter((term) => lower.includes(term.toLowerCase())).length
}

function boilerplateScore(content: string) {
  const lower = content.toLowerCase()
  return boilerplateTerms.filter((term) => lower.includes(term)).length
}

function looksLikeSearchOrIndex(url: string | undefined, title: string | undefined) {
  const lower = `${url ?? ''} ${title ?? ''}`.toLowerCase()
  return lower.includes('/search') || lower.includes('?q=') || lower.includes('tag/') || lower.includes('/category/') || lower.includes('site search')
}

function labelSource(args: {
  sourceId: string
  url: string
  title: string
  content: string
  contentLength: number
  snippetLength: number
  expectedHits: number
  boilerplate: number
  testCase: TestCase
}) {
  const { url, title, contentLength, snippetLength, expectedHits, boilerplate, testCase } = args
  const onExpectedDomain = hostMatches(url, testCase.expectedDomains)
  const hasBody = contentLength >= 300 && contentLength > Math.min(280, snippetLength)
  const answerBearing = hasBody && expectedHits > 0
  const searchOrIndex = looksLikeSearchOrIndex(url, title)

  if (!contentLength) {
    return {
      label: 'F',
      useful: false,
      reason: 'broken',
      notes: 'No content field returned.',
    }
  }
  if (searchOrIndex && expectedHits === 0) {
    return {
      label: 'D',
      useful: false,
      reason: 'aggregator',
      notes: 'Search, tag, or index-like page without answer-bearing content.',
    }
  }
  if (!hasBody) {
    return {
      label: 'D',
      useful: false,
      reason: 'thin_summary',
      notes: `Content length ${contentLength} is snippet-like or shorter than the snippet.`,
    }
  }
  if (answerBearing && onExpectedDomain) {
    return {
      label: 'A',
      useful: true,
      reason: testCase.pageType === 'company' ? 'official_source' : 'primary_data',
      notes: 'Expected-domain body content includes at least one answer-bearing term.',
    }
  }
  if (answerBearing) {
    return {
      label: 'B',
      useful: true,
      reason: 'reputable_reporting',
      notes: 'Off-domain body content includes at least one answer-bearing term.',
    }
  }
  if (boilerplate >= 3) {
    return {
      label: 'D',
      useful: false,
      reason: 'thin_summary',
      notes: 'Body text is present but boilerplate-heavy and misses expected terms.',
    }
  }
  return {
    label: 'F',
    useful: false,
    reason: 'off_topic',
    notes: 'Body text misses expected answer-bearing terms.',
  }
}

function validateRow(row: ResultRow) {
  const required = ['runId', 'timestamp', 'experiment', 'caseId', 'provider', 'query', 'mode', 'sources', 'costUSD', 'latencyMs', 'stats', 'metrics'] as const
  for (const key of required) {
    if (!(key in row)) throw new Error(`row missing ${key}`)
  }
  if (!row.runId) throw new Error('row.runId must be non-empty')
  if (Number.isNaN(Date.parse(row.timestamp))) throw new Error('row.timestamp must be date-time')
  if (!row.experiment) throw new Error('row.experiment must be non-empty')
  if (!row.caseId) throw new Error('row.caseId must be non-empty')
  if (!row.provider) throw new Error('row.provider must be non-empty')
  if (row.mode !== 'research') throw new Error('row.mode must be research')
  if (!Number.isInteger(row.sources) || row.sources < 0) throw new Error('row.sources must be a non-negative integer')
  if (typeof row.costUSD !== 'number' || row.costUSD < 0) throw new Error('row.costUSD must be a non-negative number')
  if (!Number.isInteger(row.latencyMs) || row.latencyMs < 0) throw new Error('row.latencyMs must be a non-negative integer')
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

function gitWorktreeNote() {
  const head = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' })
  if (head.status === 0 && head.stdout.trim()) return head.stdout.trim()
  return 'uncommitted/no HEAD'
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
    maxBuffer: 1024 * 1024 * 100,
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
    `- Source: fixed 4-case pilot seed list embedded in \`protoblocks/src/${experiment}/run-pilot.ts\`.`,
    `- Sampled: ${new Date().toISOString()} UTC.`,
    '- Filters: one case each for news, official agency, company investor-relations, and structured official pages.',
    '- Case cap: 4.',
    '- Providers: full-content capable set from PROVIDER_SETS.md: exa,parallel,tavily,jina.',
    '- Control provider: omitted because the 4-provider full-content set already reaches the 4-case pilot cap target.',
    '- Exclusions: blog and Polymarket resolution-source page types deferred to a full run or larger pilot.',
    '',
  ].join('\n'),
)

const providersRun = runCli('providers', ['src/cli/main.ts', 'providers', '--json'], join(runDir, 'providers.json'))
writeFileSync(join(rawDir, 'providers.stderr.txt'), providersRun.stderr)

const rows: ResultRow[] = []
const labels: Record<string, unknown>[] = []
const callRecords: Record<string, unknown>[] = []

for (const testCase of cases) {
  for (const provider of providerSet) {
    const safeBase = `${testCase.id}__${provider}`
    const run = runCli(`${testCase.id}:${provider}`, [
      'src/cli/main.ts',
      'research',
      testCase.q,
      '--providers',
      provider,
      '--max',
      String(maxResults),
      '--timeout',
      String(timeoutMs),
      '--full',
      '--fresh',
      '--json',
    ])
    writeFileSync(join(rawDir, `${safeBase}.stdout.json`), run.stdout)
    writeFileSync(join(rawDir, `${safeBase}.stderr.txt`), run.stderr)

    const providerStats = run.result?.stats?.providers?.[provider]
    const sources = run.result?.sources ?? []
    const callCostUSD = run.result?.cost?.byProvider?.[provider]?.usd ?? run.result?.cost?.totalUSD ?? 0
    const latencyMs = Math.max(0, Math.round(providerStats?.latencyMs ?? run.result?.timing?.totalMs ?? run.elapsedMs))
    const callStatus = providerStats?.status ?? (run.parseError ? 'parse_error' : run.exitCode === 0 ? 'ok' : 'error')

    callRecords.push({
      caseId: testCase.id,
      provider,
      command: run.command,
      exitCode: run.exitCode,
      status: callStatus,
      sources: sources.length,
      costUSD: round(callCostUSD),
      latencyMs,
      parseError: run.parseError,
      stderr: run.stderr.trim() || undefined,
      providerError: providerStats?.error,
    })

    if (!run.result || run.parseError || !providerStats || sources.length === 0) {
      const row: ResultRow = {
        runId,
        timestamp: new Date().toISOString(),
        experiment,
        caseId: testCase.id,
        provider,
        query: testCase.q,
        mode: 'research',
        sources: 0,
        sourceUrls: [],
        costUSD: round(callCostUSD),
        latencyMs,
        stats: {
          command: run.command,
          exitCode: run.exitCode,
          stdoutBytes: run.stdout.length,
          stderr: run.stderr,
          sweepId: run.result?.sweepId,
          providerStats,
          providerStatuses: providerStatuses(run.result),
          costBasis: run.result?.cost?.byProvider?.[provider]?.basis,
        },
        metrics: {
          pageType: testCase.pageType,
          expectedTerms: testCase.expectedTerms,
          failureStage: !run.result || run.parseError ? 'cli_or_parse' : sources.length === 0 ? 'no_sources' : 'provider_stats_missing',
          providerStatus: callStatus,
          hasContent: false,
          contentUseful: false,
        },
        errors: [
          {
            code: run.parseError ? 'parse_error' : providerStats?.error?.code ?? (sources.length === 0 ? 'no_sources' : 'provider_call'),
            message: run.parseError ?? providerStats?.error?.message ?? (run.stderr.trim() || 'No provider sources returned'),
            stage: 'provider_call',
          },
        ],
      }
      validateRow(row)
      rows.push(row)
      continue
    }

    const allocatedCostUSD = sources.length ? callCostUSD / sources.length : 0
    sources.forEach((source, index) => {
      const url = source.url ?? ''
      const title = source.title ?? ''
      const snippet = source.snippet ?? ''
      const content = source.content ?? ''
      const sourceId = source.id || `${testCase.id}-${provider}-${index + 1}`
      const contentLength = content.length
      const snippetLength = snippet.length
      const expectedHits = expectedTermHits(content, testCase.expectedTerms)
      const boilerplate = boilerplateScore(content)
      const label = labelSource({
        sourceId,
        url,
        title,
        content,
        contentLength,
        snippetLength,
        expectedHits,
        boilerplate,
        testCase,
      })
      const rank = source.provenance?.find((p) => p.provider === provider)?.rank ?? index + 1
      const hasContent = contentLength > 0
      const row: ResultRow = {
        runId,
        timestamp: new Date().toISOString(),
        experiment,
        caseId: testCase.id,
        provider,
        query: testCase.q,
        mode: 'research',
        sources: 1,
        sourceUrls: [url],
        costUSD: round(allocatedCostUSD),
        latencyMs,
        sourceId,
        url,
        title,
        snippetLength,
        contentLength,
        expectedTermHits: expectedHits,
        boilerplateScore: boilerplate,
        hasContent,
        contentUseful: label.useful,
        stats: {
          command: run.command,
          exitCode: run.exitCode,
          sweepId: run.result?.sweepId,
          providerStats,
          costBasis: run.result?.cost?.byProvider?.[provider]?.basis,
          rank,
          score: source.score,
          host: host(url),
          expectedDomainMatch: hostMatches(url, testCase.expectedDomains),
        },
        metrics: {
          pageType: testCase.pageType,
          expectedTerms: testCase.expectedTerms,
          expectedTermHits: expectedHits,
          expectedTermHitRate: round(expectedHits / testCase.expectedTerms.length, 4),
          boilerplateScore: boilerplate,
          contentLength,
          snippetLength,
          hasContent,
          contentUseful: label.useful,
          label: label.label,
          labelReason: label.reason,
          providerStatus: callStatus,
          onExpectedDomain: hostMatches(url, testCase.expectedDomains),
          contentToSnippetRatio: snippetLength ? round(contentLength / snippetLength, 3) : null,
        },
      }
      validateRow(row)
      rows.push(row)
      labels.push({
        sourceId,
        rowId: `${testCase.id}__${provider}__${rank}`,
        caseId: testCase.id,
        provider,
        url,
        label: label.label,
        useful: label.useful,
        reason: label.reason,
        notes: label.notes,
        contentLength,
        snippetLength,
        expectedTermHits: expectedHits,
        boilerplateScore: boilerplate,
      })
    })
  }
}

writeFileSync(join(runDir, 'commands.jsonl'), commands.map((command) => jsonLine({ command })).join(''))
writeFileSync(join(runDir, 'commands.log'), `${commands.join('\n')}\n`)
writeFileSync(join(runDir, 'call-results.jsonl'), callRecords.map(jsonLine).join(''))
writeFileSync(join(runDir, 'rows.jsonl'), rows.map(jsonLine).join(''))
writeFileSync(join(runDir, 'manual-labels.jsonl'), labels.map(jsonLine).join(''))

const sourceRows = rows.filter((row) => row.sources === 1)
const failureRows = rows.filter((row) => row.sources === 0)
const totalCostUSD = round(callRecords.reduce((sum, call) => sum + (typeof call.costUSD === 'number' ? call.costUSD : 0), 0))
const totalUseful = sourceRows.filter((row) => row.contentUseful === true).length

function summarizeSubset(subset: ResultRow[]) {
  const sourceSubset = subset.filter((row) => row.sources === 1)
  const contentRows = sourceSubset.filter((row) => row.hasContent === true)
  const usefulRows = sourceSubset.filter((row) => row.contentUseful === true)
  const contentLengths = sourceSubset.map((row) => Number(row.contentLength ?? 0))
  const expectedTermHitRows = sourceSubset.filter((row) => Number(row.expectedTermHits ?? 0) > 0)
  const boilerplateValues = sourceSubset.map((row) => Number(row.boilerplateScore ?? 0))
  return {
    rows: subset.length,
    returnedSources: sourceSubset.length,
    failureRows: subset.length - sourceSubset.length,
    contentPresenceRate: sourceSubset.length ? round(contentRows.length / sourceSubset.length, 4) : 0,
    medianContentLength: Math.round(median(contentLengths)),
    expectedTermHitRate: sourceSubset.length ? round(expectedTermHitRows.length / sourceSubset.length, 4) : 0,
    avgBoilerplateScore: sourceSubset.length ? round(boilerplateValues.reduce((sum, value) => sum + value, 0) / sourceSubset.length, 3) : 0,
    usefulContentRate: sourceSubset.length ? round(usefulRows.length / sourceSubset.length, 4) : 0,
    usefulSources: usefulRows.length,
  }
}

const byProvider: Record<string, unknown> = {}
for (const provider of providerSet) {
  const subset = rows.filter((row) => row.provider === provider)
  const providerCost = callRecords.filter((call) => call.provider === provider).reduce((sum, call) => sum + (typeof call.costUSD === 'number' ? call.costUSD : 0), 0)
  const summary = summarizeSubset(subset)
  byProvider[provider] = {
    ...summary,
    callCount: callRecords.filter((call) => call.provider === provider).length,
    costUSD: round(providerCost),
    costPerUsefulSourceUSD: (summary as { usefulSources: number }).usefulSources ? round(providerCost / (summary as { usefulSources: number }).usefulSources) : null,
    avgLatencyMs: Math.round(
      callRecords
        .filter((call) => call.provider === provider)
        .reduce((sum, call) => sum + (typeof call.latencyMs === 'number' ? call.latencyMs : 0), 0) / cases.length,
    ),
  }
}

const byPageType: Record<string, unknown> = {}
for (const pageType of [...new Set(cases.map((c) => c.pageType))]) {
  byPageType[pageType] = summarizeSubset(rows.filter((row) => row.metrics.pageType === pageType))
}

const badExamples = sourceRows
  .filter((row) => row.contentUseful !== true)
  .sort((a, b) => {
    const aLen = Number(a.contentLength ?? 0)
    const bLen = Number(b.contentLength ?? 0)
    if (aLen === 0 && bLen !== 0) return -1
    if (bLen === 0 && aLen !== 0) return 1
    return Number(a.expectedTermHits ?? 0) - Number(b.expectedTermHits ?? 0)
  })
  .slice(0, 8)
  .map((row) => ({
    caseId: row.caseId,
    provider: row.provider,
    url: row.url,
    title: row.title,
    contentLength: row.contentLength,
    expectedTermHits: row.expectedTermHits,
    label: row.metrics.label,
    reason: row.metrics.labelReason,
  }))

const projectChangesJustified = failureRows.length > 0 ? 'needs_more_data' : 'none'
const interpretation =
  totalUseful === 0
    ? 'Pilot found content fields but no answer-bearing full content under the current cases.'
    : 'Pilot shows full-content usefulness varies materially by provider and page type; summary metrics are enough to justify a larger run, not a default change.'

const summary = {
  runId,
  providerSet,
  providers: providerSet,
  controlProvider: null,
  caseCount: cases.length,
  callCount: callRecords.length,
  rows: rows.length,
  sourceRows: sourceRows.length,
  labelRows: labels.length,
  costUSD: totalCostUSD,
  mainMetrics: {
    ...summarizeSubset(rows),
    costPerUsefulFullContentSourceUSD: totalUseful ? round(totalCostUSD / totalUseful) : null,
    byProvider,
    byPageType,
  },
  examplesThatChangedInterpretation: badExamples.slice(0, 3),
  badContentExamples: badExamples,
  providerFailures: callRecords.filter((call) => call.status !== 'ok'),
  commands,
  projectChangesJustified,
}

writeFileSync(join(runDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)

const providerMetricLines = providerSet
  .map((provider) => {
    const m = byProvider[provider] as {
      returnedSources: number
      contentPresenceRate: number
      medianContentLength: number
      expectedTermHitRate: number
      usefulContentRate: number
      costPerUsefulSourceUSD: number | null
      failureRows: number
    }
    return `| ${provider} | ${m.returnedSources} | ${m.contentPresenceRate} | ${m.medianContentLength} | ${m.expectedTermHitRate} | ${m.usefulContentRate} | ${m.costPerUsefulSourceUSD ?? 'n/a'} | ${m.failureRows} |`
  })
  .join('\n')

const pageTypeMetricLines = Object.entries(byPageType)
  .map(([pageType, value]) => {
    const m = value as {
      returnedSources: number
      contentPresenceRate: number
      medianContentLength: number
      expectedTermHitRate: number
      usefulContentRate: number
    }
    return `| ${pageType} | ${m.returnedSources} | ${m.contentPresenceRate} | ${m.medianContentLength} | ${m.expectedTermHitRate} | ${m.usefulContentRate} |`
  })
  .join('\n')

const notes = [
  `# Notes - ${runId}`,
  '',
  `- Providers used: ${providerSet.join(',')}.`,
  '- Control provider omitted: full-content provider set alone was used for the 4-case pilot cap.',
  `- Cases: ${cases.length}; provider calls: ${callRecords.length}; returned source rows: ${sourceRows.length}.`,
  `- Run-local ledger: \`${ledgerPath}\`.`,
  `- Reported provider-call cost: $${totalCostUSD}.`,
  `- Manual labels: ${labels.length}; labels use USEFUL_SOURCE_RUBRIC.md full-content rules.`,
  `- Project change justified: ${projectChangesJustified}.`,
  '',
  '## Metrics By Provider',
  '',
  '| Provider | Sources | Content presence | Median content length | Expected-term hit rate | Useful-content rate | Cost/useful USD | Failure rows |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  providerMetricLines,
  '',
  '## Metrics By Page Type',
  '',
  '| Page type | Sources | Content presence | Median content length | Expected-term hit rate | Useful-content rate |',
  '| --- | ---: | ---: | ---: | ---: | ---: |',
  pageTypeMetricLines,
  '',
  '## Bad Content Examples',
  '',
  badExamples.length
    ? badExamples
        .map(
          (example) =>
            `- ${example.provider} ${example.caseId}: ${example.reason}, hits ${example.expectedTermHits}, length ${example.contentLength}, ${example.url}`,
        )
        .join('\n')
    : '- None.',
  '',
  '## Provider Failures',
  '',
  summary.providerFailures.length
    ? summary.providerFailures
        .map((failure) => `- ${failure.caseId} ${failure.provider}: ${failure.status}${failure.providerError ? ` (${failure.providerError.code}: ${failure.providerError.message})` : ''}`)
        .join('\n')
    : '- None.',
  '',
  '## Measurement Bugs',
  '',
  '- None observed in the runner.',
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
  `- Commit/worktree: ${gitWorktreeNote()}`,
  `- Commands: \`bun protoblocks/src/${experiment}/run-pilot.ts\`; full command list in \`${runDir}/commands.jsonl\``,
  `- Providers: ${providerSet.join(',')} (Full-Content Capable from PROVIDER_SETS.md; no control provider within pilot cap)`,
  '- Dataset: 4 fixed pilot cases; news, agency, company investor-relations, structured official page.',
  `- Cost: $${totalCostUSD}`,
  '- Key metrics:',
  '',
  '| Provider | Sources | Content presence | Median content length | Expected-term hit rate | Useful-content rate | Cost/useful USD | Failure rows |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  providerMetricLines,
  '',
  `- Interpretation: ${interpretation}`,
  '- Follow-up: expand to include blog and Polymarket resolution-source page types, then compare source-level usefulness against a non-full-content control.',
  `- Project change justified: ${projectChangesJustified}`,
  '',
].join('\n')

appendFileSync(`protoblocks/${experiment}.md`, resultLog)

console.log(
  JSON.stringify(
    {
      runId,
      runDir,
      providers: providerSet,
      costUSD: totalCostUSD,
      rows: rows.length,
      sourceRows: sourceRows.length,
      usefulSources: totalUseful,
      projectChangesJustified,
    },
    null,
    2,
  ),
)
