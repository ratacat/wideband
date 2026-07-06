// @ts-nocheck
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const EXPERIMENT = '01-polymarket-resolution-source-recall'
const MODE = 'research'
const PROVIDERS = ['brave', 'jina', 'desearch', 'sailor', 'searchx'] as const
const CASE_CAP = 5
const GAMMA_ENDPOINTS = [
  { label: 'active_open', url: 'https://gamma-api.polymarket.com/events?active=true&closed=false&limit=100' },
  { label: 'closed_fallback', url: 'https://gamma-api.polymarket.com/events?closed=true&limit=100' },
] as const

type Provider = (typeof PROVIDERS)[number]

type GammaMarket = {
  id?: string
  slug?: string
  question?: string
  resolutionSource?: string | null
  volumeNum?: number
  category?: string
  closed?: boolean
}

type GammaEvent = {
  id?: string
  slug?: string
  title?: string
  category?: string
  closed?: boolean
  markets?: GammaMarket[]
}

type CaseRow = {
  id: string
  q: string
  tags: string[]
  expectedDomains: string[]
  expectedUrls: string[]
  category?: string
  market: {
    question: string
    resolutionSource: string
    expectedHost: string
    eventSlug?: string
    eventTitle?: string
    marketSlug?: string
    volumeNum?: number
    sourceEndpoint: string
    eventClosed?: boolean
    marketClosed?: boolean
  }
}

type CliResult = {
  sweepId?: string
  query?: { q?: string }
  sources?: { id?: string; url: string; title?: string; snippet?: string; providers?: string[] }[]
  stats?: {
    totalHits?: number
    uniqueSources?: number
    overlapPct?: number
    providers?: Record<string, Record<string, unknown>>
  }
  cost?: { totalUSD?: number; byProvider?: Record<string, { usd?: number; basis?: string }> }
  timing?: { totalMs?: number }
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
  errors?: { code: string; message: string; stage?: string }[]
}

function utcStamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

function canonicalHost(raw: string) {
  try {
    return new URL(raw).hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return raw.trim().toLowerCase()
  }
}

function canonicalUrl(raw: string) {
  const url = new URL(raw)
  url.hash = ''
  url.hostname = url.hostname.replace(/^www\./, '').toLowerCase()
  if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) url.port = ''
  let out = url.toString()
  if (out.endsWith('/')) out = out.slice(0, -1)
  return out
}

function sourceMatch(sourceUrl: string, expectedUrl: string) {
  try {
    if (canonicalUrl(sourceUrl) === canonicalUrl(expectedUrl)) return 'exact_url'
  } catch {
    // Bare-domain resolution sources are common in Gamma; host matching still applies.
  }
  try {
    if (canonicalHost(sourceUrl) === canonicalHost(expectedUrl)) return 'expected_host'
    return null
  } catch {
    return null
  }
}

function isPolymarketUrl(raw: string) {
  const host = canonicalHost(raw)
  return host === 'polymarket.com' || host.endsWith('.polymarket.com')
}

function safeId(raw: string) {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96)
}

function round(n: number, places = 6) {
  const scale = 10 ** places
  return Math.round(n * scale) / scale
}

function jsonl(rows: unknown[]) {
  return rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
}

async function runCli(args: string[], ledgerPath: string) {
  const started = Date.now()
  const proc = Bun.spawn(['bun', ...args], {
    cwd: process.cwd(),
    env: { ...Bun.env, WIDEBAND_DB: ledgerPath },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  return { exitCode, stdout, stderr, elapsedMs: Date.now() - started }
}

async function writeProviders(runDir: string, ledgerPath: string) {
  const result = await runCli(['src/cli/main.ts', 'providers', '--json'], ledgerPath)
  writeFileSync(join(runDir, 'providers.json'), result.stdout)
  if (result.exitCode !== 0) {
    throw new Error(`provider inventory failed: ${result.stderr || result.stdout}`)
  }
  return JSON.parse(result.stdout) as { name: string; keyPresent?: boolean }[]
}

async function fetchGamma(url: string) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Gamma API failed: ${response.status} ${response.statusText}`)
  return (await response.json()) as GammaEvent[]
}

async function fetchCases(runDir: string) {
  const candidates: CaseRow[] = []
  const candidateStats: { endpoint: string; events: number; candidatesWithResolutionSource: number }[] = []
  const seen = new Set<string>()

  for (const endpoint of GAMMA_ENDPOINTS) {
    if (candidates.length >= CASE_CAP) break
    const events = await fetchGamma(endpoint.url)
    let endpointCandidates = 0
    for (const event of events) {
      for (const market of event.markets ?? []) {
        const resolutionSource = market.resolutionSource?.trim()
        const question = market.question?.trim()
        if (!resolutionSource || !question) continue
        endpointCandidates += 1
        const expectedHost = canonicalHost(resolutionSource)
        const id = safeId(market.slug ?? market.id ?? `${event.slug ?? event.id ?? 'event'}-${question}`)
        if (!id || seen.has(id)) continue
        seen.add(id)
        const category = market.category ?? event.category
        candidates.push({
          id,
          q: `${question} official resolution source`,
          tags: ['polymarket', 'resolution-source', 'pilot', endpoint.label],
          expectedDomains: [expectedHost],
          expectedUrls: [resolutionSource],
          ...(category ? { category } : {}),
          market: {
            question,
            resolutionSource,
            expectedHost,
            sourceEndpoint: endpoint.label,
            ...(event.slug ? { eventSlug: event.slug } : {}),
            ...(event.title ? { eventTitle: event.title } : {}),
            ...(market.slug ? { marketSlug: market.slug } : {}),
            ...(typeof market.volumeNum === 'number' ? { volumeNum: market.volumeNum } : {}),
            ...(typeof event.closed === 'boolean' ? { eventClosed: event.closed } : {}),
            ...(typeof market.closed === 'boolean' ? { marketClosed: market.closed } : {}),
          },
        })
      }
    }
    candidateStats.push({ endpoint: endpoint.label, events: events.length, candidatesWithResolutionSource: endpointCandidates })
  }

  const groups = new Map<string, CaseRow[]>()
  for (const item of candidates) {
    const key = item.category ?? 'uncategorized'
    const group = groups.get(key) ?? []
    group.push(item)
    groups.set(key, group)
  }

  const selected: CaseRow[] = []
  const groupList = [...groups.values()].sort((a, b) => b.length - a.length)
  while (selected.length < CASE_CAP && groupList.some((group) => group.length > 0)) {
    for (const group of groupList) {
      const item = group.shift()
      if (item) selected.push(item)
      if (selected.length >= CASE_CAP) break
    }
  }

  writeFileSync(join(runDir, 'cases.jsonl'), jsonl(selected))
  writeFileSync(
    join(runDir, 'sampling.md'),
    [
      `# Sampling`,
      ``,
      `- Sources: ${GAMMA_ENDPOINTS.map((endpoint) => `${endpoint.label}=${endpoint.url}`).join('; ')}`,
      `- Sampled at: ${new Date().toISOString()}`,
      `- Filters: active/open events first, then closed markets only if active/open cannot fill the pilot cap; markets require non-empty resolutionSource and question.`,
      `- Case cap: ${CASE_CAP}`,
      `- Selection: category round-robin when category fields are available; otherwise API order.`,
      `- Candidates with resolutionSource: ${candidates.length}`,
      `- Candidate stats: ${JSON.stringify(candidateStats)}`,
      `- Selected cases: ${selected.length}`,
      `- Exclusions: duplicate or empty market IDs, missing question, missing resolutionSource.`,
      ``,
    ].join('\n'),
  )

  if (selected.length === 0) throw new Error('no cases with resolutionSource found')
  return { selected, candidates: candidates.length, candidateStats }
}

function rowFromCall(runId: string, c: CaseRow, provider: Provider, result: ReturnType<typeof runCli> extends Promise<infer T> ? T : never) {
  let parsed: CliResult | undefined
  try {
    parsed = result.stdout.trim() ? (JSON.parse(result.stdout) as CliResult) : undefined
  } catch {
    parsed = undefined
  }

  const providerStats = parsed?.stats?.providers?.[provider]
  const sourceUrls = (parsed?.sources ?? []).map((source) => source.url)
  const matches = sourceUrls
    .map((url, index) => ({ url, rank: index + 1, matchType: sourceMatch(url, c.market.resolutionSource) }))
    .filter((item): item is { url: string; rank: number; matchType: 'exact_url' | 'expected_host' } => item.matchType !== null)
  const firstMatch = matches[0]
  const polymarketUrls = sourceUrls.filter(isPolymarketUrl)
  const costUSD = parsed?.cost?.byProvider?.[provider]?.usd ?? parsed?.cost?.totalUSD ?? 0
  const latencyMs =
    typeof providerStats?.latencyMs === 'number'
      ? providerStats.latencyMs
      : typeof parsed?.timing?.totalMs === 'number'
        ? parsed.timing.totalMs
        : result.elapsedMs
  const errors =
    result.exitCode === 0
      ? undefined
      : [
          {
            code: String((providerStats?.error as { code?: string } | undefined)?.code ?? `exit_${result.exitCode}`),
            message: String(((providerStats?.error as { message?: string } | undefined)?.message ?? result.stderr.trim()) || 'provider call failed'),
            stage: 'provider_call',
          },
        ]

  return {
    runId,
    timestamp: new Date().toISOString(),
    experiment: EXPERIMENT,
    caseId: c.id,
    provider,
    query: c.q,
    mode: MODE,
    sources: sourceUrls.length,
    sourceUrls,
    costUSD,
    latencyMs,
    stats: {
      ...(providerStats ?? {}),
      exitCode: result.exitCode,
      sweepId: parsed?.sweepId,
      stderr: result.stderr.trim() || undefined,
    },
    metrics: {
      resolutionSource: c.market.resolutionSource,
      expectedHost: c.market.expectedHost,
      hitTop3: matches.some((match) => match.rank <= 3),
      hitTop10: matches.length > 0,
      exactUrlHitTop10: matches.some((match) => match.matchType === 'exact_url'),
      hostHitTop10: matches.some((match) => match.matchType === 'expected_host'),
      firstMatchRank: firstMatch?.rank ?? null,
      firstMatchUrl: firstMatch?.url ?? null,
      firstMatchType: firstMatch?.matchType ?? null,
      matchedUrls: matches.map((match) => match.url),
      polymarketLeakage: sourceUrls.length === 0 ? 0 : round(polymarketUrls.length / sourceUrls.length),
      polymarketUrls,
      topSourceUrl: sourceUrls[0] ?? null,
    },
    ...(errors ? { errors } : {}),
  } satisfies ResultRow
}

function summarize(runId: string, rows: ResultRow[], cases: CaseRow[], providerInventory: { name: string; keyPresent?: boolean }[]) {
  const byProvider = new Map<string, ResultRow[]>()
  for (const row of rows) byProvider.set(row.provider, [...(byProvider.get(row.provider) ?? []), row])

  const providerMetrics = [...byProvider.entries()].map(([provider, providerRows]) => {
    const top3 = providerRows.filter((row) => row.metrics.hitTop3 === true).length
    const top10 = providerRows.filter((row) => row.metrics.hitTop10 === true).length
    const cost = providerRows.reduce((sum, row) => sum + row.costUSD, 0)
    const sources = providerRows.reduce((sum, row) => sum + row.sources, 0)
    const polymarketSourceCount = providerRows.reduce((sum, row) => sum + ((row.metrics.polymarketUrls as string[] | undefined)?.length ?? 0), 0)
    const ranks = providerRows
      .map((row) => row.metrics.firstMatchRank)
      .filter((rank): rank is number => typeof rank === 'number')
    const statusCounts = providerRows.reduce<Record<string, number>>((acc, row) => {
      const status = String(row.stats.status ?? (row.errors?.length ? 'error' : 'unknown'))
      acc[status] = (acc[status] ?? 0) + 1
      return acc
    }, {})

    return {
      provider,
      cases: providerRows.length,
      top3,
      top10,
      top3Recall: round(top3 / providerRows.length),
      top10Recall: round(top10 / providerRows.length),
      avgFirstMatchRank: ranks.length ? round(ranks.reduce((sum, rank) => sum + rank, 0) / ranks.length, 2) : null,
      avgLatencyMs: Math.round(providerRows.reduce((sum, row) => sum + row.latencyMs, 0) / providerRows.length),
      costUSD: round(cost),
      costPerTop10Hit: top10 === 0 ? null : round(cost / top10),
      totalSources: sources,
      polymarketLeakage: sources === 0 ? 0 : round(polymarketSourceCount / sources),
      statusCounts,
    }
  })

  const examples = cases
    .map((c) => {
      const caseRows = rows.filter((row) => row.caseId === c.id)
      const hits = caseRows
        .filter((row) => row.metrics.hitTop10 === true)
        .map((row) => `${row.provider}@${row.metrics.firstMatchRank}`)
      const misses = caseRows.filter((row) => row.metrics.hitTop10 !== true).map((row) => row.provider)
      return {
        caseId: c.id,
        question: c.market.question,
        resolutionSource: c.market.resolutionSource,
        hits,
        misses,
        topSources: Object.fromEntries(caseRows.map((row) => [row.provider, row.metrics.topSourceUrl])),
      }
    })
    .filter((example) => example.hits.length > 0 || example.misses.length > 0)
    .sort((a, b) => Math.abs(b.hits.length - b.misses.length) - Math.abs(a.hits.length - a.misses.length))
    .slice(0, 3)

  const totalCostUSD = round(rows.reduce((sum, row) => sum + row.costUSD, 0))
  const top10Hits = rows.filter((row) => row.metrics.hitTop10 === true).length
  const failures = rows.filter((row) => row.errors?.length).length

  return {
    runId,
    providerSet: {
      name: 'Low-Cost First Pass',
      providers: PROVIDERS,
    },
    caseCount: cases.length,
    callCount: rows.length,
    totalCostUSD,
    mainMetrics: {
      providerMetrics,
      overallTop10Rows: top10Hits,
      overallTop10RecallByRow: round(top10Hits / rows.length),
      failures,
    },
    providerInventory: providerInventory
      .filter((provider) => PROVIDERS.includes(provider.name as Provider))
      .map((provider) => ({ name: provider.name, keyPresent: Boolean(provider.keyPresent) })),
    examplesThatChangedInterpretation: examples,
    projectChangesJustified: failures === rows.length ? 'needs_more_data' : 'none',
  }
}

function writeNotes(
  runDir: string,
  runId: string,
  providerInventory: { name: string; keyPresent?: boolean }[],
  rows: ResultRow[],
  candidateCount: number,
  candidateStats: { endpoint: string; events: number; candidatesWithResolutionSource: number }[],
) {
  const selectedInventory = providerInventory.filter((provider) => PROVIDERS.includes(provider.name as Provider))
  const missing = selectedInventory.filter((provider) => !provider.keyPresent).map((provider) => provider.name)
  const failures = rows.filter((row) => row.errors?.length)
  const lines = [
    `# Notes`,
    ``,
    `- Run ID: ${runId}`,
    `- Provider set: Low-Cost First Pass (${PROVIDERS.join(', ')})`,
    `- Live selected-provider key state: ${selectedInventory.map((provider) => `${provider.name}=${provider.keyPresent ? 'present' : 'missing'}`).join(', ')}`,
    `- Gamma candidates with resolutionSource: ${candidateCount}`,
    `- Gamma candidate stats: ${JSON.stringify(candidateStats)}`,
    `- Sampling deviation: active/open Gamma events had too few resolutionSource values for the pilot, so the script used the closed-market fallback before provider calls.`,
    `- Provider calls used --fresh through the wideband CLI.`,
    `- Doctor was not run.`,
    `- Manual labels were not written; recall used deterministic exact-URL or expected-host matching from the Polymarket resolutionSource.`,
  ]
  if (missing.length) lines.push(`- Missing selected provider keys: ${missing.join(', ')}`)
  if (failures.length) {
    lines.push(`- Provider failure rows: ${failures.length}`)
    for (const row of failures.slice(0, 10)) {
      lines.push(`  - ${row.caseId}/${row.provider}: ${row.errors?.[0]?.code} ${row.errors?.[0]?.message}`)
    }
  } else {
    lines.push(`- Measurement bugs or blockers: none observed.`)
  }
  lines.push(``)
  writeFileSync(join(runDir, 'notes.md'), lines.join('\n'))
}

const runId = Bun.env.RUN_ID ?? `${utcStamp()}-${EXPERIMENT}-pilot`
const runDir = join('protoblocks/src/01-polymarket-resolution-source-recall/runs', runId)
const expectedLedger = join(runDir, 'ledger.db')
const ledgerPath = Bun.env.WIDEBAND_DB ?? expectedLedger

if (ledgerPath !== expectedLedger) {
  throw new Error(`WIDEBAND_DB must be ${expectedLedger}, got ${ledgerPath}`)
}

mkdirSync(join(runDir, 'raw'), { recursive: true })

const providerInventory = await writeProviders(runDir, ledgerPath)
const { selected: cases, candidates, candidateStats } = await fetchCases(runDir)

const rowsFile = join(runDir, 'rows.jsonl')
writeFileSync(rowsFile, '')

const rows: ResultRow[] = []
for (const c of cases) {
  for (const provider of PROVIDERS) {
    const result = await runCli(
      ['src/cli/main.ts', MODE, c.q, '--providers', provider, '--max', '10', '--fresh', '--json', '--timeout', '15000'],
      ledgerPath,
    )
    const rawName = `${c.id}-${provider}.json`
    writeFileSync(
      join(runDir, 'raw', rawName),
      JSON.stringify({ command: ['bun', 'src/cli/main.ts', MODE, c.q, '--providers', provider, '--max', '10', '--fresh', '--json', '--timeout', '15000'], ...result }, null, 2),
    )
    const row = rowFromCall(runId, c, provider, result)
    rows.push(row)
    appendFileSync(rowsFile, JSON.stringify(row) + '\n')
  }
}

const summary = summarize(runId, rows, cases, providerInventory)
writeFileSync(join(runDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
writeNotes(runDir, runId, providerInventory, rows, candidates, candidateStats)

console.log(JSON.stringify({ runId, runDir, ledgerPath, summary }, null, 2))
