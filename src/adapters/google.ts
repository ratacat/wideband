import { search, SearchError } from '../google-search.mjs'
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
  async search(query, ctx) {
    const hits = new Map<string, Hit>()
    let start: number | null = 0
    try {
      for (let page = 0; page < (query.googlePages ?? 1) && start !== null && hits.size < query.max; page++) {
        ctx.signal.throwIfAborted()
        const result = await search(query.q, start, { signal: ctx.signal })
        for (const row of result.results) {
          const url = new URL(row.url)
          url.searchParams.delete('srsltid')
          const key = canonicalizeUrl(url.href)
          if (!hits.has(key)) hits.set(key, { ...row, url: key, provider: 'google', mediaType: 'web', raw: row })
        }
        start = result.nextStart
      }
      return { hits: [...hits.values()].slice(0, query.max) }
    } catch (error) {
      if (ctx.signal.aborted) throw new AdapterError('timeout', 'Google search timed out')
      if (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)) throw new AdapterError('timeout', 'Google page request timed out')
      if (error instanceof SearchError) throw new AdapterError('provider_error', `Google ${error.code}: ${error.message}`)
      throw new AdapterError('provider_error', 'Google search failed; check uv, Python, and proxy inventory')
    }
  },
}
