import { describe, expect, test } from 'bun:test'
import { estimateUSD, monthlyQuota, roundUSD } from '../src/core/cost'

describe('cost models', () => {
  test('estimates metered, subscription, and free providers', () => {
    expect(estimateUSD({ kind: 'metered', perRequestUSD: 0.005 })).toEqual({ usd: 0.005, basis: 'metered' })
    expect(estimateUSD({ kind: 'subscription', monthlyUSD: 20, includedRequests: 1000 })).toEqual({
      usd: 0.02,
      basis: 'amortized',
    })
    expect(estimateUSD({ kind: 'free', monthlyQuota: 2000 })).toEqual({ usd: 0, basis: 'free' })
  })

  test('reports monthly quotas when available', () => {
    expect(monthlyQuota({ kind: 'metered', perRequestUSD: 0.005 })).toBeNull()
    expect(monthlyQuota({ kind: 'subscription', monthlyUSD: 20, includedRequests: 1000 })).toBe(1000)
    expect(monthlyQuota({ kind: 'free', monthlyQuota: 2000 })).toBe(2000)
    expect(monthlyQuota({ kind: 'free' })).toBeNull()
  })

  test('rounds USD to six decimals', () => {
    expect(roundUSD(0.12345678)).toBe(0.123457)
  })
})
