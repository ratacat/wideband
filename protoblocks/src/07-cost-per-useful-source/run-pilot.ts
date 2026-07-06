#!/usr/bin/env bun
// @ts-nocheck
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const experiment = '07-cost-per-useful-source'
const mode = 'scan'
const maxResults = 10
const timeoutMs = 20_000
const providerSet = ['brave', 'jina', 'desearch', 'sailor', 'searchx', 'exa', 'tavily']
const lowCostFirstPass = ['brave', 'jina', 'desearch', 'sailor', 'searchx']
const paidComparison = ['exa', 'tavily']

type TestCase = {
  id: string
  q: string
  tags: string[]
  category: string
  expectedDomains?: string[]
  notes?: string
}

type SourceLike = {
  id?: string
  url?: string
  title?: string
  snippet?: string
  publishedAt?: string
  providers?: string[]
  score?: number
}

type SweepLike = {
  sweepId?: string
  query?: { q?: string }
  sources?: SourceLike[]
  stats?: {
    totalHits?: number
    uniqueSources?: number
    overlapPct?: number
    providers?: Record<
      string,
      {
        status?: string
        hits?: number
        uniqueContributed?: number
        latencyMs?: number
        error?: { code?: string; message?: string }
      }
    >
  }
  cost?: {
    totalUSD?: number
    byProvider?: Record<string, { usd?: number; basis?: string }>
  }
  timing?: { totalMs?: number }
}

type CliRun = {
  command: string
  exitCode: number
  elapsedMs: number
  stdout: string
  stderr: string
  result?: SweepLike
  parseError?: string
}

type SourceLabel = {
  sourceId: string
  caseId: string
  provider: string
  mode: typeof mode
  url: string
  title: string
  label: 'A' | 'B' | 'C' | 'D' | 'F'
  useful: boolean
  reason:
    | 'expected_domain'
    | 'official_source'
    | 'entity_match'
    | 'reputable_reporting'
    | 'context'
    | 'duplicate'
    | 'thin_summary'
    | 'aggregator'
    | 'polymarket_page'
    | 'off_topic'
    | 'broken'
  labeler: 'heuristic'
  notes: string
}

const cases: TestCase[] = [
  {
    id: 'case-001-polymarket-fed-june-2026',
    q: 'Polymarket Fed interest rate decision June 2026 resolution source FOMC target range',
    tags: ['polymarket', 'resolution-source', 'official-domain'],
    category: 'polymarket',
    expectedDomains: ['federalreserve.gov', 'polymarket.com'],
    notes: 'Polymarket-style official source discovery for a macro market.',
  },
  {
    id: 'case-002-polymarket-artemis-ii-launch',
    q: 'Polymarket Artemis II launch before July 2026 official NASA launch schedule source',
    tags: ['polymarket', 'resolution-source', 'official-domain'],
    category: 'polymarket',
    expectedDomains: ['nasa.gov', 'polymarket.com'],
    notes: 'Polymarket-style official source discovery for an agency schedule market.',
  },
  {
    id: 'case-003-current-news-nvidia-earnings',
    q: 'latest NVIDIA earnings guidance news Reuters official NVIDIA investor relations 2026',
    tags: ['current-news', 'company-news'],
    category: 'current-news',
    expectedDomains: ['reuters.com', 'nvidia.com', 'sec.gov'],
    notes: 'Current-news source discovery with expected reporting and primary-company domains.',
  },
  {
    id: 'case-004-official-bls-cpi-may-2026',
    q: 'BLS Consumer Price Index May 2026 official release CPI',
    tags: ['official-domain', 'government-data'],
    category: 'official-domain',
    expectedDomains: ['bls.gov'],
    notes: 'Official-domain lookup for a government statistical release.',
  },
  {
    id: 'case-005-known-answer-rfc-9110',
    q: 'RFC 9110 HTTP semantics official specification source',
    tags: ['known-answer', 'long-tail', 'official-domain'],
    category: 'known-answer',
    expectedDomains: ['rfc-editor.org', 'ietf.org'],
    notes: 'Known-answer source discovery for a technical standard.',
  },
]

const stopWords = new Set([
  'a',
  'an',
  'and',
  'are',
  'before',
  'by',
  'for',
  'from',
  'http',
  'june',
  'latest',
  'may',
  'news',
  'official',
  'polymarket',
  'release',
  'resolution',
  'source',
  'the',
  'with',
  'will',
  '2026',
])

const reputableDomains = [
  'apnews.com',
  'axios.com',
  'bbc.com',
  'bloomberg.com',
  'cnbc.com',
  'cnn.com',
  'espn.com',
  'ft.com',
  'nytimes.com',
  'reuters.com',
  'theguardian.com',
  'wsj.com',
]

const aggregatorDomains = [
  'bing.com',
  'duckduckgo.com',
  'google.com',
  'kalshi.com',
  'manifold.markets',
  'polymarket.com',
  'search.yahoo.com',
  'yahoo.com',
]

const socialDomains = ['facebook.com', 'instagram.com', 'linkedin.com', 'reddit.com', 'tiktok.com', 'twitter.com', 'x.com', 'youtube.com']

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

function stableId(value: string) {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function normalizeUrl(raw: string) {
  try {
    const url = new URL(raw.trim())
    if (url.protocol === 'http:') url.protocol = 'https:'
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '')
    url.hash = ''
    if (url.pathname.length > 1 && url.pathname.endsWith('/')) url.pathname = url.pathname.slice(0, -1)
    url.searchParams.sort()
    return url.toString()
  } catch {
    return raw.trim()
  }
}

function hostOf(raw: string | undefined) {
  if (!raw) return ''
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}

function hostMatches(host: string, domain: string) {
  const normalized = domain.toLowerCase().replace(/^www\./, '')
  return host === normalized || host.endsWith(`.${normalized}`)
}

function anyHostMatches(host: string, domains: string[] | undefined) {
  return Boolean(host && domains?.some((domain) => hostMatches(host, domain)))
}

function queryTerms(testCase: TestCase) {
  return testCase.q
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 2 && !stopWords.has(term))
}

function termHits(source: SourceLike, testCase: TestCase) {
  const text = `${source.url ?? ''} ${source.title ?? ''} ${source.snippet ?? ''}`.toLowerCase()
  return queryTerms(testCase).filter((term) => text.includes(term)).length
}

function isSearchOrAggregatorUrl(url: string, host: string) {
  if (aggregatorDomains.some((domain) => hostMatches(host, domain))) return true
  return /[?&](q|query|search)=/i.test(url) || /\/search(\/|\?|$)/i.test(url)
}

function labelSource(source: SourceLike, testCase: TestCase, provider: string, index: number, seenUrls: Set<string>): SourceLabel {
  const url = source.url ?? ''
  const normalizedUrl = normalizeUrl(url)
  const host = hostOf(normalizedUrl)
  const title = source.title ?? ''
  const sourceId = source.id ?? stableId(`${testCase.id}:${provider}:${normalizedUrl || index}`)
  const hits = termHits(source, testCase)
  const duplicate = Boolean(normalizedUrl && seenUrls.has(normalizedUrl))

  if (!normalizedUrl || !host) {
    return {
      sourceId,
      caseId: testCase.id,
      provider,
      mode,
      url,
      title,
      label: 'F',
      useful: false,
      reason: 'broken',
      labeler: 'heuristic',
      notes: 'Missing or unparsable URL.',
    }
  }

  if (duplicate) {
    return {
      sourceId,
      caseId: testCase.id,
      provider,
      mode,
      url: normalizedUrl,
      title,
      label: 'D',
      useful: false,
      reason: 'duplicate',
      labeler: 'heuristic',
      notes: 'Duplicate normalized URL already seen for this case/provider row.',
    }
  }

  if (testCase.category === 'polymarket' && hostMatches(host, 'polymarket.com')) {
    return {
      sourceId,
      caseId: testCase.id,
      provider,
      mode,
      url: normalizedUrl,
      title,
      label: 'D',
      useful: false,
      reason: 'polymarket_page',
      labeler: 'heuristic',
      notes: 'Polymarket page is not counted as useful for official resolution-source discovery.',
    }
  }

  if (anyHostMatches(host, testCase.expectedDomains)) {
    return {
      sourceId,
      caseId: testCase.id,
      provider,
      mode,
      url: normalizedUrl,
      title,
      label: 'A',
      useful: true,
      reason: 'expected_domain',
      labeler: 'heuristic',
      notes: 'Host matches an expected case domain.',
    }
  }

  if (isSearchOrAggregatorUrl(normalizedUrl, host)) {
    return {
      sourceId,
      caseId: testCase.id,
      provider,
      mode,
      url: normalizedUrl,
      title,
      label: 'D',
      useful: false,
      reason: 'aggregator',
      labeler: 'heuristic',
      notes: 'Search, market, or aggregator page.',
    }
  }

  if (socialDomains.some((domain) => hostMatches(host, domain))) {
    return {
      sourceId,
      caseId: testCase.id,
      provider,
      mode,
      url: normalizedUrl,
      title,
      label: hits >= 2 ? 'C' : 'F',
      useful: false,
      reason: hits >= 2 ? 'context' : 'off_topic',
      labeler: 'heuristic',
      notes: 'Social or discussion source; not accepted for this cost-per-useful run.',
    }
  }

  if (reputableDomains.some((domain) => hostMatches(host, domain)) && hits >= 2) {
    return {
      sourceId,
      caseId: testCase.id,
      provider,
      mode,
      url: normalizedUrl,
      title,
      label: 'B',
      useful: true,
      reason: 'reputable_reporting',
      labeler: 'heuristic',
      notes: 'Reputable reporting host with query-entity matches.',
    }
  }

  if (hits >= 2) {
    return {
      sourceId,
      caseId: testCase.id,
      provider,
      mode,
      url: normalizedUrl,
      title,
      label: 'B',
      useful: true,
      reason: 'entity_match',
      labeler: 'heuristic',
      notes: 'Title, snippet, or URL contains multiple core query entities and is not an excluded source type.',
    }
  }

  if (hits === 1) {
    return {
      sourceId,
      caseId: testCase.id,
      provider,
      mode,
      url: normalizedUrl,
      title,
      label: 'C',
      useful: false,
      reason: 'context',
      labeler: 'heuristic',
      notes: 'Only weak entity overlap; context not counted useful for this experiment.',
    }
  }

  return {
    sourceId,
    caseId: testCase.id,
    provider,
    mode,
    url: normalizedUrl,
    title,
    label: 'F',
    useful: false,
    reason: 'off_topic',
    labeler: 'heuristic',
    notes: 'No meaningful query-entity overlap in URL, title, or snippet.',
  }
}

function urls(sources: SourceLike[]) {
  return sources.map((source) => source.url).filter((url): url is string => Boolean(url))
}

function topDomains(sourceUrls: string[]) {
  const counts = new Map<string, number>()
  for (const url of sourceUrls) {
    const host = hostOf(url)
    if (!host) continue
    counts.set(host, (counts.get(host) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([domain, count]) => ({ domain, count }))
}

function costPer(costUSD: number, count: number) {
  return count === 0 ? null : roundUSD(costUSD / count)
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
  if (row.mode !== mode) throw new Error(`row.mode must be ${mode}`)
  if (!Number.isInteger(row.sources) || (row.sources as number) < 0) throw new Error('row.sources must be a non-negative integer')
  if (typeof row.costUSD !== 'number' || row.costUSD < 0) throw new Error('row.costUSD must be a non-negative number')
  if (!Number.isInteger(row.latencyMs) || (row.latencyMs as number) < 0) throw new Error('row.latencyMs must be a non-negative integer')
  if (!row.stats || typeof row.stats !== 'object') throw new Error('row.stats must be an object')
  if (!row.metrics || typeof row.metrics !== 'object') throw new Error('row.metrics must be an object')
}

function runCli(args: string[], outFile?: string): CliRun {
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

const repoRoot = process.cwd()
const runId = process.env.RUN_ID || `${isoCompact(new Date())}-${experiment}-pilot`
const runDir = join('protoblocks', 'src', experiment, 'runs', runId)
const rawDir = join(runDir, 'raw')
const ledgerPath = join(runDir, 'ledger.db')
const commands: string[] = []

mkdirSync(rawDir, { recursive: true })

writeFileSync(join(runDir, 'cases.jsonl'), cases.map(jsonLine).join(''))
writeFileSync(
  join(runDir, 'sampling.md'),
  [
    `# Sampling - ${runId}`,
    '',
    `- Source: fixed 5-case pilot seed list embedded in \`protoblocks/src/${experiment}/run-pilot.ts\`.`,
    `- Sampled: ${new Date().toISOString()} UTC.`,
    '- Filters: two Polymarket-style resolution-source prompts, one current-news prompt, one official-domain prompt, one known-answer/long-tail prompt.',
    '- Case cap: 5.',
    `- Provider call cap: 50; planned calls: ${cases.length * providerSet.length} scan calls.`,
    '- Exclusions: research mode and full 100-case dataset deferred until after pilot.',
    '',
  ].join('\n'),
)

const providersRun = runCli(['src/cli/main.ts', 'providers', '--json'], join(runDir, 'providers.json'))
writeFileSync(join(rawDir, 'providers.stderr.txt'), providersRun.stderr)

const rows: Record<string, unknown>[] = []
const labels: SourceLabel[] = []

for (const testCase of cases) {
  for (const provider of providerSet) {
    const rawSlug = `${testCase.id}__${provider}__${mode}`
    const run = runCli([
      'src/cli/main.ts',
      mode,
      testCase.q,
      '--providers',
      provider,
      '--max',
      String(maxResults),
      '--timeout',
      String(timeoutMs),
      '--fresh',
      '--json',
    ])
    writeFileSync(join(rawDir, `${rawSlug}.stdout.json`), run.stdout)
    writeFileSync(join(rawDir, `${rawSlug}.stderr.txt`), run.stderr)

    const providerStats = run.result?.stats?.providers?.[provider]
    const sources = run.result?.sources ?? []
    const seenUrls = new Set<string>()
    const rowLabels = sources.map((source, index) => {
      const label = labelSource(source, testCase, provider, index, seenUrls)
      if (label.url) seenUrls.add(label.url)
      return label
    })
    labels.push(...rowLabels)

    const sourceUrls = urls(sources)
    const usefulLabels = rowLabels.filter((label) => label.useful)
    const uniqueUsefulUrls = new Set(usefulLabels.map((label) => label.url).filter(Boolean))
    const costUSD = roundUSD(run.result?.cost?.byProvider?.[provider]?.usd ?? run.result?.cost?.totalUSD ?? 0)
    const latencyMs = Math.max(0, Math.round(providerStats?.latencyMs ?? run.result?.timing?.totalMs ?? run.elapsedMs))
    const errors: { code: string; message: string; stage: string }[] = []
    if (run.parseError) errors.push({ code: 'parse_error', message: run.parseError, stage: 'provider_call' })
    if (run.exitCode !== 0 && !run.result) {
      errors.push({
        code: 'cli_exit',
        message: run.stderr.trim() || `CLI exited ${run.exitCode}`,
        stage: 'provider_call',
      })
    }
    if (providerStats?.error) {
      errors.push({
        code: providerStats.error.code ?? 'provider_error',
        message: providerStats.error.message ?? 'Provider error',
        stage: 'provider_call',
      })
    }

    const row = {
      runId,
      timestamp: new Date().toISOString(),
      experiment,
      caseId: testCase.id,
      provider,
      query: testCase.q,
      mode,
      sources: sourceUrls.length,
      sourceUrls,
      costUSD,
      latencyMs,
      stats: {
        exitCode: run.exitCode,
        sweepId: run.result?.sweepId ?? null,
        provider: providerStats ?? null,
        totalHits: run.result?.stats?.totalHits ?? 0,
        uniqueSources: run.result?.stats?.uniqueSources ?? sourceUrls.length,
        overlapPct: run.result?.stats?.overlapPct ?? 0,
        costBasis: run.result?.cost?.byProvider?.[provider]?.basis ?? null,
        rawStdout: `raw/${rawSlug}.stdout.json`,
        rawStderr: `raw/${rawSlug}.stderr.txt`,
      },
      metrics: {
        totalSources: sourceUrls.length,
        usefulSources: usefulLabels.length,
        uniqueUsefulSources: uniqueUsefulUrls.size,
        usefulSourceRate: sourceUrls.length === 0 ? 0 : roundMetric(usefulLabels.length / sourceUrls.length),
        costPerUseful: costPer(costUSD, usefulLabels.length),
        costPerUniqueUseful: costPer(costUSD, uniqueUsefulUrls.size),
        usefulLatencyMs: usefulLabels.length === 0 ? null : roundMetric(latencyMs / usefulLabels.length),
        uniqueUsefulLatencyMs: uniqueUsefulUrls.size === 0 ? null : roundMetric(latencyMs / uniqueUsefulUrls.size),
        acceptedReasons: Object.fromEntries(
          [...new Set(usefulLabels.map((label) => label.reason))]
            .sort()
            .map((reason) => [reason, usefulLabels.filter((label) => label.reason === reason).length]),
        ),
        rejectedReasons: Object.fromEntries(
          [...new Set(rowLabels.filter((label) => !label.useful).map((label) => label.reason))]
            .sort()
            .map((reason) => [reason, rowLabels.filter((label) => !label.useful && label.reason === reason).length]),
        ),
        topDomains: topDomains(sourceUrls),
      },
      ...(errors.length ? { errors } : {}),
    }
    validateRow(row)
    rows.push(row)
  }
}

writeFileSync(join(runDir, 'rows.jsonl'), rows.map(jsonLine).join(''))
writeFileSync(join(runDir, 'manual-labels.jsonl'), labels.map(jsonLine).join(''))

function providerRows(provider: string) {
  return rows.filter((row) => row.provider === provider)
}

function sumMetric(provider: string, key: 'totalSources' | 'usefulSources' | 'uniqueUsefulSources') {
  return providerRows(provider).reduce((sum, row) => sum + Number((row.metrics as Record<string, unknown>)[key] ?? 0), 0)
}

function sumCost(provider: string) {
  return roundUSD(providerRows(provider).reduce((sum, row) => sum + Number(row.costUSD ?? 0), 0))
}

function avgLatency(provider: string) {
  const providerRowsList = providerRows(provider)
  if (!providerRowsList.length) return 0
  return Math.round(providerRowsList.reduce((sum, row) => sum + Number(row.latencyMs ?? 0), 0) / providerRowsList.length)
}

const providerMetrics = providerSet.map((provider) => {
  const totalSources = sumMetric(provider, 'totalSources')
  const usefulSources = sumMetric(provider, 'usefulSources')
  const uniqueUsefulSources = sumMetric(provider, 'uniqueUsefulSources')
  const costUSD = sumCost(provider)
  return {
    provider,
    calls: providerRows(provider).length,
    costUSD,
    totalSources,
    usefulSources,
    uniqueUsefulSources,
    usefulSourceRate: totalSources === 0 ? 0 : roundMetric(usefulSources / totalSources),
    costPerUseful: costPer(costUSD, usefulSources),
    costPerUniqueUseful: costPer(costUSD, uniqueUsefulSources),
    avgLatencyMs: avgLatency(provider),
    errors: providerRows(provider).filter((row) => Array.isArray(row.errors) && row.errors.length > 0).length,
  }
})

const totalCostUSD = roundUSD(rows.reduce((sum, row) => sum + Number(row.costUSD ?? 0), 0))
const totalUsefulSources = rows.reduce((sum, row) => sum + Number((row.metrics as Record<string, unknown>).usefulSources ?? 0), 0)
const totalUniqueUsefulSources = rows.reduce((sum, row) => sum + Number((row.metrics as Record<string, unknown>).uniqueUsefulSources ?? 0), 0)
const freeProviders = ['brave', 'jina', 'sailor', 'searchx']
const paidProviders = ['desearch', 'exa', 'tavily']
const freeUseful = freeProviders.reduce((sum, provider) => sum + sumMetric(provider, 'usefulSources'), 0)
const paidUseful = paidProviders.reduce((sum, provider) => sum + sumMetric(provider, 'usefulSources'), 0)
const freeCost = roundUSD(freeProviders.reduce((sum, provider) => sum + sumCost(provider), 0))
const paidCost = roundUSD(paidProviders.reduce((sum, provider) => sum + sumCost(provider), 0))

const sortedByCostPerUseful = [...providerMetrics].sort((a, b) => {
  const aValue = a.costPerUseful ?? Number.POSITIVE_INFINITY
  const bValue = b.costPerUseful ?? Number.POSITIVE_INFINITY
  return aValue - bValue || b.usefulSources - a.usefulSources || a.provider.localeCompare(b.provider)
})

const sortedByCostPerUniqueUseful = [...providerMetrics].sort((a, b) => {
  const aValue = a.costPerUniqueUseful ?? Number.POSITIVE_INFINITY
  const bValue = b.costPerUniqueUseful ?? Number.POSITIVE_INFINITY
  return aValue - bValue || b.uniqueUsefulSources - a.uniqueUsefulSources || a.provider.localeCompare(b.provider)
})

const examples = rows
  .map((row) => ({
    caseId: row.caseId,
    provider: row.provider,
    costUSD: row.costUSD,
    latencyMs: row.latencyMs,
    usefulSources: (row.metrics as Record<string, unknown>).usefulSources,
    uniqueUsefulSources: (row.metrics as Record<string, unknown>).uniqueUsefulSources,
    costPerUniqueUseful: (row.metrics as Record<string, unknown>).costPerUniqueUseful,
    topDomains: (row.metrics as Record<string, unknown>).topDomains,
  }))
  .sort((a, b) => {
    const aUseful = Number(a.uniqueUsefulSources ?? 0)
    const bUseful = Number(b.uniqueUsefulSources ?? 0)
    if (bUseful !== aUseful) return bUseful - aUseful
    return Number(a.costUSD ?? 0) - Number(b.costUSD ?? 0)
  })
  .slice(0, 3)

const summary = {
  runId,
  experiment,
  mode,
  providerSet,
  lowCostFirstPass,
  paidComparison,
  caseCount: cases.length,
  callCount: rows.length,
  providerCallCap: 50,
  costUSD: totalCostUSD,
  mainMetrics: {
    totalSources: rows.reduce((sum, row) => sum + Number(row.sources ?? 0), 0),
    totalUsefulSources,
    totalUniqueUsefulSources,
    costPerUseful: costPer(totalCostUSD, totalUsefulSources),
    costPerUniqueUseful: costPer(totalCostUSD, totalUniqueUsefulSources),
    providerRankingByCostPerUseful: sortedByCostPerUseful,
    providerRankingByCostPerUniqueUseful: sortedByCostPerUniqueUseful,
    paidProviderLiftOverFree: {
      freeProviders,
      paidProviders,
      freeCostUSD: freeCost,
      paidCostUSD: paidCost,
      freeUsefulSources: freeUseful,
      paidUsefulSources: paidUseful,
      freeCostPerUseful: costPer(freeCost, freeUseful),
      paidCostPerUseful: costPer(paidCost, paidUseful),
    },
    heuristicAudit: {
      labelCount: labels.length,
      acceptedLabels: labels.filter((label) => label.useful).length,
      rejectedLabels: labels.filter((label) => !label.useful).length,
      note: 'All visible sources were rubric-labeled by deterministic heuristic using host, duplicate, aggregator, social, and query-entity rules; no source bodies were opened manually in this pilot.',
    },
  },
  examplesThatChangedInterpretation: examples,
  projectChangesJustified: 'needs_more_data',
  commands,
}

writeFileSync(join(runDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
writeFileSync(
  join(runDir, 'notes.md'),
  [
    `# Notes - ${runId}`,
    '',
    '## Scope',
    '',
    `Pilot only. Ran \`${mode}\` mode for 5 fixed cases across ${providerSet.length} providers: ${providerSet.join(', ')}.`,
    `Low-Cost First Pass providers were ${lowCostFirstPass.join(', ')}. Added ${paidComparison.join(', ')} for paid comparison while staying under the 50-call cap.`,
    '',
    '## Labeling',
    '',
    'Labels use the Useful Source Rubric categories A/B/C/D/F. A and B count as useful. C is retained as context but not counted useful because this experiment measures answer-bearing source value.',
    'The pilot uses deterministic heuristic labels from URL/title/snippet only. This is intentionally lightweight; the full run should include a stricter manual audit of a sampled accepted/rejected set.',
    '',
    '## Measurement Notes',
    '',
    '- `providers.json` is live inventory, not doctor output; no doctor calls were run.',
    '- Every provider call used `--fresh` and the run-local ledger.',
    '- Costs are wideband-reported or adapter-estimated costs from scan responses.',
    '- `research` mode was not run to keep the pilot under the user-specified provider-call cap.',
    '',
    '## Commands',
    '',
    ...commands.map((command) => `- \`${command}\``),
    '',
  ].join('\n'),
)

console.log(JSON.stringify({ runId, runDir, rows: rows.length, labels: labels.length, costUSD: totalCostUSD }, null, 2))
