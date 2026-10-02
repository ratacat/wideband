import { Effect, Schema } from 'effect'
import type { Hit, ProviderAdapter } from '../core/types'
import { dateOnly } from '../core/freshness'
import { requestJSON, HttpUrl, stripTags } from './http'

const BraveResult = Schema.StructWithRest(Schema.Struct({
  title: Schema.optionalKey(Schema.NullOr(Schema.String)),
  url: HttpUrl,
  description: Schema.optionalKey(Schema.NullOr(Schema.String)),
  page_age: Schema.optionalKey(Schema.NullOr(Schema.String)),
}), [Schema.Record(Schema.String, Schema.Unknown)])
type BraveResult = typeof BraveResult.Type
const BraveWebResponse = Schema.Struct({ web: Schema.Struct({ results: Schema.Array(BraveResult) }) })
const BraveNewsResponse = Schema.Struct({ results: Schema.Array(BraveResult) })

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
  search(q, ctx) {
    return Effect.gen(function* () {
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

      const json = yield* ctx.request({
        requestId: 'search',
        run: requestJSON<typeof BraveWebResponse.Type | typeof BraveNewsResponse.Type>(url.toString(), {
          headers: {
            accept: 'application/json',
            'X-Subscription-Token': ctx.key,
          },
        }, q.mediaType === 'news' ? BraveNewsResponse : BraveWebResponse, ctx.key),
      })

      const rows = 'results' in json ? json.results : json.web.results
      const hits: Hit[] = rows
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
      yield* ctx.addHits(hits)
    })
  },
}
