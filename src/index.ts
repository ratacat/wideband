import { Cause, Context, Effect, Exit, Layer, ManagedRuntime, Queue, Result, Schema, Stream } from 'effect'
import { FetchHttpClient, HttpClient } from 'effect/http'
import { ADAPTERS } from './adapters/registry'
import { Engine } from './core/engine'
import { Ledger } from './core/ledger'
import { safeErrorMessage, WidebandError } from './core/errors'
import { parseQuery, parseSweepOptions, type SweepEvent, type SweepOptions, type UnifiedQuery } from './core/types'

export type WidebandOptions = { db?: string }

type ClientResources = { engine: Engine; ledger: Ledger }
type DoctorCheck = { provider: string; status: string; latencyMs?: number; error?: { code: string; message: string } }
const Client = Context.Service<ClientResources>('wideband/Client')

function parseModeQuery(input: unknown, mode?: 'scan' | 'research'): UnifiedQuery {
  if (typeof input === 'string') return parseQuery({ q: input, ...(mode ? { mode } : {}) })
  if (mode && input !== null && typeof input === 'object') return parseQuery({ ...input, mode })
  return parseQuery(input)
}

export function wideband(opts: WidebandOptions = {}) {
  const resources = Layer.effect(Client, Effect.gen(function* () {
    const ledger = yield* Effect.acquireRelease(
      Effect.try({ try: () => new Ledger(opts.db), catch: () => new WidebandError('LEDGER_ERROR', 'Could not open search ledger') }),
      ledger => Effect.sync(() => ledger.close()),
    )
    const engine = yield* Engine.make(ADAPTERS, ledger)
    return { engine, ledger }
  })).pipe(Layer.provideMerge(FetchHttpClient.layer))
  const runtime = ManagedRuntime.make(resources)
  let closing: Promise<void> | undefined

  async function run<A, E>(effect: Effect.Effect<A, E, ClientResources | HttpClient.HttpClient>, signal?: AbortSignal): Promise<A> {
    if (closing) throw new WidebandError('CLOSED', 'Wideband client is closed')
    const exit = await runtime.runPromiseExit(effect, signal ? { signal } : {})
    if (Exit.isSuccess(exit)) return exit.value
    const error = Cause.findError(exit.cause)
    if (Result.isSuccess(error)) throw error.success
    if (Cause.hasInterrupts(exit.cause)) throw new WidebandError('CANCELLED', 'Search cancelled')
    throw new WidebandError('INTERNAL', 'Internal search error')
  }

  function sweep(input: unknown, options: SweepOptions = {}, mode?: 'scan' | 'research') {
    return run(Effect.gen(function* () {
      const { query, parsed } = yield* Effect.try({
        try: () => ({ query: parseModeQuery(input, mode), parsed: parseSweepOptions(options) }),
        catch: error => new WidebandError('INVALID_ARGS', safeErrorMessage(error), ['run: wideband --help'], 2),
      })
      const { engine } = yield* Client
      return yield* engine.sweep(query, parsed)
    }), options.signal)
  }

  function snapshot<A>(read: (resources: ClientResources) => A) {
    return run(Effect.flatMap(Client, resources => Effect.try({
      try: () => read(resources),
      catch: () => new WidebandError('LEDGER_ERROR', 'Could not read search ledger'),
    })))
  }

  return {
    sweep: (input: unknown, options: SweepOptions = {}) => sweep(input, options),
    scan: (input: unknown, options: SweepOptions = {}) => sweep(input, options, 'scan'),
    research: (input: unknown, options: SweepOptions = {}) => sweep(input, options, 'research'),
    async *stream(input: unknown, options: SweepOptions = {}): AsyncGenerator<SweepEvent> {
      const queue = await run(Queue.make<{ kind: 'event'; event: SweepEvent } | { kind: 'error'; error: unknown }, Cause.Done>())
      const controller = new AbortController()
      const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal
      const pending = run(Effect.gen(function* () {
        const { query, parsed } = yield* Effect.try({
          try: () => ({ query: parseModeQuery(input), parsed: parseSweepOptions(options) }),
          catch: error => new WidebandError('INVALID_ARGS', safeErrorMessage(error), ['run: wideband --help'], 2),
        })
        const { engine } = yield* Client
        return yield* engine.sweep(query, parsed, 'sweep', event => {
          Queue.offerUnsafe(queue, { kind: 'event', event })
        })
      }), signal).then(result => {
        Queue.offerUnsafe(queue, { kind: 'event', event: { kind: 'result', result } })
        Queue.endUnsafe(queue)
      }, error => {
        Queue.offerUnsafe(queue, { kind: 'error', error })
        Queue.endUnsafe(queue)
      })
      try {
        for await (const item of Stream.toAsyncIterable(Stream.fromQueue(queue))) {
          if (item.kind === 'error') throw item.error
          yield item.event
        }
      } finally {
        controller.abort()
        await pending
        Queue.shutdownUnsafe(queue)
      }
    },
    providers: () => snapshot(({ engine }) => engine.providerInfo()),
    stats: (days?: number) => run(Effect.gen(function* () {
      const parsed = yield* Effect.try({
        try: () => days === undefined ? undefined : Schema.decodeUnknownSync(Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)))(days),
        catch: () => new WidebandError('INVALID_ARGS', 'days must be a positive integer', [], 2),
      })
      const { ledger } = yield* Client
      return yield* Effect.try({ try: () => ledger.stats(parsed), catch: () => new WidebandError('LEDGER_ERROR', 'Could not read search ledger') })
    })),
    costs: () => snapshot(({ ledger }) => ledger.monthToDate()),
    doctor: (options: { signal?: AbortSignal } = {}) => run(Effect.gen(function* () {
      const { engine } = yield* Client
      const providers = yield* Effect.try({ try: () => engine.providerInfo(), catch: () => new WidebandError('LEDGER_ERROR', 'Could not read search ledger') })
      const missingKeys = providers.flatMap(provider => provider.envKey && !provider.keyPresent ? [provider.envKey] : [])
      const checks = yield* Effect.forEach(providers.filter(provider => provider.configured), provider =>
        engine.sweep(parseQuery({ q: 'wideband connectivity check', max: 1 }), { providers: [provider.name], fresh: true, timeoutMs: 8000 }, 'doctor').pipe(
          Effect.map((result): DoctorCheck => {
            const stats = result.stats.providers[provider.name]
            return stats
              ? { provider: provider.name, status: stats.status, latencyMs: stats.latencyMs, ...(stats.error ? { error: stats.error } : {}) }
              : { provider: provider.name, status: 'error', error: { code: 'missing_stats', message: 'Provider returned no stats' } }
          }),
          Effect.catch(error => Effect.succeed<DoctorCheck>({ provider: provider.name, status: 'error', error: { code: error instanceof WidebandError ? error.code : 'LEDGER_ERROR', message: safeErrorMessage(error) } })),
        ), { concurrency: 'unbounded' })
      return { checks, missingKeys }
    }), options.signal),
    close() {
      closing ??= runtime.dispose()
      return closing
    },
  }
}

export { ADAPTERS, getAdapter } from './adapters/registry'
export { AdapterError, LedgerError, WidebandError } from './core/errors'
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
  parseQuery,
  parseSweepResult,
  type AdapterCtx,
  type Capabilities,
  type CostModel,
  type FreshnessConfidence as FreshnessConfidenceType,
  type FreshnessPolicy as FreshnessPolicyType,
  type Hit,
  type ProviderAdapter,
  type ProviderFreshnessStats as ProviderFreshnessStatsType,
  type SweepEvent,
  type SweepOptions,
} from './core/types'
