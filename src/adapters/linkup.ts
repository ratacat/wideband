import type { Hit, MediaType, ProviderAdapter } from '../core/types'
import { addDays, dateOnly } from '../core/freshness'
import { requestJSON } from './http'

type LinkupResult = {
  type?: 'text' | 'image'
  name?: string
  url?: string
  content?: string
  snippet?: string
}

type LinkupResponse = {
  results?: LinkupResult[]
}

function mediaTypeFor(result: LinkupResult): MediaType {
  return result.type === 'image' ? 'image' : 'web'
}

export const linkup: ProviderAdapter = {
  name: 'linkup',
  envKey: 'LINKUP_API_KEY',
  capabilities: {
    mediaTypes: ['web', 'image'],
    freshness: true,
    domainFilters: true,
    fullContent: false,
    maxPerRequest: 50,
  },
  costModel: { kind: 'metered', perRequestUSD: 0.005 },
  async search(q, ctx) {
    const max = Math.min(q.max, 50)
    const body: Record<string, unknown> = {
      q: q.q,
      depth: q.mode === 'research' ? 'standard' : 'fast',
      outputType: 'searchResults',
      maxResults: max,
    }
    if (q.mediaType === 'image') body.includeImages = true
    const fromDate = q.freshness?.after ? dateOnly(q.freshness.after) : undefined
    const requestedToDate = q.freshness?.before ? dateOnly(q.freshness.before) : undefined
    const toDate = fromDate && (!requestedToDate || requestedToDate <= fromDate) ? addDays(fromDate, 1) : requestedToDate
    if (fromDate) body.fromDate = fromDate
    if (toDate) body.toDate = toDate
    if (q.domains?.include?.length) body.includeDomains = q.domains.include
    if (q.domains?.exclude?.length) body.excludeDomains = q.domains.exclude

    const json = await requestJSON<LinkupResponse>('https://api.linkup.so/v1/search', {
      method: 'POST',
      signal: ctx.signal,
      headers: {
        authorization: `Bearer ${ctx.key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    const hits: Hit[] = (json.results ?? [])
      .filter((r): r is LinkupResult & { url: string } => typeof r.url === 'string' && r.url.length > 0)
      .filter((r) => q.mediaType !== 'image' || r.type === 'image')
      .slice(0, max)
      .map((r, i) => {
        const snippet = r.content ?? r.snippet
        return {
          provider: 'linkup',
          rank: i + 1,
          url: r.url,
          ...(r.name ? { title: r.name } : {}),
          ...(snippet ? { snippet: snippet.slice(0, 500) } : {}),
          mediaType: mediaTypeFor(r),
          raw: r,
        }
      })
    return { hits }
  },
}
