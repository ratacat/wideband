import { describe, expect, test } from 'bun:test'
import { AdapterError, Engine, Ledger, WidebandError, type ProviderAdapter, type UnifiedQuery } from '../src/index'

function adapter(
  name: string,
  search: ProviderAdapter['search'],
  costModel: ProviderAdapter['costModel'] = { kind: 'metered', perRequestUSD: 0.005 },
): ProviderAdapter {
  return {
    name,
    envKey: `${name.toUpperCase()}_API_KEY`,
    capabilities: {
      mediaTypes: ['web'],
      freshness: false,
      domainFilters: false,
      fullContent: true,
      maxPerRequest: 10,
    },
    costModel,
    search,
  }
}

function engine(adapters: ProviderAdapter[], keys: Record<string, string> = {}) {
  const ledger = new Ledger(':memory:')
  return {
    ledger,
    engine: new Engine(adapters, ledger, { getKey: (envKey) => keys[envKey] }),
  }
}

describe('Engine', () => {
  test('merges sources across providers and tolerates partial failure', async () => {
    const a = adapter('a', async () => ({
      hits: [{ provider: 'a', rank: 1, url: 'https://example.com/a', title: 'A', mediaType: 'web' }],
    }))
    const b = adapter('b', async () => ({
      hits: [{ provider: 'b', rank: 1, url: 'http://www.example.com/a?utm_source=x', title: 'B title', mediaType: 'web' }],
    }))
    const c = adapter('c', async () => {
      throw new AdapterError('provider_error', 'broken')
    })
    const ctx = engine([a, b, c], { A_API_KEY: 'k', B_API_KEY: 'k', C_API_KEY: 'k' })

    const result = await ctx.engine.sweep({ q: 'x' } as UnifiedQuery)
    expect(result.sources).toHaveLength(1)
    expect(result.sources[0]!.providers).toEqual(['a', 'b'])
    expect(result.stats.providers.a?.uniqueContributed).toBe(0)
    expect(result.stats.providers.b?.uniqueContributed).toBe(0)
    expect(result.stats.providers.c?.status).toBe('error')
    expect(result.stats.providers.c?.error?.code).toBe('provider_error')
    ctx.ledger.close()
  })

  test('records timeout failures without throwing the sweep', async () => {
    const slow = adapter(
      'slow',
      (_q, ctx) =>
        new Promise((_resolve, reject) => {
          ctx.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        }),
    )
    const ctx = engine([slow], { SLOW_API_KEY: 'k' })

    const result = await ctx.engine.sweep({ q: 'x' } as UnifiedQuery, { timeoutMs: 5 })
    expect(result.sources).toHaveLength(0)
    expect(result.stats.providers.slow?.status).toBe('timeout')
    ctx.ledger.close()
  })

  test('skips by budget and throws when budget excludes every runnable provider', async () => {
    const a = adapter('a', async () => ({ hits: [] }), { kind: 'metered', perRequestUSD: 0.01 })
    const b = adapter('b', async () => ({ hits: [] }), { kind: 'metered', perRequestUSD: 0.02 })
    const ctx = engine([a, b], { A_API_KEY: 'k', B_API_KEY: 'k' })

    const result = await ctx.engine.sweep({ q: 'x' } as UnifiedQuery, { budget: 0.015 })
    expect(result.stats.providers.a?.status).toBe('ok')
    expect(result.stats.providers.b?.status).toBe('skipped:budget')

    await expect(ctx.engine.sweep({ q: 'x fresh' } as UnifiedQuery, { budget: 0.001 })).rejects.toMatchObject({
      code: 'BUDGET_TOO_LOW',
      exitCode: 4,
    } satisfies Partial<WidebandError>)
    ctx.ledger.close()
  })

  test('runs providers without native freshness and post-filters dated hits', async () => {
    const limited = adapter('limited', async () => ({
      hits: [
        { provider: 'limited', rank: 1, url: 'https://example.com/recent', title: 'Recent', publishedAt: '2026-06-12T02:00:00.000Z', mediaType: 'web' },
        { provider: 'limited', rank: 2, url: 'https://example.com/stale', title: 'Stale', publishedAt: '2026-06-11T23:00:00.000Z', mediaType: 'web' },
        { provider: 'limited', rank: 3, url: 'https://example.com/unknown', title: 'Unknown', mediaType: 'web' },
      ],
    }))
    const ctx = engine([limited], { LIMITED_API_KEY: 'k' })

    const result = await ctx.engine.sweep({
      q: 'filtered',
      freshness: { after: '2026-06-12T01:28:00.000Z' },
    } as UnifiedQuery)

    expect(result.stats.providers.limited?.status).toBe('ok')
    expect(result.stats.providers.limited?.freshness).toMatchObject({
      support: 'post-filter',
      policy: 'balanced',
      kept: 2,
      keptUndated: 1,
      droppedStale: 1,
      droppedUndated: 0,
    })
    expect(result.sources.find((source) => source.url === 'https://example.com/recent')?.freshness?.confidence).toBe('verified')
    expect(result.sources.find((source) => source.url === 'https://example.com/unknown')?.freshness?.confidence).toBe('undated')
    expect(result.sources.map((source) => source.url)).toEqual(['https://example.com/recent', 'https://example.com/unknown'])
    ctx.ledger.close()
  })

  test('strict freshness drops undated hits from providers without native freshness', async () => {
    const limited = adapter('limited', async () => ({
      hits: [
        { provider: 'limited', rank: 1, url: 'https://example.com/recent', title: 'Recent', publishedAt: '2026-06-12T02:00:00.000Z', mediaType: 'web' },
        { provider: 'limited', rank: 2, url: 'https://example.com/stale', title: 'Stale', publishedAt: '2026-06-11T23:00:00.000Z', mediaType: 'web' },
        { provider: 'limited', rank: 3, url: 'https://example.com/unknown', title: 'Unknown', mediaType: 'web' },
      ],
    }))
    const native = {
      ...adapter('native', async () => ({
        hits: [{ provider: 'native', rank: 1, url: 'https://example.com/native-unknown', title: 'Native unknown', mediaType: 'web' }],
      })),
      capabilities: {
        mediaTypes: ['web'],
        freshness: true,
        domainFilters: false,
        fullContent: true,
        maxPerRequest: 10,
      },
    } satisfies ProviderAdapter
    const ctx = engine([limited, native], { LIMITED_API_KEY: 'k', NATIVE_API_KEY: 'k' })

    const result = await ctx.engine.sweep({
      q: 'strict freshness',
      freshness: { after: '2026-06-12T01:28:00.000Z' },
      freshnessPolicy: 'strict',
    } as UnifiedQuery)

    expect(result.sources.map((source) => source.url).sort()).toEqual([
      'https://example.com/native-unknown',
      'https://example.com/recent',
    ])
    expect(result.stats.providers.limited?.freshness).toMatchObject({
      support: 'post-filter',
      policy: 'strict',
      kept: 1,
      keptUndated: 0,
      droppedStale: 1,
      droppedUndated: 1,
    })
    expect(result.stats.providers.native?.freshness).toMatchObject({
      support: 'native',
      policy: 'strict',
      kept: 1,
      keptUndated: 1,
      droppedStale: 0,
      droppedUndated: 0,
    })
    expect(result.sources.find((source) => source.url === 'https://example.com/native-unknown')?.freshness?.confidence).toBe('native')
    ctx.ledger.close()
  })

  test('recall freshness keeps stale hits with stale labels', async () => {
    const limited = adapter('limited', async () => ({
      hits: [
        { provider: 'limited', rank: 1, url: 'https://example.com/stale', title: 'Stale', publishedAt: '2026-06-11T23:00:00.000Z', mediaType: 'web' },
        { provider: 'limited', rank: 2, url: 'https://example.com/unknown', title: 'Unknown', mediaType: 'web' },
      ],
    }))
    const ctx = engine([limited], { LIMITED_API_KEY: 'k' })

    const result = await ctx.engine.sweep({
      q: 'recall freshness',
      freshness: { after: '2026-06-12T01:28:00.000Z' },
      freshnessPolicy: 'recall',
    } as UnifiedQuery)

    expect(result.sources.map((source) => source.url)).toEqual(['https://example.com/stale', 'https://example.com/unknown'])
    expect(result.sources.find((source) => source.url === 'https://example.com/stale')?.freshness?.confidence).toBe('stale')
    expect(result.sources.find((source) => source.url === 'https://example.com/unknown')?.freshness?.confidence).toBe('undated')
    expect(result.stats.providers.limited?.freshness).toMatchObject({
      support: 'post-filter',
      policy: 'recall',
      kept: 2,
      keptUndated: 1,
      keptStale: 1,
      droppedStale: 0,
      droppedUndated: 0,
    })
    ctx.ledger.close()
  })

  test('skips providers that cannot honor domain filters', async () => {
    const limited = adapter('limited', async () => ({ hits: [] }))
    const capable: ProviderAdapter = {
      ...adapter('capable', async () => ({
        hits: [{ provider: 'capable', rank: 1, url: 'https://example.com/a', title: 'A', mediaType: 'web' }],
      })),
      capabilities: {
        mediaTypes: ['web'],
        freshness: true,
        domainFilters: true,
        fullContent: true,
        maxPerRequest: 10,
      },
    }
    const ctx = engine([limited, capable], { LIMITED_API_KEY: 'k', CAPABLE_API_KEY: 'k' })

    const result = await ctx.engine.sweep({
      q: 'filtered',
      domains: { include: ['example.com'] },
    } as UnifiedQuery)
    expect(result.stats.providers.limited?.status).toBe('skipped:capability')
    expect(result.stats.providers.capable?.status).toBe('ok')
    expect(result.sources).toHaveLength(1)
    ctx.ledger.close()
  })

  test('drops parseably stale hits from freshness queries', async () => {
    const fresh = {
      ...adapter('fresh', async () => ({
        hits: [
          { provider: 'fresh', rank: 1, url: 'https://example.com/recent', title: 'Recent', publishedAt: '2026-06-12T02:00:00.000Z', mediaType: 'web' },
          { provider: 'fresh', rank: 2, url: 'https://example.com/stale', title: 'Stale', publishedAt: '2026-06-11T23:00:00.000Z', mediaType: 'web' },
          { provider: 'fresh', rank: 3, url: 'https://example.com/date-only', title: 'Date only', publishedAt: '2026-06-12', mediaType: 'web' },
          { provider: 'fresh', rank: 4, url: 'https://example.com/unknown', title: 'Unknown', mediaType: 'web' },
        ],
      })),
      capabilities: {
        mediaTypes: ['web'],
        freshness: true,
        domainFilters: false,
        fullContent: true,
        maxPerRequest: 10,
      },
    } satisfies ProviderAdapter
    const ctx = engine([fresh], { FRESH_API_KEY: 'k' })

    const result = await ctx.engine.sweep({
      q: 'freshness',
      freshness: { after: '2026-06-12T01:28:00.000Z' },
    } as UnifiedQuery)

    expect(result.sources.map((source) => source.url)).toEqual([
      'https://example.com/recent',
      'https://example.com/date-only',
      'https://example.com/unknown',
    ])
    ctx.ledger.close()
  })

  test('uses cache hits at zero cost without another provider call', async () => {
    let calls = 0
    const a = adapter('a', async () => {
      calls += 1
      return { hits: [{ provider: 'a', rank: 1, url: 'https://example.com/a', title: 'A', mediaType: 'web' }] }
    })
    const ctx = engine([a], { A_API_KEY: 'k' })

    const first = await ctx.engine.sweep({ q: 'cache me' } as UnifiedQuery)
    const second = await ctx.engine.sweep({ q: 'cache me' } as UnifiedQuery)
    expect(first.cached).toBeUndefined()
    expect(second.cached).toBe(true)
    expect(second.cost.totalUSD).toBe(0)
    expect(second.cost.byProvider).toEqual({})
    expect(calls).toBe(1)
    ctx.ledger.close()
  })

  test('retains raw payloads only when capture is enabled', async () => {
    const a = adapter('a', async () => ({
      hits: [
        {
          provider: 'a',
          rank: 1,
          url: 'https://example.com/a',
          title: 'A',
          mediaType: 'web',
          raw: { providerField: true },
        },
      ],
    }))
    const ctx = engine([a], { A_API_KEY: 'k' })

    const stripped = await ctx.engine.sweep({ q: 'capture stripped' } as UnifiedQuery)
    const captured = await ctx.engine.sweep({ q: 'capture kept' } as UnifiedQuery, { capture: true })
    expect(stripped.sources[0]?.raw).toBeUndefined()
    expect(captured.sources[0]?.raw).toEqual({ a: [{ providerField: true }] })
    ctx.ledger.close()
  })

  test('separates captured and stripped cache entries', async () => {
    let calls = 0
    const a = adapter('a', async () => {
      calls += 1
      return {
        hits: [
          {
            provider: 'a',
            rank: 1,
            url: 'https://example.com/cache-capture',
            title: 'A',
            mediaType: 'web',
            raw: { call: calls },
          },
        ],
      }
    })
    const ctx = engine([a], { A_API_KEY: 'k' })

    const captured = await ctx.engine.sweep({ q: 'cache capture split' } as UnifiedQuery, { capture: true })
    const stripped = await ctx.engine.sweep({ q: 'cache capture split' } as UnifiedQuery)
    const capturedAgain = await ctx.engine.sweep({ q: 'cache capture split' } as UnifiedQuery, { capture: true })

    expect(captured.sources[0]?.raw).toEqual({ a: [{ call: 1 }] })
    expect(stripped.sources[0]?.raw).toBeUndefined()
    expect(capturedAgain.cached).toBe(true)
    expect(calls).toBe(2)
    ctx.ledger.close()
  })

  test('suppresses already-seen sources by session after cache lookup', async () => {
    const a = adapter('a', async () => ({
      hits: [{ provider: 'a', rank: 1, url: 'https://example.com/a', title: 'A', mediaType: 'web' }],
    }))
    const ctx = engine([a], { A_API_KEY: 'k' })

    const first = await ctx.engine.sweep({ q: 'session' } as UnifiedQuery, { session: 's1' })
    const second = await ctx.engine.sweep({ q: 'session' } as UnifiedQuery, { session: 's1' })
    expect(first.sources).toHaveLength(1)
    expect(second.sources).toHaveLength(0)
    expect(second.stats.suppressedBySession).toBe(1)
    ctx.ledger.close()
  })

  test('retries once on rate limit', async () => {
    let calls = 0
    const a = adapter('a', async () => {
      calls += 1
      if (calls === 1) throw new AdapterError('rate_limit', 'try again', 429)
      return { hits: [{ provider: 'a', rank: 1, url: 'https://example.com/a', title: 'A', mediaType: 'web' }] }
    })
    const ctx = engine([a], { A_API_KEY: 'k' })

    const result = await ctx.engine.sweep({ q: 'retry' } as UnifiedQuery)
    expect(result.sources).toHaveLength(1)
    expect(calls).toBe(2)
    ctx.ledger.close()
  })

  test('bounds retry delay by the provider timeout', async () => {
    let calls = 0
    const a = adapter('a', async () => {
      calls += 1
      throw new AdapterError('rate_limit', 'try again', 429)
    })
    const ctx = engine([a], { A_API_KEY: 'k' })

    const result = await ctx.engine.sweep({ q: 'retry deadline' } as UnifiedQuery, { timeoutMs: 5 })
    expect(calls).toBe(1)
    expect(result.stats.providers.a?.status).toBe('timeout')
    ctx.ledger.close()
  })
})
