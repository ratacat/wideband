import type { Hit, ProviderAdapter } from '../core/types'
import { requestJSON } from './http'

type DesearchResult = {
  title?: string
  snippet?: string
  link?: string
  date?: string | null
}

type DesearchResponse = {
  data?: DesearchResult[]
}

export const desearch: ProviderAdapter = {
  name: 'desearch',
  envKey: 'DESEARCH_API_KEY',
  capabilities: {
    mediaTypes: ['web'],
    freshness: false,
    domainFilters: false,
    fullContent: false,
    maxPerRequest: 10,
  },
  costModel: { kind: 'metered', perRequestUSD: 0.00025 },
  async search(q, ctx) {
    const max = Math.min(q.max, 10)
    const url = new URL('https://api.desearch.ai/web')
    url.searchParams.set('query', q.q)
    url.searchParams.set('num', String(max))
    url.searchParams.set('start', '0')

    const json = await requestJSON<DesearchResponse>(url.toString(), {
      signal: ctx.signal,
      headers: {
        accept: 'application/json',
        authorization: ctx.key,
      },
    })

    const hits: Hit[] = (json.data ?? [])
      .filter((r): r is DesearchResult & { link: string } => typeof r.link === 'string' && r.link.length > 0)
      .slice(0, max)
      .map((r, i) => ({
        provider: 'desearch',
        rank: i + 1,
        url: r.link,
        ...(r.title ? { title: r.title } : {}),
        ...(r.snippet ? { snippet: r.snippet } : {}),
        ...(r.date ? { publishedAt: r.date } : {}),
        mediaType: 'web',
        raw: r,
      }))
    return { hits }
  },
}
