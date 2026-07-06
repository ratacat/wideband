import type { Hit, ProviderAdapter } from '../core/types'
import { requestJSON } from './http'

type ParallelResult = {
  url?: string
  title?: string
  publish_date?: string
  excerpts?: string[]
}

type ParallelResponse = {
  results?: ParallelResult[]
}

export const parallel: ProviderAdapter = {
  name: 'parallel',
  envKey: 'PARALLEL_API_KEY',
  capabilities: {
    mediaTypes: ['web'],
    freshness: false,
    domainFilters: false,
    fullContent: true,
    maxPerRequest: 25,
  },
  costModel: { kind: 'metered', perRequestUSD: 0.005 },
  async search(q, ctx) {
    const max = Math.min(q.max, 25)
    const json = await requestJSON<ParallelResponse>('https://api.parallel.ai/v1/search', {
      method: 'POST',
      signal: ctx.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': ctx.key,
      },
      body: JSON.stringify({
        objective: q.q,
        search_queries: [q.q],
        mode: q.mode === 'research' ? 'advanced' : 'basic',
        advanced_settings: { max_results: max },
      }),
    })

    const hits: Hit[] = (json.results ?? [])
      .filter((r): r is ParallelResult & { url: string } => typeof r.url === 'string' && r.url.length > 0)
      .slice(0, max)
      .map((r, i) => {
        const excerpts = r.excerpts ?? []
        return {
          provider: 'parallel',
          rank: i + 1,
          url: r.url,
          ...(r.title ? { title: r.title } : {}),
          ...(excerpts[0] ? { snippet: excerpts[0].slice(0, 500) } : {}),
          ...(excerpts.length ? { content: excerpts.join('\n\n') } : {}),
          ...(r.publish_date ? { publishedAt: r.publish_date } : {}),
          mediaType: 'web',
          raw: r,
        }
      })
    return { hits }
  },
}
