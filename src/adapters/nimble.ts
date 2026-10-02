import { Effect, Schema } from 'effect'
import type { Hit, ProviderAdapter } from '../core/types'
import { requestJSON, HttpUrl } from './http'

const NimbleResult = Schema.StructWithRest(Schema.Struct({
  title: Schema.optionalKey(Schema.NullOr(Schema.String)),
  description: Schema.optionalKey(Schema.NullOr(Schema.String)),
  url: HttpUrl,
  content: Schema.optionalKey(Schema.NullOr(Schema.String)),
  metadata: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
}), [Schema.Record(Schema.String, Schema.Unknown)])
const NimbleResponse = Schema.Struct({ results: Schema.Array(NimbleResult) })

function stringField(obj: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj?.[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

function freshnessTime(after: string | undefined): string | undefined {
  if (!after) return undefined
  const parsed = Date.parse(after)
  if (Number.isNaN(parsed)) return undefined
  const ageMs = Date.now() - parsed
  if (ageMs <= 60 * 60 * 1000) return 'hour'
  if (ageMs <= 24 * 60 * 60 * 1000) return 'day'
  if (ageMs <= 7 * 24 * 60 * 60 * 1000) return 'week'
  if (ageMs <= 31 * 24 * 60 * 60 * 1000) return 'month'
  if (ageMs <= 366 * 24 * 60 * 60 * 1000) return 'year'
  return undefined
}

export const nimble: ProviderAdapter = {
  name: 'nimble',
  envKey: 'NIMBLE_API_KEY',
  timeoutMs: 30_000,
  capabilities: {
    mediaTypes: ['web', 'news'],
    freshness: true,
    domainFilters: true,
    fullContent: true,
    maxPerRequest: 100,
  },
  costModel: { kind: 'metered', perRequestUSD: 0.005 },
  search(q, ctx) {
    return Effect.gen(function* () {
      const max = Math.min(q.max, 100)
      const body: Record<string, unknown> = {
        query: q.q,
        focus: q.mediaType === 'news' ? 'news' : 'general',
        max_results: max,
        search_depth: q.mode === 'research' ? 'deep' : 'lite',
      }
      if (q.domains?.include?.length) body.include_domains = q.domains.include
      if (q.domains?.exclude?.length) body.exclude_domains = q.domains.exclude
      const time = freshnessTime(q.freshness?.after)
      if (time) body.time_range = time

      const json = yield* ctx.request({
        requestId: 'search',
        run: requestJSON('https://sdk.nimbleway.com/v2/search', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${ctx.key}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
        }, NimbleResponse, ctx.key),
      })

      const hits: Hit[] = json.results
        .slice(0, max)
        .map((r, i) => {
          const position = r.metadata?.position
          const publishedAt = stringField(r.metadata, ['date', 'published_date', 'publishedAt'])
          const author = stringField(r.metadata, ['author', 'source'])
          return {
            provider: 'nimble',
            rank: typeof position === 'number' ? position : i + 1,
            url: r.url,
            ...(r.title ? { title: r.title } : {}),
            ...(r.description ? { snippet: r.description.slice(0, 500) } : {}),
            ...(q.mode === 'research' && r.content ? { content: r.content } : {}),
            ...(publishedAt ? { publishedAt } : {}),
            ...(author ? { author } : {}),
            mediaType: q.mediaType,
            raw: r,
          }
        })
      yield* ctx.addHits(hits)
    })
  },
}
