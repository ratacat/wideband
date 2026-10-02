import { Effect, Schema, Result } from 'effect'
import type { Hit, ProviderAdapter } from '../core/types'
import { requestJSON, HttpUrl, ReportedUSD } from './http'

const ExaResult = Schema.StructWithRest(Schema.Struct({
  url: HttpUrl,
  title: Schema.optionalKey(Schema.NullOr(Schema.String)),
  publishedDate: Schema.optionalKey(Schema.NullOr(Schema.String)),
  author: Schema.optionalKey(Schema.NullOr(Schema.String)),
  score: Schema.optionalKey(Schema.Finite),
  text: Schema.optionalKey(Schema.NullOr(Schema.String)),
  highlights: Schema.optionalKey(Schema.Array(Schema.String)),
  summary: Schema.optionalKey(Schema.NullOr(Schema.String)),
}), [Schema.Record(Schema.String, Schema.Unknown)])
type ExaResult = typeof ExaResult.Type
const ExaResponse = Schema.Struct({ results: Schema.Array(ExaResult) })
const ExaCost = Schema.Struct({ costDollars: Schema.optionalKey(Schema.Struct({ total: Schema.optionalKey(ReportedUSD) })) })

export const exa: ProviderAdapter = {
  name: 'exa',
  envKey: 'EXA_API_KEY',
  capabilities: {
    mediaTypes: ['web', 'news'],
    freshness: true,
    domainFilters: true,
    fullContent: true,
    maxPerRequest: 25,
  },
  costModel: { kind: 'metered', perRequestUSD: 0.007 },
  search(q, ctx) {
    return Effect.gen(function* () {
      const max = Math.min(q.max, 25)
      const research = q.mode === 'research'
      const body: Record<string, unknown> = {
        query: q.q,
        numResults: max,
        type: research ? 'auto' : 'fast',
        contents: research
          ? { highlights: true, text: { maxCharacters: 6000 } }
          : { highlights: { maxCharacters: 1000 } },
      }
      if (q.mediaType === 'news') body.category = 'news'
      if (q.freshness?.after) body.startPublishedDate = q.freshness.after
      if (q.freshness?.before) body.endPublishedDate = q.freshness.before
      if (q.domains?.include?.length) body.includeDomains = q.domains.include
      if (q.domains?.exclude?.length) body.excludeDomains = q.domains.exclude

      const json = yield* ctx.request({
        requestId: 'search',
        estimateMicroUSD: 7_000 + Math.max(0, max - 10) * 1_000,
        run: requestJSON('https://api.exa.ai/search', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': ctx.key,
          },
          body: JSON.stringify(body),
        }, ExaResponse, ctx.key, raw => Result.map(Schema.decodeUnknownResult(ExaCost)(raw), cost => cost.costDollars?.total)),
      })

      const hits: Hit[] = json.results
        .slice(0, max)
        .map((r, i) => {
          const excerpt = r.highlights?.join('\n\n') || r.summary || r.text
          return {
            provider: 'exa',
            rank: i + 1,
            url: r.url,
            ...(r.title ? { title: r.title } : {}),
            ...(excerpt ? { snippet: excerpt.slice(0, 500) } : {}),
            ...(research && r.text ? { content: r.text } : {}),
            ...(r.publishedDate ? { publishedAt: r.publishedDate } : {}),
            ...(r.author ? { author: r.author } : {}),
            ...(typeof r.score === 'number' ? { score: r.score } : {}),
            mediaType: q.mediaType,
            raw: r,
          }
        })
      yield* ctx.addHits(hits)
    })
  },
}
