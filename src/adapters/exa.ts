import type { Hit, ProviderAdapter } from '../core/types'
import { requestJSON } from './http'

type ExaResult = {
  url?: string
  title?: string
  publishedDate?: string
  author?: string
  score?: number
  text?: string
  highlights?: string[]
  summary?: string
}

type ExaResponse = {
  results?: ExaResult[]
  costDollars?: { total?: number }
}

export const exa: ProviderAdapter = {
  name: 'exa',
  envKey: 'EXA_API_KEY',
  capabilities: {
    mediaTypes: ['web', 'news'],
    freshness: true,
    domainFilters: true,
    fullContent: true,
    maxPerRequest: 25,
  },
  costModel: { kind: 'metered', perRequestUSD: 0.005 },
  async search(q, ctx) {
    const max = Math.min(q.max, 25)
    const research = q.mode === 'research'
    const body: Record<string, unknown> = {
      query: q.q,
      numResults: max,
      type: research ? 'auto' : 'fast',
      contents: research
        ? { highlights: true, text: { maxCharacters: 6000 } }
        : { highlights: { maxCharacters: 1000 } },
    }
    if (q.mediaType === 'news') body.category = 'news'
    if (q.freshness?.after) body.startPublishedDate = q.freshness.after
    if (q.freshness?.before) body.endPublishedDate = q.freshness.before
    if (q.domains?.include?.length) body.includeDomains = q.domains.include
    if (q.domains?.exclude?.length) body.excludeDomains = q.domains.exclude

    const json = await requestJSON<ExaResponse>('https://api.exa.ai/search', {
      method: 'POST',
      signal: ctx.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': ctx.key,
      },
      body: JSON.stringify(body),
    })

    const hits: Hit[] = (json.results ?? [])
      .filter((r): r is ExaResult & { url: string } => typeof r.url === 'string' && r.url.length > 0)
      .slice(0, max)
      .map((r, i) => {
        const excerpt = r.highlights?.join('\n\n') || r.summary || r.text
        return {
          provider: 'exa',
          rank: i + 1,
          url: r.url,
          ...(r.title ? { title: r.title } : {}),
          ...(excerpt ? { snippet: excerpt.slice(0, 500) } : {}),
          ...(research && r.text ? { content: r.text } : {}),
          ...(r.publishedDate ? { publishedAt: r.publishedDate } : {}),
          ...(r.author ? { author: r.author } : {}),
          ...(typeof r.score === 'number' ? { score: r.score } : {}),
          mediaType: q.mediaType,
          raw: r,
        }
      })
    return { hits, ...(typeof json.costDollars?.total === 'number' ? { reportedUSD: json.costDollars.total } : {}) }
  },
}
