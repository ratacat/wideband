import { describe, expect, test } from 'bun:test'
import { Ledger } from '../src/core/ledger'
import { UnifiedQuery, type SweepResult } from '../src/core/types'

function sampleResult(id = 'sw_test'): SweepResult {
  return {
    sweepId: id,
    query: UnifiedQuery.parse({ q: 'test' }),
    sources: [
      {
        id: 'src1',
        url: 'https://example.com/a',
        title: 'A',
        snippet: '',
        mediaType: 'web',
        providers: ['exa'],
        provenance: [{ provider: 'exa', rank: 1 }],
        uniqueTo: 'exa',
        score: 0.1,
      },
    ],
    stats: {
      totalHits: 2,
      uniqueSources: 1,
      overlapPct: 0.5,
      providers: {
        exa: { status: 'ok', hits: 2, uniqueContributed: 1, latencyMs: 100 },
        brave: {
          status: 'error',
          hits: 0,
          uniqueContributed: 0,
          latencyMs: 50,
          error: { code: 'provider_error', message: 'failed' },
        },
      },
    },
    cost: {
      totalUSD: 0.01,
      byProvider: { exa: { usd: 0.01, basis: 'reported' } },
    },
    timing: { totalMs: 120 },
  }
}

describe('Ledger', () => {
  test('records sweep stats and excludes doctor calls from stats', () => {
    const ledger = new Ledger(':memory:')
    ledger.recordSweep(sampleResult('sw_1'), 'sweep')
    ledger.recordSweep(sampleResult('sw_2'), 'doctor')

    const stats = ledger.stats(30)
    expect(stats.exa).toEqual({
      calls: 1,
      errorRate: 0,
      hits: 2,
      uniqueContributed: 1,
      uniqueRate: 0.5,
      usd: 0.01,
      costPerUniqueSource: 0.01,
      latency: { p50: 100, p95: 100 },
    })
    expect(stats.brave?.errorRate).toBe(1)
    expect(stats.brave?.usd).toBe(0)

    const mtd = ledger.monthToDate()
    expect(mtd.providers.exa).toEqual({ calls: 2, usd: 0.02 })
    expect(mtd.providers.brave).toEqual({ calls: 2, usd: 0 })
    expect(mtd.totalUSD).toBe(0.02)
    ledger.close()
  })

  test('caches results with TTL expiry', () => {
    const ledger = new Ledger(':memory:')
    const result = sampleResult('sw_cache')
    ledger.cachePut('hash1', result)
    expect(ledger.cacheGet('hash1', 60)?.sweepId).toBe('sw_cache')
    expect(ledger.cacheGet('hash1', -1)).toBeNull()
    ledger.close()
  })

  test('tracks seen source IDs per session', () => {
    const ledger = new Ledger(':memory:')
    ledger.markSeen('session-a', ['src1', 'src2'])
    expect(ledger.seenIds('session-a', ['src1', 'src3'])).toEqual(new Set(['src1']))
    expect(ledger.seenIds('session-b', ['src1'])).toEqual(new Set())
    ledger.close()
  })
})
