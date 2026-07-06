# wideband — Architecture

**Mission:** maximize *unique sources* per query by fanning out across many search providers, with full telemetry on where every source came from and what it cost.

## Vocabulary

| Term | Meaning |
| --- | --- |
| **Provider** | An external search service (Exa, Brave, Tavily, …). See [adapters.md](adapters.md). |
| **Adapter** | Module implementing `ProviderAdapter` for one provider: query translation, response normalization, capability declaration, cost model. |
| **Hit** | One normalized result from one provider. Adapter output. |
| **Source** | The unified media object: a deduplicated content item merged from Hits across providers, carrying provenance. Engine output. |
| **Sweep** | One fan-out search across selected adapters. The unit of telemetry and cost accounting. |
| **Ledger** | SQLite store recording every sweep, provider call, cost, and attribution. |
| **Engine** | The deep core module: `sweep(query, opts) → SweepResult`. SDK and CLI (and later HTTP) are thin shells over it. |

## Design shape

One deep module (Engine) behind a small interface; one real seam (`ProviderAdapter`) with N adapters behind it. Normalization lives *inside* each adapter (provider response → `Hit[]`); merging, ranking, cost metering, caching, and telemetry live *inside* the Engine. The access surfaces (SDK + CLI now, HTTP as first fast-follow) share one schema and one serializer — parity by construction, not by discipline.

```
src/
  core/
    engine.ts      sweep(): fan-out, merge, meter, cache, record
    merge.ts       URL canonicalization, dedup, RRF rank fusion
    cost.ts        cost models, per-sweep aggregation, month-to-date rollups
    ledger.ts      SQLite telemetry + cache + sessions (bun:sqlite)
    types.ts       UnifiedQuery, Hit, Source, SweepResult — zod schemas (single source of truth)
  adapters/
    registry.ts    adapter list + key detection ("configured" = adapter exists AND key present)
    brave.ts  desearch.ts  exa.ts  jina.ts  linkup.ts  nimble.ts  parallel.ts  perplexity.ts  sailor.ts  searchx.ts  tavily.ts
  cli/
    main.ts        robot-mode CLI (bin: wideband)
  server.ts        (fast-follow) Bun.serve HTTP endpoint, same JSON bodies as CLI --json
  index.ts         SDK exports
```

Runtime deps: **zod** only (validation at CLI edges + JSON Schema export for `wideband schema`). Storage via `bun:sqlite` (built in). Everything else is hand-rolled fetch.

## Adapter seam

```ts
interface ProviderAdapter {
  name: string                       // 'exa'
  envKey: string                     // 'EXA_API_KEY'
  capabilities: {
    mediaTypes: MediaType[]          // what it can return
    freshness: boolean               // date-range filtering
    domainFilters: boolean
    fullContent: boolean             // can return page text
    maxPerRequest: number
  }
  costModel: CostModel
  search(q: UnifiedQuery, ctx: { signal: AbortSignal; key: string }): Promise<{ hits: Hit[]; reportedUSD?: number }>
}
```

Adapters never throw raw provider errors — they classify into `auth | quota | rate_limit | timeout | provider_error` so the Engine and telemetry see uniform failure modes. The Engine skips adapters whose capabilities can't serve the query (e.g. image search on a web-only provider) and records them as `skipped:capability`.

## Data shapes

```ts
type UnifiedQuery = {
  q: string
  mode?: 'scan' | 'research'                       // default 'scan'
  mediaType?: 'web' | 'news' | 'image' | 'video'   // default 'web'
  max?: number                                      // per-provider hit count, default 10
  freshness?: { after?: string; before?: string }   // ISO timestamp or YYYY-MM-DD
  domains?: { include?: string[]; exclude?: string[] }
}

type Hit = {
  provider: string
  rank: number                 // provider-native ordering, 1-based
  url: string
  title?: string
  snippet?: string
  content?: string             // full text when the provider returns it
  publishedAt?: string
  author?: string
  score?: number               // provider-native relevance
  mediaType: MediaType
  raw?: unknown                // only retained with --capture (debugging)
}

type Provenance = { provider: string; rank: number; score?: number }

type Source = {                // ← the unified media object
  id: string                   // sha256(canonical URL), first 16 hex chars
  url: string                  // canonical
  title: string
  snippet: string              // best available across providers
  content?: string             // longest available
  publishedAt?: string
  author?: string
  mediaType: MediaType
  providers: string[]          // convenience projection of provenance
  provenance: Provenance[]     // every provider that found it, at what rank
  uniqueTo?: string            // set iff exactly one provider found it
  score: number                // RRF-fused rank score
}

type SweepResult = {
  sweepId: string
  cached?: true                // served from TTL cache at $0
  query: UnifiedQuery
  sources: Source[]            // sorted by fused score
  stats: {
    totalHits: number
    uniqueSources: number
    overlapPct: number         // 1 - uniqueSources/totalHits
    suppressedBySession?: number   // sources hidden: already seen in --session
    providers: Record<string, {
      status: 'ok' | 'error' | 'timeout' | 'skipped:budget' | 'skipped:capability' | 'skipped:nokey'
      hits: number
      uniqueContributed: number   // sources ONLY this provider found
      latencyMs: number
      error?: { code: string; message: string }
    }>
  }
  cost: {
    totalUSD: number
    byProvider: Record<string, { usd: number; basis: 'reported' | 'metered' | 'amortized' | 'free' }>
  }
  timing: { totalMs: number }
}
```

## Merge & ranking

- **Canonical URL:** lowercase host, https-preferred, strip default ports, fragments, tracking params (`utm_*`, `fbclid`, `gclid`, `ref`), normalize trailing slash. `Source.id` = hash of canonical URL.
- **Merge policy:** union metadata; keep best snippet (longest non-truncated), longest content, earliest non-null publishedAt. Every contributing provider lands in `provenance`.
- **Fused ranking:** Reciprocal Rank Fusion — `score = Σ 1/(60 + rank_p)` over providers. Standard, robust, no score normalization across heterogeneous providers needed.

## Cost model

Two billing realities, modeled explicitly:

```ts
type CostModel =
  | { kind: 'metered';      perRequestUSD: number }                          // top-up credits: real marginal cost (Exa, Parallel, Tavily)
  | { kind: 'subscription'; monthlyUSD: number; includedRequests: number }   // flat fee: amortized = monthlyUSD/includedRequests, plus quota tracking
  | { kind: 'free';         monthlyQuota?: number }                          // free tier: $0, quota tracked (Brave free)
```

- Per call, adapters prefer **provider-reported cost** (e.g. Exa returns `costDollars`) over the model estimate; the `basis` field records which was used.
- Per sweep, the Engine aggregates `cost.totalUSD` + per-provider breakdown into the result *and* the Ledger.
- `--budget <usd>` enforces a per-sweep cap: the Engine pre-estimates each adapter's cost (cheapest first), skips providers that would exceed the remaining budget (`skipped:budget`), never exceeds the cap.
- Month-to-date spend and quota consumption per provider are SQL views over the Ledger.

## Telemetry (Ledger)

SQLite at `~/.wideband/ledger.db` (override: `WIDEBAND_DB`).

```sql
sweeps(id TEXT PK, ts INTEGER, kind TEXT,            -- 'sweep' | 'doctor'
       query_json TEXT, total_hits INT, unique_sources INT, total_usd REAL, total_ms INT)
calls (sweep_id TEXT, provider TEXT, status TEXT, hits INT, unique_contributed INT,
       latency_ms INT, usd REAL, cost_basis TEXT, error_code TEXT)
cache (query_hash TEXT PK, ts INTEGER, result_json TEXT)        -- TTL result cache
seen  (session_id TEXT, source_id TEXT, ts INTEGER,             -- research sessions
       PRIMARY KEY (session_id, source_id))
```

Headline metrics (surfaced by `wideband stats`):

- **Unique contribution rate** per provider — share of sources only it found.
- **Cost per unique source** per provider — the metric that decides whether a provider earns its keep.
- Latency p50/p95, error rate, month-to-date spend vs quota.

This is the feedback loop for the mission: providers are kept, dropped, or deprioritized based on measured marginal uniqueness per dollar, not vibes. Doctor calls are recorded (real money) but excluded from stats by default.

## Caching & research sessions (base features)

- **TTL cache:** a sweep with an identical normalized `(query, providers, max, …)` tuple within the TTL (default 15 min; `--ttl <sec>` / `WIDEBAND_CACHE_TTL`) returns the stored SweepResult at $0, marked `cached: true`. `--fresh` bypasses and overwrites. Repeated queries in agent loops become free.
- **Content freshness:** `--hours`, `--after`, and `--before` populate `query.freshness`. Adapters send provider-specific date filters, and the Engine drops parseably stale dated hits after provider results return.
- **Research sessions:** `--session <id>` drops Sources whose id was already returned in that session (applied after cache lookup and merge); the remainder are recorded as seen. `stats.suppressedBySession` reports the count. Iterative agent research sees only *new* unique sources.

## Access surfaces

### SDK

```ts
import { wideband } from 'wideband'
const wb = wideband()                                  // reads .env / process.env
const result = await wb.scan('query', { budget: 0.10 })     // SweepResult
const deeper = await wb.research('query', { budget: 0.10 }) // heavier retrieval
wb.providers()  wb.stats()  wb.costs()                 // same data as CLI commands
```

### CLI — robot mode (base interface)

Default search route = **everything configured**. Optimized for AI agents.

```
wideband                          compact help (below)
wideband scan <query>             fast source discovery across configured providers
wideband research <query>         heavier retrieval for article research
  --providers exa,brave           subset
  --max 10                        per-provider hits
  --budget 0.10                   per-sweep USD cap
  --timeout 10000                 per-provider ms (default 10s)
  --session <id>                  suppress sources already seen in this session
  --hours 5                       filter to content published within the last N hours
  --after 2026-06-12T01:00:00Z    content published after timestamp/date
  --before 2026-06-13             content published before timestamp/date
  --fresh                         bypass TTL cache
  --ttl 900                       cache TTL seconds
  --fields url,title,snippet      token-efficient projection (default: id,url,title,snippet,providers,score)
  --full                          everything incl. content + provenance
  --capture                       retain raw provider payloads (debugging)
  --json | --pretty               (auto-JSON when stdout is not a TTY)
wideband providers                adapters × key status × cost model × quota state
wideband stats [--days 30]        uniqueness / cost-per-unique / latency by provider
wideband costs                    month-to-date spend by provider
wideband doctor                   live-validate each key with the cheapest possible call
wideband schema [SweepResult]     JSON Schema (from zod) for any output type
```

Robot-mode contract:

1. **JSON everywhere** — every command honors `--json`; output shapes are the zod schemas verbatim.
2. **TTY detection** — `!process.stdout.isTTY` ⇒ JSON automatically; humans at a terminal get compact pretty output.
3. **Structured errors** — stderr JSON: `{ "error": { "code": "NO_API_KEYS", "message": "…", "suggestions": ["set EXA_API_KEY in .env", "run: wideband providers"] } }`
4. **Exit codes** — `0` success (≥1 source) · `1` zero results · `2` invalid args · `3` config/auth error · `4` budget excludes all providers · `5` all providers failed. Partial provider failure with ≥1 source is still `0` (details in `stats`).
5. **Token efficiency** — nulls omitted, snippets capped at 280 chars unless `--full`, `--fields` projection, compact no-arg help.

Help text (the entire no-arg output):

```
wideband — fan-out search across providers, merged unique sources
  scan <query>      fast source discovery  [--providers a,b --max N --hours N --after ISO --before ISO --fresh --json]
  research <query>  richer provider retrieval, slower and costlier
  providers       adapters + key/quota status
  stats           uniqueness, cost/unique-source, latency by provider
  costs           month-to-date spend
  doctor          live-validate keys
  schema [type]   JSON Schema for outputs
flags:
  --hours N       filter to content published within the last N hours
  --after VALUE   filter to content after an ISO timestamp or YYYY-MM-DD
  --before VALUE  filter to content before an ISO timestamp or YYYY-MM-DD
  --fresh         bypass the TTL cache
exit: 0 ok · 1 no results · 2 bad args · 3 config · 4 budget · 5 all failed
```

### HTTP (first fast-follow — not in base build)

`Bun.serve`. Bodies are the same zod schemas as CLI `--json` — zero translation layer.

```
POST /v1/search      body = UnifiedQuery + sweep opts → SweepResult
GET  /v1/providers   GET /v1/stats   GET /v1/costs   GET /v1/healthz
```

## Engine semantics

- Fan-out via `Promise.all`; each provider gets one `AbortController` deadline.
- One retry on 429/5xx with jittered backoff inside the same provider deadline; everything else fails fast into `stats`.
- A provider failure never fails the sweep — degraded results + honest stats.
- Ledger write is synchronous post-merge (SQLite is fast; one insert + N call rows).

## Provider status (2026-06-12)

| Provider | Key | Cost model (initial) |
| --- | --- | --- |
| Brave | present | free-tier quota |
| Exa | present | metered; prefers reported `costDollars` |
| Parallel | present | metered |
| Perplexity | present | metered |
| Tavily | present | metered |
| Jina | present | free-tier quota |
| Linkup | present | metered |
| Nimble | present | metered |
| Desearch | present | metered |
| Sailor | present | free-tier quota |
| SearchX | present | free-tier quota |

Live notes: Linkup is validated after top-up. Tavily is using a fresh `wideband-20260612` dev key. Nimble is validated through Fast SERP because AI Search `/v1/search` hangs on the trial workspace. Desearch reports no balance. SerpAPI is blocked at phone verification; Search Router is blocked on Google OAuth approval.

## Upgrade roadmap (post-base)

1. **HTTP endpoint** — `wideband serve`; the first fast-follow once shapes settle.
2. **NDJSON streaming** — `--stream` emits Sources as each provider lands (SSE on HTTP). Agents read before the slowest provider finishes.
3. **MCP server mode** — `wideband mcp`: native tool for any MCP-capable agent; the biggest distribution lever.
4. **Budget-aware smart routing** — Ledger-learned marginal-uniqueness-per-dollar drives provider selection: `--profile cheap|fast|deep|auto`.
5. **Content enrichment stage** — `--enrich top:5` fetches full text for top merged Sources via cheapest capable path, same cost metering.
6. **Multi-angle fan-out** — `--angles 3` sends query variants tuned to provider strengths, merges all.
7. **Bench harness** — `wideband bench` runs a fixed query suite head-to-head; data-driven keep/drop decisions per provider.
8. **Watch mode** — recurring sweep diffing newly-appeared Sources (monitoring/alerting use case).
9. **Quota guardrails** — monthly per-provider budget caps with warn/hard-stop thresholds; protects top-up balances from runaway agents.

## Decisions (2026-06-11)

- Bun + TypeScript; zod is the only runtime dependency; `bun:sqlite` for the Ledger.
- Base build ships **SDK + CLI**; HTTP endpoint is the first fast-follow.
- **TTL caching and research sessions are base features**, not upgrades.
- Default sweep = all configured providers (mission over thrift; `--budget`/`--providers` constrain).
- Dedup key = canonical URL hash; fusion = RRF (k=60).
- Normalization in adapters, merging in Engine — adapters stay thin and testable against fixtures.
- Tavily, Jina, Linkup, Nimble, and Desearch have adapters and local keys.
- Sailor and SearchX have adapters and local keys. SerpAPI needs phone verification before an API key. Search Router needs explicit approval before using the Chrome profile Google OAuth account.
- No backward-compat shims ever; replace, don't deprecate.
