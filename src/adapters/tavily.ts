import type { Hit, ProviderAdapter } from '../core/types'
import { dateOnly } from '../core/freshness'
import { requestJSON } from './http'

type TavilyResult = {
  title?: string
  url?: string
  content?: string
  raw_content?: string | null
  score?: number
  published_date?: string
}

type TavilyResponse = {
  results?: TavilyResult[]
}

export const tavily: ProviderAdapter = {
  name: 'tavily',
  envKey: 'TAVILY_API_KEY',
  capabilities: {
    mediaTypes: ['web', 'news'],
    freshness: true,
    domainFilters: true,
    fullContent: true,
    maxPerRequest: 20,
  },
  costModel: { kind: 'metered', perRequestUSD: 0.005 },
  async search(q, ctx) {
    const max = Math.min(q.max, 20)
    const research = q.mode === 'research'
    const body: Record<string, unknown> = {
      query: q.q,
      max_results: max,
      search_depth: research ? 'advanced' : 'basic',
      include_answer: false,
      include_raw_content: research ? 'markdown' : false,
    }
    if (research) body.chunks_per_source = 3
    if (q.mediaType === 'news') body.topic = 'news'
    if (q.freshness?.after) body.start_date = dateOnly(q.freshness.after)
    if (q.freshness?.before) body.end_date = dateOnly(q.freshness.before)
    if (q.domains?.include?.length) body.include_domains = q.domains.include
    if (q.domains?.exclude?.length) body.exclude_domains = q.domains.exclude

    const json = await requestJSON<TavilyResponse>('https://api.tavily.com/search', {
      method: 'POST',
      signal: ctx.signal,
      headers: {
        authorization: `Bearer ${ctx.key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    const hits: Hit[] = (json.results ?? [])
      .filter((r): r is TavilyResult & { url: string } => typeof r.url === 'string' && r.url.length > 0)
      .slice(0, max)
      .map((r, i) => ({
        provider: 'tavily',
        rank: i + 1,
        url: r.url,
        ...(r.title ? { title: r.title } : {}),
        ...(r.content ? { snippet: r.content.slice(0, 500) } : {}),
        ...(r.raw_content ? { content: r.raw_content } : {}),
        ...(r.published_date ? { publishedAt: r.published_date } : {}),
        ...(typeof r.score === 'number' ? { score: r.score } : {}),
        mediaType: q.mediaType,
        raw: r,
      }))
    return { hits }
  },
}
