import { randomUUID } from 'node:crypto'
import { Cache, Cause, Effect, Exit, Result, Schedule, Semaphore } from 'effect'
import type { HttpClient } from 'effect/http'
import { AdapterError, LedgerError, safeErrorMessage, WidebandError } from './errors'
import {
  chargeMicroUSD,
  estimateUSD,
  monthlyQuota,
  roundUSD,
  summarizeCharges,
  toMicroUSD,
} from './cost'
import { mergeHits, sha256, stableStringify } from './merge'
import { Ledger } from './ledger'
import { classifyFreshness } from './freshness'
import {
  parseQuery,
  parseSweepOptions,
  type AdapterCtx,
  type AttemptFinish,
  type Charge,
  type DeepMutable,
  type FreshnessConfidence,
  type Hit,
  type ProviderAdapter,
  type ProviderCallStats,
  type ProviderFreshnessStats,
  type ProviderRequest,
  type SweepOptions,
  type SweepProviderEvent,
  type SweepResult,
  type UnifiedQuery,
} from './types'

type EngineOptions = { getKey?: (envKey: string) => string | undefined }
export type ProviderInfo = {
  name: string
  configured: boolean
  keyPresent: boolean
  envKey?: string
  costModel: ProviderAdapter['costModel']
  capabilities: ProviderAdapter['capabilities']
  month: { attempts: number; usd: number; unknownAttempts: number }
  quota?: { limit: number; used: number }
}
type EngineError = WidebandError | LedgerError
type Observer = (event: SweepProviderEvent) => void
type Flight = {
  key: string
  query: UnifiedQuery
  opts: SweepOptions
  kind: 'sweep' | 'doctor'
  providers: { adapter: ProviderAdapter; key: string }[]
  observers: Set<Observer>
  history: SweepProviderEvent[]
  users: number
}
type ProviderState = {
  adapter: ProviderAdapter
  key: string
  hits: Hit[]
  charges: Charge[]
  startedAt: number
  latencyMs: number
  status?: ProviderCallStats['status']
  error?: AdapterError
  freshness?: DeepMutable<ProviderFreshnessStats>
}
type EngineState = {
  adapters: readonly ProviderAdapter[]
  ledger: Ledger
  getKey: (envKey: string) => string | undefined
  flights: Map<string, Flight>
  pacing: Map<string, { gate: Semaphore.Semaphore; nextAt: number }>
}
type SweepState = {
  sweepId: string
  query: UnifiedQuery
  startedAt: number
  providers: ProviderState[]
  skipped: Record<string, ProviderCallStats>
  budgetMicroUSD?: number
  budgetUsedMicroUSD: number
}

function ledgerCall<A>(
  operation: string,
  run: () => A,
  attempt?: AttemptFinish,
): Effect.Effect<A, LedgerError> {
  return Effect.try({
    try: run,
    catch: (error) => new LedgerError(operation, safeErrorMessage(error), attempt),
  })
}

function clone<A>(value: A): A {
  return structuredClone(value)
}
function freeze<A>(value: A): A {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
function roundScore(value: number): number {
  return Math.round(value * 1e9) / 1e9
}
function stats(status: ProviderCallStats['status']): ProviderCallStats {
  return { status, hits: 0, uniqueContributed: 0, latencyMs: 0, attempts: 0 }
}

function lacksCapability(adapter: ProviderAdapter, query: UnifiedQuery): boolean {
  return (
    !adapter.capabilities.mediaTypes.includes(query.mediaType) ||
    Boolean(
      (query.domains?.include?.length || query.domains?.exclude?.length) &&
      !adapter.capabilities.domainFilters,
    )
  )
}

function annotateHit(hit: Hit, state: ProviderState, query: UnifiedQuery): Hit | undefined {
  if (!query.freshness) return hit
  const classification = classifyFreshness(hit.publishedAt, query.freshness)
  let confidence: FreshnessConfidence
  if (classification === 'within')
    confidence = state.adapter.capabilities.freshness ? 'native' : 'verified'
  else if (classification === 'undated') {
    if (state.adapter.capabilities.freshness) confidence = 'native'
    else if (query.freshnessPolicy === 'strict') {
      if (state.freshness) state.freshness.droppedUndated += 1
      return undefined
    } else confidence = 'undated'
  } else if (classification === 'stale') {
    if (query.freshnessPolicy !== 'recall') {
      if (state.freshness) state.freshness.droppedStale += 1
      return undefined
    }
    confidence = 'stale'
  } else return hit
  if (state.freshness) {
    state.freshness.kept += 1
    if (classification === 'undated') state.freshness.keptUndated += 1
    if (classification === 'stale') state.freshness.keptStale += 1
  }
  return { ...hit, freshness: { confidence } }
}

function buildResult(state: SweepState): SweepResult {
  const allHits = state.providers.flatMap((provider) => provider.hits)
  const sources = mergeHits(allHits).map((source) => ({
    ...source,
    score: roundScore(source.score),
  }))
  const providers: Record<string, ProviderCallStats> = { ...state.skipped }
  const byProvider: SweepResult['cost']['byProvider'] = Object.fromEntries(
    state.providers
      .filter((provider) => provider.charges.length > 0)
      .map((provider) => [provider.adapter.name, summarizeCharges(provider.charges)]),
  )
  for (const provider of state.providers) {
    providers[provider.adapter.name] = {
      status: provider.status ?? 'cancelled',
      hits: provider.hits.length,
      uniqueContributed: sources.filter((source) => source.uniqueTo === provider.adapter.name)
        .length,
      latencyMs: provider.latencyMs,
      attempts: provider.charges.length,
      ...(provider.freshness ? { freshness: provider.freshness } : {}),
      ...(provider.error
        ? {
            error: {
              code: provider.error.code,
              message: safeErrorMessage(provider.error, [provider.key]),
            },
          }
        : {}),
    }
  }
  const complete =
    state.providers.every((provider) => provider.status === 'ok') &&
    !Object.values(state.skipped).some((provider) => provider.status === 'skipped:budget')
  return {
    sweepId: state.sweepId,
    query: state.query,
    complete,
    sources,
    stats: {
      totalHits: allHits.length,
      uniqueSources: sources.length,
      overlapPct: allHits.length ? roundScore(1 - sources.length / allHits.length) : 0,
      providers,
    },
    cost: {
      totalUSD: roundUSD(Object.values(byProvider).reduce((sum, cost) => sum + cost.usd, 0)),
      unknownAttempts: Object.values(byProvider).reduce(
        (sum, cost) => sum + cost.unknownAttempts,
        0,
      ),
      byProvider,
    },
    timing: { totalMs: Date.now() - state.startedAt },
  }
}

function broadcast(flight: Flight, event: SweepProviderEvent) {
  const saved = freeze(clone(event))
  flight.history.push(saved)
  for (const observer of flight.observers) observer(clone(saved))
}

function executeRequest<A>(
  engine: EngineState,
  sweep: SweepState,
  provider: ProviderState,
  request: ProviderRequest<A>,
): Effect.Effect<A, AdapterError | LedgerError, HttpClient.HttpClient> {
  const model = estimateUSD(provider.adapter.costModel)
  const estimate = request.estimateMicroUSD ?? toMicroUSD(model.usd)
  if (!Number.isSafeInteger(estimate) || estimate < 0)
    return Effect.die(new RangeError('Request estimate must be a nonnegative integer'))
  const pacing = engine.pacing.get(provider.adapter.name)
  if (!pacing) return Effect.die(new Error('Provider pacing state is missing'))
  const attempt = pacing.gate.withPermit(
    Effect.gen(function* () {
      const ordinal = (yield* Schedule.CurrentMetadata).attempt + 1
      const wait = pacing.nextAt - Date.now()
      if (wait > 0) yield* Effect.sleep(wait)
      let finish: AttemptFinish | undefined
      const run = Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          if (
            sweep.budgetMicroUSD !== undefined &&
            sweep.budgetUsedMicroUSD + estimate > sweep.budgetMicroUSD
          )
            return yield* Effect.fail(
              new AdapterError('budget', 'Budget excludes this request attempt'),
            )
          sweep.budgetUsedMicroUSD += estimate
          const attemptId = `at_${randomUUID()}`
          yield* ledgerCall('startAttempt', () =>
            engine.ledger.startAttempt({
              attemptId,
              sweepId: sweep.sweepId,
              provider: provider.adapter.name,
              requestId: request.requestId,
              ordinal,
              startedAt: Date.now(),
              estimateMicroUSD: estimate,
              basis: model.basis,
            }),
          ).pipe(
            Effect.catchTag('LedgerError', (error) => {
              sweep.budgetUsedMicroUSD -= estimate
              return Effect.fail(error)
            }),
          )
          const chargeIndex =
            provider.charges.push({ kind: 'unknown', estimateMicroUSD: estimate }) - 1
          finish = {
            attemptId,
            finishedAt: Date.now(),
            status: 'cancelled',
            charge: { kind: 'unknown', estimateMicroUSD: estimate },
            errorCode: 'cancelled',
          }
          const received = yield* restore(Effect.result(request.run))
          const result = Result.isSuccess(received)
            ? received.success.result
            : Result.fail(received.failure)
          const reported = Result.isSuccess(received)
            ? received.success.reportedMicroUSD
            : undefined
          const charge: Charge =
            reported !== undefined
              ? { kind: 'observed', microUSD: reported }
              : Result.isSuccess(received)
                ? { kind: 'estimated', microUSD: estimate, basis: model.basis }
                : { kind: 'unknown', estimateMicroUSD: estimate }
          provider.charges[chargeIndex] = charge
          sweep.budgetUsedMicroUSD += chargeMicroUSD(charge) - estimate
          const error = Result.isFailure(result) ? result.failure : undefined
          finish = {
            attemptId,
            finishedAt: Date.now(),
            status: error ? 'error' : 'ok',
            charge,
            ...(error?.httpStatus !== undefined ? { httpStatus: error.httpStatus } : {}),
            ...(error ? { errorCode: error.reason ?? error.code } : {}),
          }
          if (error?.code === 'rate_limit' && error.httpStatus === 429)
            pacing.nextAt = Math.max(pacing.nextAt, Date.now() + (error.retryAfterMs ?? 300))
          return yield* Effect.fromResult(result)
        }),
      )
      return yield* Effect.onExit(run, () => {
        const completed = finish
        return completed
          ? ledgerCall(
              'finishAttempt',
              () => engine.ledger.finishAttempt({ ...completed, finishedAt: Date.now() }),
              completed,
            )
          : Effect.void
      })
    }),
  )
  const schedule = Schedule.recurs(1).pipe(
    Schedule.addDelay(({ input }: Schedule.Metadata<number, AdapterError | LedgerError>) =>
      Effect.succeed(
        input instanceof AdapterError
          ? (input.retryAfterMs ?? 300 + Math.floor(Math.random() * 501))
          : 0,
      ),
    ),
  )
  return Effect.retry(attempt, {
    schedule,
    while: (error) =>
      error instanceof AdapterError &&
      request.retryable !== false &&
      provider.charges.at(-1)?.kind !== 'unknown' &&
      (error.code === 'rate_limit' ||
        (error.code === 'provider_error' &&
          error.httpStatus !== undefined &&
          error.httpStatus >= 500 &&
          error.httpStatus <= 599)),
  })
}

function executeSweep(
  engine: EngineState,
  flight: Flight,
): Effect.Effect<SweepResult, EngineError, HttpClient.HttpClient> {
  return Effect.suspend(() => {
    const query = flight.query
    const skipped: Record<string, ProviderCallStats> = {}
    const providers: ProviderState[] = []
    for (const { adapter, key } of flight.providers) {
      if (lacksCapability(adapter, query)) skipped[adapter.name] = stats('skipped:capability')
      else if (adapter.envKey && !key) skipped[adapter.name] = stats('skipped:nokey')
      else
        providers.push({
          adapter,
          key,
          hits: [],
          charges: [],
          startedAt: 0,
          latencyMs: 0,
          ...(query.freshness
            ? {
                freshness: {
                  support: adapter.capabilities.freshness ? 'native' : 'post-filter',
                  policy: query.freshnessPolicy,
                  kept: 0,
                  keptUndated: 0,
                  keptStale: 0,
                  droppedStale: 0,
                  droppedUndated: 0,
                },
              }
            : {}),
        })
    }
    if (!providers.length)
      return Effect.fail(
        new WidebandError(
          'NO_PROVIDERS',
          'No providers can run this query',
          ['set provider API keys', 'run: wideband providers'],
          3,
        ),
      )
    providers.sort(
      (a, b) => estimateUSD(a.adapter.costModel).usd - estimateUSD(b.adapter.costModel).usd,
    )
    const state: SweepState = {
      sweepId: `sw_${randomUUID().slice(0, 12)}`,
      query,
      startedAt: Date.now(),
      providers,
      skipped,
      budgetUsedMicroUSD: 0,
      ...(flight.opts.budget === undefined
        ? {}
        : { budgetMicroUSD: Math.floor(flight.opts.budget * 1e6 + 1e-8) }),
    }
    let began = false
    let recorded = false
    const program = Effect.gen(function* () {
      const ttl = flight.opts.ttlSec ?? Number(process.env.WIDEBAND_CACHE_TTL ?? 900)
      if (!flight.opts.fresh && flight.kind === 'sweep') {
        const cached = yield* ledgerCall('cacheGet', () =>
          engine.ledger.cacheGet(flight.key, Number.isFinite(ttl) ? ttl : 900),
        )
        if (cached)
          return freeze({
            ...cached,
            cached: true as const,
            cost: { totalUSD: 0, unknownAttempts: 0, byProvider: {} },
          })
      }
      yield* ledgerCall('beginSweep', () =>
        engine.ledger.beginSweep({ sweepId: state.sweepId, query, kind: flight.kind }),
      )
      began = true
      yield* Effect.forEach(
        providers,
        (provider) => {
          provider.startedAt = Date.now()
          const context: AdapterCtx = {
            key: provider.key,
            request: (request) => executeRequest(engine, state, provider, request),
            addHits: (hits) =>
              Effect.sync(() => {
                for (const hit of hits) {
                  if (provider.hits.length >= query.max) break
                  const annotated = annotateHit(hit, provider, query)
                  if (annotated) {
                    const { raw, ...rest } = annotated
                    provider.hits.push(flight.opts.capture ? annotated : rest)
                  }
                }
              }),
          }
          const search = Effect.suspend(() => provider.adapter.search(query, context)).pipe(
            Effect.timeoutOrElse({
              duration: flight.opts.timeoutMs ?? provider.adapter.timeoutMs ?? 10000,
              orElse: () => Effect.fail(new AdapterError('timeout', 'Provider request timed out')),
            }),
            Effect.catchTag('AdapterError', (error) =>
              Effect.sync(() => {
                provider.error = error
                provider.status = provider.hits.length
                  ? 'partial'
                  : error.code === 'budget' && !provider.charges.length
                    ? 'skipped:budget'
                    : error.code === 'timeout'
                      ? 'timeout'
                      : 'error'
              }),
            ),
            Effect.tap(() =>
              Effect.sync(() => {
                provider.status ??= 'ok'
              }),
            ),
          )
          return Effect.onExit(search, (exit) =>
            Effect.sync(() => {
              provider.latencyMs = Date.now() - provider.startedAt
              if (Exit.isFailure(exit))
                provider.status = Cause.hasInterrupts(exit.cause) ? 'cancelled' : 'error'
              broadcast(flight, {
                kind: 'provider',
                sweepId: state.sweepId,
                provider: provider.adapter.name,
                status: provider.status ?? 'error',
                sources: buildResult(state).sources,
              })
            }),
          )
        },
        { concurrency: 'unbounded', discard: true },
      )
      const result = freeze(clone(buildResult(state)))
      const hasUsableResult = providers.some(
        (provider) =>
          provider.status === 'ok' || (provider.status === 'partial' && provider.hits.length > 0),
      )
      yield* ledgerCall('finishSweep', () =>
        engine.ledger.finishSweep(
          result,
          flight.kind,
          hasUsableResult ? (result.complete ? 'complete' : 'partial') : 'failed',
        ),
      )
      recorded = true
      if (!hasUsableResult) {
        const budgetOnly = providers.every((provider) => provider.error?.code === 'budget')
        return yield* Effect.fail(
          new WidebandError(
            budgetOnly ? 'BUDGET_TOO_LOW' : 'ALL_PROVIDERS_FAILED',
            budgetOnly
              ? 'Budget excludes all runnable requests'
              : 'Every attempted provider failed',
            budgetOnly
              ? ['increase --budget']
              : ['inspect provider errors', 'run: wideband doctor'],
            budgetOnly ? 4 : 1,
            result,
          ),
        )
      }
      if (result.complete && flight.kind === 'sweep')
        yield* ledgerCall('cachePut', () => engine.ledger.cachePut(flight.key, result))
      return result
    })
    return Effect.onExit(program, (exit) =>
      began && !recorded
        ? ledgerCall('finishSweep', () =>
            engine.ledger.finishSweep(
              buildResult(state),
              flight.kind,
              Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause) ? 'cancelled' : 'failed',
            ),
          )
        : Effect.void,
    )
  })
}

export class Engine {
  private constructor(
    private readonly state: EngineState,
    private readonly cache: Cache.Cache<Flight, SweepResult, EngineError, HttpClient.HttpClient>,
  ) {}

  static make(
    adapters: readonly ProviderAdapter[],
    ledger: Ledger,
    opts: EngineOptions = {},
  ): Effect.Effect<Engine> {
    const state: EngineState = {
      adapters,
      ledger,
      getKey: opts.getKey ?? ((name) => process.env[name] || undefined),
      flights: new Map(),
      pacing: new Map(
        adapters.map((adapter) => [adapter.name, { gate: Semaphore.makeUnsafe(1), nextAt: 0 }]),
      ),
    }
    return Effect.map(
      Cache.makeWith((flight: Flight) => executeSweep(state, flight), {
        capacity: Infinity,
        timeToLive: () => 0,
        requireServicesAt: 'lookup',
      }),
      (cache) => new Engine(state, cache),
    )
  }

  sweep(
    queryInput: unknown,
    optsInput: SweepOptions = {},
    kind: 'sweep' | 'doctor' = 'sweep',
    onProvider?: Observer,
  ): Effect.Effect<SweepResult, EngineError, HttpClient.HttpClient> {
    return Effect.gen({ self: this }, function* () {
      const { query, opts } = yield* Effect.try({
        try: () => ({ query: parseQuery(queryInput), opts: parseSweepOptions(optsInput) }),
        catch: (error) => new WidebandError('INVALID_ARGS', safeErrorMessage(error), [], 2),
      })
      const requested = opts.providers?.length
        ? [...new Set(opts.providers.map((name) => name.toLowerCase()))]
        : this.state.adapters.map((adapter) => adapter.name)
      const unknown = requested.filter(
        (name) => !this.state.adapters.some((adapter) => adapter.name === name),
      )
      if (unknown.length)
        return yield* Effect.fail(
          new WidebandError(
            'UNKNOWN_PROVIDER',
            `Unknown provider: ${unknown.join(', ')}`,
            ['run: wideband providers'],
            2,
          ),
        )
      const selected = this.state.adapters.filter((adapter) => requested.includes(adapter.name))
      if (
        query.googlePages !== undefined &&
        !selected.some((adapter) => ['google', 'anyapi'].includes(adapter.name))
      )
        return yield* Effect.fail(
          new WidebandError(
            'INVALID_ARGS',
            'googlePages requires selecting the google or anyapi provider',
            ['use --providers google or --providers anyapi'],
            2,
          ),
        )
      const providers = selected.map((adapter) => ({
        adapter,
        key: adapter.envKey ? (this.state.getKey(adapter.envKey) ?? '') : '',
      }))
      const key = sha256(
        stableStringify({
          query,
          providers: providers
            .map(({ adapter, key }) => ({
              name: adapter.name,
              credentials: sha256(key),
              timeoutMs: opts.timeoutMs ?? adapter.timeoutMs ?? 10000,
            }))
            .sort((a, b) => a.name.localeCompare(b.name)),
          capture: Boolean(opts.capture),
          budget: opts.budget,
          ttlSec: opts.ttlSec,
          kind,
        }),
      )
      const baseline = opts.session
        ? yield* ledgerCall('seenIds', () => this.state.ledger.seenIds(opts.session ?? ''))
        : new Set<string>()
      const fresh = Boolean(opts.fresh || kind !== 'sweep')
      const flight = !fresh
        ? (this.state.flights.get(key) ?? {
            key,
            query,
            opts,
            kind,
            providers,
            observers: new Set<Observer>(),
            history: [],
            users: 0,
          })
        : {
            key,
            query,
            opts,
            kind,
            providers,
            observers: new Set<Observer>(),
            history: [],
            users: 0,
          }
      if (!fresh) this.state.flights.set(key, flight)
      flight.users += 1
      const observer: Observer = (event) =>
        onProvider?.({
          ...event,
          sources: event.sources.filter((source) => !baseline.has(source.id)),
        })
      if (onProvider) {
        flight.observers.add(observer)
        for (const event of flight.history) observer(clone(event))
      }
      const work = fresh ? executeSweep(this.state, flight) : Cache.get(this.cache, flight)
      const projected = Effect.flatMap(work, (result) =>
        Effect.gen({ self: this }, function* () {
          const copied = clone(result)
          if (!opts.session) return copied
          const session = opts.session
          const claimed = yield* ledgerCall('claimSources', () =>
            this.state.ledger.claimSources(
              session,
              copied.sources.map((source) => source.id),
            ),
          )
          const sources = copied.sources.filter((source) => claimed.has(source.id))
          return {
            ...copied,
            sources,
            stats: {
              ...copied.stats,
              uniqueSources: sources.length,
              overlapPct: copied.stats.totalHits
                ? roundScore(1 - sources.length / copied.stats.totalHits)
                : 0,
              suppressedBySession: copied.sources.length - sources.length,
            },
          }
        }),
      ).pipe(
        Effect.catchTag('WidebandError', (error) =>
          Effect.fail(
            new WidebandError(
              error.code,
              error.message,
              error.suggestions,
              error.exitCode,
              error.result
                ? {
                    ...clone(error.result),
                    sources: error.result.sources
                      .filter((source) => !baseline.has(source.id))
                      .map(clone),
                  }
                : undefined,
            ),
          ),
        ),
      )
      return yield* Effect.ensuring(
        projected,
        Effect.sync(() => {
          flight.observers.delete(observer)
          flight.users -= 1
          if (!flight.users && !fresh && this.state.flights.get(key) === flight)
            this.state.flights.delete(key)
        }),
      )
    })
  }

  providerInfo(): ProviderInfo[] {
    const month = this.state.ledger.monthToDate()
    return this.state.adapters.map((adapter) => {
      const keyPresent = adapter.envKey ? Boolean(this.state.getKey(adapter.envKey)) : false
      const usage = month.providers[adapter.name] ?? { attempts: 0, usd: 0, unknownAttempts: 0 }
      const quota = monthlyQuota(adapter.costModel)
      return {
        name: adapter.name,
        configured: !adapter.envKey || keyPresent,
        keyPresent,
        envKey: adapter.envKey,
        costModel: adapter.costModel,
        capabilities: adapter.capabilities,
        month: usage,
        ...(quota === null ? {} : { quota: { limit: quota, used: usage.attempts } }),
      }
    })
  }
}
