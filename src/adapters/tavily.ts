import { Effect, Schema } from 'effect'
import type { Hit, ProviderAdapter } from '../core/types'
import { dateOnly } from '../core/freshness'
import { requestJSON, HttpUrl } from './http'

const TavilyResult = Schema.StructWithRest(Schema.Struct({
  title: Schema.optionalKey(Schema.NullOr(Schema.String)),
  url: HttpUrl,
  content: Schema.optionalKey(Schema.NullOr(Schema.String)),
  raw_content: Schema.optionalKey(Schema.NullOr(Schema.String)),
  score: Schema.optionalKey(Schema.Finite),
  published_date: Schema.optionalKey(Schema.NullOr(Schema.String)),
}), [Schema.Record(Schema.String, Schema.Unknown)])
type TavilyResult = typeof TavilyResult.Type
const TavilyResponse = Schema.Struct({ results: Schema.Array(TavilyResult) })

export const tavily: ProviderAdapter = {
  name: 'tavily',
  envKey: 'TAVILY_API_KEY',
  capabilities: {
    mediaTypes: ['web', 'news'],
    freshness: true,
    domainFilters: true,
    fullContent: true,
    maxPerRequest: 20,
  },
  costModel: { kind: 'metered', perRequestUSD: 0.008 },
  search(q, ctx) {
    return Effect.gen(function* () {
      const max = Math.min(q.max, 20)
      const research = q.mode === 'research'
      const body: Record<string, unknown> = {
        query: q.q,
        max_results: max,
        search_depth: research ? 'advanced' : 'basic',
        include_answer: false,
        include_raw_content: research ? 'markdown' : false,
      }
      if (research) body.chunks_per_source = 3
      if (q.mediaType === 'news') body.topic = 'news'
      if (q.freshness?.after) body.start_date = dateOnly(q.freshness.after)
      if (q.freshness?.before) body.end_date = dateOnly(q.freshness.before)
      if (q.domains?.include?.length) body.include_domains = q.domains.include
      if (q.domains?.exclude?.length) body.exclude_domains = q.domains.exclude

      const json = yield* ctx.request({
        requestId: 'search',
        run: requestJSON('https://api.tavily.com/search', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${ctx.key}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
        }, TavilyResponse, ctx.key),
        estimateMicroUSD: q.mode === 'research' ? 16_000 : 8_000,
      })

      const hits: Hit[] = json.results
        .slice(0, max)
        .map((r, i) => ({
          provider: 'tavily',
          rank: i + 1,
          url: r.url,
          ...(r.title ? { title: r.title } : {}),
          ...(r.content ? { snippet: r.content.slice(0, 500) } : {}),
          ...(r.raw_content ? { content: r.raw_content } : {}),
          ...(r.published_date ? { publishedAt: r.published_date } : {}),
          ...(typeof r.score === 'number' ? { score: r.score } : {}),
          mediaType: q.mediaType,
          raw: r,
        }))
      yield* ctx.addHits(hits)
    })
  },
}
