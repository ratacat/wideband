// @ts-nocheck
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

type Case = {
  id: string
  q: string
  category: string
  tags: string[]
  expectedDomains?: string[]
  expectedUrls?: string[]
  market?: { resolutionSource?: string; eventSlug?: string; marketSlug?: string; gammaTags?: string[] }
}

type Source = {
  id?: string
  url?: string
  title?: string
  snippet?: string
  publishedAt?: string
  providers?: string[]
  score?: number
}

type SweepResult = {
  sweepId?: string
  query?: { q?: string }
  sources?: Source[]
  stats?: {
    totalHits?: number
    uniqueSources?: number
    overlapPct?: number
    providers?: Record<string, { status?: string; hits?: number; uniqueContributed?: number; latencyMs?: number; error?: { code?: string; message?: string } }>
  }
  cost?: { totalUSD?: number; byProvider?: Record<string, { usd?: number; basis?: string }> }
  timing?: { totalMs?: number }
}

type Row = {
  runId: string
  timestamp: string
  experiment: string
  caseId: string
  category: string
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

const runDir = process.argv[2]
if (!runDir) throw new Error('usage: bun run-pilot.ts <run-dir>')

const runId = runDir.split('/').filter(Boolean).at(-1)
if (!runId) throw new Error(`could not infer run id from ${runDir}`)

const experiment = '02-polymarket-category-matrix'
const providers = ['brave', 'jina', 'desearch', 'sailor', 'searchx']
const rawDir = join(runDir, 'raw')
mkdirSync(rawDir, { recursive: true })

const cases = readFileSync(join(runDir, 'cases.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line) as Case)

function stableId(value: string) {
  return createHash('sha256').update(value).digest('hex').slice(0, 12)
}

function host(value: string | undefined) {
  if (!value) return ''
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}

function suffixHost(actual: string, expected: string) {
  return actual === expected || actual.endsWith(`.${expected}`)
}

function topDomains(urls: string[]) {
  const counts = new Map<string, number>()
  for (const url of urls) {
    const h = host(url)
    if (!h) continue
    counts.set(h, (counts.get(h) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([domain]) => domain)
}

const officialDomains: Record<string, string[]> = {
  politics: ['elysee.fr', 'gouvernement.fr', 'service-public.fr', 'legifrance.gouv.fr'],
  crypto: ['kraken.com', 'sec.gov', 'nasdaq.com', 'nyse.com'],
  sports: ['nhl.com', 'carolinahurricanes.com'],
  macro: ['nber.org', 'bea.gov', 'bls.gov', 'federalreserve.gov', 'treasury.gov', 'fred.stlouisfed.org'],
  culture: ['rihannanow.com', 'rockstargames.com', 'roc-nation.com'],
}

const reputableDomains = [
  'apnews.com',
  'axios.com',
  'bbc.com',
  'billboard.com',
  'bloomberg.com',
  'cbssports.com',
  'cnbc.com',
  'cnn.com',
  'espn.com',
  'financialpost.com',
  'forbes.com',
  'france24.com',
  'ft.com',
  'hollywoodreporter.com',
  'ign.com',
  'nhl.com',
  'politico.com',
  'reuters.com',
  'rollingstone.com',
  'sportsnet.ca',
  'theathletic.com',
  'theguardian.com',
  'variety.com',
  'wsj.com',
]

const socialDomains = ['x.com', 'twitter.com', 'reddit.com', 'youtube.com', 'facebook.com', 'instagram.com', 'tiktok.com']
const aggregatorDomains = ['polymarket.com', 'kalshi.com', 'manifold.markets', 'google.com', 'bing.com', 'duckduckgo.com', 'yahoo.com']
const stopWords = new Set(['will', 'the', 'and', 'for', 'with', 'before', 'after', 'latest', 'official', 'source', 'june', 'december', '2026', '2027', 'into', 'from', 'that', 'this'])

function relevanceTerms(c: Case) {
  return c.q
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((term) => term.length > 2 && !stopWords.has(term))
}

function sourceLabel(c: Case, source: Source) {
  const url = source.url ?? ''
  const h = host(url)
  const text = `${source.title ?? ''} ${source.snippet ?? ''} ${url}`.toLowerCase()
  const expected = c.expectedDomains ?? []
  const categoryOfficial = officialDomains[c.category] ?? []
  const terms = relevanceTerms(c)
  const relevant = terms.some((term) => text.includes(term))

  if (expected.some((domain) => suffixHost(h, domain)) || categoryOfficial.some((domain) => suffixHost(h, domain))) {
    return { label: 'A', useful: true, reason: 'official_source' }
  }
  if (aggregatorDomains.some((domain) => suffixHost(h, domain))) {
    return { label: 'D', useful: false, reason: suffixHost(h, 'polymarket.com') ? 'polymarket_page' : 'aggregator' }
  }
  if (socialDomains.some((domain) => suffixHost(h, domain))) {
    return { label: relevant ? 'C' : 'F', useful: false, reason: relevant ? 'context' : 'off_topic' }
  }
  if (relevant && reputableDomains.some((domain) => suffixHost(h, domain))) {
    return { label: 'B', useful: true, reason: 'reputable_reporting' }
  }
  if (relevant) return { label: 'C', useful: false, reason: 'context' }
  return { label: 'F', useful: false, reason: 'off_topic' }
}

function runProvider(c: Case, provider: string) {
  const query = `${c.q} latest official source`
  const command = ['bun', 'src/cli/main.ts', 'research', query, '--providers', provider, '--max', '10', '--fresh', '--json', '--full']
  const started = Date.now()
  const proc = spawnSync(command[0], command.slice(1), {
    cwd: process.cwd(),
    env: { ...process.env, WIDEBAND_DB: join(runDir, 'ledger.db') },
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 20,
  })
  const elapsed = Date.now() - started
  const slug = `${c.id}__${provider}`
  writeFileSync(join(rawDir, `${slug}.stdout.json`), proc.stdout || '')
  writeFileSync(join(rawDir, `${slug}.stderr.txt`), proc.stderr || '')

  let result: SweepResult | undefined
  let parseError: string | undefined
  if (proc.stdout.trim()) {
    try {
      result = JSON.parse(proc.stdout) as SweepResult
    } catch (error) {
      parseError = error instanceof Error ? error.message : 'failed to parse stdout'
    }
  }

  const providerStats = result?.stats?.providers?.[provider]
  const sources = result?.sources ?? []
  const urls = sources.map((source) => source.url).filter((url): url is string => Boolean(url))
  const expectedDomains = c.expectedDomains ?? []
  const officialDomainHits = urls.filter((url) => {
    const h = host(url)
    return [...expectedDomains, ...(officialDomains[c.category] ?? [])].some((domain) => suffixHost(h, domain))
  }).length
  const polymarketHits = urls.filter((url) => suffixHost(host(url), 'polymarket.com')).length
  const labels = sources.map((source, index) => {
    const label = sourceLabel(c, source)
    return {
      sourceId: source.id ?? stableId(`${c.id}:${provider}:${source.url ?? index}`),
      caseId: c.id,
      category: c.category,
      provider,
      url: source.url ?? '',
      title: source.title ?? '',
      label: label.label,
      useful: label.useful,
      reason: label.reason,
      notes: 'Pilot heuristic audit from URL/title/snippet; no sampled case had Gamma resolutionSource.',
    }
  })
  const usefulSources = labels.filter((label) => label.useful).length
  const costUSD = result?.cost?.byProvider?.[provider]?.usd ?? result?.cost?.totalUSD ?? 0
  const latencyMs = providerStats?.latencyMs ?? result?.timing?.totalMs ?? elapsed
  const errors =
    proc.status === 0 && !parseError && !providerStats?.error
      ? undefined
      : [
          {
            code: providerStats?.error?.code ?? (parseError ? 'parse_error' : `exit_${proc.status ?? 'signal'}`),
            message: providerStats?.error?.message ?? parseError ?? (proc.stderr.trim() || 'provider call failed'),
            stage: 'provider_call',
          },
        ]

  const row: Row = {
    runId,
    timestamp: new Date().toISOString(),
    experiment,
    caseId: c.id,
    category: c.category,
    provider,
    query,
    mode: 'research',
    sources: urls.length,
    sourceUrls: urls,
    costUSD,
    latencyMs,
    stats: {
      exitCode: proc.status,
      sweepId: result?.sweepId,
      provider: providerStats ?? null,
      totalHits: result?.stats?.totalHits ?? 0,
      uniqueSources: result?.stats?.uniqueSources ?? urls.length,
      overlapPct: result?.stats?.overlapPct ?? 0,
      costBasis: result?.cost?.byProvider?.[provider]?.basis ?? null,
      rawStdout: `raw/${slug}.stdout.json`,
      rawStderr: `raw/${slug}.stderr.txt`,
    },
    metrics: {
      category: c.category,
      providerStatus: providerStats?.status ?? (proc.status === 0 ? 'unknown' : 'error'),
      uniqueContributed: providerStats?.uniqueContributed ?? urls.length,
      officialDomainHits,
      officialDomainApplicable: expectedDomains.length > 0,
      polymarketHits,
      usefulSources,
      costPerUsefulSource: usefulSources > 0 ? costUSD / usefulSources : null,
      topDomains: topDomains(urls),
    },
    ...(errors ? { errors } : {}),
  }

  return { row, labels, command: `WIDEBAND_DB="${join(runDir, 'ledger.db')}" ${command.map((part) => (part.includes(' ') ? JSON.stringify(part) : part)).join(' ')}` }
}

const rows: Row[] = []
const labels: Record<string, unknown>[] = []
const commands: string[] = []

for (const c of cases) {
  for (const provider of providers) {
    const result = runProvider(c, provider)
    rows.push(result.row)
    labels.push(...result.labels)
    commands.push(result.command)
    writeFileSync(join(runDir, 'rows.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
    writeFileSync(join(runDir, 'manual-labels.jsonl'), labels.map((label) => JSON.stringify(label)).join('\n') + (labels.length ? '\n' : ''))
  }
}

const urlProvidersByCategory = new Map<string, Map<string, Set<string>>>()
for (const row of rows) {
  const byUrl = urlProvidersByCategory.get(row.category) ?? new Map<string, Set<string>>()
  for (const url of row.sourceUrls) {
    const key = url.toLowerCase().replace(/\/$/, '')
    const set = byUrl.get(key) ?? new Set<string>()
    set.add(row.provider)
    byUrl.set(key, set)
  }
  urlProvidersByCategory.set(row.category, byUrl)
}

for (const row of rows) {
  const byUrl = urlProvidersByCategory.get(row.category) ?? new Map<string, Set<string>>()
  const unique = row.sourceUrls.filter((url) => byUrl.get(url.toLowerCase().replace(/\/$/, ''))?.size === 1).length
  row.metrics.crossProviderUniqueContributed = unique
  row.metrics.crossProviderUniqueRate = row.sources > 0 ? unique / row.sources : null
}

writeFileSync(join(runDir, 'rows.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
writeFileSync(join(runDir, 'commands.txt'), commands.join('\n') + '\n')

function groupKey<T extends Record<string, unknown>>(items: T[], key: keyof T) {
  const out = new Map<string, T[]>()
  for (const item of items) {
    const value = String(item[key])
    const bucket = out.get(value) ?? []
    bucket.push(item)
    out.set(value, bucket)
  }
  return out
}

function sum(items: Row[], pick: (row: Row) => number) {
  return items.reduce((total, row) => total + pick(row), 0)
}

const byProvider = Object.fromEntries(
  [...groupKey(rows, 'provider').entries()].map(([provider, providerRows]) => [
    provider,
    {
      calls: providerRows.length,
      failures: providerRows.filter((row) => row.errors?.length).length,
      sources: sum(providerRows, (row) => row.sources),
      usefulSources: sum(providerRows, (row) => Number(row.metrics.usefulSources ?? 0)),
      officialDomainHits: sum(providerRows, (row) => Number(row.metrics.officialDomainHits ?? 0)),
      polymarketHits: sum(providerRows, (row) => Number(row.metrics.polymarketHits ?? 0)),
      crossProviderUniqueContributed: sum(providerRows, (row) => Number(row.metrics.crossProviderUniqueContributed ?? 0)),
      costUSD: sum(providerRows, (row) => row.costUSD),
      avgLatencyMs: Math.round(sum(providerRows, (row) => row.latencyMs) / providerRows.length),
    },
  ]),
)

const byCategory = Object.fromEntries(
  [...groupKey(rows, 'category').entries()].map(([category, categoryRows]) => {
    const providerRows = categoryRows
      .map((row) => ({
        provider: row.provider,
        sources: row.sources,
        usefulSources: Number(row.metrics.usefulSources ?? 0),
        officialDomainHits: Number(row.metrics.officialDomainHits ?? 0),
        polymarketHits: Number(row.metrics.polymarketHits ?? 0),
        crossProviderUniqueContributed: Number(row.metrics.crossProviderUniqueContributed ?? 0),
        latencyMs: row.latencyMs,
        costUSD: row.costUSD,
      }))
      .sort((a, b) => b.usefulSources - a.usefulSources || b.sources - a.sources || a.latencyMs - b.latencyMs)
    return [
      category,
      {
        providers: providerRows,
        bestProvider: providerRows[0]?.provider ?? null,
        worstProvider: providerRows.at(-1)?.provider ?? null,
        distinctUrls: urlProvidersByCategory.get(category)?.size ?? 0,
      },
    ]
  }),
)

const totalCost = sum(rows, (row) => row.costUSD)
const totalUseful = sum(rows, (row) => Number(row.metrics.usefulSources ?? 0))
const summary = {
  runId,
  experiment,
  providerSet: {
    name: 'Low-Cost First Pass',
    providers,
  },
  caseCount: cases.length,
  callCount: rows.length,
  costUSD: totalCost,
  mainMetrics: {
    sources: sum(rows, (row) => row.sources),
    usefulSources: totalUseful,
    costPerUsefulSource: totalUseful > 0 ? totalCost / totalUseful : null,
    officialDomainHits: sum(rows, (row) => Number(row.metrics.officialDomainHits ?? 0)),
    officialDomainApplicableRows: rows.filter((row) => row.metrics.officialDomainApplicable).length,
    polymarketHits: sum(rows, (row) => Number(row.metrics.polymarketHits ?? 0)),
    failures: rows.filter((row) => row.errors?.length).length,
  },
  byProvider,
  byCategory,
  examplesThatChangedInterpretation: Object.entries(byCategory)
    .slice(0, 3)
    .map(([category, value]) => {
      const data = value as { bestProvider: string | null; worstProvider: string | null; providers: { provider: string; usefulSources: number; sources: number }[] }
      return {
        category,
        caseId: rows.find((row) => row.category === category)?.caseId,
        bestProvider: data.bestProvider,
        worstProvider: data.worstProvider,
        providerSpread: data.providers,
      }
    }),
  categoryLabelsReliable: 'partial: five labels were distinct and manually spot-checked, but Gamma supplied no resolutionSource and no real weather/climate question appeared in the sampled pages.',
  projectChangesJustified: 'needs_more_data',
}

writeFileSync(join(runDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
writeFileSync(
  join(runDir, 'notes.md'),
  `# Notes

- Run ID: ${runId}
- Provider set: Low-Cost First Pass (${providers.join(', ')})
- Ledger: ${join(runDir, 'ledger.db')}
- Provider command template: \`WIDEBAND_DB="${join(runDir, 'ledger.db')}" bun src/cli/main.ts research "<market question> latest official source" --providers <provider> --max 10 --fresh --json --full\`
- Doctor was not run.
- Gamma supplied no \`resolutionSource\` for the five selected open markets, so exact resolution-source recall and expected-domain hit rate are not applicable for this pilot.
- Category labels are usable for a pilot across politics, crypto, sports, macro, and culture. No actual weather/climate question matched in the first 300 active events; the earlier broad \`climate\` tag match was excluded before provider calls.
- Manual labels are heuristic audits from URL/title/snippet using the shared usefulness rubric. A/B count as useful; C/D/F do not count as useful for the official-source query intent.
- \`git rev-parse --short HEAD\` failed with: fatal: Needed a single revision.

## Provider Failures

${rows.filter((row) => row.errors?.length).length ? rows.filter((row) => row.errors?.length).map((row) => `- ${row.caseId} / ${row.provider}: ${row.errors?.map((error) => `${error.code} ${error.message}`).join('; ')}`).join('\n') : '- None.'}
`,
)

console.log(JSON.stringify({ runId, rows: rows.length, costUSD: totalCost, failures: rows.filter((row) => row.errors?.length).length }, null, 2))
