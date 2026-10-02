import { Effect, Result, Schema } from 'effect'
import type { Hit, ProviderAdapter } from '../core/types'
import { HttpUrl, ReportedUSD, requestJSON } from './http'

const Row = Schema.StructWithRest(Schema.Struct({
  title: Schema.optionalKey(Schema.NullOr(Schema.String)),
  link: HttpUrl,
  snippet: Schema.optionalKey(Schema.NullOr(Schema.String)),
}), [Schema.Record(Schema.String, Schema.Unknown)])
const Data = Schema.Struct({
  results: Schema.Array(Row),
  nextCursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
})
const Body = Schema.Struct({
  output: Schema.Union([
    Schema.Struct({ found: Schema.Literal(false), data: Schema.Null }),
    Schema.Struct({ found: Schema.optionalKey(Schema.Literal(true)), data: Data }),
  ]),
})
const Cost = Schema.Struct({ costUsd: Schema.optionalKey(ReportedUSD) })

export const anyapi: ProviderAdapter = {
  name: 'anyapi',
  envKey: 'ANYAPI_API_KEY',
  timeoutMs: 60_000,
  capabilities: {
    mediaTypes: ['web'],
    freshness: false,
    domainFilters: false,
    fullContent: false,
    maxPerRequest: 100,
  },
  costModel: { kind: 'metered', perRequestUSD: 0.0005 },
  search(q, ctx) {
    return Effect.gen(function* () {
      const hits = new Map<string, Hit>()
      for (let page = 1; page <= (q.googlePages ?? 1) && hits.size < q.max; page++) {
        const body = yield* ctx.request({
          requestId: `page:${page}`,
          estimateMicroUSD: 900,
          run: requestJSON('https://api.getanyapi.com/v1/run/google.search', {
            method: 'POST',
            headers: { authorization: `Bearer ${ctx.key}`, 'content-type': 'application/json' },
            body: JSON.stringify({ query: q.q, page }),
          }, Body, ctx.key, raw => Result.map(Schema.decodeUnknownResult(Cost)(raw), cost => cost.costUsd)),
        })
        const added: Hit[] = []
        const rows = body.output.data?.results ?? []
        for (const row of rows) {
          if (hits.has(row.link) || hits.size >= q.max) continue
          const hit: Hit = {
            provider: 'anyapi',
            rank: hits.size + 1,
            url: row.link,
            ...(row.title ? { title: row.title } : {}),
            ...(row.snippet ? { snippet: row.snippet } : {}),
            mediaType: 'web',
            raw: row,
          }
          hits.set(row.link, hit)
          added.push(hit)
        }
        yield* ctx.addHits(added)
        if (!rows.length || !body.output.data?.nextCursor) break
      }
    })
  },
}
