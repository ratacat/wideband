import type { Hit, ProviderAdapter } from '../core/types'
import { requestJSON } from './http'

type SailorResult = {
  title?: string
  url?: string
  markdown?: string
  content?: string
  text?: string
  snippet?: string
  published_at?: string
  publishedAt?: string
  date?: string
  score?: number
}

type SailorResponse = {
  results?: SailorResult[]
  sources?: SailorResult[]
}

function rows(json: SailorResponse): SailorResult[] {
  return json.results ?? json.sources ?? []
}

export const sailor: ProviderAdapter = {
  name: 'sailor',
  envKey: 'SAILOR_API_KEY',
  capabilities: {
    mediaTypes: ['web'],
    freshness: false,
    domainFilters: false,
    fullContent: false,
    maxPerRequest: 10,
  },
  costModel: { kind: 'free', monthlyQuota: 500 },
  async search(q, ctx) {
    const max = Math.min(q.max, 10)
    const research = q.mode === 'research'
    const body: Record<string, unknown> = {
      q: q.q,
      num: max,
      format: 'markdown',
      engine: 'sail',
      search_mode: research ? 'advanced' : 'basic',
      dedupe: true,
    }

    const json = await requestJSON<SailorResponse>('https://sailorsearch.dev/api/v1/search', {
      method: 'POST',
      signal: ctx.signal,
      headers: {
        authorization: `Bearer ${ctx.key}`,
        'x-api-key': ctx.key,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    const hits: Hit[] = rows(json)
      .filter((r): r is SailorResult & { url: string } => typeof r.url === 'string' && r.url.length > 0)
      .slice(0, max)
      .map((r, i) => {
        const content = r.markdown ?? r.content ?? r.text
        const snippet = r.snippet ?? content
        const publishedAt = r.published_at ?? r.publishedAt ?? r.date
        return {
          provider: 'sailor',
          rank: i + 1,
          url: r.url,
          ...(r.title ? { title: r.title } : {}),
          ...(snippet ? { snippet: snippet.slice(0, 500) } : {}),
          ...(research && content ? { content } : {}),
          ...(publishedAt ? { publishedAt } : {}),
          ...(typeof r.score === 'number' ? { score: r.score } : {}),
          mediaType: 'web',
          raw: r,
        }
      })
    return { hits }
  },
}
