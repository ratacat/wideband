import type { CostBasis, CostModel } from './types'

/** Pre-call estimate; adapters override with provider-reported cost when available. */
export function estimateUSD(model: CostModel): { usd: number; basis: CostBasis } {
  switch (model.kind) {
    case 'metered':
      return { usd: model.perRequestUSD, basis: 'metered' }
    case 'subscription':
      return { usd: model.monthlyUSD / model.includedRequests, basis: 'amortized' }
    case 'free':
      return { usd: 0, basis: 'free' }
  }
}

export function monthlyQuota(model: CostModel): number | null {
  switch (model.kind) {
    case 'metered':
      return null
    case 'subscription':
      return model.includedRequests
    case 'free':
      return model.monthlyQuota ?? null
  }
}

export function roundUSD(n: number): number {
  return Math.round(n * 1e6) / 1e6
}
