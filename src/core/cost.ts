import type { Charge, CostBasis, CostModel, ProviderCost } from './types'

export function estimateUSD(model: CostModel): {
  usd: number
  basis: 'metered' | 'amortized' | 'free'
} {
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

export function toMicroUSD(usd: number): number {
  const amount = Math.ceil(usd * 1e6 - 1e-8)
  if (!Number.isSafeInteger(amount) || amount < 0)
    throw new RangeError('Cost must be finite, nonnegative, and within the supported range')
  return amount
}

export function roundUSD(n: number): number {
  return Math.round(n * 1e6) / 1e6
}
export function chargeMicroUSD(charge: Charge): number {
  return charge.kind === 'unknown' ? charge.estimateMicroUSD : charge.microUSD
}

export function summarizeCharges(charges: readonly Charge[]): ProviderCost {
  let total = 0
  let observed = 0
  let estimated = 0
  let unknownAttempts = 0
  const bases = new Set<CostBasis>()
  for (const charge of charges) {
    total += chargeMicroUSD(charge)
    if (charge.kind === 'observed') {
      observed += charge.microUSD
      bases.add('reported')
    } else if (charge.kind === 'estimated') {
      estimated += charge.microUSD
      bases.add(charge.basis)
    } else {
      unknownAttempts += 1
      bases.add('unknown')
    }
  }
  const basis = bases.size > 1 ? 'mixed' : (bases.values().next().value ?? 'free')
  return {
    usd: total / 1e6,
    basis,
    observedUSD: observed / 1e6,
    estimatedUSD: estimated / 1e6,
    unknownAttempts,
    attempts: charges.length,
  }
}
