import { z } from 'zod'

export const MediaType = z.enum(['web', 'news', 'image', 'video', 'pdf', 'other'])
export type MediaType = z.infer<typeof MediaType>

export const FreshnessPolicy = z.enum(['strict', 'balanced', 'recall'])
export type FreshnessPolicy = z.infer<typeof FreshnessPolicy>

export const FreshnessConfidence = z.enum(['native', 'verified', 'undated', 'stale'])
export type FreshnessConfidence = z.infer<typeof FreshnessConfidence>

export const UnifiedQuery = z.object({
  q: z.string().min(1),
  mode: z.enum(['scan', 'research']).default('scan'),
  mediaType: z.enum(['web', 'news', 'image', 'video']).default('web'),
  max: z.number().int().min(1).max(50).default(10),
  freshness: z
    .object({ after: z.string().optional(), before: z.string().optional() })
    .optional(),
  freshnessPolicy: FreshnessPolicy.default('balanced'),
  domains: z
    .object({ include: z.array(z.string()).optional(), exclude: z.array(z.string()).optional() })
    .optional(),
})
export type UnifiedQuery = z.infer<typeof UnifiedQuery>

/** One normalized result from one provider. Adapter output, pre-merge. */
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

export const Provenance = z.object({
  provider: z.string(),
  rank: z.number(),
  score: z.number().optional(),
})
export type Provenance = z.infer<typeof Provenance>

/** The unified media object: one deduplicated content item with full provenance. */
export const Source = z.object({
  id: z.string(),
  url: z.string(),
  title: z.string(),
  snippet: z.string(),
  content: z.string().optional(),
  publishedAt: z.string().optional(),
  author: z.string().optional(),
  mediaType: MediaType,
  providers: z.array(z.string()),
  provenance: z.array(Provenance),
  uniqueTo: z.string().optional(),
  freshness: z
    .object({
      confidence: FreshnessConfidence,
      providers: z.record(z.string(), FreshnessConfidence),
    })
    .optional(),
  score: z.number(),
  raw: z.record(z.string(), z.array(z.unknown())).optional(),
})
export type Source = z.infer<typeof Source>

export const ProviderFreshnessStats = z.object({
  support: z.enum(['native', 'post-filter']),
  policy: FreshnessPolicy,
  kept: z.number(),
  keptUndated: z.number(),
  keptStale: z.number(),
  droppedStale: z.number(),
  droppedUndated: z.number(),
})
export type ProviderFreshnessStats = z.infer<typeof ProviderFreshnessStats>

export const ProviderCallStats = z.object({
  status: z.enum(['ok', 'error', 'timeout', 'skipped:budget', 'skipped:capability', 'skipped:nokey']),
  hits: z.number(),
  uniqueContributed: z.number(),
  latencyMs: z.number(),
  freshness: ProviderFreshnessStats.optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
})
export type ProviderCallStats = z.infer<typeof ProviderCallStats>

export const CostBasis = z.enum(['reported', 'metered', 'amortized', 'free'])
export type CostBasis = z.infer<typeof CostBasis>

export const SweepResult = z.object({
  sweepId: z.string(),
  cached: z.literal(true).optional(),
  query: UnifiedQuery,
  sources: z.array(Source),
  stats: z.object({
    totalHits: z.number(),
    uniqueSources: z.number(),
    overlapPct: z.number(),
    suppressedBySession: z.number().optional(),
    providers: z.record(z.string(), ProviderCallStats),
  }),
  cost: z.object({
    totalUSD: z.number(),
    byProvider: z.record(z.string(), z.object({ usd: z.number(), basis: CostBasis })),
  }),
  timing: z.object({ totalMs: z.number() }),
})
export type SweepResult = z.infer<typeof SweepResult>

export type CostModel =
  | { kind: 'metered'; perRequestUSD: number }
  | { kind: 'subscription'; monthlyUSD: number; includedRequests: number }
  | { kind: 'free'; monthlyQuota?: number }

export type Capabilities = {
  mediaTypes: MediaType[]
  freshness: boolean
  domainFilters: boolean
  fullContent: boolean
  maxPerRequest: number
}

export type AdapterCtx = { signal: AbortSignal; key: string }
export type AdapterResult = { hits: Hit[]; reportedUSD?: number }

export interface ProviderAdapter {
  name: string
  envKey: string
  capabilities: Capabilities
  costModel: CostModel
  search(q: UnifiedQuery, ctx: AdapterCtx): Promise<AdapterResult>
}

export type SweepOptions = {
  providers?: string[]
  budget?: number
  timeoutMs?: number
  session?: string
  fresh?: boolean
  ttlSec?: number
  capture?: boolean
}
