import { ADAPTERS } from './adapters/registry'
import { Engine } from './core/engine'
import { Ledger } from './core/ledger'
import { UnifiedQuery, type SweepOptions } from './core/types'

export type WidebandOptions = { db?: string }

function parseModeQuery(input: string | unknown, mode: 'scan' | 'research') {
  if (typeof input === 'string') return UnifiedQuery.parse({ q: input, mode })
  if (input !== null && typeof input === 'object') return UnifiedQuery.parse({ ...(input as Record<string, unknown>), mode })
  return UnifiedQuery.parse(input)
}

export function wideband(opts: WidebandOptions = {}) {
  const ledger = new Ledger(opts.db)
  const engine = new Engine(ADAPTERS, ledger)
  return {
    engine,
    ledger,
    sweep(input: string | unknown, sweepOptions: SweepOptions = {}) {
      const query = typeof input === 'string' ? UnifiedQuery.parse({ q: input }) : UnifiedQuery.parse(input)
      return engine.sweep(query, sweepOptions)
    },
    scan(input: string | unknown, sweepOptions: SweepOptions = {}) {
      const query = parseModeQuery(input, 'scan')
      return engine.sweep(query, sweepOptions)
    },
    research(input: string | unknown, sweepOptions: SweepOptions = {}) {
      const query = parseModeQuery(input, 'research')
      return engine.sweep(query, sweepOptions)
    },
    providers: () => engine.providerInfo(),
    stats: (days?: number) => ledger.stats(days),
    costs: () => ledger.monthToDate(),
    close: () => ledger.close(),
  }
}

export { ADAPTERS, getAdapter } from './adapters/registry'
export { Engine } from './core/engine'
export { Ledger } from './core/ledger'
export { AdapterError, WidebandError } from './core/errors'
export { canonicalizeUrl, mergeHits, sha256, sourceId, stableStringify } from './core/merge'
export { estimateUSD, monthlyQuota, roundUSD } from './core/cost'
export {
  CostBasis,
  FreshnessConfidence,
  FreshnessPolicy,
  MediaType,
  ProviderCallStats,
  ProviderFreshnessStats,
  Provenance,
  Source,
  SweepResult,
  UnifiedQuery,
  type AdapterCtx,
  type AdapterResult,
  type Capabilities,
  type CostModel,
  type FreshnessConfidence as FreshnessConfidenceType,
  type FreshnessPolicy as FreshnessPolicyType,
  type Hit,
  type ProviderAdapter,
  type ProviderFreshnessStats as ProviderFreshnessStatsType,
  type SweepOptions,
} from './core/types'
