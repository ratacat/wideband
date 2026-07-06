import type { Hit, ProviderAdapter } from '../core/types'
import { requestJSON } from './http'

type NimbleResult = {
  title?: string
  description?: string
  snippet?: string
  url?: string
  position?: number
  date?: string
  source?: string
  metadata?: Record<string, unknown>
  extra_fields?: Record<string, unknown>
}

type NimbleResponse = {
  status?: string
  status_code?: number
  data?: {
    parsing?: {
      entities?: Record<string, unknown>
    }
  }
  parsing?: {
    entities?: Record<string, unknown>
  }
}

function stringField(obj: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj?.[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

function entityRows(json: NimbleResponse): NimbleResult[] {
  const entities = json.data?.parsing?.entities ?? json.parsing?.entities ?? {}
  const rows: unknown[] = [
    entities.OrganicResult,
    entities.NewsResult,
    entities.NewsArticle,
    entities.TopStories,
    entities.VideoResult,
  ].flatMap((value) => (Array.isArray(value) ? value : []))
  return rows.filter((row): row is NimbleResult => typeof row === 'object' && row !== null)
}

function freshnessTime(after: string | undefined): string | undefined {
  if (!after) return undefined
  const parsed = Date.parse(after)
  if (Number.isNaN(parsed)) return undefined
  const ageMs = Date.now() - parsed
  if (ageMs <= 60 * 60 * 1000) return 'hour'
  if (ageMs <= 24 * 60 * 60 * 1000) return 'day'
  if (ageMs <= 7 * 24 * 60 * 60 * 1000) return 'week'
  if (ageMs <= 31 * 24 * 60 * 60 * 1000) return 'month'
  if (ageMs <= 366 * 24 * 60 * 60 * 1000) return 'year'
  return undefined
}

function withDomainOperators(query: string, include: string[] | undefined, exclude: string[] | undefined): string {
  const includeClause = include?.length ? `(${include.map((domain) => `site:${domain}`).join(' OR ')})` : ''
  const excludeClause = exclude?.length ? exclude.map((domain) => `-site:${domain}`).join(' ') : ''
  return [query, includeClause, excludeClause].filter(Boolean).join(' ')
}

export const nimble: ProviderAdapter = {
  name: 'nimble',
  envKey: 'NIMBLE_API_KEY',
  capabilities: {
    mediaTypes: ['web', 'news'],
    freshness: true,
    domainFilters: true,
    fullContent: false,
    maxPerRequest: 100,
  },
  costModel: { kind: 'metered', perRequestUSD: 0.005 },
  async search(q, ctx) {
    const max = Math.min(q.max, 100)
    const query = withDomainOperators(q.q, q.domains?.include, q.domains?.exclude)
    const body: Record<string, unknown> = {
      search_engine: q.mediaType === 'news' ? 'google_news' : 'google_search',
      query,
      num_results: max,
      country: 'US',
      locale: 'en',
      no_html: true,
    }
    const time = freshnessTime(q.freshness?.after)
    if (time) body.time = time

    const json = await requestJSON<NimbleResponse>('https://sdk.nimbleway.com/v1/serp', {
      method: 'POST',
      signal: ctx.signal,
      headers: {
        authorization: `Bearer ${ctx.key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    const hits: Hit[] = entityRows(json)
      .filter((r): r is NimbleResult & { url: string } => typeof r.url === 'string' && r.url.length > 0)
      .slice(0, max)
      .map((r, i) => {
        const meta = r.metadata ?? r.extra_fields
        const publishedAt = r.date ?? stringField(meta, ['published_date', 'publishedAt', 'date'])
        const author = stringField(meta, ['author', 'byline'])
        const snippet = r.snippet ?? r.description
        return {
          provider: 'nimble',
          rank: typeof r.position === 'number' ? r.position : i + 1,
          url: r.url,
          ...(r.title ? { title: r.title } : {}),
          ...(snippet ? { snippet: snippet.slice(0, 500) } : {}),
          ...(publishedAt ? { publishedAt } : {}),
          ...(author ?? r.source ? { author: author ?? r.source } : {}),
          mediaType: q.mediaType,
          raw: r,
        }
      })
    return { hits }
  },
}
