import type { Hit, ProviderAdapter } from '../core/types'
import { requestJSON } from './http'

type JinaResult = {
  title?: string
  description?: string
  url?: string
  content?: string
}

type JinaResponse = {
  data?: JinaResult[] | JinaResult
}

function rows(data: JinaResponse['data']): JinaResult[] {
  if (Array.isArray(data)) return data
  return data ? [data] : []
}

export const jina: ProviderAdapter = {
  name: 'jina',
  envKey: 'JINA_API_KEY',
  capabilities: {
    mediaTypes: ['web'],
    freshness: false,
    domainFilters: false,
    fullContent: true,
    maxPerRequest: 10,
  },
  costModel: { kind: 'free', monthlyQuota: 1_000 },
  async search(q, ctx) {
    const max = Math.min(q.max, 10)
    const research = q.mode === 'research'
    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: `Bearer ${ctx.key}`,
      'content-type': 'application/json',
    }
    if (!research) headers['X-Respond-With'] = 'no-content'

    const json = await requestJSON<JinaResponse>('https://s.jina.ai/', {
      method: 'POST',
      signal: ctx.signal,
      headers,
      body: JSON.stringify({ q: q.q, num: max }),
    })

    const hits: Hit[] = rows(json.data)
      .filter((r): r is JinaResult & { url: string } => typeof r.url === 'string' && r.url.length > 0)
      .slice(0, max)
      .map((r, i) => {
        const snippet = r.description ?? r.content
        return {
          provider: 'jina',
          rank: i + 1,
          url: r.url,
          ...(r.title ? { title: r.title } : {}),
          ...(snippet ? { snippet: snippet.slice(0, 500) } : {}),
          ...(research && r.content ? { content: r.content } : {}),
          mediaType: 'web',
          raw: r,
        }
      })
    return { hits }
  },
}
