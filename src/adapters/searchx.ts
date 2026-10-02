import { Effect, Schema } from 'effect'
import type { Hit, ProviderAdapter } from '../core/types'
import { requestJSON, HttpUrl, stripTags } from './http'

const SearchXResult = Schema.StructWithRest(Schema.Struct({
  title: Schema.optionalKey(Schema.NullOr(Schema.String)),
  name: Schema.optionalKey(Schema.NullOr(Schema.String)),
  alt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  url: Schema.optionalKey(HttpUrl),
  link: Schema.optionalKey(HttpUrl),
  image_url: Schema.optionalKey(HttpUrl),
  thumbnail_url: Schema.optionalKey(HttpUrl),
  snippet: Schema.optionalKey(Schema.NullOr(Schema.String)),
  description: Schema.optionalKey(Schema.NullOr(Schema.String)),
  content: Schema.optionalKey(Schema.NullOr(Schema.String)),
  markdown: Schema.optionalKey(Schema.NullOr(Schema.String)),
  citation: Schema.optionalKey(Schema.NullOr(Schema.String)),
  published_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
  publishedAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  date: Schema.optionalKey(Schema.NullOr(Schema.String)),
  score: Schema.optionalKey(Schema.Finite),
}), [Schema.Record(Schema.String, Schema.Unknown)]).check(Schema.makeFilter(row => Boolean(row.url ?? row.link ?? row.image_url)))
type SearchXResult = typeof SearchXResult.Type
const SearchXResponse = Schema.Union([
  Schema.Struct({ results: Schema.Array(SearchXResult) }),
  Schema.Struct({ data: Schema.Array(SearchXResult) }),
  Schema.Struct({ data: Schema.Struct({ results: Schema.Array(SearchXResult) }) }),
])
type SearchXResponse = typeof SearchXResponse.Type

function rows(json: SearchXResponse): readonly SearchXResult[] {
  if ('results' in json) return json.results
  return 'results' in json.data ? json.data.results : json.data
}

function resultUrl(result: SearchXResult, imageMode: boolean): string | undefined {
  if (imageMode) return result.image_url ?? result.url ?? result.link
  return result.url ?? result.link ?? result.image_url
}

export const searchx: ProviderAdapter = {
  name: 'searchx',
  envKey: 'SEARCHX_API_KEY',
  capabilities: {
    mediaTypes: ['web', 'image'],
    freshness: false,
    domainFilters: false,
    fullContent: false,
    maxPerRequest: 20,
  },
  costModel: { kind: 'free', monthlyQuota: 90_000 },
  search(q, ctx) {
    return Effect.gen(function* () {
      const max = Math.min(q.max, 20)
      const imageMode = q.mediaType === 'image'
      const url = new URL(imageMode ? 'https://searchx.dev/api/v1/images/search' : 'https://searchx.dev/api/v1/search')
      url.searchParams.set('q', q.q)
      url.searchParams.set('per_page', String(max))
      if (!imageMode) url.searchParams.set('mode', q.mode === 'research' ? 'hybrid' : 'keyword')

      const json = yield* ctx.request({
        requestId: 'search',
        run: requestJSON(url.toString(), {
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${ctx.key}`,
          },
        }, SearchXResponse, ctx.key),
      })

      const hits: Hit[] = rows(json)
        .flatMap(row => {
          const url = resultUrl(row, imageMode)
          return url ? [{ row, url }] : []
        })
        .slice(0, max)
        .map(({ row: r, url }, i) => {
          const content = r.markdown ?? r.content
          const title = r.title ?? r.name ?? r.alt
          const snippet = r.snippet ?? r.description ?? r.citation ?? r.content ?? r.markdown
          const publishedAt = r.published_at ?? r.publishedAt ?? r.date
          return {
            provider: 'searchx',
            rank: i + 1,
            url,
            ...(title ? { title } : {}),
            ...(snippet ? { snippet: stripTags(snippet).slice(0, 500) } : {}),
            ...(q.mode === 'research' && content ? { content } : {}),
            ...(publishedAt ? { publishedAt } : {}),
            ...(typeof r.score === 'number' ? { score: r.score } : {}),
            mediaType: imageMode ? 'image' : 'web',
            raw: r,
          }
        })
      yield* ctx.addHits(hits)
    })
  },
}
