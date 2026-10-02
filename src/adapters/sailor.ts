import { Effect, Schema } from 'effect'
import type { Hit, ProviderAdapter } from '../core/types'
import { requestJSON, HttpUrl } from './http'

const SailorResult = Schema.StructWithRest(Schema.Struct({
  title: Schema.optionalKey(Schema.NullOr(Schema.String)),
  url: HttpUrl,
  markdown: Schema.optionalKey(Schema.NullOr(Schema.String)),
  content: Schema.optionalKey(Schema.NullOr(Schema.String)),
  text: Schema.optionalKey(Schema.NullOr(Schema.String)),
  snippet: Schema.optionalKey(Schema.NullOr(Schema.String)),
  published_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
  publishedAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  date: Schema.optionalKey(Schema.NullOr(Schema.String)),
  score: Schema.optionalKey(Schema.Finite),
}), [Schema.Record(Schema.String, Schema.Unknown)])
type SailorResult = typeof SailorResult.Type
const SailorResponse = Schema.Union([
  Schema.Struct({ results: Schema.Array(SailorResult) }),
  Schema.Struct({ sources: Schema.Array(SailorResult) }),
])
type SailorResponse = typeof SailorResponse.Type

function rows(json: SailorResponse): readonly SailorResult[] {
  return 'results' in json ? json.results : json.sources
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
  search(q, ctx) {
    return Effect.gen(function* () {
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

      const json = yield* ctx.request({
        requestId: 'search',
        run: requestJSON('https://sailorsearch.dev/api/v1/search', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${ctx.key}`,
            'x-api-key': ctx.key,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
        }, SailorResponse, ctx.key),
      })

      const hits: Hit[] = rows(json)
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
      yield* ctx.addHits(hits)
    })
  },
}
