import { Effect, Schema } from 'effect'
import type { Hit, MediaType, ProviderAdapter } from '../core/types'
import { addDays, dateOnly } from '../core/freshness'
import { requestJSON, HttpUrl } from './http'

const LinkupResult = Schema.StructWithRest(Schema.Struct({
  type: Schema.optionalKey(Schema.Literals(['text', 'image'])),
  name: Schema.optionalKey(Schema.NullOr(Schema.String)),
  url: HttpUrl,
  content: Schema.optionalKey(Schema.NullOr(Schema.String)),
  snippet: Schema.optionalKey(Schema.NullOr(Schema.String)),
}), [Schema.Record(Schema.String, Schema.Unknown)])
type LinkupResult = typeof LinkupResult.Type
const LinkupResponse = Schema.Struct({ results: Schema.Array(LinkupResult) })

function mediaTypeFor(result: LinkupResult): MediaType {
  return result.type === 'image' ? 'image' : 'web'
}

export const linkup: ProviderAdapter = {
  name: 'linkup',
  envKey: 'LINKUP_API_KEY',
  capabilities: {
    mediaTypes: ['web', 'image'],
    freshness: true,
    domainFilters: true,
    fullContent: false,
    maxPerRequest: 50,
  },
  costModel: { kind: 'metered', perRequestUSD: 0.005 },
  search(q, ctx) {
    return Effect.gen(function* () {
      const max = Math.min(q.max, 50)
      const body: Record<string, unknown> = {
        q: q.q,
        depth: q.mode === 'research' ? 'standard' : 'fast',
        outputType: 'searchResults',
        maxResults: max,
      }
      if (q.mediaType === 'image') body.includeImages = true
      const fromDate = q.freshness?.after ? dateOnly(q.freshness.after) : undefined
      const requestedToDate = q.freshness?.before ? dateOnly(q.freshness.before) : undefined
      const toDate = fromDate && (!requestedToDate || requestedToDate <= fromDate) ? addDays(fromDate, 1) : requestedToDate
      if (fromDate) body.fromDate = fromDate
      if (toDate) body.toDate = toDate
      if (q.domains?.include?.length) body.includeDomains = q.domains.include
      if (q.domains?.exclude?.length) body.excludeDomains = q.domains.exclude

      const json = yield* ctx.request({
        requestId: 'search',
        run: requestJSON('https://api.linkup.so/v1/search', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${ctx.key}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
        }, LinkupResponse, ctx.key),
      })

      const hits: Hit[] = json.results
        .filter((r) => q.mediaType !== 'image' || r.type === 'image')
        .slice(0, max)
        .map((r, i) => {
          const snippet = r.content ?? r.snippet
          return {
            provider: 'linkup',
            rank: i + 1,
            url: r.url,
            ...(r.name ? { title: r.name } : {}),
            ...(snippet ? { snippet: snippet.slice(0, 500) } : {}),
            mediaType: mediaTypeFor(r),
            raw: r,
          }
        })
      yield* ctx.addHits(hits)
    })
  },
}
