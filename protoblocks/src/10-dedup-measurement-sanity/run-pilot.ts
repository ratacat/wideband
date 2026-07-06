#!/usr/bin/env bun
// @ts-nocheck
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalizeUrl, mergeHits } from '../../../src/core/merge'
import type { Hit, Source } from '../../../src/core/types'

const experiment = '10-dedup-measurement-sanity'
const providerSet = ['brave', 'jina', 'desearch', 'sailor', 'searchx']
const maxResults = 10
const timeoutMs = 30_000

type TestCase = {
  id: string
  q: string
  tags: string[]
  category: 'synthetic' | 'live'
  expectedUrls?: string[]
  notes?: string
}

type Fixture = TestCase & {
  category: 'synthetic'
  hits: Hit[]
  expectedSources: number
  expectedCanonicalUrls: string[]
}

type ProviderInfo = {
  name?: string
  keyPresent?: boolean
  capabilities?: Record<string, unknown>
  costModel?: { kind?: string; perRequestUSD?: number; monthlyQuota?: number }
}

type ProviderStats = {
  status?: string
  hits?: number
  uniqueContributed?: number
  latencyMs?: number
  error?: { code?: string; message?: string }
}

type SourceLike = {
  id?: string
  url?: string
  title?: string
  snippet?: string
  providers?: string[]
  provenance?: { provider?: string; rank?: number }[]
  raw?: Record<string, unknown[]>
}

type SweepLike = {
  sweepId?: string
  query?: { q?: string }
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
  json?: unknown
  parseError?: string
}

type DuplicateReason = 'amp' | 'mobile' | 'tracking' | 'syndication' | 'http_https' | 'slash' | 'other'

type DuplicateCandidate = {
  caseId: string
  query: string
  sourceA: string
  sourceB: string
  reason: DuplicateReason
  currentlyMerged: boolean
  sourceAId?: string
  sourceBId?: string
  providersA: string[]
  providersB: string[]
  canonicalA: string
  canonicalB: string
  heuristicCanonicalA: string
  heuristicCanonicalB: string
  titleA?: string
  titleB?: string
}

type Row = Record<string, unknown>

const fixtures: Fixture[] = [
  {
    id: 'fixture-http-https',
    q: 'synthetic http versus https URL variants',
    tags: ['synthetic', 'dedup', 'http_https'],
    category: 'synthetic',
    expectedSources: 1,
    expectedCanonicalUrls: ['https://example.com/story'],
    notes: 'HTTP and HTTPS variants of the same URL should collapse.',
    hits: [
      { provider: 'a', rank: 2, url: 'http://example.com/story', title: 'Story', mediaType: 'web' },
      { provider: 'b', rank: 1, url: 'https://example.com/story', title: 'Story', mediaType: 'web' },
    ],
  },
  {
    id: 'fixture-www-bare-host',
    q: 'synthetic www versus bare host URL variants',
    tags: ['synthetic', 'dedup', 'www'],
    category: 'synthetic',
    expectedSources: 1,
    expectedCanonicalUrls: ['https://example.com/story'],
    notes: 'www host variants should collapse to the bare host.',
    hits: [
      { provider: 'a', rank: 1, url: 'https://www.example.com/story', title: 'Story', mediaType: 'web' },
      { provider: 'b', rank: 1, url: 'https://example.com/story', title: 'Story', mediaType: 'web' },
    ],
  },
  {
    id: 'fixture-tracking-params',
    q: 'synthetic tracking parameter URL variants',
    tags: ['synthetic', 'dedup', 'tracking'],
    category: 'synthetic',
    expectedSources: 1,
    expectedCanonicalUrls: ['https://example.com/story'],
    notes: 'Known tracking params should be stripped before deduplication.',
    hits: [
      { provider: 'a', rank: 1, url: 'https://example.com/story?utm_source=x&utm_medium=y', title: 'Story', mediaType: 'web' },
      { provider: 'b', rank: 1, url: 'https://example.com/story?fbclid=abc&ref=home', title: 'Story', mediaType: 'web' },
    ],
  },
  {
    id: 'fixture-fragments',
    q: 'synthetic fragment URL variants',
    tags: ['synthetic', 'dedup', 'fragment'],
    category: 'synthetic',
    expectedSources: 1,
    expectedCanonicalUrls: ['https://example.com/story'],
    notes: 'Fragments should not split otherwise identical URLs.',
    hits: [
      { provider: 'a', rank: 1, url: 'https://example.com/story#top', title: 'Story', mediaType: 'web' },
      { provider: 'b', rank: 1, url: 'https://example.com/story#comments', title: 'Story', mediaType: 'web' },
    ],
  },
  {
    id: 'fixture-trailing-slash',
    q: 'synthetic trailing slash URL variants',
    tags: ['synthetic', 'dedup', 'slash'],
    category: 'synthetic',
    expectedSources: 1,
    expectedCanonicalUrls: ['https://example.com/story'],
    notes: 'A trailing slash on a non-root path should not split URLs.',
    hits: [
      { provider: 'a', rank: 1, url: 'https://example.com/story/', title: 'Story', mediaType: 'web' },
      { provider: 'b', rank: 1, url: 'https://example.com/story', title: 'Story', mediaType: 'web' },
    ],
  },
  {
    id: 'fixture-sorted-query-params',
    q: 'synthetic sorted query parameter URL variants',
    tags: ['synthetic', 'dedup', 'query_order'],
    category: 'synthetic',
    expectedSources: 1,
    expectedCanonicalUrls: ['https://example.com/search?a=1&b=2'],
    notes: 'Equivalent query params in different orders should share one canonical URL.',
    hits: [
      { provider: 'a', rank: 1, url: 'https://example.com/search?b=2&a=1', title: 'Search', mediaType: 'web' },
      { provider: 'b', rank: 1, url: 'https://example.com/search?a=1&b=2', title: 'Search', mediaType: 'web' },
    ],
  },
  {
    id: 'fixture-provider-internal-duplicate',
    q: 'synthetic provider duplicate within one result set',
    tags: ['synthetic', 'dedup', 'provider_internal_duplicate'],
    category: 'synthetic',
    expectedSources: 1,
    expectedCanonicalUrls: ['https://example.com/story'],
    notes: 'Duplicate hits from the same provider should merge and keep the best rank.',
    hits: [
      { provider: 'a', rank: 4, url: 'https://example.com/story?utm_campaign=x', title: 'Short', mediaType: 'web' },
      { provider: 'a', rank: 1, url: 'https://example.com/story', title: 'Longer Story Title', mediaType: 'web' },
    ],
  },
  {
    id: 'fixture-combined-common-variants',
    q: 'synthetic combined common URL variants from protoblock example',
    tags: ['synthetic', 'dedup', 'combined'],
    category: 'synthetic',
    expectedSources: 1,
    expectedCanonicalUrls: ['https://example.com/story'],
    notes: 'The protoblock example should collapse to one source.',
    hits: [
      { provider: 'a', rank: 1, url: 'http://www.example.com/story/?utm_source=x#top', title: 'Story', mediaType: 'web' },
      { provider: 'b', rank: 1, url: 'https://example.com/story', title: 'Story', mediaType: 'web' },
      { provider: 'c', rank: 1, url: 'https://example.com/story/?ref=home', title: 'Story', mediaType: 'web' },
    ],
  },
]

const liveCases: TestCase[] = [
  {
    id: 'live-fomc-june-2026',
    q: 'Federal Reserve FOMC statement official June 2026',
    tags: ['live', 'official-source', 'dedup'],
    category: 'live',
    expectedUrls: ['https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm'],
    notes: 'Official macro query likely to return repeated Federal Reserve URLs.',
  },
  {
    id: 'live-bitcoin-etf-sec-filing',
    q: 'latest bitcoin ETF SEC filing official',
    tags: ['live', 'official-source', 'dedup'],
    category: 'live',
    expectedUrls: ['https://www.sec.gov/'],
    notes: 'SEC filing query likely to expose duplicated filing and news URLs.',
  },
  {
    id: 'live-nba-finals-box-score',
    q: 'NBA finals box score official',
    tags: ['live', 'sports', 'dedup'],
    category: 'live',
    expectedUrls: ['https://www.nba.com/'],
    notes: 'Sports query likely to return official box score variants.',
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

function sorted(values: string[]) {
  return [...values].sort((a, b) => a.localeCompare(b))
}

function sameStrings(a: string[], b: string[]) {
  const aa = sorted(a)
  const bb = sorted(b)
  return aa.length === bb.length && aa.every((value, index) => value === bb[index])
}

function hostOf(raw: string | undefined) {
  if (!raw) return ''
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}

function normalizeTitle(title: string | undefined) {
  return (title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

const extraTrackingParams = new Set([
  'cid',
  'cmpid',
  'cmp',
  'utm',
  'ocid',
  'smid',
  'ito',
  's',
  'source',
  'rss',
  'guccounter',
  'ved',
  'ei',
  'usg',
])

function deleteTrackingParams(url: URL) {
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_\w+|fbclid|gclid|msclkid|igshid|mc_cid|mc_eid|ref|ref_src)$/i.test(key) || extraTrackingParams.has(key.toLowerCase())) {
      url.searchParams.delete(key)
    }
  }
}

function heuristicCanonicalize(raw: string) {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return raw.trim()
  }

  if (url.protocol === 'http:') url.protocol = 'https:'
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, '')
  url.hostname = url.hostname.replace(/^m\./, '').replace(/^mobile\./, '').replace(/^amp\./, '')
  url.hash = ''
  deleteTrackingParams(url)
  url.searchParams.sort()

  let path = url.pathname
  path = path.replace(/\/amp\/?$/i, '')
  path = path.replace(/\.amp(\/)?$/i, '$1')
  path = path.replace(/^\/amp\/s\//i, '/')
  path = path.replace(/^\/amp\//i, '/')
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1)
  url.pathname = path || '/'

  if (url.port === '80' || url.port === '443') url.port = ''
  return url.toString()
}

function parsed(raw: string) {
  try {
    return new URL(raw)
  } catch {
    return undefined
  }
}

function isAmp(raw: string) {
  const url = parsed(raw)
  if (!url) return false
  const host = url.hostname.toLowerCase()
  const path = url.pathname.toLowerCase()
  return host.startsWith('amp.') || host.includes('ampproject.org') || path.includes('/amp/') || path.endsWith('/amp') || path.endsWith('.amp')
}

function isMobile(raw: string) {
  const url = parsed(raw)
  if (!url) return false
  const host = url.hostname.toLowerCase()
  return host.startsWith('m.') || host.startsWith('mobile.')
}

function hasTracking(raw: string) {
  const url = parsed(raw)
  if (!url) return false
  return [...url.searchParams.keys()].some(
    (key) => /^(utm_\w+|fbclid|gclid|msclkid|igshid|mc_cid|mc_eid|ref|ref_src)$/i.test(key) || extraTrackingParams.has(key.toLowerCase()),
  )
}

function sameExceptSlash(a: string, b: string) {
  return canonicalizeUrl(a).replace(/\/(\?|$)/, '$1') === canonicalizeUrl(b).replace(/\/(\?|$)/, '$1')
}

function variantReason(a: string, b: string, titleA?: string, titleB?: string): DuplicateReason | null {
  const currentA = canonicalizeUrl(a)
  const currentB = canonicalizeUrl(b)
  const heuristicA = heuristicCanonicalize(a)
  const heuristicB = heuristicCanonicalize(b)

  if (currentA === currentB || heuristicA === heuristicB) {
    const parsedA = parsed(a)
    const parsedB = parsed(b)
    if (parsedA && parsedB && parsedA.protocol !== parsedB.protocol) return 'http_https'
    if (isAmp(a) || isAmp(b)) return 'amp'
    if (isMobile(a) || isMobile(b)) return 'mobile'
    if (hasTracking(a) || hasTracking(b)) return 'tracking'
    if (sameExceptSlash(a, b) && a !== b) return 'slash'
    return 'other'
  }

  const hostA = hostOf(a)
  const hostB = hostOf(b)
  const normalizedTitleA = normalizeTitle(titleA)
  const normalizedTitleB = normalizeTitle(titleB)
  if (hostA && hostB && hostA !== hostB && normalizedTitleA.length > 24 && normalizedTitleA === normalizedTitleB) {
    return 'syndication'
  }

  return null
}

function rawUrl(raw: unknown) {
  if (!raw || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  for (const key of ['url', 'link', 'image_url', 'thumbnail_url']) {
    if (typeof record[key] === 'string' && record[key]) return record[key] as string
  }
  return undefined
}

function rawTitle(raw: unknown) {
  if (!raw || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  for (const key of ['title', 'name', 'alt']) {
    if (typeof record[key] === 'string' && record[key]) return record[key] as string
  }
  return undefined
}

function rawEntries(source: SourceLike) {
  const entries: { provider: string; url: string; title?: string }[] = []
  for (const [provider, raws] of Object.entries(source.raw ?? {})) {
    for (const raw of raws ?? []) {
      const url = rawUrl(raw) ?? source.url
      if (url) entries.push({ provider, url, title: rawTitle(raw) ?? source.title })
    }
  }
  if (entries.length === 0 && source.url) {
    for (const provider of source.providers ?? ['unknown']) entries.push({ provider, url: source.url, title: source.title })
  }
  return entries
}

function candidateKey(candidate: DuplicateCandidate) {
  const pair = [candidate.sourceA, candidate.sourceB].sort().join(' <> ')
  return `${candidate.caseId}:${candidate.currentlyMerged}:${candidate.reason}:${pair}`
}

function findDuplicateCandidates(testCase: TestCase, result: SweepLike | undefined): DuplicateCandidate[] {
  const sources = result?.sources ?? []
  const out: DuplicateCandidate[] = []
  const seen = new Set<string>()

  for (const source of sources) {
    const entries = rawEntries(source)
    for (let i = 0; i < entries.length; i += 1) {
      for (let j = i + 1; j < entries.length; j += 1) {
        const a = entries[i]!
        const b = entries[j]!
        if (a.url === b.url) continue
        const reason = variantReason(a.url, b.url, a.title, b.title)
        if (!reason) continue
        const candidate: DuplicateCandidate = {
          caseId: testCase.id,
          query: testCase.q,
          sourceA: a.url,
          sourceB: b.url,
          reason,
          currentlyMerged: true,
          ...(source.id ? { sourceAId: source.id, sourceBId: source.id } : {}),
          providersA: [a.provider],
          providersB: [b.provider],
          canonicalA: canonicalizeUrl(a.url),
          canonicalB: canonicalizeUrl(b.url),
          heuristicCanonicalA: heuristicCanonicalize(a.url),
          heuristicCanonicalB: heuristicCanonicalize(b.url),
          ...(a.title ? { titleA: a.title } : {}),
          ...(b.title ? { titleB: b.title } : {}),
        }
        const key = candidateKey(candidate)
        if (!seen.has(key)) {
          seen.add(key)
          out.push(candidate)
        }
      }
    }
  }

  for (let i = 0; i < sources.length; i += 1) {
    for (let j = i + 1; j < sources.length; j += 1) {
      const a = sources[i]!
      const b = sources[j]!
      if (!a.url || !b.url) continue
      const reason = variantReason(a.url, b.url, a.title, b.title)
      if (!reason) continue
      if (reason !== 'syndication' && heuristicCanonicalize(a.url) !== heuristicCanonicalize(b.url)) continue
      const candidate: DuplicateCandidate = {
        caseId: testCase.id,
        query: testCase.q,
        sourceA: a.url,
        sourceB: b.url,
        reason,
        currentlyMerged: false,
        ...(a.id ? { sourceAId: a.id } : {}),
        ...(b.id ? { sourceBId: b.id } : {}),
        providersA: a.providers ?? [],
        providersB: b.providers ?? [],
        canonicalA: canonicalizeUrl(a.url),
        canonicalB: canonicalizeUrl(b.url),
        heuristicCanonicalA: heuristicCanonicalize(a.url),
        heuristicCanonicalB: heuristicCanonicalize(b.url),
        ...(a.title ? { titleA: a.title } : {}),
        ...(b.title ? { titleB: b.title } : {}),
      }
      const key = candidateKey(candidate)
      if (!seen.has(key)) {
        seen.add(key)
        out.push(candidate)
      }
    }
  }

  return out
}

function sourceUrls(sources: SourceLike[]) {
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
    if (stats.error) {
      errors.push({
        code: stats.error.code ?? 'provider_error',
        message: stats.error.message ?? 'Provider failed',
        stage,
        provider,
      })
    }
  }
  return errors
}

function validateRow(row: Row) {
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
  if (!['fixture', 'research'].includes(String(row.mode))) throw new Error('row.mode must be fixture or research')
  if (!Number.isInteger(row.sources) || (row.sources as number) < 0) throw new Error('row.sources must be a non-negative integer')
  if (typeof row.costUSD !== 'number' || row.costUSD < 0) throw new Error('row.costUSD must be a non-negative number')
  if (!Number.isInteger(row.latencyMs) || (row.latencyMs as number) < 0) throw new Error('row.latencyMs must be a non-negative integer')
  if (!row.stats || typeof row.stats !== 'object') throw new Error('row.stats must be an object')
  if (!row.metrics || typeof row.metrics !== 'object') throw new Error('row.metrics must be an object')
}

function fixtureStats(source: Source) {
  return {
    id: source.id,
    url: source.url,
    providers: source.providers,
    provenance: source.provenance,
    uniqueTo: source.uniqueTo,
  }
}

function evaluateFixture(fixture: Fixture, runId: string): Row {
  const started = performance.now()
  const sources = mergeHits(fixture.hits)
  const latencyMs = Math.max(0, Math.round(performance.now() - started))
  const canonicalUrls = sources.map((source) => source.url)
  const pass = sources.length === fixture.expectedSources && sameStrings(canonicalUrls, fixture.expectedCanonicalUrls)
  const providerInternalRank = fixture.id === 'fixture-provider-internal-duplicate' ? sources[0]?.provenance[0]?.rank : undefined
  const providerInternalPass = providerInternalRank === undefined || providerInternalRank === 1
  const fixturePassed = pass && providerInternalPass

  return {
    runId,
    timestamp: new Date().toISOString(),
    experiment,
    caseId: fixture.id,
    provider: 'synthetic',
    query: fixture.q,
    mode: 'fixture',
    sources: sources.length,
    sourceUrls: canonicalUrls,
    costUSD: 0,
    latencyMs,
    stats: {
      inputHits: fixture.hits.length,
      mergedSources: sources.length,
      canonicalUrls,
      sources: sources.map(fixtureStats),
    },
    metrics: {
      rowKind: 'synthetic-fixture',
      fixturePassed,
      expectedSources: fixture.expectedSources,
      expectedCanonicalUrls: fixture.expectedCanonicalUrls,
      duplicateInflationBeforeMerge: Math.max(0, fixture.hits.length - fixture.expectedSources),
      duplicateInflationAfterMerge: Math.max(0, sources.length - fixture.expectedSources),
      providerInternalBestRank: providerInternalRank,
    },
    ...(fixturePassed
      ? {}
      : {
          errors: [
            {
              code: 'fixture_failed',
              message: `Expected ${fixture.expectedSources} source(s) at ${fixture.expectedCanonicalUrls.join(', ')}, got ${sources.length} at ${canonicalUrls.join(', ')}`,
              stage: 'synthetic',
            },
          ],
        }),
  }
}

function providerAssociation(candidates: DuplicateCandidate[]) {
  const counts: Record<string, number> = {}
  for (const candidate of candidates) {
    for (const provider of [...candidate.providersA, ...candidate.providersB]) counts[provider] = (counts[provider] ?? 0) + 1
  }
  return counts
}

function missedInflation(candidates: DuplicateCandidate[]) {
  const urlVariantMisses = candidates.filter((candidate) => !candidate.currentlyMerged && candidate.reason !== 'syndication')
  const seen = new Set<string>()
  let inflation = 0
  for (const candidate of urlVariantMisses) {
    const key = [candidate.heuristicCanonicalA, candidate.heuristicCanonicalB].sort()[0]!
    if (seen.has(key)) continue
    seen.add(key)
    inflation += 1
  }
  return inflation
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

  const run: CliRun = {
    label,
    command,
    exitCode: child.status ?? 1,
    elapsedMs,
    stdout,
    stderr,
  }

  const trimmed = stdout.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      run.json = JSON.parse(trimmed)
      if (trimmed.startsWith('{')) run.result = run.json as SweepLike
    } catch (error) {
      run.parseError = error instanceof Error ? error.message : 'Unable to parse JSON stdout'
    }
  }
  return run
}

const allCases: TestCase[] = [...fixtures.map(({ hits: _hits, expectedSources: _sources, expectedCanonicalUrls: expectedUrls, ...rest }) => ({ ...rest, expectedUrls })), ...liveCases]
writeFileSync(join(runDir, 'cases.jsonl'), allCases.map(jsonLine).join(''))
writeFileSync(
  join(runDir, 'sampling.md'),
  [
    `# Sampling - ${runId}`,
    '',
    `- Source: fixed pilot seed list embedded in \`protoblocks/src/${experiment}/run-pilot.ts\`.`,
    `- Sampled: ${new Date().toISOString()} UTC.`,
    '- Filters: synthetic fixtures required by the protoblock plus the three live queries listed in Part B.',
    `- Case cap: ${fixtures.length} synthetic fixtures plus ${liveCases.length} live queries.`,
    `- Live provider set: Low-Cost First Pass (${providerSet.join(',')}).`,
    '- Exclusions: no doctor run; no full sample beyond pilot.',
    '',
  ].join('\n'),
)

const rows: Row[] = []
for (const fixture of fixtures) {
  const row = evaluateFixture(fixture, runId)
  validateRow(row)
  rows.push(row)
}

const providersRun = runCli('providers', ['src/cli/main.ts', 'providers', '--json'], join(runDir, 'providers.json'))
writeFileSync(join(rawDir, 'providers.stderr.txt'), providersRun.stderr)
const liveProviderInventory = Array.isArray(providersRun.json) ? (providersRun.json as ProviderInfo[]) : []
const selectedProviderInventory = liveProviderInventory.filter((provider) => providerSet.includes(String(provider.name)))

const liveRuns: CliRun[] = []
const duplicateCandidates: DuplicateCandidate[] = []

for (const testCase of liveCases) {
  const run = runCli(testCase.id, [
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
    '--capture',
    '--full',
    '--json',
  ])
  liveRuns.push(run)
  writeFileSync(join(rawDir, `${testCase.id}.stdout.json`), run.stdout)
  writeFileSync(join(rawDir, `${testCase.id}.stderr.txt`), run.stderr)

  const candidates = findDuplicateCandidates(testCase, run.result)
  duplicateCandidates.push(...candidates)
  const sources = run.result?.sources ?? []
  const liveRow = {
    runId,
    timestamp: new Date().toISOString(),
    experiment,
    caseId: testCase.id,
    provider: '__all__',
    query: testCase.q,
    mode: 'research',
    sources: sources.length,
    sourceUrls: sourceUrls(sources),
    costUSD: roundUSD(run.result?.cost?.totalUSD ?? 0),
    latencyMs: Math.max(0, Math.round(run.result?.timing?.totalMs ?? run.elapsedMs)),
    stats: {
      exitCode: run.exitCode,
      sweepId: run.result?.sweepId,
      totalHits: run.result?.stats?.totalHits ?? 0,
      uniqueSources: run.result?.stats?.uniqueSources ?? sources.length,
      overlapPct: run.result?.stats?.overlapPct ?? 0,
      providers: providerStatuses(run.result),
    },
    metrics: {
      rowKind: 'live-query',
      candidateCount: candidates.length,
      currentlyMergedCandidates: candidates.filter((candidate) => candidate.currentlyMerged).length,
      currentlyMissedCandidates: candidates.filter((candidate) => !candidate.currentlyMerged).length,
      estimatedUniqueSourceInflation: missedInflation(candidates),
      providerVariantCounts: providerAssociation(candidates),
      failureStage: !run.result ? 'research' : undefined,
    },
    errors: rowErrors('research', run),
  }
  validateRow(liveRow)
  rows.push(liveRow)
}

for (const candidate of duplicateCandidates) {
  const row = {
    runId,
    timestamp: new Date().toISOString(),
    experiment,
    caseId: candidate.caseId,
    provider: '__all__',
    query: candidate.query,
    mode: 'research',
    sources: candidate.currentlyMerged ? 1 : 2,
    sourceUrls: [candidate.sourceA, candidate.sourceB],
    costUSD: 0,
    latencyMs: 0,
    stats: {
      duplicateCandidate: candidate,
    },
    metrics: {
      rowKind: 'live-duplicate-candidate',
      reason: candidate.reason,
      currentlyMerged: candidate.currentlyMerged,
      currentlyMissed: !candidate.currentlyMerged,
      estimatedUniqueSourceInflation: candidate.currentlyMerged || candidate.reason === 'syndication' ? 0 : 1,
    },
  }
  validateRow(row)
  rows.push(row)
}

writeFileSync(join(runDir, 'rows.jsonl'), rows.map(jsonLine).join(''))
writeFileSync(join(runDir, 'duplicate-candidates.jsonl'), duplicateCandidates.map(jsonLine).join(''))

const fixtureRows = rows.filter((row) => (row.metrics as { rowKind?: string }).rowKind === 'synthetic-fixture')
const liveQueryRows = rows.filter((row) => (row.metrics as { rowKind?: string }).rowKind === 'live-query')
const fixturePasses = fixtureRows.filter((row) => (row.metrics as { fixturePassed?: boolean }).fixturePassed).length
const fixtureFailures = fixtureRows.length - fixturePasses
const liveCostUSD = roundUSD(liveRuns.reduce((sum, run) => sum + (run.result?.cost?.totalUSD ?? 0), 0))
const plannedProviderCalls = liveCases.length * providerSet.length
const providerCallStats = liveRuns.flatMap((run) => Object.values(run.result?.stats?.providers ?? {}))
const completedProviderCalls = providerCallStats.filter((stats) => stats.status && !String(stats.status).startsWith('skipped:')).length
const failedProviderCalls = providerCallStats.filter((stats) => stats.status === 'error' || stats.status === 'timeout').length
const mergedCandidates = duplicateCandidates.filter((candidate) => candidate.currentlyMerged)
const missedCandidates = duplicateCandidates.filter((candidate) => !candidate.currentlyMerged)
const missedUrlVariantCandidates = missedCandidates.filter((candidate) => candidate.reason !== 'syndication')
const liveUniqueSources = liveRuns.reduce((sum, run) => sum + (run.result?.stats?.uniqueSources ?? run.result?.sources?.length ?? 0), 0)
const liveTotalHits = liveRuns.reduce((sum, run) => sum + (run.result?.stats?.totalHits ?? 0), 0)
const projectChangesJustified =
  fixtureFailures > 0 || missedUrlVariantCandidates.length > 0
    ? 'measurement_fix'
    : liveRuns.every((run) => !run.result) || failedProviderCalls === providerCallStats.length
      ? 'needs_more_data'
      : 'none'

const summary = {
  runId,
  experiment,
  pass: 'pilot',
  providerSet: {
    name: 'Low-Cost First Pass',
    providers: providerSet,
  },
  liveProvidersFromInventory: selectedProviderInventory.map((provider) => ({
    name: provider.name,
    keyPresent: provider.keyPresent,
    costModel: provider.costModel,
  })),
  caseCount: {
    synthetic: fixtures.length,
    live: liveCases.length,
    total: fixtures.length + liveCases.length,
  },
  callCount: {
    plannedProviderCalls,
    completedProviderCalls,
    failedProviderCalls,
    skippedProviderCalls: providerCallStats.length - completedProviderCalls,
  },
  costUSD: liveCostUSD,
  mainMetrics: {
    syntheticFixturePasses: fixturePasses,
    syntheticFixtureFailures: fixtureFailures,
    liveTotalHits,
    liveUniqueSources,
    liveOverlapPct: liveTotalHits === 0 ? 0 : roundMetric(1 - liveUniqueSources / liveTotalHits),
    liveSuspectedDuplicateCount: duplicateCandidates.length,
    duplicateCandidatesCurrentlyMerged: mergedCandidates.length,
    duplicateCandidatesCurrentlyMissed: missedCandidates.length,
    missedUrlVariantCandidates: missedUrlVariantCandidates.length,
    estimatedUniqueSourceInflation: missedInflation(duplicateCandidates),
    providerVariantCounts: providerAssociation(duplicateCandidates),
  },
  examplesChangedInterpretation: [
    ...fixtureRows
      .filter((row) => !(row.metrics as { fixturePassed?: boolean }).fixturePassed)
      .slice(0, 3)
      .map((row) => ({ caseId: row.caseId, finding: 'synthetic fixture failed', metrics: row.metrics })),
    ...duplicateCandidates.slice(0, Math.max(0, 3 - fixtureFailures)).map((candidate) => ({
      caseId: candidate.caseId,
      finding: candidate.currentlyMerged ? 'live URL variant already merged' : 'live URL variant missed',
      sourceA: candidate.sourceA,
      sourceB: candidate.sourceB,
      reason: candidate.reason,
      providersA: candidate.providersA,
      providersB: candidate.providersB,
    })),
  ].slice(0, 3),
  projectChangesJustified,
  commands,
  outputFiles: {
    providers: 'providers.json',
    cases: 'cases.jsonl',
    rows: 'rows.jsonl',
    summary: 'summary.json',
    notes: 'notes.md',
    duplicateCandidates: 'duplicate-candidates.jsonl',
    raw: 'raw/',
    ledger: 'ledger.db',
  },
}

writeFileSync(join(runDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)

const providerFailureLines = liveRuns.flatMap((run) =>
  Object.entries(run.result?.stats?.providers ?? {})
    .filter(([, stats]) => stats.status === 'error' || stats.status === 'timeout')
    .map(([provider, stats]) => `- ${run.label} / ${provider}: ${stats.status}${stats.error ? ` (${stats.error.code}: ${stats.error.message})` : ''}`),
)

const selectedInventoryLines = selectedProviderInventory.map(
  (provider) => `- ${provider.name}: keyPresent=${Boolean(provider.keyPresent)}, costModel=${JSON.stringify(provider.costModel ?? {})}`,
)

const notes = [
  `# Notes - ${runId}`,
  '',
  '## Scope',
  '',
  '- Pass: pilot only.',
  `- Synthetic fixtures: ${fixtures.length}.`,
  `- Live queries: ${liveCases.length}.`,
  `- Live providers: ${providerSet.join(',')}.`,
  '- Live provider calls used `--fresh --capture --full --json` with a run-local ledger.',
  '',
  '## Provider Inventory',
  '',
  ...(selectedInventoryLines.length ? selectedInventoryLines : ['- Provider inventory parse failed or selected providers were absent from providers.json.']),
  '',
  '## Synthetic Fixtures',
  '',
  `- Passed: ${fixturePasses}/${fixtures.length}.`,
  `- Failed: ${fixtureFailures}/${fixtures.length}.`,
  '',
  '## Live Duplicate Candidates',
  '',
  `- Suspected candidates: ${duplicateCandidates.length}.`,
  `- Currently merged: ${mergedCandidates.length}.`,
  `- Currently missed: ${missedCandidates.length}.`,
  `- Missed URL-variant candidates, excluding semantic syndication: ${missedUrlVariantCandidates.length}.`,
  `- Estimated unique-source inflation: ${missedInflation(duplicateCandidates)}.`,
  '',
  '## Suspected Measurement Bugs',
  '',
  projectChangesJustified === 'measurement_fix'
    ? `- Potential dedup measurement bug recorded: fixture failures=${fixtureFailures}, missed URL-variant candidates=${missedUrlVariantCandidates.length}. No core fix was made in this pilot.`
    : '- None found in the pilot fixture/live sample.',
  '',
  '## Provider Failures',
  '',
  ...(providerFailureLines.length ? providerFailureLines : ['- None recorded.']),
  '',
  '## Raw Outputs',
  '',
  '- Provider inventory: `providers.json`.',
  '- Live CLI captures: `raw/*.stdout.json` and `raw/*.stderr.txt`.',
  '- Duplicate candidates: `duplicate-candidates.jsonl`.',
  '',
]

writeFileSync(join(runDir, 'notes.md'), notes.join('\n'))

console.log(JSON.stringify(summary, null, 2))
