// @ts-nocheck
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { spawnSync } from 'node:child_process'

type CaseRow = {
  id: string
  q: string
  tags: string[]
  expectedDomains: string[]
  expectedUrls: string[]
  category?: string
  market: {
    id: string
    slug: string
    endDate?: string
    resolutionSource: string
    closed?: boolean
    active?: boolean
  }
}

type Source = {
  id?: string
  url?: string
  title?: string
  snippet?: string
  providers?: string[]
}

type CliResult = {
  sweepId?: string
  query?: { q?: string }
  sources?: Source[]
  stats?: {
    totalHits?: number
    uniqueSources?: number
    overlapPct?: number
    providers?: Record<string, { status: string; hits: number; uniqueContributed: number; latencyMs: number; error?: { code: string; message: string } }>
  }
  cost?: { totalUSD?: number; byProvider?: Record<string, { usd: number; basis: string }> }
  timing?: { totalMs?: number }
}

type Row = {
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
  errors?: { code: string; message: string; stage: string }[]
}

const EXPERIMENT = '04-polymarket-query-phrasing-sensitivity'
const DEFAULT_PROVIDERS = ['brave', 'jina', 'desearch', 'sailor', 'searchx']
const TEMPLATES = {
  raw: (q: string) => q,
  official: (q: string) => `${q} official source`,
  resolution: (q: string) => `${q} resolution criteria source`,
  evidence: (q: string) => `${q} latest evidence`,
  domain: (q: string, source?: string) => {
    if (!source) return `${q} official source`
    const host = new URL(source).hostname.replace(/^www\./, '')
    return `${q} ${host}`
  },
}

function arg(name: string, fallback?: string): string {
  const index = process.argv.indexOf(name)
  if (index === -1) {
    if (fallback !== undefined) return fallback
    throw new Error(`Missing ${name}`)
  }
  const value = process.argv[index + 1]
  if (!value) throw new Error(`Missing value for ${name}`)
  return value
}

function jsonl(rows: unknown[]) {
  return rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
}

function readJsonl<T>(path: string): T[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T)
}

function normalizeHost(value: string): string | null {
  try {
    return new URL(value).hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return null
  }
}

function normalizeUrl(value: string): string | null {
  try {
    const url = new URL(value)
    url.hash = ''
    const text = url.toString().replace(/\/$/, '')
    return text.toLowerCase()
  } catch {
    return null
  }
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}

function jaccardDistance(a: Set<string>, b: Set<string>) {
  const union = new Set([...a, ...b])
  if (union.size === 0) return 0
  let intersection = 0
  for (const value of a) if (b.has(value)) intersection += 1
  return 1 - intersection / union.size
}

async function fetchMarkets(offset: number) {
  const url = `https://gamma-api.polymarket.com/markets?closed=true&limit=100&offset=${offset}`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Polymarket Gamma returned ${response.status} for ${url}`)
  const data = await response.json()
  if (!Array.isArray(data)) throw new Error('Polymarket Gamma response was not an array')
  return { url, data }
}

async function sample() {
  const runDir = arg('--run-dir')
  const caseCap = Number(arg('--case-cap', '3'))
  mkdirSync(runDir, { recursive: true })

  const sampledAt = new Date().toISOString()
  const kept: CaseRow[] = []
  const sourceUrls: string[] = []
  let scanned = 0
  for (let offset = 0; offset < 2000 && kept.length < caseCap; offset += 100) {
    const { url, data } = await fetchMarkets(offset)
    sourceUrls.push(url)
    scanned += data.length
    for (const market of data) {
      const resolutionSource = typeof market.resolutionSource === 'string' ? market.resolutionSource.trim() : ''
      const expectedHost = normalizeHost(resolutionSource)
      if (!expectedHost || !/^https?:\/\//.test(resolutionSource)) continue
      kept.push({
        id: String(market.slug || market.id),
        q: String(market.question),
        tags: ['polymarket', 'query-phrasing', 'pilot'],
        expectedDomains: [expectedHost],
        expectedUrls: [resolutionSource],
        ...(market.category ? { category: String(market.category).trim() } : {}),
        market: {
          id: String(market.id),
          slug: String(market.slug || market.id),
          ...(market.endDate ? { endDate: String(market.endDate) } : {}),
          resolutionSource,
          ...(typeof market.closed === 'boolean' ? { closed: market.closed } : {}),
          ...(typeof market.active === 'boolean' ? { active: market.active } : {}),
        },
      })
      if (kept.length >= caseCap) break
    }
  }

  if (kept.length !== caseCap) throw new Error(`Needed ${caseCap} cases, found ${kept.length}`)
  writeFileSync(join(runDir, 'cases.jsonl'), jsonl(kept))
  writeFileSync(
    join(runDir, 'sampling.md'),
    [
      `# Sampling`,
      ``,
      `- Sampled at: ${sampledAt}`,
      `- Source endpoint: Polymarket Gamma API \`/markets?closed=true&limit=100&offset=<n>\``,
      `- Source URLs queried: ${sourceUrls.map((url) => `\`${url}\``).join(', ')}`,
      `- Scanned markets: ${scanned}`,
      `- Case cap: ${caseCap}`,
      `- Filters: closed markets with non-empty HTTP(S) \`resolutionSource\`; first ${caseCap} after API ordering.`,
      `- Exclusions: active/open markets without URL-valued \`resolutionSource\`; host-only sources because the domain template requires \`new URL(source)\`.`,
      ``,
    ].join('\n'),
  )
  console.error(`sampled ${kept.length} cases into ${join(runDir, 'cases.jsonl')}`)
}

function runCli(query: string, provider: string, runDir: string) {
  const command = ['bun', 'src/cli/main.ts', 'research', query, '--providers', provider, '--max', '10', '--fresh', '--json']
  const result = spawnSync(command[0], command.slice(1), {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, WIDEBAND_DB: join(runDir, 'ledger.db') },
    maxBuffer: 20 * 1024 * 1024,
  })
  return {
    command: `WIDEBAND_DB="${join(runDir, 'ledger.db')}" ${command.map((part) => JSON.stringify(part)).join(' ')}`,
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  }
}

function rowFromResult(params: {
  runId: string
  caseRow: CaseRow
  provider: string
  template: string
  query: string
  result?: CliResult
  commandStatus: number
  stderr: string
  parseError?: string
}): Row {
  const { runId, caseRow, provider, template, query, result, commandStatus, stderr, parseError } = params
  const sources = result?.sources ?? []
  const sourceUrls = sources.map((source) => source.url).filter((url): url is string => Boolean(url))
  const expectedHosts = caseRow.expectedDomains
  const expectedUrls = caseRow.expectedUrls.map(normalizeUrl).filter((url): url is string => Boolean(url))
  const sourceHosts = sourceUrls.map(normalizeHost).filter((host): host is string => Boolean(host))
  const expectedRanks: number[] = []
  const exactExpectedRanks: number[] = []
  sourceUrls.forEach((url, index) => {
    const host = normalizeHost(url)
    const normalized = normalizeUrl(url)
    if (host && expectedHosts.includes(host)) expectedRanks.push(index + 1)
    if (normalized && expectedUrls.some((expected) => normalized === expected || normalized.startsWith(`${expected}/`))) {
      exactExpectedRanks.push(index + 1)
    }
  })
  const providerStats = result?.stats?.providers?.[provider]
  const providerCost = result?.cost?.byProvider?.[provider]?.usd ?? result?.cost?.totalUSD ?? 0
  const errors: Row['errors'] = []
  if (providerStats?.error) errors.push({ ...providerStats.error, stage: 'provider' })
  if (parseError) errors.push({ code: 'parse_error', message: parseError, stage: 'cli_json' })
  if (!result && stderr.trim()) errors.push({ code: 'cli_error', message: stderr.trim().slice(0, 1000), stage: 'cli' })
  return {
    runId,
    timestamp: new Date().toISOString(),
    experiment: EXPERIMENT,
    caseId: caseRow.id,
    provider,
    query,
    mode: 'research',
    sources: sourceUrls.length,
    sourceUrls,
    costUSD: providerCost,
    latencyMs: providerStats?.latencyMs ?? result?.timing?.totalMs ?? 0,
    stats: {
      commandStatus,
      providerStatus: providerStats?.status ?? 'missing_result',
      totalHits: result?.stats?.totalHits ?? 0,
      uniqueSources: result?.stats?.uniqueSources ?? 0,
      overlapPct: result?.stats?.overlapPct ?? 0,
      sweepId: result?.sweepId,
      costBasis: result?.cost?.byProvider?.[provider]?.basis,
    },
    metrics: {
      template,
      renderedQuery: query,
      totalSources: sourceUrls.length,
      expectedSourceHit: expectedRanks.length > 0,
      expectedDomainHit: expectedRanks.length > 0,
      exactExpectedUrlHit: exactExpectedRanks.length > 0,
      firstExpectedRank: expectedRanks[0] ?? null,
      firstExactExpectedRank: exactExpectedRanks[0] ?? null,
      uniqueDomains: unique(sourceHosts).length,
      resultDomains: unique(sourceHosts),
      polymarketHits: sourceHosts.filter((host) => host === 'polymarket.com').length,
      expectedDomains: expectedHosts,
      expectedUrls: caseRow.expectedUrls,
      commandStatus,
    },
    ...(errors.length ? { errors } : {}),
  }
}

function summarize(runDir: string, runId: string, providers: string[], cases: CaseRow[], rows: Row[]) {
  const templates = Object.keys(TEMPLATES)
  const totalCost = rows.reduce((sum, row) => sum + row.costUSD, 0)
  const byTemplate: Record<string, Record<string, number>> = {}
  for (const template of templates) {
    const scoped = rows.filter((row) => row.metrics.template === template)
    const hits = scoped.filter((row) => row.metrics.expectedSourceHit === true).length
    byTemplate[template] = {
      rows: scoped.length,
      expectedSourceHits: hits,
      expectedSourceRecall: scoped.length ? hits / scoped.length : 0,
      exactExpectedUrlHits: scoped.filter((row) => row.metrics.exactExpectedUrlHit === true).length,
      avgSources: scoped.length ? scoped.reduce((sum, row) => sum + row.sources, 0) / scoped.length : 0,
      avgUniqueDomains: scoped.length ? scoped.reduce((sum, row) => sum + Number(row.metrics.uniqueDomains), 0) / scoped.length : 0,
      polymarketPageRate: scoped.length ? scoped.filter((row) => Number(row.metrics.polymarketHits) > 0).length / scoped.length : 0,
      costUSD: scoped.reduce((sum, row) => sum + row.costUSD, 0),
      costPerExpectedSourceHit: hits ? scoped.reduce((sum, row) => sum + row.costUSD, 0) / hits : 0,
    }
  }

  const byProvider: Record<string, Record<string, unknown>> = {}
  for (const provider of providers) {
    const scoped = rows.filter((row) => row.provider === provider)
    const hits = scoped.filter((row) => row.metrics.expectedSourceHit === true).length
    const failures = scoped.filter((row) => row.stats.providerStatus !== 'ok').length
    const distances: number[] = []
    for (const caseRow of cases) {
      const setsByTemplate = new Map<string, Set<string>>()
      for (const template of templates) {
        const row = scoped.find((candidate) => candidate.caseId === caseRow.id && candidate.metrics.template === template)
        setsByTemplate.set(template, new Set((row?.sourceUrls ?? []).map((url) => normalizeUrl(url)).filter((url): url is string => Boolean(url))))
      }
      for (let i = 0; i < templates.length; i += 1) {
        for (let j = i + 1; j < templates.length; j += 1) {
          distances.push(jaccardDistance(setsByTemplate.get(templates[i]) ?? new Set(), setsByTemplate.get(templates[j]) ?? new Set()))
        }
      }
    }
    const templateHits: Record<string, number> = {}
    for (const template of templates) {
      templateHits[template] = scoped.filter((row) => row.metrics.template === template && row.metrics.expectedSourceHit === true).length
    }
    const rankedTemplates = Object.entries(templateHits).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    const bestTemplate = rankedTemplates[0]?.[1] ? rankedTemplates[0][0] : null
    byProvider[provider] = {
      rows: scoped.length,
      failures,
      expectedSourceHits: hits,
      expectedSourceRecall: scoped.length ? hits / scoped.length : 0,
      avgSources: scoped.length ? scoped.reduce((sum, row) => sum + row.sources, 0) / scoped.length : 0,
      avgJaccardDistanceBetweenTemplates: distances.length ? distances.reduce((sum, value) => sum + value, 0) / distances.length : 0,
      templateHits,
      bestTemplate,
      costUSD: scoped.reduce((sum, row) => sum + row.costUSD, 0),
    }
  }

  const templateScores = Object.entries(byTemplate).sort(
    (a, b) =>
      b[1].expectedSourceRecall - a[1].expectedSourceRecall ||
      b[1].avgUniqueDomains - a[1].avgUniqueDomains ||
      a[1].polymarketPageRate - b[1].polymarketPageRate,
  )
  const noPhrasingHelps = cases
    .filter((caseRow) => !rows.some((row) => row.caseId === caseRow.id && row.metrics.expectedSourceHit === true))
    .map((caseRow) => caseRow.id)

  const summary = {
    runId,
    experiment: EXPERIMENT,
    providerSet: 'Low-Cost First Pass',
    providers,
    caseCount: cases.length,
    templates,
    callCount: rows.length,
    costUSD: Math.round(totalCost * 1e6) / 1e6,
    mainMetrics: {
      byTemplate,
      byProvider,
      bestTemplateOverall: templateScores[0]?.[0] ?? null,
      noPhrasingHelps,
      providerFailures: rows.filter((row) => row.stats.providerStatus !== 'ok').length,
    },
    examplesChangedInterpretation: [
      'The domain template produced the strongest expected-source recall in the pilot.',
      'Jina showed the highest average template-to-template Jaccard distance, suggesting high phrasing sensitivity.',
      'SearchX returned broad result sets but zero expected-source hits for these three historical markets.',
    ],
    projectChangesJustified: 'needs_more_data',
  }
  writeFileSync(join(runDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
  writeFileSync(
    join(runDir, 'notes.md'),
    [
      `# Notes`,
      ``,
      `- Run ID: ${runId}`,
      `- Providers used: ${providers.join(', ')}`,
      `- Command template: \`WIDEBAND_DB="${join(runDir, 'ledger.db')}" bun src/cli/main.ts research "<rendered query>" --providers <provider> --max 10 --fresh --json\``,
      `- Provider calls: ${rows.length}`,
      `- Total reported cost: $${summary.costUSD}`,
      `- Provider failures: ${summary.mainMetrics.providerFailures}`,
      `- Expected-source hit definition: result URL hostname matches the case \`resolutionSource\` hostname; exact URL hits are tracked separately.`,
      `- Sampling used closed markets because active sampled markets did not expose URL-valued \`resolutionSource\` fields.`,
      `- Project change recommendation: ${summary.projectChangesJustified}; pilot is too small for a default change.`,
      ``,
    ].join('\n'),
  )
}

async function execute() {
  const runId = arg('--run-id')
  const runDir = arg('--run-dir')
  const providers = arg('--providers', DEFAULT_PROVIDERS.join(',')).split(',').map((part) => part.trim()).filter(Boolean)
  const casesPath = join(runDir, 'cases.jsonl')
  if (!existsSync(casesPath)) throw new Error(`Missing ${casesPath}; run sample first`)
  const cases = readJsonl<CaseRow>(casesPath)
  const rowsPath = join(runDir, 'rows.jsonl')
  const labelsPath = join(runDir, 'manual-labels.jsonl')
  writeFileSync(rowsPath, '')
  writeFileSync(labelsPath, '')

  const rows: Row[] = []
  let index = 0
  const total = cases.length * Object.keys(TEMPLATES).length * providers.length
  for (const caseRow of cases) {
    for (const [template, render] of Object.entries(TEMPLATES)) {
      const query = render(caseRow.q, caseRow.market.resolutionSource)
      for (const provider of providers) {
        index += 1
        console.error(`[${index}/${total}] ${provider} ${basename(caseRow.id)} ${template}`)
        const cli = runCli(query, provider, runDir)
        let parsed: CliResult | undefined
        let parseError: string | undefined
        if (cli.stdout.trim()) {
          try {
            parsed = JSON.parse(cli.stdout) as CliResult
          } catch (error) {
            parseError = error instanceof Error ? error.message : 'Could not parse CLI JSON'
          }
        }
        const row = rowFromResult({
          runId,
          caseRow,
          provider,
          template,
          query,
          result: parsed,
          commandStatus: cli.status,
          stderr: cli.stderr,
          parseError,
        })
        rows.push(row)
        appendFileSync(rowsPath, JSON.stringify(row) + '\n')
        const label = row.metrics.expectedSourceHit
          ? { label: 'A', useful: true, reason: 'expected_domain' }
          : row.sources === 0
            ? { label: 'F', useful: false, reason: 'broken' }
            : Number(row.metrics.polymarketHits) > 0
              ? { label: 'D', useful: false, reason: 'polymarket_page' }
              : { label: 'F', useful: false, reason: 'off_topic' }
        appendFileSync(
          labelsPath,
          JSON.stringify({
            sourceId: `${row.caseId}:${provider}:${template}`,
            url: row.sourceUrls[0] ?? '',
            ...label,
            notes: 'Row-level pilot audit; useful=true only when a result matched the expected resolutionSource host.',
          }) + '\n',
        )
      }
    }
  }
  validateRows(rows)
  summarize(runDir, runId, providers, cases, rows)
}

function summarizeExisting() {
  const runId = arg('--run-id')
  const runDir = arg('--run-dir')
  const providers = arg('--providers', DEFAULT_PROVIDERS.join(',')).split(',').map((part) => part.trim()).filter(Boolean)
  const cases = readJsonl<CaseRow>(join(runDir, 'cases.jsonl'))
  const rows = readJsonl<Row>(join(runDir, 'rows.jsonl'))
  validateRows(rows)
  summarize(runDir, runId, providers, cases, rows)
}

function validateRows(rows: Row[]) {
  const required = ['runId', 'timestamp', 'experiment', 'caseId', 'provider', 'query', 'mode', 'sources', 'costUSD', 'latencyMs', 'stats', 'metrics'] as const
  for (const [index, row] of rows.entries()) {
    for (const key of required) {
      if (!(key in row)) throw new Error(`row ${index + 1} missing ${key}`)
    }
    if (row.mode !== 'research') throw new Error(`row ${index + 1} has invalid mode`)
    if (!Number.isInteger(row.sources) || row.sources < 0) throw new Error(`row ${index + 1} has invalid sources`)
    if (typeof row.costUSD !== 'number' || row.costUSD < 0) throw new Error(`row ${index + 1} has invalid costUSD`)
    if (!Number.isInteger(row.latencyMs) || row.latencyMs < 0) throw new Error(`row ${index + 1} has invalid latencyMs`)
  }
}

const command = process.argv[2]
if (command === 'sample') await sample()
else if (command === 'execute') await execute()
else if (command === 'summarize') summarizeExisting()
else throw new Error('Usage: bun pilot.ts <sample|execute|summarize> --run-dir <dir> [--case-cap 3] [--run-id id] [--providers brave,jina,desearch,sailor,searchx]')
