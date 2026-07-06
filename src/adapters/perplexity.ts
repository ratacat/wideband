import type { Hit, ProviderAdapter } from '../core/types'
import { requestJSON } from './http'

type PerplexityResult = {
  title?: string
  url?: string
  snippet?: string
  date?: string
}

type PerplexityResponse = {
  results?: PerplexityResult[]
}

export const perplexity: ProviderAdapter = {
  name: 'perplexity',
  envKey: 'PERPLEXITY_API_KEY',
  capabilities: {
    mediaTypes: ['web'],
    freshness: false,
    domainFilters: false,
    fullContent: false,
    maxPerRequest: 20,
  },
  costModel: { kind: 'metered', perRequestUSD: 0.005 },
  async search(q, ctx) {
    const max = Math.min(q.max, 20)
    const json = await requestJSON<PerplexityResponse>('https://api.perplexity.ai/search', {
      method: 'POST',
      signal: ctx.signal,
      headers: {
        authorization: `Bearer ${ctx.key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query: q.q, max_results: max }),
    })

    const hits: Hit[] = (json.results ?? [])
      .filter((r): r is PerplexityResult & { url: string } => typeof r.url === 'string' && r.url.length > 0)
      .slice(0, max)
      .map((r, i) => ({
        provider: 'perplexity',
        rank: i + 1,
        url: r.url,
        ...(r.title ? { title: r.title } : {}),
        ...(r.snippet ? { snippet: r.snippet } : {}),
        ...(r.date ? { publishedAt: r.date } : {}),
        mediaType: 'web',
        raw: r,
      }))
    return { hits }
  },
}
