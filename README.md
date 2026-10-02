<p align="center">
  <img src="https://raw.githubusercontent.com/ratacat/wideband/main/assets/wideband-hero.jpg" alt="Bar chart: unique sources found across 11 providers — wideband 48.5 vs best single provider 8.2" width="100%">
</p>

# wideband

[![npm](https://img.shields.io/npm/v/wideband)](https://www.npmjs.com/package/wideband)

A multi-provider web search API for AI agents. One query runs across configured providers and returns ranked, deduplicated sources with provenance and recorded or estimated costs. Google uses your proxy inventory.

Search providers overlap heavily. For agentic research the number that matters is **unique sources per dollar** — wideband exists to maximize it and to measure it.

- **13 provider adapters** — anyapi (Google results), Brave, Desearch, Exa, Google, Jina, Linkup, Nimble, Parallel, Perplexity, Sailor, SearchX, Tavily. Google is included in default scans.
- **Real deduplication** — URL canonicalization (tracking params, fragments, default ports stripped) plus metadata union, so five providers returning the same article yield one Source with five provenance entries.
- **Reciprocal Rank Fusion** ranking — robust across heterogeneous providers, no score-normalization games.
- **Request accounting.** Each potentially billable attempt reserves budget before dispatch and gets a durable SQLite record. Reported charges, estimates, and unresolved charges remain distinct.
- **Streaming results.** `--stream` emits provider snapshots as they finish and then the final result. Compatible concurrent SDK searches share work.
- **Usage ledger.** SQLite retains attempts, provider outcomes, latency, and costs. `wideband stats` reports provider contributions; `wideband costs` includes unresolved attempts.
- **Robot-mode CLI** — JSON by default, meaningful exit codes, `--pretty` when a human is watching.

Built on [Bun](https://bun.sh), Effect 4 for execution and schemas, and Cheerio for Google HTML. Google also requires uv, Python, and residential proxies.

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

API providers participate when their key is present. Google is included by default and uses `WIDEBAND_PROXY_FILE`.

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
- `--max N` — per-provider hit limit, 1–100; providers can return fewer
- `--google-pages N` — Google or AnyAPI page limit, 1–10; defaults `--max` to ten times this value unless explicitly set; an explicit provider list must include Google or AnyAPI
- `--budget USD` — cap on request reservations, including retries and pages; see the cost model below
- `--timeout MS` — provider deadline including queue waits, requests, and retries
- `--stream` — provider snapshots and the final result as NDJSON
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

Provider keys come from the server process environment or the shell that launches the client. Tool arguments include `q`, `max`, `googlePages`, `providers`, `budget`, and `hours`. MCP request cancellation reaches provider work. EOF waits for accepted requests; SIGTERM cancels them and waits for cleanup.

## SDK

```ts
import { wideband } from 'wideband'

const wb = wideband()

try {
  const result = await wb.scan('bun sqlite WAL', { budget: 0.05 })
  for (const source of result.sources) {
    console.log(source.score, source.url, source.providers)
  }
  console.log(result.cost.totalUSD, result.cost.unknownAttempts)

  for await (const event of wb.stream('Effect TypeScript')) {
    if (event.kind === 'provider') console.log(event.provider, event.sources)
    else console.log(event.result)
  }
} finally {
  await wb.close()
}
```

Pass `signal: AbortSignal` in search options to cancel a caller. Cancelling one caller leaves shared work running for other callers. Breaking out of a stream releases its subscription.

`providers()`, `stats()`, `costs()`, and `close()` return Promises. `close()` is idempotent and rejects subsequent work. Sources in provider events are cumulative snapshots, so replace earlier sources with the same IDs. The final event contains the batch result.

Every sweep returns a `SweepResult`:

```ts
type Source = {
  id: string
  url: string
  title: string
  snippet: string
  content?: string
  publishedAt?: string
  providers: string[]
  provenance: { provider: string; rank: number; score?: number }[]
  uniqueTo?: string
  score: number
}

type SweepResult = {
  sweepId: string
  complete: boolean
  sources: Source[]
  stats: {
    totalHits: number
    uniqueSources: number
    overlapPct: number
    providers: Record<string, { status: string; hits: number; uniqueContributed: number; latencyMs: number; attempts: number }>
  }
  cost: {
    totalUSD: number
    unknownAttempts: number
    byProvider: Record<string, {
      usd: number
      basis: 'reported' | 'metered' | 'amortized' | 'free' | 'unknown' | 'mixed'
      observedUSD: number
      estimatedUSD: number
      unknownAttempts: number
      attempts: number
    }>
  }
  timing: { totalMs: number }
}
```

## How a sweep works

1. Select configured providers whose capabilities match the query.
2. Run provider effects concurrently. Each request reserves budget and records a pending attempt before network work. Retries repeat that request, preserving successful earlier pages.
3. Validate responses before normalization. Merge hits by canonical URL and retain each provider's provenance, the longest content, and the earliest publication date.
4. Rank sources by Reciprocal Rank Fusion, `score = Σ 1/(60 + rank_p)`.
5. Return the sources and accounting. A provider that loses a later page can contribute a `partial` result with `complete: false`. Complete successful sweeps, including valid empty results, can be cached. Session suppression happens per caller after retrieval.

SDK calls reject with `WidebandError` when every provider fails. Its `result` retains provider outcomes and costs. The CLI prints that result and exits with code 5. Storage failures surface as `LedgerError`.

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
| Exa | $0.007/req plus $0.001 per requested result above 10 | account allowance applies |
| Tavily | $0.008 scan, $0.016 research | PAYG estimate; account credits and plans can cost less |
| Linkup | $0.005/req | 4,000 signup queries + $5/mo credit top-up |
| Parallel | $0.005/req plus $0.001 per requested result above 10 | signup credits |
| Perplexity | $0.005/req | signup credits |
| Nimble | $0.005/req | trial workspace |
| anyapi | $0.0005/page base; reserve up to $0.0009 for automatic fallback | provider reports the charge |
| Google | $0/req; you pay for the proxies | your proxy plan |

Prices are modeled estimates, not account invoices. Free-tier models assume the allowance applies. `--budget` limits reservations before each attempt. A reported amount replaces its reservation. A lost response retains the reserved estimate and increments `unknownAttempts`; it does not silently become free. Actual provider charges can differ from a stale model, and cancellation cannot undo a dispatched request.

Exa, Parallel, Tavily, and AnyAPI estimates were checked on October 2, 2026 against [Exa pricing](https://exa.ai/docs/admin/pricing.md), [Parallel pricing](https://docs.parallel.ai/getting-started/pricing), [Tavily credits](https://docs.tavily.com/documentation/api-credits.md), and [the AnyAPI catalog](https://api.getanyapi.com/catalog). Other rows retain the existing adapter models. Google proxy costs are outside these totals.

## Telemetry

SQLite stores sweeps, provider outcomes, request attempts, cached results, and seen source IDs at `~/.wideband/ledger.db`. `WIDEBAND_DB` selects another file. Attempt records survive cancellation and failed final summaries. `wideband costs` reports monthly `attempts` and unresolved charges. `wideband stats` reports settled provider operations as `calls`, with uniqueness and cost per unique source. Historical rows from before 0.4 have only provider-operation counts, so their monthly attempt counts remain approximate.

## Providers

Google is included in default scans alongside configured API providers. An explicit `--providers` list replaces the default set:

```sh
wideband scan "scuba diving shops bonaire"
wideband scan "scuba diving shops bonaire" --providers google,brave --google-pages 3
wideband scan "site:padi.com/dive-center/" --providers google --google-pages 10
```

### Local Google provider

The `google` adapter runs the search transport on your machine and fetches Google's result pages through your proxy inventory. It requires no Google API key or remote search service. Google sees the proxy's exit IP.

#### Set up the connection

Install Bun 1.4 or newer, [uv](https://docs.astral.sh/uv/getting-started/installation/), and Python 3.10 or newer. Warm the pinned Python dependency before your first timed search:

```sh
uv run --with curl-cffi==0.16.3 python -c 'import curl_cffi; print("Google transport ready")'
```

Save your proxy provider's connection details in a private file outside the repository, such as `~/.config/wideband/proxies.txt`. Create its parent directory if necessary. One connection per line in `host:port:username:password` format is sufficient:

```text
proxy-a.example.net:8080:USERNAME:PASSWORD
proxy-b.example.net:8080:USERNAME:PASSWORD
```

Replace those example values with your own. Export the file's absolute path, restrict its permissions, and test Google alone:

```sh
export WIDEBAND_PROXY_FILE="$HOME/.config/wideband/proxies.txt"
chmod 600 "$WIDEBAND_PROXY_FILE"
wideband scan "Effect TypeScript" --providers google --max 3 --fresh --full
```

The same variable works for the SDK and standalone Google module. For an MCP client, set `WIDEBAND_PROXY_FILE` in the environment of the server it launches. Desktop clients may not inherit your shell's exports. The CLI and MCP server also read the package's `.env` file; `.env.example` includes the variable. Use an absolute path there.

The file also accepts `username:password@host:port`, `host:port` for IP-allowlisted proxies, and complete proxy URLs. For example:

```text
http://USERNAME:PASSWORD@proxy.example.net:8080
```

A JSON inventory supports separate credential fields and an optional `protocol`, which defaults to `http`:

```json
[
  {
    "host": "proxy.example.net",
    "port": 8080,
    "username": "USERNAME",
    "password": "PASSWORD",
    "protocol": "http"
  }
]
```

Credentials in these separate fields are URL-encoded by wideband. Complete URLs must already encode reserved characters correctly. Blank lines and lines beginning with `#` are ignored in text inventories. Keep the inventory private; it contains proxy credentials.

#### How and why it works

The transport in [google-search.mjs](src/google-search.mjs) starts `uv`, which runs Python with pinned `curl_cffi==0.16.3`. It passes the query, page offset, and proxy connection through stdin, then receives the response as JSON.

The request targets Google's `/search` endpoint with `gbv=1` and a Nokia feature-phone User-Agent. That combination returns compact HTML containing the search results without requiring a JavaScript browser. As of October 2026, Google answers `/wml/search` with HTTP 403. The request fixes `hl=en`, `gl=us`, and `pws=0`.

`curl_cffi` supplies the `chrome99_android` impersonation profile. It controls the TLS and HTTP fingerprint as well as the ordinary request headers. That is why the transport uses this library instead of plain JavaScript `fetch` or standard Python `requests`. [curl_cffi's browser impersonation documentation](https://github.com/lexiforest/curl_cffi#features).

Cheerio extracts organic result cards, titles, snippets, and next-page offsets. The parser unwraps Google redirect links; the adapter canonicalizes URLs and removes duplicates. This depends on Google's current page format. CAPTCHA, consent, JavaScript challenges, and unrecognized markup produce errors rather than successful empty results. This is an HTML integration, not a documented Google search API.

#### Direct IP versus proxies

An ordinary home or office IP may work for occasional direct requests. Repeated automated searches can trigger restrictions affecting that public IP, including other users sharing the connection. Google documents these shared-network effects in its [unusual traffic guidance](https://support.google.com/websearch/answer/86640).

For regular or batch use, plan on a proxy pool with pacing. This implementation has been verified with residential proxies. Separate exit IPs spread traffic, while cooldowns prevent rapid reuse. Proxy reputation and traffic from other customers still matter; buying proxies does not guarantee uninterrupted access.

**The current adapter requires `WIDEBAND_PROXY_FILE` and has no direct-IP mode.** An unset or empty inventory fails before contacting Google. A local forward proxy that uses your machine's public IP still exposes that same exit IP.

Wideband rotates the connections listed in the file. Its scheduler identifies each connection by a hash of its complete proxy URL. It does not discover the actual exit IP behind a rotating gateway. Different connection strings can share an exit IP, and one gateway can change exits. Use your provider's session or endpoint controls when you need distinct or stable exits.

#### Pacing and failure handling

The scheduler coordinates CLI processes and SDK clients under the same home directory through `~/.wideband/google-proxies.sqlite`. It selects a ready connection and reserves it in a SQLite transaction.

- The same connection has at least six seconds between reservations.
- Returned transport failures, non-200 responses, and detected blocks or challenges put that connection on a fifteen-minute cooldown.
- A page tries at most three distinct available connections. Unrecognized markup stops the search so a parser change cannot be hidden by repeated proxy attempts.
- Each page has a 45-second deadline, including proxy waits. Each network attempt has a 20-second timeout.
- Google has a 120-second provider deadline. `--timeout` changes that provider deadline; the page and network limits still apply.

These timings are wideband's policy, not a Google-approved request rate. The scheduler database contains hashes and timestamps, not credentials. State is shared on the same machine and home directory; separate machines do not coordinate their proxy usage automatically.

Cancellation kills the transport process group on macOS and Linux and waits for it to close. If a later page fails, earlier hits remain available with provider status `partial` and `complete: false`.

#### Pagination and troubleshooting

Google fetches one page by default, even with `--max 100`. Use `--google-pages` to follow next-page offsets:

```sh
wideband scan "site:padi.com/dive-center/" --providers google --google-pages 3 --max 30 --fresh
```

A search stops at the page limit, result limit, or end of results. Ten pages can produce fewer than 100 unique URLs. Proxy locations can change rankings, so this is source discovery rather than a stable rank-tracking measurement.

The provider supports English US web results. Search and research return the same snippets; Google images, news, video endpoints, and full-page content are outside this adapter. Put `site:` operators in the query instead of structured domain filters. Undated snippets retain their uncertainty under wideband's freshness policy.

For a failed first search:

- For an `inventory` error, check the file path, contents, and permissions first. Errors mentioning reservations point to the local SQLite scheduler or its filesystem access.
- A `runtime` error means the subprocess could not start or complete. Run the uv dependency command above in the same environment.
- An `exhausted` error lists failed proxy attempts. Check proxy authentication, IP allowlisting, exit reputation, and the provider's network access.
- A timeout can mean all connections are cooling down. Wait or use a healthy pool; raising the overall timeout does not remove the page deadline.
- An `unrecognized` error means the HTML parser could not identify results or an explicit no-results page. Check the parser against the returned page format.

Google's recorded search-API fee is zero. Proxy bandwidth and inventory costs are outside wideband's budget and cost totals.

SDK calls use `scan({ q: 'dive shops', googlePages: 3, max: 30 }, { providers: ['google'] })`. MCP `scan` and `research` accept `googlePages` and derive the default `max` from it. The standalone parser and page client are exported from `wideband/google-search` and run on Node 22.16 or newer.

Run `bun run build` and `bun testing/google-live.ts` for live CLI checks using your configured proxies and providers.

### Google through AnyAPI

The `anyapi` provider returns Google results through the [anyapi](https://getanyapi.com) `google.search` API, with no local proxies, uv, or Python. Its published base price is $0.0005 per page, and default automatic fallback can cost up to $0.0009. Each attempt reserves that upper bound and then records the reported amount. It reads its key from `ANYAPI_API_KEY`, or else from `~/.anyapi/config.json`. `--google-pages` sets its page count.

Page depth participates in cache keys. Other providers retain their own result caps and are not paginated by `--google-pages`.

| Provider | Env key |
| --- | --- |
| Brave | `BRAVE_API_KEY` |
| Desearch | `DESEARCH_API_KEY` |
| Exa | `EXA_API_KEY` |
| anyapi | `ANYAPI_API_KEY`, or `~/.anyapi/config.json` |
| Google | `WIDEBAND_PROXY_FILE` |
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
bun run test
bun run typecheck
bun run build
```

`bun run test` exercises the SDK and CLI against a local HTTP server, then drives the MCP process over stdio. It makes no paid provider calls. After building, `bun testing/effect-e2e.ts --dist` checks the generated SDK and CLI with the same scenarios. The separate Google live harness uses configured providers and proxies.

## Upgrade to 0.4

Await `providers()`, `stats()`, `costs()`, and `close()`. Monthly provider usage exposes `attempts`. Schema exports are Effect Schema values; use `parseQuery` and `parseSweepResult` or Effect's decoder functions in place of Zod `.parse`. Engine and Ledger are internal and no longer exported from the package. Provider adapters return Effects and submit individual request receipts through their context. Incomplete results expose `complete: false`, and all-provider failure rejects SDK calls while preserving the CLI's exit 5 result output.

## FAQ

**Which is the best web search API for AI agents — Exa, Tavily, Brave, Linkup, Perplexity?**
Wrong question. They overlap heavily but each finds sources the others miss; every serious comparison ends with "use at least two." Wideband makes "all of them" one API call and tells you afterward which ones earned their cost.

**How do I deduplicate search results across multiple providers?**
URL canonicalization (strip tracking params, fragments, default ports) plus metadata union — that's wideband's merge step. Five providers returning the same article yield one Source with five provenance entries.

**What does an AI search API actually cost per query?**
Cost depends on provider, result count, depth, page count, retries, and account pricing. `wideband costs` reports observed, estimated, and unresolved usage. `wideband stats` compares cost per unique source across settled provider operations.

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
