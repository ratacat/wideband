import type { FreshnessConfidence, Hit, Source } from './types'

const TRACKING_PARAM = /^(utm_\w+|fbclid|gclid|msclkid|igshid|mc_cid|mc_eid|ref|ref_src)$/i
const RRF_K = 60

export function sha256(s: string): string {
  return new Bun.CryptoHasher('sha256').update(s).digest('hex')
}

export function canonicalizeUrl(raw: string): string {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return raw.trim()
  }
  if (u.protocol === 'http:') u.protocol = 'https:'
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '')
  if (u.port === '80' || u.port === '443') u.port = ''
  u.hash = ''
  for (const k of [...u.searchParams.keys()]) {
    if (TRACKING_PARAM.test(k)) u.searchParams.delete(k)
  }
  u.searchParams.sort()
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1)
  return u.toString()
}

export function sourceId(canonicalUrl: string): string {
  return sha256(canonicalUrl).slice(0, 16)
}

function earliestDate(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b
  if (!b) return a
  const ta = Date.parse(a)
  const tb = Date.parse(b)
  if (Number.isNaN(ta)) return b
  if (Number.isNaN(tb)) return a
  return ta <= tb ? a : b
}

const FRESHNESS_RANK: Record<FreshnessConfidence, number> = {
  native: 4,
  verified: 3,
  undated: 2,
  stale: 1,
}

function bestFreshness(a: FreshnessConfidence, b: FreshnessConfidence): FreshnessConfidence {
  return FRESHNESS_RANK[a] >= FRESHNESS_RANK[b] ? a : b
}

function addFreshness(source: Source, hit: Hit) {
  if (!hit.freshness) return
  source.freshness ??= { confidence: hit.freshness.confidence, providers: {} }
  source.freshness.providers[hit.provider] = hit.freshness.confidence
  source.freshness.confidence = bestFreshness(source.freshness.confidence, hit.freshness.confidence)
}

/** Merge per-provider Hits into deduplicated Sources, RRF-ranked. */
export function mergeHits(hits: Hit[]): Source[] {
  const byId = new Map<string, Source>()

  for (const hit of hits) {
    const url = canonicalizeUrl(hit.url)
    const id = sourceId(url)
    const existing = byId.get(id)

    if (!existing) {
      byId.set(id, {
        id,
        url,
        title: hit.title ?? url,
        snippet: hit.snippet ?? '',
        ...(hit.content !== undefined ? { content: hit.content } : {}),
        ...(hit.publishedAt !== undefined ? { publishedAt: hit.publishedAt } : {}),
        ...(hit.author !== undefined ? { author: hit.author } : {}),
        mediaType: hit.mediaType,
        providers: [hit.provider],
        provenance: [
          { provider: hit.provider, rank: hit.rank, ...(hit.score !== undefined ? { score: hit.score } : {}) },
        ],
        ...(hit.freshness ? { freshness: { confidence: hit.freshness.confidence, providers: { [hit.provider]: hit.freshness.confidence } } } : {}),
        score: 0,
        ...(hit.raw !== undefined ? { raw: { [hit.provider]: [hit.raw] } } : {}),
      })
      continue
    }

    if (hit.title && (existing.title === existing.url || hit.title.length > existing.title.length)) {
      existing.title = hit.title
    }
    if (hit.snippet && hit.snippet.length > existing.snippet.length) existing.snippet = hit.snippet
    if (hit.content && hit.content.length > (existing.content?.length ?? 0)) existing.content = hit.content
    const earliest = earliestDate(existing.publishedAt, hit.publishedAt)
    if (earliest !== undefined) existing.publishedAt = earliest
    if (!existing.author && hit.author) existing.author = hit.author
    addFreshness(existing, hit)

    const prior = existing.provenance.find((p) => p.provider === hit.provider)
    if (prior) {
      // a provider returned the same URL twice — keep its best rank
      if (hit.rank < prior.rank) prior.rank = hit.rank
    } else {
      existing.provenance.push({
        provider: hit.provider,
        rank: hit.rank,
        ...(hit.score !== undefined ? { score: hit.score } : {}),
      })
      existing.providers.push(hit.provider)
    }
    if (hit.raw !== undefined) {
      existing.raw ??= {}
      existing.raw[hit.provider] ??= []
      existing.raw[hit.provider]!.push(hit.raw)
    }
  }

  const sources = [...byId.values()]
  for (const s of sources) {
    s.score = s.provenance.reduce((sum, p) => sum + 1 / (RRF_K + p.rank), 0)
    if (s.providers.length === 1) s.uniqueTo = s.providers[0]
  }
  sources.sort((a, b) => b.score - a.score)
  return sources
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
    }
    return v
  })
}
