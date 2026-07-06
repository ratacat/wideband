import type { Hit, ProviderAdapter } from '../core/types'
import { dateOnly } from '../core/freshness'
import { requestJSON, stripTags } from './http'

type BraveResult = {
  title?: string
  url?: string
  description?: string
  page_age?: string
}

type BraveResponse = {
  web?: { results?: BraveResult[] }
  results?: BraveResult[]
}

function freshnessParam(after?: string, before?: string): string | undefined {
  if (!after && !before) return undefined
  return `${after ? dateOnly(after) : ''}to${before ? dateOnly(before) : ''}`
}

export const brave: ProviderAdapter = {
  name: 'brave',
  envKey: 'BRAVE_API_KEY',
  capabilities: {
    mediaTypes: ['web', 'news'],
    freshness: true,
    domainFilters: false,
    fullContent: false,
    maxPerRequest: 20,
  },
  costModel: { kind: 'free', monthlyQuota: 2000 },
  async search(q, ctx) {
    const max = Math.min(q.max, 20)
    const endpoint =
      q.mediaType === 'news'
        ? 'https://api.search.brave.com/res/v1/news/search'
        : 'https://api.search.brave.com/res/v1/web/search'
    const url = new URL(endpoint)
    url.searchParams.set('q', q.q)
    url.searchParams.set('count', String(max))
    const freshness = freshnessParam(q.freshness?.after, q.freshness?.before)
    if (freshness) url.searchParams.set('freshness', freshness)

    const json = await requestJSON<BraveResponse>(url.toString(), {
      signal: ctx.signal,
      headers: {
        accept: 'application/json',
        'X-Subscription-Token': ctx.key,
      },
    })

    const rows = q.mediaType === 'news' ? (json.results ?? []) : (json.web?.results ?? [])
    const hits: Hit[] = rows
      .filter((r): r is BraveResult & { url: string } => typeof r.url === 'string' && r.url.length > 0)
      .slice(0, max)
      .map((r, i) => ({
        provider: 'brave',
        rank: i + 1,
        url: r.url,
        ...(r.title ? { title: r.title } : {}),
        ...(r.description ? { snippet: stripTags(r.description) } : {}),
        ...(r.page_age ? { publishedAt: r.page_age } : {}),
        mediaType: q.mediaType,
        raw: r,
      }))
    return { hits }
  },
}
