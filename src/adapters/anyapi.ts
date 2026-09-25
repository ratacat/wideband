import type { Hit, ProviderAdapter } from '../core/types'
import { requestJSON } from './http'

type Row = { title?: string; link?: string; snippet?: string }
type Body = { costUsd?: number; output?: { data?: { results?: Row[]; nextCursor?: string | null } | null } }

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
  costModel: { kind: 'metered', perRequestUSD: 0.0004 },
  async search(q, ctx) {
    const hits = new Map<string, Hit>()
    let reportedUSD = 0
    for (let page = 1; page <= (q.googlePages ?? 1) && hits.size < q.max; page++) {
      const body = await requestJSON<Body>('https://api.getanyapi.com/v1/run/google.search', {
        method: 'POST',
        signal: ctx.signal,
        headers: { authorization: `Bearer ${ctx.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ query: q.q, page }),
      })
      reportedUSD += body.costUsd ?? 0
      const rows = body.output?.data?.results ?? []
      for (const row of rows) {
        if (!row.link || hits.has(row.link)) continue
        hits.set(row.link, {
          provider: 'anyapi',
          rank: hits.size + 1,
          url: row.link,
          ...(row.title ? { title: row.title } : {}),
          ...(row.snippet ? { snippet: row.snippet } : {}),
          mediaType: 'web',
          raw: row,
        })
      }
      if (!rows.length || !body.output?.data?.nextCursor) break
    }
    return { hits: [...hits.values()].slice(0, q.max), reportedUSD }
  },
}
