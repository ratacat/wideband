import { Effect, Schema } from 'effect'
import type { Hit, ProviderAdapter } from '../core/types'
import { requestJSON, HttpUrl } from './http'

const PerplexityResult = Schema.StructWithRest(Schema.Struct({
  title: Schema.optionalKey(Schema.NullOr(Schema.String)),
  url: HttpUrl,
  snippet: Schema.optionalKey(Schema.NullOr(Schema.String)),
  date: Schema.optionalKey(Schema.NullOr(Schema.String)),
}), [Schema.Record(Schema.String, Schema.Unknown)])
type PerplexityResult = typeof PerplexityResult.Type
const PerplexityResponse = Schema.Struct({ results: Schema.Array(PerplexityResult) })

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
  search(q, ctx) {
    return Effect.gen(function* () {
      const max = Math.min(q.max, 20)
      const json = yield* ctx.request({
        requestId: 'search',
        run: requestJSON('https://api.perplexity.ai/search', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${ctx.key}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ query: q.q, max_results: max }),
        }, PerplexityResponse, ctx.key),
      })

      const hits: Hit[] = json.results
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
      yield* ctx.addHits(hits)
    })
  },
}
