import { Effect, Schema } from 'effect'
import type { Hit, ProviderAdapter } from '../core/types'
import { requestJSON, HttpUrl } from './http'

const DesearchResult = Schema.StructWithRest(Schema.Struct({
  title: Schema.optionalKey(Schema.NullOr(Schema.String)),
  snippet: Schema.optionalKey(Schema.NullOr(Schema.String)),
  link: HttpUrl,
  date: Schema.optionalKey(Schema.NullOr(Schema.String)),
}), [Schema.Record(Schema.String, Schema.Unknown)])
type DesearchResult = typeof DesearchResult.Type
const DesearchResponse = Schema.Struct({ data: Schema.Array(DesearchResult) })

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
  search(q, ctx) {
    return Effect.gen(function* () {
      const max = Math.min(q.max, 10)
      const url = new URL('https://api.desearch.ai/web')
      url.searchParams.set('query', q.q)
      url.searchParams.set('num', String(max))
      url.searchParams.set('start', '0')

      const json = yield* ctx.request({
        requestId: 'search',
        run: requestJSON(url.toString(), {
          headers: {
            accept: 'application/json',
            authorization: ctx.key,
          },
        }, DesearchResponse, ctx.key),
      })

      const hits: Hit[] = json.data
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
      yield* ctx.addHits(hits)
    })
  },
}
