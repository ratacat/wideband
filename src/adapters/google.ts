import { Effect } from 'effect'
import { searchEffect, SearchError } from '../google-search.mjs'
import type { GooglePage } from '../google-search.mjs'
import { AdapterError } from '../core/errors'
import { canonicalizeUrl } from '../core/merge'
import type { Hit, ProviderAdapter } from '../core/types'

export const google: ProviderAdapter = {
  name: 'google',
  timeoutMs: 120_000,
  capabilities: {
    mediaTypes: ['web'],
    freshness: false,
    domainFilters: false,
    fullContent: false,
    maxPerRequest: 100,
  },
  costModel: { kind: 'free' },
  search(query, ctx) {
    return Effect.gen(function* () {
      const hits = new Map<string, Hit>()
      let start: number | null = 0
      for (let page = 0; page < (query.googlePages ?? 1) && start !== null && hits.size < query.max; page++) {
        const result: GooglePage = yield* ctx.request({
          requestId: `page:${page + 1}`,
          estimateMicroUSD: 0,
          retryable: false,
          run: searchEffect(query.q, start).pipe(
            Effect.mapError(error => error instanceof SearchError
              ? Object.assign(
                  new AdapterError(error.code === 'timeout' || error.code === 'invalid_response' ? error.code : 'provider_error', `Google ${error.code}: ${error.message}`),
                  { reason: `google:${error.failures.join(',') || error.code}` },
                )
              : new AdapterError('provider_error', 'Google search failed; check uv, Python, and proxy inventory')),
            Effect.result,
            Effect.map(result => ({ result })),
          ),
        })
        const added: Hit[] = []
        for (const row of result.results) {
          const url = new URL(row.url)
          url.searchParams.delete('srsltid')
          const key = canonicalizeUrl(url.href)
          if (hits.has(key) || hits.size >= query.max) continue
          const hit: Hit = { ...row, url: key, provider: 'google', mediaType: 'web', raw: row }
          hits.set(key, hit)
          added.push(hit)
        }
        yield* ctx.addHits(added)
        start = result.nextStart
      }
    })
  },
}
