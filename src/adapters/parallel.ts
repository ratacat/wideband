import { Effect, Schema } from 'effect'
import type { Hit, ProviderAdapter } from '../core/types'
import { requestJSON, HttpUrl } from './http'

const ParallelResult = Schema.StructWithRest(Schema.Struct({
  url: HttpUrl,
  title: Schema.optionalKey(Schema.NullOr(Schema.String)),
  publish_date: Schema.optionalKey(Schema.NullOr(Schema.String)),
  excerpts: Schema.optionalKey(Schema.Array(Schema.String)),
}), [Schema.Record(Schema.String, Schema.Unknown)])
type ParallelResult = typeof ParallelResult.Type
const ParallelResponse = Schema.Struct({ results: Schema.Array(ParallelResult) })

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
  search(q, ctx) {
    return Effect.gen(function* () {
      const max = Math.min(q.max, 25)
      const json = yield* ctx.request({
        requestId: 'search',
        estimateMicroUSD: 5_000 + Math.max(0, max - 10) * 1_000,
        run: requestJSON('https://api.parallel.ai/v1/search', {
          method: 'POST',
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
        }, ParallelResponse, ctx.key),
      })

      const hits: Hit[] = json.results
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
      yield* ctx.addHits(hits)
    })
  },
}
