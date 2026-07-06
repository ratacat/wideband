import type { Hit, ProviderAdapter } from '../core/types'
import { requestJSON, stripTags } from './http'

type SearchXResult = {
  title?: string
  name?: string
  alt?: string
  url?: string
  link?: string
  image_url?: string
  thumbnail_url?: string
  snippet?: string
  description?: string
  content?: string
  markdown?: string
  citation?: string
  published_at?: string
  publishedAt?: string
  date?: string
  score?: number
}

type SearchXResponse = {
  results?: SearchXResult[]
  data?: SearchXResult[] | { results?: SearchXResult[] }
}

function rows(json: SearchXResponse): SearchXResult[] {
  if (Array.isArray(json.results)) return json.results
  if (Array.isArray(json.data)) return json.data
  if (json.data && Array.isArray(json.data.results)) return json.data.results
  return []
}

function resultUrl(result: SearchXResult, imageMode: boolean): string | undefined {
  if (imageMode) return result.image_url ?? result.url ?? result.link
  return result.url ?? result.link ?? result.image_url
}

export const searchx: ProviderAdapter = {
  name: 'searchx',
  envKey: 'SEARCHX_API_KEY',
  capabilities: {
    mediaTypes: ['web', 'image'],
    freshness: false,
    domainFilters: false,
    fullContent: false,
    maxPerRequest: 20,
  },
  costModel: { kind: 'free', monthlyQuota: 90_000 },
  async search(q, ctx) {
    const max = Math.min(q.max, 20)
    const imageMode = q.mediaType === 'image'
    const url = new URL(imageMode ? 'https://searchx.dev/api/v1/images/search' : 'https://searchx.dev/api/v1/search')
    url.searchParams.set('q', q.q)
    url.searchParams.set('per_page', String(max))
    if (!imageMode) url.searchParams.set('mode', q.mode === 'research' ? 'hybrid' : 'keyword')

    const json = await requestJSON<SearchXResponse>(url.toString(), {
      signal: ctx.signal,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${ctx.key}`,
      },
    })

    const hits: Hit[] = rows(json)
      .filter((r): r is SearchXResult => typeof resultUrl(r, imageMode) === 'string')
      .slice(0, max)
      .map((r, i) => {
        const url = resultUrl(r, imageMode)!
        const title = r.title ?? r.name ?? r.alt
        const snippet = r.snippet ?? r.description ?? r.citation ?? r.content ?? r.markdown
        const publishedAt = r.published_at ?? r.publishedAt ?? r.date
        return {
          provider: 'searchx',
          rank: i + 1,
          url,
          ...(title ? { title } : {}),
          ...(snippet ? { snippet: stripTags(snippet).slice(0, 500) } : {}),
          ...(q.mode === 'research' && (r.markdown ?? r.content) ? { content: r.markdown ?? r.content } : {}),
          ...(publishedAt ? { publishedAt } : {}),
          ...(typeof r.score === 'number' ? { score: r.score } : {}),
          mediaType: imageMode ? 'image' : 'web',
          raw: r,
        }
      })
    return { hits }
  },
}
