import { Effect, Schema, type Result } from 'effect'
import type { HttpClient } from 'effect/http'
import type { AdapterError, LedgerError } from './errors'

const Count = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
const Amount = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))

export const MediaType = Schema.Literals(['web', 'news', 'image', 'video', 'pdf', 'other'])
export type MediaType = typeof MediaType.Type
export const FreshnessPolicy = Schema.Literals(['strict', 'balanced', 'recall'])
export type FreshnessPolicy = typeof FreshnessPolicy.Type
export const FreshnessConfidence = Schema.Literals(['native', 'verified', 'undated', 'stale'])
export type FreshnessConfidence = typeof FreshnessConfidence.Type

export const UnifiedQuery = Schema.Struct({
  q: Schema.String.check(Schema.isMinLength(1)),
  mode: Schema.Literals(['scan', 'research'])
    .annotate({ default: 'scan' })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed('scan'))),
  mediaType: Schema.Literals(['web', 'news', 'image', 'video'])
    .annotate({ default: 'web' })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed('web'))),
  max: Schema.Finite.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(100),
  )
    .annotate({ default: 10 })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed(10))),
  googlePages: Schema.optionalKey(
    Schema.Finite.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(10),
    ),
  ),
  freshness: Schema.optionalKey(
    Schema.Struct({
      after: Schema.optionalKey(Schema.String),
      before: Schema.optionalKey(Schema.String),
    }),
  ),
  freshnessPolicy: FreshnessPolicy.annotate({ default: 'balanced' }).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed('balanced')),
  ),
  domains: Schema.optionalKey(
    Schema.Struct({
      include: Schema.optionalKey(Schema.Array(Schema.String)),
      exclude: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  ),
})
export type UnifiedQuery = typeof UnifiedQuery.Type
function omitUndefined(input: unknown): unknown {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return input
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))
}

export function parseQuery(input: unknown): UnifiedQuery {
  const normalized = omitUndefined(input)
  if (normalized === null || typeof normalized !== 'object' || Array.isArray(normalized))
    return Schema.decodeUnknownSync(UnifiedQuery)(normalized)
  return Schema.decodeUnknownSync(UnifiedQuery)({
    ...normalized,
    ...('freshness' in normalized ? { freshness: omitUndefined(normalized.freshness) } : {}),
    ...('domains' in normalized ? { domains: omitUndefined(normalized.domains) } : {}),
  })
}

export type Hit = {
  provider: string
  rank: number
  url: string
  title?: string
  snippet?: string
  content?: string
  publishedAt?: string
  author?: string
  score?: number
  mediaType: MediaType
  freshness?: { confidence: FreshnessConfidence }
  raw?: unknown
}

export const Provenance = Schema.Struct({
  provider: Schema.String,
  rank: Count,
  score: Schema.optionalKey(Schema.Finite),
})
export type Provenance = typeof Provenance.Type
export const Source = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  title: Schema.String,
  snippet: Schema.String,
  content: Schema.optionalKey(Schema.String),
  publishedAt: Schema.optionalKey(Schema.String),
  author: Schema.optionalKey(Schema.String),
  mediaType: MediaType,
  providers: Schema.Array(Schema.String),
  provenance: Schema.Array(Provenance),
  uniqueTo: Schema.optionalKey(Schema.String),
  freshness: Schema.optionalKey(
    Schema.Struct({
      confidence: FreshnessConfidence,
      providers: Schema.Record(Schema.String, FreshnessConfidence),
    }),
  ),
  score: Schema.Finite,
  raw: Schema.optionalKey(Schema.Record(Schema.String, Schema.Array(Schema.Unknown))),
})
export type Source = typeof Source.Type
export type DeepMutable<A> = A extends readonly (infer B)[]
  ? DeepMutable<B>[]
  : A extends object
    ? { -readonly [K in keyof A]: DeepMutable<A[K]> }
    : A
export type MutableSource = DeepMutable<Source>

export const ProviderFreshnessStats = Schema.Struct({
  support: Schema.Literals(['native', 'post-filter']),
  policy: FreshnessPolicy,
  kept: Count,
  keptUndated: Count,
  keptStale: Count,
  droppedStale: Count,
  droppedUndated: Count,
})
export type ProviderFreshnessStats = typeof ProviderFreshnessStats.Type

export const ProviderCallStats = Schema.Struct({
  status: Schema.Literals([
    'ok',
    'partial',
    'error',
    'timeout',
    'cancelled',
    'skipped:budget',
    'skipped:capability',
    'skipped:nokey',
  ]),
  hits: Count,
  uniqueContributed: Count,
  latencyMs: Amount,
  attempts: Count.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  freshness: Schema.optionalKey(ProviderFreshnessStats),
  error: Schema.optionalKey(Schema.Struct({ code: Schema.String, message: Schema.String })),
})
export type ProviderCallStats = typeof ProviderCallStats.Type

export const CostBasis = Schema.Literals([
  'reported',
  'metered',
  'amortized',
  'free',
  'unknown',
  'mixed',
])
export type CostBasis = typeof CostBasis.Type
export const ProviderCost = Schema.Struct({
  usd: Amount,
  basis: CostBasis,
  observedUSD: Amount.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  estimatedUSD: Amount.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  unknownAttempts: Count.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  attempts: Count.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
})
export type ProviderCost = typeof ProviderCost.Type

export const SweepResult = Schema.Struct({
  sweepId: Schema.String,
  cached: Schema.optionalKey(Schema.Literal(true)),
  complete: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
  query: UnifiedQuery,
  sources: Schema.Array(Source),
  stats: Schema.Struct({
    totalHits: Count,
    uniqueSources: Count,
    overlapPct: Schema.Finite,
    suppressedBySession: Schema.optionalKey(Count),
    providers: Schema.Record(Schema.String, ProviderCallStats),
  }),
  cost: Schema.Struct({
    totalUSD: Amount,
    unknownAttempts: Count.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
    byProvider: Schema.Record(Schema.String, ProviderCost),
  }),
  timing: Schema.Struct({ totalMs: Amount }),
})
export type SweepResult = typeof SweepResult.Type
export const parseSweepResult = Schema.decodeUnknownSync(SweepResult)

export const SweepOptionsSchema = Schema.Struct({
  providers: Schema.optionalKey(Schema.Array(Schema.String)),
  budget: Schema.optionalKey(
    Amount.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER / 1e6)),
  ),
  timeoutMs: Schema.optionalKey(Count.check(Schema.isGreaterThanOrEqualTo(1))),
  session: Schema.optionalKey(Schema.String),
  fresh: Schema.optionalKey(Schema.Boolean),
  ttlSec: Schema.optionalKey(Schema.Finite),
  capture: Schema.optionalKey(Schema.Boolean),
})
export type SweepOptions = typeof SweepOptionsSchema.Type & { signal?: AbortSignal }
export function parseSweepOptions(input: unknown): typeof SweepOptionsSchema.Type {
  return Schema.decodeUnknownSync(SweepOptionsSchema)(omitUndefined(input))
}

export type CostModel =
  | { kind: 'metered'; perRequestUSD: number }
  | { kind: 'subscription'; monthlyUSD: number; includedRequests: number }
  | { kind: 'free'; monthlyQuota?: number }
export type Capabilities = {
  mediaTypes: readonly MediaType[]
  freshness: boolean
  domainFilters: boolean
  fullContent: boolean
  maxPerRequest: number
}
export type Charge =
  | { kind: 'observed'; microUSD: number }
  | { kind: 'estimated'; microUSD: number; basis: 'metered' | 'amortized' | 'free' }
  | { kind: 'unknown'; estimateMicroUSD: number }
export type RequestReceipt<A> = {
  result: Result.Result<A, AdapterError>
  reportedMicroUSD?: number
}
export type ProviderRequest<A> = {
  requestId: string
  estimateMicroUSD?: number
  retryable?: boolean
  run: Effect.Effect<RequestReceipt<A>, AdapterError, HttpClient.HttpClient>
}
export type AdapterCtx = {
  key: string
  request: <A>(
    request: ProviderRequest<A>,
  ) => Effect.Effect<A, AdapterError | LedgerError, HttpClient.HttpClient>
  addHits: (hits: readonly Hit[]) => Effect.Effect<void>
}
export interface ProviderAdapter {
  name: string
  envKey?: string
  timeoutMs?: number
  capabilities: Capabilities
  costModel: CostModel
  search: (
    query: UnifiedQuery,
    ctx: AdapterCtx,
  ) => Effect.Effect<void, AdapterError | LedgerError, HttpClient.HttpClient>
}
export type SweepProviderEvent = {
  kind: 'provider'
  sweepId: string
  provider: string
  status: ProviderCallStats['status']
  sources: readonly Source[]
}
export type SweepEvent = SweepProviderEvent | { kind: 'result'; result: SweepResult }
export type AttemptStart = {
  attemptId: string
  sweepId: string
  provider: string
  requestId: string
  ordinal: number
  startedAt: number
  estimateMicroUSD: number
  basis: 'metered' | 'amortized' | 'free'
}
export type AttemptFinish = {
  attemptId: string
  finishedAt: number
  status: 'ok' | 'error' | 'cancelled'
  charge: Charge
  httpStatus?: number
  errorCode?: string
}
