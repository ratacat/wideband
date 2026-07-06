<p align="center">
  <img src="https://raw.githubusercontent.com/ratacat/wideband/main/assets/wideband-hero.jpg" alt="Bar chart: unique sources found across 11 providers — wideband 48.5 vs best single provider 8.2" width="100%">
</p>

# wideband

<p align="right"><em>— the last agentic search provider you'll ever need</em></p>

[![npm](https://img.shields.io/npm/v/wideband)](https://www.npmjs.com/package/wideband)

A multi-provider **web search API for AI agents**: one query, fanned out across every agentic search provider you have a key for. Results come back as a single ranked list of deduplicated **Sources** — each carrying provenance (every provider that found it, and at what rank), a fused relevance score, and exactly what the sweep cost.

Search providers overlap heavily. For agentic research the number that matters is **unique sources per dollar** — wideband exists to maximize it and to measure it.

- **11 provider adapters** — Brave, Desearch, Exa, Jina, Linkup, Nimble, Parallel, Perplexity, Sailor, SearchX, Tavily — behind one `ProviderAdapter` seam. Adding a provider is one file.
- **Real deduplication** — URL canonicalization (tracking params, fragments, default ports stripped) plus metadata union, so five providers returning the same article yield one Source with five provenance entries.
- **Reciprocal Rank Fusion** ranking — robust across heterogeneous providers, no score-normalization games.
- **Cost as a first-class output** — every sweep reports total USD with a per-provider breakdown, preferring provider-reported cost over estimates. `--budget` caps a sweep hard: cheapest providers first, the rest skipped.
- **Telemetry ledger** — every sweep, provider call, latency, and dollar lands in SQLite. `wideband stats` answers "which provider actually earns its cost?"
- **Robot-mode CLI** — JSON by default, meaningful exit codes, `--pretty` when a human is watching.

Built on [Bun](https://bun.sh). One runtime dependency (`zod`); everything else is hand-rolled `fetch` and `bun:sqlite`.

## Quick start

Requires [Bun](https://bun.sh) (the CLI and library run on it).

```bash
npm install -g wideband   # or: bun add -g wideband

export EXA_API_KEY=...    # any provider keys you have — see the Providers table below
wideband providers --pretty
wideband scan "bun sqlite WAL" --max 5 --pretty
```

Using it as a library: `npm install wideband`, then `import { wideband } from 'wideband'` (see [SDK](#sdk)).

From source instead:

```bash
git clone https://github.com/ratacat/wideband && cd wideband
bun install && bun link       # puts the `wideband` bin on your PATH
cp .env.example .env          # add keys for the providers you use
```

Only providers with a key present participate in a sweep — one key is enough to start.

```
$ wideband providers --pretty
brave: key free quota 1203/2000
exa: key metered
tavily: key metered
jina: key free quota 203/1000
...
```

## Two modes

| Mode | Optimized for | Provider behavior |
| --- | --- | --- |
| `scan` | Fast, cheap source discovery | Fast/basic depth, content suppressed |
| `research` | Rich retrieval for deep reading | Advanced depth, full page text where supported |

## CLI

```bash
wideband scan "latest topic" --hours 5 --providers brave,exa,linkup --fresh
wideband research "article research topic" --providers exa,tavily,jina --max 10
wideband providers    # adapters + key/quota status
wideband stats        # uniqueness, cost per unique source, latency by provider
wideband costs        # month-to-date spend
wideband doctor       # live-validate keys
wideband schema       # JSON Schema for outputs
```

Key flags:

- `--providers a,b,c` — restrict the fan-out
- `--max N` — per-provider hit count
- `--budget USD` — hard per-sweep cost cap
- `--hours N` / `--after DATE` / `--before DATE` — freshness window
- `--freshness strict|balanced|recall` — what to do with undated or stale results (default `balanced`)
- `--session NAME` — suppress sources already seen in this session across sweeps
- `--fresh` / `--ttl SECONDS` — bypass or tune the result cache (cache hits cost $0)
- `--fields url,title,score` / `--full` — projection control
- `--json` / `--pretty` — output for robots (default) or humans

Exit codes: `0` ok · `1` no results · `2` bad args · `3` config · `4` budget · `5` all providers failed.

## MCP server

`wideband-mcp` ships in the package: a stdio MCP server exposing `scan`, `research`, and `providers` as tools, so any MCP client (Claude Code, Claude Desktop, Cursor, ...) gets multi-provider web search as a single tool call.

```json
{
  "mcpServers": {
    "wideband": {
      "command": "wideband-mcp",
      "env": { "EXA_API_KEY": "...", "TAVILY_API_KEY": "..." }
    }
  }
}
```

Provider keys come from the server process env (as above) or the shell that launches the client. Tool arguments mirror the CLI: `q`, `max`, `providers`, `budget`, `hours`.

## SDK

```ts
import { wideband } from 'wideband'

const wb = wideband()

const result = await wb.scan('bun sqlite WAL', { budget: 0.05 })
for (const source of result.sources) {
  console.log(source.score, source.url, source.providers)
}
console.log(result.cost.totalUSD, result.stats.overlapPct)

const deep = await wb.research({ q: 'topic', freshness: { after: '2026-07-01' } })
wb.close()
```

Every sweep returns a `SweepResult`:

```ts
type Source = {
  id: string                  // sha256(canonical URL), first 16 hex chars
  url: string                 // canonical
  title: string
  snippet: string             // best available across providers
  content?: string            // longest available (research mode)
  publishedAt?: string
  providers: string[]
  provenance: { provider: string; rank: number; score?: number }[]
  uniqueTo?: string           // set iff exactly one provider found it
  score: number               // RRF-fused rank score
}

type SweepResult = {
  sweepId: string
  sources: Source[]           // sorted by fused score
  stats: {
    totalHits: number
    uniqueSources: number
    overlapPct: number
    providers: Record<string, { status: string; hits: number; uniqueContributed: number; latencyMs: number }>
  }
  cost: { totalUSD: number; byProvider: Record<string, { usd: number; basis: 'reported' | 'metered' | 'amortized' | 'free' }> }
  timing: { totalMs: number }
}
```

## How a sweep works

Fan-out → normalize → merge → fuse → meter → record.

1. The Engine selects adapters: key present, capabilities match the query (a web-only provider is skipped for image search), estimated cost fits the remaining `--budget` — cheapest first.
2. All selected adapters fire concurrently under one timeout. Each adapter translates the unified query to its provider's API and normalizes the response to `Hit[]`. Provider errors are classified (`auth | quota | rate_limit | timeout | provider_error`), never thrown raw.
3. Hits merge by canonical URL. Metadata unions: best snippet, longest content, earliest publish date. Every contributing provider lands in `provenance`.
4. Sources rank by Reciprocal Rank Fusion: `score = Σ 1/(60 + rank_p)`.
5. Cost aggregates per provider — provider-reported dollars when available, cost-model estimate otherwise — and the whole sweep is written to the ledger.

## Cost model

Three billing realities, modeled explicitly per provider:

```ts
type CostModel =
  | { kind: 'metered';      perRequestUSD: number }                          // top-up credits (Exa, Tavily, Parallel)
  | { kind: 'subscription'; monthlyUSD: number; includedRequests: number }   // flat fee, amortized per request
  | { kind: 'free';         monthlyQuota?: number }                          // $0, quota tracked (Brave free)
```

`wideband costs` shows month-to-date spend and quota consumption per provider.

### What providers cost

As configured in the adapters (modeled estimate; provider-reported dollars override it per call when available):

| Provider | Modeled cost | Free allowance |
| --- | --- | --- |
| Brave | free tier | ~2,000 req/mo ($5/mo in credits; paid: ~$5/1k) |
| SearchX | free tier | 90,000 req/mo |
| Jina | free tier | 1,000 req/mo |
| Sailor | free tier | 500 req/mo |
| Desearch | $0.00025/req | signup credits |
| Exa | $0.005/req | 20,000 req/mo free, then ~$7/1k (deep: $12/1k) |
| Tavily | $0.005/req | 1,000 credits/mo (basic = 1 credit, advanced = 2; PAYG $0.008/credit) |
| Linkup | $0.005/req | 4,000 signup queries + $5/mo credit top-up |
| Parallel | $0.005/req | signup credits |
| Perplexity | $0.005/req | signup credits |
| Nimble | $0.005/req | trial workspace |

Free tiers cover a lot: with the four free-tier providers alone you get thousands of sweeps per month at $0.

**Full-price sweep, all 11 providers, no free quota left:** a `scan` runs ~$0.03 (7 metered calls ≈ $0.005 each, Desearch ≈ $0.0003, free-tier providers $0). A `research` sweep runs higher where providers bill for depth — roughly $0.04–$0.08 (e.g. Tavily advanced is 2 credits, Exa deep search ~$0.012). In practice most sweeps cost less: free quotas absorb calls first, and `--budget` hard-caps a sweep, cheapest providers first.

Pricing is the providers' to change — treat the table as a snapshot (mid-2026) and `wideband stats` as the ground truth for what *your* searches actually cost.

## Telemetry

SQLite ledger at `~/.wideband/ledger.db` (override with `WIDEBAND_DB`): every sweep, every provider call, status, latency, hits, unique contributions, and cost. `wideband stats` reads it back as per-provider uniqueness and cost-per-unique-source — the data you need to decide which subscriptions to keep.

## Providers

| Provider | Env key |
| --- | --- |
| Brave | `BRAVE_API_KEY` |
| Desearch | `DESEARCH_API_KEY` |
| Exa | `EXA_API_KEY` |
| Jina | `JINA_API_KEY` |
| Linkup | `LINKUP_API_KEY` |
| Nimble | `NIMBLE_API_KEY` |
| Parallel | `PARALLEL_API_KEY` |
| Perplexity | `PERPLEXITY_API_KEY` |
| Sailor | `SAILOR_API_KEY` |
| SearchX | `SEARCHX_API_KEY` |
| Tavily | `TAVILY_API_KEY` |

Endpoints and per-provider quirks: [docs/adapters.md](docs/adapters.md).

## Docs

- [docs/architecture.md](docs/architecture.md) — design shape, adapter seam, data schemas, merge/ranking policy
- [docs/adapters.md](docs/adapters.md) — built adapters and candidate backlog
- [protoblocks/](protoblocks/) — measurement experiments: provider recall, freshness truth, cost per useful source

## Development

```bash
bun test              # 40 tests, no network
bun run typecheck
```

## FAQ

**Which is the best web search API for AI agents — Exa, Tavily, Brave, Linkup, Perplexity?**
Wrong question. They overlap heavily but each finds sources the others miss; every serious comparison ends with "use at least two." Wideband makes "all of them" one API call and tells you afterward which ones earned their cost.

**How do I deduplicate search results across multiple providers?**
URL canonicalization (strip tracking params, fragments, default ports) plus metadata union — that's wideband's merge step. Five providers returning the same article yield one Source with five provenance entries.

**What does an AI search API actually cost per query?**
Metered providers cluster around $0.005/request; several have generous free tiers. A full 11-provider sweep is ~$0.03 at full price. The number that matters is cost per *unique* source — `wideband stats` measures it from your real usage.

**Does this work as an MCP web search or LangChain tool?**
It's a plain TypeScript SDK and a JSON-emitting CLI, so wrapping it as an MCP server or agent-framework tool is a thin adapter. The CLI's robot mode (JSON out, meaningful exit codes) was designed for exactly that.

## Glossary

- **Agentic search** — web search shaped for LLM agents: structured results, content extraction, freshness controls, tool-call ergonomics.
- **Multi-provider search / metasearch** — fanning one query across several search engines and merging the results; wideband is this, rebuilt for the agent era with real deduplication.
- **Reciprocal Rank Fusion (RRF)** — rank-merging algorithm that combines heterogeneous result lists without comparing raw scores across providers.
- **LLM grounding** — feeding a model current web sources so its answers cite reality; RAG web search is the retrieval half of that loop.
- **Cost per unique source** — dollars spent divided by sources no other provider found; the metric wideband exists to maximize and measure.

## License

MIT
