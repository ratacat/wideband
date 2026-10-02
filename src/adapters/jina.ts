import { Effect, Schema } from 'effect'
import type { Hit, ProviderAdapter } from '../core/types'
import { requestJSON, HttpUrl } from './http'

const JinaResult = Schema.StructWithRest(Schema.Struct({
  title: Schema.optionalKey(Schema.NullOr(Schema.String)),
  description: Schema.optionalKey(Schema.NullOr(Schema.String)),
  url: HttpUrl,
  content: Schema.optionalKey(Schema.NullOr(Schema.String)),
}), [Schema.Record(Schema.String, Schema.Unknown)])
type JinaResult = typeof JinaResult.Type
const JinaResponse = Schema.Struct({ data: Schema.Union([Schema.Array(JinaResult), JinaResult]) })
type JinaResponse = typeof JinaResponse.Type

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
  search(q, ctx) {
    return Effect.gen(function* () {
      const max = Math.min(q.max, 10)
      const research = q.mode === 'research'
      const headers: Record<string, string> = {
        accept: 'application/json',
        authorization: `Bearer ${ctx.key}`,
        'content-type': 'application/json',
      }
      if (!research) headers['X-Respond-With'] = 'no-content'

      const json = yield* ctx.request({
        requestId: 'search',
        run: requestJSON('https://s.jina.ai/', {
          method: 'POST',
          headers,
          body: JSON.stringify({ q: q.q, num: max }),
        }, JinaResponse, ctx.key),
      })

      const hits: Hit[] = ('url' in json.data ? [json.data] : json.data)
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
      yield* ctx.addHits(hits)
    })
  },
}
