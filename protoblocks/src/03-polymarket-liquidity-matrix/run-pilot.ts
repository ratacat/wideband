// @ts-nocheck
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

type GammaMarket = {
  id?: string
  question?: string
  slug?: string
  active?: boolean
  closed?: boolean
  resolutionSource?: string
  volume?: string | number
  volumeNum?: number
  liquidity?: string | number
  liquidityNum?: number
}

type GammaEvent = {
  id?: string
  slug?: string
  title?: string
  active?: boolean
  closed?: boolean
  volume24hr?: number | string
  liquidity?: number | string
  resolutionSource?: string
  markets?: GammaMarket[]
}

type CaseRow = {
  id: string
  q: string
  tags: string[]
  expectedUrls?: string[]
  category: 'hot' | 'middle' | 'long_tail'
  market: Record<string, unknown>
  notes: string
}

type Source = {
  id?: string
  url: string
  title?: string
  snippet?: string
  providers?: string[]
}

type SweepResult = {
  sweepId: string
  query: { q: string }
  sources: Source[]
  stats: {
    totalHits: number
    uniqueSources: number
    overlapPct: number
    providers: Record<
      string,
      {
        status: string
        hits: number
        uniqueContributed: number
        latencyMs: number
        error?: { code: string; message: string }
      }
    >
  }
  cost: { totalUSD: number; byProvider: Record<string, { usd: number; basis: string }> }
  timing: { totalMs: number }
}

const slug = '03-polymarket-liquidity-matrix'
const experiment = slug
const providers = ['brave', 'jina', 'desearch', 'sailor', 'searchx']
const providerArg = providers.join(',')
const repoRoot = process.cwd()
const runId = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}-${slug}-pilot`
const runDir = join(repoRoot, 'protoblocks', 'src', slug, 'runs', runId)
const ledgerPath = join(runDir, 'ledger.db')
const env = { ...process.env, WIDEBAND_DB: ledgerPath }
const sampledAt = new Date().toISOString()

const endpoints = [
  'https://gamma-api.polymarket.com/events?active=true&closed=false&order=volume24hr&ascending=false&limit=500',
  'https://gamma-api.polymarket.com/events?active=true&closed=false&order=volume24hr&ascending=true&limit=500',
  'https://gamma-api.polymarket.com/events?active=true&closed=false&order=liquidity&ascending=false&limit=200',
]

function asNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(n) ? n : 0
}

function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim())
    if (u.protocol === 'http:') u.protocol = 'https:'
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '')
    u.hash = ''
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1)
    u.searchParams.sort()
    return u.toString()
  } catch {
    return raw.trim()
  }
}

function hostOf(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}

function safeId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72)
}

function chooseMarket(event: GammaEvent): GammaMarket | undefined {
  const openMarkets = (event.markets ?? [])
    .filter((market) => market.question?.trim() && market.active !== false && market.closed !== true)
    .sort((a, b) => asNumber(b.volumeNum ?? b.volume) - asNumber(a.volumeNum ?? a.volume))
  return openMarkets[0]
}

function candidateFromEvent(event: GammaEvent, bucket: CaseRow['category']): CaseRow | null {
  if (event.active === false || event.closed === true) return null
  const market = chooseMarket(event)
  const question = market?.question?.trim() || event.title?.trim()
  if (!question) return null

  const resolutionSource = market?.resolutionSource?.trim() || event.resolutionSource?.trim() || ''
  const expectedUrls = resolutionSource && /^https?:\/\//i.test(resolutionSource) ? [normalizeUrl(resolutionSource)] : undefined
  const eventSlug = event.slug || safeId(event.title ?? question)
  const marketSlug = market?.slug || eventSlug
  const id = `${bucket}-${safeId(marketSlug || eventSlug || question)}`
  const volume24h = asNumber(event.volume24hr)
  const liquidity = asNumber(event.liquidity ?? market?.liquidityNum ?? market?.liquidity)

  return {
    id,
    q: question,
    tags: ['polymarket', bucket, 'volume24hr'],
    ...(expectedUrls ? { expectedUrls } : {}),
    category: bucket,
    market: {
      bucket,
      eventId: event.id,
      eventSlug,
      marketId: market?.id,
      marketSlug,
      eventTitle: event.title,
      volume24h,
      liquidity,
      resolutionSource,
    },
    notes: `Selected from active Gamma event snapshot by ${bucket} volume24hr bucket.`,
  }
}

function uniqueEvents(events: GammaEvent[]): GammaEvent[] {
  const seen = new Set<string>()
  const out: GammaEvent[] = []
  for (const event of events) {
    const key = event.id || event.slug || event.title
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(event)
  }
  return out
}

function takeDistinct(
  events: GammaEvent[],
  bucket: CaseRow['category'],
  count: number,
  usedIds: Set<string>,
): CaseRow[] {
  const rows: CaseRow[] = []
  for (const event of events) {
    const row = candidateFromEvent(event, bucket)
    if (!row || usedIds.has(row.id) || usedIds.has(row.q)) continue
    usedIds.add(row.id)
    usedIds.add(row.q)
    rows.push(row)
    if (rows.length === count) break
  }
  return rows
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`Fetch failed ${response.status} ${response.statusText}: ${url}`)
  return (await response.json()) as T
}

async function runCli(args: string[]) {
  const proc = Bun.spawn(['bun', 'src/cli/main.ts', ...args], {
    cwd: repoRoot,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}

function jsonl(rows: unknown[]): string {
  return `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`
}

function topDomains(urls: string[]): string[] {
  const counts = new Map<string, number>()
  for (const url of urls) {
    const host = hostOf(url)
    if (!host) continue
    counts.set(host, (counts.get(host) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([host]) => host)
}

const stopWords = new Set([
  'a',
  'an',
  'and',
  'any',
  'are',
  'be',
  'by',
  'for',
  'from',
  'in',
  'is',
  'of',
  'on',
  'or',
  'the',
  'to',
  'will',
  'with',
])

function relevant(source: Source, q: string): boolean {
  const text = `${source.url} ${source.title ?? ''} ${source.snippet ?? ''}`.toLowerCase()
  const tokens = q
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2 && !stopWords.has(token))
  const hits = tokens.filter((token) => text.includes(token)).length
  return hits >= Math.min(2, tokens.length)
}

function classifySource(source: Source, row: CaseRow) {
  const url = normalizeUrl(source.url)
  const host = hostOf(url)
  const q = row.q
  const expectedUrls = (row.expectedUrls ?? []).map(normalizeUrl)
  const expectedHosts = expectedUrls.map(hostOf).filter(Boolean)

  if (expectedUrls.includes(url) || expectedHosts.includes(host)) {
    return { label: 'A', useful: true, reason: 'official_source', notes: 'Matches case resolution source URL or host.' }
  }

  if (host === 'polymarket.com' || host.endsWith('.polymarket.com')) {
    return { label: 'D', useful: false, reason: 'polymarket_page', notes: 'Market page is not the requested official source.' }
  }

  const officialHosts = [
    'cftc.gov',
    'congress.gov',
    'ecfr.gov',
    'fec.gov',
    'federalreserve.gov',
    'fia.com',
    'fifa.com',
    'formula1.com',
    'gov.uk',
    'house.gov',
    'nba.com',
    'parliament.uk',
    'sec.gov',
    'senate.gov',
    'supremecourt.gov',
    'uefa.com',
    'whitehouse.gov',
  ]
  const officialTld = host.endsWith('.gov') || host.endsWith('.mil') || host.endsWith('.gov.uk')
  if ((officialTld || officialHosts.some((official) => host === official || host.endsWith(`.${official}`))) && relevant(source, q)) {
    return { label: 'A', useful: true, reason: 'official_source', notes: 'Official or primary domain and query-relevant title/snippet/URL.' }
  }

  const reputableHosts = [
    'abcnews.go.com',
    'aljazeera.com',
    'axios.com',
    'bbc.com',
    'bbc.co.uk',
    'bloomberg.com',
    'cbsnews.com',
    'cbssports.com',
    'cnbc.com',
    'cnn.com',
    'espn.com',
    'ft.com',
    'nbcnews.com',
    'nytimes.com',
    'politico.com',
    'reuters.com',
    'skysports.com',
    'theathletic.com',
    'theguardian.com',
    'wsj.com',
  ]
  if (reputableHosts.some((newsHost) => host === newsHost || host.endsWith(`.${newsHost}`)) && relevant(source, q)) {
    return { label: 'B', useful: true, reason: 'reputable_reporting', notes: 'Reputable reporting domain with query-relevant title/snippet/URL.' }
  }

  const weakHosts = [
    'kalshi.com',
    'manifold.markets',
    'reddit.com',
    'twitter.com',
    'wikipedia.org',
    'x.com',
    'youtube.com',
  ]
  if (weakHosts.some((weakHost) => host === weakHost || host.endsWith(`.${weakHost}`))) {
    return { label: 'D', useful: false, reason: 'thin_summary', notes: 'Discussion, market, encyclopedia, or social page.' }
  }

  return relevant(source, q)
    ? { label: 'C', useful: false, reason: 'context', notes: 'Relevant context, but not official or strong resolution evidence for this pilot.' }
    : { label: 'F', useful: false, reason: 'off_topic', notes: 'URL/title/snippet did not directly match the market question.' }
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[index] ?? null
}

function round(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000
}

function buildSummary(rows: any[], cases: CaseRow[], commands: string[], providerInventory: unknown) {
  const providerMetrics: Record<string, any> = {}
  const bucketMetrics: Record<string, any> = {}
  for (const provider of providers) {
    const subset = rows.filter((row) => row.provider === provider)
    const okRows = subset.filter((row) => row.stats.status === 'ok')
    const cost = subset.reduce((sum, row) => sum + row.costUSD, 0)
    const useful = subset.reduce((sum, row) => sum + row.metrics.usefulSources, 0)
    const sources = subset.reduce((sum, row) => sum + row.sources, 0)
    const longTail = subset.filter((row) => row.metrics.bucket === 'long_tail')
    providerMetrics[provider] = {
      rows: subset.length,
      okRows: okRows.length,
      errorRows: subset.length - okRows.length,
      sources,
      usefulSources: useful,
      usefulRate: sources === 0 ? 0 : round(useful / sources),
      uniqueContributed: subset.reduce((sum, row) => sum + row.metrics.uniqueContributed, 0),
      costUSD: round(cost),
      costPerUsefulSource: useful === 0 ? null : round(cost / useful),
      latencyMs: {
        p50: percentile(okRows.map((row) => row.latencyMs), 50),
        p95: percentile(okRows.map((row) => row.latencyMs), 95),
      },
      longTail: {
        sources: longTail.reduce((sum, row) => sum + row.sources, 0),
        usefulSources: longTail.reduce((sum, row) => sum + row.metrics.usefulSources, 0),
        uniqueContributed: longTail.reduce((sum, row) => sum + row.metrics.uniqueContributed, 0),
      },
    }
  }

  for (const bucket of ['hot', 'middle', 'long_tail']) {
    const subset = rows.filter((row) => row.metrics.bucket === bucket)
    const cost = subset.reduce((sum, row) => sum + row.costUSD, 0)
    const useful = subset.reduce((sum, row) => sum + row.metrics.usefulSources, 0)
    const sources = subset.reduce((sum, row) => sum + row.sources, 0)
    const polymarketPages = subset.reduce((sum, row) => sum + row.metrics.polymarketPageCount, 0)
    bucketMetrics[bucket] = {
      rows: subset.length,
      sources,
      usefulSources: useful,
      usefulRate: sources === 0 ? 0 : round(useful / sources),
      uniqueContributed: subset.reduce((sum, row) => sum + row.metrics.uniqueContributed, 0),
      emptyRows: subset.filter((row) => row.sources === 0).length,
      lowResultRows: subset.filter((row) => row.sources > 0 && row.sources <= 2).length,
      polymarketPageRate: sources === 0 ? 0 : round(polymarketPages / sources),
      costUSD: round(cost),
      costPerUsefulSource: useful === 0 ? null : round(cost / useful),
    }
  }

  const totalCost = rows.reduce((sum, row) => sum + row.costUSD, 0)
  const longTailProviders = Object.entries(providerMetrics)
    .map(([provider, metrics]) => ({ provider, ...metrics.longTail }))
    .sort((a, b) => b.usefulSources - a.usefulSources || b.uniqueContributed - a.uniqueContributed)

  return {
    runId,
    experiment,
    pass: 'pilot',
    providerSetName: 'Low-Cost First Pass',
    providers,
    providerInventory,
    caseCount: cases.length,
    callCount: cases.length * providers.length,
    sweepCount: cases.length,
    costUSD: round(totalCost),
    commands,
    sampledAt,
    mainMetrics: {
      providers: providerMetrics,
      buckets: bucketMetrics,
      longTailLeader: longTailProviders[0] ?? null,
    },
    examplesChangedInterpretation: [
      'The pilot uses grouped Gamma events but selects active non-closed submarkets when possible; event-level active status alone is insufficient.',
      'Long-tail rows are measured separately because low-volume cases can still return broad contextual or market-page results that inflate raw source counts.',
      'Useful-source labels are heuristic URL/title/snippet judgments for the pilot; they are enough to expose obvious provider/bucket differences but need stricter manual adjudication before changing defaults.',
    ],
    projectChangeJustified: 'needs_more_data',
  }
}

async function main() {
  await mkdir(runDir, { recursive: true })

  const providersResult = await runCli(['providers', '--json'])
  if (providersResult.exitCode !== 0) {
    throw new Error(`providers failed: ${providersResult.stderr || providersResult.stdout}`)
  }
  await writeFile(join(runDir, 'providers.json'), providersResult.stdout)
  const providerInventory = JSON.parse(providersResult.stdout)

  const snapshots = await Promise.all(endpoints.map((endpoint) => fetchJson<GammaEvent[]>(endpoint)))
  const events = uniqueEvents(snapshots.flat())
  const byVolumeDesc = [...events].sort((a, b) => asNumber(b.volume24hr) - asNumber(a.volume24hr))
  const byVolumeAsc = [...events].sort((a, b) => asNumber(a.volume24hr) - asNumber(b.volume24hr))
  const midIndex = Math.floor(byVolumeDesc.length / 2)
  const middleWindow = [
    ...byVolumeDesc.slice(Math.max(0, midIndex - 30), midIndex + 31),
    ...byVolumeDesc.slice(Math.max(0, midIndex - 75), midIndex + 76),
  ]

  const used = new Set<string>()
  const cases = [
    ...takeDistinct(byVolumeDesc, 'hot', 2, used),
    ...takeDistinct(middleWindow, 'middle', 2, used),
    ...takeDistinct(byVolumeAsc, 'long_tail', 2, used),
  ]

  if (cases.length === 0) throw new Error('No cases sampled')
  await writeFile(join(runDir, 'cases.jsonl'), jsonl(cases))
  await writeFile(
    join(runDir, 'sampling.md'),
    [
      `# Sampling`,
      ``,
      `- Sampled at: ${sampledAt}`,
      `- Case cap: 6`,
      `- Selected cases: ${cases.length}`,
      `- Bucket target: 2 hot, 2 middle, 2 long_tail`,
      `- Filters: active=true, closed=false Gamma events; active non-closed submarket question preferred; event title fallback only when no open submarket question exists.`,
      `- Bucket basis: local numeric sort by event volume24hr across combined snapshots.`,
      `- Endpoints:`,
      ...endpoints.map((endpoint) => `  - ${endpoint}`),
      ``,
      `## Selected Cases`,
      ``,
      ...cases.map(
        (row) =>
          `- ${row.id}: ${row.q} (${row.category}, volume24h=${row.market.volume24h}, liquidity=${row.market.liquidity})`,
      ),
      ``,
    ].join('\n'),
  )

  const rows: any[] = []
  const labels: any[] = []
  const commands: string[] = [
    `WIDEBAND_DB=${shellQuote(ledgerPath)} bun src/cli/main.ts providers --json > ${shellQuote(join(runDir, 'providers.json'))}`,
  ]

  for (const row of cases) {
    const query = `${row.q} official source`
    const args = ['research', query, '--providers', providerArg, '--max', '10', '--fresh', '--json']
    commands.push(`WIDEBAND_DB=${shellQuote(ledgerPath)} bun src/cli/main.ts research ${shellQuote(query)} --providers ${providerArg} --max 10 --fresh --json`)
    const started = Date.now()
    const result = await runCli(args)
    const finishedAt = new Date().toISOString()
    let parsed: SweepResult | null = null
    try {
      parsed = JSON.parse(result.stdout) as SweepResult
    } catch {
      parsed = null
    }

    if (!parsed) {
      for (const provider of providers) {
        rows.push({
          runId,
          timestamp: finishedAt,
          experiment,
          caseId: row.id,
          provider,
          query,
          mode: 'research',
          sources: 0,
          sourceUrls: [],
          costUSD: 0,
          latencyMs: Date.now() - started,
          stats: { status: 'error', hits: 0, uniqueContributed: 0, stderr: result.stderr, exitCode: result.exitCode },
          metrics: {
            bucket: row.category,
            volume24h: row.market.volume24h,
            liquidity: row.market.liquidity,
            totalSources: 0,
            rawHits: 0,
            uniqueContributed: 0,
            expectedSourceHit: false,
            topDomains: [],
            overlapPct: 0,
            providerOverlapPct: 0,
            polymarketPageCount: 0,
            polymarketPageRate: 0,
            usefulSources: 0,
            usefulRate: 0,
            labelCounts: {},
            failureStage: 'cli',
          },
          errors: [{ code: 'cli_json_parse', message: result.stderr || result.stdout || 'CLI did not return parseable JSON', stage: 'provider_call' }],
        })
      }
      continue
    }

    for (const provider of providers) {
      const stats = parsed.stats.providers[provider] ?? {
        status: 'error',
        hits: 0,
        uniqueContributed: 0,
        latencyMs: 0,
        error: { code: 'missing_stats', message: 'Provider missing from sweep stats' },
      }
      const providerSources = parsed.sources.filter((source) => source.providers?.includes(provider))
      const sourceUrls = providerSources.map((source) => source.url)
      const providerLabels = providerSources.map((source) => {
        const label = classifySource(source, row)
        return {
          sourceId: `${row.id}:${provider}:${source.id ?? normalizeUrl(source.url)}`,
          caseId: row.id,
          provider,
          url: source.url,
          title: source.title ?? '',
          label: label.label,
          useful: label.useful,
          reason: label.reason,
          notes: label.notes,
        }
      })
      labels.push(...providerLabels)
      const usefulSources = providerLabels.filter((label) => label.useful).length
      const labelCounts = providerLabels.reduce<Record<string, number>>((acc, label) => {
        acc[label.label] = (acc[label.label] ?? 0) + 1
        return acc
      }, {})
      const polymarketPageCount = sourceUrls.filter((url) => {
        const host = hostOf(url)
        return host === 'polymarket.com' || host.endsWith('.polymarket.com')
      }).length
      const expected = (row.expectedUrls ?? []).map(normalizeUrl)
      const expectedHosts = expected.map(hostOf).filter(Boolean)
      const expectedSourceHit = sourceUrls.some((url) => {
        const normalized = normalizeUrl(url)
        return expected.includes(normalized) || expectedHosts.includes(hostOf(normalized))
      })
      const providerOverlapPct = stats.hits === 0 ? 0 : round(1 - stats.uniqueContributed / stats.hits)
      const cost = parsed.cost.byProvider[provider] ?? { usd: 0, basis: 'metered' }

      rows.push({
        runId,
        timestamp: finishedAt,
        experiment,
        caseId: row.id,
        provider,
        query,
        mode: 'research',
        sources: providerSources.length,
        sourceUrls,
        costUSD: cost.usd,
        latencyMs: stats.latencyMs,
        stats: {
          status: stats.status,
          hits: stats.hits,
          uniqueContributed: stats.uniqueContributed,
          sweepId: parsed.sweepId,
          sweepExitCode: result.exitCode,
          totalHits: parsed.stats.totalHits,
          uniqueSources: parsed.stats.uniqueSources,
          overlapPct: parsed.stats.overlapPct,
          costBasis: cost.basis,
          ...(stats.error ? { error: stats.error } : {}),
        },
        metrics: {
          bucket: row.category,
          volume24h: row.market.volume24h,
          liquidity: row.market.liquidity,
          totalSources: providerSources.length,
          rawHits: stats.hits,
          uniqueContributed: stats.uniqueContributed,
          expectedSourceHit,
          topDomains: topDomains(sourceUrls),
          overlapPct: parsed.stats.overlapPct,
          providerOverlapPct,
          polymarketPageCount,
          polymarketPageRate: providerSources.length === 0 ? 0 : round(polymarketPageCount / providerSources.length),
          usefulSources,
          usefulRate: providerSources.length === 0 ? 0 : round(usefulSources / providerSources.length),
          labelCounts,
          ...(stats.status === 'ok' ? {} : { failureStage: 'provider_call' }),
        },
        ...(stats.error ? { errors: [{ ...stats.error, stage: 'provider_call' }] } : {}),
      })
    }
  }

  await writeFile(join(runDir, 'rows.jsonl'), jsonl(rows))
  await writeFile(join(runDir, 'manual-labels.jsonl'), jsonl(labels))

  const summary = buildSummary(rows, cases, commands, providerInventory)
  await writeFile(join(runDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  await writeFile(
    join(runDir, 'notes.md'),
    [
      `# Notes`,
      ``,
      `- Run ID: ${runId}`,
      `- Ledger: ${ledgerPath}`,
      `- Provider set: Low-Cost First Pass (${providerArg})`,
      `- Provider calls: ${cases.length} cases x ${providers.length} providers = ${cases.length * providers.length}`,
      `- CLI mode: research, --max 10, --fresh, --json`,
      `- Cost reported: $${summary.costUSD}`,
      `- Worktree note: uncommitted/no HEAD observed before run.`,
      ``,
      `## Measurement Notes`,
      ``,
      `- Gamma events can be grouped; this pilot selected active non-closed submarkets where possible instead of using closed child markets from active event groups.`,
      `- Usefulness labels in manual-labels.jsonl are pilot heuristics based on URL, title, and snippet. They follow the A/B useful rule from USEFUL_SOURCE_RUBRIC.md but should be manually tightened before a full run or default changes.`,
      `- Source counts are provider-visible deduped sources from the merged wideband response; raw provider hits are kept in metrics.rawHits.`,
      `- overlapPct is the sweep-level overlap for the case; providerOverlapPct is computed as 1 - uniqueContributed/rawHits.`,
      ``,
      `## Provider Failures`,
      ``,
      ...rows
        .filter((row) => row.stats.status !== 'ok')
        .map((row) => `- ${row.caseId}/${row.provider}: ${row.stats.status}${row.stats.error ? ` (${row.stats.error.code}: ${row.stats.error.message})` : ''}`),
      rows.some((row) => row.stats.status !== 'ok') ? `` : `- None.`,
      ``,
      `## Exact Commands`,
      ``,
      ...commands.map((command) => `- \`${command}\``),
      ``,
    ].join('\n'),
  )

  console.log(JSON.stringify({ runId, runDir, costUSD: summary.costUSD, cases: cases.length, rows: rows.length }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error)
  process.exit(1)
})
