import { randomUUID } from 'node:crypto'
import { AdapterError } from './errors'
import { estimateUSD, monthlyQuota, roundUSD } from './cost'
import { mergeHits, sha256, stableStringify } from './merge'
import { Ledger } from './ledger'
import { classifyFreshness } from './freshness'
import {
  FreshnessPolicy,
  ProviderCallStats,
  ProviderFreshnessStats,
  SweepResult,
  UnifiedQuery,
  type CostBasis,
  type FreshnessConfidence,
  type Hit,
  type ProviderAdapter,
  type SweepOptions,
} from './types'
import { WidebandError } from './errors'

type EngineOptions = {
  getKey?: (envKey: string) => string | undefined
}

type ProviderInfo = {
  name: string
  configured: boolean
  keyPresent: boolean
  envKey: string
  costModel: ProviderAdapter['costModel']
  capabilities: ProviderAdapter['capabilities']
  month: { calls: number; usd: number }
  quota?: { limit: number; used: number }
}

type CallOutcome =
  | { ok: true; provider: string; hits: Hit[]; reportedUSD?: number; latencyMs: number }
  | { ok: false; provider: string; error: AdapterError; latencyMs: number }

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRetryable(error: AdapterError) {
  return error.code === 'rate_limit' || (typeof error.httpStatus === 'number' && error.httpStatus >= 500)
}

function toAdapterError(error: unknown, aborted: boolean): AdapterError {
  if (error instanceof AdapterError) return error
  if (aborted || (error instanceof Error && error.name === 'AbortError')) {
    return new AdapterError('timeout', 'Provider request timed out')
  }
  return new AdapterError('provider_error', error instanceof Error ? error.message : 'Provider request failed')
}

function providerStatus(error: AdapterError): ProviderCallStats['status'] {
  return error.code === 'timeout' ? 'timeout' : 'error'
}

function hasDomainFilters(query: UnifiedQuery): boolean {
  return Boolean(query.domains?.include?.length || query.domains?.exclude?.length)
}

function lacksCapability(adapter: ProviderAdapter, query: UnifiedQuery): boolean {
  if (!adapter.capabilities.mediaTypes.includes(query.mediaType)) return true
  if (hasDomainFilters(query) && !adapter.capabilities.domainFilters) return true
  return false
}

function roundScore(n: number): number {
  return Math.round(n * 1e9) / 1e9
}

function timeoutOutcome(provider: string, started: number): CallOutcome {
  return {
    ok: false,
    provider,
    error: new AdapterError('timeout', 'Provider request timed out'),
    latencyMs: Date.now() - started,
  }
}

type FreshnessDecision = {
  keep: boolean
  confidence?: FreshnessConfidence
  classification?: 'within' | 'stale' | 'undated'
  dropped?: 'stale' | 'undated'
}

function decideFreshness(hit: Hit, adapter: ProviderAdapter, query: UnifiedQuery): FreshnessDecision {
  if (!query.freshness) return { keep: true }

  const classification = classifyFreshness(hit.publishedAt, query.freshness)
  if (classification === 'within') {
    return { keep: true, confidence: adapter.capabilities.freshness ? 'native' : 'verified', classification }
  }

  if (classification === 'undated') {
    if (adapter.capabilities.freshness) return { keep: true, confidence: 'native', classification }
    if (query.freshnessPolicy === 'strict') return { keep: false, dropped: 'undated' }
    return { keep: true, confidence: 'undated', classification }
  }

  if (classification === 'stale') {
    if (query.freshnessPolicy === 'recall') return { keep: true, confidence: 'stale', classification }
    return { keep: false, dropped: 'stale' }
  }

  return { keep: true }
}

function emptyFreshnessStats(adapter: ProviderAdapter, policy: FreshnessPolicy): ProviderFreshnessStats {
  return {
    support: adapter.capabilities.freshness ? 'native' : 'post-filter',
    policy,
    kept: 0,
    keptUndated: 0,
    keptStale: 0,
    droppedStale: 0,
    droppedUndated: 0,
  }
}

export class Engine {
  private getKey: (envKey: string) => string | undefined

  constructor(
    readonly adapters: ProviderAdapter[],
    readonly ledger: Ledger,
    opts: EngineOptions = {},
  ) {
    this.getKey = opts.getKey ?? ((envKey) => process.env[envKey] || undefined)
  }

  async sweep(queryInput: UnifiedQuery, opts: SweepOptions = {}, kind: 'sweep' | 'doctor' = 'sweep'): Promise<SweepResult> {
    const query = UnifiedQuery.parse(queryInput)
    const started = Date.now()
    const selected = this.selectAdapters(opts.providers)
    const providerStats: Record<string, ProviderCallStats> = {}
    const runnable: { adapter: ProviderAdapter; key: string }[] = []

    for (const adapter of selected) {
      if (lacksCapability(adapter, query)) {
        providerStats[adapter.name] = { status: 'skipped:capability', hits: 0, uniqueContributed: 0, latencyMs: 0 }
        continue
      }
      const key = this.getKey(adapter.envKey)
      if (!key) {
        providerStats[adapter.name] = { status: 'skipped:nokey', hits: 0, uniqueContributed: 0, latencyMs: 0 }
        continue
      }
      runnable.push({ adapter, key })
    }

    if (runnable.length === 0) {
      throw new WidebandError('NO_PROVIDERS', 'No providers can run this query', ['set provider API keys', 'run: wideband providers'], 3)
    }

    const included = this.applyBudget(runnable, opts.budget, providerStats)
    if (included.length === 0) {
      throw new WidebandError('BUDGET_TOO_LOW', 'Budget excludes all runnable providers', ['increase --budget'], 4)
    }

    const includedNames = included.map((x) => x.adapter.name).sort()
    const cacheHash = sha256(stableStringify({ query, providers: includedNames, capture: Boolean(opts.capture) }))
    const ttlSec = opts.ttlSec ?? Number(process.env.WIDEBAND_CACHE_TTL ?? 900)
    if (!opts.fresh && kind === 'sweep') {
      const cached = this.ledger.cacheGet(cacheHash, Number.isFinite(ttlSec) ? ttlSec : 900)
      if (cached) {
        const result: SweepResult = {
          ...cached,
          cached: true,
          cost: { totalUSD: 0, byProvider: {} },
        }
        return this.applySession(result, opts.session)
      }
    }

    const outcomes = await Promise.all(
      included.map(({ adapter, key }) => this.callAdapter(adapter, key, query, opts.timeoutMs ?? 10_000)),
    )

    const allHits: Hit[] = []
    const byProviderCost: SweepResult['cost']['byProvider'] = {}
    for (const outcome of outcomes) {
      if (!outcome.ok) {
        providerStats[outcome.provider] = {
          status: providerStatus(outcome.error),
          hits: 0,
          uniqueContributed: 0,
          latencyMs: outcome.latencyMs,
          error: { code: outcome.error.code, message: outcome.error.message },
        }
        continue
      }

      const adapter = included.find((x) => x.adapter.name === outcome.provider)?.adapter
      const freshnessStats = query.freshness && adapter ? emptyFreshnessStats(adapter, query.freshnessPolicy) : undefined
      const hits: Hit[] = []
      if (adapter) {
        for (const hit of outcome.hits) {
          const decision = decideFreshness(hit, adapter, query)
          if (!decision.keep) {
            if (freshnessStats && decision.dropped === 'stale') freshnessStats.droppedStale += 1
            if (freshnessStats && decision.dropped === 'undated') freshnessStats.droppedUndated += 1
            continue
          }
          const annotated = decision.confidence ? { ...hit, freshness: { confidence: decision.confidence } } : hit
          hits.push(opts.capture ? annotated : stripRaw(annotated))
          if (freshnessStats) {
            freshnessStats.kept += 1
            if (decision.classification === 'undated') freshnessStats.keptUndated += 1
            if (decision.classification === 'stale') freshnessStats.keptStale += 1
          }
          if (hits.length >= query.max) break
        }
      }
      allHits.push(...hits)
      const estimate = adapter ? estimateUSD(adapter.costModel) : { usd: 0, basis: 'metered' as CostBasis }
      const cost =
        typeof outcome.reportedUSD === 'number'
          ? { usd: roundUSD(outcome.reportedUSD), basis: 'reported' as CostBasis }
          : { usd: roundUSD(estimate.usd), basis: estimate.basis }
      byProviderCost[outcome.provider] = cost
      providerStats[outcome.provider] = {
        status: 'ok',
        hits: hits.length,
        uniqueContributed: 0,
        latencyMs: outcome.latencyMs,
        ...(freshnessStats ? { freshness: freshnessStats } : {}),
      }
    }

    const sources = mergeHits(allHits).map((source) => ({ ...source, score: roundScore(source.score) }))
    for (const [provider, stats] of Object.entries(providerStats)) {
      if (stats.status === 'ok') {
        stats.uniqueContributed = sources.filter((source) => source.uniqueTo === provider).length
      }
    }

    const totalHits = allHits.length
    const totalUSD = roundUSD(Object.values(byProviderCost).reduce((sum, x) => sum + x.usd, 0))
    const result: SweepResult = {
      sweepId: `sw_${randomUUID().slice(0, 12)}`,
      query,
      sources,
      stats: {
        totalHits,
        uniqueSources: sources.length,
        overlapPct: totalHits === 0 ? 0 : roundScore(1 - sources.length / totalHits),
        providers: providerStats,
      },
      cost: {
        totalUSD,
        byProvider: byProviderCost,
      },
      timing: { totalMs: Date.now() - started },
    }

    this.ledger.recordSweep(result, kind)
    if (kind === 'sweep') this.ledger.cachePut(cacheHash, result)
    return this.applySession(result, opts.session)
  }

  providerInfo(): ProviderInfo[] {
    const mtd = this.ledger.monthToDate()
    return this.adapters.map((adapter) => {
      const keyPresent = Boolean(this.getKey(adapter.envKey))
      const month = mtd.providers[adapter.name] ?? { calls: 0, usd: 0 }
      const quotaLimit = monthlyQuota(adapter.costModel)
      return {
        name: adapter.name,
        configured: keyPresent,
        keyPresent,
        envKey: adapter.envKey,
        costModel: adapter.costModel,
        capabilities: adapter.capabilities,
        month,
        ...(quotaLimit === null ? {} : { quota: { limit: quotaLimit, used: month.calls } }),
      }
    })
  }

  private selectAdapters(names?: string[]): ProviderAdapter[] {
    if (!names?.length) return this.adapters
    const requested = [...new Set(names.map((name) => name.toLowerCase()))]
    const known = new Set(this.adapters.map((adapter) => adapter.name))
    const unknown = requested.filter((name) => !known.has(name))
    if (unknown.length) {
      throw new WidebandError('UNKNOWN_PROVIDER', `Unknown provider: ${unknown.join(', ')}`, ['run: wideband providers'], 2)
    }
    return this.adapters.filter((adapter) => requested.includes(adapter.name))
  }

  private applyBudget(
    runnable: { adapter: ProviderAdapter; key: string }[],
    budget: number | undefined,
    providerStats: Record<string, ProviderCallStats>,
  ) {
    if (budget === undefined) return runnable
    let spent = 0
    const included: { adapter: ProviderAdapter; key: string }[] = []
    const cheapestFirst = [...runnable].sort((a, b) => estimateUSD(a.adapter.costModel).usd - estimateUSD(b.adapter.costModel).usd)
    for (const item of cheapestFirst) {
      const estimate = estimateUSD(item.adapter.costModel).usd
      if (spent + estimate <= budget) {
        spent += estimate
        included.push(item)
      } else {
        providerStats[item.adapter.name] = { status: 'skipped:budget', hits: 0, uniqueContributed: 0, latencyMs: 0 }
      }
    }
    return included
  }

  private async callAdapter(adapter: ProviderAdapter, key: string, query: UnifiedQuery, timeoutMs: number): Promise<CallOutcome> {
    const started = Date.now()
    const deadline = started + timeoutMs
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) return timeoutOutcome(adapter.name, started)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), remainingMs)
      try {
        const result = await adapter.search(query, { signal: controller.signal, key })
        clearTimeout(timer)
        return {
          ok: true,
          provider: adapter.name,
          hits: result.hits,
          ...(typeof result.reportedUSD === 'number' ? { reportedUSD: result.reportedUSD } : {}),
          latencyMs: Date.now() - started,
        }
      } catch (error) {
        clearTimeout(timer)
        const adapterError = toAdapterError(error, controller.signal.aborted)
        if (attempt === 0 && isRetryable(adapterError)) {
          const retryDelayMs = 300 + Math.floor(Math.random() * 501)
          const remainingAfterAttemptMs = deadline - Date.now()
          if (remainingAfterAttemptMs <= 0) return timeoutOutcome(adapter.name, started)
          await sleep(Math.min(retryDelayMs, remainingAfterAttemptMs))
          continue
        }
        return { ok: false, provider: adapter.name, error: adapterError, latencyMs: Date.now() - started }
      }
    }
    return {
      ok: false,
      provider: adapter.name,
      error: new AdapterError('provider_error', 'Provider request failed'),
      latencyMs: Date.now() - started,
    }
  }

  private applySession(result: SweepResult, session?: string): SweepResult {
    if (!session) return result
    const sourceIds = result.sources.map((source) => source.id)
    const seen = this.ledger.seenIds(session, sourceIds)
    const sources = result.sources.filter((source) => !seen.has(source.id))
    this.ledger.markSeen(
      session,
      sources.map((source) => source.id),
    )
    const suppressed = result.sources.length - sources.length
    return {
      ...result,
      sources,
      stats: {
        ...result.stats,
        uniqueSources: sources.length,
        overlapPct: result.stats.totalHits === 0 ? 0 : roundScore(1 - sources.length / result.stats.totalHits),
        suppressedBySession: suppressed,
      },
    }
  }
}

function stripRaw(hit: Hit): Hit {
  const { raw: _raw, ...rest } = hit
  return rest
}
